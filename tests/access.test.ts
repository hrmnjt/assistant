import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertionHeader, audienceHeader } from '../server/access.js';
import { openHousehold, type Runtime } from '../server/runtime.js';
import { adminToken, client, deployment, openStore, setUp } from './support.js';

const json = async (response: Response) => (await response.json()) as any;
const base = 'https://assistant.example.workers.dev';
const issuer = 'https://household-team.cloudflareaccess.com';
const audience = 'synthetic-access-application';

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** An Access team for tests: its signing key, published certificates, and tokens it signs. */
async function accessTeam(iss = issuer, kid = 'key-1') {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid };
  return {
    iss,
    certs: { keys: [jwk] },
    async sign(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
      const now = Math.floor(Date.now() / 1000);
      const head = encode({ alg: 'RS256', kid, typ: 'JWT', ...header });
      const body = encode({
        iss,
        aud: [audience],
        email: 'Alex@Example.com',
        iat: now,
        nbf: now,
        exp: now + 3600,
        ...claims,
      });
      const signature = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        pair.privateKey,
        new TextEncoder().encode(`${head}.${body}`),
      );
      return `${head}.${body}.${Buffer.from(signature).toString('base64url')}`;
    },
  };
}

/** Access's published certificates, served to the app; counts each fetch. */
function publish(...teams: Awaited<ReturnType<typeof accessTeam>>[]) {
  const original = globalThis.fetch;
  const fetched: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    fetched.push(url);
    const team = teams.find((item) => url === `${item.iss}/cdn-cgi/access/certs`);
    return team ? Response.json(team.certs) : new Response('Not found', { status: 404 });
  }) as typeof fetch;
  return { fetched, restore: () => (globalThis.fetch = original) };
}

/** The admin page, signed in, with Access's token on its requests. */
async function adminPage(app: Runtime, token: string, headers: Record<string, string> = {}) {
  const signIn = await client(app, null, base).call('/api/admin/session', { token: adminToken });
  const cookie = signIn.headers.get('set-cookie')!.split(';')[0];
  return client(app, null, base).call('/api/admin/state', undefined, 'GET', {
    Cookie: cookie,
    [assertionHeader]: token,
    ...headers,
  });
}

test('without an identity from the Worker, a person is known by Access’s signed token once the admin page trusts its signer', async () => {
  const team = await accessTeam();
  const certs = publish(team);
  const app = await openHousehold(openStore(), deployment);
  await setUp(app.household);
  const person = (token: string) =>
    client(app, null, base).call('/api/state', undefined, 'GET', { [assertionHeader]: token });
  try {
    const token = await team.sign();
    // Nothing is trusted until the admin's page has recorded the Access team and application.
    assert.equal((await person(token)).status, 401);
    const state = await json(await adminPage(app, token, { [audienceHeader]: audience }));
    assert.deepEqual([state.access, state.accessToken], ['alex@example.com', true]);
    const me = await json(await person(token));
    assert.deepEqual([me.me.id, me.me.name], ['owner', 'Alex']);
    // Access's keys are fetched once and kept.
    await person(await team.sign({ email: 'sam@example.com' }));
    assert.deepEqual(certs.fetched, [`${issuer}/cdn-cgi/access/certs`]);
    // A token for another application, expired, altered, or unsigned is nobody.
    const [head, body] = token.split('.');
    const altered = `${head}.${encode({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), email: 'sam@example.com' })}.${token.split('.')[2]}`;
    const refused = [
      await team.sign({ aud: ['another-application'] }),
      await team.sign({ exp: Math.floor(Date.now() / 1000) - 3600 }),
      await team.sign({ nbf: Math.floor(Date.now() / 1000) + 3600 }),
      altered,
      `${encode({ alg: 'none', kid: 'key-1' })}.${body}.`,
      await team.sign({}, { kid: 'unknown-key' }),
      'not-a-token',
    ];
    for (const value of refused) assert.equal((await person(value)).status, 401, value);
    // Unknown key ids do not make the app fetch Access's keys again right away.
    assert.equal(certs.fetched.length, 1);
  } finally {
    certs.restore();
    await app.conversations.close();
  }
});

test('the admin page trusts only a token Access really signed, for one application', async () => {
  const team = await accessTeam();
  const impostor = await accessTeam('https://someone-else.cloudflareaccess.com');
  // A key that claims to be the team's but is not in its published certificates.
  const forger = await accessTeam(issuer, 'key-1');
  const certs = publish(team, impostor);
  try {
    for (const [token, headers] of [
      // Signed by a key Access did not publish for the team.
      [await forger.sign(), { [audienceHeader]: audience }],
      // Not from a Cloudflare Access team at all.
      [await (await accessTeam('https://example.com')).sign(), { [audienceHeader]: audience }],
      // Several applications and no name from the Worker: unclear which to trust.
      [await team.sign({ aud: [audience, 'another-application'] }), {}],
      // A token for another application than the one the Worker names.
      [await team.sign({ aud: ['another-application'] }), { [audienceHeader]: audience }],
    ] as const) {
      const app = await openHousehold(openStore(), deployment);
      await setUp(app.household);
      try {
        const state = await json(await adminPage(app, token, headers));
        assert.equal(state.access, null);
        const person = await client(app, null, base).call('/api/state', undefined, 'GET', {
          [assertionHeader]: await team.sign(),
        });
        assert.equal(person.status, 401);
      } finally {
        await app.conversations.close();
      }
    }
    // Trusting one team does not admit another team's tokens.
    const app = await openHousehold(openStore(), deployment);
    await setUp(app.household);
    try {
      assert.equal(
        (await json(await adminPage(app, await team.sign()))).access,
        'alex@example.com',
      );
      const other = await client(app, null, base).call('/api/state', undefined, 'GET', {
        [assertionHeader]: await impostor.sign({ aud: [audience] }),
      });
      assert.equal(other.status, 401);
    } finally {
      await app.conversations.close();
    }
  } finally {
    certs.restore();
  }
});
