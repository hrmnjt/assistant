import webpush from 'web-push';
import type { Executor, Row, Store } from './database.js';

/**
 * What the app keeps for itself rather than in the Worker's variables: its
 * push keys, its own address and which calendar it last showed. Values are JSON.
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
