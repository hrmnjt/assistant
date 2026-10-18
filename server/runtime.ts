import type { Models } from '@earendil-works/pi-ai';
import type { ModelRef } from '@earendil-works/pi-durable';
import { migrate, type Store } from './database.js';
import { accountsFrom, Auth, provision } from './auth.js';
import { Household } from './domain.js';
import { CalendarService } from './calendar.js';
import { ICloudTransport, type CalendarTransport } from './caldav.js';
import { Conversations } from './conversations.js';
import { Reminders, type PushSender } from './reminders.js';
import { aiConnection } from './ai.js';
import type { App } from './api.js';

/** Deployment secrets and variables; see `cloudflare/.dev.vars.example`. */
export type Config = Partial<
  Record<
    | 'APP_ORIGIN'
    | 'OWNER_USERNAME'
    | 'OWNER_NAME'
    | 'OWNER_PASSWORD'
    | 'PARTNER_USERNAME'
    | 'PARTNER_NAME'
    | 'PARTNER_PASSWORD'
    | 'ICLOUD_USERNAME'
    | 'ICLOUD_APP_PASSWORD'
    | 'ICLOUD_CALENDAR_NAME'
    | 'ICLOUD_CALENDAR_URL'
    | 'PUSH_CONTACT'
    | 'VAPID_PUBLIC_KEY'
    | 'VAPID_PRIVATE_KEY'
    | 'CHATGPT_MODEL_ID'
    | 'CHATGPT_CREDENTIAL_JSON',
    string
  >
>;
/** Replaceable integrations, for tests and local fixtures. */
export type Overrides = {
  clock?: () => Date;
  transport?: CalendarTransport;
  models?: Models;
  model?: ModelRef;
  send?: PushSender;
};
export type Runtime = App & {
  /** Background work: calendar refresh, reminder planning and delivery. Returns the next wake time. */
  tick(): Promise<number>;
  /** The next time background work is due, for the host's single wakeup. */
  nextWake(): Promise<number>;
  /** Refresh a calendar older than a minute while someone is using the app. */
  refreshIfStale(): Promise<void>;
};

const calendarInterval = 5 * 60_000;
const activeCalendarAge = 60_000;
const assistantRecovery = 30_000;

/** Open the household application on one store; the same code runs in a Durable Object and in tests. */
export async function openHousehold(
  db: Store,
  config: Config,
  overrides: Overrides = {},
): Promise<Runtime> {
  const clock = overrides.clock ?? (() => new Date());
  if (!config.APP_ORIGIN) throw new Error('Configure APP_ORIGIN with the exact app address.');
  const origin = new URL(config.APP_ORIGIN).origin;
  const accounts = accountsFrom(config);
  await migrate(db);
  await provision(db, accounts);
  const household = new Household(db, clock);
  await household.ensureSpaces();
  const transport =
    overrides.transport ??
    (config.ICLOUD_USERNAME && config.ICLOUD_APP_PASSWORD
      ? new ICloudTransport({
          username: config.ICLOUD_USERNAME,
          password: config.ICLOUD_APP_PASSWORD,
          calendarName: config.ICLOUD_CALENDAR_NAME || 'Household',
          calendarUrl: config.ICLOUD_CALENDAR_URL || undefined,
        })
      : undefined);
  const calendar = await new CalendarService(db, transport, clock).load();
  const ai = overrides.models
    ? { models: overrides.models, model: overrides.model }
    : await aiConnection(db, config);
  const conversations = await Conversations.open(db, { ...ai, household, calendar });
  const reminders = new Reminders(
    db,
    household,
    {
      contact: config.PUSH_CONTACT || (origin.startsWith('https:') ? origin : undefined),
      publicKey: config.VAPID_PUBLIC_KEY,
      privateKey: config.VAPID_PRIVATE_KEY,
    },
    () => calendar.snapshot(),
    clock,
    overrides.send,
  );
  const auth = new Auth(db, accounts, origin, () => clock().getTime());
  const syncedAt = () => Date.parse(calendar.snapshot().syncedAt ?? '') || 0;
  const nextWake = async () => {
    const times = [await reminders.nextWake(clock())];
    if (calendar.connected) times.push(syncedAt() + calendarInterval);
    if (await conversations.pending()) times.push(clock().getTime() + assistantRecovery);
    return Math.max(clock().getTime() + 1000, Math.min(...times));
  };
  return {
    db,
    auth,
    household,
    conversations,
    reminders,
    calendar,
    nextWake,
    async tick() {
      if (calendar.connected && clock().getTime() - syncedAt() >= calendarInterval)
        await calendar.sync();
      try {
        await reminders.plan();
        await reminders.deliver();
      } catch {
        console.error('Reminder work failed; it will be retried.');
      }
      return nextWake();
    },
    async refreshIfStale() {
      if (calendar.connected && clock().getTime() - syncedAt() >= activeCalendarAge)
        await calendar.sync();
    },
  };
}
