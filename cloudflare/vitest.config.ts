import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import webpush from 'web-push';

// Wrangler also loads a developer's private cloudflare/.dev.vars. Blank every
// documented setting so tests never see real accounts, calendars or ChatGPT.
const blank = Object.fromEntries(
  [...readFileSync('cloudflare/.dev.vars.example', 'utf8').matchAll(/^(?:# )?([A-Z_]+)=/gm)].map(
    ([, key]) => [key, ''],
  ),
);
const vapid = webpush.generateVAPIDKeys();
export default defineConfig({
  cacheDir: '.cache/cloudflare/vite',
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './cloudflare/wrangler.jsonc' },
      miniflare: {
        bindings: {
          ...blank,
          // A deployment: no HOUSEHOLD_DEVELOPMENT, so people need a Cloudflare Access identity.
          PUSH_CONTACT: 'mailto:test@example.com',
          VAPID_PUBLIC_KEY: vapid.publicKey,
          VAPID_PRIVATE_KEY: vapid.privateKey,
        },
      },
    }),
  ],
  test: { include: ['cloudflare/tests/**/*.test.ts'], testTimeout: 20000 },
});
