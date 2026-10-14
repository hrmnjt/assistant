import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Database } from '../server/database.js';
import { provision } from '../server/auth.js';
import { DomainError, Household, recurrenceDates } from '../server/domain.js';
import { Conversations } from '../server/conversations.js';
import { createApp } from '../server/app.js';
import { Reminders, validPushEndpoint } from '../server/reminders.js';
import type { Mutation, Task } from '../src/types.js';

const task = (overrides = {}) => ({
  title: 'Water the plants',
  notes: '',
  category: 'household' as const,
  ownerId: 'owner',
  dueAt: '2026-10-14T06:00:00.000Z',
  schedule: null,
  ...overrides,
});
function fixture() {
  const db = new Database(':memory:');
  provision(db, [
    { username: 'owner', name: 'Alex', password: 'Test-only-owner-password' },
    { username: 'partner', name: 'Sam', password: 'Test-only-partner-password' },
  ]);
  let now = new Date('2026-10-14T07:00:00Z');
  return {
    db,
    household: new Household(db, () => now),
    time: (value: string) => {
      now = new Date(value);
    },
  };
}
function apply(household: Household, mutation: Mutation, user = 'owner') {
  const preview = household.preview(user, mutation);
  return household.confirm(user, preview.id);
}
function directory() {
  mkdirSync(resolve('.cache/tests'), { recursive: true });
  return mkdtempSync(resolve('.cache/tests/run-'));
}

test('a task is never changed by previewing, and cancellation makes confirmation impossible', () => {
  const f = fixture();
  const preview = f.household.preview('owner', { kind: 'task.create', task: task() });
  assert.equal(f.household.tasks().length, 0);
  f.household.cancel('owner', preview.id);
  assert.throws(() => f.household.confirm('owner', preview.id), DomainError);
  assert.equal(f.household.tasks().length, 0);
  f.db.close();
});
test('confirmation is bound to its actor and retrying does not duplicate tasks', () => {
  const f = fixture();
  const preview = f.household.preview('owner', { kind: 'task.create', task: task() });
  assert.throws(() => f.household.confirm('partner', preview.id), DomainError);
  const first = f.household.confirm('owner', preview.id);
  assert.deepEqual(f.household.confirm('owner', preview.id), first);
  assert.equal(f.household.tasks().length, 1);
  f.db.close();
});
test('either spouse can complete a task, and an older concurrent preview cannot overwrite it', () => {
  const f = fixture();
  const created = apply(f.household, { kind: 'task.create', task: task() });
  const first = f.household.preview('owner', {
    kind: 'task.update',
    id: created.targetId,
    revision: 1,
    task: task({ title: 'Old edit' }),
  });
  const complete = f.household.preview('partner', {
    kind: 'task.complete',
    id: created.targetId,
    revision: 1,
  });
  assert.equal(f.household.task(created.targetId).status, 'open');
  f.household.confirm('partner', complete.id);
  assert.throws(
    () => f.household.confirm('owner', first.id),
    (error: unknown) => error instanceof DomainError && error.status === 409,
  );
  const saved = f.household.task(created.targetId);
  assert.equal(saved.title, 'Water the plants');
  assert.equal(saved.completedBy, 'partner');
  f.db.close();
});
test('expired previews cannot write and revisions reject stale settings', () => {
  const f = fixture();
  const preview = f.household.preview('owner', { kind: 'task.create', task: task() });
  f.time('2026-10-14T07:11:00Z');
  assert.throws(() => f.household.confirm('owner', preview.id), DomainError);
  apply(f.household, {
    kind: 'preferences.update',
    revision: 1,
    preferences: {
      timezone: 'Asia/Dubai',
      morning: { enabled: false, time: '09:00' },
      evening: { enabled: true, time: '19:00' },
    },
  });
  assert.equal(f.household.preferences('owner').morning.enabled, false);
  assert.equal(f.household.preferences('partner').morning.time, '08:00');
  assert.equal(f.household.preferences('partner').evening.time, '18:00');
  assert.throws(
    () =>
      f.household.preview('owner', {
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
  f.db.close();
});
test('recurring chores retain each missed date after a partner completes the current occurrence', () => {
  const f = fixture();
  const created = apply(f.household, {
    kind: 'task.create',
    task: task({
      dueAt: '2026-10-11T06:00:00.000Z',
      schedule: { frequency: 'daily', timezone: 'Asia/Dubai' },
    }),
  });
  const before = f.household.task(created.targetId);
  assert.equal(before.missedDates.length, 3);
  assert.equal(before.dueAt, '2026-10-11T06:00:00.000Z');
  apply(
    f.household,
    { kind: 'task.complete', id: before.id, revision: before.revision },
    'partner',
  );
  const after = f.household.task(before.id);
  assert.equal(after.missedDates.length, 3);
  assert.equal(after.status, 'open');
  assert.equal(after.dueAt, '2026-10-15T06:00:00.000Z');
  assert.equal(
    f.db.sql.prepare("SELECT completed_by FROM task_history WHERE outcome='completed'").get()
      ?.completed_by,
    'partner',
  );
  f.db.close();
});
test('editing an overdue recurring schedule preserves prior missed history', () => {
  const f = fixture();
  const created = apply(f.household, {
    kind: 'task.create',
    task: task({
      dueAt: '2026-10-11T06:00:00.000Z',
      schedule: { frequency: 'daily', timezone: 'Asia/Dubai' },
    }),
  });
  apply(f.household, {
    kind: 'task.update',
    id: created.targetId,
    revision: 1,
    task: task({ dueAt: '2026-10-20T06:00:00.000Z' }),
  });
  assert.equal(f.household.task(created.targetId).missedDates.length, 3);
  f.db.close();
});
test('daily recurrence preserves its local time across a daylight-saving transition', () => {
  const result = recurrenceDates(
    '2026-03-07T14:00:00.000Z',
    { frequency: 'daily', timezone: 'America/New_York' },
    new Date('2026-03-08T15:00:00Z'),
  );
  assert.deepEqual(result.missed, ['2026-03-07T14:00:00.000Z']);
  assert.equal(result.current, '2026-03-08T13:00:00.000Z');
  assert.equal(result.next, '2026-03-09T13:00:00.000Z');
});
test('invalid owners, time zones, and recurring tasks without dates cannot be previewed', () => {
  const f = fixture();
  for (const value of [
    task({ ownerId: 'someone-else' }),
    task({ dueAt: null, schedule: { frequency: 'daily', timezone: 'Asia/Dubai' } }),
    task({ schedule: { frequency: 'daily', timezone: 'Mars/Olympus' } }),
  ]) {
    assert.throws(
      () => f.household.preview('owner', { kind: 'task.create', task: value }),
      DomainError,
    );
  }
  assert.equal(f.household.tasks().length, 0);
  f.db.close();
});
test('summary toggles are per person, and retries do not duplicate notices', () => {
  const f = fixture();
  const path = directory();
  try {
    apply(f.household, {
      kind: 'preferences.update',
      revision: 1,
      preferences: {
        timezone: 'Asia/Dubai',
        morning: { enabled: false, time: '08:00' },
        evening: { enabled: true, time: '18:00' },
      },
    });
    const reminders = new Reminders(f.db, f.household, path, 'mailto:test@example.com');
    reminders.plan(new Date('2026-10-14T04:00:00Z'));
    reminders.plan(new Date('2026-10-14T04:00:30Z'));
    const rows = f.db.sql.prepare('SELECT user_id FROM notices').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, 'partner');
    reminders.plan(new Date('2026-10-14T14:00:00Z'));
    reminders.plan(new Date('2026-10-14T14:00:30Z'));
    assert.equal(f.db.sql.prepare('SELECT id FROM notices').all().length, 3);
  } finally {
    f.db.close();
    rmSync(path, { recursive: true, force: true });
  }
});
test('push subscriptions reject arbitrary hosts and insecure endpoints', () => {
  assert.equal(validPushEndpoint('https://web.push.apple.com/token'), true);
  assert.equal(validPushEndpoint('https://fcm.googleapis.com/token'), true);
  assert.equal(validPushEndpoint('http://127.0.0.1/token'), false);
  assert.equal(validPushEndpoint('https://push.apple.com.attacker.example/token'), false);
  assert.equal(validPushEndpoint('https://user:password@web.push.apple.com/token'), false);
});

test('topic messages persist in Pi Durable after reopening, and request retries are idempotent', async () => {
  const path = directory();
  let db = new Database(resolve(path, 'app.sqlite'));
  let conversations: Conversations | undefined;
  try {
    provision(db, [
      { username: 'owner', name: 'Alex', password: 'Test-only-owner-password' },
      { username: 'partner', name: 'Sam', password: 'Test-only-partner-password' },
    ]);
    const household = new Household(db);
    const { targetId } = apply(household, {
      kind: 'thread.create',
      title: 'Weekend',
      category: 'household',
    });
    conversations = await Conversations.open(db, resolve(path, 'pi.sqlite'));
    const requestId = randomUUID();
    await conversations.send(targetId, 'owner', 'Let’s go for a walk.', requestId);
    await conversations.send(targetId, 'owner', 'Let’s go for a walk.', requestId);
    assert.equal((await conversations.messages(targetId)).length, 1);
    await conversations.close();
    conversations = undefined;
    db.close();
    db = new Database(resolve(path, 'app.sqlite'));
    conversations = await Conversations.open(db, resolve(path, 'pi.sqlite'));
    const messages = await conversations.messages(targetId);
    assert.equal(messages[0].text, 'Let’s go for a walk.');
    assert.equal(messages[0].authorId, 'owner');
  } finally {
    await conversations?.close();
    db.close();
    rmSync(path, { recursive: true, force: true });
  }
});

test('HTTP authentication, origin checks, and task preview/confirm work together', async () => {
  const f = fixture();
  const path = directory();
  const conversations = await Conversations.open(f.db, resolve(path, 'pi.sqlite'));
  const reminders = new Reminders(f.db, f.household, path, 'mailto:test@example.com');
  const app = createApp(f.db, f.household, conversations, reminders, 'http://localhost:5173');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  let cookie = '';
  const call = (url: string, body?: unknown, origin = 'http://localhost:5173') =>
    fetch(base + url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Household-Client': '1',
        Origin: origin,
        Cookie: cookie,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    assert.equal((await call('/api/state')).status, 401);
    assert.equal(
      (
        await call(
          '/api/login',
          { username: 'owner', password: 'Test-only-owner-password' },
          'https://untrusted.example',
        )
      ).status,
      403,
    );
    const login = await call('/api/login', {
      username: 'owner',
      password: 'Test-only-owner-password',
    });
    assert.equal(login.status, 200);
    cookie = login.headers.get('set-cookie')!.split(';')[0];
    const response = await call('/api/previews', { kind: 'task.create', task: task() });
    assert.equal(response.status, 201);
    const preview = (await response.json()) as { id: string };
    assert.equal(f.household.tasks().length, 0);
    assert.equal((await call(`/api/previews/${preview.id}/confirm`, {})).status, 200);
    const state = (await (await call('/api/state')).json()) as { tasks: Task[] };
    assert.equal(state.tasks.length, 1);
    assert.equal(state.tasks[0].title, 'Water the plants');
    assert.equal((await call('/api/tasks', { title: 'Bypass preview' })).status, 404);
    await call('/api/logout', {});
    assert.equal((await call('/api/state')).status, 401);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await conversations.close();
    f.db.close();
    rmSync(path, { recursive: true, force: true });
  }
});
