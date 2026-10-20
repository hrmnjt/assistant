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

type Thread = { id: number; title: string; at: number; updated: number };
type Message = {
  id: number;
  thread: number;
  role: 'user' | 'assistant';
  text: string;
  reasoning: string;
  error: string | null;
  at: number;
};

/** How many recent messages of a thread the model sees. */
const historyLimit = 50;
const signInLifetime = 10 * 60_000;

const json = (body: unknown, status = 200) => Response.json(body, { status });
/** A thread is titled with its first message, shortened. */
const titleOf = (text: string) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
};

/** A reply in progress, streamed to every page following it as lines of JSON. */
class Reply {
  reasoning = '';
  text = '';
  private listeners = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  private encoder = new TextEncoder();
  constructor(readonly thread: number) {}
  send(event: object, to: Iterable<WritableStreamDefaultWriter<Uint8Array>> = this.listeners) {
    const line = this.encoder.encode(`${JSON.stringify(event)}\n`);
    // A page that went away just stops listening; the reply carries on.
    for (const writer of to) writer.write(line).catch(() => this.listeners.delete(writer));
  }
  follow() {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    this.listeners.add(writer);
    const snapshot = { thread: this.thread, reasoning: this.reasoning, text: this.text };
    this.send({ type: 'snapshot', ...snapshot }, [writer]);
    return new Response(readable, {
      headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' },
    });
  }
  end() {
    for (const writer of this.listeners) writer.close().catch(() => {});
    this.listeners.clear();
  }
}

/** The chats: their threads and messages, the ChatGPT sign-in and the chosen model. */
export class Chat extends DurableObject<Env> {
  private sql = this.ctx.storage.sql;
  /** Replies in progress, at most one per thread. */
  private replies = new Map<number, Reply>();
  private refreshing?: Promise<Credential>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Pages ping to keep their WebSocket open; the answer doesn't wake this object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    this.sql.exec(`CREATE TABLE IF NOT EXISTS threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      at INTEGER NOT NULL,
      updated INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread INTEGER,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      reasoning TEXT NOT NULL DEFAULT '',
      error TEXT,
      at INTEGER NOT NULL
    )`);
    // The first version kept a single conversation; it becomes the first thread.
    const columns = this.sql.exec<{ name: string }>(`SELECT name FROM pragma_table_info('messages')`);
    if (!columns.toArray().some((column) => column.name === 'thread'))
      ctx.storage.transactionSync(() => {
        this.sql.exec('ALTER TABLE messages ADD COLUMN thread INTEGER');
        const [first] = this.sql
          .exec<Message>(`SELECT * FROM messages WHERE role = 'user' ORDER BY id LIMIT 1`)
          .toArray();
        if (first) this.sql.exec('UPDATE messages SET thread = ?', this.newThread(first.text));
      });
  }

  async fetch(request: Request) {
    const { pathname } = new URL(request.url);
    const id = Number(pathname.match(/^\/api\/threads\/(\d+)/)?.[1]);
    const route = `${request.method} ${pathname.replace(/^\/api\/threads\/\d+/, '/api/threads/:id')}`;
    try {
      switch (route) {
        case 'GET /api/threads':
          return json({ threads: this.threads() });
        case 'POST /api/threads':
          return await this.start(request);
        case 'GET /api/threads/:id':
          return json({
            ...this.thread(id),
            messages: this.sql
              .exec<Message>('SELECT * FROM messages WHERE thread = ? ORDER BY id', id)
              .toArray(),
            replying: this.replies.has(id),
          });
        case 'DELETE /api/threads/:id':
          this.remove(id);
          return json({ ok: true });
        case 'POST /api/threads/:id/messages':
          return await this.send(id, request);
        case 'POST /api/threads/:id/retry':
          return this.retry(id);
        case 'GET /api/threads/:id/stream':
          return this.replies.get(id)?.follow() ?? new Response(null, { status: 204 });
        case 'GET /api/events':
          return this.listen(request);
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

  /** The threads, most recently active first. */
  private threads() {
    return this.sql
      .exec<Thread>('SELECT * FROM threads ORDER BY updated DESC')
      .toArray()
      .map((thread) => ({ ...thread, replying: this.replies.has(thread.id) }));
  }

  private thread(id: number) {
    const [thread] = this.sql.exec<Thread>('SELECT * FROM threads WHERE id = ?', id).toArray();
    if (!thread) throw new Error('That chat no longer exists.');
    return thread;
  }

  private newThread(firstMessage: string) {
    const now = Date.now();
    return this.sql
      .exec<{ id: number }>(
        'INSERT INTO threads (title, at, updated) VALUES (?, ?, ?) RETURNING id',
        titleOf(firstMessage),
        now,
        now,
      )
      .one().id;
  }

  private remove(id: number) {
    this.thread(id);
    if (this.replies.has(id)) throw new Error('Wait for the reply to finish, then delete the chat.');
    this.sql.exec('DELETE FROM messages WHERE thread = ?', id);
    this.sql.exec('DELETE FROM threads WHERE id = ?', id);
    this.changed(id);
  }

  /** A WebSocket that tells a page whenever a thread changes, from any page or device. */
  private listen(request: Request) {
    if (request.headers.get('upgrade') !== 'websocket')
      return json({ error: 'Expected a WebSocket.' }, 426);
    const [page, socket] = Object.values(new WebSocketPair());
    // Hibernatable: open sockets don't keep this object awake between changes.
    this.ctx.acceptWebSocket(socket);
    return new Response(null, { status: 101, webSocket: page });
  }

  /** Tell every open page that a thread changed; each fetches it again. */
  private changed(thread: number) {
    const event = JSON.stringify({ thread });
    for (const socket of this.ctx.getWebSockets())
      try {
        socket.send(event);
      } catch {
        // That page is going away.
      }
  }

  private async text(request: Request) {
    const { text } = await request.json<{ text?: unknown }>();
    if (typeof text !== 'string' || !text.trim()) throw new Error('Write a message first.');
    return text.trim();
  }

  private addMessage(thread: number, text: string) {
    const now = Date.now();
    this.sql.exec(
      'INSERT INTO messages (thread, role, text, at) VALUES (?, ?, ?, ?)',
      thread,
      'user',
      text,
      now,
    );
    this.sql.exec('UPDATE threads SET updated = ? WHERE id = ?', now, thread);
  }

  /** Start a thread with its first message. */
  private async start(request: Request) {
    const text = await this.text(request);
    const thread = this.newThread(text);
    this.addMessage(thread, text);
    return this.answer(thread);
  }

  private async send(thread: number, request: Request) {
    const text = await this.text(request);
    this.thread(thread);
    if (this.replies.has(thread)) return json({ error: 'Wait for the current reply.' }, 409);
    this.addMessage(thread, text);
    return this.answer(thread);
  }

  /** Answer a thread's last message again, replacing a failed reply. */
  private retry(thread: number) {
    this.thread(thread);
    if (this.replies.has(thread)) return json({ error: 'Wait for the current reply.' }, 409);
    const [last] = this.sql
      .exec<Message>('SELECT * FROM messages WHERE thread = ? ORDER BY id DESC LIMIT 1', thread)
      .toArray();
    if (last?.role === 'assistant' && last.error)
      this.sql.exec('DELETE FROM messages WHERE id = ?', last.id);
    else if (last?.role !== 'user') throw new Error('There is nothing to retry.');
    return this.answer(thread);
  }

  /** Start a reply and follow it; it finishes and is saved even if the page goes away. */
  private answer(thread: number) {
    const reply = new Reply(thread);
    this.replies.set(thread, reply);
    this.changed(thread);
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
          `SELECT * FROM messages WHERE thread = ? AND error IS NULL AND text != ''
           ORDER BY id DESC LIMIT ?`,
          reply.thread,
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
    const now = Date.now();
    const message = this.sql
      .exec<Message>(
        `INSERT INTO messages (thread, role, text, reasoning, error, at)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
        reply.thread,
        'assistant',
        reply.text,
        reply.reasoning.trim(),
        error,
        now,
      )
      .one();
    this.sql.exec('UPDATE threads SET updated = ? WHERE id = ?', now, reply.thread);
    this.replies.delete(reply.thread);
    this.changed(reply.thread);
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
