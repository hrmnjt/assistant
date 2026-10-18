// Isolated test host: the Worker's API handler on Node, with no secrets, live model or calendar.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { CalendarOutcomeError, CalendarService } from '../../server/plugins/calendar/service.js';
import { CalendarPlugin } from '../../server/plugins/calendar/index.js';
import { handle } from '../../server/api.js';
import { openHousehold } from '../../server/runtime.js';
import { securityHeaders } from '../../server/http.js';
import { updateEventData } from '../../server/plugins/calendar/icalendar.js';
import type { CalendarResource, CalendarTransport } from '../../server/plugins/calendar/caldav.js';
import { directory, openStore } from '../support.js';

if (process.env.HOUSEHOLD_BROWSER_TEST !== '1') throw new Error('Use npm run test:browser.');
const origin = 'http://127.0.0.1:4173';
const path = directory('browser');
const db = openStore(resolve(path, 'household.sqlite'));
let resource: CalendarResource | null = null;
const transport: CalendarTransport = {
  async collection() {
    return { name: 'Household', url: 'https://calendar.invalid/household/' };
  },
  async list() {
    return resource ? [resource] : [];
  },
  async get() {
    return resource;
  },
  async put(url, data) {
    resource = { url, data, etag: '"initial"' };
    throw new Error('Simulate response lost after remote acceptance');
  },
  async remove() {
    throw new Error('No delete expected in this fixture');
  },
};
const app = await openHousehold(
  db,
  {
    APP_ORIGIN: origin,
    OWNER_USERNAME: 'owner',
    OWNER_NAME: 'Alex',
    OWNER_PASSWORD: 'Browser-test-owner-password',
    PARTNER_USERNAME: 'partner',
    PARTNER_NAME: 'Sam',
    PARTNER_PASSWORD: 'Browser-test-partner-password',
  },
  { transport },
);
const fields = {
  title: 'Uncertain browser appointment',
  notes: '',
  location: '',
  allDay: false,
  reminderMinutes: 30,
  start: new Date(Date.now() + 3_600_000).toISOString(),
  end: new Date(Date.now() + 7_200_000).toISOString(),
};
async function reset() {
  // Each test/project starts with isolated fixture state, even on repeated runs.
  await db.transaction(async (tx) => {
    for (const table of [
      'sessions',
      'presence',
      'notices',
      'task_history',
      'household_tasks',
      'previews',
      'audit',
    ])
      await tx.run(`DELETE FROM ${table}`);
  });
  resource = null;
  const earlier = await new CalendarService(
    db,
    transport,
    () => new Date(Date.now() - 1_200_000),
  ).load();
  const pending = await earlier.preview('owner', { kind: 'calendar.create', event: fields });
  await assert.rejects(
    earlier.confirm('owner', pending.id),
    (error) => error instanceof CalendarOutcomeError && error.calendarOutcome.status === 'unknown',
  );
  const old = await transport.get('https://calendar.invalid/household/');
  if (!old) throw new Error('Test setup failed');
  resource = {
    ...old,
    etag: '"human"',
    data: updateEventData(old, { ...fields, title: 'Later human calendar edit' }, 'human-edit'),
  };
  const calendar = app.plugins.find((plugin) => plugin instanceof CalendarPlugin);
  await calendar!.service.sync();
}
await reset();

const dist = resolve('dist');
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
/** Static assets with the same single-page fallback as the Worker's asset binding. */
async function asset(pathname: string) {
  const file = resolve(dist, `.${decodeURIComponent(pathname)}`);
  const inside = file.startsWith(dist + sep);
  const data = inside ? await readFile(file).catch(() => null) : null;
  const [body, type] = data
    ? [data, types[extname(file)] ?? 'application/octet-stream']
    : [await readFile(resolve(dist, 'index.html')), types['.html']];
  return new Response(body, {
    headers: { ...securityHeaders, 'Cache-Control': 'no-cache', 'Content-Type': type },
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', origin);
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers))
    if (typeof value === 'string') headers.set(key, value);
  const request = new Request(url, {
    method: req.method,
    headers,
    ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
  });
  let response: Response;
  if (url.pathname === '/__test/reset' && req.method === 'POST') {
    // Test-only fixture reset; the deployed Worker has no such route.
    if (req.headers['x-household-test'] === 'reset') {
      await reset();
      response = new Response(null, { status: 204 });
    } else response = new Response(null, { status: 403 });
  } else if (url.pathname.startsWith('/api/')) response = await handle(app, request, 'browser');
  else response = await asset(url.pathname);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});
server.listen(4173, '127.0.0.1');

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await new Promise<void>((done) => server.close(() => done()));
  await app.conversations.close();
  rmSync(path, { recursive: true, force: true });
}
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
