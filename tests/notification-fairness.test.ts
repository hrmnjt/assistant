import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PushSender } from '../server/notices.js';
import type { Store } from '../server/database.js';
import type { CalendarSnapshot } from '../src/types.js';
import {
  directory,
  fakeCalendar,
  householdParts,
  householdStore,
  openStore,
  push,
  type Row,
} from './support.js';

async function fixture() {
  const path = directory('notice-fairness');
  const file = resolve(path, 'household.sqlite');
  let now = new Date('2026-10-14T07:00:00Z');
  let db: Store = await householdStore(file);
  const calendar: CalendarSnapshot = {
    status: 'error',
    name: 'Household',
    syncedAt: null,
    error: 'Unavailable',
    events: [],
  };
  const sent: string[] = [];
  let attempts = 0,
    failOwner = false;
  const send: PushSender = async (subscription, payload) => {
    attempts++;
    if (failOwner && subscription.endpoint.endsWith('/owner'))
      throw new Error('credential=never-persist-this');
    sent.push(JSON.parse(payload).tag);
    return 201;
  };
  const open = () =>
    householdParts(db, { clock: () => now, push, send, calendar: fakeCalendar(() => calendar) });
  let parts = open();
  for (const id of ['owner', 'partner']) {
    const endpoint = `https://push.apple.com/${id}`;
    await db.run(
      'INSERT INTO push_subscriptions VALUES (?,?,?)',
      endpoint,
      id,
      JSON.stringify({ endpoint, keys: {} }),
    );
  }
  return {
    get db() {
      return db;
    },
    get notices() {
      return parts.notices;
    },
    get attempts() {
      return attempts;
    },
    sent,
    calendar,
    time(value: number) {
      now = new Date(value);
    },
    get now() {
      return now.getTime();
    },
    failOwner() {
      failOwner = true;
    },
    async insert(id: string, user = 'owner', age = 0) {
      const created = now.getTime() - age;
      await db.run(
        'INSERT INTO notices(id,user_id,title,body,created_at,push_until) VALUES (?,?,?,?,?,?)',
        id,
        user,
        'Safe title',
        'Safe body',
        new Date(created).toISOString(),
        new Date(created + 7200_000).toISOString(),
      );
    },
    async task() {
      const preview = await parts.changes.preview('owner', {
        kind: 'task.create',
        task: {
          title: 'Current due task',
          notes: '',
          category: 'household',
          ownerId: 'owner',
          dueAt: '2026-10-14T06:00:00.000Z',
          schedule: null,
        },
      });
      const { targetId } = await parts.changes.confirm('owner', preview.id);
      await parts.plan();
      return `task:${targetId}:2026-10-14T06:00:00.000Z:owner`;
    },
    async reopen() {
      await db.close();
      db = openStore(file);
      parts = open();
    },
    async close() {
      await db.close();
      rmSync(path, { recursive: true, force: true });
    },
  };
}

test('twenty blocked appointments cannot starve later task, summary, or partner-change work in the same tick', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 20; i++) await f.insert(`appointment:blocked-${i}`, 'owner', 60_000);
    const taskId = await f.task();
    await f.insert('summary:owner:morning');
    await f.insert('change:newer:partner', 'partner');
    await f.notices.deliver();
    assert(f.sent.includes(taskId));
    assert(f.sent.includes('summary:owner:morning'));
    assert(f.sent.includes('change:newer:partner'));
    assert(!f.sent.some((id) => id.startsWith('appointment:')));
    await f.notices.deliver(); // defers the remaining appointment lane, not the already-delivered notices
    assert.equal(
      (
        await f.db.get<Row>(
          "SELECT COUNT(*) AS count FROM notice_retries WHERE failure='calendar-unavailable'",
        )
      )?.count,
      20,
    );
    assert.equal(f.sent.filter((id) => id === taskId).length, 1);
  } finally {
    await f.close();
  }
});

test('all obsolete work expires before calendar dependency checks, even beyond the delivery batch', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 25; i++) await f.insert(`appointment:expired-${i}`, 'owner', 7200_001);
    await f.insert('summary:newer');
    await f.notices.deliver();
    assert.deepEqual(f.sent, ['summary:newer']);
    assert.equal(
      (
        await f.db.get<Row>(
          "SELECT COUNT(*) AS count FROM notices WHERE id LIKE 'appointment:%' AND delivery='inbox'",
        )
      )?.count,
      25,
    );
    assert.equal((await f.db.get<Row>('SELECT COUNT(*) AS count FROM notice_retries'))?.count, 0);
  } finally {
    await f.close();
  }
});

test('calendar retries survive reopen, respect next-attempt deadlines, and recover when the dependency returns', async () => {
  const f = await fixture();
  try {
    const event = {
      id: 'event-1',
      uid: 'uid-1',
      etag: '"1"',
      title: 'Appointment',
      notes: '',
      location: '',
      start: '2026-10-14T07:30:00Z',
      end: '2026-10-14T08:00:00Z',
      allDay: false,
      reminderMinutes: 30,
      recurring: false,
      readOnlyReason: null,
    };
    const id = `appointment:${event.id}:${event.start}:30:owner`;
    await f.insert(id);
    await f.notices.deliver();
    const retry = (await f.db.get<Row>('SELECT * FROM notice_retries WHERE notice_id=?', id))!;
    assert.equal(retry.next_attempt_at, f.now + 60_000);
    assert.equal(retry.failure, 'calendar-unavailable');
    await f.reopen();
    f.calendar.status = 'connected';
    f.calendar.events = [event];
    await f.notices.deliver();
    assert.deepEqual(f.sent, []);
    f.time(Number(retry.next_attempt_at));
    await f.notices.deliver();
    await f.notices.deliver();
    assert.deepEqual(f.sent, [id]);
    assert.equal(
      (await f.db.get<Row>('SELECT delivery FROM notices WHERE id=?', id))?.delivery,
      'inbox',
    );
  } finally {
    await f.close();
  }
});

test('one failing recipient cannot starve another, and push retries use bounded persisted backoff without raw errors', async () => {
  const f = await fixture();
  try {
    f.failOwner();
    for (let i = 0; i < 20; i++) await f.insert(`summary:blocked-${i}`, 'owner', 60_000);
    await f.insert('change:healthy-recipient', 'partner');
    await f.notices.deliver();
    assert(f.sent.includes('change:healthy-recipient'));
    const retryId = 'summary:blocked-0';
    let retry = (await f.db.get<Row>('SELECT * FROM notice_retries WHERE notice_id=?', retryId))!;
    assert.equal(retry.failure, 'push-transient');
    assert(
      !JSON.stringify(await f.db.all<Row>('SELECT * FROM notice_retries')).includes(
        'never-persist-this',
      ),
    );
    // Flush the remaining owner lane, then verify that an immediate tick does no network work.
    await f.notices.deliver();
    const attempts = f.attempts;
    await f.reopen();
    await f.notices.deliver();
    assert.equal(f.attempts, attempts);
    for (let i = 0; i < 6; i++) {
      f.time(Number(retry.next_attempt_at));
      await f.notices.deliver();
      retry = (await f.db.get<Row>('SELECT * FROM notice_retries WHERE notice_id=?', retryId))!;
      assert(Number(retry.next_attempt_at) > f.now);
      assert(Number(retry.next_attempt_at) - f.now <= 900_000);
    }
    assert.equal(Number(retry.next_attempt_at) - f.now, 900_000);
    assert.equal(f.sent.filter((id) => id === 'change:healthy-recipient').length, 1);
    f.time(f.now + 7200_001);
    await f.notices.deliver();
    assert.equal(
      (await f.db.get<Row>("SELECT COUNT(*) AS count FROM notices WHERE delivery='pending'"))
        ?.count,
      0,
    );
  } finally {
    await f.close();
  }
});
