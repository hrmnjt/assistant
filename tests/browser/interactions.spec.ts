import { test, expect } from './household-fixture';

test('shared channel creation still requires a preview and opens the confirmed channel', async ({
  page,
  household,
}) => {
  await page.goto('/');
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
  const channels = page.getByRole('button', { name: 'Open channels' });
  if (await channels.isVisible()) await channels.click();
  await page.getByRole('button', { name: 'Add shared channel' }).click();
  await page.getByLabel('Channel name').fill('Summer plans');
  await page.getByRole('button', { name: 'Review channel' }).click();
  expect(household.state.threads.some((t) => t.title === 'Summer plans')).toBe(false);
  await page.getByRole('button', { name: 'Go back' }).click();
  await expect(page.getByLabel('Channel name')).toHaveValue('Summer plans');
  await page.getByRole('button', { name: 'Review channel' }).click();
  await page.getByRole('button', { name: 'Confirm change' }).click();
  await expect(page.getByRole('heading', { name: '# Summer plans', level: 1 })).toBeVisible();
});

test('retryable server failures and pending confirmation keep the write controls safe', async ({
  page,
  household,
}) => {
  household.confirmationError = 'Please retry this confirmation.';
  household.confirmationStatus = 503;
  await page.goto('/');
  await page.getByRole('navigation').getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'Review completion of Water the plants' }).click();
  await page.getByRole('button', { name: 'Confirm change' }).click();
  await expect(page.getByRole('alert')).toHaveText('Please retry this confirmation.');
  await expect(page.getByRole('button', { name: 'Confirm change' })).toBeEnabled();
  household.confirmationError = '';
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    '**/api/previews/*/confirm',
    async (route) => {
      await pending;
      await route.fallback();
    },
    { times: 1 },
  );
  await page.getByRole('button', { name: 'Confirm change' }).click();
  await expect(page.getByRole('button', { name: 'Saving…' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Go back' })).toBeDisabled();
  release();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(household.state.tasks[0].status).toBe('completed');
});

test('long chats scroll independently and a simulated keyboard viewport keeps the composer reachable', async ({
  page,
  household,
}, info) => {
  household.messages['assistant-owner'] = Array.from({ length: 40 }, (_, index) => ({
    id: String(index),
    threadId: 'assistant-owner',
    authorId: index % 2 ? 'assistant' : 'owner',
    text: 'A saved household message. '.repeat(4),
    createdAt: new Date().toISOString(),
  }));
  await page.goto('/');
  const messages = page.getByRole('log');
  await expect(messages.locator('article')).toHaveCount(40);
  expect(await messages.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await messages.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect.poll(() => messages.evaluate((el) => el.scrollTop)).toBe(0);
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('First line\nSecond line');
  expect(
    await input.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
  ).toBeGreaterThanOrEqual(16);
  if (info.project.name !== 'desktop') {
    // A layout simulation only: browser engines cannot verify an iOS keyboard.
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport, 'height', {
        configurable: true,
        get: () => 420,
      });
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
    await expect(page.getByRole('navigation')).toBeHidden();
    const bounds = await input.boundingBox();
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(420);
  }
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(messages).toContainText('First line');
  expect(
    household.calls.findLast((c) => c.path.endsWith('/messages') && c.method === 'POST')?.body.text,
  ).toBe('First line\nSecond line');
});

test('calendar uses one roving focus target with arrow-key navigation and Enter selection', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('navigation').getByRole('button', { name: 'Calendar', exact: true }).click();
  const day = page.locator('[data-slot="calendar"] button[tabindex="0"]');
  await expect(day).toHaveCount(1);
  await day.focus();
  const before = await day.getAttribute('aria-label');
  await page.keyboard.press('ArrowRight');
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label')))
    .not.toBe(before);
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-selected-single="true"]')).toBeFocused();
});

test('recurring read-only appointments retain their Apple Calendar editing guidance', async ({
  page,
  household,
}) => {
  household.state.calendar.events[0].recurring = true;
  household.state.calendar.events[0].readOnlyReason =
    'Recurring appointments are edited in Apple Calendar.';
  await page.goto('/');
  await page.getByRole('navigation').getByRole('button', { name: 'Calendar', exact: true }).click();
  await page.getByRole('button', { name: /19:00.*Dinner together/ }).click();
  await expect(page.getByLabel('Appointment', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Review appointment' })).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText(
    'Recurring appointments are edited in Apple Calendar.',
  );
});

test('calendar sync failure preserves cached appointments and disables writes', async ({
  page,
  household,
}) => {
  household.state.calendar.status = 'error';
  household.state.calendar.error = 'iCloud could not be reached.';
  await page.goto('/');
  await page.getByRole('navigation').getByRole('button', { name: 'Calendar', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'iCloud could not be reached.' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: /19:00.*Dinner together/ }).click();
  await expect(page.getByRole('button', { name: 'Review appointment' })).toBeDisabled();
});
