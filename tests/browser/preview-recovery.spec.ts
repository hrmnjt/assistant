import { test, expect, type Page } from '@playwright/test';
import type { Snapshot } from '../../src/types.js';

async function login(page: Page, username: 'owner' | 'partner') {
  await page.goto('/');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(`Browser-test-${username}-password`);
  await page.getByRole('button', { name: 'Come on in', exact: true }).click();
  await expect(page.locator('.app-shell')).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  const response = await request.post('/__test/reset', {
    headers: { 'X-Household-Test': 'reset' },
  });
  expect(response.status()).toBe(204);
});

test('reload/login restores direct previews and expired uncertain results without another write', async ({
  page,
  browser,
}, testInfo) => {
  await login(page, 'owner');
  await expect(page.getByRole('dialog', { name: 'Saved changes' })).toBeVisible();
  const response = await page.request.post('/api/previews', {
    headers: { 'X-Household-Client': '1' },
    data: {
      kind: 'task.create',
      task: {
        title: 'Browser recoverable task',
        notes: '',
        category: 'household',
        ownerId: 'owner',
        dueAt: null,
        schedule: null,
      },
    },
  });
  expect(response.status()).toBe(201);
  const direct = await response.json();
  await page.reload();
  const saved = page.getByRole('dialog', { name: 'Saved changes' });
  await expect(saved.getByRole('button', { name: 'Review saved change', exact: true })).toHaveCount(
    2,
  );

  await page.screenshot({ path: testInfo.outputPath('saved-changes.png') });

  // Another login/device must not receive or act on either owner-owned preview.
  const other = await browser.newContext({
    baseURL: 'http://127.0.0.1:4173',
    serviceWorkers: 'block',
  });
  try {
    const partnerPage = await other.newPage();
    await login(partnerPage, 'partner');
    await expect(partnerPage.getByRole('dialog', { name: 'Saved changes' })).toHaveCount(0);
    expect(await (await partnerPage.request.get('/api/previews')).json()).toEqual([]);
    const forbidden = await partnerPage.request.post(`/api/previews/${direct.id}/confirm`, {
      headers: { 'X-Household-Client': '1' },
      data: {},
    });
    expect(forbidden.status()).toBe(404);
  } finally {
    await other.close();
  }

  await saved
    .getByRole('article')
    .filter({ hasText: 'Browser recoverable task' })
    .getByRole('button', { name: 'Review saved change', exact: true })
    .click();
  await page.getByRole('button', { name: 'Confirm change', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Create this task?' })).toHaveCount(0);
  let state: Snapshot = await (await page.request.get('/api/state')).json();
  expect(state.tasks.filter((item) => item.title === 'Browser recoverable task')).toHaveLength(1);
  await page.reload();
  await page.getByRole('button', { name: 'Review saved change', exact: true }).click();
  const uncertain = page.getByRole('dialog', { name: 'Add this appointment?' });
  await expect(
    uncertain.getByRole('button', { name: 'Check result (read only)', exact: true }),
  ).toBeEnabled();
  await uncertain.getByRole('button', { name: 'Check result (read only)', exact: true }).click();
  await expect(uncertain.getByRole('status')).toContainText('No further write was sent');
  state = await (await page.request.get('/api/state')).json();
  expect(state.calendar.events).toHaveLength(1);
  expect(state.calendar.events[0].title).toBe('Later human calendar edit');
  await uncertain.getByRole('button', { name: 'Review current calendar', exact: true }).click();
  await expect(uncertain).toHaveCount(0);
  await page.getByRole('button', { name: 'Review saved changes (1)', exact: true }).click();
  await page.getByRole('button', { name: 'Review saved change', exact: true }).click();
  await page.getByRole('button', { name: 'Dismiss result', exact: true }).click();
  await page.reload();
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Saved changes' })).toHaveCount(0);
  expect(await (await page.request.get('/api/previews')).json()).toEqual([]);
});
