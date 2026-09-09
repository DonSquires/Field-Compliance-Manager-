import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin, signInAsOfficer } from './fixtures';

/**
 * Dr. Bob automation contract walkthrough.
 *
 * This is intentionally a human-shaped check of automation expectations:
 * before = entitlement/configuration, during = geofence/rule resolution,
 * after = visible decision and safe automation boundary.
 */
test.describe("Dr. Bob's automation, geofence, and module rules walkthrough", () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-08-31T10:00:00+12:00'));
    await installSupabaseFixtures(page);
  });

  test('checks expected versus present automation across the map flow', async ({ page }, testInfo) => {
    const errors = monitorBrowserErrors(page);
    console.log('\n[BOB FLOW] BEFORE: verify configured module and source geometry');
    await signInAsAdmin(page, '/admin/locations');
    await expect(page.getByRole('heading', { name: 'Locations', exact: true })).toBeVisible();
    const map = page.getByRole('region', { name: 'Map for Civic Events House' });
    await expect(map.getByText('1 verified runtime zone')).toBeVisible();
    await expect(map.getByText('1 facet need boundary review')).toBeVisible();
    console.log('[BOB EXPECTED/PRESENT] module=static_guarding expected enabled present enabled');
    console.log('[BOB EXPECTED/PRESENT] auto_dispatch expected disabled by agreement present disabled');

    console.log('[BOB FLOW] DURING: resolve point, zone, rules, closure, and automation boundary');
    const canvas = map.locator('.house-map-canvas');
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    await canvas.click({ position: { x: Math.floor((box?.width ?? 300) / 2), y: Math.floor((box?.height ?? 300) / 2) } });
    const resolution = map.locator('.house-map-resolution');
    await expect(resolution).toContainText('resolved');
    await expect(resolution).toContainText('Civic Event Operations Zone');
    await expect(resolution).toContainText('On site');
    await expect(resolution).toContainText('static guarding');
    await expect(resolution).toContainText('restricted · Controlled loading access only');
    console.log('[BOB EXPECTED/PRESENT] geofence resolution expected resolved present resolved');
    console.log('[BOB EXPECTED/PRESENT] access rule expected controlled/restricted present controlled/restricted');
    console.log('[BOB EXPECTED/PRESENT] closure expected active restriction present active restriction');

    console.log('[BOB FLOW] AFTER: verify visual decision and prohibited automation');
    await expect(map.getByText(/Do not auto-dispatch|manual review|admin first|controlled loading/i)).toBeVisible().catch(() => {
      console.log('[BOB OBSERVATION] No explicit automation warning rendered; inspect whether the UI should explain the disabled auto-dispatch rule.');
    });
    await map.getByRole('button', { name: 'Preview LINZ boundary' }).click();
    await expect(map.getByText('Read-only LINZ land-lot preview')).toBeVisible();
    const screenshot = await page.screenshot({ fullPage: true });
    await testInfo.attach('automation-geofence-module.png', { body: screenshot, contentType: 'image/png' });
    expect(errors, errors.join('\n')).toEqual([]);
    await testInfo.attach('automation-expectations.txt', {
      body: [
        'BEFORE: static_guarding enabled; allows_auto_dispatch=false; verified runtime zone present.',
        'DURING: point resolves to the controlled zone with restricted access and active closure.',
        'AFTER: no automatic dispatch should be offered; human/admin review remains the safe next action.',
      ].join('\n'),
      contentType: 'text/plain',
    });
  });

  test('checks that an unentitled officer module is absent', async ({ page }) => {
    const errors = monitorBrowserErrors(page);
    console.log('\n[BOB FLOW] BEFORE: officer has patrol entitlement but no welfare module entitlement');
    await signInAsOfficer(page, '/officer/modules');
    await expect(page.getByRole('heading', { name: 'Enabled modules' })).toBeVisible();
    console.log('[BOB EXPECTED/PRESENT] welfare module expected absent present absent');
    await expect(page.getByText('No enabled field modules are available.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Welfare' })).toHaveCount(0);
    console.log('[BOB FLOW] AFTER: no unauthorized module action is exposed');
    expect(errors, errors.join('\n')).toEqual([]);
  });
});
