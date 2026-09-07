import { test, expect } from '@playwright/test';
import { installSupabaseFixtures, signInAsAdmin, monitorBrowserErrors, DESKTOP_PROMPT_KEY } from './fixtures';

test('administrator is offered the desktop companion once and can dismiss it', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await installSupabaseFixtures(page);
  await page.addInitScript((key) => window.localStorage.removeItem(key), DESKTOP_PROMPT_KEY);
  await signInAsAdmin(page);

  const prompt = page.getByRole('dialog', { name: 'Use local hardware with FCM' });
  await expect(prompt).toBeVisible();
  await expect(prompt.getByRole('link', { name: 'Download desktop app' })).toBeVisible();

  await prompt.getByRole('button', { name: 'Not now' }).click();
  await expect(prompt).toBeHidden();

  // Dismissal is retained, so the modal never blocks the admin surface again.
  await page.reload();
  await expect(page.getByRole('dialog', { name: 'Use local hardware with FCM' })).toBeHidden();
  expect(errors).toEqual([]);
});
