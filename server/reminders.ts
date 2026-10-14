import { DateTime } from 'luxon';
import webpush from 'web-push';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Household } from './domain.js';
import type { Database } from './database.js';

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
  private sending = false;
  constructor(
    private db: Database,
    private household: Household,
    dataDir: string,
    contact?: string,
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
  plan(now = new Date()) {
    for (const user of this.household.people()) {
      const preferences = this.household.preferences(user.id);
      const local = DateTime.fromJSDate(now, { zone: preferences.timezone });
      const tasks = this.household
        .tasks()
        .filter((task) => task.ownerId === user.id && task.status === 'open');
      for (const task of tasks) {
        if (task.dueAt && Date.parse(task.dueAt) <= now.getTime()) {
          const due = DateTime.fromISO(task.dueAt).setZone(preferences.timezone);
          this.insert(
            `task:${task.id}:${task.dueAt}:${user.id}`,
            user.id,
            task.title,
            `Due ${due.toFormat('d LLL, HH:mm')}${task.missedDates.length ? ` · Missed ${task.missedDates.length} times` : ''}`,
            now,
          );
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
        this.insert(
          `summary:${user.id}:${kind}:${local.toISODate()}`,
          user.id,
          kind === 'morning' ? 'Good morning. Here’s your day.' : 'A little evening check-in.',
          `${today} task${today === 1 ? '' : 's'} due today · ${overdue} overdue. Open your tasks to review what needs attention.`,
          now,
        );
      }
    }
  }
  private insert(id: string, userId: string, title: string, body: string, now: Date) {
    this.db.sql
      .prepare('INSERT OR IGNORE INTO notices(id,user_id,title,body,created_at) VALUES (?,?,?,?,?)')
      .run(id, userId, title, body, now.toISOString());
  }
  async deliver() {
    if (this.sending) return;
    this.sending = true;
    try {
      const notices = this.db.sql
        .prepare("SELECT * FROM notices WHERE delivery='pending' ORDER BY created_at LIMIT 20")
        .all();
      for (const notice of notices) {
        const subscriptions = this.db.sql
          .prepare('SELECT * FROM push_subscriptions WHERE user_id=?')
          .all(notice.user_id);
        if (!subscriptions.length || !this.enabled) {
          this.db.sql.prepare("UPDATE notices SET delivery='inbox' WHERE id=?").run(notice.id);
          continue;
        }
        // Persist each device result so a retry does not resend successful deliveries.
        for (const subscription of subscriptions) {
          const deliveryId = `${notice.id}:${String(subscription.endpoint)}`;
          const sent = this.db.sql
            .prepare('SELECT id FROM push_deliveries WHERE id=?')
            .get(deliveryId);
          if (sent) continue;
          if (Date.now() - Date.parse(String(notice.created_at)) > 7200_000) continue;
          try {
            await webpush.sendNotification(
              JSON.parse(String(subscription.value)),
              JSON.stringify({
                title: notice.title,
                body: notice.body,
                tag: String(notice.id),
                url: '/',
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
        const remaining = this.db.sql
          .prepare('SELECT endpoint FROM push_subscriptions WHERE user_id=?')
          .all(notice.user_id)
          .some(
            (subscription) =>
              !this.db.sql
                .prepare('SELECT id FROM push_deliveries WHERE id=?')
                .get(`${notice.id}:${String(subscription.endpoint)}`),
          );
        if (!remaining || Date.now() - Date.parse(String(notice.created_at)) > 7200_000)
          this.db.sql.prepare("UPDATE notices SET delivery='inbox' WHERE id=?").run(notice.id);
      }
    } finally {
      this.sending = false;
    }
  }
}
