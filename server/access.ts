import type { Settings } from './settings.js';

/** The signed token Cloudflare Access adds to each request it lets through. */
export const assertionHeader = 'cf-access-jwt-assertion';
/** Set by the Worker from `ctx.access.aud`: the Access application in front of it. */
export const audienceHeader = 'x-household-access-aud';

/** The Access team and application the app trusts, recorded from the admin's page. */
type Trusted = { issuer: string; audience: string };
type Claims = {
  iss: string;
  aud: string | string[];
  email?: unknown;
  exp?: unknown;
  nbf?: unknown;
};

const trustedKey = 'access_trusted';
const team = /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/;
const skew = 60;
const refetchAfter = 60_000;

const fromBase64Url = (value: string) =>
  Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
function decode(token: string) {
  const [header, payload, signature, extra] = token.split('.');
  if (!signature || extra !== undefined) return null;
  try {
    return {
      header: JSON.parse(new TextDecoder().decode(fromBase64Url(header))) as Record<
        string,
        unknown
      >,
      claims: JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as Claims,
      signed: new TextEncoder().encode(`${header}.${payload}`),
      signature: fromBase64Url(signature),
    };
  } catch {
    return null;
  }
}
const audiences = (claims: Claims) => (Array.isArray(claims.aud) ? claims.aud : [claims.aud]);

/**
 * Checks Cloudflare Access's signed token on a request, so the app knows who
 * Access signed in even when the Worker is not given the identity itself. A
 * token counts only if it is signed by the Access team, for the Access
 * application, that the admin's page last recorded (the admin's session
 * vouches that request came through Access), and has not expired.
 */
export class AccessTokens {
  private keys = new Map<string, CryptoKey>();
  private fetched = new Map<string, number>();
  constructor(
    private settings: Settings,
    private clock: () => Date = () => new Date(),
  ) {}
  /** The email on the request's Access token, if the token is valid and trusted. */
  async email(request: Request) {
    const trusted = await this.settings.get<Trusted>(trustedKey);
    const token = request.headers.get(assertionHeader);
    if (!trusted || !token) return null;
    const claims = await this.verify(token, trusted.issuer);
    if (!claims || !audiences(claims).includes(trusted.audience)) return null;
    return typeof claims.email === 'string' ? claims.email.trim().toLowerCase() || null : null;
  }
  /** On the admin's page: trust the Access team and application that signed this request. */
  async trust(request: Request) {
    const token = request.headers.get(assertionHeader);
    const issuer = token ? decode(token)?.claims.iss : undefined;
    if (!token || typeof issuer !== 'string' || !team.test(issuer)) return null;
    const claims = await this.verify(token, issuer);
    if (!claims) return null;
    // The Worker names the application when Cloudflare gives it; else the token's only one.
    const named = request.headers.get(audienceHeader);
    const all = audiences(claims);
    const audience = named ? all.find((aud) => aud === named) : all.length === 1 ? all[0] : null;
    if (!audience) return null;
    const trusted: Trusted = { issuer, audience };
    await this.settings.set(trustedKey, trusted);
    return trusted;
  }
  /** The token's claims if Access's key for `issuer` signed it and it is current. */
  private async verify(token: string, issuer: string): Promise<Claims | null> {
    const decoded = decode(token);
    if (!decoded || decoded.header.alg !== 'RS256' || decoded.claims.iss !== issuer) return null;
    const now = this.clock().getTime() / 1000;
    const { exp, nbf } = decoded.claims;
    if (typeof exp !== 'number' || exp < now - skew) return null;
    if (typeof nbf === 'number' && nbf > now + skew) return null;
    const key = await this.key(issuer, String(decoded.header.kid));
    if (!key) return null;
    const valid = await crypto.subtle
      .verify('RSASSA-PKCS1-v1_5', key, decoded.signature, decoded.signed)
      .catch(() => false);
    return valid ? decoded.claims : null;
  }
  /** Access's public key by id, fetched from the team's published certificates. */
  private async key(issuer: string, kid: string) {
    const id = `${issuer} ${kid}`;
    const now = this.clock().getTime();
    // Refetch at most once a minute, so unknown key ids cannot make the app hammer Access.
    if (!this.keys.has(id) && now - (this.fetched.get(issuer) ?? 0) > refetchAfter) {
      this.fetched.set(issuer, now);
      const response = await fetch(`${issuer}/cdn-cgi/access/certs`, {
        signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined);
      const body = response?.ok
        ? ((await response.json().catch(() => null)) as { keys?: JsonWebKey[] } | null)
        : null;
      for (const jwk of body?.keys ?? []) {
        const keyId = (jwk as JsonWebKey & { kid?: string }).kid;
        if (!keyId || jwk.kty !== 'RSA') continue;
        const imported = await crypto.subtle
          .importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
          .catch(() => undefined);
        if (imported) this.keys.set(`${issuer} ${keyId}`, imported);
      }
    }
    return this.keys.get(id) ?? null;
  }
}
