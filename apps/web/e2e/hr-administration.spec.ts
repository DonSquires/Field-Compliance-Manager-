import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00')); await installSupabaseFixtures(page); });

test('people and HR decisions are governed and operational', async ({ page }) => {
  const errors = monitorBrowserErrors(page); await signInAsAdmin(page, '/admin/people-hr');
  await expect(page.getByRole('heading', { name: 'Roster & HR' })).toBeVisible();
  await expect(page.getByText('Ana Ngata', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Leave', exact: true }).click();
  await page.getByRole('button', { name: 'Decline' }).click();
  const leaveDialog = page.getByRole('dialog', { name: 'Decline leave request?' });
  await expect(leaveDialog.getByRole('button', { name: 'Confirm decision' })).toBeDisabled();
  await leaveDialog.getByLabel('Review notes').fill('Coverage is already committed for these dates.');
  await expect(leaveDialog).toHaveScreenshot('hr-leave-review.png');
  await leaveDialog.getByRole('button', { name: 'Confirm decision' }).click();
  await expect(page.getByText('Leave decision confirmed and roster conflicts checked.')).toBeVisible();

  await page.getByRole('button', { name: 'Timesheets' }).click();
  await page.getByRole('button', { name: 'Approve' }).click();
  await page.getByRole('dialog', { name: 'Approve timesheet?' }).getByRole('button', { name: 'Confirm decision' }).click();
  await expect(page.getByText('Timesheet decision confirmed for payroll processing.')).toBeVisible();

  await page.getByRole('button', { name: 'Open Shifts' }).click();
  await page.getByRole('button', { name: '+ New Coverage Request' }).click();
  await page.getByLabel('Date').fill('2026-09-20'); await page.getByLabel('Required Staff').fill('3');
  await page.getByLabel('Start Time').fill('18:00'); await page.getByLabel('End Time').fill('23:00');
  await page.getByLabel('Urgency').selectOption('urgent'); await page.getByLabel('Notes').fill('Festival perimeter coverage');
  await page.getByRole('button', { name: 'Create Request' }).click();
  await expect(page.getByText('Requires 3 staff')).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});