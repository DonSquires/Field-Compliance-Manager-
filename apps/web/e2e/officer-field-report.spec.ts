import { expect, test } from '@playwright/test';
import { installOfficerScheduleFixtures, monitorBrowserErrors, signInAsOfficer } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00'));
  await installOfficerScheduleFixtures(page);
});

test('officer report capture is evidential, responsive, and server-confirmed', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsOfficer(page, '/officer/report');
  await expect(page.getByRole('heading', { name: 'Field report', exact: true })).toBeVisible();
  const submit = page.getByRole('button', { name: 'Submit report' });
  await expect(submit).toBeDisabled();
  await page.getByLabel('Title').fill('Unsafe access lighting');
  await page.getByLabel('Description').fill('Lighting at the north access failed during the patrol and reduced visibility.');
  await page.getByLabel('Location name').fill('North Yard');
  await page.getByLabel('Address').fill('14 Harbour Road');
  await page.getByLabel('Immediate action taken').fill('Used the controlled alternate entrance and notified dispatch.');
  await page.getByText('Follow-up required', { exact: true }).click();
  await expect(submit).toBeDisabled();
  await page.getByLabel('Required follow-up').fill('Facilities must restore lighting before the next overnight patrol.');
  await expect(submit).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await submit.scrollIntoViewIfNeeded();
  const actionBar = page.locator('.officer-action-bar');
  const submitBounds = await submit.boundingBox();
  const actionBarBounds = await actionBar.boundingBox();
  expect(submitBounds && actionBarBounds && submitBounds.y + submitBounds.height <= actionBarBounds.y).toBe(true);
  const shellHeader = page.locator('.officer-shell-header');
  await shellHeader.evaluate((element) => { element.style.visibility = 'hidden'; });
  await actionBar.evaluate((element) => { element.style.visibility = 'hidden'; });
  const shell = page.locator('.officer-shell');
  const shellContent = page.locator('.officer-shell-content');
  await shell.evaluate((element) => { element.style.height = 'auto'; });
  await shellContent.evaluate((element) => { element.style.overflow = 'visible'; });
  await page.locator('.officer-report-form').scrollIntoViewIfNeeded();
  await expect(page.locator('.officer-report-form')).toHaveScreenshot('officer-field-report-form.png');
  await shell.evaluate((element) => { element.style.height = ''; });
  await shellContent.evaluate((element) => { element.style.overflow = ''; });
  await shellHeader.evaluate((element) => { element.style.visibility = ''; });
  await actionBar.evaluate((element) => { element.style.visibility = ''; });
  await submit.click();
  await expect(page.getByText(/Report confirmed · receipt bbbbbbbb · linked to patrol · 31 Aug/)).toBeVisible();
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('an unconfirmed report receipt preserves evidence for retry', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await page.route('**/rest/v1/rpc/submit_officer_field_report', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await signInAsOfficer(page, '/officer/report');

  await page.getByLabel('Title').fill('Damaged perimeter gate');
  await page.getByLabel('Description').fill('The north perimeter gate would not latch after the final patrol check.');
  await page.getByLabel('Immediate action taken').fill('Secured the gate with the approved temporary lock and notified dispatch.');
  await page.getByRole('button', { name: 'Submit report' }).click();

  await expect(page.getByRole('alert')).toContainText('Report receipt was not confirmed');
  await expect(page.getByLabel('Title')).toHaveValue('Damaged perimeter gate');
  await expect(page.getByLabel('Description')).toHaveValue('The north perimeter gate would not latch after the final patrol check.');
  await expect(page.getByRole('button', { name: 'Submit report' })).toBeEnabled();
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});
