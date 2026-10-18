import { mkdirSync, existsSync, lstatSync, renameSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
for (const path of ['.cache/tmp', '.cache/cloudflare/config', '.cache/cloudflare/logs'])
  mkdirSync(path, { recursive: true });
// Wrangler keeps some temporary bundles next to its config. Redirect them into our cache.
const hidden = 'cloudflare/.wrangler',
  cache = '.cache/cloudflare/wrangler';
if (existsSync(hidden) && !lstatSync(hidden).isSymbolicLink() && !existsSync(cache))
  renameSync(hidden, cache);
mkdirSync(cache, { recursive: true });
if (!existsSync(hidden)) symlinkSync('../.cache/cloudflare/wrangler', hidden, 'dir');
const env = {
  ...process.env,
  TMPDIR: resolve('.cache/tmp'),
  TMP: resolve('.cache/tmp'),
  TEMP: resolve('.cache/tmp'),
  XDG_CONFIG_HOME: resolve('.cache/cloudflare/config'),
  WRANGLER_LOG_PATH: resolve('.cache/cloudflare/logs'),
  WRANGLER_SEND_METRICS: 'false',
};
const wrangler = ['./node_modules/wrangler/bin/wrangler.js'];
const commands = {
  check: [
    ['./node_modules/typescript/bin/tsc', '--noEmit'],
    ['./node_modules/typescript/bin/tsc', '-p', 'cloudflare/tsconfig.json'],
    ['./node_modules/typescript/bin/tsc', '-p', 'cloudflare/tests/tsconfig.json'],
    [
      ...wrangler,
      'deploy',
      '--config',
      'cloudflare/wrangler.jsonc',
      '--dry-run',
      '--outdir',
      resolve('.cache/cloudflare/bundle'),
    ],
  ],
  dev: [
    [
      ...wrangler,
      'dev',
      '--config',
      'cloudflare/wrangler.jsonc',
      '--persist-to',
      resolve('data/cloudflare'),
      '--ip',
      '127.0.0.1',
      '--port',
      '8787',
      // No sign-in in development; a deployment never sets this.
      '--var',
      'HOUSEHOLD_DEVELOPMENT:true',
    ],
  ],
  // Code only, as continuous deployment does; secrets and dashboard variables are kept.
  deploy: [[...wrangler, 'deploy', '--config', 'cloudflare/wrangler.jsonc']],
  // Upload cloudflare/.prod.vars as Worker secrets; secrets missing from the file are kept.
  secrets: [
    [
      ...wrangler,
      'secret',
      'bulk',
      'cloudflare/.prod.vars',
      '--config',
      'cloudflare/wrangler.jsonc',
    ],
  ],
  // The Worker under test serves the built client, so build it first.
  test: [
    ['./node_modules/vite/bin/vite.js', 'build', '--logLevel', 'warn'],
    ['./node_modules/vitest/vitest.mjs', 'run', '--config', 'cloudflare/vitest.config.ts'],
  ],
  wrangler: [[...wrangler, ...process.argv.slice(3)]],
};
const selected = commands[process.argv[2]];
if (!selected) throw new Error('Unknown Cloudflare command');
if (process.argv[2] === 'secrets') {
  if (!existsSync('cloudflare/.prod.vars')) {
    console.error(
      'Nothing to upload: npm run ai:connect -- --production creates cloudflare/.prod.vars.',
    );
    process.exit(1);
  }
}
for (const args of selected) {
  const child = spawn(process.execPath, args, { env, stdio: 'inherit' });
  const interrupt = () => child.kill('SIGINT'),
    terminate = () => child.kill('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  const code = await new Promise((resolve, reject) => {
    child.once('exit', (code) => resolve(code ?? 1));
    child.once('error', reject);
  });
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', terminate);
  if (code !== 0) {
    process.exitCode = code;
    break;
  }
}
