import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00'));
  await installSupabaseFixtures(page);
});

test('priority dispatch item opens its exact operational review record', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  const dispatchJob = {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', job_type: 'alarm_response', priority: 'high', status: 'dispatched',
    briefing_notes: 'Verify the north loading entrance and record the outcome.', sla_minutes: 15, sla_respond_by: '2026-08-30T10:00:00.000Z', sla_breached: false,
    expected_dwell_minutes: 8, timing_source: 'dispatcher_override', shift_id: '66666666-6666-4666-8666-666666666666', client_site_id: '42424242-4242-4242-8242-424242424242', created_at: '2026-08-30T09:00:00.000Z',
    site: { name: 'Civic Operations Centre', address: '10 Waimea Road, Nelson', hs_notes: 'Boundary-first arrival check required.', access_instructions: 'Use the north loading entrance.' }, resource: { name: 'Unit N587' },
  };
  await page.route('**/rest/v1/dispatch_jobs**', async (route) => await route.fulfill({ contentType: 'application/json', body: JSON.stringify([dispatchJob]) }));
  await signInAsAdmin(page, '/admin/hub');
  const queueItem = page.getByRole('button', { name: /Alarm response.*SLA due/i });
  await expect(queueItem).toBeVisible();
  await queueItem.click();
  await expect(page).toHaveURL(/\/admin\/field-ops\?area=dispatch&job=cccccccc-cccc-4ccc-8ccc-cccccccccccc/);
  const detail = page.getByLabel('Dispatch details for Civic Operations Centre');
  await expect(detail).toBeVisible();
  await expect(detail).toContainText('10 Waimea Road, Nelson');
  await expect(detail).toContainText('Expected attendance');
  await expect(detail).toContainText('8 min');
  await expect(detail).toContainText('Verify the north loading entrance');
  await expect(detail).toContainText('Use the north loading entrance.');
  await expect(detail).toContainText('Boundary-first arrival check required.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});
test('an alarm-response job shows its response ladder counted from the alarm, in the dispatcher\'s words', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  const dispatchJob = {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', job_type: 'alarm_response', priority: 'high', status: 'on_scene',
    briefing_notes: '[Alarm burglary / intruder, received 30/08/2026, 8:50:00 am by phone call]', sla_minutes: 15, sla_respond_by: '2026-08-29T21:05:00.000Z', sla_breached: true,
    expected_dwell_minutes: 8, timing_source: 'dispatcher_override', shift_id: '66666666-6666-4666-8666-666666666666', client_site_id: '42424242-4242-4242-8242-424242424242',
    created_at: '2026-08-29T21:00:00.000Z', dispatched_at: '2026-08-29T21:02:00.000Z', acknowledged_at: null, en_route_at: '2026-08-29T21:05:00.000Z', on_scene_at: '2026-08-29T21:12:00.000Z', completed_at: null,
    site: { name: 'Civic Operations Centre', address: '10 Waimea Road, Nelson', hs_notes: null, access_instructions: null }, resource: { name: 'Unit N587' },
  };
  await page.route('**/rest/v1/dispatch_jobs**', async (route) => await route.fulfill({ contentType: 'application/json', body: JSON.stringify([dispatchJob]) }));
  let alarmQuery = '';
  await page.route('**/rest/v1/alarm_events**', async (route) => {
    alarmQuery = route.request().url();
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ dispatch_job_id: dispatchJob.id, received_at: '2026-08-29T20:50:00.000Z', signal_type: 'burglary', intake_channel: 'phone', panel_id: 'P-12', zone_name: 'Rear door', zone_number: '4', account_number: null }]) });
  });
  await signInAsAdmin(page, '/admin/field-ops?area=dispatch&job=cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  const detail = page.getByLabel('Dispatch details for Civic Operations Centre');
  await expect(detail).toBeVisible();
  await expect(detail.getByRole('status')).toContainText('On scene 22 min after the alarm — 7 min over the 15 min target.');
  const steps = detail.locator('.dispatch-response-steps li');
  await expect(steps.nth(0)).toContainText('Alarm received (Burglary / intruder, by phone call)');
  await expect(steps.nth(1)).toContainText(/Job created.*10 min after the alarm/);
  await expect(steps.nth(3)).toContainText(/Acknowledged\s*Not yet/);
  await expect(steps.nth(5)).toContainText(/On scene.*22 min after the alarm/);
  expect(alarmQuery).toContain('dispatch_job_id=in.%28cccccccc-cccc-4ccc-8ccc-cccccccccccc%29');
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test.describe('in New Zealand', () => {
  test.use({ timezoneId: 'Pacific/Auckland' });
  test('the new alarm job form asks for the signal, the channel and the time in local wall-clock terms', async ({ page }) => {
    await page.route('**/rest/v1/dispatch_jobs**', async (route) => await route.fulfill({ contentType: 'application/json', body: '[]' }));
    await signInAsAdmin(page, '/admin/field-ops?area=dispatch');
    await page.getByRole('button', { name: /New Job|Create Job|\+ Job/i }).first().click();
    await expect(page.getByLabel('Alarm signal')).toHaveValue('burglary');
    await expect(page.getByLabel('How it reached us')).toHaveValue('phone');
    // the fixture clock is 2026-08-29T12:00Z = 30 Aug 00:00 in Auckland: the default must be the local wall clock (toISOString would show 29 Aug 12:00)
    await expect(page.getByLabel('Alarm received at')).toHaveValue('2026-08-30T00:00');
    await expect(page.getByText('The response target counts from this time, not from when the job is saved.')).toBeVisible();
  });
});
