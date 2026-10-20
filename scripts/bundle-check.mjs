// Runs the deployment bundle that `npm run check` built in workerd, as Cloudflare
// would, with OpenAI's endpoints stubbed. Tests load modules one by one; only
// the bundle shows code a deploy cannot reach, such as a library loading part
// of itself by a path the bundler could not follow.
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const wrangler = readFileSync('cloudflare/wrangler.jsonc', 'utf8');
const compatibilityDate = /"compatibility_date":\s*"([^"]+)"/.exec(wrangler)[1];
const token = 'bundle-check-admin-token-0123456789';
const origin = 'https://assistant.example.workers.dev';
const granted = 'openid offline_access chatgpt.tokens.use.direct';

const mf = new Miniflare(
  convertV4MiniflareOptions({
    name: 'assistant',
    scriptPath: resolve('.cache/cloudflare/bundle/worker.js'),
    modules: true,
    compatibilityDate,
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: { HOUSEHOLD: { className: 'Household', useSQLite: true } },
    bindings: { ADMIN_TOKEN: token },
    outboundService: async (request) => {
      if (request.url === 'https://auth.openai.com/api/accounts/oauth/token') {
        // The first token is already stale, so using it must refresh it.
        const refresh =
          new URLSearchParams(await request.text()).get('grant_type') !== 'authorization_code';
        return Response.json({
          access_token: refresh ? 'fresh-access' : 'stale-access',
          refresh_token: 'refresh',
          id_token: 'id',
          scope: granted,
          expires_in: refresh ? 3600 : 60,
        });
      }
      if (request.url === 'https://api.openai.com/v1/models')
        return request.headers.get('authorization') === 'Bearer fresh-access'
          ? Response.json({
              models: [{ slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list' }],
            })
          : new Response(null, { status: 401 });
      return new Response(null, { status: 502 });
    },
  }),
);
let cookie = '';
async function expectOk(path, body) {
  const response = await mf.dispatchFetch(origin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Household-Client': '1',
      Origin: origin,
      Cookie: cookie,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok)
    throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  cookie ||= response.headers.get('set-cookie')?.split(';')[0] ?? '';
  return response.json();
}
try {
  await expectOk('/api/health');
  // The admin connects ChatGPT and chooses a model, as on the admin page.
  await expectOk('/api/admin/session', { token });
  const { url } = await expectOk('/api/admin/chatgpt/start', {});
  const state = new URL(url).searchParams.get('state');
  await expectOk('/api/admin/chatgpt/finish', {
    address: `http://127.0.0.1:1455/auth/callback?code=code&state=${state}&client_id=client`,
  });
  await expectOk('/api/admin/models');
  await expectOk('/api/admin/model', { id: 'gpt-6.1-sol' });
  console.log('The deployment bundle runs in workerd and connects ChatGPT.');
} finally {
  await mf.dispose();
}
