import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { openHousehold } from '../server/runtime.js';
import type {
  CalendarEvent,
  CalendarFields,
  CalendarSnapshot,
  Preview,
  Snapshot,
} from '../src/types.js';
import { client, config, json, openStore, setUp, type Row } from './support.js';
import { appointment, MemoryCalendar } from './memory-calendar.js';

type Person = ReturnType<typeof client>;

/** Both people on a development server, sharing one calendar, with a clock the test moves. */
async function household(t: TestContext, calendar: MemoryCalendar) {
  let now = Date.parse('2026-10-14T07:00:00Z');
  const app = await openHousehold(openStore(), config, {
    transport: calendar,
    clock: () => new Date(now),
  });
  t.after(() => app.conversations.close());
  await setUp(app.household);
  const alex = client(app);
  return {
    app,
    alex,
    sam: client(app, 'partner'),
    later(ms: number) {
      now += ms;
    },
    async refresh(): Promise<CalendarSnapshot> {
      return await json(await alex.call('/api/calendar/refresh', {}));
    },
  };
}
const state = async (person: Person): Promise<Snapshot> =>
  await json(await person.call('/api/state'));
async function propose(person: Person, change: unknown): Promise<Preview> {
  const response = await person.call('/api/previews', change);
  assert.equal(response.status, 201);
  return await json(response);
}
const confirm = (person: Person, id: string) => person.call(`/api/previews/${id}/confirm`, {});
const cancel = (person: Person, id: string) =>
  person.call(`/api/previews/${id}`, undefined, 'DELETE');
const fields = ({ title, notes, location, start, end, allDay, reminderMinutes }: CalendarEvent) =>
  ({ title, notes, location, start, end, allDay, reminderMinutes }) satisfies CalendarFields;
const update = (event: CalendarEvent, title: string) => ({
  kind: 'calendar.update',
  id: event.id,
  etag: event.etag,
  event: { ...fields(event), title },
});
const create = { kind: 'calendar.create', event: appointment };

test('an appointment is added once, only when Alex confirms it, and Sam hears about it once', async (t) => {
  const calendar = new MemoryCalendar();
  const f = await household(t, calendar);
  const preview = await propose(f.alex, create);
  assert.equal(calendar.resources.size, 0);
  assert.equal((await confirm(f.sam, preview.id)).status, 404);
  // iCloud is unreachable: nothing was attempted, so trying again can still add it.
  calendar.offline = true;
  const offline = await confirm(f.alex, preview.id);
  assert.equal(offline.status, 503);
  assert.equal((await json(offline)).calendarOutcome, undefined);
  calendar.offline = false;
  const confirmed = await confirm(f.alex, preview.id);
  assert.equal(confirmed.status, 200);
  const result = await json(confirmed);
  assert.equal(result.ok, true);
  assert.deepEqual(await json(await confirm(f.alex, preview.id)), result);
  assert.equal(calendar.writes, 1);
  const sam = await state(f.sam);
  assert.deepEqual(
    sam.notices.map((notice) => notice.targetId),
    [result.targetId],
  );
  assert(sam.calendar.events.some((event) => event.id === result.targetId));
  // A cancelled preview cannot be confirmed; an expired one fails without contacting iCloud.
  const cancelled = await propose(f.alex, create);
  assert.equal((await cancel(f.alex, cancelled.id)).status, 200);
  assert.equal((await confirm(f.alex, cancelled.id)).status, 404);
  const expiring = await propose(f.alex, create);
  f.later(10 * 60_000);
  const requests = calendar.requests;
  const expired = await confirm(f.alex, expiring.id);
  assert.equal(expired.status, 409);
  assert.equal((await json(expired)).calendarOutcome.status, 'failed');
  assert.equal(calendar.requests, requests);
  assert.equal(calendar.writes, 1);
});

test('the app and Apple Calendar share one calendar, keeping what Apple Calendar added', async (t) => {
  const calendar = new MemoryCalendar();
  const dinner = calendar.seed({ reminderMinutes: null }, [
    'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC',
    'BEGIN:VALARM',
    'ACTION:AUDIO',
    'TRIGGER:-PT1H',
    'X-WR-ALARMUID:apple-alarm',
    'END:VALARM',
  ]);
  calendar.seed({ title: 'Weekend away', allDay: true, start: '2026-10-17', end: '2026-10-19' });
  calendar.seed({ title: 'Gym' }, ['RRULE:FREQ=WEEKLY']);
  calendar.seed({ title: 'Team lunch' }, ['ATTENDEE:mailto:guest@example.com']);
  const f = await household(t, calendar);
  const named = (snapshot: CalendarSnapshot, title: string) =>
    snapshot.events.find((event) => event.title === title)!;
  const synced = await f.refresh();
  const original = named(synced, 'Dinner together');
  assert.equal(original.reminderMinutes, 60);
  // An all-day weekend: the 17th and 18th, ending on the 19th.
  const weekend = named(synced, 'Weekend away');
  assert.deepEqual(
    [weekend.allDay, weekend.start, weekend.end],
    [true, '2026-10-17', '2026-10-19'],
  );
  // Recurring appointments and invitations are read-only here.
  for (const title of ['Gym', 'Team lunch']) {
    const event = named(synced, title);
    assert(event.readOnlyReason);
    assert.equal((await f.alex.call('/api/previews', update(event, 'Changed'))).status, 409);
  }
  // A rename in Apple Calendar keeps the appointment and tells no one.
  calendar.rename(dinner, 'Dinner at eight');
  const renamed = named(await f.refresh(), 'Dinner at eight');
  assert.equal(renamed.id, original.id);
  for (const person of [f.alex, f.sam]) assert.deepEqual((await state(person)).notices, []);
  // Alex retitles it in the app, line break and all: still one iCloud event, with Apple's details.
  const title = 'Dinner\nBEGIN:VEVENT';
  const edit = await propose(f.alex, update(renamed, title));
  assert.equal((await confirm(f.alex, edit.id)).status, 200);
  const lines = calendar.resources.get(dinner)!.data.split('\r\n');
  assert.equal(lines.filter((line) => line === 'BEGIN:VEVENT').length, 1);
  assert(lines.includes('X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC'));
  assert(lines.includes('X-WR-ALARMUID:apple-alarm'));
  const edited = (await state(f.alex)).calendar.events;
  const saved = edited.find((event) => event.id === original.id)!;
  assert.deepEqual([saved.uid, saved.title], [original.uid, title]);
  assert.equal(edited.length, 4);
  assert.equal(calendar.resources.size, 4);
  // Deleting it in Apple Calendar removes it here; while iCloud fails, the last calendar stays.
  calendar.erase(dinner);
  assert(!(await f.refresh()).events.some((event) => event.id === original.id));
  calendar.offline = true;
  const failed = await f.refresh();
  assert.equal(failed.status, 'error');
  assert(failed.error);
  assert.equal(failed.events.length, 3);
});

test('an app edit never overwrites a human edit', async (t) => {
  const calendar = new MemoryCalendar();
  const dinner = calendar.seed();
  const f = await household(t, calendar);
  const [event] = (await f.refresh()).events;
  const before = await propose(f.alex, update(event, 'App title'));
  calendar.rename(dinner, 'Human title');
  assert.equal((await confirm(f.alex, before.id)).status, 409);
  // A preview from the version Alex last saw is refused.
  assert.equal((await f.alex.call('/api/previews', update(event, 'App title'))).status, 409);
  // A human edit between the app's last read and its PUT is caught too.
  const [current] = (await f.refresh()).events;
  const late = await propose(f.alex, update(current, 'App title'));
  const write = calendar.hold('write');
  const confirming = confirm(f.alex, late.id);
  await write.reached;
  calendar.rename(dinner, 'Last-moment human title');
  write.release();
  assert.equal((await confirming).status, 409);
  assert.equal(calendar.writes, 0);
  assert.equal((await f.refresh()).events[0].title, 'Last-moment human title');
});

// A write whose result was lost: its request (before it landed) or its response
// (after). Then, before Alex checks again, the appointment in iCloud was left
// untouched; renamed in Apple Calendar, which keeps the app's receipt;
// rewritten on another device, which drops it; erased; or, after a delete, recreated.
const lostWrites = [
  { kind: 'create', lost: 'response', then: 'untouched', check: 'applied' },
  { kind: 'create', lost: 'response', then: 'renamed', check: 'applied' },
  { kind: 'create', lost: 'response', then: 'rewritten', check: 'unknown' },
  { kind: 'create', lost: 'response', then: 'erased', check: 'unknown' },
  { kind: 'create', lost: 'request', then: 'untouched', check: 'unknown' },
  { kind: 'update', lost: 'response', then: 'untouched', check: 'applied' },
  { kind: 'update', lost: 'response', then: 'renamed', check: 'applied' },
  { kind: 'update', lost: 'response', then: 'rewritten', check: 'unknown' },
  { kind: 'update', lost: 'response', then: 'erased', check: 'unknown' },
  { kind: 'update', lost: 'request', then: 'untouched', check: 'unknown' },
  { kind: 'delete', lost: 'response', then: 'untouched', check: 'applied' },
  { kind: 'delete', lost: 'response', then: 'recreated', check: 'unknown' },
  { kind: 'delete', lost: 'request', then: 'untouched', check: 'unknown' },
] as const;

test('a lost write is never sent again, and counts as done only when iCloud proves it', async (t) => {
  for (const row of lostWrites) {
    const name = `${row.kind}, ${row.lost} lost, then ${row.then}`;
    const calendar = new MemoryCalendar();
    const other = calendar.seed({ title: 'Dentist' });
    const target = row.kind === 'create' ? undefined : calendar.seed();
    const f = await household(t, calendar);
    const event = (await f.refresh()).events.find((item) => item.title === appointment.title)!;
    const { id } = await propose(
      f.alex,
      row.kind === 'create'
        ? create
        : row.kind === 'update'
          ? update(event, 'Later dinner')
          : { kind: 'calendar.delete', id: event.id, etag: event.etag },
    );
    calendar.lose = row.lost;
    const lost = await confirm(f.alex, id);
    assert.equal(lost.status, 503, name);
    assert.equal((await json(lost)).calendarOutcome.status, 'unknown', name);
    assert.equal((await cancel(f.alex, id)).status, 409, name);
    const url = target ?? [...calendar.resources.keys()].find((key) => key !== other)!;
    if (row.then === 'renamed') calendar.rename(url, 'Renamed in Apple Calendar');
    if (row.then === 'rewritten') calendar.rewrite(url, 'Rewritten elsewhere');
    if (row.then === 'erased') calendar.erase(url);
    if (row.then === 'recreated') calendar.seed({}, [], event.uid);
    // After the preview expires, checking it again (twice) only reads iCloud.
    const before = calendar.contents();
    f.later(11 * 60_000);
    for (const check of [await confirm(f.alex, id), await confirm(f.alex, id)]) {
      assert.equal(check.status, 200, name);
      assert.equal((await json(check)).calendarOutcome.status, row.check, name);
    }
    assert.equal(calendar.contents(), before, name);
    assert.equal((await state(f.sam)).notices.length, row.check === 'applied' ? 1 : 0, name);
  }
});

test('a slow confirmation and repeated taps send one write, with one audit and one notice', async (t) => {
  const calendar = new MemoryCalendar();
  const f = await household(t, calendar);
  const { id } = await propose(f.alex, create);
  const read = calendar.hold('read');
  const response = calendar.hold('response');
  // The first tap waits on iCloud; it cannot be cancelled meanwhile.
  const first = confirm(f.alex, id);
  await read.reached;
  assert.equal((await cancel(f.alex, id)).status, 409);
  // It outlives its lease, so a second tap takes over and writes; that response is slow too.
  f.later(46_000);
  const second = confirm(f.alex, id);
  await response.reached;
  // When the first tap's read returns, it is rejected, and the second tap's claim stands.
  read.release();
  assert.equal((await first).status, 409);
  assert.equal((await cancel(f.alex, id)).status, 409);
  // A third tap, after the second's lease, finds the write's receipt in iCloud.
  f.later(46_000);
  const third = await confirm(f.alex, id);
  assert.equal(third.status, 200);
  const result = await json(third);
  assert.equal(result.calendarOutcome.status, 'applied');
  response.release();
  assert.deepEqual(await json(await second), result);
  assert.equal(calendar.writes, 1);
  assert.equal((await f.app.db.get<Row>('SELECT COUNT(*) AS count FROM audit'))?.count, 1);
  assert.equal((await state(f.sam)).notices.length, 1);
});
