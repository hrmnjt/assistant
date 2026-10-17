import { env } from 'cloudflare:workers';
import { reset, runInDurableObject, abortAllDurableObjects } from 'cloudflare:test';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { createECDH, randomBytes } from 'node:crypto';
import webpush from 'web-push';
import { DurableObjectSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/cloudflare';
import { ICloudTransport } from '../../server/caldav.js';
import { deliverReminder, probeCalendar } from '../probes.js';
import { ObjectCredentials } from '../credentials.js';
import type { Env } from '../worker.js';
const bindings = env as unknown as Env;
const stub = () => bindings.HOUSEHOLD.getByName('integration-test');
beforeEach(async () => {
  await reset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

it('runs real CalDAV discovery, REPORT and iCalendar parsing in workerd with mocked HTTP', async () => {
  const methods: string[] = [];
  const xml = (href: string, props: string) =>
    new Response(
      `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
      { status: 207, headers: { 'Content-Type': 'application/xml' } },
    );
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
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
  });
  const transport = new ICloudTransport({
    username: 'test-user',
    password: 'test-app-password',
    calendarName: 'Household',
  });
  expect(await probeCalendar(transport)).toContain('Household, 1 event records');
  expect(methods).toContain('REPORT');
  expect(methods.every((method) => ['GET', 'PROPFIND', 'REPORT'].includes(method))).toBe(true);
});

it('generates encrypted Web Push in workerd, records per-device success, retries failures and removes expired endpoints', async () => {
  const vapid = { ...webpush.generateVAPIDKeys(), subject: 'mailto:prototype@example.com' };
  const ecdh = createECDH('prime256v1');
  const p256dh = ecdh.generateKeys().toString('base64url');
  const subscription = (suffix: string) => ({
    endpoint: `https://push.apple.com/${suffix}`,
    keys: { p256dh, auth: randomBytes(16).toString('base64url') },
  });
  const first = subscription('first'),
    second = subscription('second');
  const calls: string[] = [];
  let failSecond = true;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    expect(init?.body).toBeInstanceOf(Uint8Array);
    expect(new Headers(init?.headers).get('content-encoding')).toBe('aes128gcm');
    expect(new Headers(init?.headers).get('authorization')).toContain('vapid');
    return new Response(null, { status: path === '/first' ? 201 : failSecond ? 503 : 410 });
  });
  await runInDurableObject(stub(), async (_instance, ctx) => {
    const db = new DurableObjectSqliteDatabase(ctx.storage);
    for (const value of [first, second])
      await db.run(
        'INSERT INTO prototype_subscriptions VALUES (?,?,?)',
        value.endpoint,
        'owner',
        JSON.stringify(value),
      );
    await expect(deliverReminder(db, 'push-job', 'owner', vapid)).rejects.toThrow('Push service');
    expect(await db.all('SELECT * FROM prototype_deliveries')).toHaveLength(1);
    failSecond = false;
    expect(await deliverReminder(db, 'push-job', 'owner', vapid)).toContain(
      '1 expired subscriptions removed',
    );
    expect(await db.all('SELECT * FROM prototype_subscriptions')).toHaveLength(1);
    expect(await deliverReminder(db, 'push-job', 'owner', vapid)).toContain(
      '1 device deliveries accepted',
    );
  });
  expect(calls.filter((path) => path === '/first')).toHaveLength(1);
  expect(calls.filter((path) => path === '/second')).toHaveLength(2);
});

it('serializes OAuth refreshes and persists rotated tokens across object restart without API-key fallback', async () => {
  await runInDurableObject(stub(), async (_instance, ctx) => {
    const credentials = new ObjectCredentials(new DurableObjectSqliteDatabase(ctx.storage));
    await credentials.modify('openai', async () => ({
      type: 'oauth',
      access: 'access-0',
      refresh: 'refresh-0',
      expires: 1,
    }));
    await Promise.all(
      [1, 2, 3].map((index) =>
        credentials.modify('openai', async (current) => {
          expect(current?.type).toBe('oauth');
          if (current?.type !== 'oauth') throw new Error('Missing OAuth');
          expect(current.refresh).toBe(`refresh-${index - 1}`);
          await Promise.resolve();
          return { ...current, access: `access-${index}`, refresh: `refresh-${index}` };
        }),
      ),
    );
    await expect(
      credentials.modify('openai', async () => ({ type: 'api_key', key: 'not-allowed' })),
    ).rejects.toThrow('API-key fallback');
  });
  await abortAllDurableObjects();
  await runInDurableObject(stub(), async (_instance, ctx) => {
    const credentials = new ObjectCredentials(new DurableObjectSqliteDatabase(ctx.storage));
    expect(await credentials.read('openai')).toMatchObject({ refresh: 'refresh-3' });
    await credentials.delete('openai');
    expect(await credentials.list()).toEqual([]);
  });
});
