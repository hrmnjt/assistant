import { test } from 'node:test';
import assert from 'node:assert/strict';
import { householdStore, type Row } from './support.js';
import { DomainError, Household } from '../server/domain.js';
import type { Mutation, Schedule } from '../src/types.js';

const daily: Schedule = { frequency: 'daily', timezone: 'Asia/Dubai' };
const task = (overrides = {}) => ({
  title: 'Water the plants',
  notes: '',
  category: 'household' as const,
  ownerId: 'owner',
  dueAt: '2026-10-14T06:00:00.000Z',
  schedule: daily,
  ...overrides,
});
async function fixture(start = '2026-10-14T07:00:00Z') {
  const db = await householdStore();
  let now = new Date(start);
  const household = new Household(db, () => now);
  return {
    db,
    household,
    time: (value: string) => {
      now = new Date(value);
    },
    apply: async (mutation: Mutation, user = 'owner') =>
      await household.confirm(user, (await household.preview(user, mutation)).id),
    history: async (taskId: string) =>
      (
        await db.all<Row>(
          'SELECT due_at, outcome FROM task_history WHERE task_id=? ORDER BY due_at',
          taskId,
        )
      ).map((row) => `${row.due_at} ${row.outcome}`),
  };
}
const conflict = (error: unknown) => error instanceof DomainError && error.status === 409;

test('rescheduling a recurring task back onto its completed occurrence is rejected at preview', async () => {
  const f = await fixture();
  const { targetId } = await f.apply({ kind: 'task.create', task: task() });
  await f.apply({ kind: 'task.complete', id: targetId, revision: 1 });
  assert.equal((await f.household.task(targetId)).dueAt, '2026-10-15T06:00:00.000Z');
  await assert.rejects(
    async () =>
      await f.household.preview('owner', {
        kind: 'task.update',
        id: targetId,
        revision: 2,
        task: task(),
      }),
    (error: unknown) => conflict(error) && /14 Oct 2026, 10:00/.test((error as Error).message),
  );
  // A later due date keeps the schedule usable and completion keeps working.
  await f.apply({
    kind: 'task.update',
    id: targetId,
    revision: 2,
    task: task({ dueAt: '2026-10-15T04:00:00.000Z' }),
  });
  await f.apply({ kind: 'task.complete', id: targetId, revision: 3 });
  assert.deepEqual(await f.history(targetId), [
    '2026-10-14T06:00:00.000Z completed',
    '2026-10-15T04:00:00.000Z completed',
  ]);
  await f.db.close();
});

test('a schedule that would later reach a completed occurrence is rejected', async () => {
  // Completing early records tomorrow's occurrence before it is due.
  const f = await fixture('2026-10-13T07:00:00Z');
  const { targetId } = await f.apply({ kind: 'task.create', task: task() });
  await f.apply({ kind: 'task.complete', id: targetId, revision: 1 }, 'partner');
  assert.deepEqual(await f.history(targetId), ['2026-10-14T06:00:00.000Z completed']);
  const earlier = {
    kind: 'task.update' as const,
    id: targetId,
    revision: 2,
    task: task({ dueAt: '2026-10-13T06:00:00.000Z' }),
  };
  await assert.rejects(async () => await f.household.preview('owner', earlier), conflict);
  await f.db.close();
});

test('an elapsed completed date keeps its outcome after a schedule moves before it', async () => {
  const f = await fixture();
  const { targetId } = await f.apply({ kind: 'task.create', task: task() });
  await f.apply({ kind: 'task.complete', id: targetId, revision: 1 });
  f.time('2026-10-16T07:00:00Z');
  await f.apply({
    kind: 'task.update',
    id: targetId,
    revision: 2,
    task: task({ dueAt: '2026-10-13T06:00:00.000Z' }),
  });
  const moved = await f.household.task(targetId);
  assert.deepEqual(moved.missedDates, ['2026-10-13T06:00:00.000Z', '2026-10-15T06:00:00.000Z']);
  await f.apply({ kind: 'task.complete', id: targetId, revision: moved.revision });
  assert.deepEqual(await f.history(targetId), [
    '2026-10-13T06:00:00.000Z missed',
    '2026-10-14T06:00:00.000Z completed',
    '2026-10-15T06:00:00.000Z missed',
    '2026-10-16T06:00:00.000Z completed',
  ]);
  assert.equal((await f.household.task(targetId)).dueAt, '2026-10-17T06:00:00.000Z');
  await f.db.close();
});

test('changing frequency cannot reactivate a date the same update records as missed', async () => {
  const f = await fixture();
  const { targetId } = await f.apply({
    kind: 'task.create',
    task: task({ dueAt: '2026-10-11T06:00:00.000Z' }),
  });
  await assert.rejects(
    async () =>
      await f.household.preview('owner', {
        kind: 'task.update',
        id: targetId,
        revision: 1,
        task: task({
          dueAt: '2026-10-13T06:00:00.000Z',
          schedule: { ...daily, frequency: 'weekly' },
        }),
      }),
    conflict,
  );
  // Ordinary edits keep the original overdue deadline and its missed dates.
  await f.apply({
    kind: 'task.update',
    id: targetId,
    revision: 1,
    task: task({ title: 'Water all plants', dueAt: '2026-10-11T06:00:00.000Z' }),
  });
  const edited = await f.household.task(targetId);
  assert.equal(edited.dueAt, '2026-10-11T06:00:00.000Z');
  assert.equal(edited.missedDates.length, 3);
  await f.db.close();
});

test('a previously stored colliding occurrence gives a domain error instead of a storage error', async () => {
  const f = await fixture();
  const { targetId } = await f.apply({ kind: 'task.create', task: task() });
  const pending = await f.household.preview('partner', {
    kind: 'task.complete',
    id: targetId,
    revision: 1,
  });
  await f.apply({ kind: 'task.complete', id: targetId, revision: 1 });
  // Simulate data written before reschedules were validated.
  const stored = JSON.parse(
    String((await f.db.get<Row>('SELECT value FROM household_tasks WHERE id=?', targetId))!.value),
  );
  await f.db.run(
    'UPDATE household_tasks SET value=?, revision=3 WHERE id=?',
    JSON.stringify({ ...stored, dueAt: '2026-10-14T06:00:00.000Z', revision: 3 }),
    targetId,
  );
  await assert.rejects(
    async () =>
      await f.household.preview('owner', { kind: 'task.complete', id: targetId, revision: 3 }),
    conflict,
  );
  await assert.rejects(async () => await f.household.confirm('partner', pending.id), conflict);
  assert.deepEqual(await f.history(targetId), ['2026-10-14T06:00:00.000Z completed']);
  await f.db.close();
});

test('time-zone edits and repeated confirmation keep a valid recurring schedule', async () => {
  const f = await fixture();
  const { targetId } = await f.apply({ kind: 'task.create', task: task() });
  await f.apply({ kind: 'task.complete', id: targetId, revision: 1 });
  const preview = await f.household.preview('owner', {
    kind: 'task.update',
    id: targetId,
    revision: 2,
    task: task({
      dueAt: '2026-10-15T06:00:00.000Z',
      schedule: { frequency: 'daily', timezone: 'Europe/London' },
    }),
  });
  const first = await f.household.confirm('owner', preview.id);
  assert.deepEqual(await f.household.confirm('owner', preview.id), first);
  const saved = await f.household.task(targetId);
  assert.equal(saved.revision, 3);
  assert.equal(saved.schedule?.timezone, 'Europe/London');
  assert.deepEqual(saved.missedDates, []);
  await f.db.close();
});

test('history records the actor and actual time of early, on-time, and late completions', async () => {
  const f = await fixture('2026-10-14T05:00:00Z');
  const { targetId } = await f.apply({ kind: 'task.create', task: task() });
  // Early: before the 10:00 Dubai deadline.
  await f.apply({ kind: 'task.complete', id: targetId, revision: 1 }, 'partner');
  // On time: at the next deadline.
  f.time('2026-10-15T06:00:00Z');
  await f.apply({ kind: 'task.complete', id: targetId, revision: 2 });
  // Late: two days after the following deadline, leaving one miss.
  f.time('2026-10-17T09:30:00Z');
  await f.apply({ kind: 'task.complete', id: targetId, revision: 3 }, 'partner');
  // A later schedule edit keeps every recorded outcome.
  await f.apply({
    kind: 'task.update',
    id: targetId,
    revision: 4,
    task: task({ title: 'Water the balcony', dueAt: '2026-10-18T14:00:00.000Z' }),
  });
  assert.deepEqual(await f.household.history(targetId), [
    {
      dueAt: '2026-10-17T06:00:00.000Z',
      outcome: 'completed',
      completedBy: 'partner',
      completedAt: '2026-10-17T09:30:00.000Z',
    },
    { dueAt: '2026-10-16T06:00:00.000Z', outcome: 'missed', completedBy: null, completedAt: null },
    {
      dueAt: '2026-10-15T06:00:00.000Z',
      outcome: 'completed',
      completedBy: 'owner',
      completedAt: '2026-10-15T06:00:00.000Z',
    },
    {
      dueAt: '2026-10-14T06:00:00.000Z',
      outcome: 'completed',
      completedBy: 'partner',
      completedAt: '2026-10-14T05:00:00.000Z',
    },
  ]);
  await f.db.close();
});

test('history includes elapsed unrecorded misses and one-off completions', async () => {
  const f = await fixture();
  const recurring = await f.apply({
    kind: 'task.create',
    task: task({ dueAt: '2026-10-12T06:00:00.000Z' }),
  });
  assert.deepEqual(
    (await f.household.history(recurring.targetId)).map((item) => `${item.dueAt} ${item.outcome}`),
    ['2026-10-13T06:00:00.000Z missed', '2026-10-12T06:00:00.000Z missed'],
  );
  const once = await f.apply({ kind: 'task.create', task: task({ schedule: null }) });
  assert.deepEqual(await f.household.history(once.targetId), []);
  await f.apply({ kind: 'task.complete', id: once.targetId, revision: 1 }, 'partner');
  assert.deepEqual(await f.household.history(once.targetId), [
    {
      dueAt: '2026-10-14T06:00:00.000Z',
      outcome: 'completed',
      completedBy: 'partner',
      completedAt: '2026-10-14T07:00:00.000Z',
    },
  ]);
  await f.db.close();
});
