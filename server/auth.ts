import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { Database } from './database.js';
import type { Person } from '../src/types.js';

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password: string, hash: string) {
  const [salt, expected] = hash.split(':');
  return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(expected, 'hex'));
}
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const defaultPreferences = {
  timezone: 'Asia/Dubai',
  morning: { enabled: true, time: '08:00' },
  evening: { enabled: true, time: '18:00' },
};

export function provision(
  db: Database,
  config: { username: string; name: string; password: string }[],
) {
  if (db.sql.prepare('SELECT id FROM users LIMIT 1').get()) return;
  if (
    config.length !== 2 ||
    new Set(config.map((u) => u.username)).size !== 2 ||
    config.some((u) => !u.username || u.password.length < 12)
  ) {
    throw new Error(
      'Configure two distinct accounts with passwords of at least 12 characters. Run npm run configure first.',
    );
  }
  db.transaction(() =>
    config.forEach((user, index) => {
      const id = index === 0 ? 'owner' : 'partner';
      db.sql
        .prepare('INSERT INTO users VALUES (?, ?, ?, ?)')
        .run(id, user.username, user.name, hashPassword(user.password));
      db.sql
        .prepare('INSERT INTO preferences VALUES (?, ?, 1)')
        .run(id, JSON.stringify(defaultPreferences));
    }),
  );
}

export function auth(db: Database, origin: string) {
  const secure = origin.startsWith('https:');
  const cookieName = secure ? '__Host-household' : 'household';
  const cookie = {
    httpOnly: true,
    secure,
    sameSite: 'strict' as const,
    path: '/',
    maxAge: 30 * 86400_000,
  };
  const attempts = new Map<string, { count: number; until: number }>();
  // A fixed dummy hash keeps unknown-user password checks comparable in cost.
  const dummyHash = hashPassword(randomBytes(32).toString('hex'));
  const person = (row: Record<string, unknown>): Person => ({
    id: String(row.id),
    username: String(row.username),
    name: String(row.name),
  });
  function current(req: Request): Person | null {
    const raw = req.headers.cookie
      ?.split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    if (!raw) return null;
    const row = db.sql
      .prepare(
        'SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?',
      )
      .get(digest(raw), Date.now());
    return row ? person(row) : null;
  }
  function writeGuard(req: Request, res: Response, next: NextFunction) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (
      req.headers['x-household-client'] !== '1' ||
      (req.headers.origin && req.headers.origin !== origin)
    ) {
      res.status(403).json({ error: 'Request origin is not allowed.' });
      return;
    }
    next();
  }
  function login(req: Request, res: Response) {
    const key = req.ip || 'local';
    const attempt = attempts.get(key);
    if (attempt && attempt.until > Date.now() && attempt.count >= 10) {
      res.status(429).json({ error: 'Too many sign-in attempts. Please wait 15 minutes.' });
      return;
    }
    const { username, password } = req.body ?? {};
    if (
      typeof username !== 'string' ||
      typeof password !== 'string' ||
      password.length > 1024 ||
      username.length > 100
    ) {
      res.status(400).json({ error: 'Enter your username and password.' });
      return;
    }
    const row = db.sql.prepare('SELECT * FROM users WHERE username=?').get(username);
    const valid = verifyPassword(password, row ? String(row.password_hash) : dummyHash);
    if (!row || !valid) {
      const value =
        attempt && attempt.until > Date.now() ? attempt : { count: 0, until: Date.now() + 900_000 };
      attempts.set(key, { ...value, count: value.count + 1 });
      res.status(401).json({ error: 'The username or password is incorrect.' });
      return;
    }
    attempts.delete(key);
    const token = randomBytes(32).toString('base64url');
    db.sql.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
    db.sql
      .prepare('INSERT INTO sessions VALUES (?, ?, ?)')
      .run(digest(token), row.id, Date.now() + cookie.maxAge);
    res.cookie(cookieName, token, cookie).json({ person: person(row) });
  }
  function requireUser(req: Request, res: Response, next: NextFunction) {
    const me = current(req);
    if (!me) {
      res.status(401).json({ error: 'Please sign in.' });
      return;
    }
    res.locals.me = me;
    next();
  }
  function logout(req: Request, res: Response) {
    const raw = req.headers.cookie
      ?.split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    if (raw) db.sql.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(raw));
    res.clearCookie(cookieName, { ...cookie, maxAge: undefined }).json({ ok: true });
  }
  return { current, writeGuard, login, requireUser, logout };
}
