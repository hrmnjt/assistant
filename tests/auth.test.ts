import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identityHeader, withAccessIdentity } from '../server/auth.js';
import { assertionHeader, audienceHeader } from '../server/access.js';
import { openHousehold, type Runtime } from '../server/runtime.js';
import {
  adminToken,
  client,
  config,
  deployment,
  json,
  openStore,
  people,
  setUp,
} from './support.js';

const base = 'https://assistant.example.workers.dev';

/** Run `work` on an open assistant, then stop it. */
async function running(opening: Promise<Runtime>, work: (app: Runtime) => Promise<void>) {
  const app = await opening;
  try {
    await work(app);
  } finally {
    await app.conversations.close();
  }
}

test('the Worker replaces any identity a client sends with the one Cloudflare Access verified', async () => {
  const spoofed = new Request(`${base}/api/state`, {
    headers: {
      [identityHeader]: people.partner.email,
      [audienceHeader]: 'claimed-by-client',
      Cookie: 'kept=1',
    },
  });
  const anonymous = await withAccessIdentity(spoofed);
  assert.equal(anonymous.headers.get(identityHeader), null);
  assert.equal(anonymous.headers.get(audienceHeader), null);
  assert.equal(anonymous.headers.get('cookie'), 'kept=1');
  const verified = await withAccessIdentity(spoofed, {
    aud: 'access-application',
    getIdentity: async () => ({ email: ' Alex@Example.com ' }),
  });
  assert.equal(verified.headers.get(identityHeader), people.owner.email);
  assert.equal(verified.headers.get(audienceHeader), 'access-application');
  // Access present but without an email (a service token, say) is still nobody.
  const tokenOnly = await withAccessIdentity(spoofed, { getIdentity: async () => ({}) });
  assert.equal(tokenOnly.headers.get(identityHeader), null);
});

test('on a deployment only the two emails the admin added get in', async () => {
  await running(openHousehold(openStore(), deployment), async (app) => {
    const state = (person: 'owner' | 'partner' | null, headers: Record<string, string> = {}) =>
      client(app, person, base).call('/api/state', undefined, 'GET', headers);
    // Until the admin adds them, someone Access signed in learns the app is not set up yet.
    assert.equal((await state('owner')).status, 503);
    assert.equal((await state(null)).status, 401);
    assert.equal((await client(app, null, base).call('/api/admin/session')).status, 200);
    await setUp(app.household);
    const owner = await json(await state('owner'));
    assert.deepEqual(
      [owner.me.id, owner.me.name, owner.signIn],
      ['owner', 'Alex', 'cloudflare-access'],
    );
    assert.equal((await json(await state('partner'))).me.id, 'partner');
    // A third email, even one Access let in, is refused, and there is no setup to run.
    assert.equal((await state(null, { [identityHeader]: 'guest@example.com' })).status, 401);
    assert.equal((await state(null)).status, 401);
    const setup = await client(app, 'owner', base).call('/api/setup', { name: 'Again' });
    assert.equal(setup.status, 404);
  });
});

test('requests from another site or another computer are refused', async () => {
  await running(openHousehold(openStore(), deployment), async (app) => {
    await setUp(app.household);
    const owner = client(app, 'owner', base);
    const channel = { kind: 'thread.create', title: 'Holiday', category: 'household' };
    // On a deployment, a write needs the app's own header and, when sent, its own origin.
    const elsewhere: Record<string, string>[] = [
      { 'X-Household-Client': '0' },
      { Origin: 'https://elsewhere.example' },
    ];
    for (const headers of elsewhere)
      assert.equal((await owner.call('/api/previews', channel, 'POST', headers)).status, 403);
    assert.deepEqual(await json(await owner.call('/api/previews')), []);
    assert.equal((await owner.call('/api/previews', channel)).status, 201);
  });
  await running(openHousehold(openStore(), config), async (app) => {
    await setUp(app.household);
    // A development server answers on this computer's own names only, so another site's
    // hostname (DNS rebinding) or a public tunnel cannot reach it.
    for (const at of ['http://localhost:8787', 'http://127.0.0.1:9000', 'http://[::1]:8787'])
      assert.equal((await client(app, 'owner', at).call('/api/state')).status, 200, at);
    for (const at of ['http://rebound.example', 'https://abc.trycloudflare.com'])
      assert.equal((await client(app, 'owner', at).call('/api/state')).status, 403, at);
  });
});

const issuer = 'https://household-team.cloudflareaccess.com';
const audience = 'synthetic-access-application';
const certs = `${issuer}/cdn-cgi/access/certs`;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const signingKey = async () =>
  (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;

/** The admin page, signed in: whom Access signed in, for a request carrying Access's headers. */
async function adminPage(app: Runtime) {
  const signedIn = await client(app, null, base).call('/api/admin/session', { token: adminToken });
  const Cookie = signedIn.headers.get('set-cookie')!.split(';')[0];
  return async (headers: Record<string, string>) => {
    const state = await client(app, null, base).call('/api/admin/state', undefined, 'GET', {
      Cookie,
      ...headers,
    });
    return (await json(state)).access;
  };
}

test('without an identity from the Worker, people are known by Access’s signed token once the admin page has trusted its signer', async () => {
  let now = Date.parse('2026-10-20T09:00:00Z');
  // Access's published key, and one it never published that claims the same id.
  const [genuine, forged] = await Promise.all([signingKey(), signingKey()]);
  const published = {
    keys: [{ ...(await crypto.subtle.exportKey('jwk', genuine.publicKey)), kid: 'key-1' }],
  };
  const sign = async (
    claims: Record<string, unknown> = {},
    { key = genuine, kid = 'key-1' } = {},
  ) => {
    const seconds = Math.floor(now / 1000);
    const head = encode({ alg: 'RS256', kid, typ: 'JWT' });
    const body = encode({
      iss: issuer,
      aud: [audience],
      email: people.owner.email,
      iat: seconds,
      nbf: seconds,
      exp: seconds + 3600,
      ...claims,
    });
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      key.privateKey,
      new TextEncoder().encode(`${head}.${body}`),
    );
    return `${head}.${body}.${Buffer.from(signature).toString('base64url')}`;
  };
  const app = await openHousehold(openStore(), deployment, { clock: () => new Date(now) });
  const fetched: string[] = [];
  const original = globalThis.fetch;
  // Whatever address the app asks for keys answers with these, as a forger's own site would.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetched.push(String(input));
    return Response.json(published);
  }) as typeof fetch;
  try {
    await setUp(app.household);
    const person = (token: string) =>
      client(app, null, base).call('/api/state', undefined, 'GET', { [assertionHeader]: token });
    const signedInAs = await adminPage(app);
    const token = await sign();
    const named = { [audienceHeader]: audience };
    assert.equal((await person(token)).status, 401);
    // The admin page trusts only a token Access really signed, for one application.
    const untrusted: [string, Record<string, string>][] = [
      [await sign({}, { key: forged }), named],
      [await sign({ iss: 'https://example.com' }), named],
      // Several applications, and no name from the Worker: unclear which to trust.
      [await sign({ aud: [audience, 'another-application'] }), {}],
      [await sign({ aud: ['another-application'] }), named],
    ];
    for (const [value, headers] of untrusted) {
      assert.equal(await signedInAs({ [assertionHeader]: value, ...headers }), null);
      assert.equal((await person(token)).status, 401);
    }
    assert.equal(await signedInAs({ [assertionHeader]: token, ...named }), people.owner.email);
    assert.equal((await json(await person(token))).me.id, 'owner');
    const sam = await sign({ email: people.partner.email });
    assert.equal((await json(await person(sam))).me.id, 'partner');
    // Expired, for another application, from another team, or not signed by Access: nobody.
    const refused = [
      await sign({ exp: Math.floor(now / 1000) - 3600 }),
      await sign({ aud: ['another-application'] }),
      await sign({ iss: 'https://another-team.cloudflareaccess.com' }),
      await sign({}, { key: forged }),
      await sign({}, { kid: 'unknown-key' }),
    ];
    for (const value of refused) assert.equal((await person(value)).status, 401);
    // Access's keys were fetched once; an unknown key id refetches them at most once a minute.
    assert.deepEqual(fetched, [certs]);
    now += 61_000;
    assert.equal((await person(await sign({}, { kid: 'unknown-key' }))).status, 401);
    assert.deepEqual(fetched, [certs, certs]);
  } finally {
    globalThis.fetch = original;
    await app.conversations.close();
  }
});
