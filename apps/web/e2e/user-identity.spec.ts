import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00'));
  await installSupabaseFixtures(page);
  await page.route('**/rest/v1/module_catalog**', async (route) => await route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify([{ module_key: 'patrol', active: true }, { module_key: 'static_guarding', active: true }]),
  }));
  await page.route('**/rest/v1/rpc/get_operating_organization_contexts', async (route) => await route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify([{ organization_id: '41414141-4141-4141-8141-414141414141', organization_name: 'Northern Branch', authority_basis: 'branch_authorisation', role_at_branch: 'admin', module_access: ['people_hr', 'access_control'], can_be_rostered: false, is_default: true }, { organization_id: '45454545-4545-4545-8545-454545454545', organization_name: 'Southern Branch', authority_basis: 'branch_authorisation', role_at_branch: 'admin', module_access: ['people_hr', 'access_control'], can_be_rostered: false, is_default: false }]),
  }));
});

test('administrator manages identity and access preset', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/users');
  await expect(page.getByRole('heading', { name: 'Identity and access' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Branch staff access' })).toBeVisible();

  const jordan = page.getByText('Jordan Lee', { exact: true }).locator('..').locator('..');
  await jordan.getByRole('button', { name: 'Edit user' }).click();
  const workspace = page.getByRole('dialog', { name: 'Jordan Lee' });
  await expect(workspace.getByText('Verify credential')).toBeVisible();
  await expect(workspace.getByText('missing_valid')).toBeVisible();

  await workspace.getByRole('button', { name: 'Grant branch access' }).click();
  await workspace.getByLabel('Delivery branch').selectOption('45454545-4545-4545-8545-454545454545');
  await workspace.getByLabel('Role at branch').selectOption('supervisor');
  await workspace.getByLabel('Patrol').check();
  await workspace.getByLabel('Reason for change').last().fill('Jordan now supervises the southern response team.');
  await workspace.getByRole('button', { name: 'Grant access' }).click();
  await expect(workspace.getByText('Southern Branch', { exact: true })).toBeVisible();

  await workspace.getByLabel('Role').selectOption('admin_officer');
  await workspace.getByLabel('Phone').fill('021 555 0199');
  await workspace.getByPlaceholder('Why is this identity or role changing?').fill('Jordan is taking the duty administration rotation.');
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

test('administrator sends a non-field identity invitation', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/users');
  await page.getByRole('button', { name: 'Invite user' }).click();
  const invite = page.locator('form.identity-invite-form');
  await expect(invite.getByRole('heading', { name: 'Invite a user' })).toBeVisible();
  await invite.getByLabel('Display name').fill('Tama Ropata');
  await invite.getByLabel('Email address').fill('tama@fcm.test');
  await invite.getByLabel('Role').selectOption('client_viewer');
  await expect(invite.getByRole('switch')).toHaveCount(0);
  await invite.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByRole('status')).toContainText('Invitation sent to tama@fcm.test');
  await expect(page.getByText('Tama Ropata', { exact: true })).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});

for (const linkage of ['account-only', 'hr-only', 'roster-only', 'both'] as const) {
  test(`administrator sends an officer invitation with ${linkage} linkage`, async ({ page }) => {
    await page.route('**/rest/v1/organizations**', async (route) => {
      if (route.request().url().includes('organization_type=eq.branch')) {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ id: '41414141-4141-4141-8141-414141414141', name: 'Northern Branch' }]) });
      } else await route.fallback();
    });
    await signInAsAdmin(page, '/admin/users');
    await page.getByRole('button', { name: 'Invite user' }).click();
    const invite = page.locator('form.identity-invite-form');
    await invite.getByLabel('Display name').fill('Test Officer');
    await invite.getByLabel('Email address').fill('officer@fcm.test');
    await invite.getByLabel('Role').selectOption('officer');
    await expect(invite.getByRole('switch', { name: 'Link to HR' })).not.toBeChecked();
    await expect(invite.getByRole('switch', { name: 'Link to rostering' })).not.toBeChecked();
    if (linkage === 'hr-only' || linkage === 'both') await invite.getByRole('switch', { name: 'Link to HR' }).check();
    if (linkage === 'roster-only' || linkage === 'both') {
      await invite.getByRole('switch', { name: 'Link to rostering' }).check();
      await invite.getByLabel('Delivery branch').selectOption('41414141-4141-4141-8141-414141414141');
    }
    const request = page.waitForRequest('**/functions/v1/create-user');
    await invite.getByRole('button', { name: 'Send invitation' }).click();
    const payload = (await request).postDataJSON();
    expect(payload.role).toBe('officer');
    if (linkage === 'hr-only' || linkage === 'both') expect(payload.staff).toEqual({ employment_type: 'permanent', work_ready: false });
    else expect(payload).not.toHaveProperty('staff');
    if (linkage === 'roster-only' || linkage === 'both') expect(payload.branch_authorisations).toEqual([{ branch_org_id: '41414141-4141-4141-8141-414141414141', role_at_branch: 'officer', module_access: [], can_be_rostered: false }]);
    else expect(payload).not.toHaveProperty('branch_authorisations');
    await expect(page.getByRole('status')).toContainText('Invitation sent to officer@fcm.test');
  });
}

test('failed invitation retains the profile form and shows the actual send error', async ({ page }) => {
  await page.route('**/functions/v1/create-user', async (route) => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Email service temporarily unavailable' }) }));
  await signInAsAdmin(page, '/admin/users');
  await page.getByRole('button', { name: 'Invite user' }).click();
  const invite = page.locator('form.identity-invite-form');
  await invite.getByLabel('Display name').fill('Test Officer');
  await invite.getByLabel('Email address').fill('officer@fcm.test');
  await invite.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByRole('alert')).toContainText('Email service temporarily unavailable');
  await expect(invite.getByLabel('Email address')).toHaveValue('officer@fcm.test');
  await expect(page.getByRole('status').filter({ hasText: 'Invitation sent' })).toHaveCount(0);
});

test('administrator ends a direct area grant with retained reason', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/access-control');
  await expect(page.getByRole('heading', { name: 'Access rules' })).toBeVisible();
  const grantRow = page.getByText('Reports', { exact: true }).locator('..');
  await grantRow.getByRole('button', { name: 'End access' }).click();
  const dialog = page.getByRole('dialog', { name: 'End branch permission' });
  await expect(dialog.getByText(/Jordan Lee/)).toBeVisible();
  await dialog.getByLabel('Reason for ending access').fill('Temporary reporting review assignment has ended.');
  await dialog.getByRole('button', { name: 'End access' }).click();
  await expect(page.getByText('Ended', { exact: true })).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('administrator grants a local branch authority with retained reason', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/access-control');
  await page.getByRole('button', { name: 'Add branch permission' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add branch permission' });
  await expect(dialog.getByRole('button', { name: 'Add permission' })).toBeDisabled();
  await expect(dialog).toHaveScreenshot('branch-authority-grant.png');
  await dialog.getByLabel('Staff member').selectOption({ label: 'Jordan Lee' });
  await dialog.getByLabel('Permission').selectOption('timesheet_local_review');
  await dialog.getByLabel('Access').selectOption('approve');
  await dialog.getByLabel('Why is this needed?').fill('Jordan provides local timesheet review cover.');
  await dialog.getByRole('button', { name: 'Add permission' }).click();
  await expect(page.getByText('Timesheet local review', { exact: true })).toBeVisible();
  await expect(page.getByText('timesheet_local_review', { exact: true })).toHaveCount(0);
  expect(errors, errors.join('\n')).toEqual([]);
});
