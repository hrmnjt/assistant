import { DateTime } from 'luxon';
import webpush from 'web-push';
import type { SqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite';
import type { CalendarTransport } from '../server/caldav.js';
import { parseEvents } from '../server/icalendar.js';

export async function probeCalendar(transport: CalendarTransport) {
  const collection = await transport.collection();
  const start = DateTime.utc().startOf('month');
  const resources = await transport.list(start.toISO()!, start.plus({ months: 1 }).toISO()!);
  const count = resources.flatMap((resource) => parseEvents(resource)).length;
  return `Read-only iCloud probe passed: ${collection.name}, ${count} event records this month. No calendar changes made.`;
}

export async function deliverReminder(
  database: SqliteDatabase,
  jobId: string,
  userId: string,
  vapid: { subject: string; publicKey: string; privateKey: string },
) {
  const subscriptions = await database.all<{ endpoint: string; value: string }>(
    'SELECT endpoint,value FROM prototype_subscriptions WHERE user_id=?',
    userId,
  );
  let expired = 0;
  for (const subscription of subscriptions) {
    const id = `${jobId}:${subscription.endpoint}`;
    if (await database.get('SELECT id FROM prototype_deliveries WHERE id=?', id)) continue;
    const details = webpush.generateRequestDetails(
      JSON.parse(subscription.value),
      JSON.stringify({
        title: 'Cloudflare reminder test',
        body: 'This reminder ran from a durable alarm, even with the app closed.',
        tag: jobId,
      }),
      { TTL: 3600, vapidDetails: vapid },
    );
    // Use Workers fetch for delivery; the Node HTTPS client is not required.
    const response = await fetch(details.endpoint, {
      method: details.method,
      headers: details.headers,
      body: details.body ? new Uint8Array(details.body) : undefined,
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
    await response.body?.cancel();
    if (response.status === 404 || response.status === 410) {
      await database.run(
        'DELETE FROM prototype_subscriptions WHERE endpoint=?',
        subscription.endpoint,
      );
      expired++;
      continue;
    }
    if (!response.ok) throw new Error('Push service rejected delivery');
    await database.run('INSERT OR IGNORE INTO prototype_deliveries VALUES (?)', id);
  }
  return subscriptions.length
    ? `Alarm fired; ${subscriptions.length - expired} device deliveries accepted by the push service; ${expired} expired subscriptions removed. Check device display separately.`
    : 'Alarm fired and persisted this reminder. Subscribe this account to test phone push.';
}
