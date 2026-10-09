import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00'));
  await installSupabaseFixtures(page, { officerModules: ['patrol'] });
});

test('admin patrol route shows exact officer checkpoint evidence', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/field-ops?area=patrol');

  await expect(page.getByRole('heading', { name: 'Patrol evidence' })).toBeVisible();
  await expect(page).toHaveScreenshot('patrol-oversight-first-viewport.png');
  if ((page.viewportSize()?.width ?? 0) < 980) {
    await expect(page.locator('.patrol-oversight-scroll-cue')).toBeVisible();
    const tableSize = await page.locator('.patrol-oversight-table').evaluate((element) => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
    expect(tableSize.scrollWidth).toBeGreaterThan(tableSize.clientWidth);
  }
  const verifiedVisit = page.getByText('North gate checkpoint').locator('..').locator('..');
  await expect(verifiedVisit).toBeVisible();
  await expect(verifiedVisit.getByText('Ana Ngata', { exact: true })).toBeVisible();
  await expect(verifiedVisit.getByText('Evidence ID 89898989', { exact: false })).toBeVisible();
  await expect(verifiedVisit.getByText('6 m', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'exception' }).click();
  await expect(page.getByText('Loading bay checkpoint')).toBeVisible();
  await expect(page.getByText('North gate checkpoint')).toBeHidden();
  await expect(page.getByText('Review required')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});