import { expect, test } from '@playwright/test';
import {
  installOfficerScheduleFixtures,
  installSupabaseFixtures,
  monitorBrowserErrors,
  signInAsAdmin,
  signInAsOfficer,
} from './fixtures';

test.describe('paired patrol and dispatch acceptance', () => {
  test('admin and officer complete a correlated dispatch handoff', async ({ browser }) => {
    const events: string[] = [];
    const adminContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const officerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const admin = await adminContext.newPage();
    const officer = await officerContext.newPage();
    const adminErrors = monitorBrowserErrors(admin);
    const officerErrors = monitorBrowserErrors(officer);

    await installSupabaseFixtures(admin);
    await installOfficerScheduleFixtures(officer);
    await admin.route('**/rest/v1/dispatch_jobs**', async (route) => await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', job_type: 'alarm_response', priority: 'high', status: 'dispatched', briefing_notes: 'Verify the north loading entrance and record the outcome.', sla_minutes: 15, sla_respond_by: '2026-08-30T10:00:00.000Z', sla_breached: false, expected_dwell_minutes: 8, timing_source: 'dispatcher_override', shift_id: '66666666-6666-4666-8666-666666666666', client_site_id: '42424242-4242-4242-8242-424242424242', created_at: '2026-08-30T09:00:00.000Z', site: { name: 'Civic Operations Centre', address: '10 Waimea Road, Nelson', hs_notes: 'Boundary-first arrival check required.', access_instructions: 'Use the north loading entrance.' }, resource: { name: 'Unit N587' } }]) }));
    await Promise.all([
      signInAsAdmin(admin, '/admin/hub'),
      signInAsOfficer(officer, '/officer/dispatch'),
    ]);

    await expect(admin.locator('nav').first()).toBeVisible();
    events.push('admin-online');

    await expect(officer.getByRole('heading', { name: 'Dispatch', exact: true })).toBeVisible();
    await expect(officer.getByText('Alarm response', { exact: true })).toBeVisible();
    events.push('officer-received-dispatch');

    const complete = officer.getByRole('button', { name: 'Mark Completed' });
    await expect(complete).toBeDisabled();
    await officer.getByLabel('Outcome notes').fill('Paired test: entrance checked, panel reset, supervisor notified.');
    await expect(complete).toBeEnabled();
    await complete.click();
    await expect(officer.getByRole('region', { name: 'Dispatch completion receipt' })).toContainText('Dispatch completed');
    await expect(officer.getByText('No active dispatch jobs right now.')).toBeVisible();
    events.push('officer-completed-dispatch');

    await admin.goto('/admin/field-ops?area=dispatch&job=cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    await expect(admin.getByLabel(/Dispatch details for/i)).toBeVisible();
    await expect(admin.getByText(/Verify the north loading entrance/)).toBeVisible();
    events.push('admin-verified-dispatch-receipt');

    expect(events).toEqual([
      'admin-online',
      'officer-received-dispatch',
      'officer-completed-dispatch',
      'admin-verified-dispatch-receipt',
    ]);
    expect(adminErrors, adminErrors.join('\n')).toEqual([]);
    expect(officerErrors, officerErrors.join('\n')).toEqual([]);
    expect(await admin.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await officer.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await adminContext.close();
    await officerContext.close();
  });

  test('officer patrol exercises session, checkpoint, completion, and receipt states', async ({ page }) => {
    await installOfficerScheduleFixtures(page);
    const browserErrors = monitorBrowserErrors(page);
    await page.route('**/rest/v1/shifts**', async (route) => {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ id: 'patrol-shift-0001', service_type: 'patrol', scheduled_start: '2026-08-30T08:00:00.000Z', scheduled_end: '2026-08-30T16:00:00.000Z', status: 'published', zone_id: 'zone-0001', patrol_route_id: null, zone: { name: 'North District Patrol' }, route: null }]) });
    });
    await page.route('**/rest/v1/patrols**', async (route) => {
      const request = route.request();
      if (request.method() === 'POST') {
        await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify([{ id: 'patrol-session-0001', status: 'in_progress', started_at: '2026-08-30T09:30:00.000Z' }]) });
        return;
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify([]) });
    });
    await page.route('**/rest/v1/patrol_checkpoints**', async (route) => {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ id: 'checkpoint-0001', name: 'North loading entrance', description: 'Verify gate and alarm panel.', qr_code: 'FCM-NORTH-001', gps_lat: -41.274, gps_lng: 173.283, radius_meters: 50, active: true }]) });
    });
    await page.route('**/rest/v1/patrol_checkpoint_visits**', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify([{ id: 'visit-0001', checkpoint_id: 'checkpoint-0001', visited_at: '2026-08-30T09:35:00.000Z', scan_method: 'manual', notes: 'Gate secure; alarm panel normal.' }]) });
        return;
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify([]) });
    });

    await signInAsOfficer(page, '/officer/patrol');
    const patrolLauncher = page.getByRole('button', { name: /Patrol.*Route and checkpoints/i }).first();
    if (await patrolLauncher.isVisible().catch(() => false)) await patrolLauncher.click();
    await expect(page.getByRole('heading', { name: 'Field Patrol & Checkpoints' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'Field Patrol & Checkpoints' })).toBeVisible();
    const shift = page.getByRole('button', { name: /North District Patrol|PATROL/i }).first();
    await expect(shift).toBeVisible();
    await shift.click();
    await expect(page.getByRole('button', { name: 'Start Patrol Session' })).toBeVisible();
    await page.getByRole('button', { name: 'Start Patrol Session' }).click();
    await expect(page.getByText('Route Checkpoints (1)', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Record Visit' }).click();
    await page.getByPlaceholder(/Site secure/).fill('Gate secure; alarm panel normal.');
    await page.getByRole('button', { name: '✓ Confirm & Record Visit' }).click();
    await expect(page.getByText(/Visited/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Complete Patrol Session' })).toBeVisible();
    await page.getByRole('button', { name: 'Complete Patrol Session' }).click();
    await expect(page.getByText('Patrol Completed', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(browserErrors, browserErrors.join('\n')).toEqual([]);
  });
});
