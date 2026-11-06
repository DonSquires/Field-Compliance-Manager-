import { expect, test } from '@playwright/test';
import { installOfficerScheduleFixtures, signInAsOfficer } from './fixtures';

const shiftId = '66666666-6666-4666-8666-666666666666';
const briefing = (hash: string) => ({
  shift_id: shiftId, stop_id: null, shift_status: 'published',
  places: [{ kind: 'site', id: '42424242-4242-4242-8242-424242424242', location_id: 'place-1', name: 'Civic Centre' }],
  hazards: [{
    id: 'hazard-1', title: hash === 'v1' ? 'Wet loading entrance' : 'Broken lighting at the entrance',
    hazard_class: 'slips_trips_falls', risk_level: 'high', controls: ['Use the marked dry walkway'],
    details: null, status: 'active', origin: 'bob_extracted', version: hash === 'v1' ? 1 : 2,
    place_name: 'Civic Centre', place_kind: 'site', source_name: 'Synthetic site safety plan',
    source_locator: 'Section 2', source_as_of: '2026-08-01', has_source_document: false,
    recorded_by: 'Fixture organisation', updated_at: '2026-08-30T00:00:00Z',
  }],
  warnings: [], item_count: 1, briefing_hash: hash, acknowledgement_required: true,
  acknowledged: false, acknowledged_at: null, changed_since_acknowledgement: hash !== 'v1', is_assigned_officer: true,
});

test.beforeEach(async ({ page, context }) => {
  await page.clock.setFixedTime(new Date('2026-08-31T05:30:00Z'));
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: -41.2705, longitude: 173.284 });
  await installOfficerScheduleFixtures(page);
  await page.route('**/functions/v1/linz-lookup', async (route) => route.fulfill({ json: { candidates: [] } }));
  await page.route('**/rest/v1/rpc/evaluate_shift_start_position', async (route) => route.fulfill({ json: { status: 'on_site', place_name: 'Civic Centre', distance_m: 0 } }));
});

test('shift start waits for the exact safety acknowledgement, including a stale-version retry', async ({ page }) => {
  let hash = 'v1';
  let starts = 0;
  const acknowledgements: string[] = [];
  await page.route('**/rest/v1/rpc/get_shift_safety_briefing', async (route) => route.fulfill({ json: briefing(hash) }));
  await page.route('**/rest/v1/rpc/acknowledge_safety_briefing', async (route) => {
    const args = route.request().postDataJSON();
    acknowledgements.push(args.p_briefing_hash);
    if (hash === 'v1') {
      hash = 'v2';
      await route.fulfill({ status: 409, json: { message: 'The safety briefing changed', hint: 'briefing_changed' } });
    } else await route.fulfill({ json: { acknowledged_at: '2026-08-31T05:30:00Z', briefing_hash: hash } });
  });
  await page.route('**/rest/v1/rpc/start_officer_shift', async (route) => {
    starts++;
    await route.fulfill({ json: [{ shift_id: shiftId, shift_status: 'in_progress', started_at: '2026-08-31T05:30:00Z', position_status: 'on_site', place_name: 'Civic Centre' }] });
  });
  await signInAsOfficer(page);
  await page.locator('.officer-assigned-shift').first().getByRole('button', { name: 'Start shift' }).click();
  const dialog = page.getByRole('dialog', { name: 'Before you start: risks on this shift' });
  await expect(dialog).toContainText('Wet loading entrance');
  expect(starts).toBe(0);
  await dialog.getByRole('button', { name: "I've read these risks – start shift" }).click();
  await expect(dialog).toContainText('Broken lighting at the entrance');
  await expect(dialog).toContainText('updated while you were reading');
  expect(starts).toBe(0);
  const bounds = await dialog.boundingBox();
  const viewport = page.viewportSize();
  expect(bounds && viewport && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height).toBe(true);
  await dialog.getByRole('button', { name: "I've read these risks – start shift" }).click();
  await expect(page.getByText(/Shift started at/)).toBeVisible();
  expect(starts).toBe(1);
  expect(acknowledgements).toEqual(['v1', 'v2']);
});

test('a briefing service failure is visible and never starts the shift', async ({ page }) => {
  let starts = 0;
  await page.route('**/rest/v1/rpc/get_shift_safety_briefing', async (route) => route.fulfill({ status: 503, json: { message: 'Safety service unavailable' } }));
  await page.route('**/rest/v1/rpc/start_officer_shift', async (route) => { starts++; await route.fulfill({ json: [] }); });
  await signInAsOfficer(page);
  await page.locator('.officer-assigned-shift').first().getByRole('button', { name: 'Start shift' }).click();
  await expect(page.locator('.officer-schedule')).toContainText('safety briefing for this shift could not be loaded');
  expect(starts).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('unscheduled work is prepared, briefed and only then started', async ({ page }) => {
  let starts = 0;
  let acknowledged = false;
  await page.route('**/rest/v1/rpc/start_ad_hoc_officer_shift', async (route) => route.fulfill({ json: {
    id: shiftId, service_type: 'patrol', scheduled_start: '2026-08-31T05:30:00Z',
    scheduled_end: '2026-08-31T17:30:00Z', status: 'scheduled', notes: null, shift_health: null, total_stops: 0, ended_reason: null,
  } }));
  await page.route('**/rest/v1/rpc/get_shift_safety_briefing', async (route) => route.fulfill({ json: briefing('v1') }));
  await page.route('**/rest/v1/rpc/acknowledge_safety_briefing', async (route) => {
    acknowledged = true;
    await route.fulfill({ json: { acknowledged_at: '2026-08-31T05:30:00Z', briefing_hash: 'v1' } });
  });
  await page.route('**/rest/v1/rpc/start_officer_shift', async (route) => {
    expect(acknowledged).toBe(true);
    starts++;
    await route.fulfill({ json: [{ shift_id: shiftId, shift_status: 'in_progress', started_at: '2026-08-31T05:30:00Z' }] });
  });
  await signInAsOfficer(page);
  await page.getByText('Start an unscheduled shift', { exact: true }).click();
  await page.getByLabel('Work unit', { exact: true }).selectOption('44444444-4444-4444-8444-444444444445');
  await page.getByRole('button', { name: 'Start unscheduled shift' }).click();
  const dialog = page.getByRole('dialog', { name: 'Before you start: risks on this shift' });
  await expect(dialog).toContainText('Wet loading entrance');
  expect(starts).toBe(0);
  await dialog.getByRole('button', { name: "I've read these risks – start shift" }).click();
  await expect(page.getByText(/Shift started at/)).toBeVisible();
  expect(starts).toBe(1);
});

test('an on-shift report becomes visible as unreviewed and requires a new confirmation', async ({ page }) => {
  let reported = false;
  let payload: Record<string, unknown> | null = null;
  await page.route('**/rest/v1/shifts**', async (route) => route.fulfill({ json: [{
    id: shiftId, organization_id: '33333333-3333-4333-8333-333333333333', officer_user_id: '22222222-2222-4222-8222-222222222222',
    service_type: 'patrol', scheduled_start: '2026-08-31T05:00:00Z', scheduled_end: '2026-08-31T17:00:00Z',
    status: 'in_progress', notes: null, total_stops: 0, shift_stops: [],
  }] }));
  await page.route('**/rest/v1/rpc/get_shift_safety_briefing', async (route) => {
    const next = briefing('v1');
    await route.fulfill({ json: {
      ...next, shift_status: 'in_progress', hazards: reported ? [{ ...next.hazards[0], status: 'reported', origin: 'officer_reported' }] : [],
      item_count: reported ? 1 : 0, acknowledgement_required: reported, changed_since_acknowledgement: reported,
    } });
  });
  await page.route('**/rest/v1/rpc/report_place_hazard', async (route) => {
    payload = route.request().postDataJSON();
    reported = true;
    await route.fulfill({ json: 'synthetic-new-hazard' });
  });
  await signInAsOfficer(page);
  await page.getByRole('button', { name: 'Report a hazard', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Report a hazard' });
  await dialog.getByLabel('What is the hazard').fill('Wet loading entrance');
  await dialog.getByLabel('What others should do').fill('Use the marked dry walkway');
  await dialog.getByRole('button', { name: 'Report hazard', exact: true }).click();
  await expect(page.getByText('Hazard reported. Your supervisor has been asked to review it.')).toBeVisible();
  expect(payload).toMatchObject({ p_shift_id: shiftId, p_place_kind: 'site', p_title: 'Wet loading entrance', p_controls: ['Use the marked dry walkway'] });
  await page.getByRole('button', { name: 'Read now' }).click();
  await expect(page.getByRole('dialog')).toContainText('Reported — not yet reviewed');
});
