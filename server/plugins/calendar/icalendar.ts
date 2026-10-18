import ICAL from 'ical.js';
import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import type { CalendarEvent, CalendarFields } from '../../../src/types.js';
import type { CalendarResource } from './caldav.js';
import { DomainError } from '../../errors.js';

export function eventId(url: string, uid: string, recurrenceId = '') {
  return createHash('sha256').update(`${url}\n${uid}\n${recurrenceId}`).digest('hex');
}
function component(data: string) {
  const calendar = new ICAL.Component(ICAL.parse(data));
  for (const zone of calendar.getAllSubcomponents('vtimezone')) {
    const id = String(zone.getFirstPropertyValue('tzid') || '');
    if (id) ICAL.TimezoneService.register(new ICAL.Timezone({ component: zone, tzid: id }));
  }
  return calendar;
}
function stringTime(time: InstanceType<typeof ICAL.Time>) {
  if (time.isDate) return time.toString();
  if (time.zone.tzid === 'floating')
    return DateTime.fromISO(time.toString(), { zone: 'Asia/Dubai' }).toUTC().toISO()!;
  return time.toJSDate().toISOString();
}
function reminder(event: InstanceType<typeof ICAL.Component>) {
  const values = event
    .getAllSubcomponents('valarm')
    .map((alarm) => {
      if (alarm.getFirstProperty('trigger')?.getParameter('related') === 'END') return NaN;
      const trigger = alarm.getFirstPropertyValue('trigger');
      return trigger instanceof ICAL.Duration ? -trigger.toSeconds() / 60 : NaN;
    })
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= 10080);
  return values.length ? Math.min(...values) : null;
}
export function parseEvents(resource: CalendarResource): CalendarEvent[] {
  const calendar = component(resource.data);
  return calendar
    .getAllSubcomponents('vevent')
    .filter((event) => event.getFirstPropertyValue('status') !== 'CANCELLED')
    .map((event) => {
      const parsed = new ICAL.Event(event);
      const uid = String(event.getFirstPropertyValue('uid') || '');
      if (!uid || !parsed.startDate)
        throw new DomainError('An iCloud appointment could not be read.', 503);
      const recurring =
        event.hasProperty('rrule') ||
        event.hasProperty('recurrence-id') ||
        event.hasProperty('rdate');
      const invited = event.hasProperty('attendee') || event.hasProperty('organizer');
      return {
        id: eventId(resource.url, uid, String(event.getFirstPropertyValue('recurrence-id') || '')),
        uid,
        etag: resource.etag,
        title: parsed.summary || 'Untitled appointment',
        notes: parsed.description || '',
        location: parsed.location || '',
        start: stringTime(parsed.startDate),
        end: stringTime(parsed.endDate),
        allDay: parsed.startDate.isDate,
        reminderMinutes: reminder(event),
        recurring,
        readOnlyReason: recurring
          ? 'Edit recurring appointments in Apple Calendar for now.'
          : invited
            ? 'Edit invitations in Apple Calendar for now.'
            : !resource.etag
              ? 'iCloud did not return an event version. Refresh before editing.'
              : null,
      };
    });
}

function setFields(
  event: InstanceType<typeof ICAL.Component>,
  fields: CalendarFields,
  operationId: string,
  prior?: CalendarEvent,
) {
  event.updatePropertyWithValue('summary', fields.title);
  event.updatePropertyWithValue('description', fields.notes);
  event.updatePropertyWithValue('location', fields.location);
  for (const name of ['dtstart', 'dtend']) event.removeAllProperties(name);
  event.removeAllProperties('duration');
  event.addPropertyWithValue(
    'dtstart',
    fields.allDay
      ? ICAL.Time.fromDateString(fields.start)
      : ICAL.Time.fromJSDate(new Date(fields.start), true),
  );
  event.addPropertyWithValue(
    'dtend',
    fields.allDay
      ? ICAL.Time.fromDateString(fields.end)
      : ICAL.Time.fromJSDate(new Date(fields.end), true),
  );
  event.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true));
  event.updatePropertyWithValue('last-modified', ICAL.Time.fromJSDate(new Date(), true));
  event.updatePropertyWithValue(
    'sequence',
    Number(event.getFirstPropertyValue('sequence') || 0) + 1,
  );
  event.updatePropertyWithValue('x-household-operation', operationId);
  if (!prior || prior.reminderMinutes !== fields.reminderMinutes) {
    event.removeAllSubcomponents('valarm');
    if (fields.reminderMinutes !== null) {
      const alarm = new ICAL.Component('valarm');
      alarm.addPropertyWithValue('action', 'DISPLAY');
      alarm.addPropertyWithValue('description', fields.title);
      alarm.addPropertyWithValue(
        'trigger',
        ICAL.Duration.fromSeconds(-fields.reminderMinutes * 60),
      );
      event.addSubcomponent(alarm);
    }
  }
}
export function createEventData(uid: string, fields: CalendarFields, operationId: string) {
  const calendar = new ICAL.Component('vcalendar');
  calendar.addPropertyWithValue('version', '2.0');
  calendar.addPropertyWithValue('prodid', '-//Our day//Household assistant//EN');
  const event = new ICAL.Component('vevent');
  event.addPropertyWithValue('uid', uid);
  setFields(event, fields, operationId);
  calendar.addSubcomponent(event);
  return calendar.toString();
}
export function updateEventData(
  resource: CalendarResource,
  fields: CalendarFields,
  operationId: string,
) {
  const calendar = component(resource.data);
  const events = calendar.getAllSubcomponents('vevent');
  const prior = parseEvents(resource);
  if (events.length !== 1 || prior.length !== 1 || prior[0].readOnlyReason)
    throw new DomainError(
      prior[0]?.readOnlyReason || 'This appointment must be edited in Apple Calendar.',
      409,
    );
  setFields(events[0], fields, operationId, prior[0]);
  return calendar.toString();
}
// The operation marker is a receipt for the original write, not a fingerprint
// of today's fields. Apple Calendar may preserve it while editing those fields.
export function hasOperation(resource: CalendarResource, operationId: string, uid: string) {
  try {
    return component(resource.data)
      .getAllSubcomponents('vevent')
      .some(
        (event) =>
          event.getFirstPropertyValue('uid') === uid &&
          event.getFirstPropertyValue('x-household-operation') === operationId,
      );
  } catch {
    return false;
  }
}
