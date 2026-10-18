import { expect, test } from '@playwright/test';
import { installOfficerScheduleFixtures, installSupabaseFixtures, signInAsAdmin, signInAsOfficer } from './fixtures';

const shiftId = '66666666-6666-4666-8666-666666666666';

test('officer signs an unsafe task assessment, retries a network failure and reads the persisted receipt', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-31T05:30:00Z'));
  await installOfficerScheduleFixtures(page);
  await page.route('**/rest/v1/shifts**', (route) => route.fulfill({ json: [{
    id: shiftId, organization_id: '33333333-3333-4333-8333-333333333333', officer_user_id: '22222222-2222-4222-8222-222222222222',
    service_type: 'patrol', scheduled_start: '2026-08-31T05:00:00Z', scheduled_end: '2026-08-31T17:00:00Z',
    status: 'in_progress', notes: null, total_stops: 0, shift_stops: [],
  }] }));
  await page.route('**/rest/v1/rpc/get_shift_safety_briefing', (route) => route.fulfill({ json: {
    shift_id: shiftId, stop_id: null, shift_status: 'in_progress', places: [{ kind: 'site', id: 'site-1', location_id: 'place-1', name: 'Civic Centre' }],
    hazards: [], warnings: [], item_count: 0, briefing_hash: 'empty', acknowledgement_required: false,
    acknowledged: false, acknowledged_at: null, changed_since_acknowledgement: false, is_assigned_officer: true,
  } }));
  let saved = false;
  const receipt = { id: 'assessment-1', task: 'Check rear gate', hazards: 'Loose material on walkway', controls: ['Isolate the area'],
    likelihood: 2, consequence: 3, decision: 'stop_work', signed_at: '2026-08-31T05:30:00Z', review_status: 'open', review_outcome: null };
  await page.route('**/rest/v1/rpc/get_shift_risk_assessments', (route) => route.fulfill({ json: saved ? [receipt] : [] }));
  const requests: Array<Record<string, unknown>> = [];
  await page.route('**/rest/v1/rpc/submit_dynamic_risk_assessment', (route) => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) return route.fulfill({ status: 503, json: { message: 'Temporary connection failure' } });
    saved = true;
    return route.fulfill({ json: receipt });
  });
  await signInAsOfficer(page);
  await page.locator('.safety-task-assessments summary').click();
  await page.getByRole('button', { name: 'Assess a task', exact: true }).click();
  await page.getByLabel('Task to be done').fill('Check rear gate');
  await page.getByLabel('Hazards observed').fill('Loose material on walkway');
  await page.getByLabel('Task controls, one per line').fill('Isolate the area');
  await page.getByLabel('Task likelihood (1-5)').fill('2');
  await page.getByLabel('Task consequence (1-5)').fill('3');
  await page.getByLabel('Work decision').selectOption('stop_work');
  await expect(page.getByText(/Do not begin or resume this task/)).toBeVisible();
  await page.getByLabel(/I assessed this task/).check();
  await page.getByRole('button', { name: 'Sign and submit assessment' }).click();
  await expect(page.getByText('Temporary connection failure')).toBeVisible();
  expect(saved).toBe(false);
  await page.getByRole('button', { name: 'Sign and submit assessment' }).click();
  await expect(page.getByText(/Your signed assessment is recorded/)).toBeVisible();
  await expect(page.locator('.safety-task-receipt')).toContainText('STOP WORK - reassess before resuming this task');
  expect(requests[0].p_client_request_id).toBe(requests[1].p_client_request_id);
  expect(requests[1]).toMatchObject({ p_decision: 'stop_work', p_understood: true, p_likelihood: 2, p_consequence: 3 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('supervisor reads source evidence, links corrective action and records the review receipt', async ({ page }) => {
  await installSupabaseFixtures(page);
  let closed = false;
  const workspace = () => ({
    owners: [], hazards: [{ id: 'h1', title: 'Wet path', version: 1, controls: [], control_levels: {}, risk_owner_id: null, review_due: null, location_id: 'place-1' }],
    incidents: [], investigations: [{ id: 'inv-1', name: 'Existing investigation' }],
    reviews: [{ id: 'review-1', location_id: 'place-1', title: 'H&S field report review', field_report_id: 'report-1', incident_id: null,
      assessment: null, status: closed ? 'closed' : 'open', created_at: '2026-08-31T05:30:00Z',
      source_description: 'Synthetic officer account: walkway isolated pending repair.', investigation_id: closed ? 'inv-1' : null,
      outcome: closed ? 'Path isolated, maintenance arranged and hazard controls reviewed.' : null }],
  });
  await page.route('**/rest/v1/rpc/get_safety_review_workspace', (route) => route.fulfill({ json: workspace() }));
  let payload: Record<string, unknown> | null = null;
  await page.route('**/rest/v1/rpc/complete_safety_review', (route) => {
    payload = route.request().postDataJSON(); closed = true;
    return route.fulfill({ json: 'review-1' });
  });
  await signInAsAdmin(page, '/admin/field_reports');
  await page.getByText(/Safety reviews and risk ownership/).click();
  await page.getByText('Read original source account').click();
  await expect(page.getByText(/Synthetic officer account/)).toBeVisible();
  await page.getByRole('button', { name: 'Record corrective action' }).click();
  await page.getByLabel('Findings, corrective action and closure reason').fill('Path isolated, maintenance arranged and hazard controls reviewed.');
  await page.getByLabel('Related place hazard').selectOption('h1');
  await page.getByLabel('Existing investigation').selectOption('inv-1');
  await page.getByRole('button', { name: 'Complete safety review' }).click();
  await expect(page.getByText(/Review closed with findings/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open linked investigation' })).toBeVisible();
  expect(payload).toMatchObject({ p_review_id: 'review-1', p_hazard_id: 'h1', p_investigation_id: 'inv-1' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
