import { mkdir } from 'node:fs/promises';
import { test, expect, navigate } from './household-fixture';
import type { Page, TestInfo } from '@playwright/test';

async function shot(page: Page, info: TestInfo, name: string) {
  await mkdir('.cache/ui-screenshots', { recursive: true });
  const path = `.cache/ui-screenshots/${info.project.name}-${name}.png`;
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path, scale: 'css', animations: 'disabled' });
  await info.attach(name, { path, contentType: 'image/png' });
}
async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test('signed out: loading, then the reason and a way back through Cloudflare Access', async ({
  page,
  household,
}, info) => {
  household.signedIn = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    '**/api/state',
    async (route) => {
      await gate;
      await route.fallback();
    },
    { times: 1 },
  );
  await page.goto('/');
  await expect(page.getByRole('status')).toHaveText('Finding our place…');
  release();
  await expect(page.getByRole('alert')).toHaveText(
    'Sign in through Cloudflare Access with one of the household’s two email addresses.',
  );
  await expect(page.getByRole('link', { name: 'Use a different email' })).toHaveAttribute(
    'href',
    '/cdn-cgi/access/logout',
  );
  await noHorizontalOverflow(page);
  await shot(page, info, 'signed-out');
  // Signing in happens on Access's own page; back in the app, a reload finds the session.
  household.signedIn = true;
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();

  // An Access sign-in that has ended redirects API calls; that reads as signed out, not offline.
  await page.route('**/api/state', (route) =>
    route.fulfill({
      status: 302,
      headers: { Location: 'https://household.cloudflareaccess.com/' },
    }),
  );
  await page.reload();
  await expect(page.getByRole('alert')).toHaveText(
    'Your sign-in has ended. Sign in again to continue.',
  );
});

test('settings: sign out through Access, or act as the other person in development', async ({
  page,
  household,
}) => {
  await page.route('**/cdn-cgi/access/logout', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<p>Signed out of Access</p>' }),
  );
  await page.goto('/');
  await navigate(page, 'Settings');
  await expect(page.getByRole('button', { name: /^Act as/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText('Signed out of Access')).toBeVisible();

  household.state.signIn = 'development';
  await page.goto('/');
  await navigate(page, 'Settings');
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
  await Promise.all([
    page.waitForEvent('load'),
    page.getByRole('button', { name: 'Act as Sam' }).click(),
  ]);
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
  const cookies = await page.context().cookies();
  expect(cookies.find((cookie) => cookie.name === 'household-dev-person')?.value).toBe('partner');
});

test('chat: suggestions, saved messages, shared history, presence, and channel switch', async ({
  page,
  household,
}, info) => {
  await page.goto('/');
  const composer = page.getByLabel('Message', { exact: true });
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  await shot(page, info, 'chat-empty');
  await page.getByRole('button', { name: 'What’s on today?' }).click();
  await expect(composer).toBeFocused();
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('log')).toContainText('What’s on today?');
  await expect(composer).toHaveValue('');
  const channels = page.getByRole('button', { name: 'Open menu' });
  if (await channels.isVisible()) await channels.click();
  await page.getByRole('button', { name: /Weekend plans/ }).click();
  await expect(page.getByRole('log')).toContainText('Shall we make time for a walk?');
  await expect(page.locator('.typing-status')).toBeVisible();
  await page.getByRole('switch').check();
  await composer.fill('Let’s go after dinner');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect
    .poll(
      () =>
        household.calls.findLast((c) => c.path.endsWith('/messages') && c.method === 'POST')?.body
          .askAssistant,
    )
    .toBe(true);
  await noHorizontalOverflow(page);
  await shot(page, info, 'chat-shared');
});

test('tasks: tabs, missed history, form draft, cancel, explicit confirmation, menu', async ({
  page,
  household,
}, info) => {
  await page.goto('/');
  await navigate(page, 'Tasks');
  await page.getByRole('tab', { name: 'For me' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Household' })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Household' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(
    page.getByRole('button', { name: 'Book the car service', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Missed 2 times' }).click();
  await expect(page.locator('.missed li')).toHaveCount(2);
  await shot(page, info, 'tasks');
  await page.getByRole('button', { name: 'Add task' }).click();
  await page.getByLabel('What needs doing?').fill('Pick up groceries');
  await page.getByLabel('Follow-up owner').selectOption('partner');
  await page.getByRole('combobox', { name: 'Space', exact: true }).selectOption('household');
  await page.getByLabel('Anything else?').fill('Oat milk and lemons');
  await noHorizontalOverflow(page);
  await page.getByRole('button', { name: 'Review task', exact: true }).click();
  await expect(page.getByRole('dialog').last()).toContainText('Nothing changes until you confirm.');
  expect(household.calls.filter((c) => c.path.endsWith('/confirm'))).toHaveLength(0);
  await shot(page, info, 'confirmation');
  await page.getByRole('button', { name: 'Go back' }).click();
  await expect(page.getByLabel('What needs doing?')).toHaveValue('Pick up groceries');
  await expect(page.getByLabel('Follow-up owner')).toHaveValue('partner');
  await page.getByRole('button', { name: 'Review task', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm change' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Pick up groceries', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Actions for Water the plants' }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.getByRole('menuitem', { name: 'Review completion' }).click();
  await page.getByRole('button', { name: 'Confirm change' }).click();
  await expect(page.getByRole('button', { name: /Completed tasks/ })).toBeVisible();
  await noHorizontalOverflow(page);
});

test('confirmation: stale errors cannot be retried; cancel preserves the form; focus is trapped and restored', async ({
  page,
  household,
}) => {
  household.confirmationError = 'This task changed. Review a fresh preview.';
  await page.goto('/');
  await navigate(page, 'Tasks');
  const add = page.getByRole('button', { name: 'Add task' });
  await add.click();
  await expect(page.getByLabel('What needs doing?')).toBeFocused();
  await page.getByLabel('What needs doing?').fill('A focus test');
  await page.getByRole('button', { name: 'Review task', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm change' }).click();
  await expect(page.getByRole('alert')).toHaveText('This task changed. Review a fresh preview.');
  await expect(page.getByRole('button', { name: 'Confirm change' })).toBeDisabled();
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    expect(
      await page
        .getByRole('dialog')
        .last()
        .evaluate((el) => el.contains(document.activeElement)),
    ).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'A new task', exact: true })).toBeVisible();
  await expect(page.getByLabel('What needs doing?')).toHaveValue('A focus test');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(add).toBeFocused();
});

test('calendar: month bounds, event details, all-day form and reminders', async ({
  page,
  household,
}, info) => {
  await page.goto('/');
  await navigate(page, 'Calendar');
  await page.getByRole('button', { name: /19:00.*Dinner together/ }).click();
  await expect(page.getByLabel('Appointment', { exact: true })).toHaveValue('Dinner together');
  await page.getByRole('switch').check();
  await expect(page.getByLabel('Starts')).toHaveAttribute('type', 'date');
  await page.getByRole('combobox', { name: 'Reminder', exact: true }).selectOption('15');
  await page.getByRole('button', { name: 'Review appointment' }).click();
  const mutation = household.calls.findLast((c) => c.path === '/previews')!.body;
  expect(mutation.event.allDay).toBe(true);
  expect(mutation.event.reminderMinutes).toBe(15);
  await page.getByRole('button', { name: 'Go back' }).click();
  await expect(
    page.getByRole('heading', { name: 'Shared appointment', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Next month' }).click();
  await page.getByRole('button', { name: 'Next month' }).click();
  await expect(page.getByRole('button', { name: 'Next month' })).toBeDisabled();
  await page
    .getByLabel('Month calendar')
    .getByRole('button', { name: 'Today', exact: true })
    .click();
  await noHorizontalOverflow(page);
  await shot(page, info, 'calendar');
});

test('settings: independent switches, disabled time, preferences preview; Updates deep link', async ({
  page,
  household,
}, info) => {
  await page.goto('/');
  await navigate(page, 'Settings');
  await expect(page.getByRole('button', { name: 'Review settings' })).toBeDisabled();
  await page.getByRole('switch', { name: 'Enable morning summary' }).uncheck();
  await expect(page.getByLabel('morning summary time', { exact: true })).toBeDisabled();
  await expect(page.getByRole('switch', { name: 'Enable evening summary' })).toBeChecked();
  await page.getByRole('button', { name: 'Review settings' }).click();
  await page.getByRole('button', { name: 'Confirm change' }).click();
  await expect(page.getByRole('button', { name: 'Review settings' })).toBeDisabled();
  expect(household.state.preferences.morning.enabled).toBe(false);
  await shot(page, info, 'settings');
  await page.getByRole('button', { name: 'Open updates' }).click();
  await expect(page.getByRole('dialog')).toContainText('Sam updated a task');
  await page.getByRole('button', { name: 'View task' }).click();
  await expect(page.getByLabel('What needs doing?')).toHaveValue('Book the car service');
  await noHorizontalOverflow(page);
});

test('Today and disconnected/empty states remain readable and safe', async ({
  page,
  household,
}, info) => {
  household.state.tasks = [];
  household.state.notices = [];
  household.state.calendar.status = 'not-connected';
  household.state.calendar.events = [];
  await page.goto('/');
  await navigate(page, 'Today');
  await expect(page.getByText('A little breathing room')).toBeVisible();
  await shot(page, info, 'today-empty');
  await navigate(page, 'Calendar');
  await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
  await expect(page.getByText('Connect your shared calendar')).toBeVisible();
  await page.getByRole('button', { name: 'Open updates' }).click();
  await expect(page.getByText('You’re all caught up')).toBeVisible();
  await page.keyboard.press('Escape');
  household.offline = true;
  await expect(page.getByRole('status').filter({ hasText: 'Connection lost' })).toBeVisible({
    timeout: 8000,
  });
  await navigate(page, 'Tasks');
  await expect(page.getByRole('button', { name: 'Add task' })).toBeDisabled();
  await noHorizontalOverflow(page);
});

test('assistant running, queue, failed request and inline proposals remain reviewable', async ({
  page,
  household,
}, info) => {
  household.state.integrations.ai = 'configured';
  household.status = {
    running: true,
    queued: 2,
    error: 'The assistant request timed out. Your message is saved.',
    previews: [
      {
        actorId: 'owner',
        preview: {
          id: 'assistant-proposal',
          title: 'Add flowers to the shopping list',
          details: [{ label: 'Task', after: 'Flowers' }],
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        },
      },
    ],
  };
  household.messages['assistant-owner'] = [
    {
      id: 'm1',
      threadId: 'assistant-owner',
      authorId: 'owner',
      text: 'Can you add flowers to our list?',
      createdAt: new Date().toISOString(),
    },
    {
      id: 'm2',
      threadId: 'assistant-owner',
      authorId: 'assistant',
      text: 'Here is a preview. Please review it before anything changes.',
      createdAt: new Date().toISOString(),
    },
  ];
  await page.addInitScript(() => localStorage.setItem('chatgpt-plan-notice:owner', 'seen'));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Thinking · 2 queued' })).toBeVisible();
  await expect(page.getByRole('log')).toContainText('Please review it');
  await expect(page.getByText('The assistant request timed out.', { exact: false })).toBeVisible();
  await shot(page, info, 'chat-preview');
  await page.getByRole('button', { name: 'Review change' }).click();
  await expect(page.getByRole('dialog')).toContainText('Flowers');
  await expect(page.getByRole('dialog')).toContainText('Nothing changes until you confirm.');
});
