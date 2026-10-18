import webpush from 'web-push';
import type { Executor, Row, Store } from './database.js';

/**
 * Household settings the app keeps itself, instead of deployment
 * configuration: when it was set up, its push keys, the calendar connection
 * and the assistant's model. Values are JSON.
 */
export class Settings {
  constructor(private db: Store) {}
  async get<T>(key: string, q: Executor = this.db): Promise<T | undefined> {
    const row = await q.get<Row>('SELECT value FROM settings WHERE key=?', key);
    return row ? (JSON.parse(String(row.value)) as T) : undefined;
  }
  async set(key: string, value: unknown, q: Executor = this.db) {
    await q.run(
      'INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      key,
      JSON.stringify(value),
    );
  }
  async delete(key: string) {
    await this.db.run('DELETE FROM settings WHERE key=?', key);
  }
  /**
   * This household's Web Push keys, made once and kept: phones subscribe to
   * the public key, so a new pair would break every existing subscription.
   */
  async pushKeys() {
    return this.db.transaction(async (tx) => {
      const saved = await this.get<{ publicKey: string; privateKey: string }>('push', tx);
      if (saved) return saved;
      const keys = webpush.generateVAPIDKeys();
      await this.set('push', keys, tx);
      return keys;
    });
  }
}
