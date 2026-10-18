import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  // This full-stack scenario has its own isolated server/configuration.
  testIgnore: '**/preview-recovery.spec.ts',
  outputDir: './.cache/ui-results',
  fullyParallel: true,
  reporter: [['list'], ['html', { outputFolder: '.cache/ui-report', open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:5189', serviceWorkers: 'block', trace: 'retain-on-failure' },
  projects: [
    {
      name: 'phone-chromium',
      use: {
        ...devices['iPhone 13'],
        viewport: { width: 390, height: 844 },
        defaultBrowserType: 'chromium',
      },
    },
    {
      name: 'phone-webkit',
      use: { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } },
    },
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 1000 } } },
    {
      name: 'small-phone',
      use: {
        browserName: 'chromium',
        viewport: { width: 320, height: 740 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: {
    command:
      'npm run build && node node_modules/vite/bin/vite.js preview --config tests/browser/preview-vite.config.ts --host 127.0.0.1 --port 5189 --strictPort',
    url: 'http://127.0.0.1:5189',
    reuseExistingServer: false,
  },
});
