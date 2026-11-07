import { expect, test, type Page } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00')); await installSupabaseFixtures(page); });

async function openStaffProfile(page: Page, name = 'Ana Ngata', staffId = '22222222-2222-4222-8222-222222222222') {
  await page.getByRole('row', { name: new RegExp(name) }).getByRole('button', { name: 'Open profile ↗' }).click();
  await page.waitForURL(new RegExp(`profile=${staffId}`));
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  return page;
}

async function savePayrollRole(page: Page, roleCode: string) {
  await page.getByLabel('Payroll role').selectOption(roleCode);
  const startDate = page.getByLabel('Start date', { exact: true });
  if (!(await startDate.inputValue())) await startDate.fill('2026-09-01');
  await page.getByLabel('Reason for change').fill('Payroll role confirmed by HR.');
  await page.getByRole('button', { name: 'Save employment details' }).click();
}

test('organization role codes appear in Payroll role and do not replace the staff authorization role', async ({ page }) => {
  const referenceCodeRequest: { url?: URL } = {};
  let savedPayRole: Record<string, unknown> | null = null;
  await page.route('**/rest/v1/reference_codes*', async (route) => {
    referenceCodeRequest.url = new URL(route.request().url());
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ code: 'field_security', name: 'Field Security' }]) });
  });
  await page.route('**/rest/v1/rpc/set_staff_employment_setup', async (route) => {
    savedPayRole = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ staff_id: '22222222-2222-4222-8222-222222222222', role_code: 'field_security' }) });
  });

  await signInAsAdmin(page, '/admin/people-hr');
  await expect(page.getByRole('row', { name: /Ana Ngata/ })).toContainText('ana@fcm.test');
  await expect(page.getByRole('row', { name: /Ana Ngata/ })).not.toContainText('Officer');
  const staffProfile = await openStaffProfile(page);
  await staffProfile.getByRole('button', { name: 'Employment & pay' }).click();
  const payrollRole = staffProfile.getByLabel('Payroll role');
  await expect(payrollRole.locator('option')).toHaveCount(2);
  await expect(payrollRole).toHaveValue('');
  await savePayrollRole(staffProfile, 'field_security');
  await expect(staffProfile.getByRole('status')).toContainText('Employment details saved for Ana Ngata.');

  expect(referenceCodeRequest.url?.searchParams.get('organization_id')).toBe('eq.33333333-3333-4333-8333-333333333333');
  expect(referenceCodeRequest.url?.searchParams.get('code_type')).toBe('eq.role_code');
  expect(referenceCodeRequest.url?.searchParams.get('is_active')).toBe('eq.true');
  expect(savedPayRole).toMatchObject({ p_staff_id: '22222222-2222-4222-8222-222222222222', p_expected_role_code: null, p_role_code: 'field_security' });
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
  await page.route('**/rest/v1/rpc/set_staff_employment_setup', async (route) => {
    assignmentPayload = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ staff_id: '22222222-2222-4222-8222-222222222222', role_code: 'FIELD_SECURITY' }) });
  });

  await signInAsAdmin(page, '/admin/people-hr');
  await expect(page.getByText('No active payroll role codes.')).toBeVisible();
  await page.getByRole('button', { name: 'Add payroll role code' }).click();
  await page.getByLabel('Role name').fill('Field Security Officer');
  await expect(page.getByLabel('Payroll role code')).toHaveValue('FIELD_SECURITY_OFFICER');
  await page.getByLabel('Payroll role code').fill('FIELD_SECURITY');
  await page.getByRole('button', { name: 'Create payroll role code' }).click();
  await expect(page.getByRole('status')).toContainText('Payroll role code FIELD_SECURITY created.');

  const staffProfile = await openStaffProfile(page);
  await staffProfile.getByRole('button', { name: 'Employment & pay' }).click();
  await savePayrollRole(staffProfile, 'FIELD_SECURITY');
  await expect(staffProfile.getByRole('status')).toContainText('Employment details saved for Ana Ngata.');
  expect(createPayload).toMatchObject({ p_action: 'create', p_code: 'FIELD_SECURITY', p_name: 'Field Security Officer' });
  expect(assignmentPayload).toMatchObject({ p_staff_id: '22222222-2222-4222-8222-222222222222', p_expected_role_code: null, p_role_code: 'FIELD_SECURITY' });
});

test('HR records a current roster skill and auditable training evidence for staff', async ({ page }) => {
  const skills: Array<Record<string, unknown>> = [];
  const training: Array<Record<string, unknown>> = [];
  let skillPayload: Record<string, unknown> | null = null;
  let trainingPayload: Record<string, unknown> | null = null;
  await page.route('**/rest/v1/roster_skill_catalog*', async (route) => await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'skill-first-aid', skill_name: 'First aid', skill_category: 'medical', active: true }]) }));
  await page.route('**/rest/v1/staff_skills*', async (route) => await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(skills) }));
  await page.route('**/rest/v1/staff_training_records*', async (route) => await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(training) }));
  await page.route('**/rest/v1/rpc/assign_roster_skill_to_staff', async (route) => {
    skillPayload = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
    const row = { id: 'staff-skill-first-aid', staff_id: skillPayload.p_staff_id, skill_id: skillPayload.p_skill_id, skill_name: 'First aid', skill_category: 'medical', proficiency_level: skillPayload.p_proficiency_level, certified: skillPayload.p_certified, certification_expiry: skillPayload.p_certification_expiry, notes: skillPayload.p_notes, updated_at: '2026-08-30T10:00:00Z' };
    skills.splice(0, skills.length, row);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(row) });
  });
  await page.route('**/rest/v1/rpc/record_staff_training', async (route) => {
    trainingPayload = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
    const row = { id: 'training-first-aid', staff_id: trainingPayload.p_staff_id, officer_id: trainingPayload.p_staff_id, training_name: trainingPayload.p_training_name, training_type: trainingPayload.p_training_type, provider: trainingPayload.p_provider, completed_date: trainingPayload.p_completed_date, expiry_date: trainingPayload.p_expiry_date, passed: trainingPayload.p_passed, score: trainingPayload.p_score, notes: trainingPayload.p_notes };
    training.splice(0, training.length, row);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(row) });
  });

  await signInAsAdmin(page, '/admin/people-hr');
  await page.getByRole('button', { name: 'Check credentials' }).click();
  await page.getByRole('button', { name: 'Assign skill' }).click();
  const skillForm = page.locator('form', { has: page.getByRole('button', { name: 'Save staff skill' }) });
  await skillForm.getByLabel('Staff member').selectOption('22222222-2222-4222-8222-222222222222');
  await skillForm.getByLabel('Catalog skill').selectOption('skill-first-aid');
  await skillForm.getByLabel('Certification state').selectOption('certified');
  await skillForm.getByLabel('Certification expiry').fill('2027-08-30');
  await skillForm.getByLabel('Evidence note').fill('Certificate sighted by HR');
  await skillForm.getByRole('button', { name: 'Save staff skill' }).click();
  await expect(page.getByRole('status')).toContainText('Staff skill saved');
  await expect(page.getByRole('row', { name: /Ana Ngata First aid/ })).toContainText('Current');

  await page.getByRole('button', { name: 'Record training' }).click();
  const trainingForm = page.locator('form', { has: page.getByRole('button', { name: 'Record training' }) });
  await trainingForm.getByLabel('Staff member').selectOption('22222222-2222-4222-8222-222222222222');
  await trainingForm.getByLabel('Training name').fill('Workplace first aid');
  await trainingForm.getByLabel('Training type').selectOption('external');
  await trainingForm.getByLabel('Provider').fill('NZ Training Provider');
  await trainingForm.getByLabel('Expiry').fill('2027-08-30');
  await trainingForm.getByLabel('Score (optional)').fill('92');
  await trainingForm.getByLabel('Evidence or review note').fill('Certificate reference FA-2026');
  await trainingForm.getByRole('button', { name: 'Record training' }).click();
  await expect(page.getByRole('status')).toContainText('Training record saved and audited.');
  await expect(page.getByRole('row').filter({ hasText: 'Workplace first aid' })).toContainText('Passed (92)');

  expect(skillPayload).toMatchObject({ p_staff_id: '22222222-2222-4222-8222-222222222222', p_skill_id: 'skill-first-aid', p_proficiency_level: 'competent', p_certified: true, p_certification_expiry: '2027-08-30' });
  expect(trainingPayload).toMatchObject({ p_staff_id: '22222222-2222-4222-8222-222222222222', p_training_name: 'Workplace first aid', p_training_type: 'external', p_passed: true, p_score: 92 });
  expect(typeof (trainingPayload as Record<string, unknown> | null)?.p_client_request_id).toBe('string');
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
  await page.route('**/rest/v1/rpc/set_staff_employment_setup', async (route) => {
    savedPayRole = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ staff_id: '22222222-2222-4222-8222-222222222222', role_code: 'field_security' }) });
  });

  await signInAsAdmin(page, '/admin/people-hr');
  await expect(page.getByRole('row', { name: /Ana Ngata/ })).toContainText('ana@fcm.test');
  await expect(page.getByRole('row', { name: /Ana Ngata/ })).not.toContainText('Officer');
  const staffProfile = await openStaffProfile(page);
  await staffProfile.getByRole('button', { name: 'Employment & pay' }).click();
  await savePayrollRole(staffProfile, 'field_security');
  await expect(staffProfile.getByRole('status')).toContainText('Employment details saved for Ana Ngata.');
  expect(savedPayRole).toMatchObject({ p_staff_id: '22222222-2222-4222-8222-222222222222', p_expected_role_code: 'existing_guard', p_role_code: 'field_security' });
});

test('an empty organization role-code list leaves Payroll role unassigned and saving disabled', async ({ page }) => {
  await page.route('**/rest/v1/reference_codes*', async (route) => await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

  await signInAsAdmin(page, '/admin/people-hr');
  const staffProfile = await openStaffProfile(page);
  await staffProfile.getByRole('button', { name: 'Employment & pay' }).click();
  const payrollRole = staffProfile.getByLabel('Payroll role');
  await expect(payrollRole.locator('option')).toHaveText(['Choose a payroll role']);
  await expect(payrollRole).toHaveValue('');
  await expect(staffProfile.getByText('No active payroll roles are configured for this organisation.')).toBeVisible();
  await expect(staffProfile.getByRole('button', { name: 'Save employment details' })).toBeDisabled();
});

test('a rejected payroll-role write is shown without changing the authorization role', async ({ page }) => {
  await page.route('**/rest/v1/reference_codes*', async (route) => await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ code: 'field_security', name: 'Field Security' }]) }));
  await page.route('**/rest/v1/rpc/set_staff_employment_setup', async (route) => await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: '23505', message: 'Role code already exists for this staff member.' }) }));

  await signInAsAdmin(page, '/admin/people-hr');
  const staffProfile = await openStaffProfile(page);
  await staffProfile.getByRole('button', { name: 'Employment & pay' }).click();
  await savePayrollRole(staffProfile, 'field_security');
  await expect(staffProfile.getByRole('alert')).toContainText('Role code already exists for this staff member.');
});

test('missing employment start date blocks the work-readiness review flow', async ({ page }) => {
  let readinessPayload: Record<string, unknown> | null = null;
  await page.route('**/rest/v1/staff_profiles*', async (route) => {
    const select = new URL(route.request().url()).searchParams.get('select') ?? '';
    if (!select.includes('end_date')) { await route.fallback(); return; }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
      { id: '22222222-2222-4222-8222-222222222222', user_id: '22222222-2222-4222-8222-222222222222', employment_type: 'permanent', start_date: '2025-02-03', end_date: null, work_ready: true, role_code: null },
      { id: '2f2f2f2f-2222-4222-8222-222222222222', user_id: '2f2f2f2f-2222-4222-8222-222222222222', employment_type: 'casual', start_date: null, end_date: null, work_ready: false, role_code: null },
    ]) });
  });
  await page.route('**/rest/v1/rpc/get_staff_readiness_assessment', async (route) => await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
    { staff_id: '22222222-2222-4222-8222-222222222222', user_id: '22222222-2222-4222-8222-222222222222', work_ready: true, identity_status: 'active', employment_status: 'current', credential_status: 'current', training_status: 'clear', blockers: [] },
    { staff_id: '2f2f2f2f-2222-4222-8222-222222222222', user_id: '2f2f2f2f-2222-4222-8222-222222222222', work_ready: false, identity_status: 'active', employment_status: 'missing_start_date', credential_status: 'current', training_status: 'clear', blockers: ['Employment start date is not set'] },
  ]) }));
  await page.route('**/rest/v1/rpc/set_staff_work_readiness', async (route) => {
    readinessPayload = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
    await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: 'P0001', message: 'Staff member is not work ready: Employment start date is not set' }) });
  });

  await signInAsAdmin(page, '/admin/people-hr');
  await expect(page.getByRole('row', { name: /Jordan Lee/ })).toContainText('Not work ready');
  const staffProfile = await openStaffProfile(page, 'Jordan Lee', '2f2f2f2f-2222-4222-8222-222222222222');
  await expect(staffProfile.getByText('Missing start date', { exact: true })).toBeVisible();
  await expect(staffProfile.getByText(/Employment start date is not set/)).toBeVisible();
  await staffProfile.getByRole('button', { name: 'Mark work ready' }).click();

  const readinessDialog = staffProfile.getByRole('dialog', { name: 'Mark work ready?' });
  await readinessDialog.getByLabel('Readiness review notes').fill('Synthetic test: employment start date is missing.');
  await readinessDialog.getByRole('button', { name: 'Confirm readiness' }).click();

  await expect(staffProfile.getByRole('alert')).toContainText('Staff member is not work ready: Employment start date is not set');
  await expect(staffProfile.getByText('Not work ready', { exact: true })).toBeVisible();
  expect(readinessPayload).toMatchObject({ p_staff_id: '2f2f2f2f-2222-4222-8222-222222222222', p_expected_work_ready: false, p_work_ready: true, p_review_notes: 'Synthetic test: employment start date is missing.' });
});

test('admin officer has the same People and Rosters work as an administrator', async ({ page }) => {
  await page.addInitScript(() => window.sessionStorage.setItem('fcm.admin_officer.portal', 'admin'));
  await installSupabaseFixtures(page, { adminRole: 'admin_officer' });
  await signInAsAdmin(page, '/admin/people-hr');
  const groups = page.getByLabel('People and HR workspace');
  await expect(groups.getByRole('button', { name: 'Staff', exact: true })).toBeVisible();
  await expect(groups.getByRole('button', { name: 'HR', exact: true })).toBeVisible();
  await expect(groups.getByRole('button', { name: 'Pay & Assets', exact: true })).toBeVisible();
  await expect(groups.getByRole('button', { name: 'Rostering', exact: true })).toHaveCount(0);
  await groups.getByRole('button', { name: 'HR', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Leave', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Recruitment', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Pay & Assets', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Timesheets', exact: true })).toBeVisible();
  await page.goto('/admin/people-hr?section=rostering');
  await expect(page.getByRole('heading', { name: 'Shift setup & open shifts' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Court', exact: true })).toBeVisible();
  await expect(page.getByLabel('People and HR workspace')).toHaveCount(0);
});

test('Rosters opens its HR-gated setup view when the Rostering module is disabled', async ({ page }) => {
  await page.route('**/rest/v1/organization_modules**', async (route) => await route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify([
      { id: 'abababab-abab-4bab-8bab-ababababab01', module_key: 'patrol', enabled: false },
      { id: 'abababab-abab-4bab-8bab-ababababab02', module_key: 'welfare', enabled: true },
      { id: 'abababab-abab-4bab-8bab-ababababab03', module_key: 'crm', enabled: true },
      { id: 'abababab-abab-4bab-8bab-ababababab04', module_key: 'rostering', enabled: false },
      { id: 'abababab-abab-4bab-8bab-ababababab05', module_key: 'hr', enabled: true },
      { id: 'abababab-abab-4bab-8bab-ababababab06', module_key: 'finance', enabled: true },
      { id: 'abababab-abab-4bab-8bab-ababababab07', module_key: 'workshop', enabled: true },
    ]),
  }));
  await signInAsAdmin(page, '/admin/people-hr');

  const rosters = page.getByRole('button', { name: 'Rosters', exact: true });
  const viewport = page.viewportSize();
  if (viewport && viewport.width < 768) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
  }
  await expect(rosters).toBeVisible();
  await rosters.click();
  await expect(page).toHaveURL(/\/admin\/people-hr\?section=rostering/);
  await expect(page.getByRole('heading', { name: 'Shift setup & open shifts' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rest & hours rules', exact: true })).toBeVisible();
});

test('administrator registers and corrects equipment before officer sign-out', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/people-hr');
  await page.getByRole('button', { name: 'Pay & Assets', exact: true }).click();
  await page.getByRole('button', { name: 'Assets', exact: true }).click();

  await expect(page.getByText('No fleet or equipment registered.')).toBeVisible();
  await page.getByRole('button', { name: 'Add asset' }).click();
  const createDialog = page.getByRole('dialog', { name: 'Add fleet or equipment' });
  await expect(createDialog.getByText('This creates the accountable register record. It does not assign the asset to a person or shift.')).toBeVisible();
  await createDialog.getByLabel('Name').fill('Patrol Radio 12');
  await createDialog.getByLabel('Type').selectOption('radio');
  await createDialog.getByLabel('Serial number').fill('RAD-0012');
  await createDialog.getByLabel('Next inspection').fill('2026-12-01');
  await createDialog.getByRole('button', { name: 'Add to register' }).click();

  await expect(page.getByRole('status')).toContainText('Patrol Radio 12 added with an audit receipt.');
  await expect(page.getByRole('cell', { name: 'Patrol Radio 12' })).toBeVisible();
  await page.getByRole('button', { name: 'Edit register' }).click();
  const editDialog = page.getByRole('dialog', { name: 'Update Patrol Radio 12' });
  await expect(editDialog.getByLabel('Type')).toBeDisabled();
  await editDialog.getByLabel('Status').selectOption('maintenance');
  await editDialog.getByRole('button', { name: 'Confirm update' }).click();

  await expect(page.getByRole('status')).toContainText('Patrol Radio 12 updated with an audit receipt.');
  await expect(page.getByRole('cell', { name: 'maintenance' })).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('people and HR decisions are governed and operational', async ({ page }) => {
  const errors = monitorBrowserErrors(page); await signInAsAdmin(page, '/admin/people-hr');
  await expect(page.getByRole('heading', { name: 'People, pay & HR' })).toBeVisible();
  await expect(page.getByText('Ana Ngata', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Prepare someone to work' })).toBeVisible();
  await expect(page).toHaveScreenshot('hr-staff-overview.png');
  await expect(page.getByText('These lists change the rules used by onboarding and rostering.')).toBeHidden();
  await expect(page.getByRole('row', { name: /Ana Ngata/ })).toContainText('Work ready');
  await expect(page.getByRole('row', { name: /Jordan Lee/ })).toContainText('Not work ready');
  await page.getByRole('searchbox', { name: 'Search staff' }).fill('Jordan');
  await expect(page.getByRole('row', { name: /Ana Ngata/ })).toHaveCount(0);
  await expect(page.getByRole('row', { name: /Jordan Lee/ })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search staff' }).fill('');
  const staffProfile = await openStaffProfile(page);
  await expect(staffProfile.getByRole('heading', { name: 'Ana Ngata' })).toBeVisible();
  await staffProfile.getByRole('button', { name: 'Remove work readiness' }).click();
  const readinessDialog = staffProfile.getByRole('dialog', { name: 'Remove work readiness?' });
  await expect(readinessDialog.getByRole('button', { name: 'Confirm readiness' })).toBeDisabled();
  await readinessDialog.getByLabel('Readiness review notes').fill('Temporary restriction pending refresher training review.');
  await readinessDialog.getByRole('button', { name: 'Confirm readiness' }).click();
  await expect(staffProfile.getByText('Ana Ngata readiness updated and audited.')).toBeVisible();

  await page.goto('/admin/people-hr');
  await page.getByRole('button', { name: 'HR', exact: true }).click();
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

  await page.goto('/admin/roster');
  await page.getByRole('navigation', { name: 'Roster sections' }).getByRole('button', { name: 'Shift setup & open shifts' }).click();
  await expect(page.getByRole('heading', { name: 'Shift setup & open shifts' })).toBeVisible();
  await page.locator('.roster-hr-tab-list').getByRole('button', { name: 'Open Shifts', exact: true }).click();
  await page.getByRole('button', { name: '+ New Coverage Request' }).click();
  await page.getByLabel('Date').fill('2026-09-20'); await page.getByLabel('Required Staff').fill('3');
  await page.getByLabel('Start Time').fill('18:00'); await page.getByLabel('End Time').fill('23:00');
  await page.getByLabel('Urgency').selectOption('urgent'); await page.getByLabel('Notes').fill('Festival perimeter coverage');
  await page.getByRole('button', { name: 'Create Request' }).click();
  await expect(page.getByText('Requires 3 staff')).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('administrator finalizes an officer coverage claim into roster ownership', async ({ page }) => {
  // Legacy deep link: an old ?tab= rostering link still lands in the shift-setup view.
  const errors=monitorBrowserErrors(page);await signInAsAdmin(page,'/admin/people-hr?tab=coverage');
  await expect(page.getByRole('navigation',{name:'Roster sections'}).getByRole('button',{name:'Shift setup & open shifts'})).toHaveAttribute('aria-current','page');
  await expect(page.locator('.roster-hr-tab-list').getByRole('button',{name:'Open Shifts', exact:true})).toHaveClass(/btn-primary/);
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
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: '38383838-3838-4838-8838-383838383838', staff_id: '22222222-2222-4222-8222-222222222222', period_start: '2026-08-17', period_end: '2026-08-23', scheduled_hours: 40, actual_hours: 39, overtime_hours: 0, work_derived_hours: 39, adjustment_hours: 0, work_summary: { source_count: 4 }, status: 'submitted', branch_review_notes: null, branch_reviewed_by: null, submitted_at: '2026-08-23T21:30:00Z' }]) });
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
  // 21:30 UTC on 23 Aug is 09:30 on 24 Aug in New Zealand standard time.
  await expect(page.locator('.hr-timesheet-submitted')).toContainText(/Submitted 24 Aug.*9:30/);
  await page.getByRole('button', { name: 'Edit hours' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit timesheet hours' });
  await dialog.getByLabel('Actual hours').fill('40');
  await dialog.getByLabel('Correction reason').fill('Corrected after comparing the signed attendance record.');
  await dialog.getByRole('button', { name: 'Save correction' }).click();
  await expect(page.locator('.roster-hr-page .alert-success')).toContainText('Timesheet hours corrected and returned to submitted review.');
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
  await page.getByRole('button', { name: 'HR', exact: true }).click();
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
  await expect(page.getByRole('status')).toContainText('Tama Rangi hired. Their login and staff record are ready for profile-based onboarding.');
  expect(calls).toEqual(['manage', 'create-user', 'convert']);
});

test('onboarding shows each person as a searchable single row with the next required action', async ({ page }) => {
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/rest/v1/rpc/get_staff_onboarding_readiness', async (route) => await route.fulfill(json([{ ledger_id: '81818181-8181-4181-8181-818181818181', staff_id: '22222222-2222-4222-8222-222222222222', user_id: '22222222-2222-4222-8222-222222222222', display_name: 'Ana Ngata', current_stage: 'evidence', status: 'in_progress', version: 3, target_start: '2026-09-07', identity_status: 'complete', employment_status: 'complete', evidence_status: 'complete', supervision_status: 'blocked', induction_status: 'blocked', work_status: 'blocked', blockers: ['Assign a line manager'], next_action: 'Assign line manager' }])));
  await page.route('**/rest/v1/rpc/manage_staff_onboarding', async (route) => { const payload = JSON.parse(route.request().postData() ?? '{}'); expect(payload.p_action).toBe('advance'); expect(payload.p_stage).toBe('supervision'); expect(payload.p_expected_version).toBe(3); await route.fulfill(json([{ ledger_id: payload.p_ledger_id, current_stage: 'supervision', status: 'in_progress', version: 4 }])); });
  await signInAsAdmin(page, '/admin/people-hr');
  await page.getByRole('button', { name: 'Prepare someone to work' }).click();
  const row = page.getByRole('row', { name: /Ana Ngata/ });
  await expect(row).toContainText('Evidence');
  await expect(row).toContainText('In progress');
  await expect(row).toContainText('Assign a line manager');
  await expect(row.getByRole('button', { name: 'Continue to Supervision' })).toBeVisible();
  await expect(row).toHaveScreenshot('hr-onboarding-list-row.png');
  await page.getByLabel('Search onboarding').fill('line manager');
  await expect(row).toBeVisible();
  await page.getByLabel('Search onboarding').fill('no matching person');
  await expect(row).toBeHidden();
  await page.getByLabel('Search onboarding').fill('');
  await row.getByRole('button', { name: 'Continue to Supervision' }).click();
  const dialog = page.getByRole('dialog', { name: 'Move to Supervision?' });
  await expect(dialog.getByText(/Needs: A line manager assigned/)).toBeVisible();
  await dialog.getByLabel('Stage note').fill('Evidence pack checked against the record.');
  await dialog.getByRole('button', { name: 'Advance step' }).click();
  await expect(dialog).toBeHidden();
});

test('a first credential is recorded and verified from the onboarding row through the governed RPC', async ({ page }) => {
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/rest/v1/rpc/get_staff_onboarding_readiness', async (route) => await route.fulfill(json([{ ledger_id: '81818181-8181-4181-8181-818181818181', staff_id: '22222222-2222-4222-8222-222222222222', user_id: '22222222-2222-4222-8222-222222222222', display_name: 'Ana Ngata', current_stage: 'evidence', status: 'in_progress', version: 3, target_start: null, identity_status: 'complete', employment_status: 'complete', evidence_status: 'blocked', supervision_status: 'blocked', induction_status: 'blocked', work_status: 'blocked', blockers: ['No verified current credential'], next_action: 'Verify credential' }])));
  let payload: Record<string, unknown> | null = null;
  await page.route('**/rest/v1/rpc/record_staff_credential', async (route) => { const body = JSON.parse(route.request().postData() ?? '{}'); payload = body; await route.fulfill(json([{ credential_id: '91919191-9191-4191-8191-919191919191', staff_id: body.p_staff_id, verified: true, verified_at: '2026-08-30T10:00:00.000Z', created: true }])); });
  await signInAsAdmin(page, '/admin/people-hr');
  await page.getByRole('button', { name: 'Prepare someone to work' }).click();
  const row = page.getByRole('row', { name: /Ana Ngata/ });
  await row.getByRole('button', { name: 'Verify credential' }).click();
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

test('onboarding guides HR through employment setup as one audited step', async ({ page }) => {
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  let saved: Record<string, unknown> | null = null;
  await page.route('**/rest/v1/staff_profiles*', async (route) => await route.fulfill(json([
    { id: '22222222-2222-4222-8222-222222222222', user_id: '22222222-2222-4222-8222-222222222222', employment_type: null, start_date: null, end_date: null, work_ready: false, role_code: null },
  ])));
  await page.route('**/rest/v1/reference_codes*', async (route) => await route.fulfill(json([{ id: '91919191-9191-4191-8191-919191919192', code: 'FIELD_SECURITY', name: 'Field security officer' }])));
  await page.route('**/rest/v1/rpc/get_staff_onboarding_readiness', async (route) => await route.fulfill(json([{ ledger_id: '81818181-8181-4181-8181-818181818181', staff_id: '22222222-2222-4222-8222-222222222222', user_id: '22222222-2222-4222-8222-222222222222', display_name: 'Ana Ngata', current_stage: 'employment', status: 'in_progress', version: 2, target_start: null, identity_status: 'complete', employment_status: 'blocked', evidence_status: 'blocked', supervision_status: 'blocked', induction_status: 'blocked', work_status: 'blocked', blockers: ['Select an employment type', 'Set a current employment start date', 'Assign a payroll role'], next_action: 'Complete employment setup' }])));
  await page.route('**/rest/v1/rpc/set_staff_employment_setup', async (route) => {
    saved = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill(json([{ id: '22222222-2222-4222-8222-222222222222', employment_type: 'permanent', start_date: '2026-09-14', role_code: 'FIELD_SECURITY' }]));
  });

  await signInAsAdmin(page, '/admin/people-hr');
  await page.getByRole('button', { name: 'Prepare someone to work' }).click();
  const row = page.getByRole('row', { name: /Ana Ngata/ });
  await row.getByRole('button', { name: 'Complete employment setup' }).click();
  const dialog = page.getByRole('dialog', { name: 'Complete employment setup' });
  await dialog.getByLabel('Employment type').selectOption('permanent');
  await dialog.getByLabel('Payroll role').selectOption('FIELD_SECURITY');
  await dialog.getByLabel('Start date').fill('2026-09-14');
  await dialog.getByLabel('Reason for setup').fill('Signed employment details checked by HR.');
  await dialog.getByRole('button', { name: 'Save employment setup' }).click();
  await expect(page.getByRole('status')).toContainText('Ana Ngata employment setup saved. Continue with the next onboarding requirement.');
  expect(saved).toMatchObject({
    p_staff_id: '22222222-2222-4222-8222-222222222222',
    p_expected_employment_type: null,
    p_expected_start_date: null,
    p_expected_role_code: null,
    p_employment_type: 'permanent',
    p_start_date: '2026-09-14',
    p_role_code: 'FIELD_SECURITY',
    p_reason: 'Signed employment details checked by HR.',
  });
});

test('HR can mark an applicant not suitable with an audited job-related reason', async ({ page }) => {
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  let decision: Record<string, unknown> | null = null;
  await page.route('**/rest/v1/recruitment_vacancies**', async (route) => await route.fulfill(json([{ id: '71717171-7171-4171-8171-717171717171', title: 'Patrol officer – Nelson', employment_type: 'permanent', location_summary: 'Nelson', status: 'open', opens_on: null, closes_on: null }])));
  await page.route('**/rest/v1/recruitment_candidates**', async (route) => await route.fulfill(json([{ id: '72727272-7272-4272-8272-727272727272', vacancy_id: '71717171-7171-4171-8171-717171717171', first_name: 'Tama', last_name: 'Rangi', email: 'tama@fcm.test', stage: 'screening', status: 'active', offer_role: null, offer_employment_type: null, offer_start_date: null }])));
  await page.route('**/rest/v1/rpc/manage_recruitment_candidate', async (route) => {
    decision = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill(json([{ id: '72727272-7272-4272-8272-727272727272', stage: 'declined', status: 'declined' }]));
  });

  await signInAsAdmin(page, '/admin/people-hr');
  await page.getByRole('button', { name: 'HR', exact: true }).click();
  await page.getByRole('button', { name: 'Recruitment', exact: true }).click();
  const card = page.locator('.contact-card', { has: page.getByRole('heading', { name: 'Tama Rangi' }) });
  await card.getByRole('button', { name: 'Mark as not suitable' }).click();
  const dialog = page.getByRole('dialog', { name: 'Mark as not suitable' });
  await expect(dialog.getByText(/factual, job-related reason/)).toBeVisible();
  await expect(dialog.getByText(/does not email the candidate/)).toBeVisible();
  await dialog.getByLabel('Job-related reason').fill('Required licence could not be verified by the closing date.');
  await dialog.getByRole('button', { name: 'Decline candidate' }).click();
  await expect(page.getByRole('status')).toContainText('Candidate marked as not suitable and declined.');
  expect(decision).toMatchObject({
    p_candidate_id: '72727272-7272-4272-8272-727272727272',
    p_expected_stage: 'screening',
    p_next_stage: 'declined',
    p_note: 'Required licence could not be verified by the closing date.',
  });
});

test('administrator sets the rest and hours rules the roster enforces, in plain words', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  let saved: Record<string, unknown> | null = null;
  await page.route('**/rest/v1/rpc/manage_organization_fatigue_rules', async (route) => {
    const payload = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>; saved = payload;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ organization_id: payload.p_organization_id, min_rest_hours_between_shifts: payload.p_min_rest_hours_between_shifts, max_hours_per_week: payload.p_max_hours_per_week, max_consecutive_days: payload.p_max_consecutive_days, enforced: payload.p_enforced, updated_at: '2026-08-30T09:31:00.000Z' }) });
  });

  await signInAsAdmin(page, '/admin/people-hr?section=rostering');
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
