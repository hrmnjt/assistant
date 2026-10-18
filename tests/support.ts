import { DatabaseSync } from 'node:sqlite';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { NodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';
import { migrate, type Store } from '../server/database.js';
import { provision, type Account } from '../server/auth.js';
import { handle, type App } from '../server/api.js';
import { AssistantKit, coreExtension } from '../server/assistant-tools.js';
import { previewOwner } from '../server/changes.js';
import { DomainError } from '../server/errors.js';
import { Household } from '../server/household.js';
import { Notices, type PushConfig, type PushSender } from '../server/notices.js';
import type { Plugin, PluginHost } from '../server/plugin.js';
import type { CalendarSnapshot } from '../src/types.js';
import { CalendarPlugin, type CalendarSource } from '../server/plugins/calendar/index.js';
import { DashboardPlugin } from '../server/plugins/dashboard.js';
import { TasksPlugin } from '../server/plugins/tasks.js';

export type Row = Record<string, any>;
export const origin = 'http://localhost:5173';
export const accounts: Account[] = [
  { id: 'owner', name: 'Alex', email: 'alex@example.com' },
  { id: 'partner', name: 'Sam', email: 'sam@example.com' },
];
/** A development server: no Cloudflare Access, so requests on this computer need no sign-in. */
export const config = {
  OWNER_NAME: 'Alex',
  OWNER_EMAIL: accounts[0].email,
  PARTNER_NAME: 'Sam',
  PARTNER_EMAIL: accounts[1].email,
};

/** Cloudflare Access for tests: a local signing key and tokens naming an email. */
export async function testAccess(teamDomain = 'https://household.cloudflareaccess.com') {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256' };
  const audience = 'test-audience';
  return {
    config: { ...config, ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: audience },
    keys: createLocalJWKSet({ keys: [jwk] }),
    token: (
      email: string,
      overrides: { audience?: string; issuer?: string; expires?: string } = {},
    ) =>
      new SignJWT({ email })
        .setProtectedHeader({ alg: 'RS256', kid: 'test' })
        .setIssuer(overrides.issuer ?? teamDomain)
        .setAudience(overrides.audience ?? audience)
        .setIssuedAt()
        .setExpirationTime(overrides.expires ?? '10m')
        .sign(privateKey),
  };
}

/** Push settings for tests that inject a fake sender; no push service is called. */
export const push = {
  contact: 'mailto:test@example.com',
  publicKey: 'test-public-key',
  privateKey: 'test-private-key',
};

/** The household store on Node's SQLite, through the same adapter interface as a Durable Object. */
export function openStore(path = ':memory:'): Store {
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA foreign_keys = ON');
  return new NodeSqliteDatabase(raw);
}
/** A migrated store with the two test accounts. */
export async function householdStore(path?: string) {
  const db = openStore(path);
  await migrate(db);
  await provision(db, accounts);
  return db;
}
export function directory(prefix = 'run') {
  mkdirSync(resolve('.cache/tests'), { recursive: true });
  return mkdtempSync(resolve(`.cache/tests/${prefix}-`));
}

/**
 * A client calling the API handler directly. On a development server it acts
 * as the given person; with Access, pass that person's token header instead.
 */
export function client(app: App, person: 'owner' | 'partner' = 'owner', base = origin) {
  const cookie = person === 'partner' ? 'household-dev-person=partner' : '';
  const call = async (
    path: string,
    body?: unknown,
    method = body === undefined ? 'GET' : 'POST',
    headers: Record<string, string> = {},
  ) =>
    handle(
      app,
      new Request(base + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Household-Client': '1',
          Origin: base,
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  return { call };
}

/** The household core and its plugins on one store, assembled as the runtime does. */
export function householdParts(
  db: Store,
  options: {
    clock?: () => Date;
    push?: PushConfig;
    send?: PushSender;
    calendar?: CalendarSource;
  } = {},
) {
  const clock = options.clock ?? (() => new Date());
  const household = new Household(db, clock);
  const notices = new Notices(db, options.push ?? {}, clock, options.send);
  const assistant = new AssistantKit(db);
  const host: PluginHost = { db, clock, household, notices, assistant };
  const tasks = new TasksPlugin(host);
  const calendar = options.calendar ? new CalendarPlugin(host, options.calendar) : undefined;
  const dashboard = new DashboardPlugin(host, tasks, calendar);
  const plugins: Plugin[] = [...(calendar ? [calendar] : []), tasks, dashboard];
  notices.use(plugins);
  const owners = [household.changes, ...plugins.flatMap((plugin) => plugin.changes ?? [])];
  return {
    /** The assistant's Pi extensions: the core, then each plugin's. */
    extensions: [
      coreExtension(db, assistant, household),
      ...plugins.flatMap((plugin) => (plugin.extension ? [plugin.extension] : [])),
    ],
    db,
    household,
    notices,
    assistant,
    host,
    tasks,
    calendar,
    dashboard,
    plugins,
    /** Previews and confirmations, routed to the owning plugin as the API does. */
    changes: {
      preview(actorId: string, input: unknown) {
        const kind = String((input as { kind?: unknown } | null)?.kind);
        const owner = owners.find((item) => item.kinds.includes(kind));
        if (!owner) throw new DomainError('Choose a supported change.');
        return owner.preview(actorId, input);
      },
      async confirm(actorId: string, previewId: string) {
        return (await previewOwner(db, owners, actorId, previewId)).confirm(actorId, previewId);
      },
      async cancel(actorId: string, previewId: string) {
        const owner = await previewOwner(db, owners, actorId, previewId).catch(() => null);
        await owner?.cancel(actorId, previewId);
      },
    },
    /** Plan every plugin's notices as the scheduler does, without refreshing the calendar. */
    async plan(now = clock()) {
      await calendar?.planReminders(now);
      await tasks.tick(now);
      await dashboard.tick(now);
    },
  };
}

/** A calendar that only reports a given snapshot, for reminder and delivery tests. */
export function fakeCalendar(snapshot: () => CalendarSnapshot): CalendarSource {
  const unused = async (): Promise<never> => {
    throw new Error('Not used by this test.');
  };
  return {
    connected: true,
    snapshot,
    sync: async () => undefined,
    preview: unused,
    confirm: unused,
    cancel: unused,
    dismiss: unused,
  };
}
