import { expect, test } from '@playwright/test';
import { installOfficerScheduleFixtures, monitorBrowserErrors, signInAsOfficer } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00'));
  await installOfficerScheduleFixtures(page);
});

test('dispatch completion keeps shift context and gives the officer a next command', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsOfficer(page, '/officer/dispatch');

  await expect(page.getByRole('heading', { name: 'Dispatch', exact: true })).toBeVisible();
  await expect(page.getByText('Alarm response', { exact: true })).toBeVisible();
  const complete = page.getByRole('button', { name: 'Mark Completed' });
  await expect(complete).toBeDisabled();
  await page.getByLabel('Outcome notes').fill('Entrance checked, alarm panel reset, and site contact notified.');
  await expect(complete).toBeEnabled();
  await complete.click();

  const receipt = page.getByRole('region', { name: 'Dispatch completion receipt' });
  await expect(receipt).toContainText('Dispatch completed');
  await expect(receipt).toContainText('Receipt cccccccc · shift 66666666');
  await expect(receipt).toContainText('Your shift remains active');
  for (const command of ['Shift home', 'Open map', 'Field report', 'Debrief']) {
    await expect(receipt.getByRole('button', { name: command })).toBeVisible();
  }
  await expect(page.getByText('No active dispatch jobs right now.')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await receipt.getByRole('button', { name: 'Open map' }).click();
  await expect(page).toHaveURL(/\/officer\/map$/);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('personal dispatch notification opens the exact assigned job', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsOfficer(page, '/officer/dispatch?job=cccccccc-cccc-4ccc-8ccc-cccccccccccc');

  const job = page.locator('#officer-dispatch-cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  await expect(job).toHaveClass(/is-context-focus/);
  await expect(job.getByText('Alarm response', { exact: true })).toBeVisible();
  await expect(job.getByRole('button', { name: 'Mark Completed' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});