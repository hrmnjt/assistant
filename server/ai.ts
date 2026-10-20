import type { Credential, CredentialStore, Models } from '@earendil-works/pi-ai';
import type { ModelRef } from '@earendil-works/pi-durable';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Row, Store } from './database.js';
import { chatgptModels } from './chatgpt-models.js';
import { DomainError } from './errors.js';
import type { Settings } from './settings.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export { chatgptModels } from './chatgpt-models.js';

/**
 * The household's ChatGPT OAuth credential, kept in its database so refreshed
 * tokens survive restarts. Refreshes are serialized and never hold a SQL
 * transaction open across the network call.
 */
export class StoredCredentials implements CredentialStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private db: Store) {}
  private exclusive<T>(work: () => Promise<T>) {
    const result = this.tail.then(work, work);
    this.tail = result.catch(() => undefined);
    return result;
  }
  async read(providerId: string): Promise<Credential | undefined> {
    if (providerId !== 'openai') return undefined;
    const row = await this.db.get<Row>('SELECT value FROM ai_credentials WHERE id=1');
    return row ? JSON.parse(String(row.value)) : undefined;
  }
  async list() {
    return (await this.read('openai')) ? [{ providerId: 'openai', type: 'oauth' as const }] : [];
  }
  async modify(
    providerId: string,
    fn: (value: Credential | undefined) => Promise<Credential | undefined>,
    options?: { signal?: AbortSignal },
  ) {
    if (providerId !== 'openai') throw new Error('Unsupported provider.');
    return this.exclusive(async () => {
      options?.signal?.throwIfAborted();
      const current = await this.read(providerId);
      const next = await fn(current);
      if (next) {
        if (next.type !== 'oauth') throw new Error('API-key fallback is disabled.');
        await this.db.run('UPDATE ai_credentials SET value=? WHERE id=1', JSON.stringify(next));
      }
      return next ?? current;
    });
  }
  async delete(providerId: string) {
    if (providerId === 'openai')
      await this.exclusive(() => this.db.run('DELETE FROM ai_credentials'));
  }
  /** Adopt a newly connected credential once; later refreshes keep their own tokens. */
  async seed(json: string | undefined) {
    if (!json) return this.delete('openai');
    const seed = digest(json);
    const saved = await this.db.get<Row>('SELECT seed FROM ai_credentials WHERE id=1');
    if (saved?.seed === seed) return;
    const credential = z
      .object({
        type: z.literal('oauth'),
        access: z.string().min(1),
        refresh: z.string().min(1),
        expires: z.number(),
      })
      .passthrough()
      .parse(JSON.parse(json));
    await this.exclusive(() =>
      this.db.run(
        'INSERT INTO ai_credentials VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,seed=excluded.seed',
        JSON.stringify(credential),
        seed,
      ),
    );
  }
}

export type AIConfig = { CHATGPT_CREDENTIAL_JSON?: string };
const modelKey = 'ai_model';

/**
 * ChatGPT access: the connected credential and the model the admin chose. The
 * assistant is optional: missing or unreadable settings leave it unavailable
 * while tasks, messages, calendar sync, and reminders keep working. No API-key
 * fallback.
 */
export async function aiConnection(db: Store, config: AIConfig, settings: Settings) {
  const credentials = new StoredCredentials(db);
  const models = chatgptModels(credentials);
  try {
    await credentials.seed(config.CHATGPT_CREDENTIAL_JSON || undefined);
    const modelId = await settings.get<string>(modelKey);
    const configured = Boolean(
      modelId && models.getModel('openai', modelId) && (await credentials.read('openai')),
    );
    return { models, model: configured ? { provider: 'openai', modelId: modelId! } : undefined };
  } catch {
    console.error(
      'ChatGPT settings could not be read, so the assistant is unavailable. Everything else keeps working; connect ChatGPT again.',
    );
    return { models, model: undefined };
  }
}

export type ChatgptModel = { id: string; name: string };

/** The models this ChatGPT account lists that the assistant supports. */
export async function chatgptCatalog(models: Models): Promise<ChatgptModel[]> {
  const auth = await models
    .getAuth('openai', { signal: AbortSignal.timeout(15000) })
    .catch(() => undefined);
  if (!auth?.auth.apiKey)
    throw new DomainError('Connect ChatGPT first: run npm run ai:connect on the Mac.', 409);
  const response = await fetch('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${auth.auth.apiKey}` },
    signal: AbortSignal.timeout(15000),
  }).catch(() => undefined);
  if (!response?.ok)
    throw new DomainError('The ChatGPT model list is unavailable. Try again later.', 503);
  const body = (await response.json()) as {
    models?: { slug: string; display_name: string; visibility: string }[];
  };
  return (body.models ?? [])
    .filter((model) => model.visibility === 'list' && models.getModel('openai', model.slug))
    .map((model) => ({ id: model.slug, name: model.display_name }));
}

/** The assistant's model, chosen by the admin from the connected account's catalog. */
export class AssistantModel {
  constructor(
    private db: Store,
    private settings: Settings,
    private models: Models,
    /** Start using a newly chosen model. */
    private use: (model: ModelRef) => void,
  ) {}
  /** Whether a ChatGPT connection was made, with or without a model chosen. */
  async connected() {
    return Boolean(await new StoredCredentials(this.db).read('openai'));
  }
  async catalog() {
    return {
      current: (await this.settings.get<string>(modelKey)) ?? null,
      models: await chatgptCatalog(this.models),
    };
  }
  async choose(id: string) {
    if (!(await chatgptCatalog(this.models)).some((model) => model.id === id))
      throw new DomainError('Choose one of the listed models.');
    await this.settings.set(modelKey, id);
    this.use({ provider: 'openai', modelId: id });
  }
}
