import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// One local app on http://localhost:8787: Wrangler runs the same Worker and
// Durable Object as deployment and serves the client, rebuilt on each change.
// There is no sign-in; it answers only on this computer.
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
if (!existsSync('cloudflare/.dev.vars'))
  console.log(
    'No cloudflare/.dev.vars: running without phone push, iCloud or ChatGPT. npm run configure creates one.',
  );
const vite = 'node_modules/vite/bin/vite.js';
if (spawnSync(process.execPath, [vite, 'build'], { stdio: 'inherit' }).status !== 0)
  process.exit(1);
const children = [
  spawn(process.execPath, [vite, 'build', '--watch'], { stdio: 'inherit' }),
  spawn(process.execPath, ['scripts/cloudflare.mjs', 'dev'], { stdio: 'inherit' }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
for (const child of children) child.on('exit', (code) => stop(code ?? 1));
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
