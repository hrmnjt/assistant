import { DateTime } from 'luxon';
import webpush from 'web-push';
import { DomainError, type Household } from './domain.js';
import type { Executor, Row, Store } from './database.js';
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

export type PushConfig = { contact?: string; publicKey?: string; privateKey?: string };
export type PushSubscription = webpush.PushSubscription;
/** Sends one encrypted Web Push request and returns the push service's HTTP status. */
export type PushSender = (
  subscription: PushSubscription,
  payload: string,
  vapid: { subject: string; publicKey: string; privateKey: string },
) => Promise<number>;

/** Web Push over `fetch`, so delivery works in Workers without Node's HTTPS client. */
export const sendPush: PushSender = async (subscription, payload, vapid) => {
  const details = webpush.generateRequestDetails(subscription, payload, {
    TTL: 3600,
    vapidDetails: vapid,
  });
  const response = await fetch(details.endpoint, {
    method: details.method,
    headers: details.headers,
    body: details.body ? new Uint8Array(details.body) : undefined,
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
  });
  await response.body?.cancel();
  return response.status;
};

export class Reminders {
  readonly publicKey: string | null;
  readonly enabled: boolean;
  private sending?: Promise<void>;
  constructor(
    private db: Store,
    private household: Household,
    private push: PushConfig = {},
    private calendar?: () => CalendarSnapshot,
    private clock: () => Date = () => new Date(),
    private send: PushSender = sendPush,
  ) {
    this.publicKey = push.publicKey || null;
    // Keep the VAPID pair stable: a new pair invalidates every phone's subscription.
    this.enabled = Boolean(push.contact && push.publicKey && push.privateKey);
  }
  async plan(now = this.clock()) {
    const calendar = this.calendar?.();
    const openTasks = (await this.household.tasks()).filter((task) => task.status === 'open');
    for (const user of await this.household.people()) {
      const preferences = await this.household.preferences(user.id);
      const local = DateTime.fromJSDate(now, { zone: preferences.timezone });
      const tasks = openTasks.filter((task) => task.ownerId === user.id);
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
            await this.insert(
              this.db,
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
          await this.db.transaction(async (tx) => {
            const noticeId = `task:${task.id}:${task.dueAt}:${user.id}`;
            await this.insert(
              tx,
              noticeId,
              user.id,
              task.title,
              `Due ${due.toFormat('d LLL, HH:mm')}${task.missedDates.length ? ` · Missed ${task.missedDates.length} times` : ''}`,
              now,
              // An overdue task stays in Updates, but is pushed only near its original deadline.
              due.plus({ hours: 2 }).toJSDate(),
            );
            await tx.run(
              'INSERT OR IGNORE INTO task_notice_deadlines VALUES (?,?,?,?)',
              noticeId,
              task.id,
              task.dueAt,
              user.id,
            );
            await tx.run(
              "INSERT OR IGNORE INTO notice_targets VALUES (?,'task',?)",
              noticeId,
              task.id,
            );
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
        await this.insert(
          this.db,
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
  private async insert(
    q: Executor,
    id: string,
    userId: string,
    title: string,
    body: string,
    now: Date,
    pushUntil: Date,
  ) {
    await q.run(
      'INSERT OR IGNORE INTO notices(id,user_id,title,body,created_at,push_until) VALUES (?,?,?,?,?,?)',
      id,
      userId,
      title,
      body,
      now.toISOString(),
      pushUntil.toISOString(),
    );
  }
  /** Whether a phone push is no longer useful; the inbox record is kept either way. */
  private pushExpired(notice: Record<string, unknown>) {
    // Fails closed for a missing or malformed deadline.
    return !(this.clock().getTime() <= Date.parse(String(notice.push_until)));
  }
  private async taskDeadlineCurrent(noticeId: string, recipientId: string) {
    const deadline = await this.db.get<Row>(
      'SELECT * FROM task_notice_deadlines WHERE notice_id=?',
      noticeId,
    );
    // Legacy notices lack reliable occurrence metadata: retain the inbox record,
    // but fail closed instead of guessing a task/deadline by parsing its label.
    if (!deadline || deadline.owner_id !== recipientId) return false;
    try {
      const task = await this.household.task(String(deadline.task_id));
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
  private async defer(noticeId: string, failure: 'calendar-unavailable' | 'push-transient') {
    const previous = await this.db.get<Row>(
      'SELECT attempts FROM notice_retries WHERE notice_id=?',
      noticeId,
    );
    const attempts = Math.min(16, Number(previous?.attempts ?? 0) + 1);
    const delay = Math.min(900_000, 60_000 * 2 ** Math.min(attempts - 1, 4));
    await this.db.run(
      `INSERT INTO notice_retries VALUES (?,?,?,?)
      ON CONFLICT(notice_id) DO UPDATE SET next_attempt_at=excluded.next_attempt_at,attempts=excluded.attempts,failure=excluded.failure`,
      noticeId,
      this.clock().getTime() + delay,
      attempts,
      failure,
    );
  }
  async deliver() {
    if (this.sending) return;
    this.sending = this.deliveryPass().finally(() => {
      this.sending = undefined;
    });
    await this.sending;
  }
  private async deliveryPass() {
    const now = this.clock().getTime();
    const inbox = (id: unknown) =>
      this.db.run("UPDATE notices SET delivery='inbox' WHERE id=?", String(id));
    // Retire expired push work before any dependency check, across the whole
    // queue rather than just the first batch. Keep its historical inbox row.
    await this.db.run(
      "UPDATE notices SET delivery='inbox' WHERE delivery='pending' AND push_until<?",
      new Date(now).toISOString(),
    );
    // Round-robin recipient/kind lanes. One broken integration or device must
    // not monopolize all twenty slots while unrelated work is ready.
    const notices = await this.db.all<Row>(
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
      now,
    );
    for (const notice of notices) {
      const taskDeadline = String(notice.id).startsWith('task:');
      if (
        taskDeadline &&
        !(await this.taskDeadlineCurrent(String(notice.id), String(notice.user_id)))
      ) {
        await inbox(notice.id);
        continue;
      }
      if (String(notice.id).startsWith('appointment:')) {
        const calendar = this.calendar?.();
        if (calendar?.status !== 'connected') {
          await this.defer(String(notice.id), 'calendar-unavailable');
          continue;
        }
        if (
          !calendar.events.some(
            (event) => this.appointmentId(event, String(notice.user_id)) === notice.id,
          )
        ) {
          await inbox(notice.id);
          continue;
        }
      }
      const subscriptions = await this.db.all<Row>(
        'SELECT * FROM push_subscriptions WHERE user_id=?',
        String(notice.user_id),
      );
      if (!subscriptions.length || !this.enabled) {
        await inbox(notice.id);
        continue;
      }
      // Persist each device result so a retry does not resend successful deliveries.
      let obsolete = false;
      for (const subscription of subscriptions) {
        // Recheck after each awaited device delivery: the task can change while
        // the previous device's push request is in flight.
        if (
          taskDeadline &&
          !(await this.taskDeadlineCurrent(String(notice.id), String(notice.user_id)))
        ) {
          await inbox(notice.id);
          obsolete = true;
          break;
        }
        const deliveryId = `${notice.id}:${String(subscription.endpoint)}`;
        if (await this.db.get('SELECT id FROM push_deliveries WHERE id=?', deliveryId)) continue;
        if (this.pushExpired(notice)) continue;
        try {
          const status = await this.send(
            JSON.parse(String(subscription.value)),
            JSON.stringify({
              title: notice.title,
              body: notice.body,
              tag: String(notice.id),
              url: '/?updates=1',
            }),
            {
              subject: this.push.contact!,
              publicKey: this.push.publicKey!,
              privateKey: this.push.privateKey!,
            },
          );
          // The device unsubscribed or the subscription expired: stop sending to it.
          if (status === 404 || status === 410)
            await this.db.run(
              'DELETE FROM push_subscriptions WHERE endpoint=?',
              String(subscription.endpoint),
            );
          else if (status >= 200 && status < 300)
            await this.db.run('INSERT OR IGNORE INTO push_deliveries VALUES (?)', deliveryId);
        } catch {
          // A network failure leaves this device pending for a bounded retry.
        }
      }
      if (obsolete) continue;
      let remaining = false;
      for (const subscription of await this.db.all<Row>(
        'SELECT endpoint FROM push_subscriptions WHERE user_id=?',
        String(notice.user_id),
      ))
        if (
          !(await this.db.get(
            'SELECT id FROM push_deliveries WHERE id=?',
            `${notice.id}:${String(subscription.endpoint)}`,
          ))
        )
          remaining = true;
      if (!remaining || this.pushExpired(notice)) await inbox(notice.id);
      else await this.defer(String(notice.id), 'push-transient');
    }
  }
  /**
   * The next time planning or delivery has work: a retry, a deadline, a summary,
   * or an appointment reminder. Hosts without timers wake no later than this.
   */
  async nextWake(now = this.clock()): Promise<number> {
    const at = now.getTime();
    const times = [at + 15 * 60_000];
    const pending = await this.db.get<{ at: number | null }>(
      `SELECT MIN(COALESCE(r.next_attempt_at,0)) AS at FROM notices n
      LEFT JOIN notice_retries r ON r.notice_id=n.id WHERE n.delivery='pending'`,
    );
    if (pending?.at !== null && pending?.at !== undefined) times.push(Number(pending.at));
    for (const task of await this.household.tasks())
      if (task.status === 'open' && task.dueAt && Date.parse(task.dueAt) > at)
        times.push(Date.parse(task.dueAt));
    for (const user of await this.household.people()) {
      const preferences = await this.household.preferences(user.id);
      const local = DateTime.fromJSDate(now, { zone: preferences.timezone });
      for (const kind of ['morning', 'evening'] as const) {
        const setting = preferences[kind];
        if (!setting.enabled) continue;
        const [hour, minute] = setting.time.split(':').map(Number);
        let scheduled = local.set({ hour, minute, second: 0, millisecond: 0 });
        if (scheduled.toMillis() <= at) scheduled = scheduled.plus({ days: 1 });
        times.push(scheduled.toMillis());
      }
    }
    const calendar = this.calendar?.();
    if (calendar?.status === 'connected')
      for (const event of calendar.events) {
        if (event.reminderMinutes === null) continue;
        const trigger = Date.parse(event.start) - event.reminderMinutes * 60_000;
        if (trigger > at) times.push(trigger);
      }
    return Math.max(at, Math.min(...times));
  }
}
