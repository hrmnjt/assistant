import type { OAuthCredential } from '@earendil-works/pi-ai';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from './errors.js';

// Sign in with ChatGPT, as pi-ai's OpenAI OAuth does, but run from the admin
// page: a public client with PKCE and OpenAI's dynamic client registration.
const authorizeUrl = 'https://auth.openai.com/api/accounts/authorize';
const tokenUrl = 'https://auth.openai.com/api/accounts/oauth/token';
const resource = 'https://api.openai.com/v1';
/** Where OpenAI sends the browser back. Only an app on the same device answers there. */
export const redirectUri = 'http://127.0.0.1:1455/auth/callback';
const directScope = 'chatgpt.tokens.use.direct';
const scope = `openid profile email offline_access resource.invoke ${directScope}`;
// Refresh a little before the real expiry, as pi-ai does.
const expiryMargin = 3 * 60_000;

const random = () => randomBytes(32).toString('base64url');

/** A sign-in in progress: what the server keeps until the admin pastes the address back. */
export type PendingSignIn = { verifier: string; state: string; startedAt: number };

/** Start a sign-in: the address to open, and what to keep for finishing it. */
export function startSignIn(hostId: string, now: number) {
  const pending: PendingSignIn = { verifier: random(), state: random(), startedAt: now };
  const url = new URL(authorizeUrl);
  url.search = new URLSearchParams({
    client_id: 'dynamic_agent_client',
    agent_name_hint: 'Our day assistant',
    ext_agent_host_id: `urn:uuid:${hostId}`,
    response_type: 'code',
    redirect_uri: redirectUri,
    resource,
    scope,
    state: pending.state,
    code_challenge: createHash('sha256').update(pending.verifier).digest('base64url'),
    code_challenge_method: 'S256',
    nonce: random(),
  }).toString();
  return { url: url.href, pending };
}

/** The code in the address the browser ended on, if it belongs to this sign-in. */
export function returnedCode(address: string, pending: PendingSignIn) {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    throw new DomainError('Paste the whole address from the browser’s address bar.');
  }
  if (url.pathname !== new URL(redirectUri).pathname)
    throw new DomainError(`Paste the address that starts with ${redirectUri}.`);
  if (url.searchParams.get('error'))
    throw new DomainError('ChatGPT was not connected. Start again to try once more.');
  const code = url.searchParams.get('code');
  const clientId = url.searchParams.get('client_id')?.trim();
  if (!code || !clientId || url.searchParams.get('state') !== pending.state)
    throw new DomainError('That address is not from this sign-in. Start again to try once more.');
  return { code, clientId };
}

const tokens = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  scope: z.string(),
  expires_in: z.number().positive(),
});

/** Ask OpenAI for tokens, server to server, and keep them as the credential. */
async function requestTokens(
  grant: Record<string, string>,
  clientId: string,
  now: number,
  signal: AbortSignal,
): Promise<OAuthCredential> {
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ ...grant, client_id: clientId, resource }),
    signal,
  }).catch(() => undefined);
  const parsed = tokens.safeParse(response?.ok ? await response.json().catch(() => null) : null);
  // Never pass on OpenAI's own error text, which can echo request details.
  if (!parsed.success)
    throw new DomainError(
      'OpenAI did not complete the sign-in. Start again to try once more.',
      502,
    );
  const scopes = parsed.data.scope.split(/\s+/).filter(Boolean);
  if (!scopes.includes(directScope))
    throw new DomainError('This ChatGPT account did not allow the assistant to use its plan.', 502);
  return {
    type: 'oauth',
    access: parsed.data.access_token,
    refresh: parsed.data.refresh_token,
    expires: now + parsed.data.expires_in * 1000 - expiryMargin,
    clientId,
    scopes,
  };
}

/** Exchange the returned code for tokens; the verifier never left the server. */
export function finishSignIn(
  returned: { code: string; clientId: string },
  pending: PendingSignIn,
  now: number,
) {
  return requestTokens(
    {
      grant_type: 'authorization_code',
      code: returned.code,
      code_verifier: pending.verifier,
      redirect_uri: redirectUri,
    },
    returned.clientId,
    now,
    AbortSignal.timeout(15_000),
  );
}

/** Exchange the refresh token for fresh tokens, as pi-ai's OpenAI OAuth does. */
export function refreshSignIn(credential: OAuthCredential, signal: AbortSignal) {
  const clientId = typeof credential.clientId === 'string' ? credential.clientId : '';
  if (!clientId) throw new DomainError('Connect ChatGPT again on the admin page.', 409);
  return requestTokens(
    { grant_type: 'refresh_token', refresh_token: credential.refresh },
    clientId,
    Date.now(),
    signal,
  );
}
