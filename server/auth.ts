import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Store } from './database.js';
import type { Person } from '../src/types.js';

/** One of the two household members. A deployment knows them by the email Cloudflare Access verified. */
export type Account = { id: 'owner' | 'partner'; name: string; email: string };

/** Cloudflare Access in front of the deployed Worker; see the README's deployment steps. */
export type AccessConfig = {
  /** For example `https://our-day.cloudflareaccess.com`. */
  teamDomain: string;
  /** The Access application's audience (AUD) tag. */
  audience: string;
  /** Signing keys; defaults to the team's published certificates. */
  keys?: JWTVerifyGetKey;
};

export function accountsFrom(env: Record<string, string | undefined>, requireEmails: boolean) {
  const accounts: Account[] = [
    {
      id: 'owner',
      name: env.OWNER_NAME || 'You',
      email: (env.OWNER_EMAIL ?? '').trim().toLowerCase(),
    },
    {
      id: 'partner',
      name: env.PARTNER_NAME || 'Partner',
      email: (env.PARTNER_EMAIL ?? '').trim().toLowerCase(),
    },
  ];
  if (requireEmails && (!accounts.every((a) => a.email) || accounts[0].email === accounts[1].email))
    throw new Error(
      'Configure OWNER_EMAIL and PARTNER_EMAIL: the two addresses allowed in Cloudflare Access.',
    );
  return accounts;
}

const defaultPreferences = {
  timezone: 'Asia/Dubai',
  morning: { enabled: true, time: '08:00' },
  evening: { enabled: true, time: '18:00' },
};

/** Keep the two people's names in step with configuration; household data and settings are kept. */
export async function provision(db: Store, accounts: Account[]) {
  await db.transaction(async (tx) => {
    for (const account of accounts) {
      await tx.run(
        'INSERT INTO users VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username,name=excluded.name',
        account.id,
        account.email || account.id,
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
/** Development only: which of the two people this browser acts as (`partner`, else the owner). */
export const developmentPersonCookie = 'household-dev-person';

/**
 * Who is making a request. The app has no sign-in of its own: a deployment
 * sits behind Cloudflare Access, which signs people in and adds a signed token
 * naming their email; the app verifies it and maps the email to one of the two
 * people. Without Access configured the app is a local development server: it
 * answers only on this computer, with no sign-in, as the owner (or the partner,
 * to try shared features). A deployment missing its Access settings therefore
 * refuses every request rather than running open.
 */
export class Auth {
  readonly mode: 'cloudflare-access' | 'development';
  private access?: { issuer: string; audience: string; keys: JWTVerifyGetKey };
  constructor(
    private accounts: Account[],
    access?: AccessConfig,
  ) {
    this.mode = access ? 'cloudflare-access' : 'development';
    if (access) {
      const issuer = new URL(
        /^https?:\/\//.test(access.teamDomain) ? access.teamDomain : `https://${access.teamDomain}`,
      ).origin;
      this.access = {
        issuer,
        audience: access.audience,
        keys: access.keys ?? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)),
      };
    }
  }
  private person(account: Account): Person {
    return { id: account.id, username: account.email || account.id, name: account.name };
  }
  async current(request: Request): Promise<Person | null> {
    if (!this.access) {
      const asPartner = request.headers
        .get('cookie')
        ?.split(';')
        .some((part) => part.trim() === `${developmentPersonCookie}=partner`);
      return this.person(this.accounts[asPartner ? 1 : 0]);
    }
    const token = request.headers.get('cf-access-jwt-assertion');
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, this.access.keys, {
        issuer: this.access.issuer,
        audience: this.access.audience,
        algorithms: ['RS256'],
      });
      const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
      const account = this.accounts.find((item) => item.email && item.email === email);
      return account ? this.person(account) : null;
    } catch {
      return null;
    }
  }
  /**
   * The origin this request was served at, or null if the app does not answer
   * there. Behind Access, Cloudflare only routes the Worker's own addresses to
   * it. A development server answers only on this computer's loopback names,
   * so another site's hostname (DNS rebinding) cannot reach it.
   */
  served(request: Request): string | null {
    const url = new URL(request.url);
    return this.access || loopback(url.hostname) ? url.origin : null;
  }
  /** Writes need the app's own header and, when sent, the origin the request was served at. */
  writeAllowed(request: Request) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;
    const origin = request.headers.get('origin');
    return (
      request.headers.get('x-household-client') === '1' &&
      (!origin || origin === this.served(request))
    );
  }
}
