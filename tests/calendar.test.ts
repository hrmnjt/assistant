import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Database } from '../server/database.js';
import { Household, DomainError } from '../server/domain.js';
import { CalendarOutcomeError, CalendarService } from '../server/calendar.js';
import type { CalendarResource, CalendarTransport } from '../server/caldav.js';
import { createEventData, parseEvents, updateEventData } from '../server/icalendar.js';
import type { CalendarFields } from '../src/types.js';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Reminders } from '../server/reminders.js';

const fields: CalendarFields = {
  title: 'Dinner together',
  notes: 'Bring a book',
  location: 'Home',
  start: '2026-10-15T15:00:00.000Z',
  end: '2026-10-15T16:00:00.000Z',
  allDay: false,
  reminderMinutes: 30,
};
const base = 'https://p01-caldav.icloud.com/123/calendars/household/';
class MemoryCalendar implements CalendarTransport {
  resources = new Map<string, CalendarResource>();
  writes = 0;
  removals = 0;
  sequence = 0;
  losePutResponse = false;
  loseDeleteResponse = false;
  beforePut?: () => void;
  async collection() {
    return { name: 'Household', url: base };
  }
  async list() {
    return [...this.resources.values()].map((resource) => ({ ...resource }));
  }
  async get(url: string) {
    const value = this.resources.get(url);
    return value ? { ...value } : null;
  }
  async put(url: string, data: string, etag: string | null) {
    this.beforePut?.();
    this.beforePut = undefined;
    const prior = this.resources.get(url);
    if (etag ? prior?.etag !== etag : Boolean(prior))
      throw new DomainError('Precondition failed.', 409);
    this.writes++;
    this.resources.set(url, { url, data, etag: `"${++this.sequence}"` });
    if (this.losePutResponse) {
      this.losePutResponse = false;
      throw new Error('Response lost after write');
    }
  }
  async remove(url: string, etag: string) {
    if (this.resources.get(url)?.etag !== etag) throw new DomainError('Precondition failed.', 409);
    this.removals++;
    this.resources.delete(url);
    if (this.loseDeleteResponse) {
      this.loseDeleteResponse = false;
      throw new Error('Response lost after delete');
    }
  }
  seed(value: CalendarFields = fields, uid = randomUUID()) {
    const url = `${base}${uid}.ics`;
    this.resources.set(url, {
      url,
      data: createEventData(uid, value, 'original'),
      etag: `"${++this.sequence}"`,
    });
    return url;
  }
  humanEdit(url: string, title: string) {
    const old = this.resources.get(url)!;
    this.resources.set(url, {
      ...old,
      data: updateEventData(old, { ...fields, title }, 'human'),
      etag: `"${++this.sequence}"`,
    });
  }
}
function fixture(path = ':memory:') {
  const db = new Database(path);
  for (const id of ['owner', 'partner'])
    db.sql.prepare('INSERT INTO users VALUES (?,?,?,?)').run(id, id, id, 'unused-test-password');
  const transport = new MemoryCalendar();
  const service = new CalendarService(db, transport, () => new Date('2026-10-14T07:00:00Z'));
  return { db, transport, service };
}

test('calendar sync reflects external edits and deletion without changing the event identity', async () => {
  const f = fixture();
  try {
    const url = f.transport.seed();
    await f.service.sync();
    const first = f.service.snapshot().events[0];
    f.transport.humanEdit(url, 'Dinner at eight');
    await f.service.sync();
    assert.equal(f.service.snapshot().events[0].id, first.id);
    assert.equal(f.service.snapshot().events[0].title, 'Dinner at eight');
    assert.equal(
      f.db.sql.prepare('SELECT id FROM notices').all().length,
      0,
      'external calendar edits sync silently',
    );
    f.transport.resources.delete(url);
    await f.service.sync();
    assert.equal(f.service.snapshot().events.length, 0);
  } finally {
    f.db.close();
  }
});
test('calendar creation writes only after actor-bound confirmation and retries do not create copies', async () => {
  const f = fixture();
  try {
    const preview = await f.service.preview('owner', { kind: 'calendar.create', event: fields });
    assert.equal(f.transport.writes, 0);
    assert.equal(f.transport.resources.size, 0);
    await assert.rejects(f.service.confirm('partner', preview.id), DomainError);
    const first = await f.service.confirm('owner', preview.id);
    const second = await f.service.confirm('owner', preview.id);
    assert.deepEqual(first, second);
    assert.equal(f.transport.writes, 1);
    assert.equal(f.transport.resources.size, 1);
  } finally {
    f.db.close();
  }
});
test('calendar cancellation makes the pending operation impossible', async () => {
  const f = fixture();
  try {
    const preview = await f.service.preview('owner', { kind: 'calendar.create', event: fields });
    f.service.cancel('owner', preview.id);
    await assert.rejects(f.service.confirm('owner', preview.id), DomainError);
    assert.equal(f.transport.writes, 0);
  } finally {
    f.db.close();
  }
});
test('an app update preserves the iCloud UID and resource URL', async () => {
  const f = fixture();
  try {
    const url = f.transport.seed();
    await f.service.sync();
    const original = f.service.snapshot().events[0];
    const preview = await f.service.preview('partner', {
      kind: 'calendar.update',
      id: original.id,
      etag: original.etag,
      event: {
        ...fields,
        title: 'A new time',
        start: '2026-10-15T16:00:00.000Z',
        end: '2026-10-15T17:00:00.000Z',
      },
    });
    await f.service.confirm('partner', preview.id);
    const saved = f.service.snapshot().events[0];
    assert.equal(saved.uid, original.uid);
    assert.equal(saved.id, original.id);
    assert.equal(saved.title, 'A new time');
    assert(f.transport.resources.has(url));
    assert.equal(f.transport.resources.size, 1);
  } finally {
    f.db.close();
  }
});
test('human edits made before preview or before confirmation reject stale app updates', async () => {
  const f = fixture();
  try {
    const url = f.transport.seed();
    await f.service.sync();
    const original = f.service.snapshot().events[0];
    const preview = await f.service.preview('owner', {
      kind: 'calendar.update',
      id: original.id,
      etag: original.etag,
      event: { ...fields, title: 'Outdated app edit' },
    });
    f.transport.humanEdit(url, 'A human changed this');
    await assert.rejects(
      f.service.confirm('owner', preview.id),
      (error: unknown) => error instanceof DomainError && error.status === 409,
    );
    await assert.rejects(
      f.service.preview('owner', {
        kind: 'calendar.update',
        id: original.id,
        etag: original.etag,
        event: fields,
      }),
      DomainError,
    );
    assert.equal(parseEvents(f.transport.resources.get(url)!)[0].title, 'A human changed this');
    assert.equal(f.transport.writes, 0);
    f.service.cancel('owner', preview.id);
  } finally {
    f.db.close();
  }
});
test('the remote ETag precondition also catches edits between the last read and PUT', async () => {
  const f = fixture();
  try {
    const url = f.transport.seed();
    await f.service.sync();
    const event = f.service.snapshot().events[0];
    const preview = await f.service.preview('owner', {
      kind: 'calendar.update',
      id: event.id,
      etag: event.etag,
      event: { ...fields, title: 'App edit' },
    });
    f.transport.beforePut = () => f.transport.humanEdit(url, 'Last-moment human edit');
    await assert.rejects(f.service.confirm('owner', preview.id), DomainError);
    assert.equal(f.transport.writes, 0);
    assert.equal(parseEvents(f.transport.resources.get(url)!)[0].title, 'Last-moment human edit');
    f.service.cancel('owner', preview.id);
  } finally {
    f.db.close();
  }
});
test('a lost create response is reconciled through the same preview without another PUT', async () => {
  const f = fixture();
  try {
    const preview = await f.service.preview('owner', { kind: 'calendar.create', event: fields });
    f.transport.losePutResponse = true;
    await assert.rejects(
      f.service.confirm('owner', preview.id),
      (error: unknown) => error instanceof DomainError && error.status === 503,
    );
    assert.throws(() => f.service.cancel('owner', preview.id), DomainError);
    // Simulate reopening the service after a process restart.
    const reopened = new CalendarService(f.db, f.transport, () => new Date('2026-10-14T07:01:00Z'));
    await reopened.confirm('owner', preview.id);
    assert.equal(f.transport.writes, 1);
    assert.equal(f.transport.resources.size, 1);
  } finally {
    f.db.close();
  }
});
test('a lost delete response can be retried without deleting any other appointment', async () => {
  const f = fixture();
  try {
    f.transport.seed();
    f.transport.seed({ ...fields, title: 'Keep this appointment' });
    await f.service.sync();
    const event = f.service.snapshot().events.find((event) => event.title === fields.title)!;
    const preview = await f.service.preview('owner', {
      kind: 'calendar.delete',
      id: event.id,
      etag: event.etag,
    });
    f.transport.loseDeleteResponse = true;
    await assert.rejects(f.service.confirm('owner', preview.id), DomainError);
    await f.service.confirm('owner', preview.id);
    assert.equal(f.transport.removals, 1);
    assert.equal(f.service.snapshot().events[0].title, 'Keep this appointment');
  } finally {
    f.db.close();
  }
});
test('a preview is blocked from cancellation while its confirmation is in progress', async () => {
  const f = fixture();
  try {
    const preview = await f.service.preview('owner', { kind: 'calendar.create', event: fields });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const originalGet = f.transport.get.bind(f.transport);
    f.transport.get = async (url) => {
      entered();
      await gate;
      return originalGet(url);
    };
    const confirmation = f.service.confirm('owner', preview.id);
    await reached;
    assert.throws(() => f.service.cancel('owner', preview.id), DomainError);
    assert.throws(() => f.service.dismiss('owner', preview.id), DomainError);
    release();
    await confirmation;
    assert.equal(f.transport.writes, 1);
  } finally {
    f.db.close();
  }
});
test('iCalendar serialization escapes content and preserves unrelated properties and alarms', () => {
  const uid = randomUUID();
  let data = createEventData(uid, fields, 'seed').replace(
    'END:VEVENT',
    'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC\r\nEND:VEVENT',
  );
  const resource = { url: `${base}${uid}.ics`, etag: '"1"', data };
  const updated = updateEventData(
    resource,
    { ...fields, title: 'Dinner\nBEGIN:VEVENT', notes: 'Changed notes' },
    'app-edit',
  );
  const parsed = parseEvents({ ...resource, data: updated });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].uid, uid);
  assert.equal(parsed[0].title, 'Dinner\nBEGIN:VEVENT');
  assert(updated.includes('X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC'));
  assert(updated.includes('BEGIN:VALARM'));
});
test('all-day appointments round-trip as dates with an exclusive end', () => {
  const event = { ...fields, allDay: true, start: '2026-10-15', end: '2026-10-17' };
  const parsed = parseEvents({
    url: `${base}all-day.ics`,
    etag: '"1"',
    data: createEventData('all-day', event, 'seed'),
  })[0];
  assert.equal(parsed.allDay, true);
  assert.equal(parsed.start, '2026-10-15');
  assert.equal(parsed.end, '2026-10-17');
});
test('recurring appointments and invitations are readable but protected from unsafe updates', async () => {
  const f = fixture();
  try {
    for (const extra of ['RRULE:FREQ=DAILY', 'ATTENDEE:mailto:guest@example.com']) {
      const url = f.transport.seed();
      const resource = f.transport.resources.get(url)!;
      resource.data = resource.data.replace('END:VEVENT', `${extra}\r\nEND:VEVENT`);
    }
    await f.service.sync();
    assert.equal(f.service.snapshot().events.length, 2);
    for (const event of f.service.snapshot().events) {
      assert(event.readOnlyReason);
      await assert.rejects(
        f.service.preview('owner', {
          kind: 'calendar.update',
          id: event.id,
          etag: event.etag,
          event: fields,
        }),
        DomainError,
      );
    }
    assert.equal(f.transport.writes, 0);
  } finally {
    f.db.close();
  }
});
test('calendar sync failure preserves cached events and exposes a stale status', async () => {
  const f = fixture();
  try {
    f.transport.seed();
    await f.service.sync();
    f.transport.list = async () => {
      throw new Error('Network unavailable');
    };
    await f.service.sync();
    assert.equal(f.service.snapshot().status, 'error');
    assert.equal(f.service.snapshot().events.length, 1);
    assert(f.service.snapshot().error);
  } finally {
    f.db.close();
  }
});
test('missing configuration and invalid date ranges cannot create appointments', async () => {
  const f = fixture();
  try {
    const disconnected = new CalendarService(f.db);
    await assert.rejects(
      disconnected.preview('owner', { kind: 'calendar.create', event: fields }),
      DomainError,
    );
    await assert.rejects(
      f.service.preview('owner', {
        kind: 'calendar.create',
        event: { ...fields, end: fields.start },
      }),
      DomainError,
    );
    await assert.rejects(
      f.service.preview('owner', {
        kind: 'calendar.create',
        event: { ...fields, start: 'not a date' },
      }),
      DomainError,
    );
    assert.equal(f.transport.writes, 0);
  } finally {
    f.db.close();
  }
});

test('appointment reminders are planned once for each person, without removing native iCloud alarms', async () => {
  const f = fixture();
  mkdirSync(resolve('.cache/tests'), { recursive: true });
  const path = mkdtempSync(resolve('.cache/tests/calendar-reminders-'));
  try {
    const preferences = {
      timezone: 'Asia/Dubai',
      morning: { enabled: false, time: '08:00' },
      evening: { enabled: false, time: '18:00' },
    };
    for (const id of ['owner', 'partner'])
      f.db.sql
        .prepare('INSERT INTO preferences VALUES (?,?,1)')
        .run(id, JSON.stringify(preferences));
    const url = f.transport.seed();
    await f.service.sync();
    const reminders = new Reminders(
      f.db,
      new Household(f.db),
      path,
      'mailto:test@example.com',
      () => f.service.snapshot(),
    );
    reminders.plan(new Date('2026-10-15T14:30:00Z'));
    reminders.plan(new Date('2026-10-15T14:30:30Z'));
    const rows = f.db.sql
      .prepare("SELECT user_id FROM notices WHERE id LIKE 'appointment:%' ORDER BY user_id")
      .all();
    assert.deepEqual(
      rows.map((row) => row.user_id),
      ['owner', 'partner'],
    );
    assert(f.transport.resources.get(url)!.data.includes('BEGIN:VALARM'));
    f.transport.resources.delete(url);
    await f.service.sync();
    await reminders.deliver();
    assert.equal(
      f.db.sql.prepare("SELECT id FROM notices WHERE delivery='pending'").all().length,
      0,
    );
  } finally {
    f.db.close();
    rmSync(path, { recursive: true, force: true });
  }
});

for (const kind of ['calendar.create', 'calendar.update', 'calendar.delete'] as const) {
  for (const external of ['edit', 'delete'] as const) {
    test(`lost ${kind} response after external ${external} and expiry never sends another write`, async () => {
      const f = fixture();
      try {
        const originalUrl = kind === 'calendar.create' ? undefined : f.transport.seed();
        await f.service.sync();
        const event = f.service.snapshot().events[0];
        const preview = await f.service.preview(
          'owner',
          kind === 'calendar.create'
            ? { kind, event: fields }
            : kind === 'calendar.update'
              ? {
                  kind,
                  id: event.id,
                  etag: event.etag,
                  event: { ...fields, title: 'Requested edit' },
                }
              : { kind, id: event.id, etag: event.etag },
        );
        if (kind === 'calendar.delete') f.transport.loseDeleteResponse = true;
        else f.transport.losePutResponse = true;
        await assert.rejects(
          f.service.confirm('owner', preview.id),
          (error: unknown) =>
            error instanceof CalendarOutcomeError && error.calendarOutcome.status === 'unknown',
        );
        const url = originalUrl ?? [...f.transport.resources.keys()][0];
        if (external === 'delete') f.transport.resources.delete(url);
        else if (kind === 'calendar.delete') {
          // A person recreated the same resource after our uncertain deletion.
          const uid = event.uid;
          f.transport.resources.set(url, {
            url,
            etag: '"recreated"',
            data: createEventData(uid, fields, 'human'),
          });
        } else f.transport.humanEdit(url, 'Keep this human edit');
        const before = JSON.stringify([...f.transport.resources]);
        const writes = f.transport.writes;
        const removals = f.transport.removals;
        const reopened = new CalendarService(
          f.db,
          f.transport,
          () => new Date('2026-10-14T07:20:00Z'),
        );
        const result = await reopened.confirm('owner', preview.id);
        const expected =
          kind === 'calendar.delete' && external === 'delete' ? 'applied' : 'unknown';
        assert.equal(result.calendarOutcome?.status, expected);
        assert.equal(result.ok, expected === 'applied');
        assert.equal(f.transport.writes, writes);
        assert.equal(f.transport.removals, removals);
        assert.equal(JSON.stringify([...f.transport.resources]), before);
        if (expected === 'unknown') {
          assert.equal(f.db.sql.prepare('SELECT id FROM notices').all().length, 0);
          assert.throws(() => reopened.dismiss('partner', preview.id), DomainError);
          reopened.dismiss('owner', preview.id);
          reopened.dismiss('owner', preview.id);
          await assert.rejects(reopened.confirm('owner', preview.id), /dismissed/);
          const saved = f.db.sql
            .prepare('SELECT result,applied_at FROM previews WHERE id=?')
            .get(preview.id)!;
          assert.equal(saved.applied_at, null);
          assert.equal(JSON.parse(String(saved.result)).calendarOutcome.status, 'unknown');
          assert.ok(JSON.parse(String(saved.result)).dismissedAt);
        }
      } finally {
        f.db.close();
      }
    });
  }
}

test('a disk reopen preserves unknown outcomes, actor binding and dismissal without another write', async () => {
  mkdirSync(resolve('.cache/tests'), { recursive: true });
  const path = mkdtempSync(resolve('.cache/tests/calendar-recovery-'));
  const f = fixture(resolve(path, 'app.sqlite'));
  let db = f.db;
  try {
    const preview = await f.service.preview('owner', { kind: 'calendar.create', event: fields });
    f.transport.losePutResponse = true;
    await assert.rejects(f.service.confirm('owner', preview.id));
    f.transport.humanEdit([...f.transport.resources.keys()][0], 'Human edit across restart');
    db.close();
    db = new Database(resolve(path, 'app.sqlite'));
    const reopened = new CalendarService(db, f.transport, () => new Date('2026-10-14T08:00:00Z'));
    await assert.rejects(reopened.confirm('partner', preview.id));
    assert.equal((await reopened.confirm('owner', preview.id)).calendarOutcome?.status, 'unknown');
    reopened.dismiss('owner', preview.id);
    db.close();
    db = new Database(resolve(path, 'app.sqlite'));
    await assert.rejects(
      new CalendarService(db, f.transport).confirm('owner', preview.id),
      /dismissed/,
    );
    assert.equal(f.transport.writes, 1);
    assert.equal(
      parseEvents([...f.transport.resources.values()][0])[0].title,
      'Human edit across restart',
    );
  } finally {
    db.close();
    rmSync(path, { recursive: true, force: true });
  }
});

test('a retained operation receipt proves the original write without overwriting later fields', async () => {
  const f = fixture();
  try {
    const preview = await f.service.preview('owner', { kind: 'calendar.create', event: fields });
    f.transport.losePutResponse = true;
    await assert.rejects(f.service.confirm('owner', preview.id));
    const [url, resource] = [...f.transport.resources][0];
    resource.data = resource.data.replace('SUMMARY:Dinner together', 'SUMMARY:Later human edit');
    resource.etag = '"later-version"';
    const reopened = new CalendarService(f.db, f.transport, () => new Date('2026-10-14T08:00:00Z'));
    const result = await reopened.confirm('owner', preview.id);
    assert.equal(result.calendarOutcome?.status, 'applied');
    assert.equal(f.transport.writes, 1);
    assert.equal(f.transport.resources.get(url)?.etag, '"later-version"');
    assert.equal(reopened.snapshot().events[0].title, 'Later human edit');
    assert.equal(reopened.snapshot().events[0].uid, parseEvents(resource)[0].uid);
  } finally {
    f.db.close();
  }
});

test('an expired unattempted preview records failure without contacting iCloud', async () => {
  const f = fixture();
  try {
    const preview = await f.service.preview('owner', { kind: 'calendar.create', event: fields });
    f.transport.get = async () => {
      throw new Error('Must not contact iCloud');
    };
    const reopened = new CalendarService(f.db, f.transport, () => new Date('2026-10-14T07:10:00Z'));
    await assert.rejects(
      reopened.confirm('owner', preview.id),
      (error: unknown) =>
        error instanceof CalendarOutcomeError && error.calendarOutcome.status === 'failed',
    );
    assert.equal(f.transport.writes, 0);
    const result = JSON.parse(
      String(f.db.sql.prepare('SELECT result FROM previews WHERE id=?').get(preview.id)!.result),
    );
    assert.equal(result.calendarOutcome.status, 'failed');
    reopened.dismiss('owner', preview.id);
    await assert.rejects(reopened.confirm('owner', preview.id));
  } finally {
    f.db.close();
  }
});

test('a failed read before admission does not consume authorization or claim an uncertain write', async () => {
  const f = fixture();
  try {
    const preview = await f.service.preview('owner', { kind: 'calendar.create', event: fields });
    const get = f.transport.get.bind(f.transport);
    f.transport.get = async () => {
      throw new Error('Offline');
    };
    await assert.rejects(f.service.confirm('owner', preview.id), /No write was attempted/);
    assert.equal(f.db.sql.prepare('SELECT attempted FROM calendar_operations').get()?.attempted, 0);
    f.transport.get = get;
    assert.equal((await f.service.confirm('owner', preview.id)).ok, true);
  } finally {
    f.db.close();
  }
});

test('uncertain writes remain read-only even before expiry when the remote request did not land', async () => {
  const f = fixture();
  try {
    const preview = await f.service.preview('owner', { kind: 'calendar.create', event: fields });
    f.transport.put = async () => {
      throw new Error('Transport failed before acceptance');
    };
    await assert.rejects(f.service.confirm('owner', preview.id));
    f.transport.put = async () => {
      assert.fail('A reconciliation must never retry a write');
    };
    assert.equal((await f.service.confirm('owner', preview.id)).calendarOutcome?.status, 'unknown');
    assert.equal(f.transport.resources.size, 0);
  } finally {
    f.db.close();
  }
});

test('calendar confirmation notifies the other spouse once, including reconciliation after a lost response', async () => {
  const f = fixture();
  try {
    const preview = await f.service.preview('owner', { kind: 'calendar.create', event: fields });
    assert.equal(f.db.sql.prepare('SELECT id FROM notices').all().length, 0);
    f.transport.losePutResponse = true;
    await assert.rejects(f.service.confirm('owner', preview.id));
    assert.equal(f.db.sql.prepare('SELECT id FROM notices').all().length, 0);
    const result = await f.service.confirm('owner', preview.id);
    await f.service.confirm('owner', preview.id);
    const rows = f.db.sql.prepare('SELECT * FROM notices').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, 'partner');
    assert.equal(
      f.db.sql.prepare('SELECT target_id FROM notice_targets').get()?.target_id,
      result.targetId,
    );
  } finally {
    f.db.close();
  }
});
