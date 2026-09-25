import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00'));
  await installSupabaseFixtures(page);
});

test('administrator reviews and publishes a tenant report pack to the live client portal', async ({ page }, testInfo) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/reports');

  await expect(page.getByRole('heading', { name: 'Reports & Analytics' })).toBeVisible();
  await expect(page.getByText('No report packs in this period')).toBeVisible();
  await page.getByRole('button', { name: 'Generate report drafts' }).click();

  await expect(page.getByRole('status')).toContainText('1 report packs generated for the selected period.');
  const packs = page.getByRole('heading', { name: 'Monthly Report Packs (1)' }).locator('..');
  await expect(packs.getByText('Civic Events Compliance Services')).toBeVisible();
  await expect(packs.getByText('Needs review', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Civic Events Compliance Services' })).toBeVisible();
  await page.getByLabel('Client-facing title').fill('August service accountability report');
  await page.getByLabel('Executive summary').fill('All scheduled visits were completed and one incident was recorded.');
  await testInfo.attach('report-review-editor', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
  await page.getByRole('button', { name: 'Publish reviewed report' }).click();
  await expect(page.getByRole('status')).toContainText("published to Civic Events Compliance Services's live client portal");
  await expect(packs.getByText('Live in portal', { exact: true })).toBeVisible();
  await expect(packs.getByText('Available in client portal', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
  await testInfo.attach('report-review-published', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
});