import type { Credential, CredentialStore, Models } from '@earendil-works/pi-ai';
import type { ModelRef } from '@earendil-works/pi-durable';
import type { Row, Store } from './database.js';
import { chatgptModels } from './chatgpt-models.js';
import { finishSignIn, returnedCode, startSignIn, type PendingSignIn } from './chatgpt-sign-in.js';
import { DomainError } from './errors.js';
import type { Settings } from './settings.js';

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
  /** Keep a newly connected credential, replacing any earlier one; refreshes then update it. */
  async save(credential: Credential) {
    if (credential.type !== 'oauth') throw new Error('API-key fallback is disabled.');
    await this.exclusive(() =>
      this.db.run(
        "INSERT INTO ai_credentials VALUES (1,?,'') ON CONFLICT(id) DO UPDATE SET value=excluded.value",
        JSON.stringify(credential),
      ),
    );
  }
}

const modelKey = 'ai_model';
const signInKey = 'chatgpt_sign_in';
const hostKey = 'chatgpt_host';
const signInLifetime = 10 * 60_000;

/**
 * ChatGPT access: the credential the admin connected and the model they chose.
 * The assistant is optional: missing or unreadable settings leave it
 * unavailable while tasks, messages, calendar sync, and reminders keep working.
 * No API-key fallback.
 */
export async function aiConnection(db: Store, settings: Settings) {
  const credentials = new StoredCredentials(db);
  const models = chatgptModels(credentials);
  try {
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

/** An error and its causes, for the Worker's log; pi-ai wraps what went wrong. */
function reasons(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause === undefined ? error.message : `${error.message} ← ${reasons(error.cause)}`;
}

/** The models this ChatGPT account lists that the assistant supports. */
export async function chatgptCatalog(models: Models): Promise<ChatgptModel[]> {
  let failed = false;
  const auth = await models
    .getAuth('openai', { signal: AbortSignal.timeout(15000) })
    .catch((error: unknown) => {
      failed = true;
      console.error(`The ChatGPT sign-in could not be used: ${reasons(error)}`);
      return undefined;
    });
  if (failed)
    throw new DomainError(
      'The ChatGPT sign-in stopped working. Disconnect ChatGPT and connect it again.',
      409,
    );
  if (!auth?.auth.apiKey) throw new DomainError('Connect ChatGPT first.', 409);
  const response = await fetch('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${auth.auth.apiKey}` },
    signal: AbortSignal.timeout(15000),
  }).catch(() => undefined);
  if (!response?.ok) {
    console.error(
      `OpenAI did not list models: ${response ? `status ${response.status}` : 'no response'}.`,
    );
    throw new DomainError('The ChatGPT model list is unavailable. Try again later.', 503);
  }
  const body = (await response.json()) as {
    models?: { slug: string; display_name: string; visibility: string }[];
  };
  return (body.models ?? [])
    .filter((model) => model.visibility === 'list' && models.getModel('openai', model.slug))
    .map((model) => ({ id: model.slug, name: model.display_name }));
}

/**
 * The assistant's ChatGPT connection and model, both made by the admin. The
 * admin signs in with ChatGPT from the admin page: OpenAI sends the browser
 * back to an address only an app on the same device answers, so on a phone
 * that page fails to load and the admin pastes its address back. The verifier
 * and state stay on the server, so a pasted address finishes only the sign-in
 * the admin started, once, within ten minutes.
 */
export class AssistantModel {
  constructor(
    private db: Store,
    private settings: Settings,
    private models: Models,
    /** Start using a newly chosen model, or stop the assistant. */
    private use: (model?: ModelRef) => void,
    private clock: () => Date = () => new Date(),
  ) {}
  /** Whether ChatGPT is connected, with or without a model chosen. */
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
  /** Start signing in with ChatGPT; returns the address to open. */
  async startSignIn() {
    // A stable identifier lets ChatGPT recognize this installation when it reconnects.
    let hostId = await this.settings.get<string>(hostKey);
    if (!hostId) await this.settings.set(hostKey, (hostId = crypto.randomUUID()));
    const { url, pending } = startSignIn(hostId, this.clock().getTime());
    await this.settings.set(signInKey, pending);
    return url;
  }
  /** Finish with the address the browser ended on, then keep the connection. */
  async finishSignIn(address: string) {
    const now = this.clock().getTime();
    const pending = await this.settings.get<PendingSignIn>(signInKey);
    if (!pending || now - pending.startedAt > signInLifetime)
      throw new DomainError('That sign-in has expired. Start again to try once more.', 409);
    const returned = returnedCode(address, pending);
    // Each sign-in finishes at most once, whatever OpenAI answers.
    await this.settings.delete(signInKey);
    await new StoredCredentials(this.db).save(await finishSignIn(returned, pending, now));
    const modelId = await this.settings.get<string>(modelKey);
    if (modelId && this.models.getModel('openai', modelId))
      this.use({ provider: 'openai', modelId });
  }
  async disconnect() {
    await new StoredCredentials(this.db).delete('openai');
    this.use(undefined);
  }
}
