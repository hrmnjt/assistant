import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { notifyPartner } from './changes.js';
import type {
  CalendarEvent,
  CalendarOutcome,
  ConfirmationResult,
  CalendarFields,
  CalendarMutation,
  CalendarSnapshot,
  Preview,
} from '../src/types.js';
import type { Database } from './database.js';
import { DomainError } from './domain.js';
import type { CalendarResource, CalendarTransport } from './caldav.js';
import {
  createEventData,
  eventId,
  hasOperation,
  parseEvents,
  updateEventData,
} from './icalendar.js';

const fields = z
  .object({
    title: z.string().trim().min(1).max(200),
    notes: z.string().max(5000),
    location: z.string().max(1000),
    start: z.string().max(50),
    end: z.string().max(50),
    allDay: z.boolean(),
    reminderMinutes: z.number().int().min(0).max(10080).nullable(),
  })
  .strict()
  .superRefine((event, ctx) => {
    const start = event.allDay
      ? DateTime.fromISO(event.start, { zone: 'UTC' })
      : DateTime.fromISO(event.start);
    const end = event.allDay
      ? DateTime.fromISO(event.end, { zone: 'UTC' })
      : DateTime.fromISO(event.end);
    const format = event.allDay ? /^\d{4}-\d{2}-\d{2}$/ : /T.*(?:Z|[+-]\d{2}:\d{2})$/;
    if (
      !format.test(event.start) ||
      !format.test(event.end) ||
      !start.isValid ||
      !end.isValid ||
      start.year < 2000 ||
      end.year > 2100 ||
      end <= start
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Choose valid start and end times, with the end after the start.',
      });
    }
  });
const calendarId = z.string().regex(/^[a-f0-9]{64}$/);
const etag = z.string().min(1).max(1000);
export const calendarMutationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('calendar.create'), event: fields }).strict(),
  z.object({ kind: z.literal('calendar.update'), id: calendarId, etag, event: fields }).strict(),
  z.object({ kind: z.literal('calendar.delete'), id: calendarId, etag }).strict(),
]);
type StoredOperation = {
  kind: CalendarMutation['kind'];
  url: string;
  etag: string | null;
  data: string | null;
  fields: CalendarFields | null;
  uid: string;
};

export class CalendarOutcomeError extends DomainError {
  constructor(
    readonly calendarOutcome: CalendarOutcome,
    status: number,
  ) {
    super(calendarOutcome.message, status);
  }
}

class CalendarClaimError extends DomainError {
  constructor() {
    super('A newer check owns this preview. Reopen its current result before retrying.', 409);
  }
}

export class CalendarService {
  private state: CalendarSnapshot = {
    status: 'not-connected',
    name: 'Household',
    syncedAt: null,
    error: null,
    events: [],
  };
  private syncing?: Promise<void>;
  constructor(
    private db: Database,
    private transport?: CalendarTransport,
    private clock: () => Date = () => new Date(),
  ) {
    const saved = db.sql.prepare('SELECT * FROM calendar_state WHERE id=1').get();
    if (saved && transport)
      this.state = {
        status: 'error',
        name: String(saved.name),
        syncedAt: String(saved.synced_at),
        error: 'Refreshing the calendar connection.',
        events: this.cached(),
      };
  }
  snapshot(): CalendarSnapshot {
    const base = DateTime.fromISO(this.state.syncedAt ?? this.clock().toISOString(), {
      zone: 'UTC',
    }).startOf('month');
    return {
      ...this.state,
      months: {
        first: base.minus({ months: 1 }).toFormat('yyyy-MM'),
        last: base.plus({ months: 2 }).toFormat('yyyy-MM'),
      },
    };
  }
  private cached() {
    return this.db.sql
      .prepare('SELECT value FROM calendar_cache ORDER BY id')
      .all()
      .map((row) => JSON.parse(String(row.value)) as CalendarEvent);
  }
  async sync() {
    if (!this.transport) return;
    if (!this.syncing)
      this.syncing = this.syncNow().finally(() => {
        this.syncing = undefined;
      });
    await this.syncing;
  }
  /** Settles when an in-progress refresh has finished. */
  async idle() {
    await this.syncing?.catch(() => undefined);
  }
  private async syncNow() {
    try {
      const collection = await this.transport!.collection();
      const now = DateTime.fromJSDate(this.clock(), { zone: 'UTC' }).startOf('month');
      const resources = await this.transport!.list(
        now.minus({ months: 1, days: 2 }).toISO()!,
        now.plus({ months: 3, days: 2 }).toISO()!,
      );
      const events = resources.flatMap((resource) =>
        parseEvents(resource).map((event) => ({ event, url: resource.url })),
      );
      const syncedAt = this.clock().toISOString();
      this.db.transaction(() => {
        this.db.sql.prepare('DELETE FROM calendar_cache').run();
        for (const entry of events)
          this.db.sql
            .prepare('INSERT OR REPLACE INTO calendar_cache VALUES (?,?,?)')
            .run(entry.event.id, JSON.stringify(entry.event), entry.url);
        this.db.sql
          .prepare(
            'INSERT INTO calendar_state VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,synced_at=excluded.synced_at',
          )
          .run(collection.name, syncedAt);
      });
      this.state = {
        status: 'connected',
        name: collection.name,
        syncedAt,
        error: null,
        events: events.map((entry) => entry.event).sort((a, b) => a.start.localeCompare(b.start)),
      };
    } catch (error) {
      this.state = {
        ...this.state,
        status: 'error',
        error:
          error instanceof DomainError
            ? error.message
            : 'The shared calendar could not be refreshed. The owner needs to check the connection.',
      };
    }
  }
  private resource(id: string) {
    const row = this.db.sql.prepare('SELECT * FROM calendar_cache WHERE id=?').get(id);
    if (!row)
      throw new DomainError(
        'This appointment is no longer in the calendar. Refresh before editing.',
        409,
      );
    return { event: JSON.parse(String(row.value)) as CalendarEvent, url: String(row.resource_url) };
  }
  async preview(actorId: string, input: unknown): Promise<Preview> {
    if (!this.transport) throw new DomainError('The shared calendar is not connected yet.', 503);
    const parsed = calendarMutationSchema.safeParse(input);
    if (!parsed.success)
      throw new DomainError(parsed.error.issues.map((issue) => issue.message).join(' '));
    const mutation = parsed.data;
    const collection = await this.transport.collection();
    const previewId = randomUUID();
    let prior: CalendarEvent | undefined;
    let resource: CalendarResource | null = null;
    let url: string;
    let uid: string;
    if (mutation.kind === 'calendar.create') {
      uid = randomUUID();
      url = new URL(
        `${uid}.ics`,
        collection.url.endsWith('/') ? collection.url : `${collection.url}/`,
      ).href;
    } else {
      const saved = this.resource(mutation.id);
      if (saved.event.readOnlyReason) throw new DomainError(saved.event.readOnlyReason, 409);
      resource = await this.transport.get(saved.url);
      if (!resource || resource.etag !== mutation.etag)
        throw new DomainError(
          'This appointment changed in iCloud. Refresh and review a new preview.',
          409,
        );
      const events = parseEvents(resource);
      if (events.length !== 1 || events[0].uid !== saved.event.uid || events[0].readOnlyReason)
        throw new DomainError(
          events[0]?.readOnlyReason || 'The appointment changed. Refresh before editing.',
          409,
        );
      prior = events[0];
      uid = prior.uid;
      url = saved.url;
    }
    const event =
      mutation.kind === 'calendar.delete'
        ? null
        : {
            ...mutation.event,
            start: mutation.event.allDay
              ? mutation.event.start
              : new Date(mutation.event.start).toISOString(),
            end: mutation.event.allDay
              ? mutation.event.end
              : new Date(mutation.event.end).toISOString(),
          };
    const operation: StoredOperation = {
      kind: mutation.kind,
      url,
      uid,
      etag: resource?.etag || null,
      fields: event,
      data: event
        ? resource
          ? updateEventData(resource, event, previewId)
          : createEventData(uid, event, previewId)
        : null,
    };
    const view: Preview = {
      id: previewId,
      title:
        mutation.kind === 'calendar.create'
          ? 'Add this appointment?'
          : mutation.kind === 'calendar.update'
            ? 'Save this appointment?'
            : 'Delete this appointment?',
      expiresAt: new Date(this.clock().getTime() + 600_000).toISOString(),
      details: [{ label: 'Calendar', after: collection.name }],
    };
    if (event) {
      view.details.push(
        { label: 'Appointment', after: event.title, before: prior?.title },
        { label: 'Starts', after: event.start, before: prior?.start },
        {
          label: event.allDay ? 'Through' : 'Ends',
          after: event.allDay
            ? DateTime.fromISO(event.end).minus({ days: 1 }).toISODate()!
            : event.end,
          before: prior
            ? prior.allDay
              ? DateTime.fromISO(prior.end).minus({ days: 1 }).toISODate()!
              : prior.end
            : undefined,
        },
        {
          label: 'Location',
          after: event.location || 'None',
          before: prior ? prior.location || 'None' : undefined,
        },
        {
          label: 'Reminder',
          after:
            event.reminderMinutes === null
              ? 'No relative reminder'
              : `${event.reminderMinutes} minutes before`,
          before: prior
            ? prior.reminderMinutes === null
              ? 'No relative reminder'
              : `${prior.reminderMinutes} minutes before`
            : undefined,
        },
        {
          label: 'Notes',
          after: event.notes || 'None',
          before: prior ? prior.notes || 'None' : undefined,
        },
      );
    } else
      view.details.push(
        { label: 'Appointment', after: prior!.title },
        { label: 'Starts', after: prior!.start },
        { label: 'Result', after: 'Removes the shared appointment from iCloud for both of you.' },
      );
    this.db.transaction(() => {
      this.db.sql
        .prepare('INSERT INTO previews(id,user_id,mutation,view,expires_at) VALUES (?,?,?,?,?)')
        .run(
          previewId,
          actorId,
          JSON.stringify(mutation),
          JSON.stringify(view),
          Date.parse(view.expiresAt),
        );
      this.db.sql
        .prepare('INSERT INTO calendar_operations(preview_id,value) VALUES (?,?)')
        .run(previewId, JSON.stringify(operation));
    });
    return view;
  }
  isCalendarPreview(previewId: string, actorId: string) {
    return Boolean(
      this.db.sql
        .prepare(
          'SELECT p.id FROM previews p JOIN calendar_operations c ON c.preview_id=p.id WHERE p.id=? AND p.user_id=?',
        )
        .get(previewId, actorId),
    );
  }
  cancel(actorId: string, previewId: string) {
    const row = this.db.sql
      .prepare(
        'SELECT p.applied_at,p.result,c.attempted,c.lease_until FROM previews p JOIN calendar_operations c ON c.preview_id=p.id WHERE p.id=? AND p.user_id=?',
      )
      .get(previewId, actorId);
    if (row && row.applied_at === null) {
      if (Number(row.lease_until) > this.clock().getTime())
        throw new DomainError('This calendar confirmation is in progress. Please wait.', 409);
      if (row.attempted) {
        const result: ConfirmationResult | null = row.result
          ? JSON.parse(String(row.result))
          : null;
        throw new CalendarOutcomeError(
          result?.calendarOutcome ?? {
            status: 'unknown',
            message:
              'This write was already attempted. Check its result (read only), or explicitly dismiss the uncertain result; cancellation cannot undo it.',
          },
          409,
        );
      }
    }
    this.db.sql
      .prepare('DELETE FROM previews WHERE id=? AND user_id=? AND applied_at IS NULL')
      .run(previewId, actorId);
  }
  // Dismissal acknowledges uncertainty; it never cancels or undoes a remote write.
  // Keep the operation and its receipt so a reload/retry cannot make it writable again.
  dismiss(actorId: string, previewId: string) {
    this.db.transaction(() => {
      const row = this.db.sql
        .prepare(
          'SELECT p.result,c.attempted,c.lease_until FROM previews p JOIN calendar_operations c ON c.preview_id=p.id WHERE p.id=? AND p.user_id=?',
        )
        .get(previewId, actorId);
      if (!row) throw new DomainError('This calendar preview is unavailable.', 404);
      if (Number(row.lease_until) > this.clock().getTime())
        throw new DomainError(
          'Wait for the active confirmation before dismissing its result.',
          409,
        );
      const result = row.result ? JSON.parse(String(row.result)) : {};
      if (!row.attempted && !result.calendarOutcome)
        throw new DomainError('Cancel this unconfirmed preview instead.', 409);
      result.dismissedAt ??= this.clock().toISOString();
      this.db.sql
        .prepare('UPDATE previews SET result=? WHERE id=?')
        .run(JSON.stringify(result), previewId);
    });
  }
  private recordOutcome(
    previewId: string,
    operation: StoredOperation,
    outcome: CalendarOutcome,
  ): ConfirmationResult {
    const result: ConfirmationResult = {
      ok: outcome.status === 'applied',
      targetId: eventId(operation.url, operation.uid),
      calendarOutcome: outcome,
    };
    return this.db.transaction(() => {
      const row = this.db.sql
        .prepare('SELECT applied_at,result FROM previews WHERE id=?')
        .get(previewId);
      if (!row) throw new DomainError('This calendar preview is unavailable.', 404);
      const previous = row.result ? JSON.parse(String(row.result)) : null;
      // Late responses cannot replace a committed receipt or erase dismissal.
      if (row.applied_at !== null || previous?.dismissedAt) return { ...result, ...previous };
      this.db.sql
        .prepare('UPDATE previews SET result=? WHERE id=?')
        .run(JSON.stringify(result), previewId);
      return result;
    });
  }
  private assertClaim(previewId: string, leaseUntil: number) {
    const row = this.db.sql
      .prepare('SELECT lease_until FROM calendar_operations WHERE preview_id=?')
      .get(previewId);
    if (!row || Number(row.lease_until) !== leaseUntil) throw new CalendarClaimError();
  }
  async confirm(actorId: string, previewId: string): Promise<ConfirmationResult> {
    if (!this.transport) throw new DomainError('The shared calendar is not connected yet.', 503);
    const claim = this.db.transaction(() => {
      const row = this.db.sql
        .prepare(
          'SELECT p.*,c.value AS operation,c.attempted,c.lease_until FROM previews p JOIN calendar_operations c ON c.preview_id=p.id WHERE p.id=? AND p.user_id=?',
        )
        .get(previewId, actorId);
      if (!row) throw new DomainError('This calendar preview is unavailable.', 404);
      if (row.applied_at !== null)
        return { done: JSON.parse(String(row.result)) as ConfirmationResult };
      const previous: ConfirmationResult | null = row.result
        ? JSON.parse(String(row.result))
        : null;
      if (previous?.dismissedAt)
        throw new DomainError(
          'This result was dismissed. Review the current calendar before preparing a new change.',
          409,
        );
      if (
        previous?.calendarOutcome &&
        ['conflicted', 'failed'].includes(previous.calendarOutcome.status)
      )
        throw new CalendarOutcomeError(previous.calendarOutcome, 409);
      const expired = Number(row.expires_at) <= this.clock().getTime();
      if (Number(row.lease_until) > this.clock().getTime())
        throw new DomainError(
          'This confirmation is already in progress. Please wait before retrying.',
          409,
        );
      const leaseUntil = this.clock().getTime() + 45_000;
      this.db.sql
        .prepare('UPDATE calendar_operations SET lease_until=? WHERE preview_id=?')
        .run(leaseUntil, previewId);
      return {
        leaseUntil,
        operation: JSON.parse(String(row.operation)) as StoredOperation,
        previouslyAttempted: Boolean(row.attempted),
        view: JSON.parse(String(row.view)) as Preview,
        expired,
      };
    });
    if (claim.done) return claim.done;
    const operation = claim.operation!;
    let attempted = claim.previouslyAttempted;
    const reject = (status: 'failed' | 'conflicted', message: string): never => {
      const outcome = { status, message };
      this.recordOutcome(previewId, operation, outcome);
      throw new CalendarOutcomeError(outcome, 409);
    };
    try {
      if (claim.expired && !attempted)
        reject(
          'failed',
          'This preview expired before a write was attempted. Review a new preview.',
        );
      const current = await this.transport.get(operation.url);
      // A slow preflight may outlive its lease. Only its current owner may
      // decide the outcome or admit a new write after that awaited read.
      this.assertClaim(previewId, claim.leaseUntil!);
      const alreadyWritten = current && hasOperation(current, previewId, operation.uid);
      const alreadyDeleted = operation.kind === 'calendar.delete' && attempted && !current;
      if (attempted && !alreadyWritten && !alreadyDeleted) {
        const result = this.recordOutcome(previewId, operation, {
          status: 'unknown',
          message:
            'The original write may have succeeded, but the calendar no longer proves its result. No further write was sent. Review the current calendar, then dismiss this result or check again.',
        });
        await this.sync();
        return result;
      }
      if (!alreadyWritten && !alreadyDeleted) {
        if (operation.kind === 'calendar.create') {
          if (current)
            reject(
              'conflicted',
              'This appointment resource already exists. Refresh the calendar and review a new preview.',
            );
          this.db.sql
            .prepare('UPDATE calendar_operations SET attempted=1 WHERE preview_id=?')
            .run(previewId);
          attempted = true;
          await this.transport.put(operation.url, operation.data!, null);
        } else {
          if (!current || current.etag !== operation.etag)
            reject(
              'conflicted',
              'This appointment changed in iCloud. Refresh and review a new preview.',
            );
          this.db.sql
            .prepare('UPDATE calendar_operations SET attempted=1 WHERE preview_id=?')
            .run(previewId);
          attempted = true;
          if (operation.kind === 'calendar.update')
            await this.transport.put(operation.url, operation.data!, operation.etag);
          else await this.transport.remove(operation.url, operation.etag!);
        }
      }
      const result: ConfirmationResult = {
        ok: true,
        targetId: eventId(operation.url, operation.uid),
        calendarOutcome: {
          status: 'applied',
          message: alreadyDeleted
            ? 'The appointment is absent from iCloud. No further delete was sent.'
            : alreadyWritten
              ? 'iCloud retains the receipt for this write. Later calendar edits have been preserved.'
              : 'iCloud accepted this change.',
        },
      };
      const committed = this.db.transaction<ConfirmationResult>(() => {
        const saved = this.db.sql
          .prepare('SELECT applied_at,result FROM previews WHERE id=?')
          .get(previewId)!;
        const previous: ConfirmationResult | null = saved.result
          ? JSON.parse(String(saved.result))
          : null;
        if (saved.applied_at !== null) return previous!;
        if (previous?.dismissedAt) result.dismissedAt = previous.dismissedAt;
        this.db.sql
          .prepare('UPDATE previews SET applied_at=?,result=? WHERE id=?')
          .run(this.clock().getTime(), JSON.stringify(result), previewId);
        this.db.sql
          .prepare('INSERT INTO audit(actor_id,kind,target_id,created_at) VALUES (?,?,?,?)')
          .run(actorId, operation.kind, result.targetId, this.clock().toISOString());
        const view = claim.view;
        notifyPartner(
          this.db,
          actorId,
          previewId,
          operation.kind,
          result.targetId,
          operation.fields?.title ??
            view.details.find((detail) => detail.label === 'Appointment')?.after ??
            'Shared appointment',
          this.clock().toISOString(),
        );
        return result;
      });
      await this.sync();
      return committed;
    } catch (error) {
      if (error instanceof CalendarOutcomeError || error instanceof CalendarClaimError) throw error;
      this.assertClaim(previewId, claim.leaseUntil!);
      // A definitive precondition rejection on the first attempt proves no write
      // occurred. A prior lost response must never be reclassified this way.
      if (!claim.previouslyAttempted && error instanceof DomainError && error.status === 409) {
        this.db.sql
          .prepare('UPDATE calendar_operations SET attempted=0 WHERE preview_id=?')
          .run(previewId);
        reject('conflicted', error.message);
      }
      if (!attempted)
        throw error instanceof DomainError
          ? error
          : new DomainError(
              'The calendar could not be checked. No write was attempted. Please retry later.',
              503,
            );
      const outcome: CalendarOutcome = {
        status: 'unknown',
        message:
          'The calendar result is unknown. Check this same preview to read its result before making another change. Checking will not send another write.',
      };
      this.recordOutcome(previewId, operation, outcome);
      throw new CalendarOutcomeError(outcome, 503);
    } finally {
      this.db.sql
        .prepare(
          'UPDATE calendar_operations SET lease_until=0 WHERE preview_id=? AND lease_until=?',
        )
        .run(previewId, claim.leaseUntil!);
    }
  }
}
