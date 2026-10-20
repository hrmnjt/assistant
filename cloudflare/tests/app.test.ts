import { env, exports } from 'cloudflare:workers';
import {
  abortAllDurableObjects,
  createExecutionContext,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createECDH, randomBytes } from 'node:crypto';
import { ICloudTransport } from '../../server/plugins/calendar/caldav.js';
import type { Runtime } from '../../server/runtime.js';
import { identityHeader } from '../../server/auth.js';
import worker, { type Env, type Household } from '../worker.js';

const bindings = env as unknown as Env;
const origin = 'https://assistant.example.workers.dev';
const stub = () => bindings.HOUSEHOLD.getByName('household');
const runtime = (instance: Household) => (instance as unknown as { runtime: Runtime }).runtime;
/**
 * The Worker's own entry point, as Cloudflare calls it: with Access in front,
 * the request context carries the identity Access verified; without, none.
 */
function context(email?: string) {
  const ctx = createExecutionContext();
  return {
    waitUntil: (promise: Promise<unknown>) => ctx.waitUntil(promise),
    passThroughOnException: () => ctx.passThroughOnException(),
    props: {},
    access: email ? { aud: 'test-audience', getIdentity: async () => ({ email }) } : undefined,
  } as unknown as ExecutionContext;
}
const call = (
  path: string,
  value?: unknown,
  email?: string,
  headers: Record<string, string> = {},
) =>
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
    bindings,
    context(email),
  );
// Both people come from the Worker's variables (see cloudflare/vitest.config.ts).
const alex = 'alex@example.com';
const sam = 'sam@example.com';
/** Outbound requests; each test that expects some supplies its own. */
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
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => network(input, init));
});
afterEach(() => {
  vi.restoreAllMocks();
});

it('serves the app shell and the API from one Worker; Cloudflare Access names who is asking', async () => {
  const shell = await call('/tasks/anything');
  expect(shell.status).toBe(200);
  expect(await shell.text()).toContain('<div id="root">');
  expect((await call('/api/health')).status).toBe(200);
  // No Access identity, or a client claiming one, is nobody.
  expect((await call('/api/state')).status).toBe(401);
  expect((await call('/api/state', undefined, undefined, { [identityHeader]: alex })).status).toBe(
    401,
  );
  const state = (await (await call('/api/state', undefined, alex)).json()) as any;
  expect([state.me.id, state.me.name, state.signIn]).toEqual([
    'owner',
    'Alex',
    'cloudflare-access',
  ]);
  expect((await call('/api/state', undefined, 'guest@example.com')).status).toBe(401);
  const foreign = await call('/api/previews', { kind: 'task.create', task }, alex, {
    Origin: 'https://attacker.test',
  });
  expect(foreign.status).toBe(403);
});

it('confirms a task for both spouses and keeps it across a Durable Object restart', async () => {
  const preview = (await (
    await call('/api/previews', { kind: 'task.create', task }, alex)
  ).json()) as { id: string };
  expect((await call(`/api/previews/${preview.id}/confirm`, {}, alex)).status).toBe(200);
  // A new instance reads the same SQLite storage, including who the two people are.
  await abortAllDurableObjects();
  const state = (await (await call('/api/state', undefined, sam)).json()) as any;
  expect(state.me.name).toBe('Sam');
  expect(state.tasks.map((item: { title: string }) => item.title)).toEqual(['Water the plants']);
  expect(state.notices[0].title).toBe('Alex added a task');
  expect((await call('/api/state', undefined, alex)).status).toBe(200);
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
    // The push services' contact is the app's own address, never a person's email.
    const token = /t=([^,\s]+)/.exec(headers.get('authorization')!)![1];
    const claims = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as {
      sub: string;
    };
    expect(claims.sub).toBe(origin);
    return new Response(null, { status: pathname === '/phone' ? 201 : 410 });
  };
  // The household makes its own push keys; there is no push configuration.
  const key = (await (await call('/api/push/key', undefined, sam)).json()) as { publicKey: string };
  expect(key.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
  for (const name of ['phone', 'old-phone'])
    expect((await call('/api/push/subscription', device(name), sam)).status).toBe(200);
  const preview = (await (
    await call('/api/previews', { kind: 'task.create', task }, alex)
  ).json()) as { id: string };
  await call(`/api/previews/${preview.id}/confirm`, {}, alex);
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
