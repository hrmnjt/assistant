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
          // A deployment, so people need a Cloudflare Access identity, and two test people.
          HOUSEHOLD_DEVELOPMENT: '',
          PERSON_1_NAME: 'Alex',
          PERSON_1_EMAIL: 'alex@example.com',
          PERSON_2_NAME: 'Sam',
          PERSON_2_EMAIL: 'sam@example.com',
        },
      },
    }),
  ],
  test: { include: ['cloudflare/tests/**/*.test.ts'], testTimeout: 20000 },
});
