import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Auth, identityHeader, withAccessIdentity } from '../server/auth.js';
import { migrate } from '../server/database.js';
import { Household } from '../server/household.js';
import { openHousehold, type Runtime } from '../server/runtime.js';
import { client, config, deployment, openStore, people, setUp, type Row } from './support.js';

const json = async (response: Response) => (await response.json()) as any;
async function withApp(settings: Record<string, string>, work: (app: Runtime) => Promise<void>) {
  const app = await openHousehold(openStore(), settings);
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

test('a deployment: the first person to sign in sets up both, then only those two emails get in', async () => {
  await withApp(deployment, async (app) => {
    assert.equal((await client(app, null).call('/api/state')).status, 401);
    const first = client(app, 'owner');
    const pending = await first.call('/api/state');
    assert.equal(pending.status, 428);
    assert.deepEqual((await json(pending)).setup, {
      email: people.owner.email,
      development: false,
    });
    // Nothing else is available before setup.
    assert.equal((await first.call('/api/previews')).status, 428);
    // A deployment needs the other person's email, distinct from the signed-in one.
    for (const partner of [{ name: 'Sam' }, { name: 'Sam', email: 'ALEX@example.com' }])
      assert.equal(
        (await first.call('/api/setup', { name: 'Alex', partner })).status,
        400,
        JSON.stringify(partner),
      );
    const done = await first.call('/api/setup', {
      name: ' Alex ',
      partner: { name: 'Sam', email: 'Sam@Example.com' },
    });
    assert.equal(done.status, 200);
    const owner = await json(await first.call('/api/state'));
    assert.deepEqual(
      [owner.me.id, owner.me.name, owner.signIn],
      ['owner', 'Alex', 'cloudflare-access'],
    );
    const partner = await json(await client(app, 'partner').call('/api/state'));
    assert.deepEqual([partner.me.id, partner.me.name], ['partner', 'Sam']);
    assert.equal(partner.threads.filter((thread: any) => thread.assistantFor).length, 2);
    // A third email, even one Access let in, is refused; setup cannot run again.
    const stranger = await app.auth.caller(
      new Request('https://app.example/api/state', {
        headers: { [identityHeader]: 'guest@example.com' },
      }),
    );
    assert.equal(stranger, null);
    assert.equal(
      (await first.call('/api/setup', { name: 'Again', partner: { name: 'X', email: 'x@y.z' } }))
        .status,
      404,
    );
    await assert.rejects(setUp(app.household), /already set up/);
  });
});

test('names are each person’s own; only the person who set up can correct the other email', async () => {
  await withApp(deployment, async (app) => {
    await setUp(app.household);
    const owner = client(app, 'owner');
    const partner = client(app, 'partner');
    assert.equal((await partner.call('/api/people/me', { name: 'Sammy' })).status, 200);
    assert.equal((await partner.call('/api/people/me', { name: '  ' })).status, 400);
    assert.equal(
      (await partner.call('/api/people/partner', { email: 'x@example.com' })).status,
      403,
    );
    assert.equal(
      (await owner.call('/api/people/partner', { email: people.owner.email })).status,
      400,
    );
    assert.equal(
      (await owner.call('/api/people/partner', { email: 'Sam@New.example' })).status,
      200,
    );
    const signedIn = (email: string) =>
      app.auth.caller(
        new Request('https://app.example/api/state', { headers: { [identityHeader]: email } }),
      );
    assert.equal(await signedIn(people.partner.email), null);
    const moved = await signedIn('sam@new.example');
    assert.deepEqual(moved && 'person' in moved ? moved.person.name : null, 'Sammy');
  });
});

test('a development server has no sign-in, answers only on this computer, and sets up with names', async () => {
  await withApp(config, async (app) => {
    const local = client(app, null);
    const pending = await local.call('/api/state');
    assert.equal(pending.status, 428);
    assert.deepEqual((await json(pending)).setup, { email: null, development: true });
    assert.equal(
      (await local.call('/api/setup', { name: 'Alex', partner: { name: 'Sam' } })).status,
      200,
    );
    const me = await json(await local.call('/api/state'));
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

test('setting up keeps the records of people provisioned by an earlier version', async () => {
  const db = openStore();
  await migrate(db);
  // Earlier versions created both people from configuration at startup.
  await db.run("INSERT INTO users VALUES ('owner','owner','You'),('partner','partner','Partner')");
  await db.run(
    "INSERT INTO preferences VALUES ('owner', ?, 4)",
    JSON.stringify({
      timezone: 'Europe/London',
      morning: { enabled: false, time: '07:00' },
      evening: { enabled: true, time: '18:00' },
    }),
  );
  const household = new Household(db);
  const auth = new Auth(household);
  assert.deepEqual(await household.people(), []);
  const before = await auth.caller(
    new Request('https://app.example/', { headers: { [identityHeader]: people.owner.email } }),
  );
  assert.deepEqual(before, { setup: { email: people.owner.email } });
  await setUp(household);
  assert.deepEqual(
    (await household.people()).map((person) => [person.id, person.username, person.name]),
    [
      ['owner', people.owner.email, 'Alex'],
      ['partner', people.partner.email, 'Sam'],
    ],
  );
  assert.equal((await household.preferences('owner')).timezone, 'Europe/London');
  const rows = await db.all<Row>("SELECT value FROM settings WHERE key='setup'");
  assert.equal(rows.length, 1);
  await db.close();
});
