import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventsForDay, monthDays } from '../src/calendar-days.js';
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
test('a month grid covers six Monday-first weeks across year and leap-month boundaries', () => {
  const january = monthDays('2027-01', 'Asia/Dubai');
  assert.equal(january.length, 42);
  assert.equal(january[0].weekday, 1);
  assert.equal(january[0].toISODate(), '2026-12-28');
  assert.ok(monthDays('2028-02', 'Asia/Dubai').some((day) => day.toISODate() === '2028-02-29'));
});
test('events crossing midnight in a person’s time zone appear on both selected days', () => {
  const values = [event({})];
  assert.equal(eventsForDay(values, '2026-10-16', 'Asia/Dubai').length, 1);
  assert.equal(eventsForDay(values, '2026-10-17', 'Asia/Dubai').length, 1);
  assert.equal(eventsForDay(values, '2026-10-18', 'Asia/Dubai').length, 0);
});
test('all-day spans use inclusive selected days and an exclusive final date', () => {
  const values = [event({ allDay: true, start: '2026-10-16', end: '2026-10-19' })];
  for (const day of ['2026-10-16', '2026-10-17', '2026-10-18'])
    assert.equal(eventsForDay(values, day, 'America/Los_Angeles').length, 1);
  assert.equal(eventsForDay(values, '2026-10-19', 'America/Los_Angeles').length, 0);
});
test('day selection respects daylight saving and does not include an event ending at midnight', () => {
  const values = [event({ start: '2026-11-01T07:30:00Z', end: '2026-11-02T08:00:00Z' })];
  assert.equal(eventsForDay(values, '2026-11-01', 'America/Los_Angeles').length, 1);
  assert.equal(eventsForDay(values, '2026-11-02', 'America/Los_Angeles').length, 0);
});
