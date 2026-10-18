import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import webpush from 'web-push';
import { Database } from '../server/database.js';
import { provision } from '../server/auth.js';
import { Household } from '../server/domain.js';
import { Reminders } from '../server/reminders.js';
import type { CalendarEvent, CalendarSnapshot, HouseholdMutation } from '../src/types.js';

const hour = 3_600_000;
function fixture(start: string) {
  mkdirSync('.cache/tests', { recursive: true });
  const path = mkdtempSync(resolve('.cache/tests/catch-up-'));
  const db = new Database(':memory:');
  provision(db, [
    { username: 'owner', name: 'Alex', password: 'Catch-up-owner-password' },
    { username: 'partner', name: 'Sam', password: 'Catch-up-partner-password' },
  ]);
  let now = new Date(start);
  const household = new Household(db, () => now);
  const calendar: CalendarSnapshot = {
    status: 'connected',
    name: 'Household',
    syncedAt: start,
    error: null,
    events: [],
  };
  const reminders = new Reminders(
    db,
    household,
    path,
    'mailto:test@example.com',
    () => calendar,
    () => now,
  );
  for (const id of ['owner', 'partner']) {
    const endpoint = `https://push.apple.com/${id}`;
    db.sql
      .prepare('INSERT INTO push_subscriptions VALUES (?,?,?)')
      .run(endpoint, id, JSON.stringify({ endpoint, keys: {} }));
  }
  const sent: string[] = [];
  let failing = false;
  const original = webpush.sendNotification;
  webpush.sendNotification = (async (_subscription, payload) => {
    if (failing) throw new Error('Temporary push failure');
    sent.push(JSON.parse(String(payload)).tag);
    return {};
  }) as typeof original;
  return {
    db,
    household,
    reminders,
    calendar,
    sent,
    apply(mutation: HouseholdMutation, user = 'owner') {
      return household.confirm(user, household.preview(user, mutation).id);
    },
    task(dueAt: string) {
      return this.apply({
        kind: 'task.create',
        task: {
          title: `Due ${dueAt}`,
          notes: '',
          category: 'household',
          ownerId: 'owner',
          dueAt,
          schedule: null,
        },
      }).targetId;
    },
    async tick() {
      reminders.plan();
      await reminders.deliver();
    },
    delivery(id: string) {
      return db.sql.prepare('SELECT delivery FROM notices WHERE id=?').get(id)?.delivery;
    },
    failing(value: boolean) {
      failing = value;
    },
    time(value: string | number) {
      now = new Date(value);
    },
    close() {
      webpush.sendNotification = original;
      db.close();
      rmSync(path, { recursive: true, force: true });
    },
  };
}
const event = (id: string, start: string, end: string, reminderMinutes: number): CalendarEvent => ({
  id,
  uid: id,
  etag: '"1"',
  title: `Appointment ${id}`,
  notes: '',
  location: '',
  start,
  end,
  allDay: false,
  reminderMinutes,
  recurring: false,
  readOnlyReason: null,
});

test('after a restart, overdue tasks stay in Updates but push only within two hours of the deadline', async () => {
  const f = fixture('2026-10-14T07:00:00Z');
  try {
    const recent = f.task('2026-10-14T05:00:00.000Z');
    const old = f.task('2026-10-14T04:59:59.999Z');
    await f.tick();
    const recentNotice = `task:${recent}:2026-10-14T05:00:00.000Z:owner`;
    const oldNotice = `task:${old}:2026-10-14T04:59:59.999Z:owner`;
    assert.ok(f.sent.includes(recentNotice));
    assert.equal(f.sent.includes(oldNotice), false);
    assert.equal(f.delivery(oldNotice), 'inbox');
  } finally {
    f.close();
  }
});

test('a task push retried past two hours after its deadline is dropped, not sent late', async () => {
  const f = fixture('2026-10-14T07:00:00Z');
  try {
    const id = f.task('2026-10-14T06:00:00.000Z');
    const notice = `task:${id}:2026-10-14T06:00:00.000Z:owner`;
    f.failing(true);
    await f.tick();
    assert.equal(f.delivery(notice), 'pending');
    f.failing(false);
    f.time(Date.parse('2026-10-14T08:00:00.000Z') + 1);
    await f.reminders.deliver();
    assert.equal(f.sent.includes(notice), false);
    assert.equal(f.delivery(notice), 'inbox');
  } finally {
    f.close();
  }
});

test('appointment pushes stop at two hours after the trigger or when the event ends', async () => {
  const f = fixture('2026-10-14T07:30:00Z');
  try {
    const short = event('a'.repeat(64), '2026-10-14T08:00:00.000Z', '2026-10-14T08:30:00.000Z', 30);
    const long = event('b'.repeat(64), '2026-10-14T08:30:00.000Z', '2026-10-14T12:00:00.000Z', 60);
    f.calendar.events = [short, long];
    f.reminders.plan();
    const shortNotice = `appointment:${short.id}:${short.start}:30:owner`;
    const longNotice = `appointment:${long.id}:${long.start}:60:owner`;
    // The calendar becomes unavailable before delivery and returns later.
    f.calendar.status = 'error';
    await f.reminders.deliver();
    f.calendar.status = 'connected';
    f.time(Date.parse(short.end) + 1);
    await f.reminders.deliver();
    assert.equal(f.sent.includes(shortNotice), false);
    assert.equal(f.delivery(shortNotice), 'inbox');
    // Still before the long event's cutoff: trigger 07:30 + two hours.
    assert.ok(f.sent.includes(longNotice));
    const later = event('c'.repeat(64), '2026-10-14T10:00:00.000Z', '2026-10-14T14:00:00.000Z', 60);
    f.calendar.events = [later];
    f.time('2026-10-14T09:00:00Z');
    f.reminders.plan();
    f.calendar.status = 'error';
    await f.reminders.deliver();
    f.calendar.status = 'connected';
    f.time(Date.parse('2026-10-14T11:00:00Z') + 1);
    await f.reminders.deliver();
    assert.equal(f.sent.includes(`appointment:${later.id}:${later.start}:60:owner`), false);
  } finally {
    f.close();
  }
});

test('summaries are delivered at most two hours late, including retries', async () => {
  // The 08:00 Dubai morning summary is 04:00 UTC.
  const f = fixture('2026-10-14T05:59:00Z');
  try {
    f.failing(true);
    await f.tick();
    const notice = 'summary:owner:morning:2026-10-14';
    assert.equal(f.delivery(notice), 'pending');
    f.failing(false);
    f.time(Date.parse('2026-10-14T06:00:00Z') + 1);
    await f.tick();
    assert.equal(f.sent.includes(notice), false);
    assert.equal(f.delivery(notice), 'inbox');
  } finally {
    f.close();
  }
  for (const [start, planned] of [
    ['2026-10-14T06:00:00Z', true],
    ['2026-10-14T06:01:00Z', false],
  ] as const) {
    const g = fixture(start);
    try {
      await g.tick();
      assert.equal(g.sent.includes('summary:owner:morning:2026-10-14'), planned, start);
    } finally {
      g.close();
    }
  }
});

test('summary catch-up follows local time across a daylight-saving change', async () => {
  // British Summer Time starts at 01:00 UTC on 29 March 2026; 08:00 BST is 07:00 UTC.
  for (const [start, planned] of [
    ['2026-03-29T06:59:00Z', false],
    ['2026-03-29T08:59:00Z', true],
    ['2026-03-29T09:01:00Z', false],
  ] as const) {
    const f = fixture(start);
    try {
      f.apply(
        {
          kind: 'preferences.update',
          revision: 1,
          preferences: {
            timezone: 'Europe/London',
            morning: { enabled: true, time: '08:00' },
            evening: { enabled: false, time: '18:00' },
          },
        },
        'partner',
      );
      await f.tick();
      assert.equal(f.sent.includes('summary:partner:morning:2026-03-29'), planned, start);
    } finally {
      f.close();
    }
  }
});

test('a partner-change push expires two hours after the change', async () => {
  const f = fixture('2026-10-14T07:00:00Z');
  try {
    f.failing(true);
    const preview = f.household.preview('owner', {
      kind: 'task.create',
      task: {
        title: 'Book the plumber',
        notes: '',
        category: 'household',
        ownerId: 'owner',
        dueAt: null,
        schedule: null,
      },
    });
    f.household.confirm('owner', preview.id);
    const notice = `change:${preview.id}:partner`;
    await f.reminders.deliver();
    f.failing(false);
    f.time(Date.parse('2026-10-14T07:00:00Z') + 2 * hour);
    await f.reminders.deliver();
    assert.ok(f.sent.includes(notice));
    assert.equal(f.delivery(notice), 'inbox');
    const later = f.household.preview('owner', {
      kind: 'task.create',
      task: {
        title: 'Call the bank',
        notes: '',
        category: 'household',
        ownerId: 'owner',
        dueAt: null,
        schedule: null,
      },
    });
    f.household.confirm('owner', later.id);
    f.failing(true);
    await f.reminders.deliver();
    f.failing(false);
    f.time(Date.parse('2026-10-14T09:00:00Z') + 2 * hour + 1);
    await f.reminders.deliver();
    assert.equal(f.sent.includes(`change:${later.id}:partner`), false);
  } finally {
    f.close();
  }
});
