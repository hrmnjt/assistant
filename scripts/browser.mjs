import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
mkdirSync('.cache/tmp', { recursive: true });
const result = spawnSync(
  process.execPath,
  ['node_modules/@playwright/test/cli.js', ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: resolve('.cache/playwright'),
      TMPDIR: resolve('.cache/tmp'),
      TMP: resolve('.cache/tmp'),
      TEMP: resolve('.cache/tmp'),
    },
  },
);
process.exit(result.status ?? 1);
