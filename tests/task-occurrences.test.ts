import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../server/database.js';
import { provision } from '../server/auth.js';
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
function fixture(start = '2026-10-14T07:00:00Z') {
  const db = new Database(':memory:');
  provision(db, [
    { username: 'owner', name: 'Alex', password: 'Test-only-owner-password' },
    { username: 'partner', name: 'Sam', password: 'Test-only-partner-password' },
  ]);
  let now = new Date(start);
  const household = new Household(db, () => now);
  return {
    db,
    household,
    time: (value: string) => {
      now = new Date(value);
    },
    apply: (mutation: Mutation, user = 'owner') =>
      household.confirm(user, household.preview(user, mutation).id),
    history: (taskId: string) =>
      db.sql
        .prepare('SELECT due_at, outcome FROM task_history WHERE task_id=? ORDER BY due_at')
        .all(taskId)
        .map((row) => `${row.due_at} ${row.outcome}`),
  };
}
const conflict = (error: unknown) => error instanceof DomainError && error.status === 409;

test('rescheduling a recurring task back onto its completed occurrence is rejected at preview', () => {
  const f = fixture();
  const { targetId } = f.apply({ kind: 'task.create', task: task() });
  f.apply({ kind: 'task.complete', id: targetId, revision: 1 });
  assert.equal(f.household.task(targetId).dueAt, '2026-10-15T06:00:00.000Z');
  assert.throws(
    () =>
      f.household.preview('owner', {
        kind: 'task.update',
        id: targetId,
        revision: 2,
        task: task(),
      }),
    (error: unknown) => conflict(error) && /14 Oct 2026, 10:00/.test((error as Error).message),
  );
  // A later due date keeps the schedule usable and completion keeps working.
  f.apply({
    kind: 'task.update',
    id: targetId,
    revision: 2,
    task: task({ dueAt: '2026-10-15T04:00:00.000Z' }),
  });
  f.apply({ kind: 'task.complete', id: targetId, revision: 3 });
  assert.deepEqual(f.history(targetId), [
    '2026-10-14T06:00:00.000Z completed',
    '2026-10-15T04:00:00.000Z completed',
  ]);
  f.db.close();
});

test('a schedule that would later reach a completed occurrence is rejected', () => {
  // Completing early records tomorrow's occurrence before it is due.
  const f = fixture('2026-10-13T07:00:00Z');
  const { targetId } = f.apply({ kind: 'task.create', task: task() });
  f.apply({ kind: 'task.complete', id: targetId, revision: 1 }, 'partner');
  assert.deepEqual(f.history(targetId), ['2026-10-14T06:00:00.000Z completed']);
  const earlier = {
    kind: 'task.update' as const,
    id: targetId,
    revision: 2,
    task: task({ dueAt: '2026-10-13T06:00:00.000Z' }),
  };
  assert.throws(() => f.household.preview('owner', earlier), conflict);
  f.db.close();
});

test('an elapsed completed date keeps its outcome after a schedule moves before it', () => {
  const f = fixture();
  const { targetId } = f.apply({ kind: 'task.create', task: task() });
  f.apply({ kind: 'task.complete', id: targetId, revision: 1 });
  f.time('2026-10-16T07:00:00Z');
  f.apply({
    kind: 'task.update',
    id: targetId,
    revision: 2,
    task: task({ dueAt: '2026-10-13T06:00:00.000Z' }),
  });
  const moved = f.household.task(targetId);
  assert.deepEqual(moved.missedDates, ['2026-10-13T06:00:00.000Z', '2026-10-15T06:00:00.000Z']);
  f.apply({ kind: 'task.complete', id: targetId, revision: moved.revision });
  assert.deepEqual(f.history(targetId), [
    '2026-10-13T06:00:00.000Z missed',
    '2026-10-14T06:00:00.000Z completed',
    '2026-10-15T06:00:00.000Z missed',
    '2026-10-16T06:00:00.000Z completed',
  ]);
  assert.equal(f.household.task(targetId).dueAt, '2026-10-17T06:00:00.000Z');
  f.db.close();
});

test('changing frequency cannot reactivate a date the same update records as missed', () => {
  const f = fixture();
  const { targetId } = f.apply({
    kind: 'task.create',
    task: task({ dueAt: '2026-10-11T06:00:00.000Z' }),
  });
  assert.throws(
    () =>
      f.household.preview('owner', {
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
  f.apply({
    kind: 'task.update',
    id: targetId,
    revision: 1,
    task: task({ title: 'Water all plants', dueAt: '2026-10-11T06:00:00.000Z' }),
  });
  const edited = f.household.task(targetId);
  assert.equal(edited.dueAt, '2026-10-11T06:00:00.000Z');
  assert.equal(edited.missedDates.length, 3);
  f.db.close();
});

test('a previously stored colliding occurrence gives a domain error instead of a storage error', () => {
  const f = fixture();
  const { targetId } = f.apply({ kind: 'task.create', task: task() });
  const pending = f.household.preview('partner', {
    kind: 'task.complete',
    id: targetId,
    revision: 1,
  });
  f.apply({ kind: 'task.complete', id: targetId, revision: 1 });
  // Simulate data written before reschedules were validated.
  const stored = JSON.parse(
    String(f.db.sql.prepare('SELECT value FROM tasks WHERE id=?').get(targetId)!.value),
  );
  f.db.sql
    .prepare('UPDATE tasks SET value=?, revision=3 WHERE id=?')
    .run(JSON.stringify({ ...stored, dueAt: '2026-10-14T06:00:00.000Z', revision: 3 }), targetId);
  assert.throws(
    () => f.household.preview('owner', { kind: 'task.complete', id: targetId, revision: 3 }),
    conflict,
  );
  assert.throws(() => f.household.confirm('partner', pending.id), conflict);
  assert.deepEqual(f.history(targetId), ['2026-10-14T06:00:00.000Z completed']);
  f.db.close();
});

test('time-zone edits and repeated confirmation keep a valid recurring schedule', () => {
  const f = fixture();
  const { targetId } = f.apply({ kind: 'task.create', task: task() });
  f.apply({ kind: 'task.complete', id: targetId, revision: 1 });
  const preview = f.household.preview('owner', {
    kind: 'task.update',
    id: targetId,
    revision: 2,
    task: task({
      dueAt: '2026-10-15T06:00:00.000Z',
      schedule: { frequency: 'daily', timezone: 'Europe/London' },
    }),
  });
  const first = f.household.confirm('owner', preview.id);
  assert.deepEqual(f.household.confirm('owner', preview.id), first);
  const saved = f.household.task(targetId);
  assert.equal(saved.revision, 3);
  assert.equal(saved.schedule?.timezone, 'Europe/London');
  assert.deepEqual(saved.missedDates, []);
  f.db.close();
});
