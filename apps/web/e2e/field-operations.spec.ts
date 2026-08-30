import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00'));
  await installSupabaseFixtures(page);
});

test('operations landing is visually stable and every command is interactive', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsAdmin(page);
  await expect(page.getByRole('heading', { name: 'Field Operations' })).toBeVisible();
  await expect(page.getByText('Officers on duty').locator('..').getByText('4')).toBeVisible();
  await expect(page.getByText('Active dispatch').locator('..').getByText('7')).toBeVisible();
  await expect(page.getByText('Welfare alerts').locator('..').getByText('2')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page).toHaveScreenshot('field-operations.png', { fullPage: true });
  const finalCommand = page.getByRole('button', { name: /^Officer investigations/ });
  await finalCommand.scrollIntoViewIfNeeded();
  const mobileNavigation = page.locator('.admin-mobile-tabs');
  if (await mobileNavigation.isVisible()) {
    const commandBounds = await finalCommand.boundingBox();
    const navigationBounds = await mobileNavigation.boundingBox();
    expect(commandBounds && navigationBounds && commandBounds.y + commandBounds.height <= navigationBounds.y).toBe(true);
    await mobileNavigation.evaluate((element) => { element.style.visibility = 'hidden'; });
  }
  await expect(page.locator('.field-ops-workflows')).toHaveScreenshot('field-operations-workflows.png');
  if (await mobileNavigation.count()) await mobileNavigation.evaluate((element) => { element.style.visibility = ''; });

  const commands = [
    ['Dispatch console', 'dispatch'],
    ['Live operations', 'live-map'],
    ['Welfare response', 'welfare-alerts'],
    ['Patrol operations', 'patrol'],
    ['Field reports', 'field-reports'],
    ['Breach review', 'breach-review'],
    ['Vehicle intelligence', 'vehicle-search'],
    ['Officer investigations', 'officer-activity'],
  ] as const;
  for (const [label, area] of commands) {
    await page.getByRole('button', { name: new RegExp(`^${label}`) }).click();
    await expect(page).toHaveURL(new RegExp(`area=${area}`));
    await page.goto('/admin/field-ops?area=landing');
    await expect(page.getByRole('heading', { name: 'Field Operations' })).toBeVisible();
  }
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('report review dialog is usable without overlap', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/field-ops?area=field-reports');
  await expect(page.getByText('Unsafe access at North Yard', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Review report' }).click();
  const dialog = page.getByRole('dialog', { name: 'Review field report' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Confirm review' })).toBeDisabled();
  await dialog.getByLabel('Supervisor review notes').fill('Facilities owns remediation before the next rostered patrol.');
  await expect(dialog.getByRole('button', { name: 'Confirm review' })).toBeEnabled();
  const bounds = await dialog.boundingBox();
  const viewport = page.viewportSize();
  expect(bounds && viewport && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height).toBe(true);
  await expect(dialog).toHaveScreenshot('field-report-review-dialog.png');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});