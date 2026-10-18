import type { Household } from './household.js';
import type { Person } from '../src/types.js';

/**
 * Set by the Worker from the identity Cloudflare Access verified; the Worker
 * removes any copy a client sends, and only the Worker reaches the household.
 */
export const identityHeader = 'x-household-access-email';
/** Development only: which of the two people this browser acts as (`partner`, else the owner). */
export const developmentPersonCookie = 'household-dev-person';

type AccessContext = { getIdentity(): Promise<{ email?: string } | undefined> };

/** In the Worker: replace any client-sent identity with the email Cloudflare Access verified. */
export async function withAccessIdentity(request: Request, access?: AccessContext) {
  const headers = new Headers(request.headers);
  headers.delete(identityHeader);
  const email = (await access?.getIdentity())?.email?.trim().toLowerCase();
  if (email) headers.set(identityHeader, email);
  return new Request(request, { headers });
}

/** Who is asking: one of the two people, someone who may set the household up, or nobody. */
export type Caller = { person: Person } | { setup: { email: string | null } } | null;

const loopback = (hostname: string) => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);

/**
 * The app has no sign-in of its own. A deployment sits behind Cloudflare
 * Access, which signs people in; the Worker passes on the verified email and
 * the household maps it to one of its two people. Before the household is set
 * up, the first person to sign in sets up both. A development server (started
 * by `npm run dev`) has no sign-in, answers only on this computer, and acts as
 * the person who set it up, or as the other person to try shared features.
 * Anything else, including a deployment without Access, is refused.
 */
export class Auth {
  readonly mode: 'cloudflare-access' | 'development';
  constructor(
    private household: Household,
    development = false,
  ) {
    this.mode = development ? 'development' : 'cloudflare-access';
  }
  async caller(request: Request): Promise<Caller> {
    const people = await this.household.people();
    if (this.mode === 'development') {
      if (!people.length) return { setup: { email: null } };
      const asPartner = request.headers
        .get('cookie')
        ?.split(';')
        .some((part) => part.trim() === `${developmentPersonCookie}=partner`);
      return { person: people.find((p) => p.id === (asPartner ? 'partner' : 'owner'))! };
    }
    const email = request.headers.get(identityHeader);
    if (!email) return null;
    if (!people.length) return { setup: { email } };
    const person = people.find((item) => item.username === email);
    return person ? { person } : null;
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
