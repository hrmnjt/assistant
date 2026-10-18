import { createHash, timingSafeEqual } from 'node:crypto';
import type { Row, Store } from './database.js';
import type { Person } from '../src/types.js';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** One of the two household sign-ins, configured as deployment secrets. */
export type Account = { id: 'owner' | 'partner'; username: string; name: string; password: string };

export function accountsFrom(env: Record<string, string | undefined>): Account[] {
  const accounts: Account[] = [
    {
      id: 'owner',
      username: env.OWNER_USERNAME || 'owner',
      name: env.OWNER_NAME || 'You',
      password: env.OWNER_PASSWORD || '',
    },
    {
      id: 'partner',
      username: env.PARTNER_USERNAME || 'partner',
      name: env.PARTNER_NAME || 'Partner',
      password: env.PARTNER_PASSWORD || '',
    },
  ];
  if (
    accounts[0].username === accounts[1].username ||
    accounts[0].password === accounts[1].password ||
    accounts.some((account) => account.password.length < 12 || account.username.length > 100)
  )
    throw new Error(
      'Configure two distinct usernames and passwords of at least 12 characters. Run npm run configure first.',
    );
  return accounts;
}

const defaultPreferences = {
  timezone: 'Asia/Dubai',
  morning: { enabled: true, time: '08:00' },
  evening: { enabled: true, time: '18:00' },
};

/** Keep account names in step with configuration; household data and settings are kept. */
export async function provision(db: Store, accounts: Account[]) {
  await db.transaction(async (tx) => {
    for (const account of accounts) {
      await tx.run(
        'INSERT INTO users VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username,name=excluded.name',
        account.id,
        account.username,
        account.name,
      );
      await tx.run(
        'INSERT OR IGNORE INTO preferences VALUES (?, ?, 1)',
        account.id,
        JSON.stringify(defaultPreferences),
      );
    }
  });
}

const loopback = (hostname: string) => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
const tunnel = (hostname: string) => /^[a-z0-9-]+\.trycloudflare\.com$/.test(hostname);

const sessionAge = 30 * 86_400_000;
const attemptWindow = 900_000;
const attemptLimit = 10;
const trackedClients = 1000;

export class SignInError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Cookie sessions for the two configured accounts. A session records a
 * fingerprint of the credentials it was issued for, so changing an account's
 * password or username secret signs that account out everywhere.
 */
export class Auth {
  readonly cookieName: string;
  private secure: boolean;
  constructor(
    private db: Store,
    private accounts: Account[],
    readonly origin: string,
    private now: () => number = Date.now,
  ) {
    this.secure = origin.startsWith('https:');
    this.cookieName = this.secure ? '__Host-household' : 'household';
  }
  private fingerprint(account: Account) {
    return digest(`${account.id}\n${account.username}\n${account.password}`);
  }
  private token(request: Request) {
    return request.headers
      .get('cookie')
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${this.cookieName}=`))
      ?.slice(this.cookieName.length + 1);
  }
  private cookie(value: string, maxAge: number) {
    return `${this.cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAge / 1000)}${this.secure ? '; Secure' : ''}`;
  }
  async current(request: Request): Promise<Person | null> {
    const token = this.token(request);
    if (!token) return null;
    const row = await this.db.get<Row>(
      'SELECT user_id, credential FROM sessions WHERE token_hash=? AND expires_at>?',
      digest(token),
      this.now(),
    );
    const account = this.accounts.find((item) => item.id === row?.user_id);
    if (!row || !account || row.credential !== this.fingerprint(account)) return null;
    return { id: account.id, username: account.username, name: account.name };
  }
  /**
   * The origin this request was served at, or null if the app does not answer
   * there. A deployment answers only at its configured origin, so a rebinding
   * hostname cannot reach it. Local development (a loopback origin) also
   * answers at the other loopback names on the same port and at the
   * `*.trycloudflare.com` tunnels `wrangler dev` opens for phones; Cloudflare
   * controls those names, so they cannot be rebound to this Mac.
   */
  served(request: Request): string | null {
    const url = new URL(request.url);
    if (url.origin === this.origin) return this.origin;
    const configured = new URL(this.origin);
    if (!loopback(configured.hostname)) return null;
    if (
      (loopback(url.hostname) &&
        url.protocol === configured.protocol &&
        url.port === configured.port) ||
      tunnel(url.hostname)
    )
      return url.origin;
    return null;
  }
  /** Writes need the app's own header and, when sent, the origin the request was served at. */
  writeAllowed(request: Request) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;
    const origin = request.headers.get('origin');
    const served = this.served(request);
    // A tunnel ends TLS and forwards plain HTTP; `wrangler dev` may or may not
    // rewrite the browser's HTTPS origin to match.
    const sameOrigin =
      origin === served ||
      (!!served &&
        tunnel(new URL(served).hostname) &&
        origin === served.replace(/^http:/, 'https:'));
    return request.headers.get('x-household-client') === '1' && (!origin || sameOrigin);
  }
  /** Reserve an attempt for this client before checking, so parallel guesses share the limit. */
  private async admit(client: string) {
    const at = this.now();
    await this.db.transaction(async (tx) => {
      await tx.run('DELETE FROM sign_in_attempts WHERE until_at<=?', at);
      const row = await tx.get<Row>('SELECT count FROM sign_in_attempts WHERE client=?', client);
      if (Number(row?.count ?? 0) >= attemptLimit)
        throw new SignInError('Too many sign-in attempts. Please wait 15 minutes.', 429);
      await tx.run(
        `INSERT INTO sign_in_attempts VALUES (?,1,?)
        ON CONFLICT(client) DO UPDATE SET count=count+1`,
        client,
        at + attemptWindow,
      );
      // Bound the table: drop the oldest windows beyond the tracked capacity.
      await tx.run(
        `DELETE FROM sign_in_attempts WHERE client IN (SELECT client FROM sign_in_attempts
        ORDER BY until_at DESC LIMIT -1 OFFSET ?)`,
        trackedClients,
      );
    });
  }
  /** Returns the signed-in person and the session cookie. */
  async login(input: unknown, clientAddress: string) {
    const { username, password } = (input ?? {}) as Record<string, unknown>;
    if (
      typeof username !== 'string' ||
      typeof password !== 'string' ||
      password.length > 1024 ||
      username.length > 100
    )
      throw new SignInError('Enter your username and password.', 400);
    const client = digest(clientAddress || 'local');
    await this.admit(client);
    const account = this.accounts.find((item) => item.username === username);
    // Compare fixed-length digests for every request, including unknown usernames.
    const expected = digest(account?.password ?? `unknown:${this.accounts[0].password}`);
    const valid = timingSafeEqual(Buffer.from(digest(password)), Buffer.from(expected));
    if (!account || !valid) throw new SignInError('The username or password is incorrect.', 401);
    await this.db.run('DELETE FROM sign_in_attempts WHERE client=?', client);
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
    await this.db.run('DELETE FROM sessions WHERE expires_at<?', this.now());
    await this.db.run(
      'INSERT INTO sessions VALUES (?,?,?,?)',
      digest(token),
      account.id,
      this.fingerprint(account),
      this.now() + sessionAge,
    );
    return {
      person: { id: account.id, username: account.username, name: account.name } as Person,
      cookie: this.cookie(token, sessionAge),
    };
  }
  async logout(request: Request) {
    const token = this.token(request);
    if (token) await this.db.run('DELETE FROM sessions WHERE token_hash=?', digest(token));
    return this.cookie('', 0);
  }
}
