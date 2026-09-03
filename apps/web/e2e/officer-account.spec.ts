import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsOfficer } from './fixtures';

test('officer can manage account access and sign out from the shell', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await installSupabaseFixtures(page);
  await signInAsOfficer(page, '/officer');

  await page.getByRole('button', { name: 'Account settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Ana Ngata' });
  await expect(dialog).toContainText('ana@fcm.test');
  await expect(dialog.getByRole('button', { name: 'Update password' })).toBeDisabled();
  await dialog.getByPlaceholder('At least 8 characters').fill('new-password');
  await expect(dialog.getByRole('button', { name: 'Update password' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Sign out' }).click();

  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});