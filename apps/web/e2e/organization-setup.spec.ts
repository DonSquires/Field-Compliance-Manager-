import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00')); await installSupabaseFixtures(page, { officerModules: ['parking_enforcement'] }); });

test('a master runs the organisation from one settings page: details, branches, modules', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/org-setup');
  await expect(page.getByRole('heading', { name: 'Organisation settings' })).toBeVisible();
  await expect(page.locator('.page-header').getByText('Harbour Compliance Services', { exact: false })).toBeVisible();

  // The overview says what is done and what still needs attention, in plain words.
  const overview = page.getByRole('navigation', { name: 'Setup overview' });
  await expect(overview.getByText('Company details')).toBeVisible();
  await expect(overview.getByText('Branches')).toBeVisible();
  await expect(overview.getByText('Modules in use')).toBeVisible();
  await expect(page).toHaveScreenshot('organisation-settings.png', { fullPage: true });

  // Branches: the existing one is listed; a new one is added through the governed RPC and confirmed.
  const branches = page.getByRole('list', { name: 'Branches' });
  await expect(branches.getByText('Northern Branch')).toBeVisible();
  await page.getByLabel('Branch name').fill('Nelson');
  await page.getByRole('button', { name: 'Add branch' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Nelson added' })).toBeVisible();
  await expect(branches.getByText('Nelson', { exact: true })).toBeVisible();

  // Modules read as names with an on/off switch, not raw keys.
  const patrol = page.getByRole('list', { name: 'Modules' }).locator('li').filter({ has: page.getByRole('heading', { name: 'Patrol', exact: true }) });
  await expect(patrol).toHaveScreenshot('operating-branch-module.png');
  await patrol.getByRole('button', { name: 'Patrol: off' }).click();
  await expect(patrol.getByRole('button', { name: 'Patrol: on' })).toBeVisible();

  // Field notice wording is configured before deployment and saved as an immutable, sourced version.
  await page.getByRole('button', { name: 'Add notice template' }).click();
  const templateForm = page.getByRole('form', { name: 'Add a notice template' });
  await templateForm.getByLabel('Enforcement module').selectOption('parking_enforcement');
  await templateForm.getByLabel('Notice type').selectOption('infringement');
  await templateForm.getByLabel('Issuing authority', { exact: true }).fill('Harbour City Council');
  await templateForm.getByLabel('Authorising Act', { exact: true }).fill('Land Transport Act 1998');
  await templateForm.getByLabel('Section (optional)').fill('s 22AB');
  await templateForm.getByLabel('Source document location').fill('governed://legal/parking-infringement-template');
  await templateForm.getByLabel('Notice body').fill('<p>Parking infringement {{notice_number}}</p>');
  await templateForm.getByLabel('Fine amount (optional)').fill('60');
  await templateForm.getByText('I checked this version against the source document.').click();
  await templateForm.getByRole('button', { name: 'Save template' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Parking enforcement infringement template v1 saved' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Notice templates' }).getByText('Parking enforcement · Infringement')).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('archiving a branch asks first and then confirms', async ({ page }) => {
  await signInAsAdmin(page, '/admin/org-setup');
  const northern = page.getByRole('list', { name: 'Branches' }).locator('li').filter({ hasText: 'Northern Branch' });
  page.once('dialog', (dialog) => { expect(dialog.message()).toContain('Archive Northern Branch?'); void dialog.accept(); });
  await northern.getByRole('button', { name: 'Archive' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Northern Branch archived' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Branches' }).getByText('Northern Branch')).toHaveCount(0);
});