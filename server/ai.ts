import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { relative, isAbsolute, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { createModels, type Credential, type CredentialStore } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';

export function projectDataDir() {
  const path = resolve(process.env.DATA_DIR || './data');
  const inside = relative(process.cwd(), path);
  if (inside.startsWith('..') || isAbsolute(inside))
    throw new Error('DATA_DIR must stay inside the repository.');
  return path;
}

/** A single server installation owns this store. The lock also covers CLI login and token refresh. */
export class LocalCredentials implements CredentialStore {
  private path: string;
  constructor(private directory: string) {
    this.path = resolve(directory, 'chatgpt-auth.json');
  }
  async read(providerId: string) {
    if (providerId !== 'openai') return undefined;
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8')) as Credential;
      if (value.type !== 'oauth') throw new Error('Only ChatGPT OAuth credentials are supported.');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error('ChatGPT credentials could not be read. Reconnect locally.');
    }
  }
  async list() {
    return (await this.read('openai')) ? [{ providerId: 'openai', type: 'oauth' as const }] : [];
  }
  private async locked<T>(work: () => Promise<T>, signal?: AbortSignal) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = `${this.path}.lock`;
    const until = Date.now() + 15000;
    while (true) {
      signal?.throwIfAborted();
      try {
        await mkdir(lock, { mode: 0o700 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (Date.now() >= until)
          throw new Error(
            'ChatGPT credentials are locked. Stop other app processes before reconnecting; inspect a leftover lock after a crash.',
          );
        await pause(100, undefined, { signal });
      }
    }
    try {
      return await work();
    } finally {
      await rm(lock, { recursive: true });
    }
  }
  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: { signal?: AbortSignal },
  ) {
    if (providerId !== 'openai') throw new Error('Unsupported provider.');
    return this.locked(async () => {
      const current = await this.read(providerId);
      const next = await fn(current);
      if (!next) return current;
      if (next.type !== 'oauth') throw new Error('API-key fallback is disabled.');
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
        await rename(temporary, this.path);
        await chmod(this.path, 0o600);
      } finally {
        await rm(temporary, { force: true });
      }
      return next;
    }, options?.signal);
  }
  async delete(providerId: string, options?: { signal?: AbortSignal }) {
    if (providerId !== 'openai') return;
    await this.locked(() => rm(this.path, { force: true }), options?.signal);
  }
}

export function chatgptModels(credentials: CredentialStore) {
  const models = createModels({
    credentials,
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  const provider = openaiProvider();
  // Do not consult API-key environment variables or other applications' credentials.
  const subscription: typeof provider = {
    ...provider,
    auth: { oauth: provider.auth.oauth },
    streamSimple: (model, context, options) =>
      provider.streamSimple(model, context, {
        ...options,
        maxTokens: 4096,
        onProviderStreamEvent: async (event, currentModel) => {
          if (
            typeof event === 'object' &&
            event !== null &&
            'type' in event &&
            event.type === 'response.incomplete'
          )
            throw new Error('ChatGPT did not complete its response.');
          await options?.onProviderStreamEvent?.(event, currentModel);
        },
      }),
  };
  models.setProvider(subscription);
  return models;
}
export type AIConfig = { hostId: string; modelId?: string };
export async function aiConfig(directory: string): Promise<AIConfig> {
  try {
    return JSON.parse(await readFile(resolve(directory, 'chatgpt-host.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { hostId: randomUUID() };
    throw new Error('ChatGPT host settings could not be read.');
  }
}
export async function openAIConnection(directory: string) {
  const credentials = new LocalCredentials(directory);
  const models = chatgptModels(credentials);
  const config = await aiConfig(directory);
  const configured = Boolean(
    (await credentials.read('openai')) &&
    config.modelId &&
    models.getModel('openai', config.modelId),
  );
  return {
    models,
    model: configured ? { provider: 'openai', modelId: config.modelId! } : undefined,
  };
}
