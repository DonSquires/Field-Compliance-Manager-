import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00')); await installSupabaseFixtures(page); });

test('organization role codes appear in Payroll role and do not replace the staff authorization role', async ({ page }) => {
  const referenceCodeRequest: { url?: URL } = {};
  let savedPayRole: Record<string, unknown> | null = null;
  await page.route('**/rest/v1/reference_codes*', async (route) => {
    referenceCodeRequest.url = new URL(route.request().url());
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ code: 'field_security', name: 'Field Security' }]) });
  });
  await page.route('**/rest/v1/rpc/set_staff_pay_role_code', async (route) => {
    savedPayRole = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ staff_id: '22222222-2222-4222-8222-222222222222', role_code: 'field_security' }) });
  });

  await signInAsAdmin(page, '/admin/people-hr');
  const staffCard = page.locator('.contact-card', { has: page.getByRole('heading', { name: 'Ana Ngata' }) });
  const payrollRole = staffCard.getByLabel('Payroll role');
  await expect(payrollRole.locator('option')).toHaveCount(2);
  await expect(payrollRole).toHaveValue('');
  await payrollRole.selectOption('field_security');
  await staffCard.getByRole('button', { name: 'Save payroll role' }).click();
  await expect(page.getByRole('status')).toContainText('Payroll role updated for Ana Ngata.');

  expect(referenceCodeRequest.url?.searchParams.get('organization_id')).toBe('eq.33333333-3333-4333-8333-333333333333');
  expect(referenceCodeRequest.url?.searchParams.get('code_type')).toBe('eq.role_code');
  expect(referenceCodeRequest.url?.searchParams.get('is_active')).toBe('eq.true');
  expect(savedPayRole).toMatchObject({ p_staff_id: '22222222-2222-4222-8222-222222222222', p_expected_role_code: null, p_role_code: 'field_security' });
  await expect(staffCard.getByText('Officer', { exact: true })).toBeVisible();
});

test('payroll administrator creates an organization code and assigns it to staff', async ({ page }) => {
  const roleCodes: Array<{ id: string; code: string; name: string }> = [];
  let createPayload: Record<string, unknown> | null = null;
  let assignmentPayload: Record<string, unknown> | null = null;
  await page.route('**/rest/v1/reference_codes*', async (route) => await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(roleCodes) }));
  await page.route('**/rest/v1/rpc/manage_pay_role_code', async (route) => {
    const payload = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
    createPayload = payload;
    const code = { id: 'rolerole-role-4role-rolecode0001', code: String(payload.p_code), name: String(payload.p_name) };
    roleCodes.push(code);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(code) });
  });
  await page.route('**/rest/v1/rpc/set_staff_pay_role_code', async (route) => {
    assignmentPayload = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ staff_id: '22222222-2222-4222-8222-222222222222', role_code: 'FIELD_SECURITY' }) });
  });

  await signInAsAdmin(page, '/admin/people-hr');
  await expect(page.getByText('No active payroll role codes.')).toBeVisible();
  await page.getByRole('button', { name: 'Add payroll role code' }).click();
  await page.getByLabel('Payroll role code').fill('FIELD_SECURITY');
  await page.getByLabel('Name shown to staff admins').fill('Field security officer');
  await page.getByRole('button', { name: 'Create payroll role code' }).click();
  await expect(page.getByRole('status')).toContainText('Payroll role code FIELD_SECURITY created.');

  const staffCard = page.locator('.contact-card', { has: page.getByRole('heading', { name: 'Ana Ngata' }) });
  await staffCard.getByLabel('Payroll role').selectOption('FIELD_SECURITY');
  await staffCard.getByRole('button', { name: 'Save payroll role' }).click();
  await expect(page.getByRole('status')).toContainText('Payroll role updated for Ana Ngata.');
  expect(createPayload).toMatchObject({ p_action: 'create', p_code: 'FIELD_SECURITY', p_name: 'Field security officer' });
  expect(assignmentPayload).toMatchObject({ p_staff_id: '22222222-2222-4222-8222-222222222222', p_expected_role_code: null, p_role_code: 'FIELD_SECURITY' });
});

test('saving a changed payroll role sends the existing role as the expected value', async ({ page }) => {
  let savedPayRole: Record<string, unknown> | null = null;
  await page.route('**/rest/v1/staff_profiles*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
      { id: '22222222-2222-4222-8222-222222222222', user_id: '22222222-2222-4222-8222-222222222222', employment_type: 'permanent', start_date: '2025-02-03', end_date: null, work_ready: true, role_code: 'existing_guard' },
      { id: '2f2f2f2f-2222-4222-8222-222222222222', user_id: '2f2f2f2f-2222-4222-8222-222222222222', employment_type: 'casual', start_date: '2026-03-01', end_date: null, work_ready: true, role_code: null },
    ]) });
  });
  await page.route('**/rest/v1/reference_codes*', async (route) => await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ code: 'existing_guard', name: 'Existing Guard' }, { code: 'field_security', name: 'Field Security' }]) }));
  await page.route('**/rest/v1/rpc/set_staff_pay_role_code', async (route) => {
    savedPayRole = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ staff_id: '22222222-2222-4222-8222-222222222222', role_code: 'field_security' }) });
  });

  await signInAsAdmin(page, '/admin/people-hr');
  const staffCard = page.locator('.contact-card', { has: page.getByRole('heading', { name: 'Ana Ngata' }) });
  await staffCard.getByLabel('Payroll role').selectOption('field_security');
  await staffCard.getByRole('button', { name: 'Save payroll role' }).click();
  await expect(page.getByRole('status')).toContainText('Payroll role updated for Ana Ngata.');
  expect(savedPayRole).toMatchObject({ p_staff_id: '22222222-2222-4222-8222-222222222222', p_expected_role_code: 'existing_guard', p_role_code: 'field_security' });
});

test('an empty organization role-code list leaves Payroll role unassigned and saving disabled', async ({ page }) => {
  await page.route('**/rest/v1/reference_codes*', async (route) => await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

  await signInAsAdmin(page, '/admin/people-hr');
  const staffCard = page.locator('.contact-card', { has: page.getByRole('heading', { name: 'Ana Ngata' }) });
  const payrollRole = staffCard.getByLabel('Payroll role');
  await expect(payrollRole.locator('option')).toHaveText(['No role code assigned']);
  await expect(payrollRole).toHaveValue('');
  await expect(staffCard.getByRole('button', { name: 'Save payroll role' })).toBeDisabled();
});

test('a rejected payroll-role write is shown without changing the authorization role', async ({ page }) => {
  await page.route('**/rest/v1/reference_codes*', async (route) => await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ code: 'field_security', name: 'Field Security' }]) }));
  await page.route('**/rest/v1/rpc/set_staff_pay_role_code', async (route) => await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: '23505', message: 'Role code already exists for this staff member.' }) }));

  await signInAsAdmin(page, '/admin/people-hr');
  const staffCard = page.locator('.contact-card', { has: page.getByRole('heading', { name: 'Ana Ngata' }) });
  await staffCard.getByLabel('Payroll role').selectOption('field_security');
  await staffCard.getByRole('button', { name: 'Save payroll role' }).click();
  await expect(page.getByRole('alert')).toContainText('Role code already exists for this staff member.');
  await expect(staffCard.getByText('Officer', { exact: true })).toBeVisible();
});

test('admin officer sees only the People & HR work needed for daily service administration', async ({ page }) => {
  await page.addInitScript(() => window.sessionStorage.setItem('fcm.admin_officer.portal', 'admin'));
  await installSupabaseFixtures(page, { adminRole: 'admin_officer' });
  await signInAsAdmin(page, '/admin/people-hr');
  await expect(page.getByRole('button', { name: 'Workforce', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'People', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rostering', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pay & Assets', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'People', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Leave', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Recruitment', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Performance', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'HR Cases', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Pay & Assets', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Timesheets', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pay Review', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Rostering', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Court', exact: true })).toHaveCount(0);
});

test('people and HR decisions are governed and operational', async ({ page }) => {
  const errors = monitorBrowserErrors(page); await signInAsAdmin(page, '/admin/people-hr');
  await expect(page.getByRole('heading', { name: 'Roster & HR' })).toBeVisible();
  await expect(page.getByText('Ana Ngata', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Prepare someone to work' })).toBeVisible();
  await expect(page.getByText('These lists change the rules used by onboarding and rostering.')).toBeHidden();
  await expect(page.getByText('No verified current credential')).toBeVisible();
  const staffCard = page.locator('.contact-card', { has: page.getByRole('heading', { name: 'Ana Ngata' }) });
  await expect(staffCard.getByText('Work ready', { exact: true })).toBeVisible();
  await expect(staffCard.getByRole('button', { name: 'Record credential' })).toHaveCount(0);
  await expect(staffCard).toHaveScreenshot('hr-staff-card.png');
  const jordanCard = page.locator('.contact-card', { has: page.getByRole('heading', { name: 'Jordan Lee' }) });
  await expect(jordanCard.getByText('Not work ready', { exact: true })).toBeVisible();
  await expect(jordanCard.getByRole('button', { name: 'Record credential' })).toBeVisible();
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

test('onboarding shows each person as a seven-step ladder with what the next step needs', async ({ page }) => {
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/rest/v1/rpc/get_staff_onboarding_readiness', async (route) => await route.fulfill(json([{ ledger_id: '81818181-8181-4181-8181-818181818181', staff_id: '22222222-2222-4222-8222-222222222222', user_id: '22222222-2222-4222-8222-222222222222', display_name: 'Ana Ngata', current_stage: 'evidence', status: 'in_progress', version: 3, target_start: '2026-09-07', blockers: ['No verified current credential'], next_action: 'record_evidence' }])));
  await page.route('**/rest/v1/rpc/manage_staff_onboarding', async (route) => { const payload = JSON.parse(route.request().postData() ?? '{}'); expect(payload.p_action).toBe('advance'); expect(payload.p_stage).toBe('supervision'); expect(payload.p_expected_version).toBe(3); await route.fulfill(json([{ ledger_id: payload.p_ledger_id, current_stage: 'supervision', status: 'in_progress', version: 4 }])); });
  await signInAsAdmin(page, '/admin/people-hr');
  await page.getByRole('button', { name: 'Onboarding', exact: true }).click();
  const card = page.locator('.contact-card', { has: page.getByRole('heading', { name: 'Ana Ngata' }) }).first();
  const ladder = card.getByRole('list', { name: 'Onboarding steps for Ana Ngata' });
  await expect(ladder.getByRole('listitem')).toHaveCount(7);
  await expect(ladder.locator('li.is-done')).toHaveCount(2);
  await expect(ladder.locator('li.is-current')).toContainText('Evidence');
  await expect(card.getByText('Holding this up: No verified current credential')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Record site induction' })).toBeVisible();
  await expect(card).toHaveScreenshot('hr-onboarding-ladder.png');
  await card.getByRole('button', { name: 'Next: Supervision' }).click();
  const dialog = page.getByRole('dialog', { name: 'Move to Supervision?' });
  await expect(dialog.getByText(/Needs: A line manager assigned/)).toBeVisible();
  await dialog.getByLabel('Stage note').fill('Evidence pack checked against the record.');
  await dialog.getByRole('button', { name: 'Advance step' }).click();
  await expect(dialog).toBeHidden();
});

test('a first credential is recorded and verified from the onboarding card through the governed RPC', async ({ page }) => {
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/rest/v1/rpc/get_staff_onboarding_readiness', async (route) => await route.fulfill(json([{ ledger_id: '81818181-8181-4181-8181-818181818181', staff_id: '22222222-2222-4222-8222-222222222222', user_id: '22222222-2222-4222-8222-222222222222', display_name: 'Ana Ngata', current_stage: 'evidence', status: 'in_progress', version: 3, target_start: null, blockers: ['No verified current credential'], next_action: 'record_evidence' }])));
  let payload: Record<string, unknown> | null = null;
  await page.route('**/rest/v1/rpc/record_staff_credential', async (route) => { const body = JSON.parse(route.request().postData() ?? '{}'); payload = body; await route.fulfill(json([{ credential_id: '91919191-9191-4191-8191-919191919191', staff_id: body.p_staff_id, verified: true, verified_at: '2026-08-30T10:00:00.000Z', created: true }])); });
  await signInAsAdmin(page, '/admin/people-hr');
  await page.getByRole('button', { name: 'Onboarding', exact: true }).click();
  const card = page.locator('.contact-card', { has: page.getByRole('heading', { name: 'Ana Ngata' }) }).first();
  await card.getByRole('button', { name: 'Record credential' }).click();
  const dialog = page.getByRole('dialog', { name: 'Record credential' });
  await expect(dialog.getByText(/A verified, current credential is what makes an officer work ready/)).toBeVisible();
  const submit = dialog.getByRole('button', { name: 'Record and verify' });
  await expect(submit).toBeDisabled();
  await dialog.getByLabel('Credential type').selectOption('security_licence');
  await dialog.getByLabel('Credential number').fill('COA-123456');
  await dialog.getByLabel('Issuing authority').fill('PSPLA');
  await dialog.getByLabel('Issued').fill('2026-01-15');
  await dialog.getByLabel('Expires').fill('2028-01-14');
  await dialog.getByLabel('Evidence note', { exact: true }).fill('Original certificate sighted; number matches the PSPLA register.');
  await expect(submit).toBeEnabled();
  await expect(dialog).toHaveScreenshot('hr-record-credential-dialog.png');
  await submit.click();
  await expect(page.getByRole('status')).toContainText('Security licence recorded and verified for Ana Ngata. If nothing else is holding them up, you can mark them work ready.');
  expect(payload).toMatchObject({ p_staff_id: '22222222-2222-4222-8222-222222222222', p_credential_type: 'security_licence', p_credential_number: 'COA-123456', p_issuing_authority: 'PSPLA', p_issued_date: '2026-01-15', p_expiry_date: '2028-01-14', p_verified: true });
});
test('administrator sets the rest and hours rules the roster enforces, in plain words', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  let saved: Record<string, unknown> | null = null;
  await page.route('**/rest/v1/rpc/manage_organization_fatigue_rules', async (route) => {
    const payload = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>; saved = payload;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ organization_id: payload.p_organization_id, min_rest_hours_between_shifts: payload.p_min_rest_hours_between_shifts, max_hours_per_week: payload.p_max_hours_per_week, max_consecutive_days: payload.p_max_consecutive_days, enforced: payload.p_enforced, updated_at: '2026-08-30T09:31:00.000Z' }) });
  });
  await signInAsAdmin(page, '/admin/people-hr');
  await page.getByRole('button', { name: 'Rostering', exact: true }).click();
  await page.getByRole('button', { name: 'Rest & hours rules' }).click();
  const panel = page.locator('.roster-rules');
  await expect(panel.getByRole('heading', { name: 'Rest & hours rules' })).toBeVisible();
  // no row yet: the rosterer is told the roster is not checking anything
  await expect(panel.getByRole('status')).toContainText('Not set. The roster is not checking rest or hours for anyone yet');
  await expect(panel.getByRole('button', { name: 'Set rules' })).toBeVisible();
  await panel.getByLabel('Minimum rest between shifts (hours)').fill('10');
  await panel.getByLabel('Most hours in a week').fill('60');
  await panel.getByLabel('Most days in a row').fill('6');
  await panel.getByRole('button', { name: 'Set rules' }).click();
  await expect(panel.getByText('Saved. From now on the roster refuses a shift that breaks these rules and says which one.')).toBeVisible();
  await expect(panel.getByRole('status').first()).toContainText('Enforced: at least 10 h rest between shifts, no more than 60 h in a Monday–Sunday week, no more than 6 days in a row.');
  await expect(panel.getByRole('button', { name: 'Save rules' })).toBeVisible();
  expect(saved).toMatchObject({ p_organization_id: '33333333-3333-4333-8333-333333333333', p_min_rest_hours_between_shifts: 10, p_max_hours_per_week: 60, p_max_consecutive_days: 6, p_enforced: true });
  expect(errors, errors.join('\n')).toEqual([]);
});
