import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

for (const roleCase of [
  { role: 'admin' as const, title: 'Team approvals', scope: 'Your organisation' },
  { role: 'master' as const, title: 'Organisation approvals', scope: 'Your organisation and branches' },
  { role: 'grand_master' as const, title: 'Platform approvals', scope: 'Platform and authorised organisations' },
]) {
  test(`${roleCase.role} receives the matching approvals workspace`, async ({ page }) => {
    const browserErrors = monitorBrowserErrors(page);
    await installSupabaseFixtures(page, { adminRole: roleCase.role });
    await signInAsAdmin(page, '/admin/approvals');

    await expect(page.getByRole('heading', { name: roleCase.title })).toBeVisible();
    await expect(page.getByText(roleCase.scope, { exact: true })).toBeAttached();
    if (roleCase.role === 'admin') await expect(page.getByRole('tab', { name: /Decisions/ })).toBeVisible();
    const documentsTab = page.getByRole('tab', { name: /Documents/ });
    if (await documentsTab.count()) await documentsTab.click();
    await expect(page.getByRole('heading', { name: 'Documents awaiting promotion' })).toBeVisible();
    expect(browserErrors, browserErrors.join('\n')).toEqual([]);
  });
}

for (const role of ['admin_officer', 'nzscv_monitor'] as const) {
  test(`${role} does not see or deep-link into Approvals`, async ({ page }) => {
    const browserErrors = monitorBrowserErrors(page);
    if (role === 'admin_officer') {
      await page.addInitScript(() => window.sessionStorage.setItem('fcm.admin_officer.portal', 'admin'));
    }
    await installSupabaseFixtures(page, { adminRole: role });
    await signInAsAdmin(page, '/admin/approvals');

    await expect(page).toHaveURL(/\/admin\/hub$/);
    const isMobile = await page.evaluate(() => window.innerWidth < 768);
    if (isMobile) await page.getByRole('button', { name: 'Open navigation' }).click();
    const navigation = page.locator(isMobile ? '.admin-mobile-drawer' : '.admin-sidebar');
    await expect(navigation.getByRole('button', { name: 'Approvals' })).toHaveCount(0);
    expect(browserErrors, browserErrors.join('\n')).toEqual([]);
  });
}
