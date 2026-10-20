import type { Household } from './household.js';
import { audienceHeader, type AccessTokens } from './access.js';
import type { Person } from '../src/types.js';

/**
 * Set by the Worker from the identity Cloudflare Access verified; the Worker
 * removes any copy a client sends, and only the Worker reaches the household.
 */
export const identityHeader = 'x-household-access-email';
/** Development only: which of the two people this browser acts as (`partner`, else the owner). */
export const developmentPersonCookie = 'household-dev-person';

type AccessContext = { aud?: string; getIdentity(): Promise<{ email?: string } | undefined> };

/**
 * In the Worker: replace any client-sent identity with the email Cloudflare
 * Access verified, and name the Access application when Cloudflare does.
 */
export async function withAccessIdentity(request: Request, access?: AccessContext) {
  const headers = new Headers(request.headers);
  headers.delete(identityHeader);
  headers.delete(audienceHeader);
  const email = (await access?.getIdentity())?.email?.trim().toLowerCase();
  if (email) headers.set(identityHeader, email);
  if (access?.aud) headers.set(audienceHeader, access.aud);
  return new Request(request, { headers });
}

const loopback = (hostname: string) => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);

/**
 * The app has no sign-in of its own. A deployment sits behind Cloudflare
 * Access, which signs people in; the Worker passes on the verified email (or
 * the app checks Access's signed token itself), and it must be one of the two
 * the admin added. A development server
 * (started by `npm run dev`) has no sign-in, answers only on this computer, and
 * acts as person 1, or as person 2 to try shared features. Anything else,
 * including a deployment without Access, is refused.
 */
export class Auth {
  readonly mode: 'cloudflare-access' | 'development';
  constructor(
    private household: Household,
    development = false,
    /** Checks Access's own signed token when the Worker passes on no email. */
    readonly tokens?: AccessTokens,
  ) {
    this.mode = development ? 'development' : 'cloudflare-access';
  }
  /** The email Cloudflare Access signed this request in with, if any. */
  async email(request: Request) {
    return request.headers.get(identityHeader) || ((await this.tokens?.email(request)) ?? null);
  }
  /** Which of the two people is asking, or null for anyone else. */
  async caller(request: Request): Promise<Person | null> {
    const people = await this.household.people();
    if (this.mode === 'development') {
      const asPartner = request.headers
        .get('cookie')
        ?.split(';')
        .some((part) => part.trim() === `${developmentPersonCookie}=partner`);
      return people.find((p) => p.id === (asPartner ? 'partner' : 'owner')) ?? null;
    }
    const email = await this.email(request);
    return (email && people.find((item) => item.username === email)) || null;
  }
  /**
   * The origin this request was served at, or null if the app does not answer
   * there. A deployment answers at the Worker's own addresses, the only ones
   * Cloudflare routes to it. A development server answers only on this
   * computer's loopback names, so another site's hostname (DNS rebinding)
   * cannot reach it.
   */
  served(request: Request): string | null {
    const url = new URL(request.url);
    return this.mode === 'cloudflare-access' || loopback(url.hostname) ? url.origin : null;
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
