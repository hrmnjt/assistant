import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class Database {
  readonly sql: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.sql = new DatabaseSync(path);
    this.sql.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL,
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
      CREATE TABLE IF NOT EXISTS notice_reads (notice_id TEXT PRIMARY KEY REFERENCES notices(id) ON DELETE CASCADE,
        read_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS push_subscriptions (endpoint TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS push_deliveries (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, actor_id TEXT NOT NULL,
        kind TEXT NOT NULL, target_id TEXT, created_at TEXT NOT NULL);
    `);
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
