import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Normalised to LF: assertions below embed literal '\n' for multi-line patterns, but git on
// Windows checks these files out as CRLF - an exact substring match would otherwise fail even
// when every individual token it checks for is genuinely present.
const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');
const page = read('src/pages/RosterHRPage.tsx');
const staffProfilePage = read('src/pages/StaffProfilePage.tsx');
const credentialSql = read('../../supabase/migrations/20260901002000_govern_staff_credential_renewal.sql');

describe('governed HR administration', () => {
  it('retries payroll receipts with the same scoped request and describes the actual batch-only action', () => {
    expect(page).toContain('JSON.stringify([profile.id, organizationId, payrollExport.from, payrollExport.to, \'csv\'])');
    expect(page).toContain('p_client_request_id: payrollExportAttempt.current.id');
    expect(page).toContain('payrollScope.current !== scope');
    expect(page).toContain('Number.isInteger(receipt.timesheet_count)');
    expect(page).toContain('Number.isFinite(Number(receipt.total_hours))');
    expect(page).toContain('Retry the same dates to recover any saved batch receipt.');
    expect(page).toContain('This records the batch and downloads its CSV. Payment and IRD submission are not available here.');
  });
  it('shares inline reconciliation without granting payroll authority or inventing receipts', () => {
    expect(page).toContain('export const RosterTimesheetPanel');
    expect(page).toContain('const TimesheetRows');
    expect(page).toContain('item.period_start <= to && item.period_end >= from');
    expect(page).toContain("scoped.filter((item) => item.status === 'submitted').length");
    expect(page).toContain('onPendingCount(null)');
    expect(page).toContain('p_expected_status: decision.item.status');
    expect(page).toContain('confirmed?.id !== decision.item.id || confirmed?.status !== decision.action');
    expect(page).toContain('corporateReviewer={false}');
    expect(page).toContain('no payment made');
    expect(page).toContain('hr-workbench-scroll');
  });
  it('matches live roster schema and branch context', () => {
    expect(page).toContain(".select('id, user_id, employment_type, start_date, end_date, work_ready, role_code')");
    expect(page).toContain('operatingOrganizationId\n            ? supabase.rpc');
    expect(page).toContain('role_code: staffProfileById.get(p.id)?.role_code ?? null');
  });

  it('splits shift setup from staff, pay and HR without removing payroll access', () => {
    expect(page).toContain("type RosterTabGroup = 'workforce' | 'people' | 'rostering' | 'pay-assets'");
    expect(page).toContain("{ id: 'workforce', label: 'Staff'");
    expect(page).toContain("{ id: 'people', label: 'HR'");
    expect(page).toContain("{ id: 'rostering', label: 'Rostering'");
    expect(page).toContain("{ id: 'pay-assets', label: 'Pay & Assets'");
    expect(page).toContain("{ id: 'pay-review', label: 'Pay Review' }");
    expect(page).toContain(".filter((group) => (group.id === 'rostering') === rosteringView)");
    expect(page).toContain("const initialTab = requestedTab && viewTabs.has(requestedTab) ? requestedTab : visibleTabGroups[0]?.tabs[0] ?? 'staff';");
  });

  it('uses server-owned leave and timesheet decisions', () => {
    expect(page).toContain("supabase.rpc('review_leave_request'");
    expect(page).toContain("supabase.rpc('review_branch_timesheet'");
    expect(page).toContain("supabase.rpc('review_timesheet'");
    expect(page).not.toContain(".from('leave_requests').update");
    expect(page).not.toContain(".from('timesheets').update");
  });

  it('shows corporate payroll every branch\'s timesheets at organisation level, and the branch queue only in a branch', () => {
    expect(page).toContain("const workingInBranch = Boolean(operatingOrganizationId && operatingOrganizationId !== profile?.organizationId);");
    expect(page).toContain("workingInBranch\n            ? supabase.rpc('get_branch_timesheet_queue', { p_operating_organization_id: operatingBranchId })");
    expect(page).toContain(".from('timesheets').select('id, staff_id, period_start, period_end, scheduled_hours, actual_hours, overtime_hours, work_derived_hours, adjustment_hours, work_summary, status, branch_review_notes, branch_reviewed_by, submitted_at, revision, pay_code_override, hourly_rate_override, pay_override_reason').eq('organization_id', orgId)");
    expect(page).toContain("{workingInBranch ? 'Branch timesheets' : 'Timesheets across branches'}");
  });

  it('shows reviewers when each timesheet was submitted from both queues', () => {
    const queueMigration = read('../../supabase/migrations/20261103100000_branch_timesheet_queue_submitted_at.sql');
    expect(queueMigration).toContain('branch_reviewed_by uuid, submitted_at timestamp with time zone)');
    expect(queueMigration).toContain('t.branch_reviewed_by,t.submitted_at from public.timesheets t');
    expect(queueMigration).toContain("'timesheet_local_review'");
    expect(queueMigration).toContain('REVOKE ALL ON FUNCTION public.get_branch_timesheet_queue(uuid) FROM PUBLIC, anon;');
    expect(queueMigration).toContain('GRANT EXECUTE ON FUNCTION public.get_branch_timesheet_queue(uuid) TO authenticated, service_role;');
    expect(page).toContain('{item.submitted_at && <small className="hr-timesheet-submitted">{submittedWords(item.submitted_at)}</small>}');
  });

  it('surfaces generated dispatch pay evidence without directly mutating financial lines', () => {
    expect(page).toContain(".from('dispatch_job_pay_lines')");
    expect(page).toContain("{ id: 'pay-review', label: 'Pay Review' }");
    expect(page).toContain("line.pay_code === 'UNRESOLVED'");
    expect(page).toContain("useState<'exceptions' | 'resolved' | 'all'>('exceptions')");
    expect(page).toContain('Needs review (');
    expect(page).toContain('Resolved pay');
    expect(page).toContain(".from('dispatch_job_pay_line_reviews')");
    expect(page).toContain("supabase.rpc('review_dispatch_job_pay_line'");
    expect(page).toContain('Reject for correction');
    expect(page).toContain('Evidence remains read-only until then.');
    expect(page).toContain('Resolve exceptions before approving related timesheets');
    expect(page).toContain('Timesheet branch check recorded for corporate payroll approval.');
    expect(page).not.toMatch(/from\('dispatch_job_pay_lines'\)[\s\S]{0,220}\.(insert|update|upsert|delete)\(/);
  });

  it('loads callout pay evidence through the server-owned summary RPC', () => {
    expect(page).toContain("supabase.rpc('get_callout_pay_summary'");
    expect(page).toContain('calloutPaySummaries');
    expect(page).toContain('summary?.minimum_applied');
    expect(page).not.toContain('Math.max(worked, Number(c.minimum_pay_hours))');
  });

  it('opens callouts and advances milestones through expected-state RPCs', () => {
    expect(page).toContain("supabase.rpc('open_callout'");
    expect(page).toContain('p_client_request_id: crypto.randomUUID()');
    expect(page).toContain("supabase.rpc('record_callout_milestone'");
    expect(page).toContain('p_expected_status: callout.status');
    expect(page).not.toMatch(/from\('callout_shifts'\)[\s\S]{0,220}\.(insert|update|upsert|delete)\(/);
  });

  it('creates on-call periods through the admin-owned idempotent RPC', () => {
    expect(page).toContain("supabase.rpc('create_on_call_period'");
    expect(page).toContain('p_client_request_id: crypto.randomUUID()');
    expect(page).toContain('Create on-call period');
    expect(page).not.toMatch(/from\('on_call_periods'\)[\s\S]{0,220}\.(insert|update|upsert|delete)\(/);
  });

  it('schedules court appearances through the idempotent roster RPC', () => {
    expect(page).toContain("supabase.rpc('schedule_court_appearance'");
    expect(page).toContain('p_client_request_id: courtRequestId.current');
    expect(page).toContain('courtRequestId.current = crypto.randomUUID()');
    expect(page).toContain('marked as overtime');
    expect(page).not.toMatch(/from\('court_appearances'\)[\s\S]{0,220}\.(insert|update|upsert|delete)\(/);
  });

  it('records court outcomes through the expected-state RPC', () => {
    expect(page).toContain("supabase.rpc('record_court_appearance_outcome'");
    expect(page).toContain('p_expected_status: courtOutcome.appearance.status');
    expect(page).toContain("courtOutcome.status === 'attended'");
    expect(page).toContain('end time must be after its start time');
    expect(page).toContain('The saved outcome becomes roster, overtime and audit evidence.');
  });

  it('governs the fleet register before officer sign-out', () => {
    expect(page).toContain("from('assets').select('id,asset_type,name,serial_number,registration,make,model,year,status,assigned_to,last_inspection_date,next_inspection_date,notes,updated_at')");
    expect(page).toContain("supabase.rpc('manage_asset'");
    expect(page).toContain('p_client_request_id: assetDraft.requestId');
    expect(page).toContain('p_expected_updated_at: assetDraft.expectedUpdatedAt');
    expect(page).toContain('Keep current register');
    expect(page).toContain('This creates the accountable register record. It does not assign the asset to a person or shift.');
    expect(page).toContain('Add the first asset before an officer can sign it out to a shift.');
    expect(page).not.toMatch(/from\('assets'\)[\s\S]{0,300}\.(insert|update|upsert|delete)\(/);
  });

  it('uses governed coverage creation and reasoned review', () => {
    expect(page).toContain("supabase.rpc('create_shift_coverage_request'");
    expect(page).not.toContain(".from('shift_coverage_requests').insert");
    expect(page).toContain('Review notes');
    expect(page).toContain('p_expected_status: currentStatus');
  });

  it('finalizes claimed coverage into roster ownership through one governed RPC', () => {
    expect(page).toContain(".in('status', ['open', 'claimed'])");
    expect(page).toContain("supabase.rpc('finalize_shift_coverage'");
    expect(page).toContain('Finalize assignment');
    expect(page).toContain('Select work unit');
    expect(page).not.toMatch(/from\('(shift_coverage_requests|roster_slots|shifts)'\)[\s\S]{0,220}\.(insert|update|upsert)\(/);
  });

  it('loads derived readiness and changes it only through the governed RPC', () => {
    expect(page).toContain("supabase.rpc('get_staff_readiness_assessment'");
    expect(page).toContain("supabase.rpc('set_staff_work_readiness'");
    expect(page).toContain('Readiness review notes');
    expect(page).not.toContain(".from('staff_profiles').update");
  });

  it('saves staff payroll roles as part of governed employment setup', () => {
    expect(page).toContain(".from('reference_codes')");
    expect(page).toContain(".eq('code_type', 'role_code')");
    expect(staffProfilePage).toContain("supabase.rpc('set_staff_employment_setup'");
    expect(staffProfilePage).toContain('Save employment details');
    expect(page).toContain("supabase.rpc('manage_pay_role_code'");
    expect(page).toContain('Create payroll role code');
    expect(page).toContain('Add its pay rule for each branch');
    expect(page).not.toContain(".from('staff_profiles').update");
    expect(page).not.toContain(".from('reference_codes').insert");
  });

  it('uses a searchable one-row staff directory and in-shell profile route', () => {
    expect(page).toContain('type="search"');
    expect(page).toContain('filteredStaff');
    expect(page).toContain('staffAttention');
    expect(page).toContain('hr-attention-');
    expect(page).toContain('Open profile ↗');
    expect(page).toContain("const params = new URLSearchParams({ profile: person.staff_id, profileTab })");
    expect(page).toContain("navigate({ pathname: staffProfileHref, search: params.toString() })");
    expect(page).not.toContain("url.searchParams.set('popout', '1')");
    expect(page).not.toContain('window.open(url.toString(), `fcm-staff-profile-${person.staff_id}`');
    expect(staffProfilePage).toContain("{ id: 'credentials', label: 'Credentials' }");
    expect(staffProfilePage).toContain("{ id: 'skills-training', label: 'Skills & training' }");
    expect(staffProfilePage).toContain("{ id: 'health-safety', label: 'H&S' }");
    expect(staffProfilePage).toContain("next.set('recordKind', kind)");
    expect(staffProfilePage).not.toContain('detailWindow.opener = null');
  });

  it('uses the searchable onboarding row and schema-backed profile read paths', () => {
    expect(page).toContain('Search onboarding');
    expect(page).toContain('filteredOnboardingPeople');
    expect(page).toContain("openStaffProfile(person, 'onboarding')");
    expect(staffProfilePage).toContain("{ id: 'onboarding', label: 'Onboarding' }");
    expect(staffProfilePage).toContain("supabase.rpc('get_staff_onboarding_readiness'");
    expect(staffProfilePage).toContain("status,created_at').eq('staff_id', staff.id)");
    expect(staffProfilePage).not.toContain("status,updated_at').eq('staff_id', staff.id)");
  });

  it('provisions accepted candidates with employer-owned employment and a branch authorization', () => {
    expect(page).toContain('employer_organization_id: profile.employerOrganizationId ?? profile.organizationId');
    expect(page).toContain('branch_authorisations: [{ branch_org_id: branchOrganizationId');
    expect(page).toContain('const branchOrganizationId = offerAction.branchId;');
  });

  it('hires only into an active delivery branch and keeps provisioning failures visible in the dialog', () => {
    expect(page).toMatch(/hireDialogOpen[\s\S]{0,400}\.eq\('organization_type', 'branch'\)\.eq\('active', true\)/);
    expect(page).toContain('Delivery branch');
    expect(page).toContain("setOfferError('Choose the delivery branch they will be rostered at.')");
    expect(page).toContain('provisionError.context instanceof Response');
    expect(page).toContain('{offerError && <p className="hr-review-error" role="alert">{offerError}</p>}');
    expect(page).not.toContain('const branchOrganizationId = operatingOrganizationId ?? profile.organizationId;');
  });

  it('records credential renewals through a governed, race-checked RPC', () => {
    expect(page).toContain("supabase.rpc('renew_staff_credential'");
    expect(page).toContain('p_expected_expiry_date: credentialRenewal.source.expiry_date');
    expect(page).toContain('Record renewal');
    expect(page).toContain('renewal recorded and verified');
    expect(page).not.toMatch(/from\('staff_credentials'\)[\s\S]{0,220}\.(insert|update|upsert)\(/);
  });

  it('loads site induction requirements and records completions through governed RPCs', () => {
    expect(page).toContain("from('site_induction_requirements')");
    expect(page).toContain("from('staff_site_inductions')");
    expect(page).toContain("supabase.rpc('manage_site_induction_requirement'");
    expect(page).toContain("supabase.rpc('record_staff_site_induction'");
    expect(page).toContain('Record site induction');
    expect(page).toContain('siteInductionDraft');
    expect(page).toContain('siteRequirementId');
    expect(page).toContain('siteInductionRequirements.map((requirement) =>');
    expect(page).toContain('Select site induction requirement');
    expect(page).toContain("(evidenceAction.action === 'record_induction' && !evidenceAction.siteRequirementId)");
    expect(page).not.toMatch(/from\('(site_induction_requirements|staff_site_inductions)'\)[\s\S]{0,220}\.(insert|update|upsert|delete)\(/);
  });

  it('reads agreement-location induction state through the governed RPC', () => {
    expect(page).toContain("supabase.rpc('get_site_induction_state'");
    expect(page).toContain('p_staff_id: evidenceAction.staffId');
    expect(page).toContain('p_service_agreement_location_id: requirement.service_agreement_location_id');
  });

  it('appends retry-safe credential lineage and closes direct mutations', () => {
    for (const evidence of ['for update', 'is_admin_for_org', 'is distinct from p_expected_expiry_date', 'replaces_credential_id', 'client_request_id', 'pg_advisory_xact_lock', "'staff_credential_renewed'"]) expect(credentialSql).toContain(evidence);
    expect(credentialSql).toContain('revoke insert,update,delete on table public.staff_credentials from authenticated');
    expect(credentialSql).toContain('from public,anon;');
  });
});