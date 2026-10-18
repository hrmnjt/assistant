import { test, expect } from '@playwright/test';

test('the fixture preview host never forwards unmocked API requests', async ({ request }) => {
  // APIRequestContext deliberately bypasses page.route mocks.
  const response = await request.get('/api/state', { headers: { Accept: 'application/json' } });
  expect(response.status()).toBe(404);
  expect(response.headers()['content-type'] ?? '').not.toContain('application/json');
});
