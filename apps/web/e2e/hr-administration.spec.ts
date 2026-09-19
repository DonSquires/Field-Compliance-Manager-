import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00')); await installSupabaseFixtures(page); });

test('people and HR decisions are governed and operational', async ({ page }) => {
  const errors = monitorBrowserErrors(page); await signInAsAdmin(page, '/admin/people-hr');
  await expect(page.getByRole('heading', { name: 'Roster & HR' })).toBeVisible();
  await expect(page.getByText('Ana Ngata', { exact: true })).toBeVisible();
  await expect(page.getByText('No verified current credential')).toBeVisible();
  const staffCard = page.locator('.contact-card', { has: page.getByRole('heading', { name: 'Ana Ngata' }) });
  await expect(staffCard.getByText('Work ready', { exact: true })).toBeVisible();
  await expect(staffCard).toHaveScreenshot('hr-staff-card.png');
  await page.getByRole('button', { name: 'Remove work readiness' }).click();
  const readinessDialog = page.getByRole('dialog', { name: 'Remove work readiness?' });
  await expect(readinessDialog.getByRole('button', { name: 'Confirm readiness' })).toBeDisabled();
  await readinessDialog.getByLabel('Readiness review notes').fill('Temporary restriction pending refresher training review.');
  await expect(readinessDialog).toHaveScreenshot('hr-readiness-review.png');
  await readinessDialog.getByRole('button', { name: 'Confirm readiness' }).click();
  await expect(page.getByText('Ana Ngata readiness updated and audited.')).toBeVisible();

  await page.getByRole('button', { name: 'People', exact: true }).click();
  await page.getByRole('button', { name: 'Leave', exact: true }).click();
  await page.getByRole('button', { name: 'Branch check' }).click();
  const leaveDialog = page.getByRole('dialog', { name: 'Branch check leave request?' });
  await leaveDialog.getByLabel('Review notes').fill('Local roster coverage has been checked.');
  await expect(leaveDialog).toHaveScreenshot('hr-leave-review.png');
  await leaveDialog.getByRole('button', { name: 'Confirm decision' }).click();
  await expect(page.getByText('Leave branch check recorded for corporate confirmation.')).toBeVisible();

  await page.getByRole('button', { name: 'Pay & Assets', exact: true }).click();
  await page.getByRole('button', { name: 'Timesheets' }).click();
  await page.getByRole('button', { name: 'Branch check' }).click();
  await page.getByRole('dialog', { name: 'Branch check timesheet?' }).getByRole('button', { name: 'Confirm decision' }).click();
  await expect(page.getByText('Timesheet branch check recorded for corporate payroll approval.')).toBeVisible();

  await page.getByRole('button', { name: 'Rostering', exact: true }).click();
  await page.getByRole('button', { name: 'Open Shifts' }).click();
  await page.getByRole('button', { name: '+ New Coverage Request' }).click();
  await page.getByLabel('Date').fill('2026-09-20'); await page.getByLabel('Required Staff').fill('3');
  await page.getByLabel('Start Time').fill('18:00'); await page.getByLabel('End Time').fill('23:00');
  await page.getByLabel('Urgency').selectOption('urgent'); await page.getByLabel('Notes').fill('Festival perimeter coverage');
  await page.getByRole('button', { name: 'Create Request' }).click();
  await expect(page.getByText('Requires 3 staff')).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('administrator finalizes an officer coverage claim into roster ownership', async ({ page }) => {
  const errors=monitorBrowserErrors(page);await signInAsAdmin(page,'/admin/people-hr');
  await page.getByRole('button',{name:'Rostering'}).click();
  await page.getByRole('button',{name:'Open Shifts'}).click();
  const claim=page.getByText('Claimed festival patrol').locator('..').locator('..');
  await expect(claim).toContainText('claimed by Ana Ngata');
  await claim.getByRole('button',{name:'Finalize assignment'}).click();
  const dialog=page.getByRole('dialog',{name:'Finalize assignment'});
  await expect(dialog.getByRole('button',{name:'Confirm assignment'})).toBeDisabled();
  await dialog.getByLabel('Select work unit').selectOption({label:'North District Patrol · patrol'});
  await dialog.getByLabel('Finalization notes').fill('Claim matched to the published festival patrol requirement.');
  await dialog.getByRole('button',{name:'Confirm assignment'}).click();
  await expect(page.getByRole('status')).toContainText('Coverage finalized for Ana Ngata · roster 96969696 · shift 97979797.');
  await expect(page.getByText('Claimed festival patrol')).toBeHidden();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  expect(errors,errors.join('\n')).toEqual([]);
});

test('administrator corrects submitted timesheet hours before review', async ({ page }) => {
  await page.route('**/rest/v1/rpc/get_branch_timesheet_queue', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: '38383838-3838-4838-8838-383838383838', staff_id: '22222222-2222-4222-8222-222222222222', period_start: '2026-08-17', period_end: '2026-08-23', scheduled_hours: 40, actual_hours: 39, overtime_hours: 0, work_derived_hours: 39, adjustment_hours: 0, work_summary: { source_count: 4 }, status: 'submitted', branch_review_notes: null, branch_reviewed_by: null }]) });
  });
  await page.route('**/rest/v1/rpc/correct_timesheet_hours', async (route) => {
    const payload = JSON.parse(route.request().postData() ?? '{}');
    expect(payload.p_expected_status).toBe('submitted');
    expect(payload.p_actual_hours).toBe(40);
    expect(payload.p_overtime_hours).toBe(0);
    expect(payload.p_reason).toBe('Corrected after comparing the signed attendance record.');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: '38383838-3838-4838-8838-383838383838', status: 'submitted' }]) });
  });
  await signInAsAdmin(page, '/admin/people-hr');
  await page.getByRole('button', { name: 'Pay & Assets', exact: true }).click();
  await page.getByRole('button', { name: 'Timesheets' }).click();
  await page.getByRole('button', { name: 'Edit hours' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit timesheet hours' });
  await dialog.getByLabel('Actual hours').fill('40');
  await dialog.getByLabel('Correction reason').fill('Corrected after comparing the signed attendance record.');
  await dialog.getByRole('button', { name: 'Save correction' }).click();
  await expect(page.getByRole('status')).toContainText('Timesheet hours corrected and returned to submitted review.');
});

test('administrator returns branch-checked time for correction and reapproves it', async ({ page }) => {
  let status = 'branch_checked';
  await page.route('**/rest/v1/rpc/get_branch_timesheet_queue', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: '38383838-3838-4838-8838-383838383838', staff_id: '22222222-2222-4222-8222-222222222222', period_start: '2026-08-17', period_end: '2026-08-23', scheduled_hours: 40, actual_hours: 40, overtime_hours: 0, work_derived_hours: 40, adjustment_hours: 0, work_summary: { source_count: 4 }, status, branch_review_notes: null, branch_reviewed_by: '2f2f2f2f-2222-4222-8222-222222222222' }]) });
  });
  await page.route('**/rest/v1/rpc/review_timesheet', async (route) => {
    const payload = JSON.parse(route.request().postData() ?? '{}');
    if (payload.p_decision === 'rejected') status = 'rejected';
    if (payload.p_decision === 'approved') {
      expect(payload.p_expected_status).toBe('branch_checked');
      status = 'approved';
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: '38383838-3838-4838-8838-383838383838', status }]) });
  });
  await page.route('**/rest/v1/rpc/correct_timesheet_hours', async (route) => { status = 'submitted'; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: '38383838-383838383838', status }]) }); });
  await page.route('**/rest/v1/rpc/review_branch_timesheet', async (route) => { status = 'branch_checked'; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: '38383838-383838383838', status }]) }); });
  await signInAsAdmin(page, '/admin/people-hr');
  await page.getByRole('button', { name: 'Pay & Assets', exact: true }).click();
  await page.getByRole('button', { name: 'Timesheets' }).click();
  await page.getByRole('button', { name: 'Return for correction' }).click();
  const returnDialog = page.getByRole('dialog', { name: 'Return for correction timesheet?' });
  await returnDialog.getByLabel('Review notes').fill('Please reconcile the signed attendance record.');
  await returnDialog.getByRole('button', { name: 'Confirm decision' }).click();
  await expect(page.getByRole('status')).toContainText('Timesheet returned for correction.');
});

test('administrator approves a pending direct shift swap', async ({ page }) => {
  await page.route('**/rest/v1/shift_swaps**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: '15151515-1515-4515-8515-151515151515', original_shift_id: '66666666-6666-4666-8666-666666666666', original_staff_id: '22222222-2222-4222-8222-222222222222', swap_with_staff_id: '2f2f2f2f-2222-4222-8222-222222222222', swap_type: 'direct', reason: 'Jordan agreed to cover this assignment.', status: 'pending', requested_by: '22222222-2222-4222-8222-222222222222', requested_at: '2026-08-30T09:20:00.000Z' }]) });
  });
  await page.route('**/rest/v1/rpc/review_shift_swap', async (route) => {
    const payload = JSON.parse(route.request().postData() ?? '{}');
    expect(payload.p_swap_id).toBe('15151515-1515-4515-8515-151515151515');
    expect(payload.p_decision).toBe('approved');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: payload.p_swap_id, status: 'approved' }]) });
  });
  await signInAsAdmin(page, '/admin/people-hr');
  await expect(page.getByRole('heading', { name: /Shift swap requests/ })).toBeVisible();
  await page.getByRole('button', { name: 'Approve swap' }).click();
  const dialog = page.getByRole('dialog', { name: 'Approve shift swap?' });
  await dialog.getByRole('button', { name: 'Confirm decision' }).click();
  await expect(page.getByRole('status')).toContainText('Shift swap approved and roster ownership updated.');
});

test('an offered candidate can be hired later, which creates the login and staff record for this branch', async ({ page }) => {
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  const calls: string[] = [];
  await page.route('**/rest/v1/recruitment_vacancies**', async (route) => await route.fulfill(json([{ id: '71717171-7171-4171-8171-717171717171', title: 'Patrol officer – Nelson', employment_type: 'permanent', location_summary: 'Nelson', status: 'open', opens_on: null, closes_on: null }])));
  await page.route('**/rest/v1/recruitment_candidates**', async (route) => await route.fulfill(json([{ id: '72727272-7272-4272-8272-727272727272', vacancy_id: '71717171-7171-4171-8171-717171717171', first_name: 'Tama', last_name: 'Rangi', email: 'tama@fcm.test', stage: 'offer', status: 'offered', offer_role: 'officer', offer_employment_type: 'casual', offer_start_date: '2026-09-14' }])));
  await page.route('**/rest/v1/rpc/manage_recruitment_candidate', async (route) => { const payload = JSON.parse(route.request().postData() ?? '{}'); calls.push('manage'); expect(payload.p_expected_stage).toBe('offer'); expect(payload.p_next_stage).toBe('offer'); expect(payload.p_offer_employment_type).toBe('casual'); await route.fulfill(json([{ id: payload.p_candidate_id, stage: 'offer', status: 'offered' }])); });
  await page.route('**/functions/v1/create-user', async (route) => { const payload = JSON.parse(route.request().postData() ?? '{}'); calls.push('create-user'); expect(payload.role).toBe('officer'); expect(payload.branch_authorisations?.[0]?.can_be_rostered).toBe(true); await route.fulfill(json({ success: true, user_id: '73737373-7373-4373-8373-737373737373', staff_id: '74747474-7474-4474-8474-747474747474' })); });
  await page.route('**/rest/v1/rpc/convert_recruitment_candidate_to_staff', async (route) => { const payload = JSON.parse(route.request().postData() ?? '{}'); calls.push('convert'); expect(payload.p_staff_id).toBe('74747474-7474-4474-8474-747474747474'); await route.fulfill(json([{ candidate_id: payload.p_candidate_id, status: 'hired' }])); });
  await signInAsAdmin(page, '/admin/people-hr');
  await page.getByRole('button', { name: 'People', exact: true }).click();
  await page.getByRole('button', { name: 'Recruitment', exact: true }).click();
  const card = page.locator('.contact-card', { has: page.getByRole('heading', { name: 'Tama Rangi' }) });
  await expect(card.getByText('Offer made', { exact: true })).toBeVisible();
  await expect(card.getByText(/Offer: Officer · Casual · starts/)).toBeVisible();
  await card.getByRole('button', { name: 'Candidate accepted – hire' }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm acceptance and hire' });
  await expect(dialog.getByText(/creates their login and staff record for this branch and starts onboarding/)).toBeVisible();
  await expect(dialog.getByLabel('Employment type')).toHaveValue('casual');
  await expect(dialog.getByLabel('Proposed start')).toHaveValue('2026-09-14');
  await dialog.getByLabel('Offer note').fill('Accepted by phone, start confirmed.');
  await dialog.getByRole('button', { name: 'Confirm acceptance and hire' }).click();
  await expect(page.getByRole('status')).toContainText('Tama Rangi hired. Their login and staff record are created for this branch and onboarding has started – see the Staff tab.');
  expect(calls).toEqual(['manage', 'create-user', 'convert']);
});