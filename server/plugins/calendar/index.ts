import { DateTime } from 'luxon';
import { z } from 'zod';
import { defineExtension, section } from '@earendil-works/pi-durable';
import type { Row } from '../../database.js';
import { DomainError } from '../../errors.js';
import { body, json } from '../../http.js';
import type { ChangeOwner, NoticeStatus, Plugin, PluginHost } from '../../plugin.js';
import type { CalendarEvent } from '../../../src/types.js';
import { iCloud, type CalendarAccount, type CalendarConnector } from './caldav.js';
import { calendarMutationSchema, type CalendarService } from './service.js';

/** The parts of the calendar service the plugin uses; tests can supply a stand-in. */
export type CalendarSource = Pick<
  CalendarService,
  'connected' | 'connect' | 'snapshot' | 'sync' | 'preview' | 'confirm' | 'cancel' | 'dismiss'
>;
/** The saved iCloud connection, kept in the app's settings and never sent to the people's app. */
export type CalendarConnection = CalendarAccount & { calendarUrl: string; calendarName: string };

const connectionInput = z
  .object({
    username: z.string().trim().min(3, 'Enter the Apple ID.').max(200),
    password: z.string().trim().min(8, 'Enter an app-specific password.').max(200),
    calendarUrl: z.string().url().optional(),
  })
  .strict();

const syncInterval = 5 * 60_000;
const activeAge = 60_000;

/**
 * The shared iCloud calendar: the household's agenda, confirmed appointment
 * changes against the original records, and appointment reminders for both
 * people. iCloud stays authoritative; this keeps a refreshed cache.
 */
export class CalendarPlugin implements Plugin {
  readonly id = 'calendar';
  readonly changes: ChangeOwner;
  readonly extension;
  readonly notices = {
    prefixes: ['appointment:'],
    status: async (notice: Row): Promise<NoticeStatus> => {
      const calendar = this.service.snapshot();
      if (calendar.status !== 'connected') return { defer: 'calendar-unavailable' };
      return calendar.events.some(
        (event) => this.appointmentId(event, String(notice.user_id)) === notice.id,
      )
        ? 'send'
        : 'inbox';
    },
  };
  readonly routes = [
    {
      method: 'POST',
      path: /^\/api\/calendar\/refresh$/,
      handle: async () => {
        if (!this.service.connected)
          throw new DomainError('The shared calendar is not connected yet.', 503);
        await this.service.sync();
        return json(this.service.snapshot());
      },
    },
  ];
  /** The admin connects the shared calendar: an Apple ID and app-specific password, then one of its calendars. */
  readonly admin = {
    routes: [
      {
        // Without a calendar: the account's calendars to choose from. With one: connect it.
        method: 'POST',
        path: /^\/api\/admin\/calendar$/,
        handle: async (request: Request) => {
          const { calendarUrl, ...account } = connectionInput.parse(await body(request));
          const calendars = await this.connector.calendars(account).catch(() => {
            throw new DomainError(
              'iCloud did not accept that Apple ID and app-specific password, or could not be reached. Check them and try again.',
            );
          });
          if (!calendarUrl) return json({ calendars });
          const chosen = calendars.find((calendar) => calendar.url === calendarUrl);
          if (!chosen) throw new DomainError('Choose one of the listed calendars.');
          const connection: CalendarConnection = {
            ...account,
            calendarUrl,
            calendarName: chosen.name,
          };
          await this.host.settings.set('icloud', connection);
          await this.service.connect(this.connector.open(connection));
          return json(this.service.snapshot());
        },
      },
      {
        method: 'DELETE',
        path: /^\/api\/admin\/calendar$/,
        handle: async () => {
          await this.host.settings.delete('icloud');
          await this.service.connect(undefined);
          return json({ ok: true });
        },
      },
    ],
    // Which Apple ID and calendar; the password never leaves the server.
    state: async () => {
      const connection = await this.host.settings.get<CalendarConnection>('icloud');
      const calendar = this.service.snapshot();
      return {
        calendar: {
          status: calendar.status,
          name: connection?.calendarName ?? null,
          account: connection?.username ?? null,
          error: calendar.error,
        },
      };
    },
  };
  constructor(
    private host: PluginHost,
    readonly service: CalendarSource,
    private connector: CalendarConnector = iCloud,
  ) {
    this.changes = {
      kinds: ['calendar.create', 'calendar.update', 'calendar.delete'],
      schema: calendarMutationSchema,
      preview: (actorId, input) => service.preview(actorId, input),
      confirm: (actorId, previewId) => service.confirm(actorId, previewId),
      cancel: (actorId, previewId) => service.cancel(actorId, previewId),
      dismiss: (actorId, previewId) => service.dismiss(actorId, previewId),
    };
    const kit = host.assistant;
    this.extension = defineExtension({
      name: 'calendar',
      tools: [
        kit.read(
          'read_calendar',
          'Read the shared calendar: its status, when it last synced, and events with IDs and ETags.',
          async () => this.service.snapshot(),
        ),
        kit.prepare(
          'prepare_calendar_change',
          'Prepare creating, updating or deleting one appointment in the shared calendar.',
          this.changes,
        ),
      ],
      sections: [
        section(
          'calendar',
          () =>
            `Shared calendar: read it with read_calendar before preparing a change with prepare_calendar_change. All-day calendar end dates are exclusive. Recurring appointments and invitations are read-only here; use Apple Calendar to edit them. If the calendar is stale or disconnected, state that when answering calendar questions.`,
          { tag: false },
        ),
      ],
    });
  }
  async snapshot() {
    const calendar = this.service.snapshot();
    return { calendar, integrations: { calendar: calendar.status } };
  }
  /** The saved connection, opened at startup. */
  static async saved(settings: PluginHost['settings'], connector: CalendarConnector = iCloud) {
    const connection = await settings.get<CalendarConnection>('icloud');
    return connection ? connector.open(connection) : undefined;
  }
  private syncedAt() {
    return Date.parse(this.service.snapshot().syncedAt ?? '') || 0;
  }
  /** Refresh every five minutes, then plan reminders for appointments now due. */
  async tick(now: Date) {
    if (this.service.connected && now.getTime() - this.syncedAt() >= syncInterval)
      await this.service.sync();
    await this.planReminders(now);
  }
  /** Each person's reminder for an appointment whose trigger has passed, within two hours. */
  async planReminders(now: Date) {
    const calendar = this.service.snapshot();
    if (calendar.status !== 'connected') return;
    const at = DateTime.fromJSDate(now);
    for (const user of await this.host.household.people()) {
      const { timezone } = await this.host.household.preferences(user.id);
      for (const event of calendar.events) {
        if (event.reminderMinutes === null) continue;
        const start = DateTime.fromISO(event.start, { zone: timezone });
        const end = DateTime.fromISO(event.end, { zone: timezone });
        const trigger = start.minus({ minutes: event.reminderMinutes });
        if (at < trigger || at.diff(trigger, 'hours').hours > 2 || at >= end) continue;
        await this.host.notices.insert(this.host.db, {
          id: this.appointmentId(event, user.id),
          userId: user.id,
          title: event.title,
          body: `${start <= at ? 'Started' : 'Starts'} ${start.setZone(timezone).toFormat('d LLL, HH:mm')}${event.location ? ` · ${event.location}` : ''}`,
          at: now,
          pushUntil: DateTime.min(trigger.plus({ hours: 2 }), end)!.toJSDate(),
        });
      }
    }
  }
  /** While someone is using the app, keep the agenda within a minute of iCloud. */
  async refreshIfStale(now: Date) {
    if (this.service.connected && now.getTime() - this.syncedAt() >= activeAge)
      await this.service.sync();
  }
  async nextWake(now: Date) {
    const times: number[] = [];
    if (this.service.connected) times.push(this.syncedAt() + syncInterval);
    const calendar = this.service.snapshot();
    if (calendar.status === 'connected')
      for (const event of calendar.events) {
        if (event.reminderMinutes === null) continue;
        const trigger = Date.parse(event.start) - event.reminderMinutes * 60_000;
        if (trigger > now.getTime()) times.push(trigger);
      }
    return times.length ? Math.min(...times) : null;
  }
  private appointmentId(event: CalendarEvent, userId: string) {
    return `appointment:${event.id}:${event.start}:${event.reminderMinutes}:${userId}`;
  }
}
