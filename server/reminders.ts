import { DateTime } from 'luxon';
import webpush from 'web-push';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DomainError, type Household } from './domain.js';
import type { Database } from './database.js';
import type { CalendarSnapshot, CalendarEvent } from '../src/types.js';

export function validPushEndpoint(endpoint: string) {
  try {
    const url = new URL(endpoint);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      ['fcm.googleapis.com', 'push.apple.com', 'push.services.mozilla.com'].some(
        (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
      )
    );
  } catch {
    return false;
  }
}

export class Reminders {
  readonly publicKey: string;
  readonly enabled: boolean;
  private sending?: Promise<void>;
  constructor(
    private db: Database,
    private household: Household,
    dataDir: string,
    contact?: string,
    private calendar?: () => CalendarSnapshot,
    private clock: () => Date = () => new Date(),
  ) {
    const path = resolve(dataDir, 'push-keys.json');
    const keys = existsSync(path)
      ? JSON.parse(readFileSync(path, 'utf8'))
      : webpush.generateVAPIDKeys();
    if (!existsSync(path)) writeFileSync(path, JSON.stringify(keys), { mode: 0o600, flag: 'wx' });
    this.publicKey = keys.publicKey;
    this.enabled = Boolean(contact);
    if (contact) webpush.setVapidDetails(contact, keys.publicKey, keys.privateKey);
  }
  plan(now = this.clock()) {
    const calendar = this.calendar?.();
    for (const user of this.household.people()) {
      const preferences = this.household.preferences(user.id);
      const local = DateTime.fromJSDate(now, { zone: preferences.timezone });
      const tasks = this.household
        .tasks()
        .filter((task) => task.ownerId === user.id && task.status === 'open');
      if (calendar?.status === 'connected') {
        for (const event of calendar.events) {
          if (event.reminderMinutes === null) continue;
          const start = DateTime.fromISO(event.start, { zone: preferences.timezone });
          const end = DateTime.fromISO(event.end, { zone: preferences.timezone });
          const trigger = start.minus({ minutes: event.reminderMinutes });
          if (
            DateTime.fromJSDate(now) >= trigger &&
            DateTime.fromJSDate(now).diff(trigger, 'hours').hours <= 2 &&
            DateTime.fromJSDate(now) < end
          ) {
            this.insert(
              this.appointmentId(event, user.id),
              user.id,
              event.title,
              `${start <= DateTime.fromJSDate(now) ? 'Started' : 'Starts'} ${start.setZone(preferences.timezone).toFormat('d LLL, HH:mm')}${event.location ? ` · ${event.location}` : ''}`,
              now,
              DateTime.min(trigger.plus({ hours: 2 }), end)!.toJSDate(),
            );
          }
        }
      }
      for (const task of tasks) {
        if (task.dueAt && Date.parse(task.dueAt) <= now.getTime()) {
          const due = DateTime.fromISO(task.dueAt).setZone(preferences.timezone);
          this.db.transaction(() => {
            const noticeId = `task:${task.id}:${task.dueAt}:${user.id}`;
            this.insert(
              noticeId,
              user.id,
              task.title,
              `Due ${due.toFormat('d LLL, HH:mm')}${task.missedDates.length ? ` · Missed ${task.missedDates.length} times` : ''}`,
              now,
              // An overdue task stays in Updates, but is pushed only near its original deadline.
              due.plus({ hours: 2 }).toJSDate(),
            );
            this.db.sql
              .prepare('INSERT OR IGNORE INTO task_notice_deadlines VALUES (?,?,?,?)')
              .run(noticeId, task.id, task.dueAt, user.id);
            this.db.sql
              .prepare("INSERT OR IGNORE INTO notice_targets VALUES (?,'task',?)")
              .run(noticeId, task.id);
          });
        }
      }
      for (const kind of ['morning', 'evening'] as const) {
        const setting = preferences[kind];
        if (!setting.enabled) continue;
        const [hour, minute] = setting.time.split(':').map(Number);
        const scheduled = local.set({ hour, minute, second: 0, millisecond: 0 });
        // A restart catches up a summary within two hours; older summaries are skipped.
        const age = local.diff(scheduled, 'minutes').minutes;
        if (age < 0 || age > 120) continue;
        const overdue = tasks.filter(
          (task) => task.dueAt && Date.parse(task.dueAt) < now.getTime(),
        ).length;
        const today = tasks.filter(
          (task) =>
            task.dueAt &&
            DateTime.fromISO(task.dueAt).setZone(preferences.timezone).hasSame(local, 'day'),
        ).length;
        const agendaDay = kind === 'morning' ? local : local.plus({ days: 1 });
        const appointments =
          calendar?.status === 'connected'
            ? calendar.events.filter((event) =>
                DateTime.fromISO(event.start, { zone: preferences.timezone })
                  .setZone(preferences.timezone)
                  .hasSame(agendaDay, 'day'),
              ).length
            : null;
        this.insert(
          `summary:${user.id}:${kind}:${local.toISODate()}`,
          user.id,
          kind === 'morning' ? 'Good morning. Here’s your day.' : 'A little evening check-in.',
          `${appointments === null ? '' : `${appointments} appointment${appointments === 1 ? '' : 's'} ${kind === 'morning' ? 'today' : 'tomorrow'} · `}${today} task${today === 1 ? '' : 's'} due today · ${overdue} overdue. Open your tasks to review what needs attention.`,
          now,
          scheduled.plus({ hours: 2 }).toJSDate(),
        );
      }
    }
  }
  private appointmentId(event: CalendarEvent, userId: string) {
    return `appointment:${event.id}:${event.start}:${event.reminderMinutes}:${userId}`;
  }
  private insert(
    id: string,
    userId: string,
    title: string,
    body: string,
    now: Date,
    pushUntil: Date,
  ) {
    this.db.sql
      .prepare(
        'INSERT OR IGNORE INTO notices(id,user_id,title,body,created_at,push_until) VALUES (?,?,?,?,?,?)',
      )
      .run(id, userId, title, body, now.toISOString(), pushUntil.toISOString());
  }
  /** Whether a phone push is no longer useful; the inbox record is kept either way. */
  private pushExpired(notice: Record<string, unknown>) {
    // Fails closed for a missing or malformed deadline.
    return !(this.clock().getTime() <= Date.parse(String(notice.push_until)));
  }
  private taskDeadlineCurrent(noticeId: string, recipientId: string) {
    const deadline = this.db.sql
      .prepare('SELECT * FROM task_notice_deadlines WHERE notice_id=?')
      .get(noticeId);
    // Legacy notices lack reliable occurrence metadata: retain the inbox record,
    // but fail closed instead of guessing a task/deadline by parsing its label.
    if (!deadline || deadline.owner_id !== recipientId) return false;
    try {
      const task = this.household.task(String(deadline.task_id));
      return (
        task.status === 'open' &&
        task.ownerId === recipientId &&
        task.dueAt === deadline.due_at &&
        Date.parse(task.dueAt!) <= this.clock().getTime()
      );
    } catch (error) {
      if (error instanceof DomainError && error.status === 404) return false;
      throw error;
    }
  }
  private defer(noticeId: string, failure: 'calendar-unavailable' | 'push-transient') {
    const previous = this.db.sql
      .prepare('SELECT attempts FROM notice_retries WHERE notice_id=?')
      .get(noticeId);
    const attempts = Math.min(16, Number(previous?.attempts ?? 0) + 1);
    const delay = Math.min(900_000, 60_000 * 2 ** Math.min(attempts - 1, 4));
    this.db.sql
      .prepare(
        `INSERT INTO notice_retries VALUES (?,?,?,?)
      ON CONFLICT(notice_id) DO UPDATE SET next_attempt_at=excluded.next_attempt_at,attempts=excluded.attempts,failure=excluded.failure`,
      )
      .run(noticeId, this.clock().getTime() + delay, attempts, failure);
  }
  async deliver() {
    if (this.sending) return;
    this.sending = this.send().finally(() => {
      this.sending = undefined;
    });
    await this.sending;
  }
  /** Settles when an in-progress delivery pass has finished. */
  async idle() {
    await this.sending?.catch(() => undefined);
  }
  private async send() {
    const now = this.clock().getTime();
    // Retire expired push work before any dependency check, across the whole
    // queue rather than just the first batch. Keep its historical inbox row.
    this.db.sql
      .prepare("UPDATE notices SET delivery='inbox' WHERE delivery='pending' AND push_until<?")
      .run(new Date(now).toISOString());
    // Round-robin recipient/kind lanes. One broken integration or device must
    // not monopolize all twenty slots while unrelated work is ready.
    const notices = this.db.sql
      .prepare(
        `
      SELECT * FROM (
        SELECT n.*,ROW_NUMBER() OVER (PARTITION BY n.user_id,
          CASE WHEN n.id LIKE 'appointment:%' THEN 'appointment'
            WHEN n.id LIKE 'task:%' THEN 'task'
            WHEN n.id LIKE 'summary:%' THEN 'summary'
            WHEN n.id LIKE 'change:%' THEN 'change' ELSE 'other' END
          ORDER BY n.created_at,n.rowid) AS lane_position
        FROM notices n LEFT JOIN notice_retries r ON r.notice_id=n.id
        WHERE n.delivery='pending' AND COALESCE(r.next_attempt_at,0)<=?
      ) ORDER BY lane_position,created_at,id LIMIT 20
    `,
      )
      .all(now);
    for (const notice of notices) {
      const taskDeadline = String(notice.id).startsWith('task:');
      if (taskDeadline && !this.taskDeadlineCurrent(String(notice.id), String(notice.user_id))) {
        this.db.sql.prepare("UPDATE notices SET delivery='inbox' WHERE id=?").run(notice.id);
        continue;
      }
      if (String(notice.id).startsWith('appointment:')) {
        const calendar = this.calendar?.();
        if (calendar?.status !== 'connected') {
          this.defer(String(notice.id), 'calendar-unavailable');
          continue;
        }
        if (
          !calendar.events.some(
            (event) => this.appointmentId(event, String(notice.user_id)) === notice.id,
          )
        ) {
          this.db.sql.prepare("UPDATE notices SET delivery='inbox' WHERE id=?").run(notice.id);
          continue;
        }
      }
      const subscriptions = this.db.sql
        .prepare('SELECT * FROM push_subscriptions WHERE user_id=?')
        .all(notice.user_id);
      if (!subscriptions.length || !this.enabled) {
        this.db.sql.prepare("UPDATE notices SET delivery='inbox' WHERE id=?").run(notice.id);
        continue;
      }
      // Persist each device result so a retry does not resend successful deliveries.
      let obsolete = false;
      for (const subscription of subscriptions) {
        // Recheck after each awaited device delivery: the task can change while
        // the previous device's push request is in flight.
        if (taskDeadline && !this.taskDeadlineCurrent(String(notice.id), String(notice.user_id))) {
          this.db.sql.prepare("UPDATE notices SET delivery='inbox' WHERE id=?").run(notice.id);
          obsolete = true;
          break;
        }
        const deliveryId = `${notice.id}:${String(subscription.endpoint)}`;
        const sent = this.db.sql
          .prepare('SELECT id FROM push_deliveries WHERE id=?')
          .get(deliveryId);
        if (sent) continue;
        if (this.pushExpired(notice)) continue;
        try {
          await webpush.sendNotification(
            JSON.parse(String(subscription.value)),
            JSON.stringify({
              title: notice.title,
              body: notice.body,
              tag: String(notice.id),
              url: '/?updates=1',
            }),
            { TTL: 3600, timeout: 10_000 },
          );
          this.db.sql.prepare('INSERT OR IGNORE INTO push_deliveries VALUES (?)').run(deliveryId);
        } catch (error) {
          if (
            typeof error === 'object' &&
            error &&
            'statusCode' in error &&
            [404, 410].includes(Number(error.statusCode))
          ) {
            this.db.sql
              .prepare('DELETE FROM push_subscriptions WHERE endpoint=?')
              .run(subscription.endpoint);
          }
        }
      }
      if (obsolete) continue;
      const remaining = this.db.sql
        .prepare('SELECT endpoint FROM push_subscriptions WHERE user_id=?')
        .all(notice.user_id)
        .some(
          (subscription) =>
            !this.db.sql
              .prepare('SELECT id FROM push_deliveries WHERE id=?')
              .get(`${notice.id}:${String(subscription.endpoint)}`),
        );
      if (!remaining || this.pushExpired(notice))
        this.db.sql.prepare("UPDATE notices SET delivery='inbox' WHERE id=?").run(notice.id);
      else this.defer(String(notice.id), 'push-transient');
    }
  }
}
