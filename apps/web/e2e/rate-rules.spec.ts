import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00')); await installSupabaseFixtures(page); });

test('administrator creates a governed operating branch patrol rate rule', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/rate-rules');
  await expect(page.getByRole('heading', { name: 'Rate Rules' })).toBeVisible();
  await page.getByRole('button', { name: 'New rate rule' }).click();
  const form = page.locator('form.assessment-form');
  await form.getByLabel('Name').fill('Patrol visit - branch standard');
  await form.getByLabel('Rate type').selectOption('per_visit');
  await form.getByLabel('Amount').fill('42.50');
  await form.getByLabel('Service type').fill('patrol');
  await expect(form).toHaveScreenshot('operating-branch-rate-rule.png');
  await form.getByRole('button', { name: 'Create rate rule' }).click();
  await expect(page.getByText('Rate rule created and available to the resolver.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Patrol visit - branch standard', exact: true })).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});