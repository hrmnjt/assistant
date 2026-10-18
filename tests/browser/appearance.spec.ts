import { test, expect, navigate } from './household-fixture';

test.use({ colorScheme: 'dark' });

test('appearance follows the device until a choice is saved on this device', async ({ page }) => {
  const html = page.locator('html');
  await page.goto('/');
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
  await expect(html).toHaveClass(/\bdark\b/);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#151b18');

  await navigate(page, 'Settings');
  const choice = page.getByLabel('Light or dark');
  await expect(choice).toHaveValue('system');
  await choice.selectOption('light');
  await expect(html).not.toHaveClass(/\bdark\b/);

  // The early script applies the saved choice before the app starts.
  await page.reload();
  await expect(html).not.toHaveClass(/\bdark\b/);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#f7f7f2');
  await navigate(page, 'Settings');
  await expect(choice).toHaveValue('light');
  await choice.selectOption('system');
  await expect(html).toHaveClass(/\bdark\b/);

  // While matching the device, a system switch applies immediately.
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(html).not.toHaveClass(/\bdark\b/);
});
