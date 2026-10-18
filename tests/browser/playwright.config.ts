import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'preview-recovery.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 60_000,
  outputDir: '../../.cache/tests/browser-results',
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'phone-chromium', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
    { name: 'phone-webkit', use: { ...devices['iPhone 13'] } },
    {
      name: 'small-phone',
      use: {
        browserName: 'chromium',
        viewport: { width: 320, height: 740 },
        isMobile: true,
        hasTouch: true,
      },
    },
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 1000 } } },
  ],
  webServer: {
    command: 'node --import tsx tests/browser/server.ts',
    env: { HOUSEHOLD_BROWSER_TEST: '1', TSX_DISABLE_CACHE: '1' },
    cwd: process.cwd(),
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
