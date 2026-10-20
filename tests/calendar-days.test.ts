import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventsForDay } from '../src/calendar-days.js';
import type { CalendarEvent } from '../src/types.js';
const event = (values: Partial<CalendarEvent>): CalendarEvent => ({
  id: 'one',
  uid: 'uid',
  etag: 'v1',
  title: 'Plan',
  notes: '',
  location: '',
  allDay: false,
  start: '2026-10-16T19:30:00Z',
  end: '2026-10-16T21:00:00Z',
  reminderMinutes: null,
  recurring: false,
  readOnlyReason: null,
  ...values,
});
test('a day lists the appointments overlapping it in the person’s time zone', () => {
  const listed = (values: Partial<CalendarEvent>, zone: string, days: string[]) =>
    days.map((day) => eventsForDay([event(values)], day, zone).length);
  // 23:30 to 01:00 in Dubai crosses midnight.
  assert.deepEqual(listed({}, 'Asia/Dubai', ['2026-10-16', '2026-10-17', '2026-10-18']), [1, 1, 0]);
  // An all-day event's end date is exclusive.
  assert.deepEqual(
    listed({ allDay: true, start: '2026-10-16', end: '2026-10-19' }, 'America/Los_Angeles', [
      '2026-10-16',
      '2026-10-17',
      '2026-10-18',
      '2026-10-19',
    ]),
    [1, 1, 1, 0],
  );
  // On the day daylight saving ends, an event ending at midnight stays on that day.
  assert.deepEqual(
    listed({ start: '2026-11-01T07:30:00Z', end: '2026-11-02T08:00:00Z' }, 'America/Los_Angeles', [
      '2026-11-01',
      '2026-11-02',
    ]),
    [1, 0],
  );
});
