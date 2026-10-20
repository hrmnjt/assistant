// Cloudflare Access signs people in before a request reaches the Worker. The
// Worker still checks the token Access signs each request with, so the app
// refuses everything if Access is ever switched off.

const keys = new Map<string, CryptoKey>();
let fetchedAt = 0;

const bytes = (part: string) =>
  Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const decode = (part: string) => JSON.parse(new TextDecoder().decode(bytes(part)));

/** Whether Access signed this request in, for this team and Access application. */
export async function fromAccess(request: Request, teamDomain: string, audience: string) {
  const parts = request.headers.get('cf-access-jwt-assertion')?.split('.') ?? [];
  if (parts.length !== 3) return false;
  const issuer = (teamDomain.includes('://') ? teamDomain : `https://${teamDomain}`).replace(
    /\/+$/,
    '',
  );
  try {
    const header = decode(parts[0]);
    const claims = decode(parts[1]);
    if (header.alg !== 'RS256' || claims.iss !== issuer) return false;
    if (![claims.aud].flat().includes(audience)) return false;
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) return false;
    const key = await publicKey(issuer, String(header.kid));
    if (!key) return false;
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, bytes(parts[2]), signed);
  } catch {
    return false;
  }
}

/** The team's signing key by id, from its published certificates (fetched at most once a minute). */
async function publicKey(issuer: string, kid: string) {
  if (!keys.has(kid) && Date.now() - fetchedAt > 60_000) {
    fetchedAt = Date.now();
    const response = await fetch(`${issuer}/cdn-cgi/access/certs`);
    const body = response.ok ? await response.json<{ keys?: (JsonWebKey & { kid?: string })[] }>() : {};
    for (const jwk of body.keys ?? []) {
      if (!jwk.kid) continue;
      const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
      keys.set(jwk.kid, await crypto.subtle.importKey('jwk', jwk, algorithm, false, ['verify']));
    }
  }
  return keys.get(kid);
}
