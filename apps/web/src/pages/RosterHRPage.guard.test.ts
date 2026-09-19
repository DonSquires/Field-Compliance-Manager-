import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/RosterHRPage.tsx'), 'utf8');
const credentialSql = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260901002000_govern_staff_credential_renewal.sql'), 'utf8');

describe('governed HR administration', () => {
  it('matches live roster schema and branch context', () => {
    expect(page).not.toContain('work_ready, role_code');
    expect(page).toContain('operatingOrganizationId\n            ? supabase.rpc');
    expect(page).toContain('role_code: null');
  });

  it('groups the full Roster HR workspace without removing payroll access', () => {
    expect(page).toContain("type RosterTabGroup = 'workforce' | 'people' | 'rostering' | 'pay-assets'");
    expect(page).toContain("{ id: 'workforce', label: 'Workforce'");
    expect(page).toContain("{ id: 'people', label: 'People'");
    expect(page).toContain("{ id: 'rostering', label: 'Rostering'");
    expect(page).toContain("{ id: 'pay-assets', label: 'Pay & Assets'");
    expect(page).toContain("{ id: 'pay-review', label: 'Pay Review' }");
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
    expect(page).toContain(".from('timesheets').select('id, staff_id, period_start, period_end, scheduled_hours, actual_hours, overtime_hours, work_derived_hours, adjustment_hours, work_summary, status, branch_review_notes, branch_reviewed_by').eq('organization_id', orgId)");
    expect(page).toContain("{workingInBranch ? 'Branch timesheets' : 'Timesheets across branches'}");
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

  it('assigns staff payroll roles from active reference codes through the governed RPC', () => {
    expect(page).toContain(".from('reference_codes')");
    expect(page).toContain(".eq('code_type', 'role_code')");
    expect(page).toContain("supabase.rpc('set_staff_pay_role_code'");
    expect(page).toContain('Save payroll role');
    expect(page).not.toContain(".from('staff_profiles').update");
  });

  it('provisions accepted candidates with employer-owned employment and a branch authorization', () => {
    expect(page).toContain('employer_organization_id: profile.employerOrganizationId ?? profile.organizationId');
    expect(page).toContain('branch_authorisations: [{ branch_org_id: branchOrganizationId');
    expect(page).toContain('operatingOrganizationId ?? profile.organizationId');
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