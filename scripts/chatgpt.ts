import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { aiConfig, chatgptModels, LocalCredentials, projectDataDir } from '../server/ai.js';

process.umask(0o077);
process.env.PI_OAUTH_CALLBACK_HOST = '127.0.0.1';
const directory = projectDataDir();
await mkdir(directory, { recursive: true, mode: 0o700 });
await chmod(directory, 0o700);
const credentials = new LocalCredentials(directory);
const models = chatgptModels(credentials);
if (process.argv.includes('--logout')) {
  await models.logout('openai');
  console.log(
    'Local ChatGPT connection removed. Restart the app. Revoke access in ChatGPT settings if desired.',
  );
} else {
  const config = await aiConfig(directory);
  const save = () =>
    writeFile(resolve(directory, 'chatgpt-host.json'), JSON.stringify(config), { mode: 0o600 });
  // Persist the stable host identifier before the first authorization request.
  await save();
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    console.log(
      'Connect the household server to your ChatGPT plan. Eligible requests use its limits. No API-key fallback is used.',
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
      { getDeviceId: () => config.hostId, agentName: 'Our day household assistant' },
    );
    const auth = await models.getAuth('openai', { signal: AbortSignal.timeout(15000) });
    if (!auth?.auth.apiKey) throw new Error('No OAuth access token was returned.');
    const response = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${auth.auth.apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new Error('The account model catalog is unavailable. Try reconnecting.');
    const body = (await response.json()) as {
      models?: { slug: string; display_name: string; visibility: string }[];
    };
    const available = body.models?.filter(
      (model) => model.visibility === 'list' && models.getModel('openai', model.slug),
    );
    if (!available?.length) throw new Error('No supported model was found for this account.');
    available.forEach((model, index) =>
      console.log(`${index + 1}. ${model.display_name} (${model.slug})`),
    );
    const index = Number(await terminal.question('Choose a model number: ')) - 1;
    if (!Number.isInteger(index) || !available[index])
      throw new Error('Choose a listed model number.');
    config.modelId = available[index].slug;
    await save();
    console.log(
      'ChatGPT is configured. Restart the app, then send a message to validate completed inference. Shared use by both spouses still requires account eligibility validation.',
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
