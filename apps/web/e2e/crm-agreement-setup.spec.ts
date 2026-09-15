import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-31T10:00:00+12:00'));
  await installSupabaseFixtures(page);
});

test('provider configures covered sites and service modules through the accepted agreement', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/relationships');

  const relationship = page.getByText('Civic Events Compliance Services', { exact: true }).locator('..').locator('..').locator('..');
  await relationship.getByRole('button', { name: 'Configure agreement' }).click();
  const dialog = page.getByRole('dialog', { name: 'Civic Events Compliance Services' });
  await expect(dialog.getByText('Civic Events Limited · accepted agreement')).toBeVisible();
  await expect(dialog.getByText('Verified authoritative boundary')).toBeVisible();
  await expect(dialog.getByText('North Pavilion')).toBeVisible();
  await dialog.getByText('North Pavilion').locator('..').locator('..').getByRole('button', { name: 'Add coverage' }).click();
  await expect(dialog.getByRole('status')).toContainText('Covered site linked');
  await expect(dialog.getByRole('button', { name: /Covered places 2/ })).toBeVisible();

  await dialog.getByRole('button', { name: /Service modules/ }).click();
  const parking = dialog.getByRole('article', { name: 'Module parking enforcement' });
  await parking.getByText('Enabled', { exact: true }).click();
  await parking.getByLabel('SLA minutes').fill('45');
  await parking.getByText('Client submission', { exact: true }).click();
  await parking.getByRole('button', { name: 'Save module' }).click();
  await expect(dialog.getByRole('status')).toContainText('Service module settings saved');
  await expect(dialog.getByRole('button', { name: /Service modules 2/ })).toBeVisible();

  await dialog.getByRole('button', { name: /Covered places/ }).click();
  await expect(dialog).toHaveScreenshot('crm-agreement-setup.png');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('provider reviews evidence-backed readiness and opens the owning workflow', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/relationships');

  const relationship = page.getByText('Civic Events Compliance Services', { exact: true }).locator('..').locator('..').locator('..');
  await relationship.getByRole('button', { name: 'Review readiness' }).click();
  const dialog = page.getByRole('dialog', { name: 'Civic Events Compliance Services' });
  await expect(dialog.getByText('2 readiness blockers')).toBeVisible();
  await expect(dialog.getByRole('article', { name: 'Commercial rates ready' })).toContainText('positive agreement or covered-place rate');
  await expect(dialog.getByRole('article', { name: 'Operational work ready' })).toContainText('1 active attributed work unit');
  await expect(dialog.getByRole('article', { name: 'Boundary evidence blocked' })).toContainText('authoritative verified geometry');
  await expect(dialog.getByRole('article', { name: 'Reporting delivery blocked' })).toContainText('without a valid monthly template');
  await expect(dialog).not.toContainText('%');
  await expect(dialog).toHaveScreenshot('crm-operational-readiness.png');

  await dialog.getByRole('article', { name: 'Boundary evidence blocked' }).getByRole('button', { name: 'Open owner' }).click();
  await expect(page.getByRole('heading', { name: 'Geofence workbench' })).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});