import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import webpush from 'web-push';
import { Database } from '../server/database.js';
import { provision } from '../server/auth.js';
import { Household } from '../server/domain.js';
import { Reminders } from '../server/reminders.js';
import type { CalendarSnapshot } from '../src/types.js';

function fixture() {
  mkdirSync('.cache/tests', { recursive: true });
  const path = mkdtempSync(resolve('.cache/tests/notice-fairness-'));
  let now = new Date('2026-10-14T07:00:00Z');
  let db = new Database(resolve(path, 'household.sqlite'));
  provision(db, [
    { username: 'owner', name: 'Alex', password: 'Notice-owner-password' },
    { username: 'partner', name: 'Sam', password: 'Notice-partner-password' },
  ]);
  let household = new Household(db, () => now);
  const calendar: CalendarSnapshot = {
    status: 'error',
    name: 'Household',
    syncedAt: null,
    error: 'Unavailable',
    events: [],
  };
  const open = () =>
    new Reminders(
      db,
      household,
      path,
      'mailto:test@example.com',
      () => calendar,
      () => now,
    );
  let reminders = open();
  for (const id of ['owner', 'partner']) {
    const endpoint = `https://push.apple.com/${id}`;
    db.sql
      .prepare('INSERT INTO push_subscriptions VALUES (?,?,?)')
      .run(endpoint, id, JSON.stringify({ endpoint, keys: {} }));
  }
  const sent: string[] = [];
  let attempts = 0,
    failOwner = false;
  const original = webpush.sendNotification;
  webpush.sendNotification = (async (subscription, payload) => {
    attempts++;
    if (failOwner && subscription.endpoint.endsWith('/owner'))
      throw new Error('credential=never-persist-this');
    sent.push(JSON.parse(String(payload)).tag);
    return {};
  }) as typeof original;
  return {
    get db() {
      return db;
    },
    get reminders() {
      return reminders;
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
    insert(id: string, user = 'owner', age = 0) {
      db.sql
        .prepare('INSERT INTO notices(id,user_id,title,body,created_at) VALUES (?,?,?,?,?)')
        .run(id, user, 'Safe title', 'Safe body', new Date(now.getTime() - age).toISOString());
    },
    task() {
      const preview = household.preview('owner', {
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
      const { targetId } = household.confirm('owner', preview.id);
      reminders.plan();
      return `task:${targetId}:2026-10-14T06:00:00.000Z:owner`;
    },
    reopen() {
      db.close();
      db = new Database(resolve(path, 'household.sqlite'));
      household = new Household(db, () => now);
      reminders = open();
    },
    close() {
      webpush.sendNotification = original;
      db.close();
      rmSync(path, { recursive: true, force: true });
    },
  };
}

test('twenty blocked appointments cannot starve later task, summary, or partner-change work in the same tick', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 20; i++) f.insert(`appointment:blocked-${i}`, 'owner', 60_000);
    const taskId = f.task();
    f.insert('summary:owner:morning');
    f.insert('change:newer:partner', 'partner');
    await f.reminders.deliver();
    assert(f.sent.includes(taskId));
    assert(f.sent.includes('summary:owner:morning'));
    assert(f.sent.includes('change:newer:partner'));
    assert(!f.sent.some((id) => id.startsWith('appointment:')));
    await f.reminders.deliver(); // defers the remaining appointment lane, not the already-delivered notices
    assert.equal(
      f.db.sql
        .prepare(
          "SELECT COUNT(*) AS count FROM notice_retries WHERE failure='calendar-unavailable'",
        )
        .get()?.count,
      20,
    );
    assert.equal(f.sent.filter((id) => id === taskId).length, 1);
  } finally {
    f.close();
  }
});

test('all obsolete work expires before calendar dependency checks, even beyond the delivery batch', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 25; i++) f.insert(`appointment:expired-${i}`, 'owner', 7200_001);
    f.insert('summary:newer');
    await f.reminders.deliver();
    assert.deepEqual(f.sent, ['summary:newer']);
    assert.equal(
      f.db.sql
        .prepare(
          "SELECT COUNT(*) AS count FROM notices WHERE id LIKE 'appointment:%' AND delivery='inbox'",
        )
        .get()?.count,
      25,
    );
    assert.equal(f.db.sql.prepare('SELECT COUNT(*) AS count FROM notice_retries').get()?.count, 0);
  } finally {
    f.close();
  }
});

test('calendar retries survive reopen, respect next-attempt deadlines, and recover when the dependency returns', async () => {
  const f = fixture();
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
    f.insert(id);
    await f.reminders.deliver();
    const retry = f.db.sql.prepare('SELECT * FROM notice_retries WHERE notice_id=?').get(id)!;
    assert.equal(retry.next_attempt_at, f.now + 60_000);
    assert.equal(retry.failure, 'calendar-unavailable');
    f.reopen();
    f.calendar.status = 'connected';
    f.calendar.events = [event];
    await f.reminders.deliver();
    assert.deepEqual(f.sent, []);
    f.time(Number(retry.next_attempt_at));
    await f.reminders.deliver();
    await f.reminders.deliver();
    assert.deepEqual(f.sent, [id]);
    assert.equal(
      f.db.sql.prepare('SELECT delivery FROM notices WHERE id=?').get(id)?.delivery,
      'inbox',
    );
  } finally {
    f.close();
  }
});

test('one failing recipient cannot starve another, and push retries use bounded persisted backoff without raw errors', async () => {
  const f = fixture();
  try {
    f.failOwner();
    for (let i = 0; i < 20; i++) f.insert(`summary:blocked-${i}`, 'owner', 60_000);
    f.insert('change:healthy-recipient', 'partner');
    await f.reminders.deliver();
    assert(f.sent.includes('change:healthy-recipient'));
    const retryId = 'summary:blocked-0';
    let retry = f.db.sql.prepare('SELECT * FROM notice_retries WHERE notice_id=?').get(retryId)!;
    assert.equal(retry.failure, 'push-transient');
    assert(
      !JSON.stringify(f.db.sql.prepare('SELECT * FROM notice_retries').all()).includes(
        'never-persist-this',
      ),
    );
    // Flush the remaining owner lane, then verify that an immediate tick does no network work.
    await f.reminders.deliver();
    const attempts = f.attempts;
    f.reopen();
    await f.reminders.deliver();
    assert.equal(f.attempts, attempts);
    for (let i = 0; i < 6; i++) {
      f.time(Number(retry.next_attempt_at));
      await f.reminders.deliver();
      retry = f.db.sql.prepare('SELECT * FROM notice_retries WHERE notice_id=?').get(retryId)!;
      assert(Number(retry.next_attempt_at) > f.now);
      assert(Number(retry.next_attempt_at) - f.now <= 900_000);
    }
    assert.equal(Number(retry.next_attempt_at) - f.now, 900_000);
    assert.equal(f.sent.filter((id) => id === 'change:healthy-recipient').length, 1);
    f.time(f.now + 7200_001);
    await f.reminders.deliver();
    assert.equal(
      f.db.sql.prepare("SELECT COUNT(*) AS count FROM notices WHERE delivery='pending'").get()
        ?.count,
      0,
    );
  } finally {
    f.close();
  }
});
