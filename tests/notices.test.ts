import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Store } from '../server/database.js';
import { DomainError } from '../server/errors.js';
import type { PushSender } from '../server/notices.js';
import { openHousehold } from '../server/runtime.js';
import type { CalendarEvent, CalendarSnapshot } from '../src/types.js';
import {
  client,
  config,
  directory,
  fakeCalendar,
  householdParts,
  householdStore,
  json,
  openStore,
  push,
  setUp,
  type Row,
} from './support.js';

/** One phone each: Alex's on Google's push service, Sam's on Apple's. */
const phone = {
  owner: 'https://fcm.googleapis.com/fcm/send/owner',
  partner: 'https://web.push.apple.com/partner',
};
const task = (title: string, dueAt: string | null, fields = {}) => ({
  kind: 'task.create' as const,
  task: {
    title,
    notes: '',
    category: 'household' as const,
    ownerId: 'owner',
    dueAt,
    schedule: null,
    ...fields,
  },
});
const event = (title: string, start: string, end: string, reminderMinutes: number) =>
  ({
    id: title,
    uid: title,
    etag: '"1"',
    title,
    notes: '',
    location: '',
    start,
    end,
    allDay: false,
    reminderMinutes,
    recurring: false,
    readOnlyReason: null,
  }) satisfies CalendarEvent;

/**
 * Both people on an injected clock, with a calendar the test edits and a
 * phone each that records the pushes it receives.
 */
async function household(at: string, file?: string) {
  let now = new Date(at);
  const calendar: CalendarSnapshot = {
    status: 'connected',
    name: 'Household',
    syncedAt: at,
    error: null,
    events: [],
  };
  type Push = { to: string; title: string };
  const sent: Push[] = [];
  const failing = new Set<string>();
  let onSend = async (_push: Push) => {};
  const send: PushSender = async (subscription, payload) => {
    const item = { to: subscription.endpoint, title: String(JSON.parse(payload).title) };
    await onSend(item);
    if (failing.has(item.to)) throw new Error('Push service down: credential=never-store-this');
    sent.push(item);
    return 201;
  };
  const open = (db: Store) =>
    householdParts(db, { clock: () => now, push, send, calendar: fakeCalendar(() => calendar) });
  const parts = open(await householdStore(file));
  await parts.subscribe('owner', phone.owner);
  await parts.subscribe('partner', phone.partner);
  return {
    ...parts,
    calendar,
    sent,
    failing,
    onSend(callback: typeof onSend) {
      onSend = callback;
    },
    time(value: string | number) {
      now = new Date(value);
    },
    async tick() {
      await parts.plan();
      await parts.notices.deliver();
    },
    /** The phones that received a push with this title, in order. */
    pushes: (title: string) => sent.filter((item) => item.title === title).map((item) => item.to),
    /** The titles in a person's Updates, oldest first, pushed or not. */
    updates: async (personId: string) =>
      (
        await parts.db.all<Row>(
          'SELECT title FROM notices WHERE user_id=? ORDER BY created_at,rowid',
          personId,
        )
      ).map((row) => String(row.title)),
    /** The same household after a restart, on the same clock, calendar and phones. */
    async reopen() {
      await parts.db.close();
      return open(openStore(file));
    },
  };
}

test('a task deadline push reaches each phone once, and never after the task stops applying', async () => {
  const f = await household('2026-10-14T07:00:00Z');
  const tablet = 'https://fcm.googleapis.com/fcm/send/owner-tablet';
  await f.subscribe('owner', tablet);
  const due = '2026-10-14T06:00:00.000Z';
  const create = async (title: string, fields = {}) =>
    (await f.changes.apply('owner', task(title, due, fields))).targetId;
  const edit = (id: string, title: string, fields: object) =>
    f.changes.apply('owner', {
      kind: 'task.update',
      id,
      revision: 1,
      task: task(title, due, fields).task,
    });
  const plants = await create('Water the plants');
  const rent = await create('Pay rent');
  const gym = await create('Cancel the gym');
  const plumber = await create('Call the plumber');
  const passport = await create('Renew the passport');
  const cat = await create('Feed the cat', {
    schedule: { frequency: 'daily', timezone: 'Asia/Dubai' },
  });
  await f.plan();
  // Only the rename leaves Alex's planned deadline in place. A reassigned task's deadline
  // goes to Sam, and a moved one is pushed once, for its new time.
  await edit(plants, 'Water the balcony plants', {});
  await f.changes.apply('owner', { kind: 'task.complete', id: rent, revision: 1 });
  await f.changes.apply('owner', { kind: 'task.delete', id: gym, revision: 1 });
  await edit(plumber, 'Call the plumber', { ownerId: 'partner' });
  await edit(passport, 'Renew the passport', { dueAt: '2026-10-14T06:30:00.000Z' });
  await f.changes.apply('owner', { kind: 'task.complete', id: cat, revision: 1 });
  await f.tick();
  await f.tick();
  assert.deepEqual(f.pushes('Water the plants'), [phone.owner, tablet]);
  assert.deepEqual(f.pushes('Call the plumber'), [phone.partner]);
  assert.deepEqual(f.pushes('Renew the passport'), [phone.owner, tablet]);
  for (const title of ['Pay rent', 'Cancel the gym', 'Feed the cat'])
    assert.deepEqual(f.pushes(title), [], title);
  // Alex's Updates keep every deadline, pushed or not.
  assert.deepEqual((await f.updates('owner')).sort(), [
    'Call the plumber',
    'Cancel the gym',
    'Feed the cat',
    'Pay rent',
    'Renew the passport',
    'Renew the passport',
    'Water the plants',
  ]);

  // Sam completes a task while its push is on the way to Alex's phone: the tablet gets none.
  const bins = await create('Take out the bins');
  f.onSend(async ({ title }) => {
    if (title !== 'Take out the bins') return;
    f.onSend(async () => {});
    await f.changes.apply('partner', { kind: 'task.complete', id: bins, revision: 1 });
  });
  await f.tick();
  await f.tick();
  assert.deepEqual(f.pushes('Take out the bins'), [phone.owner]);

  // The tablet is offline: only it is retried, and not for a task reassigned meanwhile.
  await create('Book the boiler service');
  const parcel = await create('Return the parcel');
  f.failing.add(tablet);
  await f.tick();
  await edit(parcel, 'Return the parcel', { ownerId: 'partner' });
  f.failing.clear();
  f.time('2026-10-14T07:10:00Z');
  await f.tick();
  assert.deepEqual(f.pushes('Book the boiler service'), [phone.owner, tablet]);
  assert.deepEqual(f.pushes('Return the parcel'), [phone.owner, phone.partner]);
  await f.db.close();
});

test('nothing is pushed more than two hours late, whether planned late or retried', async () => {
  const f = await household('2026-10-14T07:00:00Z');
  // After a restart at 07:00, a task due exactly two hours ago is pushed and an older one
  // is only kept. The 08:00 morning summary (04:00 UTC) is three hours late and isn't made.
  await f.changes.apply('owner', task('Pay the bills', '2026-10-14T05:00:00.000Z'));
  await f.changes.apply('owner', task('Renew the permit', '2026-10-14T04:59:59.999Z'));
  await f.tick();
  assert.deepEqual(f.pushes('Pay the bills'), [phone.owner]);
  assert.deepEqual(f.pushes('Renew the permit'), []);
  assert.deepEqual((await f.updates('owner')).sort(), ['Pay the bills', 'Renew the permit']);

  // A task and Sam's notice of it fail to push; once the phones are back two hours later,
  // neither is sent.
  f.failing.add(phone.owner).add(phone.partner);
  await f.changes.apply('owner', task('Fix the gate', '2026-10-14T07:00:00.000Z'));
  await f.tick();
  f.failing.clear();
  f.time('2026-10-14T09:00:00.001Z');
  let sent = f.sent.length;
  await f.tick();
  assert.equal(f.sent.length, sent);

  // Reminders wait out a calendar outage, but only until the event ends or two hours
  // after the reminder time, whichever is first.
  f.time('2026-10-14T10:30:00Z');
  f.calendar.events = [
    event('Dentist', '2026-10-14T11:00:00Z', '2026-10-14T11:30:00Z', 30),
    event('School play', '2026-10-14T11:30:00Z', '2026-10-14T15:00:00Z', 60),
    event('Concert', '2026-10-14T13:00:00Z', '2026-10-14T17:00:00Z', 180),
  ];
  await f.plan();
  f.calendar.status = 'error';
  await f.notices.deliver();
  f.calendar.status = 'connected';
  f.time('2026-10-14T12:00:00.001Z');
  await f.notices.deliver();
  assert.deepEqual(f.pushes('School play'), [phone.owner, phone.partner]);
  assert.deepEqual(f.pushes('Dentist'), []);
  assert.deepEqual(f.pushes('Concert'), []);

  // The 18:00 evening summary (14:00 UTC) fails to push, and isn't sent two hours later.
  f.time('2026-10-14T14:00:00Z');
  f.failing.add(phone.owner).add(phone.partner);
  await f.tick();
  f.failing.clear();
  f.time('2026-10-14T16:00:00.001Z');
  sent = f.sent.length;
  await f.tick();
  assert.equal(f.sent.length, sent);

  // Updates keep every one of them: the tasks, appointments and summary for Alex, and the
  // same appointments and summary with three change notices for Sam.
  const kept = await f.updates('owner');
  for (const title of [
    'Pay the bills',
    'Renew the permit',
    'Fix the gate',
    'Dentist',
    'School play',
    'Concert',
  ])
    assert(kept.includes(title), title);
  assert.equal(kept.length, 7);
  assert.equal((await f.updates('partner')).length, 7);
  await f.db.close();
});

test('a broken calendar or a failing phone cannot hold up other notices', async () => {
  const path = directory('notices');
  const f = await household('2026-10-14T13:59:00Z', resolve(path, 'household.sqlite'));
  try {
    // Two dozen reminders (a dozen appointments, each for both people) are due, and the
    // calendar breaks before they go out.
    f.calendar.events = Array.from({ length: 12 }, (_, i) =>
      event(`Appointment ${i + 1}`, '2026-10-14T14:30:00Z', '2026-10-14T15:00:00Z', 60),
    );
    await f.plan();
    f.calendar.status = 'error';
    await f.notices.deliver();

    // A minute later their retries are due with a task, Sam's notice of it and both
    // evening summaries: all four of those go out in that one pass, and only once.
    f.time('2026-10-14T14:00:00Z');
    await f.changes.apply('owner', task('Pay the bills', '2026-10-14T13:00:00.000Z'));
    await f.tick();
    assert.deepEqual(f.pushes('Pay the bills'), [phone.owner]);
    assert.equal(f.sent.length, 4);
    await f.tick();
    assert.equal(f.sent.length, 4);

    // The calendar is still down when the appointments end: one pass retires all of their
    // reminders, more than a batch, and nothing is left to retry.
    f.time('2026-10-14T15:00:00.001Z');
    await f.notices.deliver();
    assert.equal(await f.notices.nextWake(), null);

    // A reminder held up by the calendar survives a restart, waits for its retry, then
    // goes out once to each person.
    f.time('2026-10-14T15:30:00Z');
    f.calendar.status = 'connected';
    f.calendar.events = [
      event('School pickup', '2026-10-14T16:00:00Z', '2026-10-14T16:30:00Z', 30),
    ];
    await f.plan();
    f.calendar.status = 'error';
    await f.notices.deliver();
    const again = await f.reopen();
    f.calendar.status = 'connected';
    await again.notices.deliver();
    assert.deepEqual(f.pushes('School pickup'), []);
    f.time((await again.notices.nextWake())!);
    await again.notices.deliver();
    assert.deepEqual(f.pushes('School pickup'), [phone.owner, phone.partner]);

    // Alex's phone fails while twenty of Sam's changes wait for it; Sam still gets
    // Alex's change a minute later, and the push service's error is never stored.
    f.failing.add(phone.owner);
    for (let i = 1; i <= 20; i++)
      await again.changes.apply('partner', task(`Chore ${i}`, null, { ownerId: 'partner' }));
    f.time('2026-10-14T15:32:00Z');
    await again.changes.apply('owner', task('Call the bank', null));
    const sent = f.sent.length;
    await again.notices.deliver();
    assert.deepEqual(
      f.sent.slice(sent).map((item) => item.to),
      [phone.partner],
    );
    for (const { name } of await again.db.all<Row>(
      "SELECT name FROM sqlite_master WHERE type='table'",
    ))
      assert(
        !JSON.stringify(await again.db.all(`SELECT * FROM "${name}"`)).includes('never-store-this'),
        name,
      );
    await again.db.close();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test('summaries follow each person’s settings without duplicates, and appointment reminders go once per person', async () => {
  const f = await household('2026-10-14T03:55:00Z');
  const settings = (morning: boolean) => ({
    kind: 'preferences.update',
    revision: 1,
    preferences: {
      timezone: 'Asia/Dubai',
      morning: { enabled: morning, time: '08:00' },
      evening: { enabled: true, time: '18:00' },
    },
  });
  // Alex turns the morning summary off; a preview made from the older settings can't be
  // confirmed.
  const older = await f.changes.preview('owner', settings(true));
  await f.changes.apply('owner', settings(false));
  await assert.rejects(
    f.changes.confirm('owner', older.id),
    (error) => error instanceof DomainError && error.status === 409,
  );

  // 08:00 in Dubai, and again half a minute later: only Sam gets a morning summary, once.
  for (const at of ['2026-10-14T04:00:00Z', '2026-10-14T04:00:30Z']) {
    f.time(at);
    await f.tick();
  }
  assert.deepEqual(
    f.sent.map((item) => item.to),
    [phone.partner],
  );
  assert.equal((await f.updates('owner')).length, 0);
  assert.equal((await f.updates('partner')).length, 1);

  // Planning twice makes one reminder per person; one appointment is then deleted in
  // the calendar, so its reminder stays in Updates but isn't pushed.
  f.calendar.events = [
    event('Dentist', '2026-10-14T11:00:00Z', '2026-10-14T12:00:00Z', 30),
    event('School play', '2026-10-14T11:00:00Z', '2026-10-14T12:00:00Z', 30),
  ];
  for (const at of ['2026-10-14T10:30:00Z', '2026-10-14T10:30:30Z']) {
    f.time(at);
    await f.plan();
  }
  f.calendar.events.pop();
  await f.notices.deliver();
  assert.deepEqual(f.pushes('Dentist'), [phone.owner, phone.partner]);
  assert.deepEqual(f.pushes('School play'), []);
  assert.deepEqual(await f.updates('owner'), ['Dentist', 'School play']);
  assert.deepEqual((await f.updates('partner')).slice(1), ['Dentist', 'School play']);

  // 18:00, and again half a minute later: one evening summary each.
  const sent = f.sent.length;
  for (const at of ['2026-10-14T14:00:00Z', '2026-10-14T14:00:30Z']) {
    f.time(at);
    await f.tick();
  }
  assert.deepEqual(
    f.sent.slice(sent).map((item) => item.to),
    [phone.owner, phone.partner],
  );
  assert.equal((await f.updates('owner')).length, 3);
  assert.equal((await f.updates('partner')).length, 4);
  await f.db.close();
});

test('phones stay subscribed: the push key outlives a restart, and only push services are accepted', async () => {
  const path = directory('notices');
  const file = resolve(path, 'household.sqlite');
  const received: { to: string; key: string }[] = [];
  const overrides = {
    clock: () => new Date('2026-10-14T07:00:00Z'),
    send: (async (subscription, _payload, vapid) => {
      received.push({ to: subscription.endpoint, key: vapid.publicKey });
      return 201;
    }) satisfies PushSender,
  };
  const keys = { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) };
  const first = await openHousehold(openStore(file), config, overrides);
  await setUp(first.household);
  const key = (await json(await client(first).call('/api/push/key'))).publicKey;
  assert.match(key, /^[\w-]{80,}$/);
  for (const endpoint of [
    'http://127.0.0.1/sam',
    'https://push.apple.com.attacker.example/sam',
    'https://user:password@web.push.apple.com/sam',
  ])
    assert.equal(
      (await client(first, 'partner').call('/api/push/subscription', { endpoint, keys })).status,
      400,
      endpoint,
    );
  for (const person of ['owner', 'partner'] as const)
    assert.equal(
      (
        await client(first, person).call('/api/push/subscription', {
          endpoint: phone[person],
          keys,
        })
      ).status,
      200,
    );
  await first.conversations.close();

  // After a restart the key is the same, so Sam's phone still gets Alex's changes.
  const again = await openHousehold(openStore(file), config, overrides);
  try {
    const owner = client(again);
    assert.equal((await json(await owner.call('/api/push/key'))).publicKey, key);
    const preview = await json(await owner.call('/api/previews', task('Book the plumber', null)));
    assert.equal((await owner.call(`/api/previews/${preview.id}/confirm`, {})).status, 200);
    await again.tick();
    assert.deepEqual(received, [{ to: phone.partner, key }]);
  } finally {
    await again.conversations.close();
    rmSync(path, { recursive: true, force: true });
  }
});
