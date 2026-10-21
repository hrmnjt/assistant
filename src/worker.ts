import { accessEmail } from './access';
import type { Chat } from './chat';

export { Chat } from './chat';

export interface Env {
  CHAT: DurableObjectNamespace<Chat>;
  /** The Access team domain, such as `https://<team>.cloudflareaccess.com`. */
  ACCESS_TEAM_DOMAIN?: string;
  /** The Access application's Application Audience (AUD) tag. */
  ACCESS_AUD?: string;
  /** Set only by `npm run dev`, which runs without Access. */
  DEV?: string;
}

const refuse = (status: number, error: string) => Response.json({ error }, { status });

/** Static files are served before the Worker runs; only /api/* reaches it. */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return refuse(404, 'Not found.');
    // Who is asking: the email Access signed them in with or, locally, an `as` cookie's.
    let email = request.headers.get('cookie')?.match(/(?:^|;\s*)as=([^;]+)/)?.[1] ?? null;
    if (env.DEV !== 'true') {
      if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD)
        return refuse(500, 'Set ACCESS_TEAM_DOMAIN and ACCESS_AUD in the Worker’s settings.');
      email = await accessEmail(request, env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD);
      if (!email) return refuse(403, 'Sign in through Cloudflare Access.');
    }
    // Changes, and the WebSocket that reports them, come only from the app's own pages.
    if (
      (request.method !== 'GET' || request.headers.has('upgrade')) &&
      request.headers.get('origin') !== url.origin
    )
      return refuse(403, 'Not allowed.');
    // The Chat object learns who is asking from the Worker alone.
    const headers = new Headers(request.headers);
    headers.delete('x-email');
    if (email) headers.set('x-email', email);
    return env.CHAT.getByName('chat').fetch(new Request(request, { headers }));
  },
} satisfies ExportedHandler<Env>;
