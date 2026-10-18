import type { SqliteDatabase, SqliteExecutor } from '@earendil-works/pi-durable/storage/sqlite';

/**
 * The household's single SQLite database, shared with Pi. Every query, including
 * Pi's, goes through this one serialized adapter (a Durable Object's storage in
 * deployment, `node:sqlite` in tests), so household writes never interleave with
 * an open Pi transaction. Inside `transaction`, use only its executor.
 */
export type Store = SqliteDatabase;
export type Executor = SqliteExecutor;
export type Row = Record<string, unknown>;

/**
 * Ordered household schema migrations; `household_schema` records how many have
 * been applied. Never edit or reorder a released step: append a new one. Pi owns
 * its own unprefixed tables (such as `tasks` and `entries`) in the same database.
 */
export const migrations: readonly string[] = [
  `CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL);
  CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
    credential TEXT NOT NULL, expires_at INTEGER NOT NULL);
  CREATE TABLE sign_in_attempts (client TEXT PRIMARY KEY, count INTEGER NOT NULL, until_at INTEGER NOT NULL);
  CREATE TABLE preferences (user_id TEXT PRIMARY KEY REFERENCES users(id),
    value TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE household_tasks (id TEXT PRIMARY KEY, value TEXT NOT NULL, revision INTEGER NOT NULL);
  CREATE TABLE task_history (task_id TEXT NOT NULL, due_at TEXT NOT NULL, outcome TEXT NOT NULL,
    completed_by TEXT, completed_at TEXT, PRIMARY KEY (task_id, due_at));
  CREATE TABLE previews (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
    mutation TEXT NOT NULL, view TEXT NOT NULL, expires_at INTEGER NOT NULL,
    applied_at INTEGER, result TEXT);
  CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL,
    category TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE thread_spaces (key TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL UNIQUE REFERENCES threads(id));
  CREATE TABLE presence (user_id TEXT NOT NULL REFERENCES users(id),
    client_id TEXT NOT NULL, thread_id TEXT NOT NULL REFERENCES threads(id), typing INTEGER NOT NULL,
    seen_at INTEGER NOT NULL, PRIMARY KEY (user_id, client_id));
  CREATE TABLE notices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
    title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL,
    delivery TEXT NOT NULL DEFAULT 'pending', push_until TEXT NOT NULL);
  CREATE TABLE notice_targets (notice_id TEXT PRIMARY KEY REFERENCES notices(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, target_id TEXT NOT NULL);
  CREATE TABLE task_notice_deadlines (notice_id TEXT PRIMARY KEY REFERENCES notices(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL, due_at TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id));
  CREATE TABLE notice_retries (notice_id TEXT PRIMARY KEY REFERENCES notices(id) ON DELETE CASCADE,
    next_attempt_at INTEGER NOT NULL, attempts INTEGER NOT NULL, failure TEXT NOT NULL);
  CREATE INDEX notice_retry_due ON notice_retries(next_attempt_at);
  CREATE TABLE notice_reads (notice_id TEXT PRIMARY KEY REFERENCES notices(id) ON DELETE CASCADE,
    read_at TEXT NOT NULL);
  CREATE TABLE push_subscriptions (endpoint TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id), value TEXT NOT NULL);
  CREATE TABLE push_deliveries (id TEXT PRIMARY KEY);
  CREATE TABLE audit (id INTEGER PRIMARY KEY, actor_id TEXT NOT NULL,
    kind TEXT NOT NULL, target_id TEXT, created_at TEXT NOT NULL);
  CREATE TABLE calendar_cache (id TEXT PRIMARY KEY, value TEXT NOT NULL, resource_url TEXT NOT NULL);
  CREATE TABLE calendar_state (id INTEGER PRIMARY KEY CHECK(id=1), name TEXT NOT NULL, synced_at TEXT NOT NULL);
  CREATE TABLE calendar_operations (preview_id TEXT PRIMARY KEY REFERENCES previews(id) ON DELETE CASCADE,
    value TEXT NOT NULL, attempted INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE pi_conversations (thread_id TEXT PRIMARY KEY REFERENCES threads(id),
    conversation_id TEXT NOT NULL UNIQUE);
  CREATE TABLE assistant_runs (thread_id TEXT NOT NULL REFERENCES threads(id), request_key TEXT NOT NULL,
    author_id TEXT NOT NULL REFERENCES users(id), text TEXT NOT NULL, message_id TEXT NOT NULL,
    created_at TEXT NOT NULL, status TEXT NOT NULL, error TEXT, PRIMARY KEY (thread_id, request_key));
  CREATE UNIQUE INDEX assistant_one_run ON assistant_runs(thread_id) WHERE status='running';
  CREATE TABLE assistant_previews (call_key TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id),
    actor_id TEXT NOT NULL REFERENCES users(id), preview_id TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE assistant_model_calls (task_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, request_key TEXT NOT NULL);
  CREATE TABLE assistant_maintenance_calls (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL,
    created_at INTEGER NOT NULL);
  CREATE INDEX assistant_maintenance_recent ON assistant_maintenance_calls(thread_id, created_at);
  CREATE TABLE assistant_sessions (session_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL);
  CREATE TABLE assistant_reply_times (task_id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
  CREATE TABLE ai_credentials (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL, seed TEXT NOT NULL);`,
];

export async function schemaVersion(db: Executor) {
  const row = await db.get<{ version: number }>('SELECT version FROM household_schema WHERE id=1');
  return Number(row?.version ?? 0);
}

/** Apply pending steps; each commits with its version, so a failed step leaves the prior one. */
export async function migrate(db: Store, steps: readonly string[] = migrations) {
  await db.exec(
    'CREATE TABLE IF NOT EXISTS household_schema (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)',
  );
  if ((await schemaVersion(db)) > steps.length)
    throw new Error(
      'The household database was written by a newer app version. Update the app before starting it.',
    );
  for (let next = (await schemaVersion(db)) + 1; next <= steps.length; next++)
    await db.transaction(async (tx) => {
      if ((await schemaVersion(tx)) >= next) return;
      await tx.exec(steps[next - 1]);
      await tx.run(
        'INSERT INTO household_schema VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET version=excluded.version',
        next,
      );
    });
}
