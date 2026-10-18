import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Auth, accountsFrom } from '../server/auth.js';
import { openHousehold } from '../server/runtime.js';
import { accounts, client, config, openStore, testAccess } from './support.js';

const get = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });

test('a deployment needs both Access settings and two distinct emails; development needs neither', async () => {
  assert.throws(() => accountsFrom({ ...config, PARTNER_EMAIL: '' }, true), /OWNER_EMAIL/);
  assert.throws(
    () => accountsFrom({ ...config, PARTNER_EMAIL: config.OWNER_EMAIL.toUpperCase() }, true),
    /OWNER_EMAIL/,
  );
  assert.deepEqual(
    accountsFrom({}, false).map((account) => account.id),
    ['owner', 'partner'],
  );
  await assert.rejects(
    openHousehold(openStore(), { ...config, ACCESS_TEAM_DOMAIN: 'household.cloudflareaccess.com' }),
    /ACCESS_AUD/,
  );
});

test('a development server has no sign-in and answers only on this computer', async () => {
  const auth = new Auth(accounts);
  assert.equal(auth.mode, 'development');
  assert.equal((await auth.current(get('http://localhost:8787/api/state')))?.id, 'owner');
  const asPartner = get('http://localhost:8787/api/state', {
    Cookie: 'other=1; household-dev-person=partner',
  });
  assert.equal((await auth.current(asPartner))?.id, 'partner');
  for (const url of ['http://localhost:8787/', 'http://127.0.0.1:9000/', 'http://[::1]:8787/'])
    assert.equal(auth.served(get(url)), new URL(url).origin);
  // Another site's hostname (DNS rebinding) or a public tunnel is refused.
  for (const url of ['http://evil.example/', 'https://abc.trycloudflare.com/'])
    assert.equal(auth.served(get(url)), null);

  const app = await openHousehold(openStore(), config);
  try {
    const refused = await client(app, 'owner', 'https://abc.trycloudflare.com').call('/api/state');
    assert.equal(refused.status, 403);
    assert.match(((await refused.json()) as { error: string }).error, /Cloudflare Access/);
    const state = (await (await client(app).call('/api/state')).json()) as {
      me: { id: string };
      signIn: string;
    };
    assert.deepEqual([state.me.id, state.signIn], ['owner', 'development']);
  } finally {
    await app.conversations.close();
  }
});

test('behind Cloudflare Access, only a valid token for a household email signs a person in', async () => {
  const access = await testAccess();
  const auth = new Auth(accounts, {
    teamDomain: 'household.cloudflareaccess.com',
    audience: 'test-audience',
    keys: access.keys,
  });
  const as = async (token: string) =>
    (await auth.current(get('https://app.example/api/state', { 'Cf-Access-Jwt-Assertion': token })))
      ?.id ?? null;
  assert.equal(auth.mode, 'cloudflare-access');
  assert.equal(await as(await access.token('alex@example.com')), 'owner');
  assert.equal(await as(await access.token('SAM@example.com')), 'partner');
  assert.equal(await as(await access.token('someone@example.com')), null);
  assert.equal(await as(await access.token('alex@example.com', { audience: 'other-app' })), null);
  assert.equal(
    await as(
      await access.token('alex@example.com', { issuer: 'https://other.cloudflareaccess.com' }),
    ),
    null,
  );
  assert.equal(await as(await access.token('alex@example.com', { expires: '-1m' })), null);
  assert.equal(await as('not-a-token'), null);
  assert.equal(await auth.current(get('https://app.example/api/state')), null);
  // Cloudflare routes only the Worker's own addresses to it, so each is served as itself.
  assert.equal(auth.served(get('https://app.example/')), 'https://app.example');
});

test('Access-protected API: a missing token is refused, and writes need the app header and own origin', async () => {
  const access = await testAccess();
  const app = await openHousehold(openStore(), access.config, { accessKeys: access.keys });
  const base = 'https://household-assistant.example.workers.dev';
  try {
    const anonymous = client(app, 'owner', base);
    assert.equal((await anonymous.call('/api/state')).status, 401);
    const headers = { 'Cf-Access-Jwt-Assertion': await access.token('sam@example.com') };
    const state = (await (
      await anonymous.call('/api/state', undefined, 'GET', headers)
    ).json()) as {
      me: { id: string; name: string };
      signIn: string;
    };
    assert.deepEqual(
      [state.me.id, state.me.name, state.signIn],
      ['partner', 'Sam', 'cloudflare-access'],
    );
    const presence = { threadId: null, clientId: crypto.randomUUID(), typing: false };
    assert.equal((await anonymous.call('/api/presence', presence, 'POST', headers)).status, 200);
    const refusals: Record<string, string>[] = [
      { 'X-Household-Client': '0' },
      { Origin: 'https://evil.example' },
    ];
    for (const extra of refusals)
      assert.equal(
        (await anonymous.call('/api/presence', presence, 'POST', { ...headers, ...extra })).status,
        403,
      );
  } finally {
    await app.conversations.close();
  }
});
