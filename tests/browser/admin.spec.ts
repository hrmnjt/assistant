import { mkdir } from 'node:fs/promises';
import { test, expect } from './household-fixture';
import type { Page, TestInfo } from '@playwright/test';

async function shot(page: Page, info: TestInfo, name: string) {
  await mkdir('.cache/ui-screenshots', { recursive: true });
  const path = `.cache/ui-screenshots/${info.project.name}-${name}.png`;
  await page.screenshot({ path, scale: 'css', animations: 'disabled', fullPage: true });
  await info.attach(name, { path, contentType: 'image/png' });
}

test('admin: token sign-in, Access check, both people, iCloud and the model, then sign out', async ({
  page,
  household,
}, info) => {
  const admin = household.admin;
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Admin', exact: true })).toBeVisible();
  const token = page.getByLabel('Admin token');
  await token.fill('not the token');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('That admin token is not right.');
  await token.fill(admin.token);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Access signed you in as alex@example.com.')).toBeVisible();

  // Both people: names and the emails Access lets in.
  const second = page.getByRole('group', { name: 'Second person' });
  await second.getByLabel('Email').fill('alex@example.com');
  await page.getByRole('button', { name: 'Save the two of you' }).click();
  await expect(page.getByRole('alert')).toHaveText('Use a different email for each person.');
  await second.getByLabel('Name').fill('Sammy');
  await second.getByLabel('Email').fill('sam@new.example');
  await page.getByRole('button', { name: 'Save the two of you' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(admin.people[1]).toEqual({ id: 'partner', name: 'Sammy', email: 'sam@new.example' });

  // The shared calendar: Apple ID and app-specific password, then one of its calendars.
  await page.getByLabel('Apple ID').fill('family@icloud.example');
  await page.getByLabel('App-specific password').fill('wrong-password');
  await page.getByRole('button', { name: 'Find calendars' }).click();
  await expect(page.getByRole('alert')).toContainText('did not accept');
  await page.getByLabel('App-specific password').fill('abcd-efgh-ijkl-mnop');
  await page.getByRole('button', { name: 'Find calendars' }).click();
  await expect(page.getByRole('combobox', { name: 'Calendar', exact: true })).toHaveValue(
    'https://caldav.icloud.com/1/calendars/home/',
  );
  await page.getByRole('button', { name: 'Connect calendar' }).click();
  await expect(page.getByText('Connected to Household as family@icloud.example.')).toBeVisible();
  const connect = household.calls.findLast((call) => call.path === '/admin/calendar');
  expect(connect?.body).toEqual({
    username: 'family@icloud.example',
    password: 'abcd-efgh-ijkl-mnop',
    calendarUrl: 'https://caldav.icloud.com/1/calendars/home/',
  });

  // The assistant's model, from the connected account's catalog.
  await page.getByRole('button', { name: 'Choose the model' }).click();
  await page.getByRole('combobox', { name: 'Model', exact: true }).selectOption('gpt-6.1-mini');
  await page.getByRole('button', { name: 'Use this model' }).click();
  await expect(
    page.getByText('ChatGPT is connected. The assistant uses gpt-6.1-mini.'),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await shot(page, info, 'admin');

  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Find calendars' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out of admin' }).click();
  await expect(page.getByLabel('Admin token')).toBeVisible();
});

test('admin: says when Access does not reach the app, and when ADMIN_TOKEN is missing', async ({
  page,
  household,
}) => {
  household.admin.access = null;
  household.admin.signedIn = true;
  await page.goto('/admin');
  await expect(page.getByText(/^Access sent a sign-in token on this request/)).toBeVisible();
  household.admin.accessToken = false;
  await page.reload();
  await expect(page.getByText(/^No Access sign-in reached the app on this request/)).toBeVisible();
  household.admin.access = 'someone@example.com';
  await page.reload();
  await expect(page.getByText(/which is not one of the two people’s emails below/)).toBeVisible();
  household.admin.signedIn = false;
  household.admin.unavailable =
    'Admin sign-in is off: add ADMIN_TOKEN, at least 32 random characters, as a Secret on the Worker.';
  await page.reload();
  await expect(page.getByRole('alert')).toHaveText(household.admin.unavailable);
  await expect(page.getByLabel('Admin token')).toHaveCount(0);
});

test('admin: connect ChatGPT by pasting back the address the sign-in ended on', async ({
  page,
  household,
}, info) => {
  household.admin.signedIn = true;
  household.admin.ai = { connected: false, model: null };
  await page.goto('/admin');
  await page.getByRole('button', { name: 'Connect ChatGPT' }).click();
  await expect(page.getByRole('link', { name: 'Sign in with ChatGPT' })).toHaveAttribute(
    'href',
    /^https:\/\/auth\.openai\.com\/api\/accounts\/authorize\?/,
  );
  const address = page.getByLabel('Address after signing in');
  await address.fill('http://127.0.0.1:1455/auth/callback?code=x&state=other&client_id=c');
  await page.getByRole('button', { name: 'Finish connecting' }).click();
  await expect(page.getByRole('alert')).toContainText('not from this sign-in');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await shot(page, info, 'admin-chatgpt');
  await page.getByRole('button', { name: 'Start again' }).click();
  await page.getByRole('button', { name: 'Connect ChatGPT' }).click();
  await address.fill('http://127.0.0.1:1455/auth/callback?code=x&state=fixture-state&client_id=c');
  await page.getByRole('button', { name: 'Finish connecting' }).click();
  await expect(page.getByText('ChatGPT is connected. Choose its model.')).toBeVisible();
  await page.getByRole('button', { name: 'Disconnect ChatGPT' }).click();
  await expect(page.getByRole('button', { name: 'Connect ChatGPT' })).toBeVisible();
});
