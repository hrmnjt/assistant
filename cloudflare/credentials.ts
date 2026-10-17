import type { Credential, CredentialStore } from '@earendil-works/pi-ai';
import type { SqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite';

/** Refresh locks cover the network call too, without holding a SQL transaction open. */
export class ObjectCredentials implements CredentialStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private database: SqliteDatabase) {}
  private exclusive<T>(work: () => Promise<T>) {
    const result = this.tail.then(work, work);
    this.tail = result.catch(() => undefined);
    return result;
  }
  async read(providerId: string): Promise<Credential | undefined> {
    if (providerId !== 'openai') return undefined;
    const row = await this.database.get<{ value: string }>(
      'SELECT value FROM prototype_credentials WHERE id=1',
    );
    return row ? JSON.parse(row.value) : undefined;
  }
  async list() {
    return (await this.read('openai')) ? [{ providerId: 'openai', type: 'oauth' as const }] : [];
  }
  async modify(
    providerId: string,
    fn: (value: Credential | undefined) => Promise<Credential | undefined>,
    options?: { signal?: AbortSignal },
  ) {
    if (providerId !== 'openai') throw new Error('Unsupported provider');
    return this.exclusive(async () => {
      options?.signal?.throwIfAborted();
      const current = await this.read(providerId);
      const next = await fn(current);
      if (next) {
        if (next.type !== 'oauth') throw new Error('API-key fallback is disabled');
        await this.database.run(
          'INSERT INTO prototype_credentials VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
          JSON.stringify(next),
        );
      }
      return next ?? current;
    });
  }
  async delete(providerId: string) {
    if (providerId === 'openai')
      await this.exclusive(() => this.database.run('DELETE FROM prototype_credentials'));
  }
}
