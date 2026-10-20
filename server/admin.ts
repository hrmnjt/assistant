import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Row, Store } from './database.js';
import { DomainError } from './errors.js';
import { body, json, RequestError } from './http.js';
import { identityHeader } from './auth.js';
import { peopleInput } from './household.js';
import { Settings } from './settings.js';
import type { AdminRoute } from './plugin.js';
import type { App } from './api.js';

const cookieName = 'assistant-admin';
const sessionLength = 12 * 60 * 60_000;
const attempts = { limit: 5, window: 15 * 60_000 };
const minimumToken = 32;
const digest = (value: string) => createHash('sha256').update(value).digest();
const hash = (value: string) => digest(value).toString('hex');

/**
 * The admin's sign-in, separate from the two people's. On a deployment the
 * admin page sits behind Cloudflare Access like the rest of the app and also
 * needs ADMIN_TOKEN, a Worker secret of at least 32 characters. A correct
 * token opens a 12-hour session kept (hashed) in this database; changing the
 * secret ends every session. Five wrong tokens lock sign-in for 15 minutes. A
 * development server answers only on this computer and needs no token.
 */
export class AdminAuth {
  constructor(
    private db: Store,
    private token: string | undefined,
    readonly development: boolean,
    private clock: () => Date = () => new Date(),
  ) {}
  /** Why admin sign-in is off, if it is. */
  get unavailable() {
    if (this.development || (this.token?.length ?? 0) >= minimumToken) return null;
    return 'Admin sign-in is off: add ADMIN_TOKEN, at least 32 random characters, as a Secret on the Worker.';
  }
  async signedIn(request: Request) {
    if (this.development) return true;
    const id = sessionId(request);
    if (this.unavailable || !id) return false;
    const row = await this.db.get<Row>(
      'SELECT token_hash FROM admin_sessions WHERE id_hash=? AND expires_at>?',
      hash(id),
      this.clock().getTime(),
    );
    return row?.token_hash === hash(this.token!);
  }
  /** Check the token and open a session; returns its cookie. */
  async signIn(given: string) {
    if (this.unavailable) throw new DomainError(this.unavailable, 503);
    const settings = new Settings(this.db);
    const now = this.clock().getTime();
    const saved = await settings.get<{ failures: number; since: number }>('admin_attempts');
    const recent =
      saved && now - saved.since < attempts.window ? saved : { failures: 0, since: now };
    if (recent.failures >= attempts.limit)
      throw new DomainError(
        `Too many wrong tokens. Try again in ${Math.ceil((recent.since + attempts.window - now) / 60_000)} minutes.`,
        429,
      );
    // Equal-length digests, so the comparison takes the same time whatever was entered.
    if (!timingSafeEqual(digest(given), digest(this.token!))) {
      await settings.set('admin_attempts', { ...recent, failures: recent.failures + 1 });
      throw new DomainError('That admin token is not right.', 401);
    }
    await settings.delete('admin_attempts');
    const id = randomBytes(32).toString('base64url');
    await this.db.transaction(async (tx) => {
      await tx.run('DELETE FROM admin_sessions WHERE expires_at<=?', now);
      await tx.run(
        'INSERT INTO admin_sessions VALUES (?,?,?)',
        hash(id),
        hash(this.token!),
        now + sessionLength,
      );
    });
    return this.cookie(id, sessionLength / 1000);
  }
  async signOut(request: Request) {
    const id = sessionId(request);
    if (id) await this.db.run('DELETE FROM admin_sessions WHERE id_hash=?', hash(id));
    return this.cookie('', 0);
  }
  private cookie(value: string, maxAge: number) {
    return `${cookieName}=${value}; Path=/api/admin; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${this.development ? '' : '; Secure'}`;
  }
}

function sessionId(request: Request) {
  for (const part of request.headers.get('cookie')?.split(';') ?? []) {
    const [name, ...value] = part.trim().split('=');
    if (name === cookieName) return value.join('=') || null;
  }
  return null;
}

/** `/api/admin`: the admin's session, then, once signed in, the settings the admin makes. */
export async function handleAdmin(app: App, request: Request): Promise<Response> {
  const { admin } = app;
  const { pathname } = new URL(request.url);
  if (pathname === '/api/admin/session') {
    if (request.method === 'GET')
      return json({
        signedIn: await admin.signedIn(request),
        development: admin.development,
        unavailable: admin.unavailable,
      });
    if (request.method === 'POST') {
      const { token } = z
        .object({ token: z.string().min(1).max(500) })
        .strict()
        .parse(await body(request));
      return json({ ok: true }, 200, { 'Set-Cookie': await admin.signIn(token) });
    }
    if (request.method === 'DELETE')
      return json({ ok: true }, 200, { 'Set-Cookie': await admin.signOut(request) });
  }
  if (!(await admin.signedIn(request))) throw new RequestError('Sign in as the admin first.', 401);
  for (const route of adminRoutes(app)) {
    const match = route.path.exec(pathname);
    if (match && route.method === request.method) return route.handle(request, match.slice(1));
  }
  throw new RequestError('Not found.', 404);
}

function adminRoutes(app: App): AdminRoute[] {
  const { household, assistantModel, plugins } = app;
  return [
    {
      method: 'GET',
      path: /^\/api\/admin\/state$/,
      handle: async (request) => {
        let state: Record<string, unknown> = {
          people: (await household.people()).map((person) => ({
            id: person.id,
            name: person.name,
            email: person.username.includes('@') ? person.username : '',
          })),
          // The email Cloudflare Access verified for this request, to check Access reaches the app.
          access: request.headers.get(identityHeader),
          ai: {
            connected: await assistantModel.connected(),
            model: (await app.settings.get<string>('ai_model')) ?? null,
          },
        };
        for (const plugin of plugins) state = { ...state, ...(await plugin.admin?.state()) };
        return json(state);
      },
    },
    {
      method: 'PUT',
      path: /^\/api\/admin\/people$/,
      handle: async (request) => {
        const { people } = peopleInput(app.admin.development).parse(await body(request));
        await household.configure(people);
        return json({ ok: true });
      },
    },
    {
      method: 'GET',
      path: /^\/api\/admin\/models$/,
      handle: async () => json(await assistantModel.catalog()),
    },
    {
      method: 'POST',
      path: /^\/api\/admin\/model$/,
      handle: async (request) => {
        const input = z
          .object({ id: z.string().min(1).max(100) })
          .strict()
          .parse(await body(request));
        await assistantModel.choose(input.id);
        return json({ ok: true });
      },
    },
    {
      method: 'POST',
      path: /^\/api\/admin\/chatgpt\/start$/,
      handle: async () => json({ url: await assistantModel.startSignIn() }),
    },
    {
      method: 'POST',
      path: /^\/api\/admin\/chatgpt\/finish$/,
      handle: async (request) => {
        const input = z
          .object({ address: z.string().min(1).max(4000) })
          .strict()
          .parse(await body(request));
        await assistantModel.finishSignIn(input.address);
        return json({ ok: true });
      },
    },
    {
      method: 'DELETE',
      path: /^\/api\/admin\/chatgpt$/,
      handle: async () => {
        await assistantModel.disconnect();
        return json({ ok: true });
      },
    },
    ...plugins.flatMap((plugin) => plugin.admin?.routes ?? []),
  ];
}
