import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00'));
  await installSupabaseFixtures(page);
});

test('administrator manages identity and access preset', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/users');
  await expect(page.getByRole('heading', { name: 'Identity and access' })).toBeVisible();

  const jordan = page.getByText('Jordan Lee', { exact: true }).locator('..').locator('..');
  await jordan.getByTitle('Manage identity and access').click();
  const workspace = page.getByRole('dialog', { name: 'Jordan Lee' });
  await expect(workspace.getByText('Verify credential')).toBeVisible();
  await expect(workspace.getByText('missing_valid')).toBeVisible();

  await workspace.getByLabel('Role').selectOption('admin_officer');
  await workspace.getByLabel('Phone').fill('021 555 0199');
  await workspace.getByLabel('Reason for change').fill('Jordan is taking the duty administration rotation.');
  await workspace.getByRole('button', { name: 'Save identity' }).click();
  await expect(workspace.getByRole('status')).toContainText('Identity and role updated');

  await workspace.getByLabel('Preset').selectOption('53535353-5353-4353-8353-535353535353');
  await workspace.getByLabel('Reason for access change').fill('Approved operations administration responsibilities.');
  await workspace.getByRole('button', { name: 'Assign preset' }).click();
  await expect(workspace.getByRole('status')).toContainText('Access preset assigned');
  await workspace.evaluate((element) => { element.scrollTop = 0; });
  await expect(workspace).toHaveScreenshot('user-identity-workspace.png');
  await workspace.getByRole('button', { name: 'Close user workspace' }).click();

  expect(errors, errors.join('\n')).toEqual([]);
});

test('administrator sends an employment-aware officer invitation', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/users');
  await page.getByRole('button', { name: 'Invite user' }).click();
  const invite = page.locator('form.identity-invite-form');
  await expect(invite.getByRole('heading', { name: 'Invite a user' })).toBeVisible();
  await invite.getByLabel('Display name').fill('Tama Ropata');
  await invite.getByLabel('Email address').fill('tama@fcm.test');
  await invite.getByLabel('Role').selectOption('officer');
  await expect(invite.getByLabel('Employment type')).toBeVisible();
  await invite.getByLabel('Employment type').selectOption('casual');
  await invite.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByRole('status')).toContainText('Invitation sent to tama@fcm.test');
  await expect(page.getByText('Tama Ropata', { exact: true })).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('administrator ends a direct area grant with retained reason', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/access-control');
  await expect(page.getByRole('heading', { name: 'Access Control' })).toBeVisible();
  const grantRow = page.getByText('reports', { exact: true }).locator('..');
  await grantRow.getByRole('button', { name: 'Revoke' }).click();
  const dialog = page.getByRole('dialog', { name: 'End direct access grant' });
  await expect(dialog.getByText(/Jordan Lee/)).toBeVisible();
  await dialog.getByLabel('Reason for ending access').fill('Temporary reporting review assignment has ended.');
  await dialog.getByRole('button', { name: 'End grant' }).click();
  await expect(page.getByText('ended', { exact: true })).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});
