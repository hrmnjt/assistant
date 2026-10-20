import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Auth } from '../server/auth.js';
import { CalendarService } from '../server/plugins/calendar/service.js';
import { Conversations } from '../server/conversations.js';
import { recoverablePreviews } from '../server/preview-recovery.js';
import { AdminAuth } from '../server/admin.js';
import { updateEventData } from '../server/plugins/calendar/icalendar.js';
import type { CalendarResource, CalendarTransport } from '../server/plugins/calendar/caldav.js';
import type { Preview, Snapshot } from '../src/types.js';
import {
  client,
  directory,
  householdParts,
  householdStore,
  openStore,
  setUp,
  type Row,
} from './support.js';

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

async function fixture() {
  const path = directory('previews');
  const db = await householdStore(resolve(path, 'household.sqlite'));
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
    transport,
    ...householdParts(db, { clock: () => start }),
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

test('recovery lists actor-owned unexpired previews without calendar tables and omits settled/cancelled/expired previews', async () => {
  const f = await fixture();
  try {
    const own = await f.changes.preview('owner', { kind: 'task.create', task });
    await f.changes.preview('partner', { kind: 'task.create', task });
    const cancelled = await f.changes.preview('owner', { kind: 'task.create', task });
    await f.changes.cancel('owner', cancelled.id);
    assert.deepEqual(
      (await recoverablePreviews(f.db, 'owner', start)).map((p) => p.id),
      [own.id],
    );
    assert.equal((await recoverablePreviews(f.db, 'partner', start)).length, 1);
    assert.deepEqual(
      await recoverablePreviews(f.db, 'owner', new Date(start.getTime() + 600_000)),
      [],
    );
    await f.changes.confirm('owner', own.id);
    assert.deepEqual(await recoverablePreviews(f.db, 'owner', start), []);
  } finally {
    await f.db.close();
    rmSync(f.path, { recursive: true, force: true });
  }
});

test('a real attempted write survives disk reopen and expiry even without configured integration; dismissal stays dismissed', async () => {
  const f = await fixture();
  let db = f.db;
  try {
    const calendar = new CalendarService(db, f.transport, () => start);
    const preview = await calendar.preview('owner', { kind: 'calendar.create', event });
    await assert.rejects(calendar.confirm('owner', preview.id));
    // Baseline versions/crashes can retain attempted=1 without an outcome receipt.
    await db.run('UPDATE previews SET result=NULL WHERE id=?', preview.id);
    f.humanEdit();
    await db.close();
    db = openStore(resolve(f.path, 'household.sqlite'));
    const expired = new Date(start.getTime() + 3_600_000);
    const disconnected = new CalendarService(db, undefined, () => expired);
    const recovered = await recoverablePreviews(db, 'owner', expired);
    assert.equal(recovered[0].id, preview.id);
    assert.equal(recovered[0].calendarOutcome?.status, 'unknown');
    assert(Date.parse(recovered[0].expiresAt) < expired.getTime());
    assert.equal((await recoverablePreviews(db, 'partner', expired)).length, 0);
    await assert.rejects(disconnected.confirm('owner', preview.id), /not connected/);
    const reconnected = new CalendarService(db, f.transport, () => expired);
    assert.equal(
      (await reconnected.confirm('owner', preview.id)).calendarOutcome?.status,
      'unknown',
    );
    assert.equal(f.writes, 1);
    await reconnected.dismiss('owner', preview.id);
    await db.close();
    db = openStore(resolve(f.path, 'household.sqlite'));
    assert.deepEqual(await recoverablePreviews(db, 'owner', expired), []);
    assert(await db.get<Row>('SELECT result FROM previews WHERE id=?', preview.id));
  } finally {
    await db.close();
    rmSync(f.path, { recursive: true, force: true });
  }
});

test('authenticated state/list endpoints restore only the actor previews and never expose executable operations', async () => {
  const f = await fixture();
  const calendar = new CalendarService(f.db, f.transport, () => start);
  const direct = await f.changes.preview('owner', { kind: 'task.create', task });
  const uncertain = await calendar.preview('owner', { kind: 'calendar.create', event });
  await assert.rejects(calendar.confirm('owner', uncertain.id));
  const conversations = await Conversations.open(f.db);
  const parts = householdParts(f.db, { clock: () => start, calendar });
  const app = {
    db: f.db,
    auth: new Auth(parts.household, true),
    household: parts.household,
    conversations,
    assistantModel: parts.assistantModel,
    admin: new AdminAuth(f.db, undefined, true),
    settings: parts.settings,
    notices: parts.notices,
    plugins: parts.plugins,
  };
  await setUp(f.household);
  // Exercise status indexing separately from the real prepare_change tool test.
  const thread = (await f.household.threads()).find((item) => item.assistantFor === 'owner')!;
  await f.db.run(
    'INSERT INTO assistant_previews VALUES (?,?,?,?,?)',
    'recovery-index-test',
    thread.id,
    'owner',
    uncertain.id,
    start.toISOString(),
  );
  assert.equal(
    (await conversations.status(thread.id)).previews[0].preview.calendarOutcome?.status,
    'unknown',
  );
  let session = client(app);
  const call = (path: string, body?: unknown) => session.call(path, body);
  const actAs = (person: 'owner' | 'partner') => {
    session = client(app, person);
  };
  try {
    const previews = (await (await call('/api/previews')).json()) as Preview[];
    assert.deepEqual(new Set(previews.map((p) => p.id)), new Set([direct.id, uncertain.id]));
    assert(!JSON.stringify(previews).includes('calendar.invalid'));
    assert(previews.every((p) => !('mutation' in p) && !('operation' in p)));
    const snapshot = (await (await call('/api/state')).json()) as Snapshot;
    assert.deepEqual(snapshot.previews, previews);
    actAs('partner');
    assert.deepEqual(await (await call('/api/previews')).json(), []);
    assert.deepEqual(((await (await call('/api/state')).json()) as Snapshot).previews, []);
    assert.equal((await call(`/api/previews/${uncertain.id}/confirm`, {})).status, 404);
    assert.equal(
      (await call(`/api/previews/${uncertain.id}/dismiss`, { acknowledgeUncertain: true })).status,
      404,
    );
    actAs('owner');
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
    assert.deepEqual((await conversations.status(thread.id)).previews, []);
  } finally {
    await conversations.close();
    rmSync(f.path, { recursive: true, force: true });
  }
});
