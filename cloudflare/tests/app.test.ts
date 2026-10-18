import { env, exports } from 'cloudflare:workers';
import {
  abortAllDurableObjects,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createECDH, randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { ICloudTransport } from '../../server/plugins/calendar/caldav.js';
import type { Runtime } from '../../server/runtime.js';
import type { Env, Household } from '../worker.js';

const bindings = env as unknown as Env;
const origin = 'https://household-assistant.example.workers.dev';
const team = 'https://household.cloudflareaccess.com';
const stub = () => bindings.HOUSEHOLD.getByName('household');
const runtime = (instance: Household) => (instance as unknown as { runtime: Runtime }).runtime;
// The Worker's own entry point, including static assets (no generated `wrangler types`).
const worker = (exports as unknown as { default: Fetcher }).default;
const call = (path: string, value?: unknown, headers: Record<string, string> = {}) =>
  worker.fetch(
    new Request(`${origin}${path}`, {
      method: value === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Household-Client': '1',
        Origin: origin,
        ...headers,
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    }),
  );

// Cloudflare Access signs people in and adds a token naming their email; these
// tests stand in for it with their own key, published at the team's certs URL.
const signing = await generateKeyPair('RS256', { extractable: true });
const certs = { keys: [{ ...(await exportJWK(signing.publicKey)), kid: 'test', alg: 'RS256' }] };
async function signedIn(email: string, audience = 'test-audience') {
  const token = await new SignJWT({ email })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer(team)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(signing.privateKey);
  return { 'Cf-Access-Jwt-Assertion': token };
}
const alex = () => signedIn('alex@example.com');
const sam = () => signedIn('sam@example.com');
/** Outbound requests other than the Access certificates; each test supplies its own. */
let network: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const task = {
  title: 'Water the plants',
  notes: '',
  category: 'household',
  ownerId: 'owner',
  dueAt: null,
  schedule: null,
};

beforeEach(async () => {
  await reset();
  network = async (input) => {
    throw new Error(`Unexpected request to ${String(input)}`);
  };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) =>
    String(input instanceof Request ? input.url : input) === `${team}/cdn-cgi/access/certs`
      ? Response.json(certs)
      : network(input, init),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
});

it('serves the app shell and the API from one Worker, behind Cloudflare Access with origin guards', async () => {
  const shell = await call('/tasks/anything');
  expect(shell.status).toBe(200);
  expect(await shell.text()).toContain('<div id="root">');
  expect((await call('/api/health')).status).toBe(200);
  expect((await call('/api/state')).status).toBe(401);
  expect(
    (await call('/api/state', undefined, await signedIn('alex@example.com', 'other'))).status,
  ).toBe(401);
  expect((await call('/api/state', undefined, await signedIn('guest@example.com'))).status).toBe(
    401,
  );
  const owner = await alex();
  const state = (await (await call('/api/state', undefined, owner)).json()) as any;
  expect([state.me.id, state.signIn]).toEqual(['owner', 'cloudflare-access']);
  const foreign = await call(
    '/api/previews',
    { kind: 'task.create', task },
    {
      ...owner,
      Origin: 'https://attacker.test',
    },
  );
  expect(foreign.status).toBe(403);
});

it('confirms a task for both spouses and keeps it across a Durable Object restart', async () => {
  const owner = await alex();
  const preview = (await (
    await call('/api/previews', { kind: 'task.create', task }, owner)
  ).json()) as { id: string };
  expect((await call(`/api/previews/${preview.id}/confirm`, {}, owner)).status).toBe(200);
  // A new instance reads the same SQLite storage and fetches the Access certificates again.
  await abortAllDurableObjects();
  const state = (await (await call('/api/state', undefined, await sam())).json()) as any;
  expect(state.tasks.map((item: { title: string }) => item.title)).toEqual(['Water the plants']);
  expect(state.notices[0].title).toBe('Alex added a task');
  expect((await call('/api/state', undefined, owner)).status).toBe(200);
});

it('delivers encrypted Web Push from the alarm and removes expired devices', async () => {
  const ecdh = createECDH('prime256v1');
  const device = (name: string) => ({
    endpoint: `https://web.push.apple.com/${name}`,
    keys: {
      p256dh: ecdh.generateKeys().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  });
  const calls: string[] = [];
  network = async (input, init) => {
    const { pathname } = new URL(String(input));
    calls.push(pathname);
    const headers = new Headers(init?.headers);
    expect(headers.get('content-encoding')).toBe('aes128gcm');
    expect(headers.get('authorization')).toMatch(/^vapid /);
    return new Response(null, { status: pathname === '/phone' ? 201 : 410 });
  };
  const partner = await sam();
  for (const name of ['phone', 'old-phone'])
    expect((await call('/api/push/subscription', device(name), partner)).status).toBe(200);
  const owner = await alex();
  const preview = (await (
    await call('/api/previews', { kind: 'task.create', task }, owner)
  ).json()) as { id: string };
  await call(`/api/previews/${preview.id}/confirm`, {}, owner);
  await runInDurableObject(stub(), async (_instance, ctx) => {
    expect(await ctx.storage.getAlarm()).not.toBeNull();
  });
  expect(await runDurableObjectAlarm(stub())).toBe(true);
  await runInDurableObject(stub(), async (instance) => {
    const db = runtime(instance).db;
    // The partner change notice (and any daily summary now due) reaches the live phone once each.
    const notices = await db.all<{ id: string; delivery: string }>(
      "SELECT id,delivery FROM notices WHERE user_id='partner'",
    );
    expect(notices.map((notice) => notice.id)).toContainEqual(expect.stringMatching(/^change:/));
    expect(notices.every((notice) => notice.delivery === 'inbox')).toBe(true);
    expect(calls.filter((path) => path === '/phone')).toHaveLength(notices.length);
    expect(calls.filter((path) => path === '/old-phone')).toHaveLength(1);
    expect(await db.all('SELECT endpoint FROM push_subscriptions')).toEqual([
      { endpoint: 'https://web.push.apple.com/phone' },
    ]);
  });
});

it('runs CalDAV discovery, REPORT and iCalendar parsing in workerd', async () => {
  const xml = (href: string, props: string) =>
    new Response(
      `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
      { status: 207, headers: { 'Content-Type': 'application/xml' } },
    );
  const methods: string[] = [];
  network = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method || 'GET';
    methods.push(method);
    expect(new Headers(init?.headers).get('authorization')).toBe(
      `Basic ${btoa('test-user:test-app-password')}`,
    );
    if (path === '/.well-known/caldav') return new Response(null, { status: 404 });
    if (path === '/')
      return xml(
        '/',
        '<d:current-user-principal><d:href>/principal/</d:href></d:current-user-principal>',
      );
    if (path === '/principal/')
      return xml(path, '<c:calendar-home-set><d:href>/calendars/</d:href></c:calendar-home-set>');
    if (path === '/calendars/')
      return xml(
        '/calendars/home/',
        '<d:displayname>Household</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>',
      );
    if (path === '/calendars/home/' && method === 'PROPFIND')
      return xml(path, '<d:supported-report-set/>');
    if (path === '/calendars/home/' && method === 'REPORT')
      return xml(
        '/calendars/home/test.ics',
        '<d:getetag>"version-1"</d:getetag><c:calendar-data><![CDATA[BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:test-event\r\nDTSTART:20261017T120000Z\r\nDTEND:20261017T123000Z\r\nSUMMARY:Test appointment\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n]]></c:calendar-data>',
      );
    throw new Error(`Unexpected request ${method} ${path}`);
  };
  const transport = new ICloudTransport({
    username: 'test-user',
    password: 'test-app-password',
    calendarName: 'Household',
  });
  const collection = await transport.collection();
  expect(collection.name).toBe('Household');
  const events = await transport.list('2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z');
  expect(events).toHaveLength(1);
  expect(events[0].data).toContain('SUMMARY:Test appointment');
  expect(methods.every((method) => ['GET', 'PROPFIND', 'REPORT'].includes(method))).toBe(true);
});
