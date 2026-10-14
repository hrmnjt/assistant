import express from 'express';
import { z } from 'zod';
import type { Database } from './database.js';
import { auth } from './auth.js';
import { DomainError, Household } from './domain.js';
import type { Conversations } from './conversations.js';
import { validPushEndpoint, type Reminders } from './reminders.js';
import type { Person, Snapshot } from '../src/types.js';
import type { CalendarService } from './calendar.js';

export function createApp(
  db: Database,
  household: Household,
  conversations: Conversations,
  reminders: Reminders,
  origin: string,
  calendar?: CalendarService,
) {
  const app = express();
  app.disable('x-powered-by');
  // Listen on loopback; only the local tunnel/reverse proxy can reach this server.
  app.set('trust proxy', 'loopback');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  const accounts = auth(db, origin);
  app.use('/api', accounts.writeGuard);
  app.post('/api/login', accounts.login);
  app.use('/api', accounts.requireUser, (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.post('/api/logout', accounts.logout);
  app.get('/api/state', (_req, res) => {
    const me: Person = res.locals.me;
    const state: Snapshot = {
      me,
      people: household.people(),
      tasks: household.tasks(),
      preferences: household.preferences(me.id),
      threads: household.threads(),
      presence: db.sql
        .prepare(
          'SELECT user_id AS userId,thread_id AS threadId,MAX(typing) AS typing FROM presence WHERE seen_at>? GROUP BY user_id,thread_id',
        )
        .all(Date.now() - 30_000)
        .map((row) => ({
          userId: String(row.userId),
          threadId: String(row.threadId),
          typing: Boolean(row.typing),
        })),
      notices: db.sql
        .prepare(
          'SELECT id,title,body,created_at AS createdAt FROM notices WHERE user_id=? ORDER BY created_at DESC LIMIT 20',
        )
        .all(me.id) as unknown as Snapshot['notices'],
      integrations: {
        calendar: calendar?.snapshot().status ?? 'not-connected',
        ai: 'not-connected',
      },
      calendar: calendar?.snapshot() ?? {
        status: 'not-connected',
        name: 'Household',
        syncedAt: null,
        error: null,
        events: [],
      },
    };
    res.json(state);
  });
  app.post('/api/previews', async (req, res) => {
    if (typeof req.body?.kind === 'string' && req.body.kind.startsWith('calendar.')) {
      if (!calendar) throw new DomainError('The shared calendar is not connected yet.', 503);
      res.status(201).json(await calendar.preview(res.locals.me.id, req.body));
    } else res.status(201).json(household.preview(res.locals.me.id, req.body));
  });
  app.post('/api/previews/:id/confirm', async (req, res) => {
    const id = String(req.params.id);
    const actorId = res.locals.me.id;
    res.json(
      calendar?.isCalendarPreview(id, actorId)
        ? await calendar.confirm(actorId, id)
        : household.confirm(actorId, id),
    );
  });
  app.delete('/api/previews/:id', (req, res) => {
    const id = String(req.params.id);
    const actorId = res.locals.me.id;
    if (calendar?.isCalendarPreview(id, actorId)) calendar.cancel(actorId, id);
    else household.cancel(actorId, id);
    res.json({ ok: true });
  });
  app.post('/api/calendar/refresh', async (_req, res) => {
    if (!calendar) throw new DomainError('The shared calendar is not connected yet.', 503);
    await calendar.sync();
    res.json(calendar.snapshot());
  });
  app.get('/api/threads/:id/messages', async (req, res) =>
    res.json(await conversations.messages(String(req.params.id))),
  );
  app.post('/api/threads/:id/messages', async (req, res) => {
    const input = z
      .object({ text: z.string().trim().min(1).max(10000), requestId: z.string().uuid() })
      .strict()
      .parse(req.body);
    res.json(
      await conversations.send(
        String(req.params.id),
        res.locals.me.id,
        input.text,
        input.requestId,
      ),
    );
  });
  app.post('/api/presence', (req, res) => {
    const value = z
      .object({
        threadId: z.string().uuid().nullable(),
        clientId: z.string().uuid(),
        typing: z.boolean(),
      })
      .strict()
      .parse(req.body);
    if (!value.threadId)
      db.sql
        .prepare('DELETE FROM presence WHERE user_id=? AND client_id=?')
        .run(res.locals.me.id, value.clientId);
    else {
      if (!db.sql.prepare('SELECT id FROM threads WHERE id=?').get(value.threadId))
        throw new DomainError('Conversation not found.', 404);
      db.sql
        .prepare(
          'INSERT INTO presence VALUES (?,?,?,?,?) ON CONFLICT(user_id,client_id) DO UPDATE SET thread_id=excluded.thread_id, typing=excluded.typing, seen_at=excluded.seen_at',
        )
        .run(res.locals.me.id, value.clientId, value.threadId, value.typing ? 1 : 0, Date.now());
    }
    res.json({ ok: true });
  });
  app.get('/api/push/key', (_req, res) => {
    if (!reminders.enabled)
      throw new DomainError(
        'Phone notification setup is pending. Your reminders are available inside the app.',
        503,
      );
    res.json({ publicKey: reminders.publicKey });
  });
  app.post('/api/push/subscription', (req, res) => {
    if (!reminders.enabled) throw new DomainError('Phone notification setup is pending.', 503);
    const value = z
      .object({
        endpoint: z.string().url().refine(validPushEndpoint, 'Unsupported push service.'),
        expirationTime: z.number().nullable().optional(),
        keys: z.object({ p256dh: z.string().min(20).max(256), auth: z.string().min(10).max(256) }),
      })
      .parse(req.body);
    db.sql
      .prepare(
        'INSERT INTO push_subscriptions VALUES (?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,value=excluded.value',
      )
      .run(value.endpoint, res.locals.me.id, JSON.stringify(value));
    res.json({ ok: true });
  });
  app.delete('/api/push/subscription', (req, res) => {
    const value = z.object({ endpoint: z.string() }).parse(req.body);
    db.sql
      .prepare('DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?')
      .run(value.endpoint, res.locals.me.id);
    res.json({ ok: true });
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use(
    (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (error instanceof DomainError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues.map((issue) => issue.message).join(' ') });
        return;
      }
      if (error instanceof SyntaxError) {
        res.status(400).json({ error: 'Invalid JSON.' });
        return;
      }
      console.error('Request failed:', error instanceof Error ? error.name : 'UnknownError');
      res.status(500).json({
        error: 'Something went wrong. Your change has not been confirmed; refresh before retrying.',
      });
    },
  );
  return app;
}
