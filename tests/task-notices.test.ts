import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import webpush from 'web-push';
import { Database } from '../server/database.js';
import { provision } from '../server/auth.js';
import { Household } from '../server/domain.js';
import { Reminders } from '../server/reminders.js';
import type { HouseholdMutation } from '../src/types.js';

function fixture(recurring = false) {
  mkdirSync('.cache/tests', { recursive: true });
  const path = mkdtempSync(resolve('.cache/tests/task-notices-'));
  const db = new Database(':memory:');
  provision(db, [
    { username: 'owner', name: 'Alex', password: 'Task-notice-owner-password' },
    { username: 'partner', name: 'Sam', password: 'Task-notice-partner-password' },
  ]);
  let now = new Date('2026-10-14T07:00:00Z');
  const household = new Household(db, () => now);
  const apply = (mutation: HouseholdMutation) =>
    household.confirm('owner', household.preview('owner', mutation).id);
  const fields = {
    title: 'Due household task',
    notes: '',
    category: 'household' as const,
    ownerId: 'owner',
    dueAt: '2026-10-14T06:00:00.000Z',
    schedule: recurring ? { frequency: 'daily' as const, timezone: 'Asia/Dubai' } : null,
  };
  const { targetId } = apply({ kind: 'task.create', task: fields });
  const reminders = new Reminders(
    db,
    household,
    path,
    'mailto:test@example.com',
    undefined,
    () => now,
  );
  for (const endpoint of ['https://push.apple.com/first', 'https://push.apple.com/second'])
    db.sql
      .prepare('INSERT INTO push_subscriptions VALUES (?,?,?)')
      .run(endpoint, 'owner', JSON.stringify({ endpoint, keys: {} }));
  reminders.plan();
  const noticeId = `task:${targetId}:${fields.dueAt}:owner`;
  const sent: { endpoint: string; tag: string }[] = [];
  const original = webpush.sendNotification;
  let beforeSend: ((endpoint: string) => void) | undefined;
  webpush.sendNotification = (async (subscription, payload) => {
    beforeSend?.(subscription.endpoint);
    sent.push({ endpoint: subscription.endpoint, tag: JSON.parse(String(payload)).tag });
    return {};
  }) as typeof original;
  return {
    db,
    household,
    reminders,
    fields,
    targetId,
    noticeId,
    sent,
    apply,
    beforeSend(callback: (endpoint: string) => void) {
      beforeSend = callback;
    },
    time(value: string) {
      now = new Date(value);
    },
    close() {
      webpush.sendNotification = original;
      db.close();
      rmSync(path, { recursive: true, force: true });
    },
  };
}

for (const change of [
  'complete',
  'delete',
  'reassign',
  'reschedule',
  'complete-recurring',
] as const) {
  test(`task deadline push is suppressed after ${change} while its inbox history is retained`, async () => {
    const f = fixture(change === 'complete-recurring');
    try {
      const base = { id: f.targetId, revision: 1 };
      if (change === 'complete' || change === 'complete-recurring')
        f.apply({ kind: 'task.complete', ...base });
      else if (change === 'delete') f.apply({ kind: 'task.delete', ...base });
      else
        f.apply({
          kind: 'task.update',
          ...base,
          task: {
            ...f.fields,
            ...(change === 'reassign'
              ? { ownerId: 'partner' }
              : { dueAt: '2026-10-16T06:00:00.000Z' }),
          },
        });
      await f.reminders.deliver();
      await f.reminders.deliver();
      assert.equal(f.sent.filter((item) => item.tag === f.noticeId).length, 0);
      assert.equal(
        f.db.sql.prepare('SELECT delivery FROM notices WHERE id=?').get(f.noticeId)?.delivery,
        'inbox',
      );
      assert.equal(
        f.db.sql
          .prepare('SELECT task_id FROM task_notice_deadlines WHERE notice_id=?')
          .get(f.noticeId)?.task_id,
        f.targetId,
      );
    } finally {
      f.close();
    }
  });
}

test('valid task deadline identity survives unrelated edits and each device receives it only once', async () => {
  const f = fixture();
  try {
    f.apply({
      kind: 'task.update',
      id: f.targetId,
      revision: 1,
      task: { ...f.fields, title: 'Renamed without changing deadline' },
    });
    f.reminders.plan();
    await f.reminders.deliver();
    await f.reminders.deliver();
    assert.equal(f.sent.filter((item) => item.tag === f.noticeId).length, 2);
    assert.equal(
      f.db.sql.prepare('SELECT target_id FROM notice_targets WHERE notice_id=?').get(f.noticeId)
        ?.target_id,
      f.targetId,
    );
    assert.equal(
      f.db.sql.prepare('SELECT due_at FROM task_notice_deadlines WHERE notice_id=?').get(f.noticeId)
        ?.due_at,
      f.fields.dueAt,
    );
  } finally {
    f.close();
  }
});

test('completion during one device send prevents sending the obsolete deadline to the next device', async () => {
  const f = fixture();
  try {
    f.beforeSend(() => {
      if (!f.sent.length) f.apply({ kind: 'task.complete', id: f.targetId, revision: 1 });
    });
    await f.reminders.deliver();
    await f.reminders.deliver();
    assert.equal(f.sent.filter((item) => item.tag === f.noticeId).length, 1);
    assert.equal(
      f.db.sql.prepare('SELECT delivery FROM notices WHERE id=?').get(f.noticeId)?.delivery,
      'inbox',
    );
  } finally {
    f.close();
  }
});

test('a failed-device retry is suppressed after reassignment without resending to the successful device', async () => {
  const f = fixture();
  try {
    f.beforeSend((endpoint) => {
      if (endpoint.endsWith('/first')) throw new Error('Temporary delivery failure');
    });
    await f.reminders.deliver();
    assert.equal(f.sent.filter((item) => item.tag === f.noticeId).length, 1);
    f.apply({
      kind: 'task.update',
      id: f.targetId,
      revision: 1,
      task: { ...f.fields, ownerId: 'partner' },
    });
    f.beforeSend(() => undefined);
    await f.reminders.deliver();
    assert.equal(f.sent.filter((item) => item.tag === f.noticeId).length, 1);
    assert.equal(
      f.db.sql.prepare('SELECT delivery FROM notices WHERE id=?').get(f.noticeId)?.delivery,
      'inbox',
    );
  } finally {
    f.close();
  }
});

test('legacy task notices without typed identity are inbox-only, and future deadlines cannot be pushed early', async () => {
  const f = fixture();
  try {
    f.db.sql.prepare('DELETE FROM task_notice_deadlines WHERE notice_id=?').run(f.noticeId);
    await f.reminders.deliver();
    assert.equal(f.sent.filter((item) => item.tag === f.noticeId).length, 0);
    assert.equal(
      f.db.sql.prepare('SELECT delivery FROM notices WHERE id=?').get(f.noticeId)?.delivery,
      'inbox',
    );
    f.reminders.plan();
    f.db.sql.prepare("UPDATE notices SET delivery='pending' WHERE id=?").run(f.noticeId);
    f.time('2026-10-14T05:00:00Z');
    await f.reminders.deliver();
    assert.equal(f.sent.filter((item) => item.tag === f.noticeId).length, 0);
  } finally {
    f.close();
  }
});
