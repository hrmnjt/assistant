import webpush from 'web-push';
import type { Executor, Row, Store } from './database.js';
import type { NoticeStatus, Plugin } from './plugin.js';

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

export type PushConfig = { publicKey?: string; privateKey?: string };
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

/**
 * The household's Updates and phone push. Plugins plan notices (task
 * deadlines, appointment reminders, summaries); the core stores them, delivers
 * each one once per device, retries transient failures until its push
 * deadline, and asks the owning plugin whether a pending notice still applies.
 */
export class Notices {
  readonly publicKey: string | null;
  readonly enabled: boolean;
  private sending?: Promise<void>;
  private plugins: readonly Plugin[] = [];
  constructor(
    private db: Store,
    private push: PushConfig = {},
    private clock: () => Date = () => new Date(),
    private send: PushSender = sendPush,
  ) {
    this.publicKey = push.publicKey || null;
    // Keep the VAPID pair stable: a new pair invalidates every phone's subscription.
    this.enabled = Boolean(push.publicKey && push.privateKey);
  }
  /**
   * Push services' contact for this app: its own address, recorded when a phone subscribes,
   * so neither person's email goes to Apple or Google.
   */
  private async contact() {
    const row = await this.db.get<Row>("SELECT value FROM settings WHERE key='origin'");
    const origin = row ? String(JSON.parse(String(row.value))) : '';
    return origin.startsWith('https://') ? origin : 'mailto:assistant@localhost';
  }
  /** The plugins whose notices this delivers; partner-change notices are the core's own. */
  use(plugins: readonly Plugin[]) {
    this.plugins = plugins;
  }
  /** Plan a notice once; a repeated id keeps the first. */
  async insert(
    q: Executor,
    notice: { id: string; userId: string; title: string; body: string; at: Date; pushUntil: Date },
  ) {
    await q.run(
      'INSERT OR IGNORE INTO notices(id,user_id,title,body,created_at,push_until) VALUES (?,?,?,?,?,?)',
      notice.id,
      notice.userId,
      notice.title,
      notice.body,
      notice.at.toISOString(),
      notice.pushUntil.toISOString(),
    );
  }
  private async status(notice: Row): Promise<NoticeStatus> {
    const id = String(notice.id);
    const owner = this.plugins.find((plugin) =>
      plugin.notices?.prefixes.some((prefix) => id.startsWith(prefix)),
    );
    return owner ? owner.notices!.status(notice) : 'send';
  }
  /** Whether a phone push is no longer useful; the inbox record is kept either way. */
  private pushExpired(notice: Record<string, unknown>) {
    // Fails closed for a missing or malformed deadline.
    return !(this.clock().getTime() <= Date.parse(String(notice.push_until)));
  }
  private async defer(noticeId: string, failure: string) {
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
    // Round-robin recipient/kind lanes (a notice id's prefix names its kind). One
    // broken integration or device must not monopolize all twenty slots.
    const notices = await this.db.all<Row>(
      `
      SELECT * FROM (
        SELECT n.*,ROW_NUMBER() OVER (PARTITION BY n.user_id,substr(n.id,1,instr(n.id,':'))
          ORDER BY n.created_at,n.rowid) AS lane_position
        FROM notices n LEFT JOIN notice_retries r ON r.notice_id=n.id
        WHERE n.delivery='pending' AND COALESCE(r.next_attempt_at,0)<=?
      ) ORDER BY lane_position,created_at,id LIMIT 20
    `,
      now,
    );
    for (const notice of notices) {
      const status = await this.status(notice);
      if (status === 'inbox') {
        await inbox(notice.id);
        continue;
      }
      if (status !== 'send') {
        await this.defer(String(notice.id), status.defer);
        continue;
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
        // Recheck after each awaited device delivery: the record can change while
        // the previous device's push request is in flight.
        if ((await this.status(notice)) === 'inbox') {
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
              subject: await this.contact(),
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
  /** The next pending delivery or retry; plugins add their own planned times. */
  async nextWake(now = this.clock()): Promise<number | null> {
    const pending = await this.db.get<{ at: number | null }>(
      `SELECT MIN(COALESCE(r.next_attempt_at,0)) AS at FROM notices n
      LEFT JOIN notice_retries r ON r.notice_id=n.id WHERE n.delivery='pending'`,
    );
    return pending?.at === null || pending?.at === undefined
      ? null
      : Math.max(now.getTime(), Number(pending.at));
  }
}
