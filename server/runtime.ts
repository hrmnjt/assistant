import type { Models } from '@earendil-works/pi-ai';
import type { ModelRef } from '@earendil-works/pi-durable';
import { migrate, type Store } from './database.js';
import { Auth } from './auth.js';
import { Household } from './household.js';
import { AdminAuth } from './admin.js';
import { Conversations } from './conversations.js';
import { Notices, type PushSender } from './notices.js';
import { AssistantKit, coreExtension } from './assistant-tools.js';
import { aiConnection, AssistantModel } from './ai.js';
import { Settings } from './settings.js';
import type { Plugin, PluginHost } from './plugin.js';
import { CalendarPlugin } from './plugins/calendar/index.js';
import { CalendarService } from './plugins/calendar/service.js';
import {
  iCloud,
  type CalendarConnector,
  type CalendarTransport,
} from './plugins/calendar/caldav.js';
import { TasksPlugin } from './plugins/tasks.js';
import { DashboardPlugin } from './plugins/dashboard.js';
import type { App } from './api.js';

/**
 * The Worker's secrets: ADMIN_TOKEN opens the admin page, and `npm run dev`
 * sets HOUSEHOLD_DEVELOPMENT. Everything else the admin sets in the app.
 */
export type Config = Partial<
  Record<'HOUSEHOLD_DEVELOPMENT' | 'ADMIN_TOKEN' | 'CHATGPT_CREDENTIAL_JSON', string>
>;
/** Replaceable integrations, for tests and local fixtures. */
export type Overrides = {
  clock?: () => Date;
  /** A fixed calendar, instead of the one the admin connected. */
  transport?: CalendarTransport;
  connector?: CalendarConnector;
  models?: Models;
  model?: ModelRef;
  send?: PushSender;
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

/** Open the assistant on one store; the same code runs in a Durable Object and in tests. */
export async function openHousehold(
  db: Store,
  config: Config,
  overrides: Overrides = {},
): Promise<Runtime> {
  const clock = overrides.clock ?? (() => new Date());
  await migrate(db);
  // `npm run dev` sets HOUSEHOLD_DEVELOPMENT; a deployment never does.
  const development = config.HOUSEHOLD_DEVELOPMENT === 'true';
  const household = new Household(db, clock);
  await household.ensureSpaces();
  const settings = new Settings(db);
  const connector = overrides.connector ?? iCloud;
  const transport = overrides.transport ?? (await CalendarPlugin.saved(settings, connector));
  const notices = new Notices(db, await settings.pushKeys(), clock, overrides.send);
  const assistant = new AssistantKit(db);
  const host: PluginHost = { db, clock, household, notices, assistant, settings };
  const calendar = new CalendarPlugin(
    host,
    await new CalendarService(db, transport, clock).load(),
    connector,
  );
  const tasks = new TasksPlugin(host);
  // The calendar refreshes before the dashboard summarizes it.
  const plugins: Plugin[] = [calendar, tasks, new DashboardPlugin(host, tasks, calendar)];
  notices.use(plugins);
  const ai = overrides.models
    ? { models: overrides.models, model: overrides.model }
    : await aiConnection(db, config, settings);
  const conversations = await Conversations.open(db, {
    ...ai,
    household,
    extensions: [
      coreExtension(db, assistant, household),
      ...plugins.flatMap((plugin) => (plugin.extension ? [plugin.extension] : [])),
    ],
  });
  const assistantModel = new AssistantModel(db, settings, ai.models, (model) =>
    conversations.setModel(model),
  );
  const auth = new Auth(household, development);
  const admin = new AdminAuth(db, config.ADMIN_TOKEN, development, clock);
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
    assistantModel,
    admin,
    settings,
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
