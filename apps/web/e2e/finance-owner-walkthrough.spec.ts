import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-12T09:30:00+12:00'));
  await installSupabaseFixtures(page);
  await page.route('**/rest/v1/finance_pl_periods*', async (route) => await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ id: 'period-1', name: 'September 2026', period_start: '2026-09-01', period_end: '2026-09-30', status: 'draft' }]) }));
  await page.route('**/rest/v1/finance_pl_snapshots*', async (route) => await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ total_revenue: 24800, total_cost: 16400, gross_profit: 8400, gross_margin_pct: 33.87, cost_line_count: 42 }]) }));
  await page.route('**/rest/v1/finance_tax_periods*', async (route) => await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ period_end: '2026-08-31', filing_due_date: '2026-10-28', status: 'open', net_tax_due: 3720 }]) }));
  await page.route('**/rest/v1/finance_budget_variances*', async (route) => await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ status: 'watch', variance_amount: 320, variance_pct: 4.1 }]) }));
  await page.route('**/rest/v1/payment_receipts*', async (route) => await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ payment_amount: 8200, reconciliation_status: 'matched' }, { payment_amount: 4600, reconciliation_status: 'unmatched' }]) }));
  await page.route('**/rest/v1/rpc/get_finance_owner_brief', async (route) => await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ headline: 'Bob found 2 items worth your attention.', priorities: [{ kind: 'payments', title: '1 payment needs matching', detail: 'Bob can compare it with bank statement lines.' }, { kind: 'tax', title: 'Tax money is due by 28 Oct 2026', detail: 'Bob can prepare the figures; you approve filing and payment.' }], checked_at: '2026-09-12T09:30:00+12:00' }) }));
  await page.route('**/rest/v1/rpc/assess_bob_nz_finance_readiness', async (route) => await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ overall_score: 58, checks: [{ source_key: 'ird-gst-overview', title: 'GST calculation and period control', status: 'partial', score: 60 }, { source_key: 'ird-gst-records', title: 'GST evidence and record keeping', status: 'partial', score: 65 }, { source_key: 'ird-employers', title: 'Employer cost and staff finance controls', status: 'partial', score: 60 }, { source_key: 'ird-provisional-tax', title: 'Provisional tax planning', status: 'partial', score: 45 }, { source_key: 'ird-payroll', title: 'Payday filing integration', status: 'partial', score: 40 }, { source_key: 'xrb-nz-accounting-standards', title: 'Accounting standards and statutory reporting', status: 'partial', score: 45 }] }) }));
});

test('owner can walk finance from simple home to final review boundary', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/finance-bureau');
  await expect(page.getByRole('heading', { name: 'What would you like to do?' })).toBeVisible();
  await expect(page.getByRole('button', { name: /See how the business is doing/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Connect ANZ or IRD/ })).toBeVisible();
  await expect(page).toHaveScreenshot('finance-home-desktop.png');

  await page.getByRole('button', { name: /See how the business is doing/ }).click();
  await expect(page.getByRole('heading', { name: 'How is the business doing?' })).toBeVisible();
  await expect(page.getByText('Money left after costs')).toBeVisible();
  await page.goBack();

  await page.getByRole('button', { name: /Work out what a job should cost/ }).click();
  await expect(page.getByRole('heading', { name: 'What should this job cost?' })).toBeVisible();
  await page.goBack();

  await page.getByRole('button', { name: /Manage prices and discounts/ }).click();
  await expect(page.getByRole('heading', { name: 'Pricing and discounts' })).toBeVisible();
  await page.goBack();

  await page.getByRole('button', { name: /Connect ANZ or IRD/ }).click();
  await expect(page.getByRole('heading', { name: 'Connect your finance accounts' })).toBeVisible();
  await expect(page.getByText('We never ask for online-banking passwords')).toBeVisible();
  await page.getByRole('button', { name: /ANZ bank account/ }).click();
  await expect(page).toHaveScreenshot('finance-anz-connection-before-submit.png');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('owner can run readiness check without submitting to IRD or bank', async ({ page }) => {
  await signInAsAdmin(page, '/admin/finance-bureau');
  await page.getByRole('button', { name: 'Check now' }).click();
  await expect(page.getByText('Readiness snapshot: 58%')).toBeVisible();
  await expect(page.getByText('not a legal compliance certificate')).toBeVisible();
  await expect(page.getByText('Human approval stays with you.')).toBeVisible();
});
