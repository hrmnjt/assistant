import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Auth, accountsFrom, SignInError } from '../server/auth.js';
import { accounts, config, householdStore, origin, type Row } from './support.js';

const request = (cookie?: string) =>
  new Request(`${origin}/api/state`, { headers: cookie ? { Cookie: cookie } : {} });
const session = (cookie: string) => cookie.split(';')[0];
const rejected = (status: number) => (error: unknown) =>
  error instanceof SignInError && error.status === status;

test('configuration requires two distinct accounts with long passwords', () => {
  assert.throws(() => accountsFrom({ ...config, PARTNER_PASSWORD: 'short' }), /12 characters/);
  assert.throws(
    () => accountsFrom({ ...config, PARTNER_PASSWORD: config.OWNER_PASSWORD }),
    /distinct/,
  );
  assert.throws(() => accountsFrom({ ...config, PARTNER_USERNAME: 'owner' }), /distinct/);
  assert.deepEqual(
    accountsFrom(config).map((account) => account.name),
    ['Alex', 'Sam'],
  );
});

test('sign-in throttling is per client and expires after its window', async () => {
  let now = Date.parse('2026-10-14T07:00:00Z');
  const auth = new Auth(await householdStore(), accounts, origin, () => now);
  for (let attempt = 0; attempt < 10; attempt++)
    await assert.rejects(
      auth.login({ username: 'owner', password: 'wrong' }, '203.0.113.1'),
      rejected(401),
    );
  // The limit applies to the correct password and to unknown accounts alike.
  await assert.rejects(
    auth.login({ username: 'owner', password: accounts[0].password }, '203.0.113.1'),
    rejected(429),
  );
  await assert.rejects(
    auth.login({ username: 'nobody', password: 'x' }, '203.0.113.1'),
    rejected(429),
  );
  // Another client, such as the other spouse's phone, is unaffected.
  await auth.login({ username: 'partner', password: accounts[1].password }, '203.0.113.2');
  now += 900_000;
  await auth.login({ username: 'owner', password: accounts[0].password }, '203.0.113.1');
});

test('a successful sign-in clears that client, and unknown accounts get the same answer', async () => {
  const auth = new Auth(await householdStore(), accounts, origin);
  for (let attempt = 0; attempt < 9; attempt++)
    await auth.login({ username: 'owner', password: 'wrong' }, 'client').catch(() => undefined);
  await auth.login({ username: 'owner', password: accounts[0].password }, 'client');
  for (let attempt = 0; attempt < 9; attempt++)
    await assert.rejects(
      auth.login({ username: 'owner', password: 'wrong' }, 'client'),
      rejected(401),
    );
  const answer = (username: string) =>
    auth.login({ username, password: 'wrong' }, 'other').catch((error) => error.message);
  assert.equal(await answer('nobody'), await answer('owner'));
});

test('parallel guesses from one client share its ten-attempt limit, and memory stays bounded', async () => {
  const db = await householdStore();
  const auth = new Auth(db, accounts, origin);
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, () => auth.login({ username: 'owner', password: 'x' }, 'busy')),
  );
  const statuses = results.map((result) =>
    result.status === 'rejected' ? (result.reason as SignInError).status : 200,
  );
  assert.equal(statuses.filter((status) => status === 401).length, 10);
  assert.equal(statuses.filter((status) => status === 429).length, 2);
  for (let client = 0; client < 1005; client++)
    await auth
      .login({ username: 'owner', password: 'x' }, `client-${client}`)
      .catch(() => undefined);
  assert.ok(Number((await db.get<Row>('SELECT COUNT(*) AS n FROM sign_in_attempts'))!.n) <= 1000);
});

test('changing an account password signs that account out everywhere', async () => {
  const db = await householdStore();
  const auth = new Auth(db, accounts, origin);
  const owner = session(
    (await auth.login({ username: 'owner', password: accounts[0].password }, 'a')).cookie,
  );
  const partner = session(
    (await auth.login({ username: 'partner', password: accounts[1].password }, 'b')).cookie,
  );
  assert.equal((await auth.current(request(owner)))?.id, 'owner');
  // The same store after the owner's password secret changes.
  const rotated = new Auth(
    db,
    [{ ...accounts[0], password: 'A-new-owner-password' }, accounts[1]],
    origin,
  );
  assert.equal(await rotated.current(request(owner)), null);
  assert.equal((await rotated.current(request(partner)))?.id, 'partner');
  await assert.rejects(
    rotated.login({ username: 'owner', password: accounts[0].password }, 'a'),
    rejected(401),
  );
  await rotated.login({ username: 'owner', password: 'A-new-owner-password' }, 'a');
});

test('signing out ends only that session, and cookies are secure over HTTPS', async () => {
  const db = await householdStore();
  const auth = new Auth(db, accounts, 'https://household.example');
  const { cookie } = await auth.login({ username: 'owner', password: accounts[0].password }, 'a');
  assert.match(
    cookie,
    /^__Host-household=.+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/,
  );
  const req = new Request('https://household.example/api/logout', {
    method: 'POST',
    headers: { Cookie: session(cookie) },
  });
  assert.match(await auth.logout(req), /Max-Age=0/);
  assert.equal(await auth.current(req), null);
});
