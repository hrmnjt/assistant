import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DomainError, Household, recurrenceDates } from '../server/domain.js';
import { Conversations } from '../server/conversations.js';
import { openHousehold } from '../server/runtime.js';
import { handle } from '../server/api.js';
import { Reminders, validPushEndpoint } from '../server/reminders.js';
import type { Mutation, Task } from '../src/types.js';
import { client, config, directory, householdStore, openStore, type Row } from './support.js';

const task = (overrides = {}) => ({
  title: 'Water the plants',
  notes: '',
  category: 'household' as const,
  ownerId: 'owner',
  dueAt: '2026-10-14T06:00:00.000Z',
  schedule: null,
  ...overrides,
});
async function fixture() {
  const db = await householdStore();
  let now = new Date('2026-10-14T07:00:00Z');
  return {
    db,
    household: new Household(db, () => now),
    time: (value: string) => {
      now = new Date(value);
    },
  };
}
async function apply(household: Household, mutation: Mutation, user = 'owner') {
  const preview = await household.preview(user, mutation);
  return await household.confirm(user, preview.id);
}

test('a task is never changed by previewing, and cancellation makes confirmation impossible', async () => {
  const f = await fixture();
  const preview = await f.household.preview('owner', { kind: 'task.create', task: task() });
  assert.equal((await f.household.tasks()).length, 0);
  await f.household.cancel('owner', preview.id);
  await assert.rejects(async () => await f.household.confirm('owner', preview.id), DomainError);
  assert.equal((await f.household.tasks()).length, 0);
  await f.db.close();
});
test('confirmation is bound to its actor and retrying does not duplicate tasks', async () => {
  const f = await fixture();
  const preview = await f.household.preview('owner', { kind: 'task.create', task: task() });
  await assert.rejects(async () => await f.household.confirm('partner', preview.id), DomainError);
  const first = await f.household.confirm('owner', preview.id);
  assert.deepEqual(await f.household.confirm('owner', preview.id), first);
  assert.equal((await f.household.tasks()).length, 1);
  await f.db.close();
});
test('either spouse can complete a task, and an older concurrent preview cannot overwrite it', async () => {
  const f = await fixture();
  const created = await apply(f.household, { kind: 'task.create', task: task() });
  const first = await f.household.preview('owner', {
    kind: 'task.update',
    id: created.targetId,
    revision: 1,
    task: task({ title: 'Old edit' }),
  });
  const complete = await f.household.preview('partner', {
    kind: 'task.complete',
    id: created.targetId,
    revision: 1,
  });
  assert.equal((await f.household.task(created.targetId)).status, 'open');
  await f.household.confirm('partner', complete.id);
  await assert.rejects(
    async () => await f.household.confirm('owner', first.id),
    (error: unknown) => error instanceof DomainError && error.status === 409,
  );
  const saved = await f.household.task(created.targetId);
  assert.equal(saved.title, 'Water the plants');
  assert.equal(saved.completedBy, 'partner');
  await f.db.close();
});
test('expired previews cannot write and revisions reject stale settings', async () => {
  const f = await fixture();
  const preview = await f.household.preview('owner', { kind: 'task.create', task: task() });
  f.time('2026-10-14T07:11:00Z');
  await assert.rejects(async () => await f.household.confirm('owner', preview.id), DomainError);
  await apply(f.household, {
    kind: 'preferences.update',
    revision: 1,
    preferences: {
      timezone: 'Asia/Dubai',
      morning: { enabled: false, time: '09:00' },
      evening: { enabled: true, time: '19:00' },
    },
  });
  assert.equal((await f.household.preferences('owner')).morning.enabled, false);
  assert.equal((await f.household.preferences('partner')).morning.time, '08:00');
  assert.equal((await f.household.preferences('partner')).evening.time, '18:00');
  await assert.rejects(
    async () =>
      await f.household.preview('owner', {
        kind: 'preferences.update',
        revision: 1,
        preferences: {
          timezone: 'Asia/Dubai',
          morning: { enabled: true, time: '08:00' },
          evening: { enabled: false, time: '18:00' },
        },
      }),
    DomainError,
  );
  await f.db.close();
});
test('recurring chores retain each missed date after a partner completes the current occurrence', async () => {
  const f = await fixture();
  const created = await apply(f.household, {
    kind: 'task.create',
    task: task({
      dueAt: '2026-10-11T06:00:00.000Z',
      schedule: { frequency: 'daily', timezone: 'Asia/Dubai' },
    }),
  });
  const before = await f.household.task(created.targetId);
  assert.equal(before.missedDates.length, 3);
  assert.equal(before.dueAt, '2026-10-11T06:00:00.000Z');
  await apply(
    f.household,
    { kind: 'task.complete', id: before.id, revision: before.revision },
    'partner',
  );
  const after = await f.household.task(before.id);
  assert.equal(after.missedDates.length, 3);
  assert.equal(after.status, 'open');
  assert.equal(after.dueAt, '2026-10-15T06:00:00.000Z');
  assert.equal(
    (await f.db.get<Row>("SELECT completed_by FROM task_history WHERE outcome='completed'"))
      ?.completed_by,
    'partner',
  );
  await f.db.close();
});
test('editing an overdue recurring schedule preserves prior missed history', async () => {
  const f = await fixture();
  const created = await apply(f.household, {
    kind: 'task.create',
    task: task({
      dueAt: '2026-10-11T06:00:00.000Z',
      schedule: { frequency: 'daily', timezone: 'Asia/Dubai' },
    }),
  });
  await apply(f.household, {
    kind: 'task.update',
    id: created.targetId,
    revision: 1,
    task: task({ dueAt: '2026-10-20T06:00:00.000Z' }),
  });
  assert.equal((await f.household.task(created.targetId)).missedDates.length, 3);
  await f.db.close();
});
test('daily recurrence preserves its local time across a daylight-saving transition', async () => {
  const result = recurrenceDates(
    '2026-03-07T14:00:00.000Z',
    { frequency: 'daily', timezone: 'America/New_York' },
    new Date('2026-03-08T15:00:00Z'),
  );
  assert.deepEqual(result.missed, ['2026-03-07T14:00:00.000Z']);
  assert.equal(result.current, '2026-03-08T13:00:00.000Z');
  assert.equal(result.next, '2026-03-09T13:00:00.000Z');
});
test('invalid owners, time zones, and recurring tasks without dates cannot be previewed', async () => {
  const f = await fixture();
  for (const value of [
    task({ ownerId: 'someone-else' }),
    task({ dueAt: null, schedule: { frequency: 'daily', timezone: 'Asia/Dubai' } }),
    task({ schedule: { frequency: 'daily', timezone: 'Mars/Olympus' } }),
  ]) {
    await assert.rejects(
      async () => await f.household.preview('owner', { kind: 'task.create', task: value }),
      DomainError,
    );
  }
  assert.equal((await f.household.tasks()).length, 0);
  await f.db.close();
});
test('summary toggles are per person, and retries do not duplicate notices', async () => {
  const f = await fixture();
  const path = directory();
  try {
    await apply(f.household, {
      kind: 'preferences.update',
      revision: 1,
      preferences: {
        timezone: 'Asia/Dubai',
        morning: { enabled: false, time: '08:00' },
        evening: { enabled: true, time: '18:00' },
      },
    });
    const reminders = new Reminders(f.db, f.household, { contact: 'mailto:test@example.com' });
    await reminders.plan(new Date('2026-10-14T04:00:00Z'));
    await reminders.plan(new Date('2026-10-14T04:00:30Z'));
    const rows = await f.db.all<Row>('SELECT user_id FROM notices');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, 'partner');
    await reminders.plan(new Date('2026-10-14T14:00:00Z'));
    await reminders.plan(new Date('2026-10-14T14:00:30Z'));
    assert.equal((await f.db.all<Row>('SELECT id FROM notices')).length, 3);
  } finally {
    await f.db.close();
    rmSync(path, { recursive: true, force: true });
  }
});
test('push subscriptions reject arbitrary hosts and insecure endpoints', async () => {
  assert.equal(validPushEndpoint('https://web.push.apple.com/token'), true);
  assert.equal(validPushEndpoint('https://fcm.googleapis.com/token'), true);
  assert.equal(validPushEndpoint('http://127.0.0.1/token'), false);
  assert.equal(validPushEndpoint('https://push.apple.com.attacker.example/token'), false);
  assert.equal(validPushEndpoint('https://user:password@web.push.apple.com/token'), false);
});

test('topic messages persist in Pi Durable after reopening, and request retries are idempotent', async () => {
  const path = directory();
  const file = resolve(path, 'household.sqlite');
  let db = await householdStore(file);
  let conversations: Conversations | undefined;
  try {
    const household = new Household(db);
    const { targetId } = await apply(household, {
      kind: 'thread.create',
      title: 'Weekend',
      category: 'household',
    });
    conversations = await Conversations.open(db);
    const requestId = randomUUID();
    await conversations.send(targetId, 'owner', 'Let’s go for a walk.', requestId);
    await conversations.send(targetId, 'owner', 'Let’s go for a walk.', requestId);
    assert.equal((await conversations.messages(targetId)).length, 1);
    // Closing Pi closes the shared store, as when a runtime stops.
    await conversations.close();
    db = openStore(file);
    conversations = await Conversations.open(db);
    const messages = await conversations.messages(targetId);
    assert.equal(messages[0].text, 'Let’s go for a walk.');
    assert.equal(messages[0].authorId, 'owner');
  } finally {
    await conversations?.close();
    await db.close();
    rmSync(path, { recursive: true, force: true });
  }
});

test('HTTP authentication, origin checks, and task preview/confirm work together', async () => {
  const app = await openHousehold(openStore(), config);
  const owner = client(app);
  try {
    assert.equal((await owner.call('/api/state')).status, 401);
    assert.equal((await owner.call('/api/health')).status, 200);
    assert.equal(
      (
        await owner.call(
          '/api/login',
          { username: 'owner', password: config.OWNER_PASSWORD },
          'POST',
          { Origin: 'https://untrusted.example' },
        )
      ).status,
      403,
    );
    assert.equal((await owner.login('owner', config.OWNER_PASSWORD)).status, 200);
    const response = await owner.call('/api/previews', { kind: 'task.create', task: task() });
    assert.equal(response.status, 201);
    const preview = (await response.json()) as { id: string };
    assert.equal((await app.household.tasks()).length, 0);
    assert.equal((await owner.call(`/api/previews/${preview.id}/confirm`, {})).status, 200);
    const state = (await (await owner.call('/api/state')).json()) as { tasks: Task[] };
    assert.equal(state.tasks.length, 1);
    assert.equal(state.tasks[0].title, 'Water the plants');
    assert.equal((await owner.call('/api/tasks', { title: 'Bypass preview' })).status, 404);
    const noticeId = `change:${preview.id}:partner`;
    assert.equal((await owner.call('/api/notices/read', { ids: [noticeId] })).status, 200);
    assert.equal((await app.db.all<Row>('SELECT notice_id FROM notice_reads')).length, 0);
    const partner = client(app);
    await partner.login('partner', config.PARTNER_PASSWORD);
    const partnerState = (await (await partner.call('/api/state')).json()) as {
      tasks: Task[];
      notices: { id: string; readAt: string | null; targetId: string }[];
    };
    assert.equal(partnerState.tasks[0].id, state.tasks[0].id);
    assert.equal(partnerState.notices[0].id, noticeId);
    assert.equal(partnerState.notices[0].readAt, null);
    assert.equal(partnerState.notices[0].targetId, state.tasks[0].id);
    assert.equal((await partner.call('/api/notices/read', { ids: [noticeId] })).status, 200);
    const readState = (await (await partner.call('/api/state')).json()) as {
      notices: { readAt: string | null }[];
    };
    assert.ok(readState.notices[0].readAt);
    // Writes need the app header, and a request for another host name is refused.
    assert.equal(
      (await partner.call('/api/logout', {}, 'POST', { 'X-Household-Client': '0' })).status,
      403,
    );
    assert.equal((await handle(app, new Request('http://rebound.example/api/state'))).status, 403);
    await partner.call('/api/logout', {});
    assert.equal((await partner.call('/api/state')).status, 401);
  } finally {
    await app.conversations.close();
  }
});

test('each login has a separate ready assistant while shared channels and tasks converge', async () => {
  const f = await fixture();
  try {
    await f.household.ensureSpaces();
    const first = await f.household.threads();
    await f.household.ensureSpaces();
    assert.equal((await f.household.threads()).length, first.length);
    assert.equal(first.filter((thread) => thread.assistantFor).length, 2);
    assert.notEqual(
      first.find((thread) => thread.assistantFor === 'owner')?.id,
      first.find((thread) => thread.assistantFor === 'partner')?.id,
    );
    assert.ok(first.some((thread) => thread.title === 'household' && !thread.assistantFor));
  } finally {
    await f.db.close();
  }
});

test('only confirmed task changes notify the other spouse, with an exact link and no duplicates on retry', async () => {
  const f = await fixture();
  try {
    const preview = await f.household.preview('owner', { kind: 'task.create', task: task() });
    assert.equal((await f.db.all<Row>('SELECT id FROM notices')).length, 0);
    const created = await f.household.confirm('owner', preview.id);
    await f.household.confirm('owner', preview.id);
    const notices = await f.db.all<Row>('SELECT * FROM notices');
    assert.equal(notices.length, 1);
    assert.equal(notices[0].user_id, 'partner');
    assert.match(String(notices[0].title), /Alex added a task/);
    assert.equal(
      (await f.db.get<Row>('SELECT target_id FROM notice_targets'))?.target_id,
      created.targetId,
    );
    const cancelled = await f.household.preview('partner', {
      kind: 'task.delete',
      id: created.targetId,
      revision: 1,
    });
    await f.household.cancel('partner', cancelled.id);
    assert.equal((await f.db.all<Row>('SELECT id FROM notices')).length, 1);
    const done = await f.household.preview('partner', {
      kind: 'task.complete',
      id: created.targetId,
      revision: 1,
    });
    await f.household.confirm('partner', done.id);
    const back = await f.db.all<Row>("SELECT * FROM notices WHERE user_id='owner'");
    assert.equal(back.length, 1);
    assert.match(String(back[0].title), /Sam completed a task/);
  } finally {
    await f.db.close();
  }
});
