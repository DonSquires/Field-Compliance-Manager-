import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00'));
  await installSupabaseFixtures(page, { officerModules: ['dispatch', 'cctv', 'static_guarding', 'freedom_camping', 'parking_enforcement'] });
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
    ['CCTV & video', 'cctv-console'],
    ['Debrief follow-up', 'debrief-followup'],
    ['Breach review', 'breach-review'],
    ['Vehicle intelligence', 'vehicle-search'],
    ['Observation search', 'observation-search'],
    ['Officer investigations', 'officer-activity'],
  ] as const;
  for (const [label, area] of commands) {
    await page.getByRole('button', { name: new RegExp(`^${label}`) }).click();
    await expect(page).toHaveURL(new RegExp(`area=${area}`));
    await page.goBack();
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

test('supervisor records acknowledgement and verified resolution through the governed welfare lifecycle', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/field-ops?area=welfare-alerts');
  await expect(page.getByRole('heading', { name: 'Welfare response' })).toBeVisible();
  await expect(page.getByText('Ana Ngata', { exact: true }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Acknowledge' }).click();
  const acknowledgement = page.getByRole('dialog', { name: 'Acknowledge alert' });
  await acknowledgement.getByLabel('Response plan').fill('Control room called Ana and dispatched the duty supervisor.');
  await acknowledgement.getByRole('button', { name: 'Confirm acknowledgement' }).click();
  await expect(page.getByRole('status')).toContainText('Alert acknowledged');
  await expect(page.getByText('acknowledged', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Morgan Reed · .*29\/08\/2026/)).toBeVisible();

  await page.getByRole('button', { name: 'Resolve' }).click();
  const resolution = page.getByRole('dialog', { name: 'Resolve alert' });
  await resolution.getByLabel('Verified safety outcome').fill('Duty supervisor made face-to-face contact and confirmed Ana was safe.');
  await resolution.getByRole('button', { name: 'Confirm resolution' }).click();
  await expect(page.getByRole('status')).toContainText('Alert resolved');
  await expect(page.getByText('resolved', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Morgan Reed · .*29\/08\/2026/)).toHaveCount(2);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});