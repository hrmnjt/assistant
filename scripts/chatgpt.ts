import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Credential, CredentialStore } from '@earendil-works/pi-ai';
import { chatgptModels } from '../server/chatgpt-models.js';

// npm run ai:connect [-- --production]     sign in with ChatGPT and save the connection
// npm run ai:disconnect [-- --production]  remove it
// Local values go to cloudflare/.dev.vars; production values to cloudflare/.prod.vars,
// uploaded by `npm run secrets`. Tokens are never printed. The model is chosen in
// the app's Settings.
process.umask(0o077);
process.env.PI_OAUTH_CALLBACK_HOST = '127.0.0.1';
const path = process.argv.includes('--production')
  ? 'cloudflare/.prod.vars'
  : 'cloudflare/.dev.vars';
// CHATGPT_MODEL_ID is no longer used; saving drops it from older files.
const keys = ['CHATGPT_HOST_ID', 'CHATGPT_MODEL_ID', 'CHATGPT_CREDENTIAL_JSON'] as const;
const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [];
const value = (key: string) =>
  lines
    .find((line) => line.startsWith(`${key}=`))
    ?.slice(key.length + 1)
    .replace(/^'(.*)'$/, '$1');
function save(values: Partial<Record<(typeof keys)[number], string>>) {
  const kept = lines.filter((line) => !keys.some((key) => line.startsWith(`${key}=`)));
  while (kept.at(-1) === '') kept.pop();
  for (const [key, entry] of Object.entries(values)) kept.push(`${key}='${entry}'`);
  writeFileSync(path, `${kept.join('\n')}\n`, { mode: 0o600 });
}

if (process.argv.includes('--remove')) {
  save({ CHATGPT_HOST_ID: value('CHATGPT_HOST_ID') ?? crypto.randomUUID() });
  console.log(
    `Removed the ChatGPT connection from ${path}. For production, also delete the deployed secret with npm run wrangler -- secret delete CHATGPT_CREDENTIAL_JSON --config cloudflare/wrangler.jsonc. Revoke the app in ChatGPT settings if desired.`,
  );
} else {
  // A stable host identifier lets ChatGPT recognize this installation on reconnect.
  const hostId = value('CHATGPT_HOST_ID') ?? crypto.randomUUID();
  let credential: Credential | undefined;
  const memory: CredentialStore = {
    read: async () => credential,
    list: async () => (credential ? [{ providerId: 'openai', type: 'oauth' as const }] : []),
    modify: async (_provider, fn) => {
      const next = await fn(credential);
      if (next && next.type !== 'oauth') throw new Error('API-key fallback is disabled.');
      credential = next ?? credential;
      return credential;
    },
    delete: async () => {
      credential = undefined;
    },
  };
  const models = chatgptModels(memory);
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    console.log(
      'Connect the assistant to your ChatGPT plan. Eligible requests use its limits. No API-key fallback is used.',
    );
    await models.login(
      'openai',
      'oauth',
      {
        signal: AbortSignal.timeout(5 * 60_000),
        prompt: (prompt) => terminal.question(`${prompt.message}\n`, { signal: prompt.signal }),
        notify: (event) => {
          if (event.type === 'auth_url')
            console.log(`Open this sign-in link on your Mac:\n${event.url}`);
          else if ('message' in event) console.log(event.message);
        },
      },
      { getDeviceId: () => hostId, agentName: 'Our day assistant' },
    );
    if (!credential) throw new Error('No OAuth credential was returned.');
    save({ CHATGPT_HOST_ID: hostId, CHATGPT_CREDENTIAL_JSON: JSON.stringify(credential) });
    console.log(
      `Saved the ChatGPT connection in ${path}. ${path.includes('prod') ? 'Run npm run secrets to upload it' : 'Restart npm run dev'}, then choose the model in the app's Settings. Send a message to validate completed inference; shared use by both of you still needs account eligibility validation.`,
    );
  } catch {
    console.error(
      'ChatGPT setup did not complete. Retry npm run ai:connect; no tokens or provider errors are printed.',
    );
    process.exitCode = 1;
  } finally {
    terminal.close();
  }
}
