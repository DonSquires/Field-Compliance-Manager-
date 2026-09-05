import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00')); await installSupabaseFixtures(page); });

test('people and HR decisions are governed and operational', async ({ page }) => {
  const errors = monitorBrowserErrors(page); await signInAsAdmin(page, '/admin/people-hr');
  await expect(page.getByRole('heading', { name: 'Roster & HR' })).toBeVisible();
  await expect(page.getByText('Ana Ngata', { exact: true })).toBeVisible();
  await expect(page.getByText('No verified current credential')).toBeVisible();
  await page.getByRole('button', { name: 'Remove work readiness' }).click();
  const readinessDialog = page.getByRole('dialog', { name: 'Remove work readiness?' });
  await expect(readinessDialog.getByRole('button', { name: 'Confirm readiness' })).toBeDisabled();
  await readinessDialog.getByLabel('Readiness review notes').fill('Temporary restriction pending refresher training review.');
  await expect(readinessDialog).toHaveScreenshot('hr-readiness-review.png');
  await readinessDialog.getByRole('button', { name: 'Confirm readiness' }).click();
  await expect(page.getByText('Ana Ngata readiness updated and audited.')).toBeVisible();

  await page.getByRole('button', { name: 'People', exact: true }).click();
  await page.getByRole('button', { name: 'Leave', exact: true }).click();
  await page.getByRole('button', { name: 'Branch check' }).click();
  const leaveDialog = page.getByRole('dialog', { name: 'Branch check leave request?' });
  await leaveDialog.getByLabel('Review notes').fill('Local roster coverage has been checked.');
  await expect(leaveDialog).toHaveScreenshot('hr-leave-review.png');
  await leaveDialog.getByRole('button', { name: 'Confirm decision' }).click();
  await expect(page.getByText('Leave branch check recorded for corporate confirmation.')).toBeVisible();

  await page.getByRole('button', { name: 'Pay & Assets', exact: true }).click();
  await page.getByRole('button', { name: 'Timesheets' }).click();
  await page.getByRole('button', { name: 'Branch check' }).click();
  await page.getByRole('dialog', { name: 'Branch check timesheet?' }).getByRole('button', { name: 'Confirm decision' }).click();
  await expect(page.getByText('Timesheet branch check recorded for corporate payroll approval.')).toBeVisible();

  await page.getByRole('button', { name: 'Rostering', exact: true }).click();
  await page.getByRole('button', { name: 'Open Shifts' }).click();
  await page.getByRole('button', { name: '+ New Coverage Request' }).click();
  await page.getByLabel('Date').fill('2026-09-20'); await page.getByLabel('Required Staff').fill('3');
  await page.getByLabel('Start Time').fill('18:00'); await page.getByLabel('End Time').fill('23:00');
  await page.getByLabel('Urgency').selectOption('urgent'); await page.getByLabel('Notes').fill('Festival perimeter coverage');
  await page.getByRole('button', { name: 'Create Request' }).click();
  await expect(page.getByText('Requires 3 staff')).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('administrator finalizes an officer coverage claim into roster ownership', async ({ page }) => {
  const errors=monitorBrowserErrors(page);await signInAsAdmin(page,'/admin/people-hr');
  await page.getByRole('button',{name:'Open Shifts'}).click();
  const claim=page.getByText('Claimed festival patrol').locator('..').locator('..');
  await expect(claim).toContainText('claimed by Ana Ngata');
  await claim.getByRole('button',{name:'Finalize assignment'}).click();
  const dialog=page.getByRole('dialog',{name:'Finalize assignment'});
  await expect(dialog.getByRole('button',{name:'Confirm assignment'})).toBeDisabled();
  await dialog.getByLabel('Select work unit').selectOption({label:'North District Patrol · patrol'});
  await dialog.getByLabel('Finalization notes').fill('Claim matched to the published festival patrol requirement.');
  await dialog.getByRole('button',{name:'Confirm assignment'}).click();
  await expect(page.getByRole('status')).toContainText('Coverage finalized for Ana Ngata · roster 96969696 · shift 97979797.');
  await expect(page.getByText('Claimed festival patrol')).toBeHidden();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  expect(errors,errors.join('\n')).toEqual([]);
});