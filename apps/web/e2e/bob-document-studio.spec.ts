import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => {
  await installSupabaseFixtures(page);
});

test('enterprise document studio exposes governed families and honest brand readiness', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/document-studio');

  await expect(page).toHaveURL(/\/admin\/document-studio$/);
  await expect(page.getByText('Bob document studio', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Document title')).toBeVisible();
  await expect(page.getByLabel('Document type')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Document content' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Site safety structure' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Incident structure' })).toBeVisible();
  await expect(page.getByText('No approved organization logo is configured. The draft will not invent branding.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeVisible();

  await page.getByRole('button', { name: 'Site safety structure' }).click();
  await expect(page.getByRole('textbox', { name: 'Document content' })).toContainText('Site safety plan');
  await expect(page.getByRole('textbox', { name: 'Document content' })).toContainText('Hazards and controls');

  await expect(page.getByRole('button', { name: 'Search references' })).toBeVisible();
  await expect(page.getByPlaceholder('Search bylaws, policies, reports…')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});
