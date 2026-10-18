import { test, expect, navigate } from './household-fixture';
import type { Page } from '@playwright/test';

/** Hold the next message send until released, as a slow phone connection would. */
async function slowSends(page: Page) {
  let hold: Promise<void> | undefined;
  await page.route('**/api/threads/*/messages', async (route) => {
    const pending = route.request().method() === 'POST' ? hold : undefined;
    if (pending) hold = undefined;
    await pending;
    await route.fallback();
  });
  return () => {
    let release!: () => void;
    hold = new Promise<void>((resolve) => (release = resolve));
    return () => release();
  };
}

test('a slow send clears only the submitted text and keeps anything typed meanwhile', async ({
  page,
}) => {
  await page.goto('/');
  const input = page.getByLabel('Message', { exact: true });
  const holdNext = await slowSends(page);
  let release = holdNext();
  await input.fill('Buy oat milk');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  await input.press('End');
  await input.pressSequentially(' and lemons');
  release();
  await expect(page.getByRole('log')).toContainText('Buy oat milk');
  await expect(input).toHaveValue('and lemons');
  // Text replaced while sending is kept entirely.
  release = holdNext();
  await input.fill('Call the dentist');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  await input.fill('Something else entirely');
  release();
  await expect(page.getByRole('log')).toContainText('Call the dentist');
  await expect(input).toHaveValue('Something else entirely');
});

test('a send whose response is lost is retried with the same request ID', async ({
  page,
  household,
}) => {
  await page.goto('/');
  const input = page.getByLabel('Message', { exact: true });
  let lost = false;
  await page.route('**/api/threads/*/messages', async (route) => {
    if (route.request().method() === 'POST' && !lost) {
      lost = true;
      // The server stores the message, but its response never arrives.
      household.calls.push({
        path: '/threads/assistant-owner/messages',
        method: 'POST',
        body: route.request().postDataJSON(),
      });
      return route.abort('connectionreset');
    }
    await route.fallback();
  });
  await input.fill('Plan the week');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(input).toHaveValue('Plan the week');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(input).toHaveValue('');
  const sends = household.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/messages'));
  expect(sends).toHaveLength(2);
  expect(sends[1].body.requestId).toBe(sends[0].body.requestId);
  await input.fill('A different message');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(input).toHaveValue('');
  const last = household.calls.findLast((c) => c.method === 'POST' && c.path.endsWith('/messages'));
  expect(last!.body.requestId).not.toBe(sends[0].body.requestId);
});

test('an @assistant mention anywhere in a channel message asks Our day, and says so first', async ({
  page,
  household,
}) => {
  await page.goto('/');
  const input = page.getByLabel('Message', { exact: true });
  await expect(input).toBeVisible();
  const channels = page.getByRole('button', { name: 'Open menu' });
  if (await channels.isVisible()) await channels.click();
  await page.getByRole('button', { name: /Weekend plans/ }).click();
  const lastSend = () =>
    household.calls.findLast((c) => c.method === 'POST' && c.path.endsWith('/messages'))?.body;
  await input.fill('Could @assistant help with this?');
  await expect(page.getByRole('status').filter({ hasText: 'Our day will reply' })).toBeVisible();
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(() => lastSend()?.text).toBe('Could @assistant help with this?');
  expect(lastSend()!.askAssistant).toBe(true);
  await input.fill('Ask the @assistants channel');
  await expect(page.getByText('Our day will reply')).toHaveCount(0);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(() => lastSend()?.text).toBe('Ask the @assistants channel');
  expect(lastSend()!.askAssistant).toBe(false);
});

test('a task changed by the other spouse reloads into the editor with the edits kept', async ({
  page,
  household,
}) => {
  await page.goto('/');
  await navigate(page, 'Tasks');
  await page.getByRole('button', { name: 'Water the plants', exact: true }).click();
  const title = page.getByLabel('What needs doing?');
  await title.fill('Water the balcony plants');
  household.state.tasks[0] = {
    ...household.state.tasks[0],
    title: 'Water the garden',
    notes: 'Sam changed this',
    revision: 2,
  };
  await page.getByRole('button', { name: 'Review changes' }).click();
  const editor = page.getByRole('dialog', { name: 'Edit task' });
  await expect(editor.getByRole('alert')).toContainText('changed while you were editing');
  await expect(title).toHaveValue('Water the balcony plants');
  await page.getByRole('button', { name: 'Review changes' }).click();
  await expect(page.getByRole('button', { name: 'Confirm change' })).toBeVisible();
  const proposal = household.calls.findLast((c) => c.path === '/previews' && c.method === 'POST')!;
  expect(proposal.body.revision).toBe(2);
  expect(proposal.body.task.title).toBe('Water the balcony plants');
  await page.getByRole('button', { name: 'Go back' }).click();
  await editor.getByRole('button', { name: 'Discard my edits and show the latest' }).click();
  await expect(title).toHaveValue('Water the garden');
  await expect(editor.getByRole('alert')).toHaveCount(0);
});

test('a task deleted during editing cannot be submitted again', async ({ page, household }) => {
  await page.goto('/');
  await navigate(page, 'Tasks');
  await page.getByRole('tab', { name: 'Everything' }).click();
  await page.getByRole('button', { name: 'Book the car service', exact: true }).click();
  household.state.tasks = household.state.tasks.filter((task) => task.id !== 'task-2');
  await page.getByRole('button', { name: 'Review changes' }).click();
  const editor = page.getByRole('dialog', { name: 'Edit task' });
  await expect(editor.getByRole('alert')).toContainText('was deleted');
  await expect(editor.getByRole('button', { name: 'Review changes' })).toBeDisabled();
});

test('an appointment changed in Apple Calendar reloads with its current ETag', async ({
  page,
  household,
}) => {
  await page.goto('/');
  await navigate(page, 'Calendar');
  await page.getByRole('button', { name: /19:00.*Dinner together/ }).click();
  const title = page.getByLabel('Appointment', { exact: true });
  await title.fill('Dinner with friends');
  household.state.calendar.events[0] = {
    ...household.state.calendar.events[0],
    etag: 'v2',
    location: 'At home',
  };
  await page.getByRole('button', { name: 'Review appointment' }).click();
  const editor = page.getByRole('dialog', { name: 'Shared appointment' });
  await expect(editor.getByRole('alert')).toContainText('changed while you were editing');
  expect(household.calls.some((c) => c.path === '/calendar/refresh')).toBe(true);
  await expect(title).toHaveValue('Dinner with friends');
  await page.getByRole('button', { name: 'Review appointment' }).click();
  await expect(page.getByRole('button', { name: 'Confirm change' })).toBeVisible();
  const proposal = household.calls.findLast((c) => c.path === '/previews' && c.method === 'POST')!;
  expect(proposal.body.etag).toBe('v2');
  expect(proposal.body.event.title).toBe('Dinner with friends');
});
