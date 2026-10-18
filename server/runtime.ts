import type { Models } from '@earendil-works/pi-ai';
import type { ModelRef } from '@earendil-works/pi-durable';
import type { JWTVerifyGetKey } from 'jose';
import { migrate, type Store } from './database.js';
import { accountsFrom, Auth, provision } from './auth.js';
import { Household } from './household.js';
import { Conversations } from './conversations.js';
import { Notices, type PushSender } from './notices.js';
import { AssistantKit, coreExtension } from './assistant-tools.js';
import { aiConnection } from './ai.js';
import type { Plugin, PluginHost } from './plugin.js';
import { CalendarPlugin } from './plugins/calendar/index.js';
import { CalendarService } from './plugins/calendar/service.js';
import { ICloudTransport, type CalendarTransport } from './plugins/calendar/caldav.js';
import { TasksPlugin } from './plugins/tasks.js';
import { DashboardPlugin } from './plugins/dashboard.js';
import type { App } from './api.js';

/** Deployment secrets and variables; see `cloudflare/.dev.vars.example`. */
export type Config = Partial<
  Record<
    | 'ACCESS_TEAM_DOMAIN'
    | 'ACCESS_AUD'
    | 'OWNER_NAME'
    | 'OWNER_EMAIL'
    | 'PARTNER_NAME'
    | 'PARTNER_EMAIL'
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
  /** Access signing keys, instead of the team's published certificates. */
  accessKeys?: JWTVerifyGetKey;
};
export type Runtime = App & {
  /** Background work: each plugin's refreshes and planned notices, then delivery. Returns the next wake time. */
  tick(): Promise<number>;
  /** The next time background work is due, for the host's single wakeup. */
  nextWake(): Promise<number>;
  /** Refresh a calendar older than a minute while someone is using the app. */
  refreshIfStale(): Promise<void>;
};

const fallbackWake = 15 * 60_000;
const assistantRecovery = 30_000;

/** Open the household application on one store; the same code runs in a Durable Object and in tests. */
export async function openHousehold(
  db: Store,
  config: Config,
  overrides: Overrides = {},
): Promise<Runtime> {
  const clock = overrides.clock ?? (() => new Date());
  // Cloudflare Access settings make this a deployment; without them it is a local development server.
  if (Boolean(config.ACCESS_TEAM_DOMAIN) !== Boolean(config.ACCESS_AUD))
    throw new Error('Configure both ACCESS_TEAM_DOMAIN and ACCESS_AUD from Cloudflare Access.');
  const access = config.ACCESS_TEAM_DOMAIN
    ? {
        teamDomain: config.ACCESS_TEAM_DOMAIN,
        audience: config.ACCESS_AUD!,
        keys: overrides.accessKeys,
      }
    : undefined;
  const accounts = accountsFrom(config, Boolean(access));
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
  const notices = new Notices(
    db,
    {
      contact:
        config.PUSH_CONTACT || (config.OWNER_EMAIL ? `mailto:${config.OWNER_EMAIL}` : undefined),
      publicKey: config.VAPID_PUBLIC_KEY,
      privateKey: config.VAPID_PRIVATE_KEY,
    },
    clock,
    overrides.send,
  );
  const assistant = new AssistantKit(db);
  const host: PluginHost = { db, clock, household, notices, assistant };
  const calendar = new CalendarPlugin(host, await new CalendarService(db, transport, clock).load());
  const tasks = new TasksPlugin(host);
  // The calendar refreshes before the dashboard summarizes it.
  const plugins: Plugin[] = [calendar, tasks, new DashboardPlugin(host, tasks, calendar)];
  notices.use(plugins);
  const ai = overrides.models
    ? { models: overrides.models, model: overrides.model }
    : await aiConnection(db, config);
  const conversations = await Conversations.open(db, {
    ...ai,
    household,
    extensions: [
      coreExtension(db, assistant, household),
      ...plugins.flatMap((plugin) => (plugin.extension ? [plugin.extension] : [])),
    ],
  });
  const auth = new Auth(accounts, access);
  const nextWake = async () => {
    const now = clock();
    const times = [now.getTime() + fallbackWake, (await notices.nextWake(now)) ?? Infinity];
    for (const plugin of plugins) times.push((await plugin.nextWake?.(now)) ?? Infinity);
    if (await conversations.pending()) times.push(now.getTime() + assistantRecovery);
    return Math.max(now.getTime() + 1000, Math.min(...times));
  };
  return {
    db,
    auth,
    household,
    conversations,
    notices,
    plugins,
    nextWake,
    async tick() {
      for (const plugin of plugins)
        try {
          await plugin.tick?.(clock());
        } catch {
          console.error(`Background work for ${plugin.id} failed; it will be retried.`);
        }
      try {
        await notices.deliver();
      } catch {
        console.error('Notice delivery failed; it will be retried.');
      }
      return nextWake();
    },
    refreshIfStale: () => calendar.refreshIfStale(clock()),
  };
}
