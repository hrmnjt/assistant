import { test, expect, navigate } from './household-fixture';
import type { Page } from '@playwright/test';

test('getting in: sign in through Access, and hear when that sign-in has ended', async ({
  page,
  household,
}) => {
  household.signedIn = false;
  await page.goto('/');
  const signIn = page.getByRole('button', { name: 'Sign in' });
  await expect(signIn).toBeVisible();
  // Signing in happens on Access's own page; back in the app, a reload finds the session.
  household.signedIn = true;
  await signIn.click();
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();

  // An ended Access sign-in redirects API calls to its login page; that reads as signed out,
  // not offline. Not every browser lets Playwright fulfill a redirect, so stand in for fetch:
  // a manual-redirect request sees the opaque redirect.
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = async (input, init) => {
      if (!String(input).endsWith('/api/state')) return original(input, init);
      if (init?.redirect !== 'manual') throw new TypeError('Load failed');
      const response = new Response(null);
      Object.defineProperty(response, 'type', { value: 'opaqueredirect' });
      return response;
    };
  });
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('sign-in has ended');
  await expect(signIn).toBeVisible();
});

test('chat: review what the assistant proposes, talk in a shared channel, and add a channel', async ({
  page,
  household,
}) => {
  household.status.previews = [
    {
      actorId: 'owner',
      preview: {
        id: 'assistant-proposal',
        title: 'Add flowers to the shopping list',
        details: [{ label: 'Task', after: 'Flowers' }],
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      },
    },
  ];
  await page.goto('/');
  await page.getByRole('button', { name: 'Review change' }).click();
  await expect(page.getByRole('dialog')).toContainText('Nothing changes until you confirm.');
  await page.getByRole('button', { name: 'Go back' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const composer = page.getByLabel('Message', { exact: true });
  const send = page.getByRole('button', { name: 'Send message' });
  // A send whose response is lost keeps its text, and the retry reuses its request ID.
  const sends = () =>
    household.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/messages'));
  let lost = false;
  await page.route('**/api/threads/*/messages', async (route) => {
    if (route.request().method() !== 'POST' || lost) return route.fallback();
    lost = true;
    household.calls.push({
      path: '/threads/assistant-owner/messages',
      method: 'POST',
      body: route.request().postDataJSON(),
    });
    return route.abort('connectionreset');
  });
  await composer.fill('What’s on today?');
  await send.click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(composer).toHaveValue('What’s on today?');
  await send.click();
  await expect(page.getByRole('log')).toContainText('What’s on today?');
  await expect(composer).toHaveValue('');
  const [first, retry] = sends();
  expect(retry.body.requestId).toBe(first.body.requestId);

  // On a phone the channels sit behind the menu.
  const channels = async () => {
    const menu = page.getByRole('button', { name: 'Open menu' });
    if (await menu.isVisible()) await menu.click();
  };
  await channels();
  await page.getByRole('button', { name: /Weekend plans/ }).click();
  await expect(page.getByRole('log')).toContainText('Shall we make time for a walk?');

  // @assistant anywhere in a message asks Our day, and says so first; @assistants does not.
  const lastSend = () => sends().at(-1)?.body;
  await composer.fill('Could @assistant help with this?');
  await expect(page.getByRole('status').filter({ hasText: 'Our day will reply' })).toBeVisible();
  await send.click();
  await expect.poll(() => lastSend()?.text).toBe('Could @assistant help with this?');
  expect(lastSend().askAssistant).toBe(true);
  expect(lastSend().requestId).not.toBe(first.body.requestId);
  await composer.fill('Ask the @assistants channel');
  await expect(page.getByText('Our day will reply')).toHaveCount(0);
  await send.click();
  await expect.poll(() => lastSend()?.text).toBe('Ask the @assistants channel');
  expect(lastSend().askAssistant).toBe(false);

  await channels();
  await page.getByRole('button', { name: 'Add shared channel' }).click();
  await page.getByLabel('Channel name').fill('Summer plans');
  await page.getByRole('button', { name: 'Review channel' }).click();
  await page.getByRole('button', { name: 'Go back' }).click();
  await expect(page.getByLabel('Channel name')).toHaveValue('Summer plans');
  await page.getByRole('button', { name: 'Review channel' }).click();
  await page.getByRole('button', { name: 'Confirm change' }).click();
  await expect(page.getByRole('heading', { name: '# Summer plans', level: 1 })).toBeVisible();
});

test('tasks: open one from Updates, add one only once it is confirmed, and complete one', async ({
  page,
  household,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open updates' }).click();
  await page.getByRole('button', { name: 'View task' }).click();
  const title = page.getByLabel('What needs doing?');
  await expect(title).toHaveValue('Book the car service');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.getByRole('button', { name: 'Add task' }).click();
  await title.fill('Pick up groceries');
  await page.getByRole('button', { name: 'Review task', exact: true }).click();
  await expect(page.getByRole('dialog').last()).toContainText('Nothing changes until you confirm.');
  expect(household.calls.filter((c) => c.path.endsWith('/confirm'))).toHaveLength(0);
  await page.getByRole('button', { name: 'Go back' }).click();
  await expect(title).toHaveValue('Pick up groceries');
  await page.getByRole('button', { name: 'Review task', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm change' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Pick up groceries', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Review completion of Water the plants' }).click();
  await page.getByRole('button', { name: 'Confirm change' }).click();
  await page.getByRole('button', { name: /Completed tasks/ }).click();
  await expect(page.locator('.completed-section')).toContainText('Water the plants');
});

/** The Calendar view, once its month grid has loaded and the appointments stay put. */
async function openCalendar(page: Page) {
  await page.goto('/');
  await navigate(page, 'Calendar');
  await expect(page.getByRole('button', { name: 'Next month' })).toBeVisible();
}

test('calendar: an appointment changed in iCloud meanwhile keeps your edits and is never written twice', async ({
  page,
  household,
}) => {
  await openCalendar(page);
  await page.getByRole('button', { name: /19:00.*Dinner together/ }).click();
  const title = page.getByLabel('Appointment', { exact: true });
  await title.fill('Dinner with friends');
  await page.getByRole('combobox', { name: 'Reminder', exact: true }).selectOption('15');
  household.state.calendar.events[0] = {
    ...household.state.calendar.events[0],
    etag: 'v2',
    location: 'At home',
  };
  await page.getByRole('button', { name: 'Review appointment' }).click();
  const editor = page.getByRole('dialog', { name: 'Shared appointment' });
  await expect(editor.getByRole('alert')).toContainText('changed while you were editing');
  await expect(title).toHaveValue('Dinner with friends');
  await page.getByRole('button', { name: 'Review appointment' }).click();
  await expect(page.getByRole('button', { name: 'Confirm change' })).toBeVisible();
  const proposal = household.calls.findLast((c) => c.path === '/previews')!.body;
  expect(proposal.etag).toBe('v2');
  expect(proposal.event).toMatchObject({ title: 'Dinner with friends', reminderMinutes: 15 });

  // It changes again before the write: no retry, only a new preview.
  household.calendarConflict = {
    status: 'conflicted',
    message: 'The appointment changed. Review a new preview.',
  };
  await page.getByRole('button', { name: 'Confirm change' }).click();
  await expect(page.getByRole('button', { name: 'New preview required' })).toBeDisabled();
  await page.getByRole('button', { name: 'Dismiss result' }).click();
  await expect(page.getByRole('dialog', { name: 'Review household change' })).toHaveCount(0);
  expect(household.calls.filter((c) => c.path.endsWith('/confirm'))).toHaveLength(1);
});

test('admin: sign in with the token, set up both people, iCloud and ChatGPT, then sign out', async ({
  page,
  household,
}) => {
  const admin = household.admin;
  await page.goto('/admin');
  await page.getByLabel('Admin token').fill(admin.token);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Access signed you in as alex@example.com.')).toBeVisible();
  // Access sent its signed token, but the app could not check it.
  admin.access = null;
  await page.reload();
  await expect(page.getByText(/^Access sent a sign-in token on this request/)).toBeVisible();

  const second = page.getByRole('group', { name: 'Second person' });
  await second.getByLabel('Name').fill('Sammy');
  await second.getByLabel('Email').fill('sam@new.example');
  await page.getByRole('button', { name: 'Save the two of you' }).click();
  await expect
    .poll(() => admin.people[1])
    .toEqual({ id: 'partner', name: 'Sammy', email: 'sam@new.example' });

  await page.getByLabel('Apple ID').fill('family@icloud.example');
  await page.getByLabel('App-specific password').fill('abcd-efgh-ijkl-mnop');
  await page.getByRole('button', { name: 'Find calendars' }).click();
  await expect(page.getByRole('combobox', { name: 'Calendar', exact: true })).toHaveValue(
    'https://caldav.icloud.com/1/calendars/home/',
  );
  await page.getByRole('button', { name: 'Connect calendar' }).click();
  await expect(page.getByText('Connected to Household as family@icloud.example.')).toBeVisible();

  // ChatGPT's sign-in ends on an address the admin pastes back.
  await page.getByRole('button', { name: 'Connect ChatGPT' }).click();
  await expect(page.getByRole('link', { name: 'Sign in with ChatGPT' })).toHaveAttribute(
    'href',
    /^https:\/\/auth\.openai\.com\//,
  );
  await page
    .getByLabel('Address after signing in')
    .fill('http://127.0.0.1:1455/auth/callback?code=x&state=fixture-state');
  await page.getByRole('button', { name: 'Finish connecting' }).click();
  await page.getByRole('button', { name: 'Choose the model' }).click();
  await page.getByRole('combobox', { name: 'Model', exact: true }).selectOption('gpt-6.1-mini');
  await page.getByRole('button', { name: 'Use this model' }).click();
  await expect(page.getByText('The assistant uses gpt-6.1-mini.')).toBeVisible();

  await page.getByRole('button', { name: 'Sign out of admin' }).click();
  await expect(page.getByLabel('Admin token')).toBeVisible();
});
