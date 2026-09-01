import { expect, test } from '@playwright/test';
import { installOfficerScheduleFixtures, monitorBrowserErrors, signInAsOfficer } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00'));
  await installOfficerScheduleFixtures(page);
});

test('officer schedule and coverage claim are visually correct and operational', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsOfficer(page);
  await expect(page.getByRole('heading', { name: 'My schedule' })).toBeVisible();
  await expect(page.getByText('North district patrol')).toBeVisible();
  const internalAssignment = page.getByText('Roster Administration', { exact: true }).locator('..').locator('..');
  await expect(internalAssignment).toBeVisible();
  await internalAssignment.getByRole('button', { name: 'Decline' }).click();
  const responseDialog = page.getByRole('dialog', { name: 'Decline assignment?' });
  await expect(responseDialog.getByRole('button', { name: 'Confirm decline' })).toBeDisabled();
  await responseDialog.getByLabel('Decline reason').fill('Unavailable due to approved training commitment.');
  await expect(responseDialog).toHaveScreenshot('officer-schedule-decline-dialog.png');
  await responseDialog.getByRole('button', { name: 'Confirm decline' }).click();
  await expect(page.getByText('Assignment declined with your recorded reason.')).toBeVisible();
  const receipt = page.getByRole('region', { name: 'Assignment ownership receipt' });
  await expect(receipt).toContainText('Roster slot 55555555 · workforce assignment');
  await receipt.getByRole('button', { name: 'Dismiss receipt' }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.locator('.officer-schedule')).toHaveScreenshot('officer-schedule-assigned.png');

  await page.getByRole('tab', { name: /Open coverage/ }).click();
  await expect(page.getByText('Civic Events Centre')).toBeVisible();
  await page.getByRole('button', { name: 'Review claim' }).click();
  const dialog = page.getByRole('dialog', { name: 'Claim this shift?' });
  await expect(dialog).toBeVisible();
  const bounds = await dialog.boundingBox();
  const viewport = page.viewportSize();
  expect(bounds && viewport && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height).toBe(true);
  await expect(dialog).toHaveScreenshot('officer-schedule-claim-dialog.png');
  await dialog.getByRole('button', { name: 'Confirm claim' }).click();
  await expect(page.getByText('Coverage claim confirmed.')).toBeVisible();
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('linked assignment acceptance returns the shared roster and shift identity', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsOfficer(page);
  const fieldAssignment = page.getByText('North district patrol').locator('..').locator('..');
  await fieldAssignment.getByRole('button', { name: 'Accept' }).click();
  await page.getByRole('dialog', { name: 'Accept assignment?' }).getByRole('button', { name: 'Confirm acceptance' }).click();

  const receipt = page.getByRole('region', { name: 'Assignment ownership receipt' });
  await expect(receipt).toContainText('accepted');
  await expect(receipt).toContainText('Roster slot 33333333 · field shift 66666666 accepted');
  await expect(page.getByText('Assignment accepted and confirmed.')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('coverage finalization notification opens the exact roster assignment', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsOfficer(page, '/officer/schedule?slot=96969696-9696-4696-8696-969696969696');

  const assignment = page.locator('#officer-roster-slot-96969696-9696-4696-8696-969696969696');
  await expect(assignment).toHaveClass(/is-context-focus/);
  await expect(assignment).toContainText('Claimed festival patrol');
  await expect(assignment.getByText('published', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});