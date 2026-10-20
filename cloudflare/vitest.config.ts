import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';

// Wrangler also loads a developer's private cloudflare/.dev.vars. Blank every
// documented setting so tests never see real accounts, calendars or ChatGPT.
const blank = Object.fromEntries(
  [...readFileSync('cloudflare/.dev.vars.example', 'utf8').matchAll(/^(?:# )?([A-Z_]+)=/gm)].map(
    ([, key]) => [key, ''],
  ),
);
export default defineConfig({
  cacheDir: '.cache/cloudflare/vite',
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './cloudflare/wrangler.jsonc' },
      miniflare: {
        bindings: {
          ...blank,
          // A deployment, so people need a Cloudflare Access identity; the admin a token.
          HOUSEHOLD_DEVELOPMENT: '',
          ADMIN_TOKEN: 'test-admin-token-0123456789-abcdefghij',
        },
      },
    }),
  ],
  test: { include: ['cloudflare/tests/**/*.test.ts'], testTimeout: 20000 },
});
