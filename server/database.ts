import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Ordered household schema migrations; `PRAGMA user_version` counts those applied.
 * Never edit or reorder a released step: append a new one. Version 1 adopts
 * databases created before versioning, whose tables already exist.
 */
export const migrations: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL, password_hash TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS preferences (user_id TEXT PRIMARY KEY REFERENCES users(id),
    value TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, value TEXT NOT NULL, revision INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS task_history (task_id TEXT NOT NULL,
    due_at TEXT NOT NULL, outcome TEXT NOT NULL, completed_by TEXT,
    PRIMARY KEY (task_id, due_at));
  CREATE TABLE IF NOT EXISTS previews (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
    mutation TEXT NOT NULL, view TEXT NOT NULL, expires_at INTEGER NOT NULL,
    applied_at INTEGER, result TEXT);
  CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, title TEXT NOT NULL,
    category TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS thread_spaces (key TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL UNIQUE REFERENCES threads(id));
  CREATE TABLE IF NOT EXISTS presence (user_id TEXT NOT NULL REFERENCES users(id),
    client_id TEXT NOT NULL, thread_id TEXT NOT NULL REFERENCES threads(id), typing INTEGER NOT NULL,
    seen_at INTEGER NOT NULL, PRIMARY KEY (user_id, client_id));
  CREATE TABLE IF NOT EXISTS notices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
    title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, delivery TEXT NOT NULL DEFAULT 'pending');
  CREATE TABLE IF NOT EXISTS notice_targets (notice_id TEXT PRIMARY KEY REFERENCES notices(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,target_id TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS task_notice_deadlines (notice_id TEXT PRIMARY KEY REFERENCES notices(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL, due_at TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id));
  CREATE TABLE IF NOT EXISTS notice_retries (notice_id TEXT PRIMARY KEY REFERENCES notices(id) ON DELETE CASCADE,
    next_attempt_at INTEGER NOT NULL, attempts INTEGER NOT NULL, failure TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS notice_retry_due ON notice_retries(next_attempt_at);
  CREATE TABLE IF NOT EXISTS notice_reads (notice_id TEXT PRIMARY KEY REFERENCES notices(id) ON DELETE CASCADE,
    read_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS push_subscriptions (endpoint TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id), value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS push_deliveries (id TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, actor_id TEXT NOT NULL,
    kind TEXT NOT NULL, target_id TEXT, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS calendar_cache (id TEXT PRIMARY KEY, value TEXT NOT NULL, resource_url TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS calendar_state (id INTEGER PRIMARY KEY CHECK(id=1), name TEXT NOT NULL, synced_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS calendar_operations (preview_id TEXT PRIMARY KEY REFERENCES previews(id) ON DELETE CASCADE,
    value TEXT NOT NULL, attempted INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS pi_conversations(thread_id TEXT PRIMARY KEY REFERENCES threads(id),
    conversation_id TEXT NOT NULL UNIQUE);
  CREATE TABLE IF NOT EXISTS assistant_runs (
    thread_id TEXT NOT NULL REFERENCES threads(id), request_key TEXT NOT NULL,
    author_id TEXT NOT NULL REFERENCES users(id), text TEXT NOT NULL, message_id TEXT NOT NULL,
    created_at TEXT NOT NULL, status TEXT NOT NULL, error TEXT,
    PRIMARY KEY(thread_id,request_key));
  CREATE UNIQUE INDEX IF NOT EXISTS assistant_one_run ON assistant_runs(thread_id) WHERE status='running';
  CREATE TABLE IF NOT EXISTS assistant_previews (
    call_key TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id),
    actor_id TEXT NOT NULL REFERENCES users(id), preview_id TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS assistant_model_calls (task_id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,request_key TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS assistant_sessions (session_id TEXT PRIMARY KEY,thread_id TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS assistant_reply_times (task_id TEXT PRIMARY KEY,created_at TEXT NOT NULL);`,
  // Occurrence completion time. Earlier completed rows keep NULL: the separate
  // audit log has no occurrence link, so their actual completion time is unknown.
  `ALTER TABLE task_history ADD COLUMN completed_at TEXT;`,
  // Pi compaction calls, metered per topic separately from request generation.
  `CREATE TABLE assistant_maintenance_calls (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL,
    created_at INTEGER NOT NULL);
  CREATE INDEX assistant_maintenance_recent ON assistant_maintenance_calls(thread_id, created_at);`,
  // The latest useful phone-push time of each notice, set by its kind's catch-up
  // policy. Earlier notices keep their previous two-hour window after creation.
  `ALTER TABLE notices ADD COLUMN push_until TEXT NOT NULL DEFAULT '';
  UPDATE notices SET push_until=strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+2 hours');`,
];

export class Database {
  readonly sql: DatabaseSync;
  constructor(path: string, steps: readonly string[] = migrations) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.sql = new DatabaseSync(path);
    this.sql.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
    `);
    try {
      this.migrate(steps);
    } catch (error) {
      this.sql.close();
      throw error;
    }
  }
  get version() {
    return Number(this.sql.prepare('PRAGMA user_version').get()!.user_version);
  }
  private migrate(steps: readonly string[]) {
    if (this.version > steps.length)
      throw new Error(
        'The household database was written by a newer app version. Update the app before starting it.',
      );
    // Each step and its version bump commit together; a failed step leaves the prior version.
    for (let next = this.version + 1; next <= steps.length; next++)
      this.transaction(() => {
        if (this.version >= next) return;
        this.sql.exec(steps[next - 1]);
        this.sql.exec(`PRAGMA user_version = ${next}`);
      });
  }
  transaction<T>(fn: () => T): T {
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.sql.exec('COMMIT');
      return value;
    } catch (error) {
      this.sql.exec('ROLLBACK');
      throw error;
    }
  }
  close() {
    this.sql.close();
  }
}
