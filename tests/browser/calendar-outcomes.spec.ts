import { test, expect, navigate } from './household-fixture';
import type { Page } from '@playwright/test';

async function previewAppointment(page: Page) {
  await page.goto('/');
  await navigate(page, 'Calendar');
  await page.getByRole('button', { name: /19:00.*Dinner together/ }).click();
  await page.getByRole('button', { name: 'Review appointment', exact: true }).click();
}

test('structured uncertain outcomes keep read-only checks and explicit dismissal available', async ({
  page,
  household,
}) => {
  household.confirmationError = 'Calendar result unknown';
  household.confirmationStatus = 503;
  household.calendarOutcome = {
    status: 'unknown',
    message: 'The write result is unknown. Check it without sending another write.',
  };
  await previewAppointment(page);
  await page.getByRole('button', { name: 'Confirm change', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Review household change' });
  await expect(dialog.getByRole('status')).toContainText('result is unknown');
  await expect(
    dialog.getByRole('button', { name: 'Check result (read only)', exact: true }),
  ).toBeEnabled();
  await page.route(
    '**/api/previews/*/confirm',
    (route) =>
      route.fulfill({
        json: {
          ok: false,
          targetId: 'event-1',
          calendarOutcome: { status: 'unknown', message: 'No further write was sent.' },
        },
      }),
    { times: 1 },
  );
  await dialog.getByRole('button', { name: 'Check result (read only)', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('No further write was sent.');
  await expect(
    dialog.getByRole('button', { name: 'Check result (read only)', exact: true }),
  ).toBeEnabled();
  await dialog.getByRole('button', { name: 'Dismiss result', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(household.calls.findLast((call) => call.path.endsWith('/dismiss'))?.body).toEqual({
    acknowledgeUncertain: true,
  });
  expect(household.state.calendar.events[0].title).toBe('Dinner together');
});

test('structured conflicts require a fresh preview rather than enabling another write', async ({
  page,
  household,
}) => {
  household.confirmationError = 'Appointment changed';
  household.calendarOutcome = {
    status: 'conflicted',
    message: 'The appointment changed. Review a new preview.',
  };
  await previewAppointment(page);
  await page.getByRole('button', { name: 'Confirm change', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'New preview required', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('dialog', { name: 'Review household change' }).getByRole('status'),
  ).toContainText('appointment changed');
  await page.getByRole('button', { name: 'Dismiss result', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Review household change' })).toHaveCount(0);
  expect(household.calls.filter((call) => call.path.endsWith('/confirm'))).toHaveLength(1);
});
