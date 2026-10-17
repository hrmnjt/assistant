import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  cacheDir: '.cache/cloudflare/vite',
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './cloudflare/wrangler.jsonc' },
      miniflare: {
        bindings: {
          APP_ORIGIN: 'https://prototype.test',
          OWNER_PASSWORD: 'Owner-test-password-123',
          PARTNER_PASSWORD: 'Partner-test-password-123',
          MODEL_MODE: 'fixture',
          ALLOW_HOSTED_CHATGPT: 'false',
          CHATGPT_MODEL_ID: '',
          CHATGPT_CREDENTIAL_JSON: '',
          ICLOUD_USERNAME: '',
          ICLOUD_APP_PASSWORD: '',
          ICLOUD_CALENDAR_NAME: 'Household',
          ICLOUD_CALENDAR_URL: '',
          PUSH_CONTACT: '',
          VAPID_PUBLIC_KEY: '',
          VAPID_PRIVATE_KEY: '',
        },
      },
    }),
  ],
  test: { include: ['cloudflare/tests/**/*.test.ts'], testTimeout: 20000 },
});
