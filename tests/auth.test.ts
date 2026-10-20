import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Auth, identityHeader, withAccessIdentity } from '../server/auth.js';
import { migrate, migrations } from '../server/database.js';
import { Household } from '../server/household.js';
import { openHousehold, type Runtime } from '../server/runtime.js';
import { client, config, deployment, openStore, people, setUp, type Row } from './support.js';

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

test('a deployment: only the two emails the admin added get in', async () => {
  await withApp(deployment, async (app) => {
    await setUp(app.household);
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

test('until the admin adds the two people, the app says so and the admin page still opens', async () => {
  await withApp(deployment, async (app) => {
    const response = await client(app, 'owner').call('/api/state');
    assert.equal(response.status, 503);
    assert.match((await json(response)).error, /the admin adds the two of you/);
    // Without an Access sign-in, that is not shown.
    assert.equal((await client(app, null).call('/api/state')).status, 401);
    assert.equal((await client(app, null).call('/api/admin/session')).status, 200);
  });
});

test('a development server has no sign-in and answers only on this computer', async () => {
  await withApp(config, async (app) => {
    await setUp(app.household);
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
    await setUp(app.household);
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

test('people from an earlier version keep their records; old settings are dropped', async () => {
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
