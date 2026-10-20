import { test, expect } from '@playwright/test';
import type { Snapshot } from '../../src/types.js';

test.beforeEach(async ({ request }) => {
  const response = await request.post('/__test/reset', {
    headers: { 'X-Household-Test': 'reset' },
  });
  expect(response.status()).toBe(204);
});

test('after a reload, saved changes can still be confirmed, and an uncertain calendar write is checked without writing again', async ({
  page,
}) => {
  // The server starts with an earlier calendar write whose result is unknown.
  await page.goto('/');
  const saved = page.getByRole('dialog', { name: 'Saved changes' });
  await expect(saved).toBeVisible();
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
  await page.reload();
  await expect(saved.getByRole('button', { name: 'Review saved change', exact: true })).toHaveCount(
    2,
  );

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
  await uncertain.getByRole('button', { name: 'Check result (read only)', exact: true }).click();
  await expect(uncertain.getByRole('status')).toContainText('No further write was sent');
  state = await (await page.request.get('/api/state')).json();
  expect(state.calendar.events.map((event) => event.title)).toEqual(['Later human calendar edit']);
  await uncertain.getByRole('button', { name: 'Review current calendar', exact: true }).click();
  await expect(uncertain).toHaveCount(0);
  await page.getByRole('button', { name: 'Review saved changes (1)', exact: true }).click();
  await page.getByRole('button', { name: 'Review saved change', exact: true }).click();
  await page.getByRole('button', { name: 'Dismiss result', exact: true }).click();
  await page.reload();
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(saved).toHaveCount(0);
  expect(await (await page.request.get('/api/previews')).json()).toEqual([]);
});
