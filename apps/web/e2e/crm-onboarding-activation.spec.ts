import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-31T10:00:00+12:00'));
  await installSupabaseFixtures(page);
});

test('administrator resumes evidence-backed onboarding and activates a ready prospect', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/onboarding');

  await expect(page.getByRole('heading', { name: 'Account onboarding' })).toBeVisible();
  await page.getByRole('button', { name: /Blocked Harbour Prospect/ }).click();
  await expect(page.getByText('Target overdue')).toBeVisible();
  await expect(page.getByText('An active primary contact is required')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Activate account' })).toHaveCount(0);

  await page.getByRole('button', { name: /Ready Venue Trust/ }).click();
  await expect(page.getByText('All mandatory evidence is ready')).toBeVisible();
  await expect(page).toHaveScreenshot('crm-onboarding-queue.png');
  await page.getByRole('button', { name: 'Advance stage' }).click();
  await expect(page.getByRole('status')).toContainText('Ready Venue Trust advanced to review');
  await page.getByRole('button', { name: 'Activate account' }).click();
  const confirmation = page.getByRole('dialog', { name: 'Activate Ready Venue Trust?' });
  await expect(confirmation).toContainText('lock and recheck');
  await confirmation.getByRole('button', { name: 'Confirm activation' }).click();
  await expect(page.getByRole('status')).toContainText('Ready Venue Trust activated and removed from the incomplete queue');
  await expect(page.getByRole('button', { name: /Ready Venue Trust/ })).toHaveCount(0);
  expect(errors, errors.join('\n')).toEqual([]);
});