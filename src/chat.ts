import { DurableObject } from 'cloudflare:workers';
import {
  finishSignIn,
  listModels,
  refresh,
  respond,
  returnedCode,
  startSignIn,
  type Credential,
  type PendingSignIn,
  type Turn,
} from './chatgpt';
import type { Env } from './worker';

type Message = {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  reasoning: string;
  error: string | null;
  at: number;
};

/** How many recent messages the model sees. */
const historyLimit = 50;
const signInLifetime = 10 * 60_000;

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** A reply in progress, streamed to every page following it as lines of JSON. */
class Reply {
  reasoning = '';
  text = '';
  private listeners = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  private encoder = new TextEncoder();
  send(event: object, to: Iterable<WritableStreamDefaultWriter<Uint8Array>> = this.listeners) {
    const line = this.encoder.encode(`${JSON.stringify(event)}\n`);
    // A page that went away just stops listening; the reply carries on.
    for (const writer of to) writer.write(line).catch(() => this.listeners.delete(writer));
  }
  follow() {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    this.listeners.add(writer);
    this.send({ type: 'snapshot', reasoning: this.reasoning, text: this.text }, [writer]);
    return new Response(readable, {
      headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' },
    });
  }
  end() {
    for (const writer of this.listeners) writer.close().catch(() => {});
    this.listeners.clear();
  }
}

/** The one chat: its messages, the ChatGPT sign-in and the chosen model. */
export class Chat extends DurableObject<Env> {
  private sql = this.ctx.storage.sql;
  private reply?: Reply;
  private refreshing?: Promise<Credential>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      reasoning TEXT NOT NULL DEFAULT '',
      error TEXT,
      at INTEGER NOT NULL
    )`);
  }

  async fetch(request: Request) {
    const route = `${request.method} ${new URL(request.url).pathname}`;
    try {
      switch (route) {
        case 'GET /api/chat':
          return json({ messages: this.messages(), replying: Boolean(this.reply) });
        case 'POST /api/chat':
          return await this.send(request);
        case 'POST /api/chat/retry':
          return this.retry();
        case 'GET /api/chat/stream':
          return this.reply?.follow() ?? new Response(null, { status: 204 });
        case 'GET /api/admin':
          return json({
            connected: Boolean(await this.ctx.storage.get('chatgpt')),
            model: (await this.ctx.storage.get<string>('model')) ?? null,
          });
        case 'GET /api/admin/models':
          return json({ models: await listModels(await this.token()) });
        case 'POST /api/admin/connect':
          return json({ url: await this.signIn() });
        case 'POST /api/admin/finish':
          await this.finish(request);
          return json({ connected: true });
        case 'POST /api/admin/model':
          await this.choose(request);
          return json({ ok: true });
        case 'POST /api/admin/disconnect':
          await this.ctx.storage.delete(['chatgpt', 'signIn']);
          return json({ connected: false });
      }
      return json({ error: 'Not found.' }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Something went wrong.' }, 400);
    }
  }

  private messages() {
    return this.sql.exec<Message>('SELECT * FROM messages ORDER BY id').toArray();
  }

  private async send(request: Request) {
    const { text } = await request.json<{ text?: unknown }>();
    if (typeof text !== 'string' || !text.trim()) throw new Error('Write a message first.');
    if (this.reply) return json({ error: 'Wait for the current reply.' }, 409);
    this.sql.exec(
      'INSERT INTO messages (role, text, at) VALUES (?, ?, ?)',
      'user',
      text.trim(),
      Date.now(),
    );
    return this.answer();
  }

  /** Answer the last message again, replacing a failed reply. */
  private retry() {
    if (this.reply) return json({ error: 'Wait for the current reply.' }, 409);
    const [last] = this.sql
      .exec<Message>('SELECT * FROM messages ORDER BY id DESC LIMIT 1')
      .toArray();
    if (last?.role === 'assistant' && last.error)
      this.sql.exec('DELETE FROM messages WHERE id = ?', last.id);
    else if (last?.role !== 'user') throw new Error('There is nothing to retry.');
    return this.answer();
  }

  /** Start a reply and follow it; it finishes and is saved even if the page goes away. */
  private answer() {
    const reply = (this.reply = new Reply());
    const response = reply.follow();
    this.ctx.waitUntil(this.run(reply));
    return response;
  }

  private async run(reply: Reply) {
    let error: string | null = null;
    try {
      const model = await this.ctx.storage.get<string>('model');
      if (!model) throw new Error('Choose a model on the admin page.');
      const turns = this.sql
        .exec<Message>(
          `SELECT * FROM messages WHERE error IS NULL AND text != '' ORDER BY id DESC LIMIT ?`,
          historyLimit,
        )
        .toArray()
        .reverse()
        .map((message): Turn => ({ role: message.role, text: message.text }));
      for await (const delta of respond(await this.token(), model, turns)) {
        if ('reasoning' in delta) reply.reasoning += delta.reasoning;
        else reply.text += delta.text;
        reply.send({ type: 'delta', ...delta });
      }
    } catch (failure) {
      error = failure instanceof Error ? failure.message : 'ChatGPT couldn’t answer.';
    }
    const message = this.sql
      .exec<Message>(
        'INSERT INTO messages (role, text, reasoning, error, at) VALUES (?, ?, ?, ?, ?) RETURNING *',
        'assistant',
        reply.text,
        reply.reasoning.trim(),
        error,
        Date.now(),
      )
      .one();
    this.reply = undefined;
    reply.send({ type: 'done', message });
    reply.end();
  }

  /** A current ChatGPT token, refreshed when it has expired. */
  private async token() {
    const credential = await this.ctx.storage.get<Credential>('chatgpt');
    if (!credential) throw new Error('Connect ChatGPT on the admin page.');
    if (Date.now() < credential.expires) return credential.access;
    // One refresh at a time: OpenAI may accept each refresh token only once.
    this.refreshing ??= refresh(credential)
      .then(async (fresh) => {
        // Keep it only if ChatGPT wasn't disconnected or reconnected meanwhile.
        const current = await this.ctx.storage.get<Credential>('chatgpt');
        if (current?.refresh === credential.refresh) await this.ctx.storage.put('chatgpt', fresh);
        return fresh;
      })
      .finally(() => (this.refreshing = undefined));
    return (await this.refreshing).access;
  }

  private async signIn() {
    // A stable id lets ChatGPT recognize this installation when it reconnects.
    let hostId = await this.ctx.storage.get<string>('hostId');
    if (!hostId) await this.ctx.storage.put('hostId', (hostId = crypto.randomUUID()));
    const { url, pending } = await startSignIn(hostId);
    await this.ctx.storage.put('signIn', pending);
    return url;
  }

  private async finish(request: Request) {
    const { address } = await request.json<{ address?: unknown }>();
    const pending = await this.ctx.storage.get<PendingSignIn>('signIn');
    if (!pending || Date.now() - pending.startedAt > signInLifetime)
      throw new Error('That sign-in has expired. Start again.');
    const returned = returnedCode(String(address ?? ''), pending);
    // A sign-in finishes at most once, whatever OpenAI answers.
    await this.ctx.storage.delete('signIn');
    await this.ctx.storage.put('chatgpt', await finishSignIn(returned, pending));
  }

  private async choose(request: Request) {
    const { model } = await request.json<{ model?: unknown }>();
    if (typeof model !== 'string' || !model.trim()) throw new Error('Choose a model.');
    await this.ctx.storage.put('model', model.trim());
  }
}
