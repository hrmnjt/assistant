import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Auth, identityHeader, withAccessIdentity } from '../server/auth.js';
import { migrate, migrations } from '../server/database.js';
import { Household } from '../server/household.js';
import { openHousehold, type Runtime } from '../server/runtime.js';
import {
  client,
  config,
  deployment,
  directory,
  openStore,
  people,
  setUp,
  type Row,
} from './support.js';

const json = async (response: Response) => (await response.json()) as any;
async function withApp(
  settings: Record<string, string>,
  work: (app: Runtime) => Promise<void>,
  path?: string,
) {
  const app = await openHousehold(openStore(path), settings);
  try {
    await work(app);
  } finally {
    await app.conversations.close();
  }
}

test('the Worker forwards only the email Cloudflare Access verified', async () => {
  const spoofed = new Request('https://app.example/api/state', {
    headers: { [identityHeader]: 'someone@example.com', Cookie: 'kept=1' },
  });
  const anonymous = await withAccessIdentity(spoofed);
  assert.equal(anonymous.headers.get(identityHeader), null);
  assert.equal(anonymous.headers.get('cookie'), 'kept=1');
  const signedIn = await withAccessIdentity(spoofed, {
    getIdentity: async () => ({ email: ' Alex@Example.com ' }),
  });
  assert.equal(signedIn.headers.get(identityHeader), 'alex@example.com');
  // Access present but without an email (a service token, say) is still nobody.
  const tokenOnly = await withAccessIdentity(spoofed, { getIdentity: async () => ({}) });
  assert.equal(tokenOnly.headers.get(identityHeader), null);
});

test('a deployment: only the two emails in the Worker’s variables get in', async () => {
  await withApp(deployment, async (app) => {
    assert.equal((await client(app, null).call('/api/state')).status, 401);
    const owner = await json(await client(app, 'owner').call('/api/state'));
    assert.deepEqual(
      [owner.me.id, owner.me.name, owner.signIn],
      ['owner', 'Alex', 'cloudflare-access'],
    );
    const partner = await json(await client(app, 'partner').call('/api/state'));
    assert.deepEqual([partner.me.id, partner.me.name], ['partner', 'Sam']);
    assert.equal(partner.threads.filter((thread: any) => thread.assistantFor).length, 2);
    // A third email, even one Access let in, is refused; there is no setup to run.
    const stranger = await app.auth.caller(
      new Request('https://app.example/api/state', {
        headers: { [identityHeader]: 'guest@example.com' },
      }),
    );
    assert.equal(stranger, null);
    assert.equal((await client(app, 'owner').call('/api/setup', { name: 'Again' })).status, 404);
  });
});

test('the app does not start without both people, and says which variables to set', async () => {
  const cases: [Record<string, string>, RegExp][] = [
    [{}, /^Configure PERSON_1_NAME, PERSON_1_EMAIL, PERSON_2_NAME, PERSON_2_EMAIL in the Worker/],
    [{ ...deployment, PERSON_2_EMAIL: 'not an email' }, /^Configure PERSON_2_EMAIL in the Worker/],
    [{ ...deployment, PERSON_1_NAME: '  ' }, /^Configure PERSON_1_NAME in the Worker/],
    [{ ...deployment, PERSON_2_EMAIL: ' ALEX@example.com' }, /^Configure a different email/],
    // A development server has no sign-in, so it needs only the names.
    [{ HOUSEHOLD_DEVELOPMENT: 'true' }, /^Configure PERSON_1_NAME, PERSON_2_NAME in cloudflare/],
  ];
  for (const [settings, message] of cases)
    await assert.rejects(openHousehold(openStore(), settings), { message });
  await withApp(
    { HOUSEHOLD_DEVELOPMENT: 'true', PERSON_1_NAME: 'Alex', PERSON_2_NAME: 'Sam' },
    async (app) => {
      assert.deepEqual(
        (await app.household.people()).map((person) => person.username),
        ['owner', 'partner'],
      );
    },
  );
});

test('changing a name or email in the variables keeps each person’s records', async () => {
  const path = `${directory('people')}/household.sqlite`;
  const first = await openHousehold(openStore(path), deployment);
  await client(first, 'partner').call('/api/previews', {
    kind: 'thread.create',
    title: 'Holiday',
    category: 'household',
  });
  await first.conversations.close();
  // Sam is renamed and moves email; Alex takes Sam's old address.
  const moved = {
    ...deployment,
    PERSON_1_EMAIL: people.partner.email,
    PERSON_2_NAME: 'Sammy',
    PERSON_2_EMAIL: 'Sam@New.example',
  };
  await withApp(
    moved,
    async (app) => {
      const signedIn = (email: string) =>
        app.auth.caller(
          new Request('https://app.example/api/state', { headers: { [identityHeader]: email } }),
        );
      assert.equal(await signedIn(people.owner.email), null);
      assert.equal((await signedIn(people.partner.email))?.id, 'owner');
      const sam = await signedIn('sam@new.example');
      assert.deepEqual([sam?.id, sam?.name], ['partner', 'Sammy']);
      const previews = await json(
        await client(app, null).call('/api/previews', undefined, 'GET', {
          [identityHeader]: 'sam@new.example',
        }),
      );
      assert.equal(previews.length, 1);
    },
    path,
  );
});

test('a development server has no sign-in and answers only on this computer', async () => {
  await withApp(config, async (app) => {
    const me = await json(await client(app, null).call('/api/state'));
    assert.deepEqual([me.me.id, me.me.name, me.signIn], ['owner', 'Alex', 'development']);
    const other = await json(await client(app, 'partner').call('/api/state'));
    assert.equal(other.me.name, 'Sam');
    const auth = app.auth;
    for (const url of ['http://localhost:8787/', 'http://127.0.0.1:9000/', 'http://[::1]:8787/'])
      assert.equal(auth.served(new Request(url)), new URL(url).origin);
    // Another site's hostname (DNS rebinding) or a public tunnel is refused.
    const refused = await client(app, 'owner', 'https://abc.trycloudflare.com').call('/api/state');
    assert.equal(refused.status, 403);
    assert.equal(auth.served(new Request('http://evil.example/')), null);
  });
});

test('writes need the app header and the origin the app was served at', async () => {
  await withApp(deployment, async (app) => {
    const owner = client(app, 'owner', 'https://assistant.example.workers.dev');
    const presence = { threadId: null, clientId: crypto.randomUUID(), typing: false };
    assert.equal((await owner.call('/api/presence', presence)).status, 200);
    const refusals: Record<string, string>[] = [
      { 'X-Household-Client': '0' },
      { Origin: 'https://evil.example' },
    ];
    for (const extra of refusals)
      assert.equal((await owner.call('/api/presence', presence, 'POST', extra)).status, 403);
  });
});

test('people from an earlier version keep their records, and settings saved in the app are dropped', async () => {
  const db = openStore();
  await migrate(db, migrations.slice(0, 3));
  // Earlier versions set people up at the first sign-in and kept connections in Settings.
  await db.run("INSERT INTO users VALUES ('owner','owner','You'),('partner','partner','Partner')");
  await db.run(
    "INSERT INTO preferences VALUES ('owner', ?, 4)",
    JSON.stringify({
      timezone: 'Europe/London',
      morning: { enabled: false, time: '07:00' },
      evening: { enabled: true, time: '18:00' },
    }),
  );
  for (const key of ['setup', 'icloud', 'ai_model', 'push'])
    await db.run('INSERT INTO settings VALUES (?, ?)', key, JSON.stringify(key));
  await migrate(db);
  assert.deepEqual(
    (await db.all<Row>('SELECT key FROM settings')).map((row) => row.key),
    ['push'],
  );
  const household = new Household(db);
  await setUp(household);
  assert.deepEqual(
    (await household.people()).map((person) => [person.id, person.username, person.name]),
    [
      ['owner', people.owner.email, 'Alex'],
      ['partner', people.partner.email, 'Sam'],
    ],
  );
  assert.equal((await household.preferences('owner')).timezone, 'Europe/London');
  const auth = new Auth(household);
  const signedIn = await auth.caller(
    new Request('https://app.example/', { headers: { [identityHeader]: people.owner.email } }),
  );
  assert.equal(signedIn?.id, 'owner');
  await db.close();
});
