import { DurableObject } from 'cloudflare:workers';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { DurableObjectSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/cloudflare';
import { chatgptModels } from '../server/chatgpt-models.js';
import { digest } from '../server/auth.js';
import { validPushEndpoint } from '../server/reminders.js';
import { ICloudTransport } from '../server/caldav.js';
import { probeCalendar, deliverReminder } from './probes.js';
import { ObjectCredentials } from './credentials.js';
import { body, json, RequestError, securityHeaders } from './security.js';

export interface Env {
  HOUSEHOLD: DurableObjectNamespace<HouseholdPrototype>;
  ASSETS: Fetcher;
  APP_ORIGIN: string;
  OWNER_PASSWORD: string;
  PARTNER_PASSWORD: string;
  MODEL_MODE: 'fixture' | 'chatgpt';
  ALLOW_HOSTED_CHATGPT?: string;
  CHATGPT_MODEL_ID?: string;
  CHATGPT_CREDENTIAL_JSON?: string;
  ICLOUD_USERNAME?: string;
  ICLOUD_APP_PASSWORD?: string;
  ICLOUD_CALENDAR_NAME?: string;
  ICLOUD_CALENDAR_URL?: string;
  PUSH_CONTACT?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
}
type Job = {
  id: string;
  user_id: string;
  kind: 'chat' | 'reminder' | 'calendar';
  payload: string;
  status: string;
  due_at: number;
  attempts: number;
  result: string | null;
};
const context = BACKGROUND_CONTEXT;
const schema = `
CREATE TABLE IF NOT EXISTS prototype_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS prototype_attempts (id TEXT PRIMARY KEY, count INTEGER NOT NULL, until_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS prototype_credentials (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS prototype_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS prototype_jobs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', due_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, result TEXT);
CREATE INDEX IF NOT EXISTS prototype_due ON prototype_jobs(status,due_at);
CREATE TABLE IF NOT EXISTS prototype_subscriptions (endpoint TEXT PRIMARY KEY, user_id TEXT NOT NULL, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS prototype_deliveries (id TEXT PRIMARY KEY);
`;

/** One fixed household; no caller-controlled object IDs or public registration. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      if (!env.APP_ORIGIN || url.origin !== env.APP_ORIGIN)
        return json({ error: 'Configure this prototype’s exact APP_ORIGIN.' }, 503);
      try {
        return await env.HOUSEHOLD.getByName('household-prototype-v1').fetch(request);
      } catch {
        return json({ error: 'Prototype unavailable. Check its server configuration.' }, 503);
      }
    }
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(securityHeaders)) headers.set(key, value);
    return new Response(response.body, { status: response.status, headers });
  },
};

export class HouseholdPrototype extends DurableObject<Env> {
  private database: DurableObjectSqliteDatabase;
  private harness!: Harness;
  private bootId = crypto.randomUUID();
  private transport?: ICloudTransport;
  private model!: { provider: string; modelId: string };
  private fixture = fauxProvider();
  private ready: Promise<void>;
  private processing = false;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.database = new DurableObjectSqliteDatabase(ctx.storage);
    this.ready = ctx.blockConcurrencyWhile(async () => {
      try {
        await this.initialize();
      } catch {
        throw new Error('Prototype initialization failed; check server configuration.');
      }
    });
  }
  private async initialize() {
    await this.database.exec(schema);
    let models = createModels();
    if (this.env.MODEL_MODE === 'fixture') {
      models.setProvider(this.fixture.provider);
      this.model = {
        provider: this.fixture.getModel().provider,
        modelId: this.fixture.getModel().id,
      };
    } else if (
      this.env.MODEL_MODE === 'chatgpt' &&
      this.env.ALLOW_HOSTED_CHATGPT === 'true' &&
      this.env.CHATGPT_MODEL_ID
    ) {
      const credentials = new ObjectCredentials(this.database);
      if (!(await credentials.read('openai'))) {
        const initial = z
          .object({
            type: z.literal('oauth'),
            access: z.string().min(1),
            refresh: z.string().min(1),
            expires: z.number(),
          })
          .passthrough()
          .parse(JSON.parse(this.env.CHATGPT_CREDENTIAL_JSON || 'null'));
        await credentials.modify('openai', async () => initial);
      }
      models = chatgptModels(credentials);
      this.model = { provider: 'openai', modelId: this.env.CHATGPT_MODEL_ID };
      if (!models.getModel('openai', this.env.CHATGPT_MODEL_ID))
        throw new Error('Unknown ChatGPT model');
    } else throw new Error('Configure fixture mode or explicit hosted ChatGPT access');
    // Pi and every host query use this SAME queue. Pi 1.2.0 uses unprefixed table names.
    this.harness = await Harness.open(
      await SqliteStorage.open(this.database),
      {
        models,
        registry: createRegistry(),
        settings: {
          stream: { timeoutMs: 90000, maxRetries: 0 },
          retry: { enabled: false, maxRetries: 0 },
        },
        onReport: () => console.error('Prototype assistant needs attention.'),
      },
      context,
    );
    if (this.env.ICLOUD_USERNAME && this.env.ICLOUD_APP_PASSWORD)
      this.transport = new ICloudTransport({
        username: this.env.ICLOUD_USERNAME,
        password: this.env.ICLOUD_APP_PASSWORD,
        calendarName: this.env.ICLOUD_CALENDAR_NAME || 'Household',
        calendarUrl: this.env.ICLOUD_CALENDAR_URL,
      });
    if (
      await this.database.get(
        "SELECT id FROM prototype_jobs WHERE status IN ('queued','running') LIMIT 1",
      )
    )
      await this.schedule(Date.now() + 1000);
  }
  private async schedule(at: number) {
    // Alarm writes share the SQL queue, so a Pi transaction cannot roll them back.
    await this.database.transaction(async () => {
      const existing = await this.ctx.storage.getAlarm();
      if (existing === null || at < existing) await this.ctx.storage.setAlarm(at);
    });
  }
  private cookie(request: Request) {
    return request.url.startsWith('https:') ? '__Host-prototype' : 'prototype';
  }
  private async user(request: Request) {
    const token = request.headers
      .get('cookie')
      ?.split(';')
      .map((x) => x.trim())
      .find((x) => x.startsWith(`${this.cookie(request)}=`))
      ?.split('=')[1];
    const session =
      token &&
      (await this.database.get<{ user_id: string }>(
        'SELECT user_id FROM prototype_sessions WHERE id=? AND expires_at>?',
        digest(token),
        Date.now(),
      ));
    if (!session) throw new RequestError('Sign in to the prototype.', 401);
    return session.user_id;
  }
  async fetch(request: Request): Promise<Response> {
    try {
      await this.ready;
      if (!this.env.APP_ORIGIN || new URL(request.url).origin !== this.env.APP_ORIGIN)
        throw new RequestError('Unconfigured origin.', 503);
      if (
        !['GET', 'HEAD'].includes(request.method) &&
        (request.headers.get('origin') !== this.env.APP_ORIGIN ||
          request.headers.get('x-household-client') !== '1')
      )
        throw new RequestError('Request origin is not allowed.', 403);
      const path = new URL(request.url).pathname;
      if (path === '/api/login' && request.method === 'POST') return await this.login(request);
      const user = await this.user(request);
      if (path === '/api/logout' && request.method === 'POST') {
        const token = request.headers
          .get('cookie')
          ?.split(';')
          .map((x) => x.trim())
          .find((x) => x.startsWith(`${this.cookie(request)}=`))
          ?.split('=')[1];
        await this.database.run('DELETE FROM prototype_sessions WHERE id=?', digest(token || ''));
        return json({ ok: true }, 200, {
          'Set-Cookie': `${this.cookie(request)}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${request.url.startsWith('https:') ? '; Secure' : ''}`,
        });
      }
      if (path === '/api/state' && request.method === 'GET') {
        const jobs = await this.database.all<Job>(
          'SELECT id,user_id,kind,payload,status,due_at,attempts,result FROM prototype_jobs ORDER BY rowid DESC LIMIT 30',
        );
        const root = await this.harness.root(context);
        const entries = await root.entries({ order: 'descending' }, 100, undefined, context);
        const replies = entries.items
          .filter((entry) => entry.kind === 'pi.assistant')
          .flatMap((entry) => entry.model ?? [])
          .filter((message) => message.role === 'assistant')
          .map((message) => ({
            text: message.content
              .filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join('\n'),
          }))
          .reverse();
        return json({
          user,
          mode: this.env.MODEL_MODE,
          bootId: this.bootId,
          alarm: await this.ctx.storage.getAlarm(),
          lastAlarm:
            (
              await this.database.get<{ value: string }>(
                "SELECT value FROM prototype_meta WHERE key='lastAlarm'",
              )
            )?.value ?? null,
          calendarConfigured: Boolean(this.transport),
          pushKey: this.pushEnabled ? this.env.VAPID_PUBLIC_KEY : null,
          jobs,
          replies,
        });
      }
      if (path === '/api/jobs' && request.method === 'POST') {
        const input = z
          .discriminatedUnion('kind', [
            z
              .object({
                id: z.string().uuid(),
                kind: z.literal('chat'),
                text: z.string().trim().min(1).max(4000),
              })
              .strict(),
            z
              .object({
                id: z.string().uuid(),
                kind: z.literal('reminder'),
                seconds: z.number().int().min(5).max(86400),
              })
              .strict(),
            z.object({ id: z.string().uuid(), kind: z.literal('calendar') }).strict(),
          ])
          .parse(await body(request));
        if (input.kind === 'calendar' && !this.transport)
          throw new RequestError('Configure iCloud credentials first.', 503);
        const payload = JSON.stringify(input);
        // Admission, idempotency, queue capacity, and its wakeup commit together.
        await this.database.transaction(async (tx) => {
          const prior = await tx.get<Job>('SELECT * FROM prototype_jobs WHERE id=?', input.id);
          if (prior && (prior.user_id !== user || prior.payload !== payload))
            throw new RequestError('This request ID has already been used.', 409);
          const dueAt =
            prior?.due_at ?? Date.now() + (input.kind === 'reminder' ? input.seconds * 1000 : 0);
          if (!prior) {
            const count = await tx.get<{ count: number }>(
              "SELECT COUNT(*) AS count FROM prototype_jobs WHERE status IN ('queued','running')",
            );
            if (count!.count >= 10)
              throw new RequestError('Ten jobs are already waiting. Let them finish.', 429);
            await tx.run(
              'INSERT INTO prototype_jobs(id,user_id,kind,payload,due_at) VALUES (?,?,?,?,?)',
              input.id,
              user,
              input.kind,
              payload,
              dueAt,
            );
          }
          if (!prior || ['queued', 'running'].includes(prior.status)) {
            const existing = await this.ctx.storage.getAlarm();
            if (existing === null || dueAt < existing) await this.ctx.storage.setAlarm(dueAt);
          }
        });
        return json({ id: input.id }, 202);
      }
      if (path === '/api/push' && request.method === 'POST') {
        if (!this.pushEnabled)
          throw new RequestError('Configure stable VAPID keys and PUSH_CONTACT.', 503);
        const subscription = z
          .object({
            endpoint: z.string().url().refine(validPushEndpoint),
            expirationTime: z.number().nullable().optional(),
            keys: z.object({
              p256dh: z.string().min(20).max(256),
              auth: z.string().min(10).max(256),
            }),
          })
          .parse(await body(request));
        await this.database.run(
          'INSERT INTO prototype_subscriptions VALUES (?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,value=excluded.value',
          subscription.endpoint,
          user,
          JSON.stringify(subscription),
        );
        return json({ ok: true });
      }
      throw new RequestError('Not found.', 404);
    } catch (error) {
      if (error instanceof RequestError) return json({ error: error.message }, error.status);
      if (error instanceof z.ZodError) return json({ error: 'Check the request fields.' }, 400);
      // Never expose provider errors, calendar URLs, credentials, or stack traces.
      console.error('Prototype request failed.');
      return json({ error: 'Prototype request failed. Check its configuration and retry.' }, 503);
    }
  }
  private async login(request: Request) {
    if (
      (this.env.OWNER_PASSWORD?.length ?? 0) < 12 ||
      (this.env.PARTNER_PASSWORD?.length ?? 0) < 12 ||
      this.env.OWNER_PASSWORD === this.env.PARTNER_PASSWORD
    )
      throw new RequestError('Configure two distinct passwords of at least 12 characters.', 503);
    const input = z
      .object({ username: z.enum(['owner', 'partner']), password: z.string().max(1024) })
      .strict()
      .parse(await body(request));
    const key = digest(request.headers.get('cf-connecting-ip') || 'local');
    const now = Date.now();
    // Reserve a rate-limit attempt before checking the password.
    await this.database.transaction(async (tx) => {
      await tx.run('DELETE FROM prototype_attempts WHERE until_at<=?', now);
      const row = await tx.get<{ count: number }>(
        'SELECT count FROM prototype_attempts WHERE id=?',
        key,
      );
      if ((row?.count ?? 0) >= 10)
        throw new RequestError('Too many sign-in attempts. Wait 15 minutes.', 429);
      await tx.run(
        'INSERT INTO prototype_attempts VALUES (?,1,?) ON CONFLICT(id) DO UPDATE SET count=count+1',
        key,
        now + 900000,
      );
    });
    const expected =
      input.username === 'owner' ? this.env.OWNER_PASSWORD : this.env.PARTNER_PASSWORD;
    if (!timingSafeEqual(Buffer.from(digest(input.password)), Buffer.from(digest(expected))))
      throw new RequestError('Incorrect username or password.', 401);
    const token = randomBytes(32).toString('base64url');
    await this.database.run('DELETE FROM prototype_sessions WHERE expires_at<=?', now);
    await this.database.run(
      'INSERT INTO prototype_sessions VALUES (?,?,?)',
      digest(token),
      input.username,
      now + 86400000,
    );
    return json({ user: input.username }, 200, {
      'Set-Cookie': `${this.cookie(request)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${request.url.startsWith('https:') ? '; Secure' : ''}`,
    });
  }
  private get pushEnabled() {
    return Boolean(
      this.env.PUSH_CONTACT && this.env.VAPID_PUBLIC_KEY && this.env.VAPID_PRIVATE_KEY,
    );
  }
  async alarm() {
    await this.ready;
    if (this.processing) return;
    this.processing = true;
    // Arm a recovery wakeup before doing network work. Each job's completion is persisted.
    try {
      await this.schedule(Date.now() + 60000);
      await this.database.run(
        "INSERT INTO prototype_meta VALUES ('lastAlarm',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        new Date().toISOString(),
      );
      const jobs = await this.database.all<Job>(
        "SELECT * FROM prototype_jobs WHERE status IN ('queued','running') AND due_at<=? ORDER BY due_at,rowid LIMIT 2",
        Date.now(),
      );
      for (const job of jobs) {
        await this.database.run(
          "UPDATE prototype_jobs SET status='running',attempts=attempts+1 WHERE id=?",
          job.id,
        );
        try {
          let result: string;
          if (job.kind === 'chat') result = await this.chat(job);
          else if (job.kind === 'calendar') result = await this.calendar();
          else result = await this.remind(job);
          await this.database.run(
            "UPDATE prototype_jobs SET status='done',result=? WHERE id=?",
            result,
            job.id,
          );
        } catch {
          // Network failures remain visible. Non-AI probes get bounded automatic retries.
          if (job.kind !== 'chat' && job.attempts < 2)
            await this.database.run(
              "UPDATE prototype_jobs SET status='queued',due_at=?,result='Probe failed; retry scheduled.' WHERE id=?",
              Date.now() + 30000 * (job.attempts + 1),
              job.id,
            );
          else
            await this.database.run(
              "UPDATE prototype_jobs SET status='error',result='Probe failed. Check connection settings before creating a new test.' WHERE id=?",
              job.id,
            );
        }
      }
    } finally {
      this.processing = false;
      await this.database.transaction(async (tx) => {
        const next = await tx.get<{ due: number }>(
          "SELECT MIN(due_at) AS due FROM prototype_jobs WHERE status IN ('queued','running')",
        );
        if (next?.due != null)
          await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, next.due));
        else await this.ctx.storage.deleteAlarm();
      });
    }
  }
  private async chat(job: Job) {
    const root = await this.harness.root(context);
    await root.configure({ model: this.model, thinkingLevel: 'low' }, context);
    if (this.env.MODEL_MODE === 'fixture')
      this.fixture.setResponses([
        fauxAssistantMessage(
          'Fixture response: Pi persisted and completed this request inside a Cloudflare Durable Object. No AI provider was called.',
        ),
      ]);
    const text = JSON.parse(job.payload).text as string;
    const submission = await root.submit(
      { type: 'input', requestId: job.id, whenBusy: 'reject', content: `${job.user_id}: ${text}` },
      context,
    );
    const settled = await submission.wait(context);
    if (settled.status !== 'done') throw new Error('Assistant did not finish');
    return 'Pi request completed. Its request ID is safe to resubmit.';
  }
  private async calendar() {
    if (!this.transport) throw new Error('Calendar not configured');
    return probeCalendar(this.transport);
  }
  private async remind(job: Job) {
    return deliverReminder(this.database, job.id, job.user_id, {
      subject: this.env.PUSH_CONTACT!,
      publicKey: this.env.VAPID_PUBLIC_KEY!,
      privateKey: this.env.VAPID_PRIVATE_KEY!,
    });
  }
}
