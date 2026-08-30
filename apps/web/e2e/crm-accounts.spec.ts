import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00')); await installSupabaseFixtures(page); });

test('CRM account context and governed quote creation are operational', async ({ page }) => {
  const errors = monitorBrowserErrors(page); await signInAsAdmin(page, '/admin/crm');
  await expect(page.getByRole('heading', { name: 'CRM', exact: true })).toBeVisible();
  const client = page.getByText('Civic Events Limited', { exact: true }).locator('..').locator('..');
  await expect(client.getByText('Mere Wilson')).toBeVisible(); await expect(client.getByText('Active · 2 sites')).toBeVisible();
  await client.getByRole('button', { name: 'New quote' }).click();
  const dialog = page.getByRole('dialog', { name: 'New quote for Civic Events Limited' });
  await expect(dialog.getByLabel('Quote title')).toHaveValue('Civic Events Limited service proposal');
  await dialog.getByLabel('Target margin %').fill('24'); await dialog.getByLabel('Commercial notes').fill('Initial static guarding proposal.');
  await expect(dialog).toHaveScreenshot('crm-draft-quote.png'); await dialog.getByRole('button', { name: 'Create draft quote' }).click();
  await expect(page.getByText('Draft quote created for Civic Events Limited.')).toBeVisible();
  await expect(page.getByText('Quote: draft')).toBeVisible(); expect(errors, errors.join('\n')).toEqual([]);
});