import { z } from 'zod';
import type { Row, Store } from './database.js';
import type { Auth } from './auth.js';
import { previewOwner } from './changes.js';
import { DomainError } from './errors.js';
import { email, personName, type Household } from './household.js';
import type { Conversations } from './conversations.js';
import type { AssistantModel } from './ai.js';
import { validPushEndpoint, type Notices } from './notices.js';
import type { ApiRoute, Plugin } from './plugin.js';
import { CalendarOutcomeError } from './plugins/calendar/service.js';
import { recoverablePreviews } from './preview-recovery.js';
import { body, json, RequestError } from './http.js';
import { Settings } from './settings.js';
import type { Person, Snapshot } from '../src/types.js';

/** The assistant behind `/api`: one instance per runtime. */
export type App = {
  db: Store;
  auth: Auth;
  household: Household;
  conversations: Conversations;
  /** The assistant's model, chosen in Settings. */
  assistantModel: AssistantModel;
  notices: Notices;
  /** Features beyond the conversation: tasks, the calendar, the dashboard. */
  plugins: readonly Plugin[];
};

/** Handle one `/api` request. */
export async function handle(app: App, request: Request): Promise<Response> {
  const { auth } = app;
  try {
    const url = new URL(request.url);
    if (!auth.served(request))
      throw new RequestError('This development server answers only on this computer.', 403);
    if (url.pathname === '/api/health' && request.method === 'GET')
      return json({ ok: app.conversations.healthy });
    if (!auth.writeAllowed(request)) throw new RequestError('Request origin is not allowed.', 403);
    const caller = await auth.caller(request);
    if (!caller)
      throw new RequestError(
        'Sign in through Cloudflare Access with one of the two email addresses set up for this assistant.',
        401,
      );
    if ('setup' in caller) return await setUp(app, request, caller.setup.email);
    const me = caller.person;
    for (const route of routes(app)) {
      const match = route.path.exec(url.pathname);
      if (match && route.method === request.method)
        return await route.handle(request, me, match.slice(1));
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
    if (error instanceof RequestError) return json({ error: error.message }, error.status);
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

/**
 * Before the household is set up, the first person to sign in names both
 * people and gives the other person's email; nothing else is available yet.
 */
async function setUp(app: App, request: Request, signedIn: string | null) {
  const url = new URL(request.url);
  const development = app.auth.mode === 'development';
  if (url.pathname === '/api/setup' && request.method === 'POST') {
    const input = z
      .object({
        name: personName,
        partner: z
          .object({ name: personName, email: development ? email.optional() : email })
          .strict(),
      })
      .strict()
      .parse(await body(request));
    await app.household.setUp({ name: input.name, email: signedIn ?? undefined }, input.partner);
    // The app's own address, as Web Push's contact.
    await new Settings(app.db).set('origin', url.origin);
    return json({ ok: true });
  }
  return json(
    { error: 'Set up the assistant first.', setup: { email: signedIn, development } },
    428,
  );
}

function routes(app: App): ApiRoute[] {
  const { db, auth, household, conversations, assistantModel, notices, plugins } = app;
  const onlySetUpBy = (me: Person) => {
    if (me.id !== 'owner')
      throw new DomainError('Only the person who set up the assistant manages this.', 403);
  };
  const id = '([^/]+)';
  const owners = [household.changes, ...plugins.flatMap((plugin) => plugin.changes ?? [])];
  const route = (method: string, path: RegExp, handle: ApiRoute['handle']): ApiRoute => ({
    method,
    path,
    handle,
  });
  return [
    route('GET', /^\/api\/state$/, async (_request, me) => {
      const base: Omit<Snapshot, 'tasks' | 'calendar'> = {
        me,
        signIn: auth.mode,
        people: await household.people(),
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
          calendar: 'not-connected',
          ai: conversations.configured
            ? 'configured'
            : (await assistantModel.connected())
              ? 'needs-model'
              : 'not-connected',
        },
      };
      // Each plugin adds its part; integration statuses merge rather than replace.
      let state = base as Snapshot;
      for (const plugin of plugins) {
        const part = (await plugin.snapshot?.(me)) ?? {};
        state = {
          ...state,
          ...part,
          integrations: { ...state.integrations, ...part.integrations },
        };
      }
      return json(state);
    }),
    route('POST', /^\/api\/people\/me$/, async (request, me) => {
      const input = z
        .object({ name: personName })
        .strict()
        .parse(await body(request));
      await household.rename(me.id, input.name);
      return json({ ok: true });
    }),
    // The person who set up the household can correct the other person's email.
    route('POST', /^\/api\/people\/partner$/, async (request, me) => {
      onlySetUpBy(me);
      const input = z
        .object({ email })
        .strict()
        .parse(await body(request));
      await household.changeEmail('partner', input.email);
      return json({ ok: true });
    }),
    route('GET', /^\/api\/assistant\/models$/, async (_request, me) => {
      onlySetUpBy(me);
      return json(await assistantModel.catalog());
    }),
    route('POST', /^\/api\/assistant\/model$/, async (request, me) => {
      onlySetUpBy(me);
      const input = z
        .object({ id: z.string().min(1).max(100) })
        .strict()
        .parse(await body(request));
      await assistantModel.choose(input.id);
      return json({ ok: true });
    }),
    route('GET', /^\/api\/previews$/, async (_request, me) =>
      json(await recoverablePreviews(db, me.id, household.clock())),
    ),
    route('POST', /^\/api\/previews$/, async (request, me) => {
      const input = await body(request);
      const owner = owners.find((item) => item.kinds.includes(String(input?.kind)));
      if (!owner) throw new DomainError('Choose a supported change.');
      return json(await owner.preview(me.id, input), 201);
    }),
    route('POST', new RegExp(`^/api/previews/${id}/confirm$`), async (_request, me, [previewId]) =>
      json(await (await previewOwner(db, owners, me.id, previewId)).confirm(me.id, previewId)),
    ),
    route('POST', new RegExp(`^/api/previews/${id}/dismiss$`), async (request, me, [previewId]) => {
      z.object({ acknowledgeUncertain: z.literal(true) })
        .strict()
        .parse(await body(request));
      const owner = await previewOwner(db, owners, me.id, previewId).catch(() => null);
      if (!owner?.dismiss) throw new DomainError('This calendar preview is unavailable.', 404);
      await owner.dismiss(me.id, previewId);
      return json({ ok: true });
    }),
    route('DELETE', new RegExp(`^/api/previews/${id}$`), async (_request, me, [previewId]) => {
      const owner = await previewOwner(db, owners, me.id, previewId).catch(() => null);
      // Cancelling something already gone is not an error.
      await owner?.cancel(me.id, previewId);
      return json({ ok: true });
    }),
    route('POST', /^\/api\/notices\/read$/, async (request, me) => {
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
    }),
    route('GET', new RegExp(`^/api/threads/${id}/messages$`), async (_request, _me, [threadId]) =>
      json(await conversations.messages(threadId)),
    ),
    route('GET', new RegExp(`^/api/threads/${id}/assistant$`), async (_request, _me, [threadId]) =>
      json(await conversations.status(threadId)),
    ),
    route('POST', new RegExp(`^/api/threads/${id}/messages$`), async (request, me, [threadId]) => {
      const input = z
        .object({
          text: z.string().trim().min(1).max(10000),
          requestId: z.string().uuid(),
          askAssistant: z.boolean().optional(),
        })
        .strict()
        .parse(await body(request));
      return json(
        await conversations.send(threadId, me.id, input.text, input.requestId, input.askAssistant),
      );
    }),
    route('POST', /^\/api\/presence$/, async (request, me) => {
      const value = z
        .object({
          threadId: z.string().uuid().nullable(),
          clientId: z.string().uuid(),
          typing: z.boolean(),
        })
        .strict()
        .parse(await body(request));
      if (!value.threadId)
        await db.run('DELETE FROM presence WHERE user_id=? AND client_id=?', me.id, value.clientId);
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
    }),
    route('GET', /^\/api\/push\/key$/, async () => {
      if (!notices.enabled)
        throw new DomainError(
          'Phone notification setup is pending. Your reminders are available inside the app.',
          503,
        );
      return json({ publicKey: notices.publicKey });
    }),
    route('POST', /^\/api\/push\/subscription$/, async (request, me) => {
      if (!notices.enabled) throw new DomainError('Phone notification setup is pending.', 503);
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
    }),
    route('DELETE', /^\/api\/push\/subscription$/, async (request, me) => {
      const value = z.object({ endpoint: z.string() }).parse(await body(request));
      await db.run(
        'DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?',
        value.endpoint,
        me.id,
      );
      return json({ ok: true });
    }),
    ...plugins.flatMap((plugin) => plugin.routes ?? []),
  ];
}
