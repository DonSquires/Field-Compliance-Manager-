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