import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => {
  await installSupabaseFixtures(page);
});

test('document studio communicates brand asset readiness without inventing branding', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/document-studio');

  await expect(page.getByText('No approved organization logo is configured. The draft will not invent branding.')).toBeVisible();
  await expect(page.getByText('Upload brand asset')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Submit for review' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});
