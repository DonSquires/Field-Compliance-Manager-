import { expect, test } from '@playwright/test';
import { installOfficerScheduleFixtures, monitorBrowserErrors, signInAsOfficer } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00'));
  await installOfficerScheduleFixtures(page);
});

test('officer debrief is structured, validated, and server-confirmed', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsOfficer(page, '/officer/debrief');
  await expect(page.getByRole('heading', { name: 'Debrief', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  const submit = page.getByRole('button', { name: 'Submit debrief' });
  await expect(submit).toBeDisabled();
  await page.getByLabel('Operational summary').fill('Patrol completed. North access lighting remains unavailable for the next team.');
  await page.getByText('Follow-up required', { exact: true }).click();
  await expect(submit).toBeDisabled();
  await page.getByLabel('Required follow-up').fill('Facilities must restore lighting before the next overnight patrol.');
  await expect(submit).toBeEnabled();
  await submit.scrollIntoViewIfNeeded();
  const actionBar = page.locator('.officer-action-bar');
  const submitBounds = await submit.boundingBox();
  const actionBarBounds = await actionBar.boundingBox();
  expect(submitBounds && actionBarBounds && submitBounds.y + submitBounds.height <= actionBarBounds.y).toBe(true);
  const shellHeader = page.locator('.officer-shell-header');
  await shellHeader.evaluate((element) => { element.style.visibility = 'hidden'; });
  await actionBar.evaluate((element) => { element.style.visibility = 'hidden'; });
  await expect(page.locator('.officer-debrief-form')).toHaveScreenshot('officer-debrief-form.png');
  await shellHeader.evaluate((element) => { element.style.visibility = ''; });
  await actionBar.evaluate((element) => { element.style.visibility = ''; });
  await submit.click();
  await expect(page.getByText('Debrief recorded. Complete the shift when all field work is finished.')).toBeVisible();
  await expect(page.getByText(/Debrief review draft created for your supervisor: Debrief review - North District Patrol 30 Aug\./)).toBeVisible();
  const complete = page.getByRole('button', { name: 'Complete shift' });
  await expect(complete).toBeVisible();
  await complete.click();
  await expect(page.getByText(/Shift completed at .* You are no longer on active duty for this shift\./)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Return home' })).toBeVisible();
  await page.getByRole('button', { name: 'Open timesheet' }).click();
  await expect(page).toHaveURL(/\/officer\/timesheet$/);
  await expect(page.getByRole('heading', { name: 'Timesheets', exact: true })).toBeVisible();
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});