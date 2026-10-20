import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openHousehold } from '../server/runtime.js';
import type { Mutation, Schedule, Task, TaskOccurrence } from '../src/types.js';
import { client, deployment, json, openStore, people, setUp } from './support.js';

/** A time in October 2026, in UTC; 06:00 is the chore's 10:00 in Dubai. */
const oct = (day: number, time = '06:00') => `2026-10-${day}T${time}:00.000Z`;
const daily = { frequency: 'daily', timezone: 'Asia/Dubai' } as const;
const task = (overrides = {}) => ({
  title: 'Water the plants',
  notes: '',
  category: 'household' as const,
  ownerId: 'owner',
  dueAt: oct(14),
  schedule: null,
  ...overrides,
});
const missed = (dueAt: string) => ({
  dueAt,
  outcome: 'missed',
  completedBy: null,
  completedAt: null,
});
const completed = (dueAt: string, completedBy: string, completedAt: string) => ({
  dueAt,
  outcome: 'completed',
  completedBy,
  completedAt,
});

/** Both people on one assistant, through its API, with a clock the test moves. */
async function household(start = oct(14, '07:00')) {
  let now = new Date(start);
  const app = await openHousehold(openStore(), deployment, { clock: () => now });
  await setUp(app.household);
  const as = { owner: client(app, 'owner'), partner: client(app, 'partner') };
  type Who = keyof typeof as;
  const preview = (who: Who, mutation: Mutation) => as[who].call('/api/previews', mutation);
  const confirm = (who: Who, id: string) => as[who].call(`/api/previews/${id}/confirm`, {});
  const state = async (who: Who = 'owner') => await json(await as[who].call('/api/state'));
  return {
    ...as,
    preview,
    confirm,
    state,
    /** Preview a change and confirm it as the same person; returns what it changed. */
    async apply(who: Who, mutation: Mutation): Promise<string> {
      const shown = await json(await preview(who, mutation));
      assert.ok(shown.id, shown.error);
      const result = await json(await confirm(who, shown.id));
      assert.ok(result.ok, result.error);
      return result.targetId;
    },
    task: async (id: string): Promise<Task> =>
      (await state()).tasks.find((item: Task) => item.id === id),
    history: async (id: string): Promise<TaskOccurrence[]> =>
      await json(await as.owner.call(`/api/tasks/${id}/history`)),
    time: (value: string) => {
      now = new Date(value);
    },
    close: () => app.conversations.close(),
  };
}

test('the two people share a task: only a confirmed preview writes it, once, and the other person is told', async () => {
  const h = await household();
  const create: Mutation = { kind: 'task.create', task: task() };
  try {
    // A preview writes nothing, and a cancelled or expired one cannot be confirmed.
    const cancelled = await json(await h.preview('owner', create));
    assert.deepEqual((await h.state()).tasks, []);
    await h.owner.call(`/api/previews/${cancelled.id}`, undefined, 'DELETE');
    assert.equal((await h.confirm('owner', cancelled.id)).status, 404);
    const expired = await json(await h.preview('owner', create));
    h.time(oct(14, '07:11'));
    assert.equal((await h.confirm('owner', expired.id)).status, 409);
    assert.deepEqual((await h.state()).tasks, []);

    // Only the person who previewed can confirm, and a retry adds nothing.
    const preview = await json(await h.preview('owner', create));
    assert.equal((await h.confirm('partner', preview.id)).status, 404);
    const first = await json(await h.confirm('owner', preview.id));
    assert.deepEqual(await json(await h.confirm('owner', preview.id)), first);

    // Sam sees the task and one notice linked to it, which only Sam can mark read.
    const sam = await h.state('partner');
    assert.deepEqual(
      sam.tasks.map((item: Task) => item.id),
      [first.targetId],
    );
    assert.equal(sam.notices.length, 1);
    const [notice] = sam.notices;
    assert.equal(notice.targetId, first.targetId);
    await h.owner.call('/api/notices/read', { ids: [notice.id] });
    assert.equal((await h.state('partner')).notices[0].readAt, null);
    await h.partner.call('/api/notices/read', { ids: [notice.id] });
    assert.ok((await h.state('partner')).notices[0].readAt);
    assert.deepEqual((await h.state()).notices, []);

    // Sam completes it, so Alex's older edit cannot overwrite it, and Alex is told.
    const edit = await json(
      await h.preview('owner', {
        kind: 'task.update',
        id: first.targetId,
        revision: 1,
        task: task({ title: 'Old edit' }),
      }),
    );
    await h.apply('partner', { kind: 'task.complete', id: first.targetId, revision: 1 });
    assert.equal((await h.confirm('owner', edit.id)).status, 409);
    const alex = await h.state();
    assert.equal(alex.tasks[0].title, 'Water the plants');
    assert.equal(alex.tasks[0].status, 'completed');
    assert.equal(alex.tasks[0].completedBy, 'partner');
    assert.equal(alex.notices.length, 1);
    assert.equal(alex.notices[0].targetId, first.targetId);
    assert.ok(alex.notices[0].title.includes(people.partner.name));
  } finally {
    await h.close();
  }
});

test('a recurring chore keeps every occurrence: each miss, and who completed each one and when', async () => {
  const h = await household();
  try {
    const id = await h.apply('owner', {
      kind: 'task.create',
      task: task({ dueAt: oct(11), schedule: daily }),
    });
    // Days that passed before anyone recorded them show as missed.
    assert.deepEqual(await h.history(id), [missed(oct(13)), missed(oct(12)), missed(oct(11))]);

    // Sam completes today's occurrence an hour late, and the chore moves on to tomorrow.
    await h.apply('partner', { kind: 'task.complete', id, revision: 1 });
    const chore = await h.task(id);
    assert.equal(chore.status, 'open');
    assert.equal(chore.dueAt, oct(15));
    // Alex completes tomorrow's early, then Sam the next one on time.
    await h.apply('owner', { kind: 'task.complete', id, revision: 2 });
    h.time(oct(16));
    await h.apply('partner', { kind: 'task.complete', id, revision: 3 });

    // Overdue again, Alex moves it to next week; the misses stay.
    h.time(oct(18, '07:00'));
    await h.apply('owner', {
      kind: 'task.update',
      id,
      revision: 4,
      task: task({ title: 'Water the balcony', dueAt: oct(25), schedule: daily }),
    });
    const moved = await h.task(id);
    assert.equal(moved.dueAt, oct(25));
    assert.deepEqual(moved.missedDates, [oct(11), oct(12), oct(13), oct(17)]);
    assert.deepEqual(await h.history(id), [
      missed(oct(17)),
      completed(oct(16), 'partner', oct(16)),
      completed(oct(15), 'owner', oct(14, '07:00')),
      completed(oct(14), 'partner', oct(14, '07:00')),
      missed(oct(13)),
      missed(oct(12)),
      missed(oct(11)),
    ]);

    // A one-off task's completion is in its history too.
    const once = await h.apply('owner', { kind: 'task.create', task: task() });
    await h.apply('partner', { kind: 'task.complete', id: once, revision: 1 });
    assert.deepEqual(await h.history(once), [completed(oct(14), 'partner', oct(18, '07:00'))]);
  } finally {
    await h.close();
  }
});

test('a schedule edit never reopens or erases a recorded occurrence', async () => {
  const h = await household(oct(13, '07:00'));
  try {
    const id = await h.apply('owner', { kind: 'task.create', task: task({ schedule: daily }) });
    const reschedule = (revision: number, dueAt: string, schedule: Schedule = daily): Mutation => ({
      kind: 'task.update',
      id,
      revision,
      task: task({ dueAt, schedule }),
    });
    // Sam completes tomorrow's early; no schedule may make that occurrence due again.
    await h.apply('partner', { kind: 'task.complete', id, revision: 1 });
    assert.equal((await h.preview('owner', reschedule(2, oct(14)))).status, 409);
    assert.equal((await h.preview('owner', reschedule(2, oct(13)))).status, 409);

    // Overdue, a switch to weekly would reopen the day the edit records as missed.
    h.time(oct(16, '07:00'));
    const weekly: Schedule = { ...daily, frequency: 'weekly' };
    assert.equal((await h.preview('owner', reschedule(2, oct(15), weekly))).status, 409);

    // Moving the start earlier keeps the completion and records the misses around it.
    await h.apply('owner', reschedule(2, oct(13)));
    assert.deepEqual((await h.task(id)).missedDates, [oct(13), oct(15)]);
    await h.apply('owner', { kind: 'task.complete', id, revision: 3 });
    assert.deepEqual(
      (await h.history(id)).map((item) => `${item.dueAt} ${item.outcome}`),
      [`${oct(16)} completed`, `${oct(15)} missed`, `${oct(14)} completed`, `${oct(13)} missed`],
    );
    assert.equal((await h.task(id)).dueAt, oct(17));
  } finally {
    await h.close();
  }
});
