import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

const BRANCH_CONTEXT = [{
  organization_id: '41414141-4141-4141-8141-414141414141',
  organization_name: 'Northern Branch',
  authority_basis: 'branch_authorisation',
  role_at_branch: 'admin',
  module_access: ['roster'],
  can_be_rostered: false,
  is_default: true,
}];

for (const roleCase of [
  { role: 'admin' as const, scope: 'Team planning' },
  { role: 'admin_officer' as const, scope: 'Daily scheduling' },
  { role: 'master' as const, scope: 'Roster oversight' },
  { role: 'grand_master' as const, scope: 'Roster oversight' },
]) {
  test(`${roleCase.role} receives the matching roster workspace`, async ({ page }) => {
    const browserErrors = monitorBrowserErrors(page);
    if (roleCase.role === 'admin_officer') {
      await page.addInitScript(() => window.sessionStorage.setItem('fcm.admin_officer.portal', 'admin'));
    }
    await installSupabaseFixtures(page, { adminRole: roleCase.role });
    await page.route('**/rest/v1/rpc/get_operating_organization_contexts', async (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(BRANCH_CONTEXT) }));
    await signInAsAdmin(page, '/admin/roster');

    await expect(page.getByRole('heading', { name: 'Roster', exact: true })).toBeVisible();
    await expect(page.getByText(roleCase.scope, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create shift' })).toBeVisible();
    expect(browserErrors, browserErrors.join('\n')).toEqual([]);
  });
}
