import { DateTime } from 'luxon';
import type { CalendarEvent } from './types';

export function eventsForDay(events: CalendarEvent[], day: string, zone: string) {
  const beginning = DateTime.fromISO(day, { zone }).startOf('day');
  const end = beginning.plus({ days: 1 });
  return events
    .filter((event) => {
      const start = DateTime.fromISO(event.start, { zone }).setZone(zone);
      const finish = DateTime.fromISO(event.end, { zone }).setZone(zone);
      return start < end && (finish > beginning || (+start === +finish && start >= beginning));
    })
    .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start));
}
