import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';
const ACCOUNT = '40404040-4040-4040-8040-404040404040';
const WORK_UNIT = '20202020-2020-4020-8020-202020202020';
test.beforeEach(async ({ page }) => {
  await installSupabaseFixtures(page);
});
test('account workflow rail preserves context across operating workspaces', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await signInAsAdmin(page, `/admin/crm?account=${ACCOUNT}`);
  const rail = page.getByRole('navigation', {
    name: 'Account operations workflow',
  });
  await expect(rail).toBeVisible();
  await expect(page.locator(`#crm-account-${ACCOUNT}`)).toHaveClass(/is-context-focus/);
  await rail.getByRole('button', { name: /Agreement/ }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/relationships\\?account=${ACCOUNT}`));
  await expect(page.locator('#relationship-24242424-2424-4424-8424-242424242424')).toHaveCSS('border-top-width', '2px');
  await page
    .getByRole('navigation', { name: 'Account operations workflow' })
    .getByRole('button', { name: /Places/ })
    .click();
  await expect(page).toHaveURL(new RegExp(`/admin/locations\\?account=${ACCOUNT}`));
  await page
    .getByRole('navigation', { name: 'Account operations workflow' })
    .getByRole('button', { name: /Roster/ })
    .click();
  await expect(page).toHaveURL(new RegExp(`/admin/roster\\?account=${ACCOUNT}`));
  await page
    .getByRole('navigation', { name: 'Account operations workflow' })
    .getByRole('button', { name: /Handoff/ })
    .click();
  await expect(page).toHaveURL(new RegExp(`/admin/handoffs\\?account=${ACCOUNT}`));
  await expect(page.getByRole('heading', { name: 'Civic Events Limited' })).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('roster context lands on the exact work unit and assignment action', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await signInAsAdmin(page, `/admin/roster?work_unit=${WORK_UNIT}`);

  const contextBanner = page.locator('.roster-context-banner');
  await expect(contextBanner).toContainText('Civic Centre Static Post');
  await contextBanner.getByRole('button', { name: 'Create shift for this work unit' }).click();
  await expect(page.getByRole('dialog', { name: 'Create shift' })).toBeVisible();
  await expect(page.locator('#roster-service')).toHaveValue(WORK_UNIT);
  await page.getByRole('button', { name: 'Cancel' }).click();

  await contextBanner.getByRole('button', { name: 'Open work unit' }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/roster-targets\\?work_unit=${WORK_UNIT}`));
  const requestedUnit = page.locator(`#work-unit-${WORK_UNIT}`);
  await expect(requestedUnit).toHaveClass(/is-focused/);
  await expect(requestedUnit.getByRole('button', { name: 'Create assignment' })).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});
