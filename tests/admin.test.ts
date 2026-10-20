import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { identityHeader } from '../server/auth.js';
import { openHousehold, type Runtime } from '../server/runtime.js';
import type { CalendarConnector } from '../server/plugins/calendar/caldav.js';
import {
  adminToken,
  client,
  deployment,
  directory,
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

/** The admin page's requests, keeping its session cookie as a browser does. */
function admin(app: Runtime, cookie = '') {
  const call = async (
    path: string,
    body?: unknown,
    method = body === undefined ? 'GET' : 'POST',
    headers: Record<string, string> = {},
  ) => {
    const response = await client(app, null, base).call(path, body, method, {
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    });
    const set = response.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return response;
  };
  return {
    call,
    signIn: (token = adminToken) => call('/api/admin/session', { token }),
    get cookie() {
      return cookie;
    },
  };
}

test('the admin signs in with ADMIN_TOKEN, separately from the two people', async () => {
  for (const ADMIN_TOKEN of [undefined, 'too-short'])
    await running(openHousehold(openStore(), { ADMIN_TOKEN }), async (app) => {
      const page = admin(app);
      assert.ok((await json(await page.call('/api/admin/session'))).unavailable);
      assert.equal((await page.signIn('too-short')).status, 503);
    });
  let now = Date.parse('2026-10-20T09:00:00Z');
  const clock = () => new Date(now);
  const path = `${directory('admin')}/household.sqlite`;
  let session = '';
  await running(openHousehold(openStore(path), deployment, { clock }), async (app) => {
    await setUp(app.household);
    const page = admin(app);
    assert.equal((await page.call('/api/admin/state')).status, 401);
    assert.equal((await page.signIn('not the token')).status, 401);
    const signedIn = await page.signIn();
    assert.equal(signedIn.status, 200);
    const flags = signedIn.headers.get('set-cookie')!.split('; ');
    for (const flag of ['Path=/api/admin', 'HttpOnly', 'SameSite=Strict', 'Secure'])
      assert.ok(flags.includes(flag), flag);
    // The page shows who Cloudflare Access signed in on this request.
    const state = await page.call('/api/admin/state', undefined, 'GET', {
      [identityHeader]: people.owner.email,
    });
    assert.equal((await json(state)).access, people.owner.email);
    // The admin's session is not a person's sign-in, and a person's is not the admin's.
    assert.equal((await page.call('/api/state')).status, 401);
    assert.equal((await client(app, 'owner', base).call('/api/admin/state')).status, 401);
    // Signing out ends the session itself, not just the browser's cookie.
    const signedOut = page.cookie;
    assert.equal((await page.call('/api/admin/session', undefined, 'DELETE')).status, 200);
    assert.equal((await admin(app, signedOut).call('/api/admin/state')).status, 401);
    // Five wrong tokens lock sign-in, even with the right token, until the lock passes.
    for (let attempt = 0; attempt < 5; attempt++)
      assert.equal((await page.signIn(`wrong-${attempt}`)).status, 401);
    assert.equal((await page.signIn()).status, 429);
    now += 16 * 60_000;
    assert.equal((await page.signIn()).status, 200);
    session = page.cookie;
  });
  // A session outlasts a restart, but a new ADMIN_TOKEN ends those made with the old one.
  const rotated = { ADMIN_TOKEN: `${adminToken}-rotated` };
  for (const [settings, status] of [
    [deployment, 200],
    [rotated, 401],
  ] as const)
    await running(openHousehold(openStore(path), settings, { clock }), async (app) => {
      assert.equal((await admin(app, session).call('/api/admin/state')).status, status);
    });
});

test('adding and renaming the two people keeps their records and their assistant chats', async () => {
  await running(openHousehold(openStore(), deployment), async (app) => {
    const page = admin(app);
    await page.signIn();
    const save = (value: unknown) => page.call('/api/admin/people', { people: value }, 'PUT');
    const signedIn = async (email: string) => {
      const response = await client(app, null, base).call('/api/state', undefined, 'GET', {
        [identityHeader]: email,
      });
      return response.ok ? await json(response) : null;
    };
    const threads = (state: any) => state.threads.map((thread: any) => thread.id).sort();
    // Each person needs an email of their own.
    for (const value of [
      [people.owner, { name: 'Sam', email: people.owner.email.toUpperCase() }],
      [people.owner, { name: 'Sam' }],
    ])
      assert.equal((await save(value)).status, 400, JSON.stringify(value));
    assert.equal(
      (await save([people.owner, { name: 'Sam', email: 'Sam@Example.com' }])).status,
      200,
    );
    const sam = await signedIn(people.partner.email);
    assert.equal(sam.me.name, 'Sam');
    assert.deepEqual(sam.threads.flatMap((thread: any) => thread.assistantFor ?? []).sort(), [
      'owner',
      'partner',
    ]);
    const channel = { kind: 'thread.create', title: 'Holiday', category: 'household' };
    assert.equal((await client(app, 'partner', base).call('/api/previews', channel)).status, 201);
    // Saved again as they are, then Sam is renamed and moves email; Alex takes Sam's old address.
    assert.equal((await save([people.owner, people.partner])).status, 200);
    const renamed = [
      { name: 'Alex', email: people.partner.email },
      { name: 'Sammy', email: 'sam@new.example' },
    ];
    assert.equal((await save(renamed)).status, 200);
    assert.equal(await signedIn(people.owner.email), null);
    assert.equal((await signedIn(people.partner.email)).me.id, 'owner');
    const moved = await signedIn('sam@new.example');
    assert.deepEqual([moved.me.id, moved.me.name, moved.previews.length], ['partner', 'Sammy', 1]);
    // Neither save added a chat or lost one.
    assert.deepEqual(threads(moved), threads(sam));
    assert.deepEqual((await json(await page.call('/api/admin/state'))).people, [
      { id: 'owner', ...renamed[0] },
      { id: 'partner', ...renamed[1] },
    ]);
  });
});

const account = { username: 'family@icloud.example', password: 'abcd-efgh-ijkl-mnop' };
/** iCloud for tests: the account has a shared calendar and a personal one, both empty. */
const icloud: CalendarConnector = {
  calendars: async ({ username, password }) => {
    if (username !== account.username || password !== account.password) throw new Error('401');
    return [
      { name: 'Household', url: 'https://caldav.icloud.com/1/calendars/home/' },
      { name: 'Personal', url: 'https://caldav.icloud.com/1/calendars/mine/' },
    ];
  },
  open: ({ calendarUrl }) => ({
    collection: async () => ({
      name: calendarUrl.endsWith('/home/') ? 'Household' : 'Personal',
      url: calendarUrl,
    }),
    list: async () => [],
    get: async () => null,
    put: async () => undefined,
    remove: async () => undefined,
  }),
};

test('the admin connects iCloud; it is kept across restarts, its password stays private, and it can be removed', async () => {
  const path = `${directory('admin')}/household.sqlite`;
  await running(openHousehold(openStore(path), deployment, { connector: icloud }), async (app) => {
    await setUp(app.household);
    const page = admin(app);
    await page.signIn();
    const wrong = { ...account, password: 'wrong-password' };
    assert.equal((await page.call('/api/admin/calendar', wrong)).status, 400);
    // Without a chosen calendar, the account's calendars to choose from.
    const listed = await json(await page.call('/api/admin/calendar', account));
    assert.deepEqual(
      listed.calendars.map((calendar: { name: string }) => calendar.name),
      ['Household', 'Personal'],
    );
    const calendarUrl = listed.calendars[0].url;
    const connected = await page.call('/api/admin/calendar', { ...account, calendarUrl });
    assert.equal(connected.status, 200);
    const adminState = await json(await page.call('/api/admin/state'));
    assert.deepEqual(adminState.calendar, {
      status: 'connected',
      name: 'Household',
      account: account.username,
      error: null,
    });
    const personState = await json(await client(app, 'partner', base).call('/api/state'));
    assert.equal(personState.integrations.calendar, 'connected');
    for (const body of [listed, await json(connected), adminState, personState])
      assert.ok(!JSON.stringify(body).includes(account.password));
  });
  await running(openHousehold(openStore(path), deployment, { connector: icloud }), async (app) => {
    const owner = client(app, 'owner', base);
    const calendar = async () => (await json(await owner.call('/api/state'))).integrations.calendar;
    assert.equal((await owner.call('/api/calendar/refresh', {})).status, 200);
    assert.equal(await calendar(), 'connected');
    const page = admin(app);
    await page.signIn();
    assert.equal((await page.call('/api/admin/calendar', undefined, 'DELETE')).status, 200);
    assert.equal(await calendar(), 'not-connected');
    assert.equal((await json(await page.call('/api/admin/state'))).calendar.account, null);
  });
});

const granted = (scope = 'openid offline_access resource.invoke chatgpt.tokens.use.direct') =>
  Response.json({
    access_token: 'synthetic-access',
    refresh_token: 'synthetic-refresh',
    id_token: 'synthetic-id',
    scope,
    expires_in: 3600,
  });
/** OpenAI for tests: its token endpoint answers with `reply`; the account lists three models. */
function fakeOpenAI() {
  const original = globalThis.fetch;
  const openai = {
    exchanges: [] as URLSearchParams[],
    reply: () => granted(),
    restore: () => {
      globalThis.fetch = original;
    },
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://api.openai.com/v1/models')
      return Response.json({
        models: [
          { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list' },
          { slug: 'gpt-6-sol', display_name: 'GPT-6 Sol', visibility: 'hide' },
          { slug: 'unknown-model', display_name: 'Unknown', visibility: 'list' },
        ],
      });
    if (url !== 'https://auth.openai.com/api/accounts/oauth/token')
      return new Response(null, { status: 404 });
    openai.exchanges.push(new URLSearchParams(String(init?.body)));
    return openai.reply();
  }) as typeof fetch;
  return openai;
}
/** The address the browser ends on after signing in, for the sign-in that `url` started. */
const returnedTo = (url: string) =>
  `http://127.0.0.1:1455/auth/callback?code=synthetic-code&client_id=issued-client&state=${new URL(url).searchParams.get('state')}`;

test('the admin connects ChatGPT by pasting back the address its sign-in ended on, then chooses the model', async () => {
  // pi-ai checks the credential's expiry against the real clock, so this clock starts now.
  let now = Date.now();
  const app = await openHousehold(openStore(), deployment, { clock: () => new Date(now) });
  const openai = fakeOpenAI();
  try {
    await setUp(app.household);
    const page = admin(app);
    await page.signIn();
    const owner = client(app, 'owner', base);
    const assistant = async () => (await json(await owner.call('/api/state'))).integrations.ai;
    const start = async (): Promise<string> =>
      (await json(await page.call('/api/admin/chatgpt/start', {}))).url;
    const finish = (address: string) => page.call('/api/admin/chatgpt/finish', { address });
    assert.equal((await page.call('/api/admin/models')).status, 409);
    assert.equal(await assistant(), 'not-connected');
    // A sign-in lasts ten minutes.
    const late = await start();
    now += 11 * 60_000;
    assert.equal((await finish(returnedTo(late))).status, 409);
    // An address that is not from this sign-in never reaches OpenAI.
    const url = await start();
    assert.equal(new URL(url).searchParams.get('code_challenge_method'), 'S256');
    const forged = returnedTo(url).replace(/state=[^&]+/, 'state=forged');
    assert.equal((await finish(forged)).status, 400);
    assert.equal(openai.exchanges.length, 0);
    // OpenAI's own error text is never shown.
    openai.reply = () =>
      Response.json(
        { error: 'invalid_grant', error_description: 'synthetic provider detail' },
        { status: 400 },
      );
    const failed = await finish(returnedTo(url));
    assert.equal(failed.status, 502);
    assert.ok(!JSON.stringify(await json(failed)).includes('invalid_grant'));
    // Without the plan's scope, ChatGPT is not connected.
    openai.reply = () => granted('openid offline_access');
    assert.equal((await finish(returnedTo(await start()))).status, 502);
    assert.equal(await assistant(), 'not-connected');
    // The code goes to OpenAI with the verifier that only the server kept.
    openai.reply = () => granted();
    const signIn = await start();
    assert.equal((await finish(returnedTo(signIn))).status, 200);
    const exchange = openai.exchanges.at(-1)!;
    assert.deepEqual(
      [exchange.get('code'), exchange.get('client_id')],
      ['synthetic-code', 'issued-client'],
    );
    assert.equal(
      createHash('sha256').update(exchange.get('code_verifier')!).digest('base64url'),
      new URL(signIn).searchParams.get('code_challenge'),
    );
    assert.equal(await assistant(), 'needs-model');
    // Each sign-in finishes once.
    assert.equal((await finish(returnedTo(signIn))).status, 409);
    // The catalog leaves out hidden models and ones the assistant cannot use; a choice applies at once.
    assert.deepEqual(await json(await page.call('/api/admin/models')), {
      current: null,
      models: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }],
    });
    for (const id of ['gpt-6-sol', 'unknown-model'])
      assert.equal((await page.call('/api/admin/model', { id })).status, 400, id);
    assert.equal((await page.call('/api/admin/model', { id: 'gpt-6.1-sol' })).status, 200);
    assert.equal(await assistant(), 'configured');
    // Disconnecting stops the assistant; connecting again resumes the chosen model.
    assert.equal((await page.call('/api/admin/chatgpt', undefined, 'DELETE')).status, 200);
    assert.equal(await assistant(), 'not-connected');
    assert.equal((await finish(returnedTo(await start()))).status, 200);
    assert.equal(await assistant(), 'configured');
  } finally {
    openai.restore();
    await app.conversations.close();
  }
});
