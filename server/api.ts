import { z } from 'zod';
import type { Row, Store } from './database.js';
import { Auth, SignInError } from './auth.js';
import { DomainError, type Household } from './domain.js';
import type { Conversations } from './conversations.js';
import { validPushEndpoint, type Reminders } from './reminders.js';
import { CalendarOutcomeError, type CalendarService } from './calendar.js';
import { recoverablePreviews } from './preview-recovery.js';
import { body, json, RequestError } from './http.js';
import type { Person, Snapshot } from '../src/types.js';

/** The household application behind `/api`: one instance per household runtime. */
export type App = {
  db: Store;
  auth: Auth;
  household: Household;
  conversations: Conversations;
  reminders: Reminders;
  calendar: CalendarService;
};
type Route = (request: Request, me: Person, params: string[]) => Promise<Response>;

/** Handle one `/api` request. `client` is the caller's network address, used for sign-in limits. */
export async function handle(app: App, request: Request, client = ''): Promise<Response> {
  const { auth } = app;
  try {
    const url = new URL(request.url);
    // Only the configured origin is served, so a rebinding hostname cannot reach the API.
    if (url.origin !== auth.origin) throw new RequestError('Request origin is not allowed.', 403);
    if (url.pathname === '/api/health' && request.method === 'GET')
      return json({ ok: app.conversations.healthy });
    if (!auth.writeAllowed(request)) throw new RequestError('Request origin is not allowed.', 403);
    if (url.pathname === '/api/login' && request.method === 'POST') {
      const { person, cookie } = await auth.login(await body(request), client);
      return json({ person }, 200, { 'Set-Cookie': cookie });
    }
    const me = await auth.current(request);
    if (!me) throw new RequestError('Please sign in.', 401);
    for (const [method, pattern, route] of routes(app)) {
      const match = pattern.exec(url.pathname);
      if (match && method === request.method) return await route(request, me, match.slice(1));
    }
    throw new RequestError('Not found.', 404);
  } catch (error) {
    if (error instanceof DomainError)
      return json(
        {
          error: error.message,
          ...(error instanceof CalendarOutcomeError
            ? { calendarOutcome: error.calendarOutcome }
            : {}),
        },
        error.status,
      );
    if (error instanceof RequestError || error instanceof SignInError)
      return json({ error: error.message }, error.status);
    if (error instanceof z.ZodError)
      return json({ error: error.issues.map((issue) => issue.message).join(' ') }, 400);
    // Never expose provider errors, calendar URLs, credentials, or stack traces.
    console.error('Request failed:', error instanceof Error ? error.name : 'UnknownError');
    return json(
      {
        error: 'Something went wrong. Your change has not been confirmed; refresh before retrying.',
      },
      500,
    );
  }
}

function routes(app: App): [string, RegExp, Route][] {
  const { db, auth, household, conversations, reminders, calendar } = app;
  const id = '([^/]+)';
  return [
    [
      'POST',
      /^\/api\/logout$/,
      async (request) => json({ ok: true }, 200, { 'Set-Cookie': await auth.logout(request) }),
    ],
    [
      'GET',
      /^\/api\/state$/,
      async (_request, me) => {
        const state: Snapshot = {
          me,
          people: await household.people(),
          tasks: await household.tasks(),
          previews: await recoverablePreviews(db, me.id, household.clock()),
          preferences: await household.preferences(me.id),
          threads: await household.threads(),
          presence: (
            await db.all<Row>(
              'SELECT user_id AS userId,thread_id AS threadId,MAX(typing) AS typing FROM presence WHERE seen_at>? GROUP BY user_id,thread_id',
              Date.now() - 30_000,
            )
          ).map((row) => ({
            userId: String(row.userId),
            threadId: String(row.threadId),
            typing: Boolean(row.typing),
          })),
          notices: await db.all<Snapshot['notices'][number]>(
            `SELECT n.id,n.title,n.body,n.created_at AS createdAt,r.read_at AS readAt,t.kind AS targetKind,t.target_id AS targetId
            FROM notices n LEFT JOIN notice_reads r ON r.notice_id=n.id LEFT JOIN notice_targets t ON t.notice_id=n.id
            WHERE n.user_id=? ORDER BY n.created_at DESC,n.rowid DESC LIMIT 20`,
            me.id,
          ),
          integrations: {
            calendar: calendar.snapshot().status,
            ai: conversations.configured ? 'configured' : 'not-connected',
          },
          calendar: calendar.snapshot(),
        };
        return json(state);
      },
    ],
    [
      'GET',
      new RegExp(`^/api/tasks/${id}/history$`),
      async (_request, _me, [taskId]) => json(await household.history(taskId)),
    ],
    [
      'GET',
      /^\/api\/previews$/,
      async (_request, me) => json(await recoverablePreviews(db, me.id, household.clock())),
    ],
    [
      'POST',
      /^\/api\/previews$/,
      async (request, me) => {
        const input = await body(request);
        if (typeof input?.kind === 'string' && input.kind.startsWith('calendar.')) {
          if (!calendar.connected)
            throw new DomainError('The shared calendar is not connected yet.', 503);
          return json(await calendar.preview(me.id, input), 201);
        }
        return json(await household.preview(me.id, input), 201);
      },
    ],
    [
      'POST',
      new RegExp(`^/api/previews/${id}/confirm$`),
      async (_request, me, [previewId]) =>
        json(
          (await calendar.isCalendarPreview(previewId, me.id))
            ? await calendar.confirm(me.id, previewId)
            : await household.confirm(me.id, previewId),
        ),
    ],
    [
      'POST',
      new RegExp(`^/api/previews/${id}/dismiss$`),
      async (request, me, [previewId]) => {
        z.object({ acknowledgeUncertain: z.literal(true) })
          .strict()
          .parse(await body(request));
        if (!(await calendar.isCalendarPreview(previewId, me.id)))
          throw new DomainError('This calendar preview is unavailable.', 404);
        await calendar.dismiss(me.id, previewId);
        return json({ ok: true });
      },
    ],
    [
      'DELETE',
      new RegExp(`^/api/previews/${id}$`),
      async (_request, me, [previewId]) => {
        if (await calendar.isCalendarPreview(previewId, me.id))
          await calendar.cancel(me.id, previewId);
        else await household.cancel(me.id, previewId);
        return json({ ok: true });
      },
    ],
    [
      'POST',
      /^\/api\/calendar\/refresh$/,
      async () => {
        if (!calendar.connected)
          throw new DomainError('The shared calendar is not connected yet.', 503);
        await calendar.sync();
        return json(calendar.snapshot());
      },
    ],
    [
      'POST',
      /^\/api\/notices\/read$/,
      async (request, me) => {
        const input = z
          .object({ ids: z.array(z.string().min(1).max(500)).max(20) })
          .strict()
          .parse(await body(request));
        await db.transaction(async (tx) => {
          for (const noticeId of input.ids)
            await tx.run(
              'INSERT OR IGNORE INTO notice_reads SELECT id,? FROM notices WHERE id=? AND user_id=?',
              new Date().toISOString(),
              noticeId,
              me.id,
            );
        });
        return json({ ok: true });
      },
    ],
    [
      'GET',
      new RegExp(`^/api/threads/${id}/messages$`),
      async (_request, _me, [threadId]) => json(await conversations.messages(threadId)),
    ],
    [
      'GET',
      new RegExp(`^/api/threads/${id}/assistant$`),
      async (_request, _me, [threadId]) => json(await conversations.status(threadId)),
    ],
    [
      'POST',
      new RegExp(`^/api/threads/${id}/messages$`),
      async (request, me, [threadId]) => {
        const input = z
          .object({
            text: z.string().trim().min(1).max(10000),
            requestId: z.string().uuid(),
            askAssistant: z.boolean().optional(),
          })
          .strict()
          .parse(await body(request));
        return json(
          await conversations.send(
            threadId,
            me.id,
            input.text,
            input.requestId,
            input.askAssistant,
          ),
        );
      },
    ],
    [
      'POST',
      /^\/api\/presence$/,
      async (request, me) => {
        const value = z
          .object({
            threadId: z.string().uuid().nullable(),
            clientId: z.string().uuid(),
            typing: z.boolean(),
          })
          .strict()
          .parse(await body(request));
        if (!value.threadId)
          await db.run(
            'DELETE FROM presence WHERE user_id=? AND client_id=?',
            me.id,
            value.clientId,
          );
        else {
          if (!(await db.get('SELECT id FROM threads WHERE id=?', value.threadId)))
            throw new DomainError('Conversation not found.', 404);
          await db.run(
            'INSERT INTO presence VALUES (?,?,?,?,?) ON CONFLICT(user_id,client_id) DO UPDATE SET thread_id=excluded.thread_id, typing=excluded.typing, seen_at=excluded.seen_at',
            me.id,
            value.clientId,
            value.threadId,
            value.typing ? 1 : 0,
            Date.now(),
          );
        }
        return json({ ok: true });
      },
    ],
    [
      'GET',
      /^\/api\/push\/key$/,
      async () => {
        if (!reminders.enabled)
          throw new DomainError(
            'Phone notification setup is pending. Your reminders are available inside the app.',
            503,
          );
        return json({ publicKey: reminders.publicKey });
      },
    ],
    [
      'POST',
      /^\/api\/push\/subscription$/,
      async (request, me) => {
        if (!reminders.enabled) throw new DomainError('Phone notification setup is pending.', 503);
        const value = z
          .object({
            endpoint: z.string().url().refine(validPushEndpoint, 'Unsupported push service.'),
            expirationTime: z.number().nullable().optional(),
            keys: z.object({
              p256dh: z.string().min(20).max(256),
              auth: z.string().min(10).max(256),
            }),
          })
          .parse(await body(request));
        await db.run(
          'INSERT INTO push_subscriptions VALUES (?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,value=excluded.value',
          value.endpoint,
          me.id,
          JSON.stringify(value),
        );
        return json({ ok: true });
      },
    ],
    [
      'DELETE',
      /^\/api\/push\/subscription$/,
      async (request, me) => {
        const value = z.object({ endpoint: z.string() }).parse(await body(request));
        await db.run(
          'DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?',
          value.endpoint,
          me.id,
        );
        return json({ ok: true });
      },
    ],
  ];
}
