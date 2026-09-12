import { test, expect } from '@playwright/test';
import { installSupabaseFixtures, signInAsAdmin, monitorBrowserErrors, DESKTOP_PROMPT_KEY } from './fixtures';

test('administrator is offered the desktop companion once and can dismiss it', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'The desktop companion prompt is intentionally not shown on mobile.');
  const errors = monitorBrowserErrors(page);
  await installSupabaseFixtures(page);
  await signInAsAdmin(page);

  const downloadBtn = page.getByRole('button', { name: 'Download FCM desktop app' });
  await expect(downloadBtn).toBeVisible();
  await downloadBtn.click();

  const prompt = page.getByRole('dialog', { name: 'Choose your evidence workstation' });
  await expect(prompt).toBeVisible();
  await expect(prompt.getByRole('link', { name: 'FCM Desktop V1' })).toBeVisible();

  await prompt.getByRole('button', { name: 'Not now' }).click();
  await expect(prompt).toBeHidden();
  expect(errors).toEqual([]);
});
