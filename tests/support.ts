import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { NodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';
import { migrate, type Store } from '../server/database.js';
import { provision, type Account } from '../server/auth.js';
import { handle, type App } from '../server/api.js';

export type Row = Record<string, any>;
export const origin = 'http://localhost:5173';
export const accounts: Account[] = [
  { id: 'owner', username: 'owner', name: 'Alex', password: 'Test-only-owner-password' },
  { id: 'partner', username: 'partner', name: 'Sam', password: 'Test-only-partner-password' },
];
export const config = {
  APP_ORIGIN: origin,
  OWNER_USERNAME: 'owner',
  OWNER_NAME: 'Alex',
  OWNER_PASSWORD: accounts[0].password,
  PARTNER_USERNAME: 'partner',
  PARTNER_NAME: 'Sam',
  PARTNER_PASSWORD: accounts[1].password,
};

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

/** A signed-in client for one account, calling the API handler directly. */
export function client(app: App) {
  let cookie = '';
  const call = async (
    path: string,
    body?: unknown,
    method = body === undefined ? 'GET' : 'POST',
    headers: Record<string, string> = {},
  ) =>
    handle(
      app,
      new Request(origin + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Household-Client': '1',
          Origin: origin,
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      'test-client',
    );
  return {
    call,
    async login(username: string, password: string) {
      const response = await call('/api/login', { username, password });
      const set = response.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return response;
    },
    get cookie() {
      return cookie;
    },
  };
}
