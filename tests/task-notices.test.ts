import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Household } from '../server/domain.js';
import { Reminders, type PushSender } from '../server/reminders.js';
import type { HouseholdMutation } from '../src/types.js';
import { householdStore, push, type Row } from './support.js';

async function fixture(recurring = false) {
  const db = await householdStore();
  let now = new Date('2026-10-14T07:00:00Z');
  const household = new Household(db, () => now);
  const apply = async (mutation: HouseholdMutation) =>
    await household.confirm('owner', (await household.preview('owner', mutation)).id);
  const fields = {
    title: 'Due household task',
    notes: '',
    category: 'household' as const,
    ownerId: 'owner',
    dueAt: '2026-10-14T06:00:00.000Z',
    schedule: recurring ? { frequency: 'daily' as const, timezone: 'Asia/Dubai' } : null,
  };
  const { targetId } = await apply({ kind: 'task.create', task: fields });
  const sent: { endpoint: string; tag: string }[] = [];
  let beforeSend: ((endpoint: string) => unknown) | undefined;
  const send: PushSender = async (subscription, payload) => {
    await beforeSend?.(subscription.endpoint);
    sent.push({ endpoint: subscription.endpoint, tag: JSON.parse(payload).tag });
    return 201;
  };
  const reminders = new Reminders(db, household, push, undefined, () => now, send);
  for (const endpoint of ['https://push.apple.com/first', 'https://push.apple.com/second'])
    await db.run(
      'INSERT INTO push_subscriptions VALUES (?,?,?)',
      endpoint,
      'owner',
      JSON.stringify({ endpoint, keys: {} }),
    );
  await reminders.plan();
  const noticeId = `task:${targetId}:${fields.dueAt}:owner`;
  return {
    db,
    household,
    reminders,
    fields,
    targetId,
    noticeId,
    sent,
    apply,
    beforeSend(callback: (endpoint: string) => unknown) {
      beforeSend = callback;
    },
    time(value: string) {
      now = new Date(value);
    },
    close() {
      return db.close();
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
    const f = await fixture(change === 'complete-recurring');
    try {
      const base = { id: f.targetId, revision: 1 };
      if (change === 'complete' || change === 'complete-recurring')
        await f.apply({ kind: 'task.complete', ...base });
      else if (change === 'delete') await f.apply({ kind: 'task.delete', ...base });
      else
        await f.apply({
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
        (await f.db.get<Row>('SELECT delivery FROM notices WHERE id=?', f.noticeId))?.delivery,
        'inbox',
      );
      assert.equal(
        (
          await f.db.get<Row>(
            'SELECT task_id FROM task_notice_deadlines WHERE notice_id=?',
            f.noticeId,
          )
        )?.task_id,
        f.targetId,
      );
    } finally {
      await f.close();
    }
  });
}

test('valid task deadline identity survives unrelated edits and each device receives it only once', async () => {
  const f = await fixture();
  try {
    await f.apply({
      kind: 'task.update',
      id: f.targetId,
      revision: 1,
      task: { ...f.fields, title: 'Renamed without changing deadline' },
    });
    await f.reminders.plan();
    await f.reminders.deliver();
    await f.reminders.deliver();
    assert.equal(f.sent.filter((item) => item.tag === f.noticeId).length, 2);
    assert.equal(
      (await f.db.get<Row>('SELECT target_id FROM notice_targets WHERE notice_id=?', f.noticeId))
        ?.target_id,
      f.targetId,
    );
    assert.equal(
      (
        await f.db.get<Row>(
          'SELECT due_at FROM task_notice_deadlines WHERE notice_id=?',
          f.noticeId,
        )
      )?.due_at,
      f.fields.dueAt,
    );
  } finally {
    await f.close();
  }
});

test('completion during one device send prevents sending the obsolete deadline to the next device', async () => {
  const f = await fixture();
  try {
    f.beforeSend(async () => {
      if (!f.sent.length) await f.apply({ kind: 'task.complete', id: f.targetId, revision: 1 });
    });
    await f.reminders.deliver();
    await f.reminders.deliver();
    assert.equal(f.sent.filter((item) => item.tag === f.noticeId).length, 1);
    assert.equal(
      (await f.db.get<Row>('SELECT delivery FROM notices WHERE id=?', f.noticeId))?.delivery,
      'inbox',
    );
  } finally {
    await f.close();
  }
});

test('a failed-device retry is suppressed after reassignment without resending to the successful device', async () => {
  const f = await fixture();
  try {
    f.beforeSend((endpoint) => {
      if (endpoint.endsWith('/first')) throw new Error('Temporary delivery failure');
    });
    await f.reminders.deliver();
    assert.equal(f.sent.filter((item) => item.tag === f.noticeId).length, 1);
    await f.apply({
      kind: 'task.update',
      id: f.targetId,
      revision: 1,
      task: { ...f.fields, ownerId: 'partner' },
    });
    f.beforeSend(() => undefined);
    f.time('2026-10-14T07:01:00Z'); // the persisted device retry is now due
    await f.reminders.deliver();
    assert.equal(f.sent.filter((item) => item.tag === f.noticeId).length, 1);
    assert.equal(
      (await f.db.get<Row>('SELECT delivery FROM notices WHERE id=?', f.noticeId))?.delivery,
      'inbox',
    );
  } finally {
    await f.close();
  }
});

test('legacy task notices without typed identity are inbox-only, and future deadlines cannot be pushed early', async () => {
  const f = await fixture();
  try {
    await f.db.run('DELETE FROM task_notice_deadlines WHERE notice_id=?', f.noticeId);
    await f.reminders.deliver();
    assert.equal(f.sent.filter((item) => item.tag === f.noticeId).length, 0);
    assert.equal(
      (await f.db.get<Row>('SELECT delivery FROM notices WHERE id=?', f.noticeId))?.delivery,
      'inbox',
    );
    await f.reminders.plan();
    await f.db.run("UPDATE notices SET delivery='pending' WHERE id=?", f.noticeId);
    f.time('2026-10-14T05:00:00Z');
    await f.reminders.deliver();
    assert.equal(f.sent.filter((item) => item.tag === f.noticeId).length, 0);
  } finally {
    await f.close();
  }
});
