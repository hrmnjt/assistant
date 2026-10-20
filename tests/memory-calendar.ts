import { randomUUID } from 'node:crypto';
import { DomainError } from '../server/errors.js';
import type { CalendarResource, CalendarTransport } from '../server/plugins/calendar/caldav.js';
import { createEventData, parseEvents } from '../server/plugins/calendar/icalendar.js';
import type { CalendarFields } from '../src/types.js';

/** The appointment the tests add, edit and delete. */
export const appointment: CalendarFields = {
  title: 'Dinner together',
  notes: 'Bring a book',
  location: 'Home',
  start: '2026-10-15T15:00:00.000Z',
  end: '2026-10-15T16:00:00.000Z',
  allDay: false,
  reminderMinutes: 30,
};

type Step = 'read' | 'write' | 'response';
type Gate = { reached: Promise<void>; release(): void; pass(): Promise<void> };
function gate(): Gate {
  let reach!: () => void, release!: () => void;
  const reached = new Promise<void>((done) => (reach = done));
  const released = new Promise<void>((done) => (release = done));
  return {
    reached,
    release,
    async pass() {
      reach();
      await released;
    },
  };
}

/**
 * The shared iCloud calendar, in memory: CalDAV's ETag preconditions, plus
 * what people do in Apple Calendar and the ways a request to iCloud can fail.
 */
export class MemoryCalendar implements CalendarTransport {
  readonly base = 'https://p01-caldav.icloud.com/123/calendars/household/';
  resources = new Map<string, CalendarResource>();
  /** PUTs and DELETEs that reached iCloud, and every request the app made. */
  writes = 0;
  removals = 0;
  requests = 0;
  /** While offline, every request fails before it reaches iCloud. */
  offline = false;
  /** The next PUT or DELETE is lost: before it lands (`request`) or after (`response`). */
  lose?: 'request' | 'response';
  private version = 0;
  private holds: Record<Step, Gate[]> = { read: [], write: [], response: [] };

  /**
   * Hold the next read of an appointment, the next write before it lands, or
   * the response to the next write after it lands, until the test releases it.
   */
  hold(step: Step) {
    const held = gate();
    this.holds[step].push(held);
    return { reached: held.reached, release: held.release };
  }
  private reach() {
    this.requests++;
    if (this.offline) throw new Error('iCloud is unreachable');
  }
  async collection() {
    this.reach();
    return { name: 'Household', url: this.base };
  }
  async list() {
    this.reach();
    return [...this.resources.values()].map((resource) => ({ ...resource }));
  }
  async get(url: string) {
    this.reach();
    await this.holds.read.shift()?.pass();
    const resource = this.resources.get(url);
    return resource ? { ...resource } : null;
  }
  async put(url: string, data: string, etag: string | null) {
    await this.write(url, etag, () => {
      this.writes++;
      this.resources.set(url, { url, data, etag: this.etag() });
    });
  }
  async remove(url: string, etag: string) {
    await this.write(url, etag, () => {
      this.removals++;
      this.resources.delete(url);
    });
  }
  private async write(url: string, etag: string | null, land: () => void) {
    this.reach();
    await this.holds.write.shift()?.pass();
    const lose = this.lose;
    this.lose = undefined;
    if (lose === 'request') throw new Error('The request was lost');
    const prior = this.resources.get(url);
    if (etag ? prior?.etag !== etag : prior) throw new DomainError('Precondition failed.', 409);
    land();
    await this.holds.response.shift()?.pass();
    if (lose === 'response') throw new Error('The response was lost');
  }
  private etag() {
    return `"${++this.version}"`;
  }

  /** A person adds an appointment in Apple Calendar, with any extra iCalendar lines. */
  seed(fields: Partial<CalendarFields> = {}, lines: string[] = [], uid: string = randomUUID()) {
    const url = `${this.base}${uid}.ics`;
    const data = createEventData(uid, { ...appointment, ...fields }, 'apple').replace(
      'END:VEVENT',
      [...lines, 'END:VEVENT'].join('\r\n'),
    );
    this.resources.set(url, { url, data, etag: this.etag() });
    return url;
  }
  /** A person renames it in Apple Calendar, which keeps everything else, the app's receipt too. */
  rename(url: string, title: string) {
    const old = this.resources.get(url)!;
    const data = old.data.replace(/^SUMMARY:.*$/m, `SUMMARY:${title}`);
    this.resources.set(url, { url, data, etag: this.etag() });
  }
  /** Another device saves it afresh: the same appointment, without the app's receipt. */
  rewrite(url: string, title: string) {
    const [event] = parseEvents(this.resources.get(url)!);
    const data = createEventData(event.uid, { ...appointment, title }, 'other-device');
    this.resources.set(url, { url, data, etag: this.etag() });
  }
  /** A person deletes it in Apple Calendar. */
  erase(url: string) {
    this.resources.delete(url);
  }
  /** Everything iCloud holds, and how many writes reached it, to compare before and after. */
  contents() {
    return JSON.stringify({
      resources: [...this.resources],
      writes: this.writes,
      removals: this.removals,
    });
  }
}
