import { defineConfig, devices } from '@playwright/test';

const phone = { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } };
// This scenario runs against the real API handler rather than the page's stubbed API.
const fullStack = '**/preview-recovery.spec.ts';

export default defineConfig({
  testDir: './tests/browser',
  outputDir: './.cache/ui-results',
  fullyParallel: true,
  reporter: [['list'], ['html', { outputFolder: '.cache/ui-report', open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:5189', serviceWorkers: 'block', trace: 'retain-on-failure' },
  projects: [
    { name: 'phone-webkit', testIgnore: fullStack, use: phone },
    {
      name: 'desktop',
      testIgnore: fullStack,
      use: { browserName: 'chromium', viewport: { width: 1440, height: 1000 } },
    },
    {
      name: 'full-stack',
      testMatch: fullStack,
      // Its tests reset one shared server, so they run in order.
      fullyParallel: false,
      use: { ...phone, baseURL: 'http://127.0.0.1:4173' },
    },
  ],
  webServer: [
    {
      // The built app alone; it forwards no API request.
      command:
        'npm run build && node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 5189 --strictPort',
      url: 'http://127.0.0.1:5189',
      reuseExistingServer: false,
    },
    {
      // The same build with the Worker's API handler on Node, as a development server.
      command: 'node --import tsx tests/browser/server.ts',
      env: { HOUSEHOLD_BROWSER_TEST: '1', TSX_DISABLE_CACHE: '1' },
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: false,
    },
  ],
});
