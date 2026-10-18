import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Database } from '../server/database.js';
import { provision } from '../server/auth.js';
import { Household } from '../server/domain.js';
import { CalendarService } from '../server/calendar.js';
import { Conversations } from '../server/conversations.js';
import { Reminders } from '../server/reminders.js';
import { createApp } from '../server/app.js';
import { recoverablePreviews } from '../server/preview-recovery.js';
import { updateEventData } from '../server/icalendar.js';
import type { CalendarResource, CalendarTransport } from '../server/caldav.js';
import type { Preview, Snapshot } from '../src/types.js';

const start = new Date('2026-10-14T07:00:00Z');
const task = {
  title: 'Saved task',
  notes: '',
  category: 'household',
  ownerId: 'owner',
  dueAt: null,
  schedule: null,
};
const event = {
  title: 'Saved appointment',
  notes: '',
  location: '',
  allDay: false,
  reminderMinutes: 30,
  start: '2026-10-15T10:00:00Z',
  end: '2026-10-15T11:00:00Z',
};

function fixture() {
  mkdirSync('.cache/tests', { recursive: true });
  const path = mkdtempSync(resolve('.cache/tests/previews-'));
  const db = new Database(resolve(path, 'household.sqlite'));
  provision(db, [
    { username: 'owner', name: 'Alex', password: 'Preview-test-owner-password' },
    { username: 'partner', name: 'Sam', password: 'Preview-test-partner-password' },
  ]);
  let resource: CalendarResource | null = null,
    writes = 0;
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
      resource = { url, data, etag: '"1"' };
      writes++;
      throw new Error('Response lost after write');
    },
    async remove() {
      throw new Error('Not used');
    },
  };
  return {
    path,
    db,
    transport,
    household: new Household(db, () => start),
    get writes() {
      return writes;
    },
    humanEdit() {
      assert(resource);
      resource = {
        ...resource,
        etag: '"human"',
        data: updateEventData(resource, { ...event, title: 'Keep human edit' }, 'human'),
      };
    },
  };
}

test('recovery lists actor-owned unexpired previews without calendar tables and omits settled/cancelled/expired previews', () => {
  const f = fixture();
  try {
    const own = f.household.preview('owner', { kind: 'task.create', task });
    f.household.preview('partner', { kind: 'task.create', task });
    const cancelled = f.household.preview('owner', { kind: 'task.create', task });
    f.household.cancel('owner', cancelled.id);
    assert.deepEqual(
      recoverablePreviews(f.db, 'owner', start).map((p) => p.id),
      [own.id],
    );
    assert.equal(recoverablePreviews(f.db, 'partner', start).length, 1);
    assert.deepEqual(recoverablePreviews(f.db, 'owner', new Date(start.getTime() + 600_000)), []);
    f.household.confirm('owner', own.id);
    assert.deepEqual(recoverablePreviews(f.db, 'owner', start), []);
  } finally {
    f.db.close();
    rmSync(f.path, { recursive: true, force: true });
  }
});

test('a real attempted write survives disk reopen and expiry even without configured integration; dismissal stays dismissed', async () => {
  const f = fixture();
  let db = f.db;
  try {
    const calendar = new CalendarService(db, f.transport, () => start);
    const preview = await calendar.preview('owner', { kind: 'calendar.create', event });
    await assert.rejects(calendar.confirm('owner', preview.id));
    // Baseline versions/crashes can retain attempted=1 without an outcome receipt.
    db.sql.prepare('UPDATE previews SET result=NULL WHERE id=?').run(preview.id);
    f.humanEdit();
    db.close();
    db = new Database(resolve(f.path, 'household.sqlite'));
    const expired = new Date(start.getTime() + 3_600_000);
    const disconnected = new CalendarService(db, undefined, () => expired);
    const recovered = recoverablePreviews(db, 'owner', expired);
    assert.equal(recovered[0].id, preview.id);
    assert.equal(recovered[0].calendarOutcome?.status, 'unknown');
    assert(Date.parse(recovered[0].expiresAt) < expired.getTime());
    assert.equal(recoverablePreviews(db, 'partner', expired).length, 0);
    await assert.rejects(disconnected.confirm('owner', preview.id), /not connected/);
    const reconnected = new CalendarService(db, f.transport, () => expired);
    assert.equal(
      (await reconnected.confirm('owner', preview.id)).calendarOutcome?.status,
      'unknown',
    );
    assert.equal(f.writes, 1);
    reconnected.dismiss('owner', preview.id);
    db.close();
    db = new Database(resolve(f.path, 'household.sqlite'));
    assert.deepEqual(recoverablePreviews(db, 'owner', expired), []);
    assert(db.sql.prepare('SELECT result FROM previews WHERE id=?').get(preview.id));
  } finally {
    db.close();
    rmSync(f.path, { recursive: true, force: true });
  }
});

test('authenticated state/list endpoints restore only the actor previews and never expose executable operations', async () => {
  const f = fixture();
  const calendar = new CalendarService(f.db, f.transport, () => start);
  const direct = f.household.preview('owner', { kind: 'task.create', task });
  const uncertain = await calendar.preview('owner', { kind: 'calendar.create', event });
  await assert.rejects(calendar.confirm('owner', uncertain.id));
  const conversations = await Conversations.open(f.db, resolve(f.path, 'pi.sqlite'));
  const app = createApp(
    f.db,
    f.household,
    conversations,
    new Reminders(f.db, f.household, f.path),
    'http://localhost:5173',
    calendar,
  );
  // Exercise status indexing separately from the real prepare_change tool test.
  const thread = f.household.threads().find((item) => item.assistantFor === 'owner')!;
  f.db.sql
    .prepare('INSERT INTO assistant_previews VALUES (?,?,?,?,?)')
    .run('recovery-index-test', thread.id, 'owner', uncertain.id, start.toISOString());
  assert.equal(
    conversations.status(thread.id).previews[0].preview.calendarOutcome?.status,
    'unknown',
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((done, reject) => {
    server.once('listening', done);
    server.once('error', reject);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  let cookie = '';
  const call = (path: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Household-Client': '1', Cookie: cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const login = async (username: string) => {
    const response = await call('/api/login', {
      username,
      password: `Preview-test-${username}-password`,
    });
    assert.equal(response.status, 200);
    cookie = response.headers.get('set-cookie')!.split(';')[0];
  };
  try {
    assert.equal((await call('/api/previews')).status, 401);
    await login('owner');
    const previews = (await (await call('/api/previews')).json()) as Preview[];
    assert.deepEqual(new Set(previews.map((p) => p.id)), new Set([direct.id, uncertain.id]));
    assert(!JSON.stringify(previews).includes('calendar.invalid'));
    assert(previews.every((p) => !('mutation' in p) && !('operation' in p)));
    const snapshot = (await (await call('/api/state')).json()) as Snapshot;
    assert.deepEqual(snapshot.previews, previews);
    await login('partner');
    assert.deepEqual(await (await call('/api/previews')).json(), []);
    assert.deepEqual(((await (await call('/api/state')).json()) as Snapshot).previews, []);
    assert.equal((await call(`/api/previews/${uncertain.id}/confirm`, {})).status, 404);
    assert.equal(
      (await call(`/api/previews/${uncertain.id}/dismiss`, { acknowledgeUncertain: true })).status,
      404,
    );
    await login('owner');
    assert.equal((await call(`/api/previews/${uncertain.id}/dismiss`, {})).status, 400);
    assert.equal(
      (await call(`/api/previews/${uncertain.id}/dismiss`, { acknowledgeUncertain: true })).status,
      200,
    );
    assert.deepEqual(
      ((await (await call('/api/previews')).json()) as Preview[]).map((p) => p.id),
      [direct.id],
    );
    assert.equal(f.writes, 1);
    assert.deepEqual(conversations.status(thread.id).previews, []);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    await conversations.close();
    f.db.close();
    rmSync(f.path, { recursive: true, force: true });
  }
});
