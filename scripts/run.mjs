import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const temporary = resolve('.cache/tmp');
mkdirSync(temporary, { recursive: true });
const env = {
  ...process.env,
  TMPDIR: temporary,
  TMP: temporary,
  TEMP: temporary,
  TSX_DISABLE_CACHE: '1',
};
const tsc = ['./node_modules/typescript/bin/tsc', '--noEmit'];
const commands = {
  build: [tsc, ['./node_modules/vite/bin/vite.js', 'build']],
  test: [
    [
      '--import',
      'tsx',
      '--test',
      ...readdirSync('tests')
        .filter((file) => file.endsWith('.test.ts'))
        .map((file) => `tests/${file}`),
    ],
  ],
  'ai-connect': [['--import', 'tsx', 'scripts/chatgpt.ts', ...process.argv.slice(3)]],
  'ai-disconnect': [
    ['--import', 'tsx', 'scripts/chatgpt.ts', '--remove', ...process.argv.slice(3)],
  ],
};
const selected = commands[process.argv[2]];
if (!selected) throw new Error('Unknown project command.');
for (const args of selected) {
  const child = spawn(process.execPath, args, { cwd: process.cwd(), stdio: 'inherit', env });
  const stop = (signal) => child.kill(signal);
  const interrupt = () => stop('SIGINT');
  const terminate = () => stop('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  const code = await new Promise((resolve, reject) => {
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    child.once('error', reject);
  });
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', terminate);
  if (code !== 0) {
    process.exitCode = code;
    break;
  }
}
