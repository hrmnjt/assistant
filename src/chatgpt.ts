// Sign in with ChatGPT lets the app use the owner's ChatGPT plan. It is
// OpenAI's flow for apps without a client secret: PKCE, a client registered
// per sign-in, and a token the app sends straight to api.openai.com.

const authorizeUrl = 'https://auth.openai.com/api/accounts/authorize';
const tokenUrl = 'https://auth.openai.com/api/accounts/oauth/token';
const api = 'https://api.openai.com/v1';
/** Where OpenAI sends the browser back. Nothing answers there, so the admin pastes the address. */
const redirectUri = 'http://127.0.0.1:1455/auth/callback';
const directScope = 'chatgpt.tokens.use.direct';

export type Credential = { access: string; refresh: string; expires: number; clientId: string };
export type PendingSignIn = { verifier: string; state: string; startedAt: number };
export type Turn = { role: 'user' | 'assistant'; text: string };
export type Delta = { reasoning: string } | { text: string };

const base64url = (data: Uint8Array) =>
  btoa(String.fromCharCode(...data))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

/** OpenAI's own explanation of a refused request, if it sent one. */
async function reason(response: Response) {
  const body = await response.json<any>().catch(() => null);
  const text = body?.error?.message ?? body?.error_description ?? body?.error ?? '';
  return `${response.status}${typeof text === 'string' && text ? `: ${text.slice(0, 300)}` : ''}`;
}

/** Start a sign-in: the address to open, and what to keep until the admin pastes the result. */
export async function startSignIn(hostId: string) {
  const pending: PendingSignIn = { verifier: random(), state: random(), startedAt: Date.now() };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pending.verifier));
  const url = new URL(authorizeUrl);
  url.search = new URLSearchParams({
    client_id: 'dynamic_agent_client',
    agent_name_hint: 'assistant',
    ext_agent_host_id: `urn:uuid:${hostId}`,
    response_type: 'code',
    redirect_uri: redirectUri,
    resource: api,
    scope: `openid profile email offline_access resource.invoke ${directScope}`,
    state: pending.state,
    code_challenge: base64url(new Uint8Array(digest)),
    code_challenge_method: 'S256',
    nonce: random(),
  }).toString();
  return { url: url.href, pending };
}

/** The code in the pasted address, if it finishes this sign-in. */
export function returnedCode(address: string, pending: PendingSignIn) {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    throw new Error('Paste the whole address from the browser’s address bar.');
  }
  if (url.pathname !== new URL(redirectUri).pathname)
    throw new Error(`Paste the address that starts with ${redirectUri}.`);
  if (url.searchParams.get('error')) throw new Error('ChatGPT was not connected. Start again.');
  const code = url.searchParams.get('code');
  const clientId = url.searchParams.get('client_id');
  if (!code || !clientId || url.searchParams.get('state') !== pending.state)
    throw new Error('That address is from another sign-in. Start again.');
  return { code, clientId };
}

export function finishSignIn(returned: { code: string; clientId: string }, pending: PendingSignIn) {
  return requestTokens(
    {
      grant_type: 'authorization_code',
      code: returned.code,
      code_verifier: pending.verifier,
      redirect_uri: redirectUri,
    },
    returned.clientId,
  );
}

export function refresh(credential: Credential) {
  return requestTokens(
    { grant_type: 'refresh_token', refresh_token: credential.refresh },
    credential.clientId,
  );
}

async function requestTokens(grant: Record<string, string>, clientId: string): Promise<Credential> {
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...grant, client_id: clientId, resource: api }),
  });
  if (!response.ok)
    throw new Error(`OpenAI refused the sign-in (${await reason(response)}). Connect ChatGPT again.`);
  const body = await response.json<{
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  }>();
  if (!body.access_token || !body.refresh_token || !body.expires_in)
    throw new Error('OpenAI’s sign-in answer was incomplete. Connect ChatGPT again.');
  if (!body.scope?.split(/\s+/).includes(directScope))
    throw new Error('This ChatGPT account didn’t let the app use its plan.');
  // Refresh a few minutes before the token really expires.
  const expires = Date.now() + body.expires_in * 1000 - 3 * 60_000;
  return { access: body.access_token, refresh: body.refresh_token, expires, clientId };
}

/** The models this ChatGPT account can use. */
export async function listModels(token: string) {
  const response = await fetch(`${api}/models`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`OpenAI didn’t list the models (${await reason(response)}).`);
  // Accept both the API's usual list and the ChatGPT catalog's shape.
  const body = await response.json<{
    data?: { id: string }[];
    models?: { slug: string; visibility?: string }[];
  }>();
  const ids =
    body.data?.map((model) => model.id) ??
    body.models?.filter((model) => model.visibility !== 'hide').map((model) => model.slug) ??
    [];
  return [...new Set(ids)].sort();
}

const instructions = () =>
  'You are a helpful assistant. This chat shows replies as plain text, so do not use Markdown ' +
  'such as **bold**, headings or tables; simple lists with hyphens are fine. ' +
  `The current date and time is ${new Date().toISOString()} (UTC).`;

/** Ask the model to answer the conversation, yielding its reasoning summary and reply as they stream in. */
export async function* respond(token: string, model: string, turns: Turn[]): AsyncGenerator<Delta> {
  const response = await fetch(`${api}/responses`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    body: JSON.stringify({
      model,
      stream: true,
      store: false,
      reasoning: { effort: 'medium', summary: 'auto' },
      input: [
        { role: 'developer', content: instructions() },
        ...turns.map((turn) => ({ role: turn.role, content: turn.text })),
      ],
    }),
  });
  if (!response.ok || !response.body)
    throw new Error(`ChatGPT couldn’t answer (${await reason(response)}).`);
  for await (const event of serverSentEvents(response.body)) {
    switch (event.type) {
      case 'response.reasoning_summary_text.delta':
        yield { reasoning: event.delta };
        break;
      case 'response.reasoning_summary_part.done':
        yield { reasoning: '\n\n' };
        break;
      case 'response.output_text.delta':
        yield { text: event.delta };
        break;
      case 'response.completed':
        return;
      case 'response.incomplete':
        throw new Error(
          `ChatGPT stopped early (${event.response?.incomplete_details?.reason ?? 'no reason given'}).`,
        );
      case 'response.failed':
        throw new Error(event.response?.error?.message ?? 'ChatGPT couldn’t answer.');
      case 'error':
        throw new Error(event.message ?? event.error?.message ?? 'ChatGPT couldn’t answer.');
    }
  }
  throw new Error('The connection to ChatGPT ended before the reply did.');
}

async function* serverSentEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<any> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += value.replace(/\r\n/g, '\n');
    for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
      const data = buffer
        .slice(0, end)
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      buffer = buffer.slice(end + 2);
      if (data && data !== '[DONE]') yield JSON.parse(data);
    }
  }
}
