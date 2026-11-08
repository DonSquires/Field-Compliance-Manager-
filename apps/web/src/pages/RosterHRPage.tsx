/**
 * RosterHRPage.tsx
 *
 * Canonical schema: user_profiles (identity/role) + staff_profiles (employment
 * detail, 1:1 via id) + staff_credentials (licences/warrants, expiry) +
 * shift_templates (recurring coverage patterns) + leave_requests (approval
 * queue) + timesheets (hours, approval, payroll export).
 */

import { isAdminTierRole } from '../lib/roles';
import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useHref, useLocation, useNavigate } from 'react-router-dom';
import { ROSTERING_HR_TABS, isRosteringHrView } from '../lib/workforceSections';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { plainWords, submittedWords } from '../lib/rosterWords';
import { timesheetSummaryMismatchReasons } from '../lib/timesheetTolerances';
import { useWorkforceScope } from '../lib/workforceScope';
import { RosterRulesPanel } from '../components/RosterRulesPanel';
import { CREDENTIAL_TYPES, credentialExpiryState, credentialExpiryWords, credentialTypeLabel } from '../lib/credentialWords';
import './PageStyles.css';
import './RosterHRPage.css';

const PAY_LINE_REVIEW_TABLE_DEPLOYED = true;

type RosterTab = 'staff' | 'recruitment' | 'onboarding' | 'performance' | 'cases' | 'credentials' | 'shift-templates' | 'coverage' | 'leave' | 'timesheets' | 'pay-review' | 'assets' | 'oncall' | 'court' | 'roster-rules';
type RosterTabGroup = 'workforce' | 'people' | 'rostering' | 'pay-assets';

interface StaffRow {
  id: string;
  staff_id: string | null;
  display_name: string | null;
  role: string;
  email: string | null;
  phone: string | null;
  employment_type: string | null;
  start_date: string | null;
  end_date: string | null;
  work_ready: boolean | null;
  role_code: string | null;
}

interface RoleCodeRow { id?: string; code: string; name: string; }

interface ReadinessAssessment { staff_id: string; user_id: string | null; work_ready: boolean; identity_status: string; employment_status: string; credential_status: string; training_status: string; blockers: string[]; }
interface CatalogSkill { id: string; skill_name: string; skill_category: string; active: boolean; }
interface SiteInductionRequirementRow {
  id: string;
  organization_id: string;
  client_site_id: string | null;
  zone_id: string | null;
  service_agreement_location_id: string | null;
  induction_name: string;
  version: string | null;
  required: boolean;
  expires_after_days: number | null;
  active: boolean;
}
interface StaffSiteInductionRow {
  id: string;
  requirement_id: string;
  staff_id: string;
  completed_at: string;
  expires_at: string | null;
  evidence_notes: string | null;
}
interface SiteInductionStateRow {
  requirement_id: string;
  induction_name: string;
  required: boolean;
  completed: boolean;
  expires_at: string | null;
}
interface CredentialRow {
  id: string;
  staff_id: string;
  credential_type: string;
  credential_number: string | null;
  issuing_authority: string | null;
  issued_date: string | null;
  expiry_date: string | null;
  verified: boolean;
}

interface StaffDocumentRow { id: string; staff_id: string; document_type: string; file_name: string; file_size_bytes: number | null; mime_type: string | null; notes: string | null; expiry_date: string | null; uploaded_at: string | null; }
interface StaffTrainingRow { id: string; staff_id: string | null; officer_id: string | null; training_name: string; training_type: string; provider: string | null; completed_date: string; expiry_date: string | null; passed: boolean | null; score: number | null; notes: string | null; }
interface StaffSkillRow { id: string; staff_id: string; skill_id: string | null; skill_name: string; skill_category: string | null; proficiency_level: string | null; certified: boolean; certification_expiry: string | null; notes: string | null; updated_at: string | null; }

interface ShiftTemplateRow {
  id: string;
  name: string;
  shift_type: string;
  start_time: string;
  end_time: string;
  recurrence_type: string;
  required_staff_count: number;
  is_active: boolean;
}

interface LeaveRequestRow {
  id: string;
  staff_id: string;
  leave_type: string;
  starts_on: string;
  ends_on: string;
  status: string;
  reason: string | null;
  branch_review_notes?: string | null;
  branch_reviewed_by?: string | null;
}

interface CoverageRequestRow {
  id: string;
  shift_date: string;
  start_time: string;
  end_time: string;
  required_staff_count: number;
  urgency: string;
  status: string;
  notes: string | null;
  site_name: string | null;
  claimed_by: string | null;
  roster_slot_id: string | null;
}
interface CoverageWorkUnit { id:string;name:string;work_unit_type:string; }
interface ShiftSwapRow { id: string; original_shift_id: string; original_staff_id: string; swap_with_staff_id: string | null; swap_type: string; reason: string | null; status: string; requested_by: string; requested_at: string; }

interface TimesheetRow {
  id: string;
  staff_id: string;
  period_start: string;
  period_end: string;
  scheduled_hours: number | null;
  actual_hours: number | null;
  overtime_hours: number;
  work_derived_hours: number | null;
  adjustment_hours: number;
  work_summary: { source_count?: number; evidence_kind?: string; manual_sources?: { source_type: string; source_id: string; shift_id: string | null; reason: string }[] } | null;
  revision?: number;
  pay_code_override?: string | null;
  hourly_rate_override?: number | null;
  pay_override_reason?: string | null;
  status: string;
  branch_review_notes?: string | null;
  branch_reviewed_by?: string | null;
  submitted_at?: string | null;
}

interface ScheduledTimesheetSource {
  source_type: 'roster_slot' | 'shift';
  source_id: string;
  shift_id: string | null;
  scheduled_start: string;
  scheduled_end: string;
  source_version: string;
  planned_break_minutes: number;
  break_unpaid: boolean;
}
interface ScheduledTimesheetDraft extends ScheduledTimesheetSource {
  selected: boolean;
  reviewedStart: string;
  reviewedEnd: string;
  unpaidBreak: string;
}
interface TimesheetBreakEvidence {
  shift_id: string;
  planned_minutes: number;
  taken_minutes: number;
  unpaid: boolean;
  review_status: string;
}
const localDateTimeInput = (iso: string) => {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

interface DispatchPayLineRow {
  id: string;
  source_dispatch_id: string;
  officer_user_id: string | null;
  rate_rule_id: string | null;
  pay_code: string | null;
  rate_type: string;
  description: string;
  quantity: number;
  unit_rate: number;
  line_total: number;
  distance_km: number | null;
  distance_reason: string | null;
  created_at: string;
}

interface DispatchPayLineReviewRow {
  id: string;
  pay_line_id: string;
  decision: 'approved' | 'rejected';
  review_notes: string | null;
  reviewed_at: string;
  supersedes_review_id: string | null;
}

interface StaffOnboardingRow {
  ledger_id: string;
  staff_id: string;
  user_id: string;
  display_name: string;
  current_stage: string;
  status: string;
  version: number;
  target_start: string | null;
  identity_status: string;
  employment_status: string;
  evidence_status: string;
  supervision_status: string;
  induction_status: string;
  work_status: string;
  blockers: string[];
  next_action: string;
}

interface RecruitmentVacancy {
  id: string;
  title: string;
  employment_type: string;
  location_summary: string | null;
  status: string;
  opens_on: string | null;
  closes_on: string | null;
}

interface RecruitmentCandidate {
  id: string;
  vacancy_id: string;
  first_name: string;
  last_name: string;
  email: string;
  stage: string;
  status: string;
  offer_role: string | null;
  offer_employment_type: string | null;
  offer_start_date: string | null;
}

interface PerformanceCycle { id: string; name: string; period_start: string; period_end: string; due_date: string; status: string; }
interface PerformanceReview { id: string; staff_id: string; reviewer_user_id: string; status: string; rating: number | null; cycle_id: string; }
interface HrCase { id: string; staff_id: string; case_type: string; severity: string; status: string; subject: string; opened_at: string; }

interface AssetRow {
  id: string;
  asset_type: string;
  name: string;
  serial_number: string | null;
  registration: string | null;
  make: string | null;
  model: string | null;
  year: number | null;
  status: string;
  assigned_to: string | null;
  last_inspection_date: string | null;
  next_inspection_date: string | null;
  notes: string | null;
  updated_at: string;
}

interface AssetDraft {
  requestId: string;
  assetId: string | null;
  expectedUpdatedAt: string | null;
  assetType: string;
  name: string;
  serialNumber: string;
  registration: string;
  make: string;
  model: string;
  year: string;
  status: string;
  nextInspectionDate: string;
  notes: string;
}

type AttentionLevel = 'clear' | 'due' | 'overdue';
const attentionRank: Record<AttentionLevel, number> = { clear: 0, due: 1, overdue: 2 };
const attentionLabel: Record<AttentionLevel, string> = { clear: 'Current', due: 'Due soon', overdue: 'Needs attention' };

const expiryAttention = (value: string | null | undefined): AttentionLevel => {
  if (!value) return 'clear';
  const days = Math.ceil((new Date(value).getTime() - new Date().setHours(0, 0, 0, 0)) / 86400000);
  if (days < 0) return 'overdue';
  return days <= 30 ? 'due' : 'clear';
};

const strongestAttention = (...levels: AttentionLevel[]) =>
  levels.reduce<AttentionLevel>((strongest, level) => attentionRank[level] > attentionRank[strongest] ? level : strongest, 'clear');

interface OnCallRow {
  id: string;
  officer_user_id: string;
  period_type: string;
  starts_at: string;
  ends_at: string;
  flat_rate: number | null;
  status: string;
}

interface CalloutRow {
  id: string;
  on_call_period_id: string;
  officer_user_id: string;
  status: string;
  minimum_pay_hours: number;
  callout_received_at: string | null;
  work_started_at: string | null;
  work_ended_at: string | null;
}

interface CalloutPaySummary {
  callout_id: string;
  worked_hours: number;
  minimum_pay_hours: number;
  payable_hours: number;
  minimum_applied: boolean;
  response_minutes: number | null;
}

interface CourtRow {
  id: string;
  officer_user_id: string;
  court_name: string;
  case_reference: string | null;
  subpoena_reference: string | null;
  appearance_type: string;
  scheduled_at: string;
  estimated_hours: number;
  status: string;
  is_overtime: boolean;
  actual_start: string | null;
  actual_end: string | null;
  outcome: string | null;
}

const TABS: { id: RosterTab; label: string }[] = [
  { id: 'staff', label: 'Staff' },
  { id: 'recruitment', label: 'Recruitment' },
  { id: 'performance', label: 'Performance' },
  { id: 'cases', label: 'HR Cases' },
  { id: 'shift-templates', label: 'Shift Templates' },
  { id: 'roster-rules', label: 'Rest & hours rules' },
  { id: 'coverage', label: 'Open Shifts' },
  { id: 'oncall', label: 'On-Call' },
  { id: 'court', label: 'Court' },
  { id: 'assets', label: 'Assets' },
  { id: 'leave', label: 'Leave' },
  { id: 'timesheets', label: 'Timesheet queue' },
  { id: 'pay-review', label: 'Pay Review' },
];

const TAB_GROUPS: { id: RosterTabGroup; label: string; tabs: RosterTab[] }[] = [
  { id: 'workforce', label: 'Staff', tabs: ['staff'] },
  { id: 'people', label: 'HR', tabs: ['recruitment', 'performance', 'cases', 'leave'] },
  { id: 'rostering', label: 'Rostering', tabs: [...ROSTERING_HR_TABS] },
  { id: 'pay-assets', label: 'Pay & Assets', tabs: ['timesheets', 'pay-review', 'assets'] },
];


const tabGroupFor = (tab: RosterTab): RosterTabGroup => TAB_GROUPS.find((group) => group.tabs.includes(tab))?.id ?? 'workforce';

/** What a reviewer reads on a timesheet row; the officer's own words live on the officer page. */
const HR_TIMESHEET_STATUS: Record<string, string> = { draft: 'Draft', submitted: 'Sent by officer', branch_checked: 'Branch checked', approved: 'Approved', rejected: 'Returned to officer', paid: 'Paid' };

type EvidenceActionKind = 'add_skill' | 'assign_line_manager' | 'record_induction' | 'record_document' | 'record_credential';
/** Same list the database accepts (record_staff_credential / apply_credential_promotion_proposal). */

/** Mirrors manage_staff_onboarding's stage order and the readiness gate each advance checks. */
const ONBOARDING_STEPS: Array<{ stage: string; label: string; needs: string }> = [
  { stage: 'identity', label: 'Identity', needs: 'Login and profile exist' },
  { stage: 'employment', label: 'Employment', needs: 'Employment type, start date and payroll role recorded' },
  { stage: 'evidence', label: 'Evidence', needs: 'Credentials, documents and skills recorded' },
  { stage: 'supervision', label: 'Supervision', needs: 'A line manager assigned' },
  { stage: 'induction', label: 'Induction', needs: 'Required site inductions recorded' },
  { stage: 'review', label: 'Review', needs: 'Final check by HR' },
  { stage: 'ready', label: 'Ready', needs: 'No blockers left – can be marked work ready on the Staff tab' },
];
const onboardingStageLabel = (stage: string) => ONBOARDING_STEPS.find((step) => step.stage === stage)?.label ?? plainWords(stage);
const onboardingStatusLabel = (status: string | undefined) => ({ in_progress: 'In progress', blocked: 'Blocked', withdrawn: 'Withdrawn', ready: 'Ready' } as Record<string, string>)[status ?? ''] ?? (status ? plainWords(status) : 'Not started');
const payrollCodeFromName = (value: string) => value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
const validPayrollCode = (value: string) => /^[A-Z0-9][A-Z0-9_-]*$/.test(value);

type TimesheetDecision = 'branch_checked' | 'approved' | 'rejected';
interface TimesheetRowsProps {
  rows: TimesheetRow[];
  staffNames: Record<string, string>;
  corporateReviewer: boolean;
  actorId?: string;
  onReview: (item: TimesheetRow, decision: TimesheetDecision) => void;
  onCorrect?: (item: TimesheetRow) => void;
  onPayCorrect?: (item: TimesheetRow) => void;
  onBreakReview?: (item: TimesheetRow) => void;
}

const TimesheetRows: React.FC<TimesheetRowsProps> = ({ rows, staffNames, corporateReviewer, actorId, onReview, onCorrect, onPayCorrect, onBreakReview }) => (
  <div className="reports-table-wrapper hr-timesheet-table">
    <table className="reports-table">
      <caption className="sr-only">Timesheet reconciliation: rostered, worked, adjusted and submitted hours</caption>
      <thead><tr><th scope="col">Staff</th><th scope="col">Period</th><th scope="col">Rostered h</th><th scope="col">Worked h</th><th scope="col">Adjustment h</th><th scope="col">To pay h</th><th scope="col">Status</th><th scope="col">Review</th></tr></thead>
      <tbody>{rows.length === 0 ? <tr><td colSpan={8}>No timesheets in this scope.</td></tr> : rows.map((item) => <tr key={item.id} className={timesheetSummaryMismatchReasons(item.work_summary).length ? 'timesheet-mismatch' : undefined}>
        <td>{staffNames[item.staff_id] || 'Staff identity unavailable'}</td>
        <td>{item.period_start} – {item.period_end}{item.work_summary?.evidence_kind === 'manual_admin' && <details><summary>Manual admin evidence — not actual attendance</summary>{item.work_summary.manual_sources?.map((source) => <p key={`${source.source_type}:${source.source_id}`}>{source.source_type}: {source.source_id}{source.shift_id && <> · Shift: {source.shift_id}</>} · {source.reason}</p>)}</details>}</td>
        <td>{item.scheduled_hours ?? '—'}</td><td>{item.work_derived_hours ?? '—'}{item.work_summary?.source_count !== undefined && <small> · {item.work_summary.source_count} work records</small>}<small className="timesheet-mismatch-note">{timesheetSummaryMismatchReasons(item.work_summary).join('; ')}</small></td><td>{item.adjustment_hours ?? '—'}</td><td>{item.actual_hours ?? '—'}</td>
        <td><span className={`status-badge status-${item.status}`}>{HR_TIMESHEET_STATUS[item.status] ?? plainWords(item.status)}</span>{item.submitted_at && <small className="hr-timesheet-submitted">{submittedWords(item.submitted_at)}</small>}{item.pay_override_reason && <small>This timesheet only: {item.pay_code_override ?? 'standard pay code'} · {item.hourly_rate_override == null ? 'standard hourly rate' : `$${Number(item.hourly_rate_override).toFixed(4)}/h`} · {item.pay_override_reason}</small>}</td>
        <td><div className="hr-timesheet-actions">
          {onCorrect && ['submitted', 'branch_checked'].includes(item.status) && <button className="btn btn-sm btn-secondary" onClick={() => onCorrect(item)}>Edit hours</button>}
          {onPayCorrect && ['submitted', 'branch_checked'].includes(item.status) && <button className="btn btn-sm btn-secondary" onClick={() => onPayCorrect(item)}>Pay code / rate</button>}
          {onBreakReview && <button className="btn btn-sm btn-secondary" onClick={() => onBreakReview(item)}>Review breaks</button>}
          {item.status === 'submitted' && <><button className="btn btn-sm btn-secondary" onClick={() => onReview(item, 'branch_checked')}>Branch check</button><button className="btn btn-sm btn-danger" onClick={() => onReview(item, 'rejected')}>Return for correction</button></>}
          {item.status === 'branch_checked' && corporateReviewer && <>{item.branch_reviewed_by !== actorId && <button className="btn btn-sm btn-secondary" onClick={() => onReview(item, 'approved')}>Final approve</button>}<button className="btn btn-sm btn-danger" onClick={() => onReview(item, 'rejected')}>Return for correction</button></>}
          {item.status === 'branch_checked' && (!corporateReviewer || item.branch_reviewed_by === actorId) && <small>A different corporate payroll reviewer must approve.</small>}
        </div></td>
      </tr>)}</tbody>
    </table>
  </div>
);

/** Branch-local evidence and review; payroll export and corporate corrections stay in HR. */
export const RosterTimesheetPanel: React.FC<{
  from: string;
  to: string;
  staffId: string | null;
  staffNames: Record<string, string>;
  onPendingCount: (count: number | null) => void;
}> = ({ from, to, staffId, staffNames, onPendingCount }) => {
  const { profile, operatingOrganizationId, operatingOrganizations } = useAuth();
  const branchId = operatingOrganizationId ?? profile?.organizationId;
  const context = operatingOrganizations.find((item) => item.organizationId === branchId);
  const [rows, setRows] = useState<TimesheetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [decision, setDecision] = useState<{ item: TimesheetRow; action: TimesheetDecision } | null>(null);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const generation = useRef(0);
  const loadQueue = useCallback(async () => {
    const version = ++generation.current;
    setLoading(true); setError(null); setRows([]); onPendingCount(null);
    if (!branchId || !context || context.authorityBasis === 'corporate_oversight') {
      setError('Select an authorised delivery branch for local timesheet review.'); setLoading(false); return;
    }
    try {
      const { data, error: queueError } = await supabase.rpc('get_branch_timesheet_queue', { p_operating_organization_id: branchId });
      if (version !== generation.current) return;
      if (queueError) throw queueError;
      const scoped = ((data ?? []) as TimesheetRow[]).filter((item) => item.period_start <= to && item.period_end >= from);
      setRows(scoped); onPendingCount(scoped.filter((item) => item.status === 'submitted').length);
    } catch (failure) {
      if (version === generation.current) setError(failure instanceof Error ? failure.message : (failure as { message?: string })?.message ?? 'Timesheet review is unavailable.');
    } finally { if (version === generation.current) setLoading(false); }
  }, [branchId, context?.authorityBasis, from, to, onPendingCount]);
  useEffect(() => { void loadQueue(); return () => { generation.current += 1; }; }, [loadQueue]);
  const submitDecision = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!decision || saving || (decision.action === 'rejected' && !notes.trim())) return;
    const version = generation.current;
    setSaving(true); setError(null); setReceipt(null);
    try {
      const { data, error: reviewError } = await supabase.rpc('review_branch_timesheet', {
        p_operating_organization_id: branchId,
        p_timesheet_id: decision.item.id,
        p_expected_status: decision.item.status,
        p_decision: decision.action,
        p_review_notes: notes.trim() || null,
      });
      if (version !== generation.current) return;
      if (reviewError) throw reviewError;
      const confirmed = Array.isArray(data) ? data[0] : data;
      if (confirmed?.id !== decision.item.id || confirmed?.status !== decision.action) throw new Error('The server did not confirm this decision. Refresh before retrying.');
      setReceipt(`Timesheet ${confirmed.id}: ${HR_TIMESHEET_STATUS[confirmed.status] ?? plainWords(confirmed.status)}. Audit decision recorded; no payment made.`);
      setDecision(null); setNotes(''); await loadQueue();
    } catch (failure) {
      if (version === generation.current) setError(failure instanceof Error ? failure.message : (failure as { message?: string })?.message ?? 'Review failed. Refresh and try again.');
    } finally { setSaving(false); }
  };
  return <section className="hr-roster-reconciliation" aria-label="Inline timesheet reconciliation">
    <header><strong>Branch-local reconciliation</strong><button className="btn btn-sm btn-secondary" disabled={loading || saving} onClick={() => void loadQueue()}>Refresh timesheets</button></header>
    <p>Overlapping timesheet periods in the selected roster range. Branch check confirms local evidence, not payroll approval. Corrections and final approval require the HR workspace and its authority.</p>
    {receipt && <p role="status" className="hr-timesheet-receipt">{receipt}</p>}
    {error && <p role="alert" className="hr-review-error">{error}</p>}
    {loading ? <p role="status">Loading authorised timesheets…</p> : !error && <TimesheetRows rows={rows.filter((item) => !staffId || item.staff_id === staffId)} staffNames={staffNames} corporateReviewer={false} actorId={profile?.id} onReview={(item, action) => { setDecision({ item, action }); setNotes(''); setError(null); }} />}
    {decision && <form className="hr-inline-review" onSubmit={submitDecision} aria-label="Timesheet decision">
      <strong>{decision.action === 'branch_checked' ? 'Branch check' : 'Return for correction'} · {staffNames[decision.item.staff_id] ?? 'Staff member'}</strong>
      <label>Review notes<textarea rows={2} required={decision.action === 'rejected'} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
      <div><button type="button" className="btn btn-sm btn-secondary" disabled={saving} onClick={() => { setDecision(null); setError(null); }}>Cancel</button><button type="submit" className="btn btn-sm btn-primary" disabled={saving || (decision.action === 'rejected' && !notes.trim())}>{saving ? 'Recording…' : 'Confirm decision'}</button></div>
    </form>}
  </section>;
};

const RosterHRPage: React.FC = () => {
  const staffProfileHref = useHref('/admin/people-hr');
  const location = useLocation();
  const navigate = useNavigate();
  const requestedCredentialId = new URLSearchParams(location.search).get('credential');
  const { profile, operatingOrganizationId, operatingOrganizations } = useAuth();
  const operatingBranchId = operatingOrganizationId ?? profile?.organizationId ?? null;
  const { scope: workforceScope } = useWorkforceScope(profile?.id, operatingBranchId);
  // "Working in" the organisation itself sets operatingOrganizationId to the home org; only another org is branch mode.
  const workingInBranch = Boolean(operatingOrganizationId && operatingOrganizationId !== profile?.organizationId);
  const corporatePayrollReviewer = Boolean(profile?.employerOrganizationId && profile.employerOrganizationId === profile.organizationId && isAdminTierRole(profile.role));
  const canManagePayRoles = isAdminTierRole(profile?.role);
  const requestedTab = new URLSearchParams(location.search).get('tab') as RosterTab | null;
  const roleTabs = new Set<RosterTab>(TABS.map((item) => item.id));
  // Shift setup is reached from Rosters; staff, pay and HR from People. Each view shows only its own groups.
  const rosteringView = isRosteringHrView(location.search);
  const visibleTabGroups = TAB_GROUPS
    .filter((group) => (group.id === 'rostering') === rosteringView)
    .map((group) => ({ ...group, tabs: group.tabs.filter((item) => roleTabs.has(item)) }))
    .filter((group) => group.tabs.length > 0);
  const viewTabs = new Set<RosterTab>(visibleTabGroups.flatMap((group) => group.tabs));
  const initialTab = requestedTab && viewTabs.has(requestedTab) ? requestedTab : visibleTabGroups[0]?.tabs[0] ?? 'staff';
  const [tab, setTab] = useState<RosterTab>(initialTab);
  const [tabGroup, setTabGroup] = useState<RosterTabGroup>(tabGroupFor(initialTab));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [onboarding, setOnboarding] = useState<StaffOnboardingRow[]>([]);
  const [vacancies, setVacancies] = useState<RecruitmentVacancy[]>([]);
  const [candidates, setCandidates] = useState<RecruitmentCandidate[]>([]);
  const [performanceCycles, setPerformanceCycles] = useState<PerformanceCycle[]>([]);
  const [performanceReviews, setPerformanceReviews] = useState<PerformanceReview[]>([]);
  const [hrCases, setHrCases] = useState<HrCase[]>([]);
  const [showCycleForm, setShowCycleForm] = useState(false);
  const [showCaseForm, setShowCaseForm] = useState(false);
  const [cycleForm, setCycleForm] = useState({ name: '', start: '', end: '', due: '' });
  const [reviewForm, setReviewForm] = useState({ cycleId: '', staffId: '', reviewerId: '' });
  const [showReviewForm, setShowReviewForm] = useState(false);
  const [reviewAction, setReviewAction] = useState<PerformanceReview | null>(null);
  const [reviewCompletion, setReviewCompletion] = useState({ rating: '3', strengths: '', goals: '', comments: '' });
  const [caseForm, setCaseForm] = useState({ staffId: '', type: 'conduct', severity: 'standard', subject: '', summary: '' });
  const [caseAction, setCaseAction] = useState<{ item: HrCase; action: 'review' | 'note' | 'resolve' | 'withdraw'; note: string } | null>(null);
  const [showVacancyForm, setShowVacancyForm] = useState(false);
  const [showCandidateForm, setShowCandidateForm] = useState(false);
  const [vacancyForm, setVacancyForm] = useState({ title: '', employmentType: 'permanent', location: '' });
  const [candidateForm, setCandidateForm] = useState({ vacancyId: '', firstName: '', lastName: '', email: '', phone: '' });
  const [candidateAction, setCandidateAction] = useState<{ candidate: RecruitmentCandidate; nextStage: string; note: string; offerRole?: string; offerEmploymentType?: string; offerStartDate?: string } | null>(null);
  const [offerAction, setOfferAction] = useState<{ candidate: RecruitmentCandidate; role: string; employmentType: string; startDate: string; note: string; accepted: boolean; branchId: string } | null>(null);
  const [offerError, setOfferError] = useState<string | null>(null);
  const [hireBranches, setHireBranches] = useState<{ id: string; name: string }[]>([]);
  const hireDialogOpen = Boolean(offerAction?.accepted);
  useEffect(() => {
    // create-user only accepts active delivery branches of the employer, never the employer organisation itself.
    if (!hireDialogOpen || !operatingOrganizations.length) return;
    let active = true;
    void supabase.from('organizations').select('id,name').in('id', operatingOrganizations.map((organization) => organization.organizationId)).eq('organization_type', 'branch').eq('active', true).order('name').then(({ data, error: branchError }) => {
      if (!active) return;
      const rows = branchError ? [] : data ?? [];
      setHireBranches(rows);
      if (branchError) setOfferError('Delivery branches could not be loaded. Refresh and try again.');
      setOfferAction((current) => current && !current.branchId ? { ...current, branchId: rows.find((row) => row.id === operatingOrganizationId)?.id ?? (rows.length === 1 ? rows[0].id : '') } : current);
    });
    return () => { active = false; };
  }, [hireDialogOpen, operatingOrganizations, operatingOrganizationId]);
  const [readinessAssessments, setReadinessAssessments] = useState<ReadinessAssessment[]>([]);
  const [credentials, setCredentials] = useState<CredentialRow[]>([]);
  const [staffSiteInductions, setStaffSiteInductions] = useState<StaffSiteInductionRow[]>([]);
  const [staffDocuments, setStaffDocuments] = useState<StaffDocumentRow[]>([]);
  const [trainingRecords, setTrainingRecords] = useState<StaffTrainingRow[]>([]);
  const [staffSkills, setStaffSkills] = useState<StaffSkillRow[]>([]);
  const [shiftTemplates, setShiftTemplates] = useState<ShiftTemplateRow[]>([]);
  const [leaveRequests, setLeaveRequests] = useState<LeaveRequestRow[]>([]);
  const [timesheets, setTimesheets] = useState<TimesheetRow[]>([]);
  const [dispatchPayLines, setDispatchPayLines] = useState<DispatchPayLineRow[]>([]);
  const [dispatchPayLineReviews, setDispatchPayLineReviews] = useState<DispatchPayLineReviewRow[]>([]);
  const [payReviewGovernanceAvailable, setPayReviewGovernanceAvailable] = useState(false);
  const [payLineReview, setPayLineReview] = useState<{ line: DispatchPayLineRow; expectedReviewId: string | null; decision: 'approved' | 'rejected'; notes: string } | null>(null);
  const [payReviewFilter, setPayReviewFilter] = useState<'exceptions' | 'resolved' | 'all'>('exceptions');
  const [roleCodes, setRoleCodes] = useState<RoleCodeRow[]>([]);
  const [showPayRoleCodeForm, setShowPayRoleCodeForm] = useState(false);
  const [payRoleCodeForm, setPayRoleCodeForm] = useState({ code: '', name: '' });
  const [staffSearch, setStaffSearch] = useState('');
  const [onboardingSearch, setOnboardingSearch] = useState('');
  const [trainingAction, setTrainingAction] = useState<{ staffId: string; trainingName: string; trainingType: string; provider: string; completedDate: string; expiryDate: string; result: 'passed' | 'not_passed' | 'not_assessed'; score: string; notes: string; supersedesId: string | null } | null>(null);
  const [skillAction, setSkillAction] = useState<{ staffId: string; skillId: string; proficiency: string; certified: boolean; certificationExpiry: string; notes: string } | null>(null);
  const [staffNames, setStaffNames] = useState<Record<string, string>>({});
  const [coverageRequests, setCoverageRequests] = useState<CoverageRequestRow[]>([]);
  const [shiftSwaps, setShiftSwaps] = useState<ShiftSwapRow[]>([]);
    const [coverageWorkUnits,setCoverageWorkUnits]=useState<CoverageWorkUnit[]>([]);
    const [coverageFinalization,setCoverageFinalization]=useState<{request:CoverageRequestRow;workUnitId:string;notes:string}|null>(null);
  const [showCoverageForm, setShowCoverageForm] = useState(false);
  const [review, setReview] = useState<{ kind: 'leave' | 'timesheet'; id: string; decision: 'approved' | 'declined' | 'rejected' | 'branch_checked' } | null>(null);
  const [reviewNotes, setReviewNotes] = useState('');
  const [swapReview, setSwapReview] = useState<{ item: ShiftSwapRow; decision: 'approved' | 'declined' } | null>(null);
  const [timesheetCorrection, setTimesheetCorrection] = useState<{ item: TimesheetRow; actualHours: string; overtimeHours: string; reason: string } | null>(null);
  const [payCorrection, setPayCorrection] = useState<{ item: TimesheetRow; code: string; rate: string; reason: string; requestId: string } | null>(null);
  const [scheduleRecovery, setScheduleRecovery] = useState<{ staffId: string; from: string; to: string; rows: ScheduledTimesheetDraft[] | null; reason: string; overtime: string; requestId: string } | null>(null);
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const [breakReview, setBreakReview] = useState<{ item: TimesheetRow; rows: TimesheetBreakEvidence[] | null } | null>(null);
  const [exportedBatchId, setExportedBatchId] = useState<string | null>(null);
  const [readinessReview, setReadinessReview] = useState<{ staffId: string; name: string; current: boolean; next: boolean } | null>(null);
  const [credentialRenewal, setCredentialRenewal] = useState<{ source: CredentialRow; credentialNumber: string; issuingAuthority: string; issuedDate: string; expiryDate: string; evidenceNotes: string } | null>(null);
  const [readinessNotes, setReadinessNotes] = useState('');
  const [credentialStaffId, setCredentialStaffId] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const credentialRequestId = useRef(crypto.randomUUID());
  const [coverageForm, setCoverageForm] = useState({
    shift_date: '',
    start_time: '',
    end_time: '',
    required_staff_count: '1',
    urgency: 'normal',
    notes: '',
  });
  const [showTemplateForm, setShowTemplateForm] = useState(false);
  const [assets, setAssets] = useState<AssetRow[]>([]);
  const [assetDraft, setAssetDraft] = useState<AssetDraft | null>(null);
  const [onCallPeriods, setOnCallPeriods] = useState<OnCallRow[]>([]);
  const [onCallForm, setOnCallForm] = useState({ officerId: '', type: 'standard', startsAt: '', endsAt: '', flatRate: '', notes: '' });
  const [callouts, setCallouts] = useState<CalloutRow[]>([]);
  const [calloutPaySummaries, setCalloutPaySummaries] = useState<Record<string, CalloutPaySummary>>({});
  const [courtAppearances, setCourtAppearances] = useState<CourtRow[]>([]);
  const [courtForm, setCourtForm] = useState({ officerId: '', courtName: '', appearanceType: 'hearing', scheduledAt: '', estimatedHours: '2', caseReference: '', subpoenaReference: '', notes: '' });
  const [courtOutcome, setCourtOutcome] = useState<{ appearance: CourtRow; status: 'attended' | 'adjourned' | 'cancelled' | 'excused'; actualStart: string; actualEnd: string; outcome: string } | null>(null);
  const courtRequestId = useRef(crypto.randomUUID());
  const [assetCheck, setAssetCheck] = useState<{ asset: AssetRow; condition: string; odometer: string; fuel: string; defects: string } | null>(null);
  const [payrollExport, setPayrollExport] = useState<{ from: string; to: string } | null>(null);
  const payrollExportAttempt = useRef<{ key: string; id: string } | null>(null);
  const payrollScope = useRef(`${profile?.id}:${profile?.organizationId}`);
  payrollScope.current = `${profile?.id}:${profile?.organizationId}`;
  useEffect(() => {
    payrollExportAttempt.current = null;
    setPayrollExport(null);
  }, [profile?.id, profile?.organizationId]);
  const [onboardingAction, setOnboardingAction] = useState<{ staffId: string; ledgerId?: string; version?: number; nextStage?: string; name: string; note: string } | null>(null);
  const [employmentAction, setEmploymentAction] = useState<{
    staffId: string;
    name: string;
    expectedEmploymentType: string | null;
    expectedStartDate: string | null;
    expectedEndDate: string | null;
    expectedRoleCode: string | null;
    employmentType: string;
    startDate: string;
    endDate: string;
    roleCode: string;
    reason: string;
  } | null>(null);
  const [evidenceAction, setEvidenceAction] = useState<{ staffId: string; name: string; action: EvidenceActionKind; note: string; skillId: string; proficiency: string; managerId: string; trainingName: string; siteRequirementId: string; expiresAt: string; documentType: string; fileName: string; storagePath: string; credentialType: string; credentialNumber: string; issuingAuthority: string; issuedDate: string; expiryDate: string; credentialVerified: boolean } | null>(null);
  const [siteInductionState, setSiteInductionState] = useState<SiteInductionStateRow[]>([]);
  const [catalogSkills, setCatalogSkills] = useState<CatalogSkill[]>([]);
  const [skillCatalogDraft, setSkillCatalogDraft] = useState<{ id: string | null; name: string; category: string }>({ id: null, name: '', category: 'technical' });
  const [siteInductionRequirements, setSiteInductionRequirements] = useState<SiteInductionRequirementRow[]>([]);
  const [siteInductionDraft, setSiteInductionDraft] = useState<{ id: string | null; name: string; siteId: string; zoneId: string; serviceAgreementLocationId: string; version: string; required: boolean; expiresAfterDays: string; active: boolean }>({ id: null, name: '', siteId: '', zoneId: '', serviceAgreementLocationId: '', version: '', required: true, expiresAfterDays: '', active: true });
  const [showSkillCatalogForm, setShowSkillCatalogForm] = useState(false);
  const [showSiteInductionForm, setShowSiteInductionForm] = useState(false);
  const [sites, setSites] = useState<Array<{ id: string; name: string }>>([]);
  const [zones, setZones] = useState<Array<{ id: string; name: string }>>([]);
  const [agreementLocations, setAgreementLocations] = useState<Array<{ id: string; service_agreement_id: string; site_id: string | null; zone_id: string | null }>>([]);
  const [templateForm, setTemplateForm] = useState({
    name: '',
    shift_type: 'day',
    start_time: '08:00',
    end_time: '16:00',
    recurrence_type: 'weekly',
    required_staff_count: '1',
    notes: '',
  });

  useEffect(() => {
    if (viewTabs.has(tab)) return;
    const fallback = visibleTabGroups[0]?.tabs[0] ?? 'staff';
    setTab(fallback);
    setTabGroup(tabGroupFor(fallback));
  }, [profile?.role]);

  const activePayrollDialog = scheduleRecovery ? 'schedule-recovery-title' : payCorrection ? 'timesheet-pay-title' : breakReview ? 'timesheet-break-title' : null;
  useEffect(() => {
    if (!activePayrollDialog) return;
    const dialog = document.getElementById(activePayrollDialog)?.closest<HTMLElement>('[role="dialog"]');
    if (!dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]'));
    focusable()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); dialog.querySelector<HTMLButtonElement>('header button:not(:disabled)')?.click(); }
      if (event.key !== 'Tab') return;
      const elements = focusable();
      const first = elements[0]; const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    dialog.addEventListener('keydown', onKey);
    return () => { dialog.removeEventListener('keydown', onKey); previous?.focus(); };
  }, [activePayrollDialog]);

  // ATLAS READS: user_profiles, staff_profiles, staff_credentials,
  // shift_templates, leave_requests, timesheets, shift_coverage_requests
  const loadAll = useCallback(async () => {
    const orgId = profile?.organizationId;
    const org_access_allowed = Boolean(orgId);
    if (!org_access_allowed) {
      setCatalogSkills([]);
      setStaffSkills([]);
      setSiteInductionRequirements([]);
      setRoleCodes([]);
      setStaff([]);
      setReadinessAssessments([]);
      setCredentials([]);
      setStaffSiteInductions([]);
      setLeaveRequests([]);
      setTimesheets([]);
      setDispatchPayLines([]);
      setCalloutPaySummaries({});
      setCoverageRequests([]);
      setSites([]);
      setZones([]);
      setAgreementLocations([]);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);

      const [profilesRes, staffProfilesRes, roleCodesRes, credentialsRes, templatesRes, leaveRes, timesheetsRes, payLinesRes, payLineReviewsRes, coverageRes, readinessRes, workUnitsRes, assetsRes, onCallRes, calloutRes, courtRes, onboardingRes, vacanciesRes, candidatesRes, cyclesRes, reviewsRes, casesRes, skillCatalogRes, siteInductionRes, staffSiteInductionsRes, sitesRes, zonesRes, agreementLocationsRes, staffDocumentsRes, trainingRecordsRes, staffSkillsRes] =
        await Promise.all([
          supabase
            .from('user_profiles')
            .select('id, display_name, role, email, phone')
            .eq('organization_id', orgId),
          supabase
            .from('staff_profiles')
            .select('id, user_id, employment_type, start_date, end_date, work_ready, role_code')
            .eq('organization_id', orgId),
          supabase
            .from('reference_codes')
            .select('id, code, name')
            .eq('organization_id', orgId)
            .eq('code_type', 'role_code')
            .eq('is_active', true)
            .order('sort_order')
            .order('code'),
          supabase
            .from('staff_credentials')
            .select('id, staff_id, credential_type, credential_number, issuing_authority, issued_date, expiry_date, verified')
            .eq('organization_id', orgId)
            .order('expiry_date', { ascending: true }),
          supabase
            .from('shift_templates')
            .select('id, name, shift_type, start_time, end_time, recurrence_type, required_staff_count, is_active')
            .eq('organization_id', orgId)
            .order('name', { ascending: true }),
          operatingOrganizationId
            ? supabase.rpc('get_branch_leave_queue', { p_operating_organization_id: operatingBranchId })
            : Promise.resolve({ data: [], error: null }),
          workingInBranch
            ? supabase.rpc('get_branch_timesheet_queue', { p_operating_organization_id: operatingBranchId, p_from: workforceScope.from, p_to: workforceScope.to, p_staff_id: workforceScope.staffId })
            // ATLAS READS: timesheets — at organisation level the corporate payroll reviewer sees every branch's sheets (RLS: is_admin_for_org)
            : supabase.from('timesheets').select('id, staff_id, period_start, period_end, scheduled_hours, actual_hours, overtime_hours, work_derived_hours, adjustment_hours, work_summary, status, branch_review_notes, branch_reviewed_by, submitted_at, revision, pay_code_override, hourly_rate_override, pay_override_reason').eq('organization_id', orgId).or(workforceScope.staffId ? `staff_id.eq.${workforceScope.staffId}` : 'id.not.is.null').lte('period_start', workforceScope.to).gte('period_end', workforceScope.from).order('period_start', { ascending: false }).limit(200),
          supabase
            .from('dispatch_job_pay_lines')
            .select('id, source_dispatch_id, officer_user_id, rate_rule_id, pay_code, rate_type, description, quantity, unit_rate, line_total, distance_km, distance_reason, created_at')
            .eq('organization_id', orgId)
            .order('created_at', { ascending: false })
            .limit(100),
          PAY_LINE_REVIEW_TABLE_DEPLOYED
            ? supabase
              .from('dispatch_job_pay_line_reviews')
              .select('id, pay_line_id, decision, review_notes, reviewed_at, supersedes_review_id')
              .eq('organization_id', orgId)
              .order('reviewed_at', { ascending: false })
              .limit(200)
            : Promise.resolve({ data: [], error: null }),
          supabase
            .from('shift_coverage_requests')
            .select('id, shift_date, start_time, end_time, required_staff_count, urgency, status, notes, claimed_by, roster_slot_id, site:site_id(name)')
            .eq('organization_id', orgId)
            .in('status', ['open', 'claimed'])
            .order('urgency', { ascending: false })
            .order('shift_date', { ascending: true }),
          supabase.rpc('get_staff_readiness_assessment', { p_organization_id: orgId }),
          supabase.from('roster_work_units').select('id,name,work_unit_type').eq('organization_id',orgId).eq('active',true).order('name'),
          supabase.from('assets').select('id,asset_type,name,serial_number,registration,make,model,year,status,assigned_to,last_inspection_date,next_inspection_date,notes,updated_at').eq('organization_id', orgId).order('asset_type').order('name'),
          supabase.from('on_call_periods').select('id,officer_user_id,period_type,starts_at,ends_at,flat_rate,status').eq('organization_id', orgId).order('starts_at', { ascending: false }).limit(50),
          supabase.from('callout_shifts').select('id,on_call_period_id,officer_user_id,status,minimum_pay_hours,callout_received_at,work_started_at,work_ended_at').eq('organization_id', orgId).order('callout_received_at', { ascending: false }).limit(50),
          supabase.from('court_appearances').select('id,officer_user_id,court_name,case_reference,subpoena_reference,appearance_type,scheduled_at,estimated_hours,status,is_overtime,actual_start,actual_end,outcome').eq('organization_id', orgId).order('scheduled_at', { ascending: false }).limit(50),
          supabase.rpc('get_staff_onboarding_readiness', { p_organization_id: orgId }),
          supabase.from('recruitment_vacancies').select('id,title,employment_type,location_summary,status,opens_on,closes_on').eq('organization_id', orgId).order('created_at', { ascending: false }),
          supabase.from('recruitment_candidates').select('id,vacancy_id,first_name,last_name,email,stage,status,offer_role,offer_employment_type,offer_start_date').eq('organization_id', orgId).order('created_at', { ascending: false }),
          supabase.from('performance_review_cycles').select('id,name,period_start,period_end,due_date,status').eq('organization_id', orgId).order('due_date', { ascending: false }),
          supabase.from('performance_reviews').select('id,staff_id,reviewer_user_id,status,rating,cycle_id').eq('organization_id', orgId).order('created_at', { ascending: false }),
          supabase.from('hr_cases').select('id,staff_id,case_type,severity,status,subject,opened_at').eq('organization_id', orgId).order('opened_at', { ascending: false }),
          supabase.from('roster_skill_catalog').select('id, skill_name, skill_category, active').eq('organization_id', orgId).order('skill_name'),
          org_access_allowed
            ? supabase.from('site_induction_requirements').select('id, organization_id, client_site_id, zone_id, service_agreement_location_id, induction_name, version, required, expires_after_days, active').eq('organization_id', orgId).order('induction_name')
            : supabase.from('site_induction_requirements').select('id').limit(0),
          org_access_allowed
            ? supabase.from('staff_site_inductions').select('id, requirement_id, staff_id, completed_at, expires_at, evidence_notes').eq('organization_id', orgId).order('completed_at', { ascending: false })
            : supabase.from('staff_site_inductions').select('id').limit(0),
          supabase.from('client_sites').select('id, name').eq('active', true).order('name'),
          supabase.from('location_zones').select('id, name').eq('is_active', true).order('name'),
          supabase.from('service_agreement_locations').select('id, service_agreement_id, site_id, zone_id').eq('status', 'active').order('id'),
          supabase.from('staff_documents').select('id,staff_id,document_type,file_name,file_size_bytes,mime_type,notes,expiry_date,uploaded_at').eq('organization_id', orgId).order('created_at', { ascending: false }).limit(200),
          supabase.from('staff_training_records').select('id,staff_id,officer_id,training_name,training_type,provider,completed_date,expiry_date,passed,score,notes').eq('organization_id', orgId).order('completed_date', { ascending: false }).limit(200),
          supabase.from('staff_skills').select('id,staff_id,skill_id,skill_name,skill_category,proficiency_level,certified,certification_expiry,notes,updated_at').eq('organization_id', orgId).order('skill_name').limit(500),
        ]);
      const shiftSwapsRes = await supabase
        .from('shift_swaps')
        .select('id, original_shift_id, original_staff_id, swap_with_staff_id, swap_type, reason, status, requested_by, requested_at')
        .eq('organization_id', orgId)
        .order('requested_at', { ascending: false })
        .limit(100);

      if (profilesRes.error) throw profilesRes.error;
      if (staffProfilesRes.error) throw staffProfilesRes.error;
      if (roleCodesRes.error) throw roleCodesRes.error;
      if (credentialsRes.error) throw credentialsRes.error;
      if (staffDocumentsRes.error) throw staffDocumentsRes.error;
      if (trainingRecordsRes.error) throw trainingRecordsRes.error;
      if (staffSkillsRes.error) throw staffSkillsRes.error;
      if (templatesRes.error) throw templatesRes.error;
      if (leaveRes.error) throw leaveRes.error;
      if (timesheetsRes.error) throw timesheetsRes.error;
      if (payLinesRes.error) throw payLinesRes.error;
      if (payLineReviewsRes.error) throw payLineReviewsRes.error;
      if (coverageRes.error) throw coverageRes.error;
      if (shiftSwapsRes.error) throw shiftSwapsRes.error;
      if (readinessRes.error) throw readinessRes.error;
      if (workUnitsRes.error) throw workUnitsRes.error;
      if (assetsRes.error) throw assetsRes.error;
        if (onboardingRes.error) throw onboardingRes.error;
        if (vacanciesRes.error) throw vacanciesRes.error;
        if (candidatesRes.error) throw candidatesRes.error;
        if (cyclesRes.error) throw cyclesRes.error;
        if (reviewsRes.error) throw reviewsRes.error;
        if (casesRes.error) throw casesRes.error;
      if (skillCatalogRes.error) throw skillCatalogRes.error;
      if (siteInductionRes.error) throw siteInductionRes.error;
      if (staffSiteInductionsRes.error) throw staffSiteInductionsRes.error;
      if (sitesRes.error) throw sitesRes.error;
      if (zonesRes.error) throw zonesRes.error;
      if (agreementLocationsRes.error) throw agreementLocationsRes.error;

      setCatalogSkills((skillCatalogRes.data as CatalogSkill[]) ?? []);
      setSiteInductionRequirements((siteInductionRes.data as SiteInductionRequirementRow[]) ?? []);
      setAssets((assetsRes.data as AssetRow[]) ?? []);
      setOnCallPeriods((onCallRes.data as OnCallRow[]) ?? []);
      const calloutRows = (calloutRes.data as CalloutRow[]) ?? [];
      setCallouts(calloutRows);
      const paySummaryEntries = await Promise.all(calloutRows.map(async (callout) => {
        const { data: summary, error: summaryError } = await supabase.rpc('get_callout_pay_summary', { p_callout_id: callout.id });
        if (summaryError) throw summaryError;
        const row = (summary as CalloutPaySummary[] | null)?.[0];
        return row ? [callout.id, row] as const : null;
      }));
      setCalloutPaySummaries(Object.fromEntries(paySummaryEntries.filter((entry): entry is readonly [string, CalloutPaySummary] => entry !== null)));
      setCourtAppearances((courtRes.data as CourtRow[]) ?? []);
      setOnboarding((onboardingRes.data as StaffOnboardingRow[]) ?? []);
      setVacancies((vacanciesRes.data as RecruitmentVacancy[]) ?? []);
      setCandidates((candidatesRes.data as RecruitmentCandidate[]) ?? []);
      setPerformanceCycles((cyclesRes.data as PerformanceCycle[]) ?? []);
      setPerformanceReviews((reviewsRes.data as PerformanceReview[]) ?? []);
      setHrCases((casesRes.data as HrCase[]) ?? []);
      setRoleCodes((roleCodesRes.data as RoleCodeRow[]) ?? []);

      const staffProfileById = new Map((staffProfilesRes.data || []).map((s: any) => [s.user_id ?? s.id, s]));
      const merged: StaffRow[] = (profilesRes.data || []).map((p: any) => ({
        id: p.id,
        staff_id: staffProfileById.get(p.id)?.id ?? null,
        display_name: p.display_name,
        role: p.role,
        email: p.email,
        phone: p.phone,
        employment_type: staffProfileById.get(p.id)?.employment_type ?? null,
        start_date: staffProfileById.get(p.id)?.start_date ?? null,
        end_date: staffProfileById.get(p.id)?.end_date ?? null,
        work_ready: staffProfileById.get(p.id)?.work_ready ?? null,
        role_code: staffProfileById.get(p.id)?.role_code ?? null,
      }));

      const names: Record<string, string> = {};
      merged.forEach((s) => {
        names[s.id] = s.display_name || s.email || s.id;
        if (s.staff_id) names[s.staff_id] = s.display_name || s.email || s.id;
      });

      setStaff(merged);
      setReadinessAssessments((readinessRes.data as ReadinessAssessment[]) || []);
      setStaffNames(names);
      setCredentials((credentialsRes.data as CredentialRow[]) || []);
      setStaffSiteInductions((staffSiteInductionsRes.data as StaffSiteInductionRow[]) || []);
      setStaffDocuments((staffDocumentsRes.data as StaffDocumentRow[]) || []);
      setTrainingRecords((trainingRecordsRes.data as StaffTrainingRow[]) || []);
      setStaffSkills((staffSkillsRes.data as StaffSkillRow[]) || []);
      setShiftTemplates((templatesRes.data as ShiftTemplateRow[]) || []);
      setLeaveRequests((leaveRes.data as LeaveRequestRow[]) || []);
      setTimesheets(((timesheetsRes.data as TimesheetRow[]) || []).filter((row) => !workforceScope.staffId || row.staff_id === workforceScope.staffId));
      setDispatchPayLines((payLinesRes.data as DispatchPayLineRow[]) || []);
      setDispatchPayLineReviews((payLineReviewsRes.data as DispatchPayLineReviewRow[]) || []);
      setPayReviewGovernanceAvailable(PAY_LINE_REVIEW_TABLE_DEPLOYED);
      setCoverageRequests(
        ((coverageRes.data as any[]) || []).map((row) => ({
          id: row.id,
          shift_date: row.shift_date,
          start_time: row.start_time,
          end_time: row.end_time,
          required_staff_count: row.required_staff_count,
          urgency: row.urgency,
          status: row.status,
          notes: row.notes,
          site_name: row.site?.name ?? null,
          claimed_by:row.claimed_by,
          roster_slot_id:row.roster_slot_id,
        }))
      );
      setCoverageWorkUnits((workUnitsRes.data as CoverageWorkUnit[])||[]);
      setShiftSwaps((shiftSwapsRes.data as ShiftSwapRow[]) || []);
      setSites((sitesRes.data as Array<{ id: string; name: string }> ) ?? []);
      setZones((zonesRes.data as Array<{ id: string; name: string }> ) ?? []);
      setAgreementLocations((agreementLocationsRes.data as Array<{ id: string; service_agreement_id: string; site_id: string | null; zone_id: string | null }> ) ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load roster data');
    } finally {
      setLoading(false);
    }
  }, [operatingBranchId, profile?.organizationId, workforceScope.from, workforceScope.to, workforceScope.staffId]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (!requestedCredentialId || rosteringView) return;
    setTab('credentials');
    setTabGroup('workforce');
    document.getElementById(`credential-${requestedCredentialId}`)?.scrollIntoView({ block: 'center' });
  }, [credentials, requestedCredentialId]);

  useEffect(() => {
    if (evidenceAction?.action !== 'record_induction' || !evidenceAction.siteRequirementId) {
      setSiteInductionState([]);
      return;
    }
    const requirement = siteInductionRequirements.find((item) => item.id === evidenceAction.siteRequirementId);
    if (!requirement?.service_agreement_location_id) {
      setSiteInductionState([]);
      return;
    }
    let cancelled = false;
    void supabase.rpc('get_site_induction_state', {
      p_staff_id: evidenceAction.staffId,
      p_service_agreement_location_id: requirement.service_agreement_location_id,
    }).then(({ data, error: stateError }) => {
      if (cancelled) return;
      if (stateError) setError(stateError.message);
      else setSiteInductionState((data as SiteInductionStateRow[]) ?? []);
    });
    return () => { cancelled = true; };
  }, [evidenceAction?.action, evidenceAction?.siteRequirementId, evidenceAction?.staffId, siteInductionRequirements]);

  const handleReview = async (event: React.FormEvent) => {
    event.preventDefault();if (!review) return;setSaving(true);setError(null);setNotice(null);
    const currentStatus = review.kind === 'leave' ? leaveRequests.find((item) => item.id === review.id)?.status : timesheets.find((item) => item.id === review.id)?.status;
    const { error: reviewError } = review.kind === 'leave'
      ? review.decision === 'branch_checked' || (review.decision === 'declined' && currentStatus === 'pending')
        ? await supabase.rpc('review_branch_leave_request', { p_operating_organization_id: operatingBranchId, p_request_id: review.id, p_expected_status: currentStatus, p_decision: review.decision, p_review_notes: reviewNotes.trim() || null })
        : await supabase.rpc('review_leave_request', { p_request_id: review.id, p_expected_status: currentStatus, p_decision: review.decision, p_review_notes: reviewNotes.trim() || null })
      : review.decision === 'branch_checked' || (review.decision === 'rejected' && currentStatus === 'submitted')
        ? await supabase.rpc('review_branch_timesheet', { p_operating_organization_id: operatingBranchId, p_timesheet_id: review.id, p_expected_status: currentStatus, p_decision: review.decision, p_review_notes: reviewNotes.trim() || null })
        : await supabase.rpc('review_timesheet', { p_timesheet_id: review.id, p_expected_status: currentStatus, p_decision: review.decision, p_review_notes: reviewNotes.trim() || null });
    if (reviewError) setError(reviewError.message);else { setNotice(review.kind === 'leave' ? review.decision === 'branch_checked' ? 'Leave branch check recorded for corporate confirmation.' : review.decision === 'declined' ? 'Leave request declined with branch review notes.' : 'Leave approved after corporate review and roster conflict checks.' : review.decision === 'branch_checked' ? 'Timesheet branch check recorded for corporate payroll approval.' : review.decision === 'rejected' ? 'Timesheet returned for correction.' : 'Timesheet approved for payroll processing.');setReview(null);setReviewNotes('');await loadAll(); }setSaving(false);
  };

  const handleReadinessReview = async (event: React.FormEvent) => {
    event.preventDefault();if (!readinessReview || !readinessNotes.trim()) return;setSaving(true);setError(null);setNotice(null);
    const { error: readinessError } = await supabase.rpc('set_staff_work_readiness', { p_staff_id: readinessReview.staffId, p_expected_work_ready: readinessReview.current, p_work_ready: readinessReview.next, p_review_notes: readinessNotes.trim() });
    if (readinessError) setError(readinessError.message);else { setNotice(`${readinessReview.name} readiness updated and audited.`);setReadinessReview(null);setReadinessNotes('');await loadAll(); }setSaving(false);
  };

  const openStaffProfile = (person: StaffRow, profileTab = 'overview') => {
    if (!person.staff_id) return;
    const params = new URLSearchParams({ profile: person.staff_id, profileTab });
    navigate({ pathname: staffProfileHref, search: params.toString() });
  };

  const createPayRoleCode = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!profile?.organizationId || !canManagePayRoles) return;
    const code = payrollCodeFromName(payRoleCodeForm.code);
    if (!validPayrollCode(code) || !payRoleCodeForm.name.trim()) return;
    setSaving(true); setError(null); setNotice(null);
    const { error: createError } = await supabase.rpc('manage_pay_role_code', {
      p_action: 'create',
      p_code: code,
      p_name: payRoleCodeForm.name.trim(),
      p_role_code_id: null,
    });
    if (createError) setError(createError.message);
    else {
      setNotice(`Payroll role code ${code} created. Add its pay rule for each branch that uses it after assigning staff.`);
      setPayRoleCodeForm({ code: '', name: '' });
      setShowPayRoleCodeForm(false);
      await loadAll();
    }
    setSaving(false);
  };

  const recordTraining = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!trainingAction?.staffId || !trainingAction.trainingName.trim() || !trainingAction.completedDate) return;
    setSaving(true); setError(null); setNotice(null);
    const { data, error: actionError } = await supabase.rpc('record_staff_training', {
      p_client_request_id: crypto.randomUUID(),
      p_staff_id: trainingAction.staffId,
      p_training_name: trainingAction.trainingName.trim(),
      p_training_type: trainingAction.trainingType,
      p_provider: trainingAction.provider.trim() || null,
      p_completed_date: trainingAction.completedDate,
      p_expiry_date: trainingAction.expiryDate || null,
      p_passed: trainingAction.result === 'not_assessed' ? null : trainingAction.result === 'passed',
      p_score: trainingAction.score ? Number(trainingAction.score) : null,
      p_notes: trainingAction.notes.trim() || null,
      p_supersedes_training_record_id: trainingAction.supersedesId,
    });
    if (actionError || !data) setError(actionError?.message ?? 'Training receipt was not confirmed.');
    else {
      setNotice(trainingAction.supersedesId ? 'Training renewal recorded with the previous record preserved.' : 'Training record saved and audited.');
      setTrainingAction(null);
      await loadAll();
    }
    setSaving(false);
  };

  const saveStaffSkill = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!skillAction?.staffId || !skillAction.skillId) return;
    setSaving(true); setError(null); setNotice(null);
    const { data, error: actionError } = await supabase.rpc('assign_roster_skill_to_staff', {
      p_staff_id: skillAction.staffId,
      p_skill_id: skillAction.skillId,
      p_proficiency_level: skillAction.proficiency,
      p_certified: skillAction.certified,
      p_certification_expiry: skillAction.certificationExpiry || null,
      p_notes: skillAction.notes.trim() || null,
    });
    if (actionError || !data) setError(actionError?.message ?? 'Skill assignment receipt was not confirmed.');
    else {
      setNotice('Staff skill saved and available to roster qualification checks.');
      setSkillAction(null);
      await loadAll();
    }
    setSaving(false);
  };

  const deactivatePayRoleCode = async (code: RoleCodeRow) => {
    if (!code.id || !canManagePayRoles || !window.confirm(`Deactivate ${code.code}? It must first be removed from every staff profile.`)) return;
    setSaving(true); setError(null); setNotice(null);
    const { error: deactivateError } = await supabase.rpc('manage_pay_role_code', {
      p_action: 'deactivate',
      p_code: null,
      p_name: null,
      p_role_code_id: code.id,
    });
    if (deactivateError) setError(deactivateError.message);
    else { setNotice(`Payroll role code ${code.code} deactivated.`); await loadAll(); }
    setSaving(false);
  };

  const submitPayLineReview = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!payLineReview) return;
    if (payLineReview.decision === 'rejected' && !payLineReview.notes.trim()) return;
    setSaving(true); setError(null); setNotice(null);
    const { error: reviewError } = await supabase.rpc('review_dispatch_job_pay_line', {
      p_client_request_id: crypto.randomUUID(),
      p_pay_line_id: payLineReview.line.id,
      p_expected_review_id: payLineReview.expectedReviewId,
      p_decision: payLineReview.decision,
      p_review_notes: payLineReview.notes.trim() || null,
    });
    if (reviewError) setError(reviewError.message);
    else { setNotice(`Pay evidence ${payLineReview.decision}.`); setPayLineReview(null); await loadAll(); }
    setSaving(false);
  };

  const handleCredentialRenewal = async (event: React.FormEvent) => {
    event.preventDefault();if (!credentialRenewal) return;setSaving(true);setError(null);setNotice(null);
    const { data, error: renewalError } = await supabase.rpc('renew_staff_credential', { p_client_request_id: credentialRequestId.current, p_source_credential_id: credentialRenewal.source.id, p_expected_expiry_date: credentialRenewal.source.expiry_date, p_credential_number: credentialRenewal.credentialNumber.trim(), p_issuing_authority: credentialRenewal.issuingAuthority.trim(), p_issued_date: credentialRenewal.issuedDate, p_expiry_date: credentialRenewal.expiryDate, p_evidence_notes: credentialRenewal.evidenceNotes.trim() });
    const receipt = (data as Array<{ credential_id: string; created: boolean }> | null)?.[0];
    if (renewalError || !receipt) setError(renewalError?.message ?? 'Credential renewal receipt was not confirmed.');
    else { const staffName=staffNames[credentialRenewal.source.staff_id]||'Staff member';setNotice(`${staffName} credential renewal recorded and verified · receipt ${receipt.credential_id.slice(0,8)}.`);setCredentialRenewal(null);credentialRequestId.current=crypto.randomUUID();await loadAll(); }setSaving(false);
  };

  const handleCreateCoverage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile?.id || !profile?.organizationId) return;
    if (!coverageForm.shift_date || !coverageForm.start_time || !coverageForm.end_time) return;

    try {
      const { data, error } = await supabase.rpc('create_shift_coverage_request', { p_organization_id: profile.organizationId, p_shift_date: coverageForm.shift_date, p_start_time: coverageForm.start_time, p_end_time: coverageForm.end_time, p_required_staff_count: Number(coverageForm.required_staff_count) || 1, p_urgency: coverageForm.urgency, p_notes: coverageForm.notes.trim() || null });

      if (error) throw error;
      setCoverageRequests([{ ...(data as CoverageRequestRow), site_name: null }, ...coverageRequests]);
      setCoverageForm({ shift_date: '', start_time: '', end_time: '', required_staff_count: '1', urgency: 'normal', notes: '' });
      setShowCoverageForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create coverage request');
    }
  };

  const finalizeCoverage=async(event:React.FormEvent)=>{event.preventDefault();if(!coverageFinalization)return;setSaving(true);setError(null);setNotice(null);const{data,error:finalizeError}=await supabase.rpc('finalize_shift_coverage',{p_request_id:coverageFinalization.request.id,p_expected_status:coverageFinalization.request.status,p_work_unit_id:coverageFinalization.workUnitId,p_notes:coverageFinalization.notes.trim()||null});const receipt=(data as Array<{request_id:string;roster_slot_id:string;shift_id:string|null}>|null)?.[0];if(finalizeError||!receipt)setError(finalizeError?.message??'Coverage finalization receipt was not confirmed.');else{setNotice(`Coverage finalized for ${staffNames[coverageFinalization.request.claimed_by??'']??'claimant'} · roster ${receipt.roster_slot_id.slice(0,8)}${receipt.shift_id?` · shift ${receipt.shift_id.slice(0,8)}`:''}.`);setCoverageFinalization(null);await loadAll();}setSaving(false);};

  const handleCreateTemplate = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true); setError(null); setNotice(null);
    const { error: tplError } = await supabase.rpc('manage_shift_template', {
      p_client_request_id: crypto.randomUUID(),
      p_action: 'create',
      p_name: templateForm.name.trim(),
      p_shift_type: templateForm.shift_type,
      p_start_time: templateForm.start_time,
      p_end_time: templateForm.end_time,
      p_recurrence_type: templateForm.recurrence_type,
      p_required_staff_count: Number(templateForm.required_staff_count),
      p_notes: templateForm.notes.trim() || null,
    });
    if (tplError) setError(tplError.message);
    else {
      setNotice(`Shift template '${templateForm.name}' created.`);
      setShowTemplateForm(false);
      setTemplateForm({ name: '', shift_type: 'day', start_time: '08:00', end_time: '16:00', recurrence_type: 'weekly', required_staff_count: '1', notes: '' });
      await loadAll();
    }
    setSaving(false);
  };

  const handleAssetCheck = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!assetCheck) return;
    setSaving(true); setError(null); setNotice(null);
    const { error: checkError } = await supabase.rpc('record_asset_check', {
      p_client_request_id: crypto.randomUUID(),
      p_asset_id: assetCheck.asset.id,
      p_check_type: 'defect_report',
      p_condition: assetCheck.condition,
      p_odometer_reading: assetCheck.odometer ? Number(assetCheck.odometer) : null,
      p_fuel_level: assetCheck.fuel || null,
      p_defects_noted: assetCheck.defects.trim() || null,
    });
    if (checkError) setError(checkError.message);
    else {
      setNotice(`Check recorded for ${assetCheck.asset.name}.`);
      setAssetCheck(null);
      await loadAll();
    }
    setSaving(false);
  };

  const openAssetRegister = (asset?: AssetRow) => {
    setAssetDraft({
      requestId: crypto.randomUUID(),
      assetId: asset?.id ?? null,
      expectedUpdatedAt: asset?.updated_at ?? null,
      assetType: asset?.asset_type ?? 'vehicle',
      name: asset?.name ?? '',
      serialNumber: asset?.serial_number ?? '',
      registration: asset?.registration ?? '',
      make: asset?.make ?? '',
      model: asset?.model ?? '',
      year: asset?.year?.toString() ?? '',
      status: asset?.status ?? 'available',
      nextInspectionDate: asset?.next_inspection_date ?? '',
      notes: asset?.notes ?? '',
    });
    setError(null);
    setNotice(null);
  };

  const saveAsset = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!assetDraft) return;
    const year = assetDraft.year ? Number(assetDraft.year) : null;
    const nextYear = new Date().getFullYear() + 1;
    if (!assetDraft.name.trim()) {
      setError('Asset name is required.');
      return;
    }
    if (year !== null && (!Number.isInteger(year) || year < 1900 || year > nextYear)) {
      setError(`Asset year must be between 1900 and ${nextYear}.`);
      return;
    }

    setSaving(true);
    setError(null);
    setNotice(null);
    // ATLAS WRITES: manage_asset (replay-safe, optimistic fleet register authority)
    const { data, error: assetError } = await supabase.rpc('manage_asset', {
      p_client_request_id: assetDraft.requestId,
      p_action: assetDraft.assetId ? 'update' : 'create',
      p_asset_id: assetDraft.assetId,
      p_expected_updated_at: assetDraft.expectedUpdatedAt,
      p_asset_type: assetDraft.assetType,
      p_name: assetDraft.name.trim(),
      p_serial_number: assetDraft.serialNumber.trim() || null,
      p_registration: assetDraft.registration.trim() || null,
      p_make: assetDraft.make.trim() || null,
      p_model: assetDraft.model.trim() || null,
      p_year: year,
      p_status: assetDraft.status,
      p_next_inspection_date: assetDraft.nextInspectionDate || null,
      p_notes: assetDraft.notes.trim() || null,
    });
    const saved = (Array.isArray(data) ? data[0] : data) as AssetRow | null;
    if (assetError || !saved) {
      setError(assetError?.message ?? 'The asset register receipt was not confirmed. Check the register before retrying.');
    } else {
      setNotice(`${saved.name} ${assetDraft.assetId ? 'updated' : 'added'} with an audit receipt. Next: it is ${saved.status.replaceAll('_', ' ')} for checks${saved.status === 'available' ? ' and shift sign-out' : ''}.`);
      setAssetDraft(null);
      await loadAll();
    }
    setSaving(false);
  };

  const reviewSwap = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!swapReview) return;
    setSaving(true); setError(null); setNotice(null);
    const { error: reviewError } = await supabase.rpc('review_shift_swap', {
      p_client_request_id: crypto.randomUUID(),
      p_swap_id: swapReview.item.id,
      p_expected_status: swapReview.item.status,
      p_decision: swapReview.decision,
      p_review_notes: reviewNotes.trim() || null,
    });
    if (reviewError) setError(reviewError.message);
    else {
      setNotice(swapReview.decision === 'approved' ? 'Shift swap approved and roster ownership updated.' : 'Shift swap declined with the review recorded.');
      setSwapReview(null); setReviewNotes(''); await loadAll();
    }
    setSaving(false);
  };

  const correctTimesheet = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!timesheetCorrection) return;
    setSaving(true); setError(null); setNotice(null);
    const { error: correctionError } = await supabase.rpc('correct_timesheet_hours', {
      p_timesheet_id: timesheetCorrection.item.id,
      p_expected_status: timesheetCorrection.item.status,
      p_actual_hours: Number(timesheetCorrection.actualHours),
      p_overtime_hours: Number(timesheetCorrection.overtimeHours),
      p_reason: timesheetCorrection.reason.trim(),
    });
    if (correctionError) setError(correctionError.message);
    else { setNotice('Timesheet hours corrected and returned to submitted review.'); setTimesheetCorrection(null); await loadAll(); }
    setSaving(false);
  };

  const previewScheduleRecovery = async () => {
    if (!scheduleRecovery || !corporatePayrollReviewer) return;
    setRecoveryLoading(true); setError(null);
    const request = scheduleRecovery;
    const { data, error: previewError } = await supabase.rpc('preview_scheduled_timesheet', {
      p_staff_id: request.staffId, p_period_start: request.from, p_period_end: request.to,
    });
    if (previewError) setError(previewError.message);
    else setScheduleRecovery((current) => current && current.staffId === request.staffId && current.from === request.from && current.to === request.to
      ? { ...current, rows: ((data ?? []) as ScheduledTimesheetSource[]).map((row) => ({
        ...row, selected: false, reviewedStart: localDateTimeInput(row.scheduled_start),
        reviewedEnd: localDateTimeInput(row.scheduled_end), unpaidBreak: '0',
      })) } : current);
    setRecoveryLoading(false);
  };

  const recoverSchedule = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!scheduleRecovery || !corporatePayrollReviewer) return;
    const rows = scheduleRecovery.rows?.filter((row) => row.selected) ?? [];
    if (!rows.length) { setError('Select at least one scheduled row to review.'); return; }
    if (rows.some((row) => !row.reviewedStart || !row.reviewedEnd || !Number.isFinite(new Date(row.reviewedStart).getTime()) || !Number.isFinite(new Date(row.reviewedEnd).getTime()))) {
      setError('Review the start and end of every selected row.'); return;
    }
    setSaving(true); setError(null); setNotice(null);
    const { data, error: recoveryError } = await supabase.rpc('recover_scheduled_timesheet', {
      p_client_request_id: scheduleRecovery.requestId, p_staff_id: scheduleRecovery.staffId,
      p_period_start: scheduleRecovery.from, p_period_end: scheduleRecovery.to,
      p_rows: rows.map((row) => ({ source_type: row.source_type, source_id: row.source_id,
        source_version: row.source_version, reviewed_start: new Date(row.reviewedStart).toISOString(),
        reviewed_end: new Date(row.reviewedEnd).toISOString(), unpaid_break_minutes: Number(row.unpaidBreak) })),
      p_overtime_hours: Number(scheduleRecovery.overtime), p_reason: scheduleRecovery.reason.trim(),
    });
    const receipt = Array.isArray(data) ? data[0] : data;
    if (recoveryError || !receipt?.id) setError(recoveryError?.message ?? 'Recovery was not confirmed. Retry with the same details.');
    else {
      setNotice(`Manual admin timesheet ${receipt.id} saved for branch check and a different corporate final reviewer. No attendance or GPS was created.`);
      setScheduleRecovery(null); await loadAll();
    }
    setSaving(false);
  };

  const correctTimesheetPay = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!payCorrection || !corporatePayrollReviewer) return;
    setSaving(true); setError(null); setNotice(null);
    const { data, error: payError } = await supabase.rpc('correct_timesheet_pay', {
      p_client_request_id: payCorrection.requestId, p_timesheet_id: payCorrection.item.id,
      p_expected_revision: payCorrection.item.revision, p_pay_code: payCorrection.code.trim() || null,
      p_hourly_rate: payCorrection.rate === '' ? null : Number(payCorrection.rate), p_reason: payCorrection.reason.trim(),
    });
    const receipt = Array.isArray(data) ? data[0] : data;
    if (payError || receipt?.id !== payCorrection.item.id) setError(payError?.message ?? 'Pay correction was not confirmed. Retry with the same details.');
    else { setNotice('Pay code/rate saved for THIS TIMESHEET ONLY. Employment rates unchanged. Branch check and a different corporate final reviewer are required again.'); setPayCorrection(null); await loadAll(); }
    setSaving(false);
  };

  const reviewTimesheetBreaks = async (item: TimesheetRow) => {
    setBreakReview({ item, rows: null }); setError(null);
    const { data, error: breakError } = await supabase.rpc('get_timesheet_break_review', { p_timesheet_id: item.id });
    if (breakError) setError(breakError.message);
    else setBreakReview((current) => current?.item.id === item.id ? { item, rows: (data ?? []) as TimesheetBreakEvidence[] } : current);
  };

  const downloadPayrollBatch = async (batchId: string) => {
    const { data, error: downloadError } = await supabase.rpc('get_timesheet_payroll_export', { p_batch_id: batchId });
    if (downloadError) { setError(`Batch ${batchId} was saved, but download failed: ${downloadError.message}. Use Download last payroll batch to retry; do not create another batch.`); return; }
    const csvCell = (value: unknown) => {
      const text = String(value ?? '');
      return `"${(/^[=+\-@\t\r]/.test(text) ? `'${text}` : text).replaceAll('"', '""')}"`;
    };
    const header = ['timesheet_id', 'staff_id', 'period_start', 'period_end', 'pay_code', 'hours', 'overtime_hours', 'hourly_rate', 'gross_amount', 'evidence_kind'];
    const csv = [header, ...(data ?? []).map((row: any) => [row.timesheet_id, row.staff_id, row.period_start, row.period_end,
      ...header.slice(4).map((key) => row.payroll_snapshot?.[key])])].map((row) => row.map(csvCell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `payroll-${batchId}.csv`; link.click();
    URL.revokeObjectURL(url);
  };

  const handlePayrollExport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving || !payrollExport || !profile?.organizationId) return;
    const organizationId = profile.organizationId;
    const scope = `${profile.id}:${organizationId}`;
    const key = JSON.stringify([profile.id, organizationId, payrollExport.from, payrollExport.to, 'csv']);
    if (payrollExportAttempt.current?.key !== key) {
      payrollExportAttempt.current = { key, id: crypto.randomUUID() };
    }
    setSaving(true); setError(null); setNotice(null);
    try {
      const { data, error: exportError } = await supabase.rpc('create_payroll_export_batch', {
        p_client_request_id: payrollExportAttempt.current.id,
        p_organization_id: organizationId,
        p_period_from: payrollExport.from,
        p_period_to: payrollExport.to,
        p_format: 'csv',
      });
      if (payrollScope.current !== scope) return;
      if (exportError) throw new Error(exportError.message);
      const receipt = Array.isArray(data) ? data.length === 1 ? data[0] : null : data;
      if (!receipt || typeof receipt.batch_id !== 'string'
        || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(receipt.batch_id)
        || !Number.isInteger(receipt.timesheet_count) || receipt.timesheet_count <= 0
        || (typeof receipt.total_hours !== 'number' && typeof receipt.total_hours !== 'string')
        || String(receipt.total_hours).trim() === ''
        || !Number.isFinite(Number(receipt.total_hours)) || Number(receipt.total_hours) < 0) {
        throw new Error('Payroll batch receipt was not confirmed.');
      }
      setNotice(`Payroll batch recorded: ${receipt.timesheet_count} timesheets, ${Number(receipt.total_hours).toFixed(2)} hours · receipt ${receipt.batch_id.slice(0, 8)}.`);
      payrollExportAttempt.current = null;
      setExportedBatchId(receipt.batch_id);
      setPayrollExport(null);
      await downloadPayrollBatch(receipt.batch_id);
      await loadAll();
    } catch (failure) {
      if (payrollScope.current === scope) {
        const detail = failure instanceof Error ? failure.message : 'Payroll batch receipt was not confirmed.';
        setError(`${detail} Retry the same dates to recover any saved batch receipt.`);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleToggleTemplate = async (templateId: string) => {
    setSaving(true); setError(null); setNotice(null);
    const { error: tplError } = await supabase.rpc('manage_shift_template', {
      p_client_request_id: crypto.randomUUID(),
      p_template_id: templateId,
      p_action: 'toggle_active',
    });
    if (tplError) setError(tplError.message);
    else {
      setNotice('Shift template status toggled.');
      await loadAll();
    }
    setSaving(false);
  };

  const manageOnboarding = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!onboardingAction) return;
    setSaving(true); setError(null); setNotice(null);
    const response = onboardingAction.ledgerId
      ? await supabase.rpc('manage_staff_onboarding', { p_ledger_id: onboardingAction.ledgerId, p_expected_version: onboardingAction.version, p_action: 'advance', p_stage: onboardingAction.nextStage, p_note: onboardingAction.note.trim(), p_assigned_to: null, p_target_start: null })
      : await supabase.rpc('start_staff_onboarding', { p_client_request_id: crypto.randomUUID(), p_staff_id: onboardingAction.staffId, p_assigned_to: null, p_target_start: null, p_note: onboardingAction.note.trim() });
    if (response.error) setError(response.error.message);
    else { setNotice(onboardingAction.ledgerId ? 'Onboarding stage advanced.' : 'Staff onboarding started.'); setOnboardingAction(null); await loadAll(); }
    setSaving(false);
  };

  const saveEmploymentSetup = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!employmentAction) return;
    setSaving(true); setError(null); setNotice(null);
    const { error: employmentError } = await supabase.rpc('set_staff_employment_setup', {
      p_staff_id: employmentAction.staffId,
      p_expected_employment_type: employmentAction.expectedEmploymentType,
      p_expected_start_date: employmentAction.expectedStartDate,
      p_expected_end_date: employmentAction.expectedEndDate,
      p_expected_role_code: employmentAction.expectedRoleCode,
      p_employment_type: employmentAction.employmentType,
      p_start_date: employmentAction.startDate,
      p_end_date: employmentAction.endDate || null,
      p_role_code: employmentAction.roleCode,
      p_reason: employmentAction.reason.trim(),
    });
    if (employmentError) setError(employmentError.message);
    else {
      setNotice(`${employmentAction.name} employment setup saved. Continue with the next onboarding requirement.`);
      setEmploymentAction(null);
      await loadAll();
    }
    setSaving(false);
  };

  const openCallout = async (period: OnCallRow) => {
    setSaving(true); setError(null); setNotice(null);
    const { error: calloutError } = await supabase.rpc('open_callout', {
      p_client_request_id: crypto.randomUUID(),
      p_on_call_period_id: period.id,
      p_dispatch_job_id: null,
      p_minimum_pay_hours: 3,
      p_after_minimum_rate: null,
      p_notes: 'Callout raised from roster HR workspace',
    });
    if (calloutError) setError(calloutError.message);
    else { setNotice('Callout raised and the assigned officer was notified.'); await loadAll(); }
    setSaving(false);
  };

  const createOnCallPeriod = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!onCallForm.officerId || !onCallForm.startsAt || !onCallForm.endsAt) return;
    setSaving(true); setError(null); setNotice(null);
    const { error: createError } = await supabase.rpc('create_on_call_period', {
      p_client_request_id: crypto.randomUUID(),
      p_officer_user_id: onCallForm.officerId,
      p_period_type: onCallForm.type,
      p_starts_at: new Date(onCallForm.startsAt).toISOString(),
      p_ends_at: new Date(onCallForm.endsAt).toISOString(),
      p_flat_rate: onCallForm.flatRate ? Number(onCallForm.flatRate) : null,
      p_linked_shift_id: null,
      p_notes: onCallForm.notes.trim() || null,
    });
    if (createError) setError(createError.message);
    else { setNotice('On-call period created and sent to the officer for acceptance.'); setOnCallForm({ officerId: '', type: 'standard', startsAt: '', endsAt: '', flatRate: '', notes: '' }); await loadAll(); }
    setSaving(false);
  };

  const scheduleCourtAppearance = async (event: React.FormEvent) => {
    event.preventDefault();
    const estimatedHours = Number(courtForm.estimatedHours);
    if (!courtForm.officerId || !courtForm.courtName.trim() || !courtForm.scheduledAt || !Number.isFinite(estimatedHours) || estimatedHours <= 0 || estimatedHours > 24) {
      setError('Choose an officer, court, valid date and an estimated duration between 0 and 24 hours.');
      return;
    }
    setSaving(true); setError(null); setNotice(null);
    const { data, error: courtError } = await supabase.rpc('schedule_court_appearance', {
      p_client_request_id: courtRequestId.current,
      p_officer_user_id: courtForm.officerId,
      p_court_name: courtForm.courtName.trim(),
      p_appearance_type: courtForm.appearanceType,
      p_scheduled_at: new Date(courtForm.scheduledAt).toISOString(),
      p_estimated_hours: estimatedHours,
      p_enforcement_case_id: null,
      p_case_reference: courtForm.caseReference.trim() || null,
      p_subpoena_reference: courtForm.subpoenaReference.trim() || null,
      p_notes: courtForm.notes.trim() || null,
    });
    if (courtError || !data) {
      setError(courtError?.message ?? 'The court appearance receipt was not confirmed.');
    } else {
      const appearance = (Array.isArray(data) ? data[0] : data) as CourtRow;
      setNotice(`Court appearance scheduled for ${staffNames[appearance.officer_user_id] ?? 'the officer'}${appearance.is_overtime ? ' and marked as overtime' : ''}.`);
      courtRequestId.current = crypto.randomUUID();
      setCourtForm({ officerId: '', courtName: '', appearanceType: 'hearing', scheduledAt: '', estimatedHours: '2', caseReference: '', subpoenaReference: '', notes: '' });
      await loadAll();
    }
    setSaving(false);
  };

  const recordCourtOutcome = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!courtOutcome) return;
    if (courtOutcome.status === 'attended' && (!courtOutcome.actualStart || !courtOutcome.actualEnd)) {
      setError('Attended appearances require actual start and end times.');
      return;
    }
    const actualStart = courtOutcome.actualStart ? new Date(courtOutcome.actualStart) : null;
    const actualEnd = courtOutcome.actualEnd ? new Date(courtOutcome.actualEnd) : null;
    if (actualStart && actualEnd && actualEnd <= actualStart) {
      setError('The court appearance end time must be after its start time.');
      return;
    }
    setSaving(true); setError(null); setNotice(null);
    const { data, error: outcomeError } = await supabase.rpc('record_court_appearance_outcome', {
      p_appearance_id: courtOutcome.appearance.id,
      p_expected_status: courtOutcome.appearance.status,
      p_status: courtOutcome.status,
      p_actual_start: actualStart?.toISOString() ?? null,
      p_actual_end: actualEnd?.toISOString() ?? null,
      p_outcome: courtOutcome.outcome.trim() || null,
    });
    if (outcomeError || !data) {
      setError(outcomeError?.message ?? 'The court appearance outcome receipt was not confirmed.');
    } else {
      setNotice(`Court appearance marked ${courtOutcome.status}. Actual time and outcome are now on the roster record.`);
      setCourtOutcome(null);
      await loadAll();
    }
    setSaving(false);
  };

  const recordCalloutMilestone = async (callout: CalloutRow, milestone: string) => {
    setSaving(true); setError(null); setNotice(null);
    const { error: milestoneError } = await supabase.rpc('record_callout_milestone', {
      p_callout_id: callout.id,
      p_milestone: milestone,
      p_expected_status: callout.status,
    });
    if (milestoneError) setError(milestoneError.message);
    else { setNotice(`Callout milestone '${milestone.replaceAll('_', ' ')}' recorded.`); await loadAll(); }
    setSaving(false);
  };

  const recordOnboardingEvidence = async (event: React.FormEvent) => {
    event.preventDefault(); if (!evidenceAction) return;
    setSaving(true); setError(null); setNotice(null);
    if (evidenceAction.action === 'add_skill') {
      const { error: skillError } = await supabase.rpc('assign_roster_skill_to_staff', {
        p_staff_id: evidenceAction.staffId, p_skill_id: evidenceAction.skillId, p_proficiency_level: evidenceAction.proficiency, p_certified: false, p_notes: evidenceAction.note.trim() || null
      });
      if (skillError) setError(skillError.message);
      else { setNotice('Skill assigned and recorded.'); setEvidenceAction(null); await loadAll(); }
    } else if (evidenceAction.action === 'record_credential') {
      const { data, error: credentialError } = await supabase.rpc('record_staff_credential', {
        p_client_request_id: crypto.randomUUID(),
        p_staff_id: evidenceAction.staffId,
        p_credential_type: evidenceAction.credentialType,
        p_credential_number: evidenceAction.credentialNumber.trim() || null,
        p_issuing_authority: evidenceAction.issuingAuthority.trim() || null,
        p_issued_date: evidenceAction.issuedDate || null,
        p_expiry_date: evidenceAction.expiryDate || null,
        p_authorized_activities: [],
        p_verified: evidenceAction.credentialVerified,
        p_evidence_notes: evidenceAction.note.trim() || null,
      });
      const receipt = Array.isArray(data) ? data[0] : data;
      if (credentialError || !receipt) setError(credentialError?.message ?? 'The credential was not confirmed.');
      else { setNotice(receipt.verified ? `${plainWords(evidenceAction.credentialType)} recorded and verified for ${evidenceAction.name}. If nothing else is holding them up, you can mark them work ready.` : `${plainWords(evidenceAction.credentialType)} recorded for ${evidenceAction.name} as unverified. Verify it with evidence before it counts towards work readiness.`); setEvidenceAction(null); await loadAll(); }
    } else if (evidenceAction.action === 'record_induction') {
      if (!evidenceAction.siteRequirementId) {
        setError('Select the site induction requirement before recording completion.');
        setSaving(false);
        return;
      }
      const { error: inductionError } = await supabase.rpc('record_staff_site_induction', {
        p_staff_id: evidenceAction.staffId,
        p_requirement_id: evidenceAction.siteRequirementId,
        p_expires_at: evidenceAction.expiresAt ? new Date(`${evidenceAction.expiresAt}T00:00:00Z`).toISOString() : null,
        p_evidence_notes: evidenceAction.note.trim() || null,
      });
      if (inductionError) setError(inductionError.message);
      else { setNotice('Site induction recorded for this staff member.'); setEvidenceAction(null); await loadAll(); }
    } else {
      const { error: evidenceError } = await supabase.rpc('manage_staff_onboarding_evidence', {
        p_client_request_id: crypto.randomUUID(), p_staff_id: evidenceAction.staffId, p_action: evidenceAction.action,
        p_skill_name: null, p_skill_category: null,
        p_proficiency_level: null, p_reports_to_user_id: evidenceAction.managerId || null,
        p_training_name: evidenceAction.trainingName.trim() || null, p_document_type: evidenceAction.documentType || null,
        p_file_name: evidenceAction.fileName.trim() || null, p_storage_path: evidenceAction.storagePath.trim() || null,
        p_notes: evidenceAction.note.trim() || null,
      });
      if (evidenceError) setError(evidenceError.message);
      else { setNotice('Staff onboarding evidence recorded.'); setEvidenceAction(null); await loadAll(); }
    }
    setSaving(false);
  };

  const nextOnboardingStage = (stage: string) => ({ identity: 'employment', employment: 'evidence', evidence: 'supervision', supervision: 'induction', induction: 'review', review: 'ready' } as Record<string, string>)[stage] ?? null;

  const openEvidence = (staffId: string, name: string, action: EvidenceActionKind) => {
    setEvidenceAction({ staffId, name, action, note: '', skillId: '', proficiency: 'competent', managerId: '', trainingName: '', siteRequirementId: '', expiresAt: '', documentType: 'policy_acknowledgement', fileName: '', storagePath: '', credentialType: 'security_licence', credentialNumber: '', issuingAuthority: '', issuedDate: '', expiryDate: '', credentialVerified: true });
  };

  const openEmploymentSetup = (person: StaffRow, name: string) => {
    if (!person.staff_id) return;
    setEmploymentAction({
      staffId: person.staff_id,
      name,
      expectedEmploymentType: person.employment_type,
      expectedStartDate: person.start_date,
      expectedEndDate: person.end_date,
      expectedRoleCode: person.role_code,
      employmentType: person.employment_type ?? 'permanent',
      startDate: person.start_date ?? '',
      endDate: person.end_date ?? '',
      roleCode: person.role_code ?? '',
      reason: 'Employment details checked for onboarding.',
    });
  };

  const onboardingPrimaryActionLabel = (ledger: StaffOnboardingRow) => {
    if (ledger.current_stage === 'identity') return ledger.identity_status === 'complete' ? 'Continue to Employment' : 'Complete identity';
    if (ledger.current_stage === 'employment') return ledger.employment_status === 'complete' ? 'Continue to Evidence' : 'Complete employment setup';
    if (ledger.current_stage === 'evidence') {
      if (ledger.evidence_status === 'complete') return 'Continue to Supervision';
      return ledger.next_action;
    }
    if (ledger.current_stage === 'supervision') return ledger.supervision_status === 'complete' ? 'Continue to Induction' : 'Assign line manager';
    if (ledger.current_stage === 'induction') return ledger.induction_status === 'complete' ? 'Continue to Review' : 'Record induction';
    if (ledger.current_stage === 'review') return ledger.work_status === 'ready' ? 'Complete onboarding' : 'Review work readiness';
    return 'Onboarding complete';
  };

  const runOnboardingPrimaryAction = (person: StaffRow, ledger: StaffOnboardingRow, name: string) => {
    const advance = () => {
      const nextStage = nextOnboardingStage(ledger.current_stage);
      if (nextStage) setOnboardingAction({ staffId: person.staff_id!, ledgerId: ledger.ledger_id, version: ledger.version, nextStage, name, note: '' });
    };
    if (ledger.current_stage === 'identity') {
      if (ledger.identity_status === 'complete') advance();
      else navigate('/admin/users');
      return;
    }
    if (ledger.current_stage === 'employment') {
      if (ledger.employment_status === 'complete') advance();
      else openEmploymentSetup(person, name);
      return;
    }
    if (ledger.current_stage === 'evidence') {
      if (ledger.evidence_status === 'complete') advance();
      else if (ledger.next_action === 'Verify credential') openEvidence(person.staff_id!, name, 'record_credential');
      else if (ledger.next_action === 'Upload evidence') openStaffProfile(person, 'onboarding');
      else openEvidence(person.staff_id!, name, 'add_skill');
      return;
    }
    if (ledger.current_stage === 'supervision') {
      if (ledger.supervision_status === 'complete') advance();
      else openEvidence(person.staff_id!, name, 'assign_line_manager');
      return;
    }
    if (ledger.current_stage === 'induction') {
      if (ledger.induction_status === 'complete') advance();
      else openEvidence(person.staff_id!, name, 'record_induction');
      return;
    }
    if (ledger.current_stage === 'review') {
      if (ledger.work_status === 'ready') advance();
      else {
        const assessment = readinessAssessments.find((item) => item.staff_id === person.staff_id);
        setReadinessNotes('');
        setReadinessReview({ staffId: person.staff_id!, name, current: assessment?.work_ready ?? false, next: true });
      }
    }
  };

  const saveCatalogSkill = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!skillCatalogDraft.name.trim()) return;
    setSaving(true); setError(null); setNotice(null);
    const { error: catalogError } = await supabase.rpc('manage_roster_skill_catalog', {
      p_skill_id: skillCatalogDraft.id,
      p_skill_name: skillCatalogDraft.name.trim(),
      p_skill_category: skillCatalogDraft.category || null,
      p_action: skillCatalogDraft.id ? 'update' : 'create',
    });
    if (catalogError) setError(catalogError.message);
    else {
      setNotice(skillCatalogDraft.id ? 'Skill catalog entry updated.' : 'Skill added to the canonical catalog.');
      setSkillCatalogDraft({ id: null, name: '', category: 'technical' });
      setShowSkillCatalogForm(false);
      await loadAll();
    }
    setSaving(false);
  };

  const deactivateCatalogSkill = async (skillId: string) => {
    setSaving(true); setError(null); setNotice(null);
    const { error: catalogError } = await supabase.rpc('manage_roster_skill_catalog', {
      p_skill_id: skillId,
      p_skill_name: null,
      p_skill_category: null,
      p_action: 'deactivate',
    });
    if (catalogError) setError(catalogError.message);
    else { setNotice('Catalog skill deactivated.'); await loadAll(); }
    setSaving(false);
  };

  const saveSiteInductionRequirement = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!profile?.organizationId || !siteInductionDraft.name.trim()) return;
    if (!siteInductionDraft.siteId && !siteInductionDraft.zoneId && !siteInductionDraft.serviceAgreementLocationId) {
      setError('Choose a site, zone, or contract location for this induction requirement.');
      return;
    }
    setSaving(true); setError(null); setNotice(null);
    const { error: inductionError } = await supabase.rpc('manage_site_induction_requirement', {
      p_requirement_id: siteInductionDraft.id,
      p_client_site_id: siteInductionDraft.siteId || null,
      p_zone_id: siteInductionDraft.zoneId || null,
      p_service_agreement_location_id: siteInductionDraft.serviceAgreementLocationId || null,
      p_induction_name: siteInductionDraft.name.trim(),
      p_version: siteInductionDraft.version.trim() || null,
      p_required: siteInductionDraft.required,
      p_expires_after_days: siteInductionDraft.expiresAfterDays ? Number(siteInductionDraft.expiresAfterDays) : null,
      p_active: siteInductionDraft.active,
      p_action: siteInductionDraft.id ? 'update' : 'create',
    });
    if (inductionError) setError(inductionError.message);
    else {
      setNotice(siteInductionDraft.id ? 'Site induction requirement updated.' : 'Site induction requirement created.');
      setSiteInductionDraft({ id: null, name: '', siteId: '', zoneId: '', serviceAgreementLocationId: '', version: '', required: true, expiresAfterDays: '', active: true });
      setShowSiteInductionForm(false);
      await loadAll();
    }
    setSaving(false);
  };

  const deactivateSiteInductionRequirement = async (requirementId: string) => {
    setSaving(true); setError(null); setNotice(null);
    const { error: requirementError } = await supabase.rpc('manage_site_induction_requirement', {
      p_requirement_id: requirementId,
      p_action: 'deactivate',
    });
    if (requirementError) setError(requirementError.message);
    else { setNotice('Site induction requirement deactivated.'); await loadAll(); }
    setSaving(false);
  };

  const createVacancy = async (event: React.FormEvent) => {
    event.preventDefault(); setSaving(true); setError(null); setNotice(null);
    const { error: createError } = await supabase.rpc('manage_recruitment_vacancy', { p_client_request_id: crypto.randomUUID(), p_action: 'create', p_vacancy_id: null, p_title: vacancyForm.title.trim(), p_employment_type: vacancyForm.employmentType, p_location_summary: vacancyForm.location.trim() || null, p_opens_on: null, p_closes_on: null, p_description: null, p_required_skills: [] });
    if (createError) setError(createError.message);
    else { setNotice('Vacancy created as draft. Open it when ready to receive candidates.'); setVacancyForm({ title: '', employmentType: 'permanent', location: '' }); setShowVacancyForm(false); await loadAll(); }
    setSaving(false);
  };

  const createCandidate = async (event: React.FormEvent) => {
    event.preventDefault(); setSaving(true); setError(null); setNotice(null);
    const { error: createError } = await supabase.rpc('create_recruitment_candidate', { p_client_request_id: crypto.randomUUID(), p_vacancy_id: candidateForm.vacancyId, p_first_name: candidateForm.firstName.trim(), p_last_name: candidateForm.lastName.trim(), p_email: candidateForm.email.trim(), p_phone: candidateForm.phone.trim() || null, p_source: null, p_resume_storage_path: null, p_notes: null });
    if (createError) setError(createError.message);
    else { setNotice('Candidate added at applied stage.'); setCandidateForm({ vacancyId: '', firstName: '', lastName: '', email: '', phone: '' }); setShowCandidateForm(false); await loadAll(); }
    setSaving(false);
  };

  const manageVacancy = async (vacancy: RecruitmentVacancy, action: 'open' | 'close') => {
    setSaving(true); setError(null); setNotice(null);
    const { error: manageError } = await supabase.rpc('manage_recruitment_vacancy', { p_client_request_id: crypto.randomUUID(), p_action: action, p_vacancy_id: vacancy.id, p_title: null, p_employment_type: null, p_location_summary: null, p_opens_on: null, p_closes_on: null, p_description: null, p_required_skills: [] });
    if (manageError) setError(manageError.message); else { setNotice(`Vacancy ${action}ed.`); await loadAll(); }
    setSaving(false);
  };

  const advanceCandidate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!candidateAction) return;
    if (candidateAction.nextStage === 'offer') {
      setOfferError(null); setOfferAction({ candidate: candidateAction.candidate, role: 'officer', employmentType: 'permanent', startDate: '', note: candidateAction.note, accepted: false, branchId: '' });
      setCandidateAction(null);
      return;
    }
    setSaving(true); setError(null); setNotice(null);
    const { error: advanceError } = await supabase.rpc('manage_recruitment_candidate', { p_candidate_id: candidateAction.candidate.id, p_expected_stage: candidateAction.candidate.stage, p_next_stage: candidateAction.nextStage, p_note: candidateAction.note.trim(), p_offer_role: candidateAction.nextStage === 'offer' ? candidateAction.offerRole : null, p_offer_employment_type: candidateAction.nextStage === 'offer' ? candidateAction.offerEmploymentType : null, p_offer_start_date: candidateAction.nextStage === 'offer' ? candidateAction.offerStartDate : null });
    if (advanceError) setError(advanceError.message);
    else {
      const nextLabel = candidateAction.nextStage === 'declined' ? 'not suitable' : candidateAction.nextStage.replaceAll('_', ' ');
      setNotice(candidateAction.nextStage === 'declined' ? 'Candidate marked as not suitable and declined.' : `Candidate moved to ${nextLabel}.`);
      setCandidateAction(null); await loadAll();
    }
    setSaving(false);
  };

  const sendOffer = async (event: React.FormEvent) => {
    event.preventDefault(); if (!offerAction) return;
    if (offerAction.accepted && !hireBranches.some((branch) => branch.id === offerAction.branchId)) {
      setOfferError('Choose the delivery branch they will be rostered at.');
      return;
    }
    setSaving(true); setError(null); setNotice(null); setOfferError(null);
    const { error: recordOfferError } = await supabase.rpc('manage_recruitment_candidate', { p_candidate_id: offerAction.candidate.id, p_expected_stage: offerAction.candidate.stage, p_next_stage: 'offer', p_note: offerAction.note.trim(), p_offer_role: offerAction.role, p_offer_employment_type: offerAction.employmentType, p_offer_start_date: offerAction.startDate });
    if (recordOfferError) setOfferError(recordOfferError.message);
    else if (offerAction.accepted && profile?.organizationId) {
      try {
        const candidate = offerAction.candidate;
        const branchOrganizationId = offerAction.branchId;
        const { data: provisioned, error: provisionError } = await supabase.functions.invoke('create-user', { body: { email: candidate.email, display_name: `${candidate.first_name} ${candidate.last_name}`.trim(), role: offerAction.role, organization_id: profile.organizationId, employer_organization_id: profile.employerOrganizationId ?? profile.organizationId, staff: { employment_type: offerAction.employmentType, start_date: offerAction.startDate }, branch_authorisations: [{ branch_org_id: branchOrganizationId, role_at_branch: 'officer', module_access: [], can_be_rostered: true }] } });
        if (provisionError) {
          const response = 'context' in provisionError && provisionError.context instanceof Response ? await provisionError.context.json().catch(() => null) : null;
          throw new Error(response?.error ?? provisionError.message);
        }
        if (!provisioned?.user_id || !provisioned?.staff_id) throw new Error('Identity provisioning receipt was not confirmed.');
        const { error: convertError } = await supabase.rpc('convert_recruitment_candidate_to_staff', { p_candidate_id: candidate.id, p_user_id: provisioned.user_id, p_staff_id: provisioned.staff_id, p_note: offerAction.note.trim() });
        if (convertError) throw convertError;
        const params = new URLSearchParams({ profile: provisioned.staff_id, profileTab: 'onboarding' });
        setOfferAction(null);
        setSaving(false);
        navigate({ pathname: staffProfileHref, search: params.toString() }, {
          state: { notice: `${candidate.first_name} ${candidate.last_name} hired. Their login and staff record are ready for profile-based onboarding.` },
        });
        return;
      } catch (conversionError) {
        // Keep the dialog open so the reason is visible next to the action that failed.
        setOfferError(`Offer is recorded, but hiring did not finish: ${conversionError instanceof Error ? conversionError.message : 'staff provisioning could not be confirmed.'}`);
        await loadAll();
      }
    } else { setNotice('Offer recorded. Provision only after acceptance is confirmed.'); setOfferAction(null); await loadAll(); }
    setSaving(false);
  };

  const createPerformanceCycle = async (event: React.FormEvent) => {
    event.preventDefault(); setSaving(true); setError(null); setNotice(null);
    const { error: createError } = await supabase.rpc('manage_performance_review_cycle', { p_client_request_id: crypto.randomUUID(), p_action: 'create', p_cycle_id: null, p_name: cycleForm.name.trim(), p_period_start: cycleForm.start, p_period_end: cycleForm.end, p_due_date: cycleForm.due });
    if (createError) setError(createError.message); else { setNotice('Performance review cycle created as draft.'); setCycleForm({ name: '', start: '', end: '', due: '' }); setShowCycleForm(false); await loadAll(); }
    setSaving(false);
  };

  const transitionCycle = async (cycle: PerformanceCycle, action: 'open' | 'close') => {
    setSaving(true); setError(null); setNotice(null);
    const { error: transitionError } = await supabase.rpc('manage_performance_review_cycle', { p_client_request_id: crypto.randomUUID(), p_action: action, p_cycle_id: cycle.id, p_name: null, p_period_start: null, p_period_end: null, p_due_date: null });
    if (transitionError) setError(transitionError.message); else { setNotice(`Review cycle ${action}ed.`); await loadAll(); }
    setSaving(false);
  };

  const createPerformanceReview = async (event: React.FormEvent) => {
    event.preventDefault(); setSaving(true); setError(null); setNotice(null);
    const { error: createError } = await supabase.rpc('create_performance_review', { p_client_request_id: crypto.randomUUID(), p_cycle_id: reviewForm.cycleId, p_staff_id: reviewForm.staffId, p_reviewer_user_id: reviewForm.reviewerId });
    if (createError) setError(createError.message); else { setNotice('Performance review assigned.'); setReviewForm({ cycleId: '', staffId: '', reviewerId: '' }); setShowReviewForm(false); await loadAll(); }
    setSaving(false);
  };

  const completeReview = async (event: React.FormEvent) => {
    event.preventDefault(); if (!reviewAction) return;
    setSaving(true); setError(null); setNotice(null);
    const { error: completeError } = await supabase.rpc('complete_performance_review', { p_review_id: reviewAction.id, p_expected_status: reviewAction.status, p_rating: Number(reviewCompletion.rating), p_strengths: reviewCompletion.strengths.trim() || null, p_development_goals: reviewCompletion.goals.trim() || null, p_employee_comments: reviewCompletion.comments.trim() || null });
    if (completeError) setError(completeError.message); else { setNotice('Performance review completed and retained.'); setReviewAction(null); await loadAll(); }
    setSaving(false);
  };

  const createHrCase = async (event: React.FormEvent) => {
    event.preventDefault(); setSaving(true); setError(null); setNotice(null);
    const { error: createError } = await supabase.rpc('manage_hr_case', { p_client_request_id: crypto.randomUUID(), p_action: 'open', p_case_id: null, p_staff_id: caseForm.staffId, p_case_type: caseForm.type, p_severity: caseForm.severity, p_subject: caseForm.subject.trim(), p_summary: caseForm.summary.trim(), p_note: null, p_assigned_to: null });
    if (createError) setError(createError.message); else { setNotice('Private HR case opened and audit recorded.'); setCaseForm({ staffId: '', type: 'conduct', severity: 'standard', subject: '', summary: '' }); setShowCaseForm(false); await loadAll(); }
    setSaving(false);
  };

  const manageHrCase = async (event: React.FormEvent) => {
    event.preventDefault(); if (!caseAction) return;
    setSaving(true); setError(null); setNotice(null);
    const { error: manageError } = await supabase.rpc('manage_hr_case', { p_client_request_id: crypto.randomUUID(), p_action: caseAction.action, p_case_id: caseAction.item.id, p_staff_id: null, p_case_type: null, p_severity: null, p_subject: null, p_summary: null, p_note: caseAction.note.trim(), p_assigned_to: null });
    if (manageError) setError(manageError.message);
    else { setNotice(caseAction.action === 'note' ? 'Private case note recorded.' : `HR case ${caseAction.action}ed.`); setCaseAction(null); await loadAll(); }
    setSaving(false);
  };

  const isExpiringSoon = (expiryDate: string | null) => {
    if (!expiryDate) return false;
    const days = (new Date(expiryDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    return days <= 30;
  };

  const staffAttention = useMemo(() => Object.fromEntries(staff.filter((person) => person.staff_id).map((person) => {
    const staffId = person.staff_id!;
    const reasons: string[] = [];
    const levels: AttentionLevel[] = [];
    credentials.filter((item) => item.staff_id === staffId).forEach((item) => {
      const level = item.verified ? expiryAttention(item.expiry_date) : 'overdue';
      levels.push(level);
      if (!item.verified) reasons.push(`${credentialTypeLabel(item.credential_type)} is unverified`);
      else if (level !== 'clear') reasons.push(`${credentialTypeLabel(item.credential_type)} ${level === 'overdue' ? 'has expired' : 'expires soon'}`);
    });
    trainingRecords.filter((item) => item.staff_id === staffId).forEach((item) => {
      const level = expiryAttention(item.expiry_date);
      levels.push(level);
      if (level !== 'clear') reasons.push(`${item.training_name} ${level === 'overdue' ? 'has expired' : 'expires soon'}`);
    });
    staffSiteInductions.filter((item) => item.staff_id === staffId).forEach((item) => {
      const level = expiryAttention(item.expires_at);
      levels.push(level);
      if (level !== 'clear') reasons.push(`Site induction ${level === 'overdue' ? 'has expired' : 'expires soon'}`);
    });
    const readiness = readinessAssessments.find((item) => item.staff_id === staffId);
    if (readiness?.credential_status === 'attention' || readiness?.training_status === 'attention') levels.push('overdue');
    if (readiness?.blockers?.length) reasons.push(...readiness.blockers);
    const level = strongestAttention(...levels);
    return [staffId, { level, reasons: [...new Set(reasons)] }];
  })), [credentials, readinessAssessments, staff, staffSiteInductions, trainingRecords]);

  const filteredStaff = useMemo(() => {
    const search = staffSearch.trim().toLocaleLowerCase('en-NZ');
    return [...staff]
      .sort((left, right) => (left.display_name || left.email || '').localeCompare(right.display_name || right.email || '', 'en-NZ', { sensitivity: 'base' }))
      .filter((person) => [person.display_name, person.email, person.role_code, person.employment_type, person.work_ready ? 'work ready' : 'not work ready']
        .filter(Boolean).join(' ').toLocaleLowerCase('en-NZ').includes(search));
  }, [staff, staffSearch]);

  const filteredOnboardingPeople = useMemo(() => {
    const search = onboardingSearch.trim().toLocaleLowerCase('en-NZ');
    return staff.filter((person) => person.staff_id)
      .map((person) => ({ person, ledger: onboarding.find((item) => item.staff_id === person.staff_id) }))
      .filter(({ person, ledger }) => [person.display_name, person.email, ledger?.current_stage, ledger?.status, ledger?.next_action, ...(ledger?.blockers ?? [])]
        .filter(Boolean).join(' ').toLocaleLowerCase('en-NZ').includes(search))
      .sort((left, right) => (left.person.display_name || left.person.email || '').localeCompare(right.person.display_name || right.person.email || '', 'en-NZ', { sensitivity: 'base' }));
  }, [onboarding, onboardingSearch, staff]);

  if (loading) {
    return (
      <div className="page-container roster-hr-page" data-surface="dark">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading roster & HR data...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container roster-hr-page" data-surface="dark">
      {timesheetCorrection && <div className="hr-review-backdrop"><form className="hr-review-dialog" role="dialog" aria-modal="true" aria-labelledby="timesheet-correction-title" onSubmit={correctTimesheet}><header><div><span>Payroll correction</span><h2 id="timesheet-correction-title">Edit timesheet hours</h2></div><button type="button" onClick={() => setTimesheetCorrection(null)} aria-label="Close timesheet correction">×</button></header><p>Correction returns the timesheet to submitted review and records before/after values in the audit trail.</p><label><span>Actual hours</span><input type="number" min="0" max="744" step="0.25" required value={timesheetCorrection.actualHours} onChange={(event) => setTimesheetCorrection({ ...timesheetCorrection, actualHours: event.target.value })} /></label><label><span>Overtime hours</span><input type="number" min="0" max="744" step="0.25" required value={timesheetCorrection.overtimeHours} onChange={(event) => setTimesheetCorrection({ ...timesheetCorrection, overtimeHours: event.target.value })} /></label><label><span>Correction reason</span><textarea required rows={4} value={timesheetCorrection.reason} onChange={(event) => setTimesheetCorrection({ ...timesheetCorrection, reason: event.target.value })} /></label><footer><button type="button" className="btn btn-secondary" onClick={() => setTimesheetCorrection(null)}>Cancel</button><button type="submit" className="btn btn-primary" disabled={saving || !timesheetCorrection.reason.trim()}>Save correction</button></footer></form></div>}
      {swapReview && <div className="hr-review-backdrop"><form className="hr-review-dialog" role="dialog" aria-modal="true" aria-labelledby="shift-swap-review-title" onSubmit={reviewSwap}><header><div><span>Roster governance</span><h2 id="shift-swap-review-title">{swapReview.decision === 'approved' ? 'Approve' : 'Decline'} shift swap?</h2></div><button type="button" onClick={() => setSwapReview(null)} aria-label="Close shift swap review">×</button></header><p>Approval transfers ownership of the unstarted shift and its linked roster slot. Declined requests remain in the audit history.</p><label><span>Review notes</span><textarea rows={4} required={swapReview.decision === 'declined'} value={reviewNotes} onChange={(event) => setReviewNotes(event.target.value)} /></label><footer><button type="button" className="btn btn-secondary" onClick={() => setSwapReview(null)}>Cancel</button><button type="submit" className={swapReview.decision === 'declined' ? 'btn btn-danger' : 'btn btn-primary'} disabled={saving || (swapReview.decision === 'declined' && !reviewNotes.trim())}>{saving ? 'Saving' : 'Confirm decision'}</button></footer></form></div>}
      <header className="page-header">
        <h1>{rosteringView ? 'Shift setup & open shifts' : 'People, pay & HR'}</h1>
        <p className="subtitle">{rosteringView ? 'Shift templates, rest rules, open shifts, on-call and court' : `${staff.length} staff · Onboarding, credentials, leave, timesheets`}</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}
      {notice && <div className="alert alert-success" role="status">{notice}</div>}
      {evidenceAction?.action === 'record_induction' && siteInductionState.length > 0 && <div className="alert alert-info" role="status">Current induction state: {siteInductionState.filter((item) => item.completed).length} of {siteInductionState.length} requirements complete.</div>}

      {visibleTabGroups.length > 1 && <div className="crm-branch-filter" aria-label="People and HR workspace">
        {visibleTabGroups.map((group) => (
          <button type="button" key={group.id} className={`btn btn-sm ${tabGroup === group.id ? 'btn-primary' : 'btn-secondary'}`} onClick={() => { setTabGroup(group.id); setTab(group.tabs[0]); }}>
            {group.label}
          </button>
        ))}
      </div>}
      <div className="roster-hr-tab-list" aria-label={`${visibleTabGroups.find((group) => group.id === tabGroup)?.label} views`}>
        {TABS.filter((item) => viewTabs.has(item.id) && tabGroupFor(item.id) === tabGroup).map((t) => (
          <button
            key={t.id}
            className={`btn btn-sm ${tab === t.id ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => { setTab(t.id); setTabGroup(tabGroupFor(t.id)); }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="hr-workbench-scroll" aria-label="HR workspace content">
      {tab === 'staff' && canManagePayRoles && (
        <section className="reports-section hr-pay-role-code-section">
          <header className="page-header">
            <div>
              <span className="contact-meta">Payroll setup</span>
              <h2>Payroll role codes</h2>
              <p className="subtitle">Create the organisation-owned code first, assign it to each staff profile, then add a matching pay rule for each operating branch. This is separate from login and branch-access roles.</p>
            </div>
            <div className="assessment-actions">
              <button type="button" className="btn btn-sm btn-secondary" onClick={() => navigate('/admin/rate-rules')}>Set branch pay rules</button>
              <button type="button" className="btn btn-sm btn-primary" onClick={() => setShowPayRoleCodeForm((open) => !open)}>{showPayRoleCodeForm ? 'Cancel' : 'Add payroll role code'}</button>
            </div>
          </header>
          {roleCodes.length === 0 ? (
            <div className="empty-state"><p><strong>No active payroll role codes.</strong> Create one here before assigning Payroll role to staff.</p></div>
          ) : (
            <div className="contacts-list">
              {roleCodes.map((code) => <div className="contact-card" key={code.id ?? code.code}>
                <div className="contact-header"><h3>{code.code}</h3><span className="contact-type-badge">Payroll role</span></div>
                <div className="contact-details"><p>{code.name}</p></div>
                {code.id && <button type="button" className="btn btn-sm btn-secondary" disabled={saving} onClick={() => void deactivatePayRoleCode(code)}>Deactivate code</button>}
              </div>)}
            </div>
          )}
          {showPayRoleCodeForm && <form className="assessment-form" onSubmit={(event) => void createPayRoleCode(event)}>
            <div className="form-row">
              <label><span>Role name</span><input required maxLength={120} value={payRoleCodeForm.name} onChange={(event) => {
                const name = event.target.value;
                setPayRoleCodeForm((current) => ({ name, code: current.code === payrollCodeFromName(current.name) ? payrollCodeFromName(name) : current.code }));
              }} placeholder="Office Staff" /></label>
              <label><span>Payroll role code</span><input required maxLength={32} value={payRoleCodeForm.code} onChange={(event) => setPayRoleCodeForm((form) => ({ ...form, code: payrollCodeFromName(event.target.value) }))} aria-describedby="payroll-role-code-help" placeholder="OFFICE_STAFF" /></label>
            </div>
            <p id="payroll-role-code-help" className="contact-meta">The code is generated from the role name and is used to match staff to branch pay rules. Spaces become underscores.</p>
            {payRoleCodeForm.code && !validPayrollCode(payRoleCodeForm.code) && <p className="alert alert-error" role="alert">Use letters, numbers, underscores, or hyphens.</p>}
            <button type="submit" className="btn btn-primary" disabled={saving || !payRoleCodeForm.name.trim() || !validPayrollCode(payRoleCodeForm.code)}>{saving ? 'Creating…' : 'Create payroll role code'}</button>
          </form>}
        </section>
      )}

      {tab === 'staff' && (
        <section className="reports-section">
          <h2>Staff ({staff.length})</h2>
          <p className="hr-section-hint">Search one row per person, then open their complete profile in an independent window so this workspace remains available on the first screen.</p>
          <div className="hr-start-panel" aria-label="People and HR next steps">
            <div>
              <strong>What are you here to do?</strong>
              <span>Choose the task, then follow the person or record through to the next step.</span>
            </div>
            {roleTabs.has('recruitment') && <button type="button" className="btn btn-sm btn-secondary" onClick={() => { setTab('recruitment'); setTabGroup(tabGroupFor('recruitment')); }}>Hire someone</button>}
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => { setTab('onboarding'); setTabGroup(tabGroupFor('onboarding')); }}>Prepare someone to work</button>
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => { setTab('credentials'); setTabGroup(tabGroupFor('credentials')); }}>Check credentials</button>
          </div>
          <div className="hr-staff-directory-tools">
            <label><span>Search staff</span><input type="search" value={staffSearch} onChange={(event) => setStaffSearch(event.target.value)} placeholder="Name, email, payroll role, employment or readiness" /></label>
            <span>{filteredStaff.length} shown</span>
          </div>
          <div className="reports-table-wrapper hr-staff-directory">
            {staff.length === 0 ? (
              <div className="empty-state hr-empty-guide">
                <p><strong>No staff yet.</strong></p>
                <p>Field staff are created when a recruitment offer is accepted and the person is hired. Office and admin users are added under People &amp; Access.</p>
                <button type="button" className="btn btn-sm btn-primary" onClick={() => { setTab('recruitment'); setTabGroup(tabGroupFor('recruitment')); }}>Open Recruitment</button>
              </div>
            ) : <table className="reports-table"><thead><tr><th>Name</th><th>Attention</th><th>Employment</th><th>Payroll role</th><th>Readiness</th><th>Contact</th><th>Action</th></tr></thead><tbody>
              {filteredStaff.map((s) => {
                const attention = s.staff_id ? staffAttention[s.staff_id] ?? { level: 'clear' as AttentionLevel, reasons: [] } : { level: 'overdue' as AttentionLevel, reasons: ['No staff profile'] };
                return (
                <tr key={s.id}>
                  <td><button type="button" className="hr-staff-name-button" disabled={!s.staff_id} onClick={() => openStaffProfile(s)}><strong>{s.display_name || s.email || 'Unnamed'}</strong><small>{s.email ?? 'No email recorded'}</small></button></td>
                  <td><span className={`hr-attention hr-attention-${attention.level}`} title={attention.reasons.join(' · ') || 'No credential, training, or induction deadlines require attention'}><span aria-hidden="true" />{attentionLabel[attention.level]}</span></td>
                  <td>{plainWords(s.employment_type, 'Not set')}{s.start_date ? <small> · since {new Date(s.start_date).toLocaleDateString('en-NZ')}</small> : null}</td>
                  <td>{s.role_code ?? 'Not assigned'}</td>
                  <td><span className={`status-badge ${s.work_ready ? 'status-active' : 'status-pending'}`}>{s.staff_id ? (s.work_ready ? 'Work ready' : 'Not work ready') : 'No staff profile'}</span></td>
                  <td>{s.email ?? 'No email'}</td>
                  <td><button type="button" className="btn btn-sm btn-primary" disabled={!s.staff_id} onClick={() => openStaffProfile(s)}>Open profile ↗</button></td>
                </tr>
              );})}
              {staff.length > 0 && filteredStaff.length === 0 && <tr><td colSpan={7} className="text-center">No staff match this search.</td></tr>}
            </tbody></table>}
          </div>

          <details className="hr-setup-details">
            <summary>Workforce setup</summary>
            <p className="hr-section-hint">These lists change the rules used by onboarding and rostering. Most people do not need to open them for day-to-day staff work.</p>
          <h2 style={{ marginTop: '1.5rem' }}>Skill catalog</h2>
          <p className="hr-section-hint">Reference list of skills a work unit can require and a staff member can hold.</p>
          <div className="assessment-actions" style={{ marginBottom: '1rem' }}>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => { setShowSkillCatalogForm((value) => !value); if (!showSkillCatalogForm) setSkillCatalogDraft({ id: null, name: '', category: 'technical' }); }}>
              {showSkillCatalogForm ? 'Cancel' : 'Add catalog skill'}
            </button>
          </div>
          {showSkillCatalogForm && (
            <form className="assessment-form" onSubmit={saveCatalogSkill} style={{ marginBottom: '1rem' }}>
              <div className="form-row">
                <label>
                  <span>Skill name</span>
                  <input required value={skillCatalogDraft.name} onChange={(event) => setSkillCatalogDraft({ ...skillCatalogDraft, name: event.target.value })} />
                </label>
                <label>
                  <span>Category</span>
                  <select value={skillCatalogDraft.category} onChange={(event) => setSkillCatalogDraft({ ...skillCatalogDraft, category: event.target.value })}>
                    <option value="enforcement">Enforcement</option>
                    <option value="technical">Technical</option>
                    <option value="medical">Medical</option>
                    <option value="language">Language</option>
                    <option value="driving">Driving</option>
                    <option value="equipment">Equipment</option>
                    <option value="other">Other</option>
                  </select>
                </label>
              </div>
              <button type="submit" className="btn btn-primary" disabled={saving || !skillCatalogDraft.name.trim()}>{saving ? 'Saving' : 'Save skill'}</button>
            </form>
          )}
          <div className="contacts-list">
            {catalogSkills.length === 0 ? (
              <div className="empty-state"><p>No canonical roster skills configured.</p></div>
            ) : (
              catalogSkills.map((skill) => (
                <div key={skill.id} className="contact-card">
                  <div className="contact-header">
                    <h3>{skill.skill_name}</h3>
                    <span className={`status-badge ${skill.active ? 'status-active' : 'status-inactive'}`}>{skill.active ? 'active' : 'inactive'}</span>
                  </div>
                  <div className="contact-details">
                    <p>{skill.skill_category || 'uncategorised'}</p>
                  </div>
                  <div className="assessment-actions">
                    <button type="button" className="btn btn-sm btn-secondary" onClick={() => { setSkillCatalogDraft({ id: skill.id, name: skill.skill_name, category: skill.skill_category || 'technical' }); setShowSkillCatalogForm(true); }}>Edit</button>
                    <button type="button" className="btn btn-sm btn-danger" disabled={!skill.active || saving} onClick={() => void deactivateCatalogSkill(skill.id)}>Deactivate</button>
                  </div>
                </div>
              ))
            )}
          </div>

          <h2 style={{ marginTop: '1.5rem' }}>Site induction requirements</h2>
          <div className="assessment-actions" style={{ marginBottom: '1rem' }}>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => { setShowSiteInductionForm((value) => !value); if (!showSiteInductionForm) setSiteInductionDraft({ id: null, name: '', siteId: '', zoneId: '', serviceAgreementLocationId: '', version: '', required: true, expiresAfterDays: '', active: true }); }}>
              {showSiteInductionForm ? 'Cancel' : 'Add site induction'}
            </button>
          </div>
          {showSiteInductionForm && (
            <form className="assessment-form" onSubmit={saveSiteInductionRequirement} style={{ marginBottom: '1rem' }}>
              <div className="form-row">
                <label>
                  <span>Induction name</span>
                  <input required value={siteInductionDraft.name} onChange={(event) => setSiteInductionDraft({ ...siteInductionDraft, name: event.target.value })} />
                </label>
                <label>
                  <span>Version</span>
                  <input value={siteInductionDraft.version} onChange={(event) => setSiteInductionDraft({ ...siteInductionDraft, version: event.target.value })} placeholder="e.g. 2026.1" />
                </label>
              </div>
              <div className="form-row">
                <label>
                  <span>Site</span>
                  <select value={siteInductionDraft.siteId} onChange={(event) => setSiteInductionDraft({ ...siteInductionDraft, siteId: event.target.value, zoneId: '', serviceAgreementLocationId: '' })}>
                    <option value="">No site</option>
                    {sites.map((site) => <option value={site.id} key={site.id}>{site.name}</option>)}
                  </select>
                </label>
                <label>
                  <span>Zone</span>
                  <select value={siteInductionDraft.zoneId} onChange={(event) => setSiteInductionDraft({ ...siteInductionDraft, zoneId: event.target.value, siteId: '', serviceAgreementLocationId: '' })}>
                    <option value="">No zone</option>
                    {zones.map((zone) => <option value={zone.id} key={zone.id}>{zone.name}</option>)}
                  </select>
                </label>
              </div>
              <div className="form-row">
                <label>
                  <span>Agreement location</span>
                  <select value={siteInductionDraft.serviceAgreementLocationId} onChange={(event) => setSiteInductionDraft({ ...siteInductionDraft, serviceAgreementLocationId: event.target.value, siteId: '', zoneId: '' })}>
                    <option value="">No service agreement location</option>
                    {agreementLocations.map((location) => <option value={location.id} key={location.id}>{location.site_id ? `${sites.find((site) => site.id === location.site_id)?.name ?? 'Site'} / ${zones.find((zone) => zone.id === location.zone_id)?.name ?? 'Zone'}` : location.zone_id ? `Zone ${zones.find((zone) => zone.id === location.zone_id)?.name ?? 'Unknown'}` : `Location ${location.id.slice(0, 8)}`}</option>)}
                  </select>
                </label>
                <label>
                  <span>Expiry (days)</span>
                  <input type="number" min="0" value={siteInductionDraft.expiresAfterDays} onChange={(event) => setSiteInductionDraft({ ...siteInductionDraft, expiresAfterDays: event.target.value })} placeholder="365" />
                </label>
              </div>
              <div className="form-row">
                <label>
                  <span>Required</span>
                  <select value={siteInductionDraft.required ? 'true' : 'false'} onChange={(event) => setSiteInductionDraft({ ...siteInductionDraft, required: event.target.value === 'true' })}>
                    <option value="true">Required</option>
                    <option value="false">Optional</option>
                  </select>
                </label>
                <label>
                  <span>Active</span>
                  <select value={siteInductionDraft.active ? 'true' : 'false'} onChange={(event) => setSiteInductionDraft({ ...siteInductionDraft, active: event.target.value === 'true' })}>
                    <option value="true">Active</option>
                    <option value="false">Inactive</option>
                  </select>
                </label>
              </div>
              <button type="submit" className="btn btn-primary" disabled={saving || !siteInductionDraft.name.trim()}>{saving ? 'Saving' : 'Save induction'}</button>
            </form>
          )}
          <div className="contacts-list">
            {siteInductionRequirements.length === 0 ? (
              <div className="empty-state"><p>No site induction requirements configured.</p></div>
            ) : (
              siteInductionRequirements.map((requirement) => (
                <div key={requirement.id} className="contact-card">
                  <div className="contact-header">
                    <h3>{requirement.induction_name}</h3>
                    <span className={`status-badge ${requirement.active ? 'status-active' : 'status-inactive'}`}>{requirement.active ? 'active' : 'inactive'}</span>
                  </div>
                  <div className="contact-details">
                    <p>{requirement.required ? 'Required' : 'Optional'}{requirement.expires_after_days ? ` · expires in ${requirement.expires_after_days} days` : ''}{requirement.version ? ` · v${requirement.version}` : ''}</p>
                    <p className="contact-meta">{requirement.client_site_id ? `Site ${sites.find((site) => site.id === requirement.client_site_id)?.name ?? requirement.client_site_id.slice(0,8)}` : requirement.zone_id ? `Zone ${zones.find((zone) => zone.id === requirement.zone_id)?.name ?? requirement.zone_id.slice(0,8)}` : requirement.service_agreement_location_id ? `Location ${agreementLocations.find((location) => location.id === requirement.service_agreement_location_id)?.id.slice(0,8) ?? requirement.service_agreement_location_id.slice(0,8)}` : 'Unscoped requirement'}</p>
                  </div>
                  <div className="assessment-actions">
                    <button type="button" className="btn btn-sm btn-secondary" onClick={() => { setSiteInductionDraft({ id: requirement.id, name: requirement.induction_name, siteId: requirement.client_site_id ?? '', zoneId: requirement.zone_id ?? '', serviceAgreementLocationId: requirement.service_agreement_location_id ?? '', version: requirement.version ?? '', required: requirement.required, expiresAfterDays: requirement.expires_after_days ? String(requirement.expires_after_days) : '', active: requirement.active }); setShowSiteInductionForm(true); }}>Edit</button>
                    <button type="button" className="btn btn-sm btn-danger" disabled={!requirement.active || saving} onClick={() => void deactivateSiteInductionRequirement(requirement.id)}>Deactivate</button>
                  </div>
                </div>
              ))
            )}
          </div>

          </details>

          <h2 style={{ marginTop: '1.5rem' }}>Shift swap requests ({shiftSwaps.filter((item) => item.status === 'pending').length})</h2>
          <div className="contacts-list">
            {shiftSwaps.filter((item) => item.status === 'pending').length === 0 ? <div className="empty-state"><p>No pending shift swaps.</p></div> : shiftSwaps.filter((item) => item.status === 'pending').map((swap) => <div className="contact-card" key={swap.id}><div className="contact-header"><h3>{swap.swap_type.replaceAll('_', ' ')} swap · {swap.original_shift_id.slice(0, 8)}</h3><span className="status-badge status-pending">pending</span></div><p>{swap.reason ?? 'No reason recorded.'}</p><small>Requested by {staffNames[swap.requested_by] ?? swap.requested_by} · {new Date(swap.requested_at).toLocaleString('en-NZ')}</small><div className="assessment-actions"><button type="button" className="btn btn-sm btn-secondary" onClick={() => { setReviewNotes(''); setSwapReview({ item: swap, decision: 'approved' }); }}>Approve swap</button><button type="button" className="btn btn-sm btn-danger" onClick={() => { setReviewNotes(''); setSwapReview({ item: swap, decision: 'declined' }); }}>Decline swap</button></div></div>)}
          </div>
        </section>
      )}

      {tab === 'recruitment' && (
        <section className="reports-section">
          <h2>Recruitment</h2>
          <div className="assessment-actions" style={{ marginBottom: '1rem' }}><button type="button" className="btn btn-sm btn-primary" onClick={() => setShowVacancyForm((value) => !value)}>{showVacancyForm ? 'Cancel' : 'New vacancy'}</button><button type="button" className="btn btn-sm btn-secondary" disabled={!vacancies.some((vacancy) => vacancy.status === 'open')} onClick={() => setShowCandidateForm((value) => !value)}>{showCandidateForm ? 'Cancel' : 'Add candidate'}</button></div>
          {showVacancyForm && <form className="assessment-form" onSubmit={createVacancy}><div className="form-row"><label><span>Role title</span><input required value={vacancyForm.title} onChange={(event) => setVacancyForm({ ...vacancyForm, title: event.target.value })} /></label><label><span>Employment type</span><select value={vacancyForm.employmentType} onChange={(event) => setVacancyForm({ ...vacancyForm, employmentType: event.target.value })}><option value="permanent">Permanent</option><option value="part_time">Part time</option><option value="casual">Casual</option><option value="contractor">Contractor</option><option value="volunteer">Volunteer</option></select></label></div><label><span>Location summary</span><input value={vacancyForm.location} onChange={(event) => setVacancyForm({ ...vacancyForm, location: event.target.value })} /></label><button type="submit" className="btn btn-primary" disabled={saving || !vacancyForm.title.trim()}>{saving ? 'Saving' : 'Create draft vacancy'}</button></form>}
          {showCandidateForm && <form className="assessment-form" onSubmit={createCandidate}><label><span>Open vacancy</span><select required value={candidateForm.vacancyId} onChange={(event) => setCandidateForm({ ...candidateForm, vacancyId: event.target.value })}><option value="">Select vacancy</option>{vacancies.filter((vacancy) => vacancy.status === 'open').map((vacancy) => <option value={vacancy.id} key={vacancy.id}>{vacancy.title}</option>)}</select></label><div className="form-row"><label><span>First name</span><input required value={candidateForm.firstName} onChange={(event) => setCandidateForm({ ...candidateForm, firstName: event.target.value })} /></label><label><span>Last name</span><input required value={candidateForm.lastName} onChange={(event) => setCandidateForm({ ...candidateForm, lastName: event.target.value })} /></label></div><div className="form-row"><label><span>Email</span><input type="email" required value={candidateForm.email} onChange={(event) => setCandidateForm({ ...candidateForm, email: event.target.value })} /></label><label><span>Phone</span><input value={candidateForm.phone} onChange={(event) => setCandidateForm({ ...candidateForm, phone: event.target.value })} /></label></div><button type="submit" className="btn btn-primary" disabled={saving || !candidateForm.vacancyId || !candidateForm.firstName.trim() || !candidateForm.lastName.trim() || !candidateForm.email.trim()}>{saving ? 'Saving' : 'Add candidate'}</button></form>}
          <h3>Vacancies ({vacancies.length})</h3><div className="contacts-list">{vacancies.length === 0 ? <div className="empty-state"><p>No vacancies. Create a draft vacancy to begin recruitment.</p></div> : vacancies.map((vacancy) => <div key={vacancy.id} className="contact-card"><div className="contact-header"><h3>{vacancy.title}</h3><span className={`status-badge status-${vacancy.status}`}>{vacancy.status}</span></div><div className="contact-details"><p>{vacancy.employment_type.replaceAll('_', ' ')}{vacancy.location_summary ? ` · ${vacancy.location_summary}` : ''}</p></div>{vacancy.status === 'draft' && <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={() => void manageVacancy(vacancy, 'open')}>Open vacancy</button>}{vacancy.status === 'open' && <button type="button" className="btn btn-sm btn-secondary" disabled={saving} onClick={() => void manageVacancy(vacancy, 'close')}>Close vacancy</button>}</div>)}</div>
          <h3 style={{ marginTop: '1.5rem' }}>Candidates ({candidates.length})</h3><p className="hr-section-hint">Applied → screening → interview → reference check → offer. When the candidate accepts, hiring creates their login and staff record and starts onboarding. Unsuccessful applicants can be marked as not suitable at any point in the funnel.</p><div className="contacts-list">{candidates.length === 0 ? <div className="empty-state"><p>No candidates yet. Open a vacancy, then add the people who applied.</p></div> : candidates.map((candidate) => { const vacancy = vacancies.find((item) => item.id === candidate.vacancy_id); const nextStage = ({ applied: 'screening', screening: 'interview', interview: 'reference_check', reference_check: 'offer' } as Record<string, string>)[candidate.stage]; const awaitingAcceptance = candidate.stage === 'offer' && candidate.status === 'offered'; const canBeDismissed = !['declined', 'withdrawn', 'hired'].includes(candidate.status); return <div key={candidate.id} className="contact-card"><div className="contact-header"><h3>{candidate.first_name} {candidate.last_name}</h3><span className={`status-badge status-${candidate.status}`}>{candidate.status === 'hired' ? 'Hired' : candidate.status === 'declined' ? 'Not suitable' : candidate.status === 'withdrawn' ? 'Withdrawn' : awaitingAcceptance ? 'Offer made' : plainWords(candidate.stage)}</span></div><div className="contact-details"><p>{candidate.email} · {vacancy?.title ?? 'Vacancy unavailable'}</p>{candidate.offer_start_date && <p className="contact-meta">Offer: {plainWords(candidate.offer_role, 'role')} · {plainWords(candidate.offer_employment_type, 'employment type not set')} · starts {new Date(candidate.offer_start_date).toLocaleDateString('en-NZ')}</p>}{candidate.status === 'hired' && <p className="contact-meta">Now on the Staff tab – complete onboarding, then mark work ready.</p>}</div><div className="assessment-actions" style={{ marginTop: '0.75rem' }}>{nextStage && <button type="button" className="btn btn-sm btn-secondary" onClick={() => setCandidateAction({ candidate, nextStage, note: '' })}>{nextStage === 'offer' ? 'Make an offer' : `Move to ${plainWords(nextStage).toLowerCase()}`}</button>}{canBeDismissed && <button type="button" className="btn btn-sm btn-danger" onClick={() => setCandidateAction({ candidate, nextStage: 'declined', note: `Not suitable for ${vacancy?.title ?? 'this role'} after review.` })}>Mark as not suitable</button>}{awaitingAcceptance && <button type="button" className="btn btn-sm btn-primary" onClick={() => { setOfferError(null); setOfferAction({ candidate, role: candidate.offer_role ?? 'officer', employmentType: candidate.offer_employment_type ?? 'permanent', startDate: candidate.offer_start_date ?? '', note: '', accepted: true, branchId: '' }); }}>Candidate accepted – hire</button>}</div></div>; })}</div>
        </section>
      )}

      {tab === 'performance' && <section className="reports-section"><h2>Performance Reviews</h2><button type="button" className="btn btn-sm btn-primary" onClick={() => setShowCycleForm((value) => !value)}>{showCycleForm ? 'Cancel' : 'New review cycle'}</button>{showCycleForm && <form className="assessment-form" onSubmit={createPerformanceCycle}><label><span>Cycle name</span><input required value={cycleForm.name} onChange={(event) => setCycleForm({ ...cycleForm, name: event.target.value })} /></label><div className="form-row"><label><span>Period start</span><input type="date" required value={cycleForm.start} onChange={(event) => setCycleForm({ ...cycleForm, start: event.target.value })} /></label><label><span>Period end</span><input type="date" required value={cycleForm.end} onChange={(event) => setCycleForm({ ...cycleForm, end: event.target.value })} /></label><label><span>Due</span><input type="date" required value={cycleForm.due} onChange={(event) => setCycleForm({ ...cycleForm, due: event.target.value })} /></label></div><button type="submit" className="btn btn-primary" disabled={saving}>Create draft cycle</button></form>}<div className="contacts-list">{performanceCycles.length === 0 ? <div className="empty-state"><p>No performance cycles configured.</p></div> : performanceCycles.map((cycle) => <div className="contact-card" key={cycle.id}><div className="contact-header"><h3>{cycle.name}</h3><span className={`status-badge status-${cycle.status}`}>{cycle.status}</span></div><div className="contact-details"><p>{new Date(cycle.period_start).toLocaleDateString()} – {new Date(cycle.period_end).toLocaleDateString()} · due {new Date(cycle.due_date).toLocaleDateString()}</p><p className="contact-meta">{performanceReviews.filter((review) => review.cycle_id === cycle.id).length} assigned reviews</p></div></div>)}</div></section>}

      {tab === 'performance' && <section className="reports-section"><div className="assessment-actions"><button type="button" className="btn btn-sm btn-secondary" onClick={() => setShowReviewForm((value) => !value)} disabled={!performanceCycles.some((cycle) => cycle.status === 'open')}>{showReviewForm ? 'Cancel assignment' : 'Assign review'}</button></div>{showReviewForm && <form className="assessment-form" onSubmit={createPerformanceReview}><label><span>Open review cycle</span><select required value={reviewForm.cycleId} onChange={(event) => setReviewForm({ ...reviewForm, cycleId: event.target.value })}><option value="">Select cycle</option>{performanceCycles.filter((cycle) => cycle.status === 'open').map((cycle) => <option value={cycle.id} key={cycle.id}>{cycle.name}</option>)}</select></label><div className="form-row"><label><span>Staff member</span><select required value={reviewForm.staffId} onChange={(event) => setReviewForm({ ...reviewForm, staffId: event.target.value })}><option value="">Select staff</option>{staff.filter((person) => person.staff_id).map((person) => <option value={person.staff_id!} key={person.staff_id}>{person.display_name ?? person.email}</option>)}</select></label><label><span>Reviewer</span><select required value={reviewForm.reviewerId} onChange={(event) => setReviewForm({ ...reviewForm, reviewerId: event.target.value })}><option value="">Select reviewer</option>{staff.map((person) => <option value={person.id} key={person.id}>{person.display_name ?? person.email}</option>)}</select></label></div><button type="submit" className="btn btn-primary" disabled={saving || !reviewForm.cycleId || !reviewForm.staffId || !reviewForm.reviewerId}>{saving ? 'Saving' : 'Assign review'}</button></form>}<h3>Cycle actions</h3><div className="contacts-list">{performanceCycles.map((cycle) => <div key={cycle.id} className="contact-card"><div className="contact-header"><h3>{cycle.name}</h3><span className={`status-badge status-${cycle.status}`}>{cycle.status}</span></div><div className="contact-details"><p>{performanceReviews.filter((review) => review.cycle_id === cycle.id).length} review records</p></div>{cycle.status === 'draft' && <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={() => void transitionCycle(cycle, 'open')}>Open cycle</button>}{cycle.status === 'open' && <button type="button" className="btn btn-sm btn-secondary" disabled={saving} onClick={() => void transitionCycle(cycle, 'close')}>Close cycle</button>}</div>)}</div><h3 style={{ marginTop: '1.5rem' }}>Assigned Reviews</h3><div className="contacts-list">{performanceReviews.length === 0 ? <div className="empty-state"><p>No reviews assigned.</p></div> : performanceReviews.map((review) => <div key={review.id} className="contact-card"><div className="contact-header"><h3>{staffNames[review.staff_id] ?? 'Staff member'}</h3><span className={`status-badge status-${review.status}`}>{review.status}</span></div><div className="contact-details"><p>Reviewer: {staffNames[review.reviewer_user_id] ?? 'Assigned reviewer'}{review.rating ? ` · rating ${review.rating}/5` : ''}</p></div>{review.status !== 'completed' && <button type="button" className="btn btn-sm btn-primary" onClick={() => { setReviewCompletion({ rating: '3', strengths: '', goals: '', comments: '' }); setReviewAction(review); }}>Complete review</button>}</div>)}</div></section>}

      {tab === 'cases' && <section className="reports-section"><h2>Private HR Cases</h2><button type="button" className="btn btn-sm btn-primary" onClick={() => setShowCaseForm((value) => !value)}>{showCaseForm ? 'Cancel' : 'Open HR case'}</button>{showCaseForm && <form className="assessment-form" onSubmit={createHrCase}><label><span>Staff member</span><select required value={caseForm.staffId} onChange={(event) => setCaseForm({ ...caseForm, staffId: event.target.value })}><option value="">Select staff member</option>{staff.filter((person) => person.staff_id).map((person) => <option key={person.staff_id} value={person.staff_id!}>{person.display_name ?? person.email}</option>)}</select></label><div className="form-row"><label><span>Case type</span><select value={caseForm.type} onChange={(event) => setCaseForm({ ...caseForm, type: event.target.value })}><option value="disciplinary">Disciplinary</option><option value="grievance">Grievance</option><option value="wellbeing">Wellbeing</option><option value="conduct">Conduct</option><option value="other">Other</option></select></label><label><span>Severity</span><select value={caseForm.severity} onChange={(event) => setCaseForm({ ...caseForm, severity: event.target.value })}><option value="low">Low</option><option value="standard">Standard</option><option value="high">High</option><option value="critical">Critical</option></select></label></div><label><span>Subject</span><input required value={caseForm.subject} onChange={(event) => setCaseForm({ ...caseForm, subject: event.target.value })} /></label><label><span>Summary</span><textarea required rows={4} value={caseForm.summary} onChange={(event) => setCaseForm({ ...caseForm, summary: event.target.value })} /></label><button type="submit" className="btn btn-primary" disabled={saving}>Open private case</button></form>}<div className="contacts-list">{hrCases.length === 0 ? <div className="empty-state"><p>No private HR cases recorded.</p></div> : hrCases.map((item) => <div className="contact-card" key={item.id}><div className="contact-header"><h3>{item.subject}</h3><span className={`status-badge status-${item.status}`}>{item.status}</span></div><div className="contact-details"><p>{staffNames[item.staff_id] ?? 'Staff member'} · {item.case_type} · {item.severity}</p><p className="contact-meta">Opened {new Date(item.opened_at).toLocaleString()}</p></div></div>)}</div></section>}

      {tab === 'cases' && <section className="reports-section"><h2>Case Actions</h2><div className="contacts-list">{hrCases.filter((item) => ['open','in_review'].includes(item.status)).length === 0 ? <div className="empty-state"><p>No open HR cases require action.</p></div> : hrCases.filter((item) => ['open','in_review'].includes(item.status)).map((item) => <div key={item.id} className="contact-card"><div className="contact-header"><h3>{item.subject}</h3><span className={`status-badge status-${item.status}`}>{item.status}</span></div><div className="contact-details"><p>{staffNames[item.staff_id] ?? 'Staff member'} · {item.case_type} · {item.severity}</p></div><div className="assessment-actions">{item.status === 'open' && <button type="button" className="btn btn-sm btn-secondary" onClick={() => setCaseAction({ item, action: 'review', note: '' })}>Start review</button>}<button type="button" className="btn btn-sm btn-secondary" onClick={() => setCaseAction({ item, action: 'note', note: '' })}>Add note</button><button type="button" className="btn btn-sm btn-primary" onClick={() => setCaseAction({ item, action: 'resolve', note: '' })}>Resolve</button><button type="button" className="btn btn-sm btn-danger" onClick={() => setCaseAction({ item, action: 'withdraw', note: '' })}>Withdraw</button></div></div>)}</div></section>}

      {tab === 'onboarding' && (
        <section className="reports-section">
          <h2>Staff Onboarding ({onboarding.length})</h2>
          <p className="hr-section-hint">One row per person. Search by name, stage, blocker, or next action; open the onboarding profile without losing this workspace.</p>
          <div className="hr-staff-directory-tools">
            <label><span>Search onboarding</span><input type="search" value={onboardingSearch} onChange={(event) => setOnboardingSearch(event.target.value)} placeholder="Name, stage, status, blocker or next action" /></label>
            <span>{filteredOnboardingPeople.length} shown</span>
          </div>
          <div className="reports-table-wrapper hr-onboarding-directory">
            {staff.filter((person) => person.staff_id).length === 0 && <div className="empty-state"><p>No staff to onboard yet. Hire a candidate under People → Recruitment first.</p></div>}
            {staff.some((person) => person.staff_id) && <table className="reports-table"><thead><tr><th>Name</th><th>Stage</th><th>Status</th><th>Target start</th><th>Blockers / next action</th><th>Action</th></tr></thead><tbody>
            {filteredOnboardingPeople.map(({ person, ledger }) => {
              const name = person.display_name ?? person.email ?? 'Staff member';
              return <tr key={person.id}>
                <td><button type="button" className="hr-staff-name-button" onClick={() => openStaffProfile(person, 'onboarding')}><strong>{name}</strong><small>{person.email ?? 'No email recorded'}</small></button></td>
                <td>{ledger ? plainWords(ledger.current_stage) : 'Not started'}</td>
                <td><span className={`status-badge status-${ledger?.status ?? 'not_started'}`}>{onboardingStatusLabel(ledger?.status)}</span></td>
                <td>{ledger?.target_start ? new Date(ledger.target_start).toLocaleDateString('en-NZ') : 'Not set'}</td>
                <td>{ledger?.blockers?.length ? <span className="hr-inline-warning">{ledger.blockers.join(' · ')}</span> : ledger?.next_action ?? 'Start onboarding'}</td>
                <td><div className="assessment-actions">
                  <button type="button" className="btn btn-sm btn-secondary" onClick={() => openStaffProfile(person, 'onboarding')}>Open profile ↗</button>
                  {!ledger
                    ? <button type="button" className="btn btn-sm btn-primary" onClick={() => setOnboardingAction({ staffId: person.staff_id!, name, note: 'Onboarding started' })}>Start onboarding</button>
                    : ledger.status !== 'ready' && <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={() => runOnboardingPrimaryAction(person, ledger, name)}>{onboardingPrimaryActionLabel(ledger)}</button>}
                </div></td>
              </tr>;
            })}
            {filteredOnboardingPeople.length === 0 && <tr><td colSpan={6} className="text-center">No onboarding records match this search.</td></tr>}
            </tbody></table>}
          </div>
        </section>
      )}

      {tab === 'credentials' && (
        <section className="reports-section">
          <h2>Credentials ({credentials.length})</h2>
          <p className="hr-section-hint">Licences and warrants on file. A verified, current credential is what lets an officer be marked work ready; renew here before it expires.</p>
          <form className="hr-inline-form" onSubmit={(event) => { event.preventDefault(); const person = staff.find((item) => item.staff_id === credentialStaffId); if (person?.staff_id) openEvidence(person.staff_id, person.display_name || person.email || 'Staff member', 'record_credential'); }}><label><span>Staff member</span><select value={credentialStaffId} onChange={(event) => setCredentialStaffId(event.target.value)} aria-label="Staff member for new credential"><option value="">Choose who the credential belongs to</option>{staff.filter((person) => person.staff_id).map((person) => <option value={person.staff_id!} key={person.id}>{person.display_name || person.email}</option>)}</select></label><button type="submit" className="btn btn-sm btn-primary" disabled={!credentialStaffId}>Record credential</button></form>
          <div className="reports-table-wrapper">
            <table className="reports-table">
              <thead>
                <tr>
                  <th>Staff</th>
                  <th>Type</th>
                  <th>Number</th>
                  <th>Expiry</th>
                  <th>Verified</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {credentials.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-center">
                      No credentials on file yet. Choose a staff member above and record the licence or warrant you have sighted.
                    </td>
                  </tr>
                ) : (
                  credentials.map((c) => (
                    <tr key={c.id} id={`credential-${c.id}`} className={c.id === requestedCredentialId ? 'is-context-focus' : undefined}>
                      <td>{staffNames[c.staff_id] || c.staff_id}</td>
                      <td>{credentialTypeLabel(c.credential_type)}</td>
                      <td>{c.credential_number || '-'}</td>
                      <td>
                        <span className={credentialExpiryState(c.expiry_date) === 'expired' || credentialExpiryState(c.expiry_date) === 'expiring' ? 'severity-badge severity-high' : ''}>
                          {credentialExpiryWords(c.expiry_date)}
                        </span>
                      </td>
                      <td>{c.verified ? 'Verified' : 'Not yet verified'}</td>
                      <td><button type="button" className="btn btn-sm btn-primary" disabled={!c.expiry_date} onClick={() => { credentialRequestId.current=crypto.randomUUID();setCredentialRenewal({ source:c,credentialNumber:c.credential_number??'',issuingAuthority:c.issuing_authority??'',issuedDate:new Date().toISOString().slice(0,10),expiryDate:'',evidenceNotes:'' }); }}>Record renewal</button></td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === 'credentials' && (
        <>
          <section className="reports-section">
            <header className="page-header">
              <div><span className="contact-meta">Work qualification</span><h2>Skills and training actions</h2><p className="subtitle">Record evidence here before relying on a person for qualified roster coverage. Skill expiry is rechecked when a roster slot is assigned.</p></div>
              <div className="assessment-actions">
                <button type="button" className="btn btn-sm btn-primary" onClick={() => { setSkillAction({ staffId: '', skillId: '', proficiency: 'competent', certified: false, certificationExpiry: '', notes: '' }); setTrainingAction(null); }}>Assign skill</button>
                <button type="button" className="btn btn-sm btn-secondary" onClick={() => { setTrainingAction({ staffId: '', trainingName: '', trainingType: 'internal', provider: '', completedDate: new Date().toISOString().slice(0, 10), expiryDate: '', result: 'passed', score: '', notes: '', supersedesId: null }); setSkillAction(null); }}>Record training</button>
              </div>
            </header>
            {catalogSkills.length === 0 && <div className="empty-state"><p><strong>No active skill catalog entries.</strong> Add the organisation’s approved skills under Staff → Workforce setup before assigning one.</p></div>}
            {skillAction && <form className="assessment-form" onSubmit={(event) => void saveStaffSkill(event)}>
              <div className="form-row">
                <label><span>Staff member</span><select required value={skillAction.staffId} onChange={(event) => setSkillAction({ ...skillAction, staffId: event.target.value })}><option value="">Select staff</option>{staff.filter((person) => person.staff_id).map((person) => <option key={person.staff_id!} value={person.staff_id!}>{person.display_name || person.email || person.staff_id}</option>)}</select></label>
                <label><span>Catalog skill</span><select required value={skillAction.skillId} onChange={(event) => setSkillAction({ ...skillAction, skillId: event.target.value })}><option value="">Select skill</option>{catalogSkills.filter((skill) => skill.active).map((skill) => <option key={skill.id} value={skill.id}>{skill.skill_name} · {skill.skill_category}</option>)}</select></label>
                <label><span>Proficiency</span><select value={skillAction.proficiency} onChange={(event) => setSkillAction({ ...skillAction, proficiency: event.target.value })}><option value="basic">Basic</option><option value="competent">Competent</option><option value="proficient">Proficient</option><option value="expert">Expert</option></select></label>
              </div>
              <div className="form-row">
                <label><span>Certification state</span><select value={skillAction.certified ? 'certified' : 'not_certified'} onChange={(event) => setSkillAction({ ...skillAction, certified: event.target.value === 'certified' })}><option value="not_certified">Skill observed, not certified</option><option value="certified">Certified</option></select></label>
                <label><span>Certification expiry</span><input type="date" value={skillAction.certificationExpiry} onChange={(event) => setSkillAction({ ...skillAction, certificationExpiry: event.target.value })} /></label>
                <label><span>Evidence note</span><input value={skillAction.notes} onChange={(event) => setSkillAction({ ...skillAction, notes: event.target.value })} placeholder="Assessment or certificate reference" /></label>
              </div>
              <div className="assessment-actions"><button type="button" className="btn btn-secondary" onClick={() => setSkillAction(null)}>Cancel</button><button type="submit" className="btn btn-primary" disabled={saving || !skillAction.staffId || !skillAction.skillId}>{saving ? 'Saving' : 'Save staff skill'}</button></div>
            </form>}
            {trainingAction && <form className="assessment-form" onSubmit={(event) => void recordTraining(event)}>
              <div className="form-row">
                <label><span>Staff member</span><select required value={trainingAction.staffId} onChange={(event) => setTrainingAction({ ...trainingAction, staffId: event.target.value })}><option value="">Select staff</option>{staff.filter((person) => person.staff_id).map((person) => <option key={person.staff_id!} value={person.staff_id!}>{person.display_name || person.email || person.staff_id}</option>)}</select></label>
                <label><span>Training name</span><input required value={trainingAction.trainingName} onChange={(event) => setTrainingAction({ ...trainingAction, trainingName: event.target.value })} /></label>
                <label><span>Training type</span><select value={trainingAction.trainingType} onChange={(event) => setTrainingAction({ ...trainingAction, trainingType: event.target.value })}><option value="induction">Induction</option><option value="internal">Internal</option><option value="external">External</option><option value="refresher">Refresher</option><option value="assessment">Assessment</option></select></label>
              </div>
              <div className="form-row">
                <label><span>Provider</span><input value={trainingAction.provider} onChange={(event) => setTrainingAction({ ...trainingAction, provider: event.target.value })} /></label>
                <label><span>Completed</span><input type="date" required value={trainingAction.completedDate} onChange={(event) => setTrainingAction({ ...trainingAction, completedDate: event.target.value })} /></label>
                <label><span>Expiry</span><input type="date" min={trainingAction.completedDate || undefined} value={trainingAction.expiryDate} onChange={(event) => setTrainingAction({ ...trainingAction, expiryDate: event.target.value })} /></label>
              </div>
              <div className="form-row">
                <label><span>Result</span><select value={trainingAction.result} onChange={(event) => setTrainingAction({ ...trainingAction, result: event.target.value as 'passed' | 'not_passed' | 'not_assessed' })}><option value="passed">Passed</option><option value="not_passed">Not passed</option><option value="not_assessed">Not assessed</option></select></label>
                <label><span>Score (optional)</span><input type="number" min="0" max="100" step="0.01" value={trainingAction.score} onChange={(event) => setTrainingAction({ ...trainingAction, score: event.target.value })} /></label>
                <label><span>Evidence or review note</span><input value={trainingAction.notes} onChange={(event) => setTrainingAction({ ...trainingAction, notes: event.target.value })} /></label>
              </div>
              {trainingAction.supersedesId && <p className="contact-meta">This creates a new renewal record. The previous training evidence remains unchanged for audit.</p>}
              <div className="assessment-actions"><button type="button" className="btn btn-secondary" onClick={() => setTrainingAction(null)}>Cancel</button><button type="submit" className="btn btn-primary" disabled={saving || !trainingAction.staffId || !trainingAction.trainingName.trim() || !trainingAction.completedDate}>{saving ? 'Saving' : trainingAction.supersedesId ? 'Record renewal' : 'Record training'}</button></div>
            </form>}
          </section>
          <section className="reports-section">
            <h2>Staff documents ({staffDocuments.length})</h2>
            <div className="reports-table-wrapper">
              <table className="reports-table">
                <thead><tr><th>Staff</th><th>Type</th><th>File</th><th>Expiry</th><th>Uploaded</th></tr></thead>
                <tbody>
                  {staffDocuments.length === 0 ? <tr><td colSpan={5} className="text-center">No staff documents recorded</td></tr> : staffDocuments.map((document) => (
                    <tr key={document.id}>
                      <td>{staffNames[document.staff_id] || document.staff_id}</td>
                      <td>{document.document_type.replaceAll('_', ' ')}</td>
                      <td title={document.mime_type || undefined}>{document.file_name}</td>
                      <td><span className={isExpiringSoon(document.expiry_date) ? 'severity-badge severity-high' : ''}>{document.expiry_date ? new Date(document.expiry_date).toLocaleDateString() : 'No expiry'}</span></td>
                      <td>{document.uploaded_at ? new Date(document.uploaded_at).toLocaleDateString() : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="reports-section">
            <h2>Training records ({trainingRecords.length})</h2>
            <div className="reports-table-wrapper">
              <table className="reports-table">
                <thead><tr><th>Staff</th><th>Training</th><th>Provider</th><th>Completed</th><th>Expiry</th><th>Result</th><th /></tr></thead>
                <tbody>
                  {trainingRecords.length === 0 ? <tr><td colSpan={7} className="text-center">No training records recorded. Use Record training above to create governed evidence.</td></tr> : trainingRecords.map((record) => (
                    <tr key={record.id}>
                      <td>{staffNames[record.staff_id || record.officer_id || ''] || record.staff_id || record.officer_id || 'Unassigned'}</td>
                      <td>{record.training_name}<div className="contact-meta">{record.training_type}</div></td>
                      <td>{record.provider || '—'}</td>
                      <td>{new Date(record.completed_date).toLocaleDateString()}</td>
                      <td><span className={isExpiringSoon(record.expiry_date) ? 'severity-badge severity-high' : ''}>{record.expiry_date ? new Date(record.expiry_date).toLocaleDateString() : 'No expiry'}</span></td>
                      <td>{record.passed === null ? 'Not assessed' : record.passed ? `Passed${record.score !== null ? ` (${record.score})` : ''}` : 'Not passed'}</td>
                      <td><button type="button" className="btn btn-sm btn-secondary" disabled={!record.staff_id} onClick={() => setTrainingAction({ staffId: record.staff_id ?? '', trainingName: record.training_name, trainingType: 'refresher', provider: record.provider ?? '', completedDate: new Date().toISOString().slice(0, 10), expiryDate: '', result: 'passed', score: '', notes: '', supersedesId: record.id })}>Renew</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="reports-section">
            <h2>Staff skills ({staffSkills.length})</h2>
            <div className="reports-table-wrapper">
              <table className="reports-table">
                <thead><tr><th>Staff</th><th>Skill</th><th>Proficiency</th><th>Certification</th><th>Expiry</th><th>Roster state</th></tr></thead>
                <tbody>
                  {staffSkills.length === 0 ? <tr><td colSpan={6} className="text-center">No staff skills recorded. Qualified work-unit assignments will remain blocked where a skill is required.</td></tr> : staffSkills.map((skill) => {
                    const expired = Boolean(skill.certification_expiry && skill.certification_expiry < new Date().toISOString().slice(0, 10));
                    return <tr key={skill.id}><td>{staffNames[skill.staff_id] || skill.staff_id}</td><td>{skill.skill_name}<div className="contact-meta">{skill.skill_category || 'uncategorised'}</div></td><td>{plainWords(skill.proficiency_level, 'Not set')}</td><td>{skill.certified ? 'Certified' : 'Observed only'}</td><td>{skill.certification_expiry ? new Date(skill.certification_expiry).toLocaleDateString() : 'No expiry'}</td><td><span className={`status-badge ${expired ? 'status-inactive' : 'status-active'}`}>{expired ? 'Expired — blocked' : 'Current'}</span></td></tr>;
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {tab === 'coverage' && (
        <section className="reports-section">
          <h2>Open Shifts ({coverageRequests.length})</h2>
          <button className="btn btn-primary btn-sm" onClick={() => setShowCoverageForm(!showCoverageForm)}>
            {showCoverageForm ? 'Cancel' : '+ New Coverage Request'}
          </button>

          {showCoverageForm && (
            <form className="assessment-form" onSubmit={handleCreateCoverage}>
              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="coverage-date">Date</label>
                  <input
                    id="coverage-date"
                    type="date"
                    required
                    value={coverageForm.shift_date}
                    onChange={(e) => setCoverageForm({ ...coverageForm, shift_date: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="coverage-required-staff">Required Staff</label>
                  <input
                    id="coverage-required-staff"
                    type="number"
                    min={1}
                    value={coverageForm.required_staff_count}
                    onChange={(e) => setCoverageForm({ ...coverageForm, required_staff_count: e.target.value })}
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="coverage-start-time">Start Time</label>
                  <input
                    id="coverage-start-time"
                    type="time"
                    required
                    value={coverageForm.start_time}
                    onChange={(e) => setCoverageForm({ ...coverageForm, start_time: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="coverage-end-time">End Time</label>
                  <input
                    id="coverage-end-time"
                    type="time"
                    required
                    value={coverageForm.end_time}
                    onChange={(e) => setCoverageForm({ ...coverageForm, end_time: e.target.value })}
                  />
                </div>
              </div>
              <div className="form-group">
                <label htmlFor="coverage-urgency">Urgency</label>
                <select id="coverage-urgency" value={coverageForm.urgency} onChange={(e) => setCoverageForm({ ...coverageForm, urgency: e.target.value })}>
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>
              </div>
              <div className="form-group">
                <label htmlFor="coverage-notes">Notes</label>
                <textarea
                  id="coverage-notes"
                  rows={2}
                  value={coverageForm.notes}
                  onChange={(e) => setCoverageForm({ ...coverageForm, notes: e.target.value })}
                />
              </div>
              <button type="submit" className="btn btn-primary btn-block">
                Create Request
              </button>
            </form>
          )}

          <div className="contacts-list" style={{ marginTop: '12px' }}>
            {coverageRequests.length === 0 ? (
              <div className="empty-state">
                <p>No open shifts need coverage right now.</p>
              </div>
            ) : (
              coverageRequests.map((c) => (
                <div key={c.id} className="contact-card">
                  <div className="contact-header">
                    <h3>
                      {new Date(c.shift_date).toLocaleDateString()} · {c.start_time.slice(0, 5)}–{c.end_time.slice(0, 5)}
                    </h3>
                    <span className={`badge ${c.urgency === 'urgent' || c.urgency === 'high' ? 'badge-danger' : 'badge-info'}`}>
                      {c.urgency.toUpperCase()}
                    </span>
                  </div>
                  <div className="contact-details">
                    <p className="contact-meta">
                      {c.site_name ? `${c.site_name} · ` : ''}
                      Requires {c.required_staff_count} staff
                    </p>
                    {c.notes && <p className="contact-meta">{c.notes}</p>}
                    <p className="contact-meta">Status: {c.status}{c.claimed_by?` · claimed by ${staffNames[c.claimed_by]??c.claimed_by}`:''}</p>
                  </div>
                  {c.status==='claimed'&&<button type="button" className="btn btn-sm btn-primary" onClick={()=>setCoverageFinalization({request:c,workUnitId:'',notes:''})}>Finalize assignment</button>}
                </div>
              ))
            )}
          </div>
        </section>
      )}

      {tab === 'roster-rules' && profile?.organizationId && (
        // Rules belong to the employing organisation (staff_profiles.organization_id), not the branch being worked in.
        <RosterRulesPanel organizationId={profile.employerOrganizationId ?? profile.organizationId} organizationName={operatingOrganizations.find((context) => context.organizationId === (profile.employerOrganizationId ?? profile.organizationId))?.organizationName ?? null} />
      )}

      {tab === 'shift-templates' && (
        <section className="reports-section">
          <h2>Shift Templates ({shiftTemplates.length})</h2>
          <button className="btn btn-primary btn-sm" style={{ marginBottom: '1rem' }} onClick={() => setShowTemplateForm(!showTemplateForm)}>
            {showTemplateForm ? 'Cancel' : '+ New Shift Template'}
          </button>

          {showTemplateForm && (
            <form className="assessment-form" onSubmit={handleCreateTemplate} style={{ marginBottom: '1.5rem' }}>
              <div className="form-group">
                <label htmlFor="tpl-name">Template Name</label>
                <input id="tpl-name" required value={templateForm.name} onChange={(e) => setTemplateForm({ ...templateForm, name: e.target.value })} placeholder="e.g. Morning Static Guard" />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="tpl-shift-type">Shift Type</label>
                  <select id="tpl-shift-type" value={templateForm.shift_type} onChange={(e) => setTemplateForm({ ...templateForm, shift_type: e.target.value })}>
                    <option value="day">Day</option>
                    <option value="swing">Swing</option>
                    <option value="night">Night</option>
                    <option value="overnight">Overnight</option>
                    <option value="split">Split</option>
                  </select>
                </div>
                <div className="form-group">
                  <label htmlFor="tpl-recurrence">Recurrence</label>
                  <select id="tpl-recurrence" value={templateForm.recurrence_type} onChange={(e) => setTemplateForm({ ...templateForm, recurrence_type: e.target.value })}>
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="fortnightly">Fortnightly</option>
                    <option value="monthly">Monthly</option>
                  </select>
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="tpl-start">Start Time</label>
                  <input id="tpl-start" type="time" required value={templateForm.start_time} onChange={(e) => setTemplateForm({ ...templateForm, start_time: e.target.value })} />
                </div>
                <div className="form-group">
                  <label htmlFor="tpl-end">End Time</label>
                  <input id="tpl-end" type="time" required value={templateForm.end_time} onChange={(e) => setTemplateForm({ ...templateForm, end_time: e.target.value })} />
                </div>
                <div className="form-group">
                  <label htmlFor="tpl-staff-count">Required Staff</label>
                  <input id="tpl-staff-count" type="number" min={1} required value={templateForm.required_staff_count} onChange={(e) => setTemplateForm({ ...templateForm, required_staff_count: e.target.value })} />
                </div>
              </div>
              <div className="form-group">
                <label htmlFor="tpl-notes">Notes</label>
                <textarea id="tpl-notes" rows={2} value={templateForm.notes} onChange={(e) => setTemplateForm({ ...templateForm, notes: e.target.value })} />
              </div>
              <button type="submit" className="btn btn-primary btn-block" disabled={saving}>
                {saving ? 'Creating...' : 'Create Shift Template'}
              </button>
            </form>
          )}

          <div className="contacts-list">
            {shiftTemplates.length === 0 ? (
              <div className="empty-state">
                <p>No shift templates configured.</p>
              </div>
            ) : (
              shiftTemplates.map((t) => (
                <div key={t.id} className="contact-card">
                  <div className="contact-header">
                    <h3>{t.name}</h3>
                    <span className="contact-type-badge">{t.shift_type}</span>
                  </div>
                  <div className="contact-details">
                    <p>
                      {t.start_time} – {t.end_time} · {t.recurrence_type}
                    </p>
                    <p className="contact-meta">
                      Requires {t.required_staff_count} staff · {t.is_active ? 'Active' : 'Inactive'}
                    </p>
                  </div>
                  <button type="button" className={`btn btn-sm ${t.is_active ? 'btn-secondary' : 'btn-primary'}`} style={{ marginTop: '0.5rem' }} disabled={saving} onClick={() => void handleToggleTemplate(t.id)}>
                    {t.is_active ? 'Deactivate' : 'Activate'}
                  </button>
                </div>
              ))
            )}
          </div>
        </section>
      )}

      {tab === 'leave' && (
        <section className="reports-section">
          <h2>Leave Requests ({leaveRequests.length})</h2>
          <div className="contacts-list">
            {leaveRequests.length === 0 ? (
              <div className="empty-state">
                <p>No leave requests.</p>
              </div>
            ) : (
              leaveRequests.map((l) => (
                <div key={l.id} className="contact-card">
                  <div className="contact-header">
                    <h3>{staffNames[l.staff_id] || l.staff_id}</h3>
                    <span className={`status-badge status-${l.status}`}>{l.status}</span>
                  </div>
                  <div className="contact-details">
                    <p>
                      {l.leave_type} · {new Date(l.starts_on).toLocaleDateString()} –{' '}
                      {new Date(l.ends_on).toLocaleDateString()}
                    </p>
                    {l.reason && <p className="contact-meta">{l.reason}</p>}
                  </div>
                  {l.status === 'pending' && (
                    <div className="assessment-actions">
                      <button className="btn btn-sm btn-secondary" onClick={() => { setReviewNotes('');setReview({ kind: 'leave', id: l.id, decision: 'branch_checked' }); }}>
                        Branch check
                      </button>
                      <button className="btn btn-sm btn-danger" onClick={() => { setReviewNotes('');setReview({ kind: 'leave', id: l.id, decision: 'declined' }); }}>
                        Decline
                      </button>
                    </div>
                  )}
                  {l.status === 'branch_checked' && corporatePayrollReviewer && <div className="assessment-actions">{l.branch_reviewed_by !== profile?.id && <button className="btn btn-sm btn-secondary" onClick={() => { setReviewNotes('');setReview({ kind: 'leave', id: l.id, decision: 'approved' }); }}>Final approve</button>}{l.branch_reviewed_by !== profile?.id && ' '}<button className="btn btn-sm btn-danger" onClick={() => { setReviewNotes('');setReview({ kind: 'leave', id: l.id, decision: 'declined' }); }}>Decline</button></div>}
                </div>
              ))
            )}
          </div>
        </section>
      )}

      {scheduleRecovery && <div className="hr-review-backdrop"><form className="hr-review-dialog hr-schedule-recovery" role="dialog" aria-modal="true" aria-labelledby="schedule-recovery-title" onSubmit={recoverSchedule}>
        <header><h2 id="schedule-recovery-title">Recover scheduled shift into timesheet</h2><button type="button" disabled={saving} onClick={() => setScheduleRecovery(null)} aria-label="Close scheduled timesheet recovery">×</button></header>
        <p>For an officer who forgot to log in or start. Select and review scheduled rows, amend the times and confirm an unpaid break only when supported by evidence. This creates manual admin payroll evidence, not actual attendance, GPS or completed work.</p>
        <p>Period boundaries use New Zealand dates. Editable times use your device time zone ({Intl.DateTimeFormat().resolvedOptions().timeZone}). Planned breaks are reference only and are never automatically deducted.</p>
        <fieldset disabled={saving || recoveryLoading}><legend>Find scheduled work</legend>
          <label><span>Staff member</span><select required value={scheduleRecovery.staffId} onChange={(event) => setScheduleRecovery({ ...scheduleRecovery, staffId: event.target.value, rows: null })}><option value="">Choose staff</option>{staff.filter((person) => person.staff_id).map((person) => <option key={person.id} value={person.staff_id!}>{person.display_name || person.email || 'Unnamed staff member'}</option>)}</select></label>
          <div className="form-row"><label><span>Period from</span><input type="date" required value={scheduleRecovery.from} onChange={(event) => setScheduleRecovery({ ...scheduleRecovery, from: event.target.value, rows: null })} /></label><label><span>Period to (include overnight end date)</span><input type="date" required min={scheduleRecovery.from} value={scheduleRecovery.to} onChange={(event) => setScheduleRecovery({ ...scheduleRecovery, to: event.target.value, rows: null })} /></label></div>
          <button type="button" className="btn btn-secondary" disabled={!scheduleRecovery.staffId || !scheduleRecovery.from || !scheduleRecovery.to} onClick={() => { void previewScheduleRecovery(); }}>Preview scheduled rows</button>
        </fieldset>
        {recoveryLoading && <p role="status">Loading scheduled sources…</p>}
        {scheduleRecovery.rows?.length === 0 && <p>No eligible completed-time scheduled rows. Check the staff member and dates; draft, declined, cancelled and future rows cannot be recovered.</p>}
        {scheduleRecovery.rows?.map((row, index) => {
          const update = (patch: Partial<ScheduledTimesheetDraft>) => setScheduleRecovery({ ...scheduleRecovery, rows: scheduleRecovery.rows!.map((item, rowIndex) => rowIndex === index ? { ...item, ...patch } : item) });
          return <fieldset key={`${row.source_type}:${row.source_id}`} disabled={saving}><legend><label><input type="checkbox" checked={row.selected} onChange={(event) => update({ selected: event.target.checked })} /> Include {new Date(row.scheduled_start).toLocaleString()} – {new Date(row.scheduled_end).toLocaleString()}</label></legend>
            <p className="hr-source-provenance">{row.source_type}: {row.source_id}{row.shift_id && <> · Shift: {row.shift_id}</>}</p>
            <p>Planned break: {row.planned_break_minutes} minutes ({row.break_unpaid ? 'unpaid' : 'paid'}). No deduction copied from plan.</p>
            {row.selected && <><div className="form-row"><label><span>Reviewed start</span><input type="datetime-local" required value={row.reviewedStart} onChange={(event) => update({ reviewedStart: event.target.value })} /></label><label><span>Reviewed end</span><input type="datetime-local" required value={row.reviewedEnd} onChange={(event) => update({ reviewedEnd: event.target.value })} /></label></div><label><span>Evidence-confirmed unpaid break (minutes)</span><input type="number" min="0" max="1440" step="1" required value={row.unpaidBreak} onChange={(event) => update({ unpaidBreak: event.target.value })} /></label></>}
          </fieldset>;
        })}
        {scheduleRecovery.rows?.some((row) => row.selected) && <p role="status">Reviewed hours to submit: {scheduleRecovery.rows.filter((row) => row.selected).reduce((total, row) => total + (new Date(row.reviewedEnd).getTime() - new Date(row.reviewedStart).getTime()) / 3600000 - Number(row.unpaidBreak) / 60, 0).toFixed(2)}. Invalid or overlapping times must be corrected before saving.</p>}
        <label><span>Overtime hours (included in reviewed hours, not added)</span><input type="number" min="0" max="744" step="0.01" required disabled={saving} value={scheduleRecovery.overtime} onChange={(event) => setScheduleRecovery({ ...scheduleRecovery, overtime: event.target.value })} /></label>
        <label><span>Recovery / amendment reason and evidence</span><textarea rows={3} maxLength={2000} required disabled={saving} value={scheduleRecovery.reason} onChange={(event) => setScheduleRecovery({ ...scheduleRecovery, reason: event.target.value })} /></label>
        <p>Saving submits for branch check, then final approval by a different corporate payroll reviewer. Existing or overlapping timesheets are rejected; edit the existing sheet instead.</p>
        {error && <p role="alert" className="hr-review-error">{error}</p>}
        <footer><button type="button" className="btn btn-secondary" disabled={saving} onClick={() => setScheduleRecovery(null)}>Cancel</button><button type="submit" className="btn btn-primary" disabled={saving || recoveryLoading || !scheduleRecovery.reason.trim() || !scheduleRecovery.rows?.some((row) => row.selected)}>{saving ? 'Saving recovery' : 'Save manual timesheet for review'}</button></footer>
      </form></div>}

      {payCorrection && <div className="hr-review-backdrop"><form className="hr-review-dialog" role="dialog" aria-modal="true" aria-labelledby="timesheet-pay-title" onSubmit={correctTimesheetPay}>
        <header><h2 id="timesheet-pay-title">Pay code / rate — THIS TIMESHEET ONLY</h2><button type="button" disabled={saving} onClick={() => setPayCorrection(null)} aria-label="Close timesheet pay correction">×</button></header>
        <p>{staffNames[payCorrection.item.staff_id] || 'Staff member'} · {payCorrection.item.period_start} – {payCorrection.item.period_end}</p>
        <p>Employment rates and rate rules are not changed. The hourly rate applies to every payable hour on this sheet; overtime hours are classified within those hours, not multiplied or added. Clear an override to restore the normal hourly rule.</p>
        <label><span>Timesheet pay code override (blank = normal rule)</span><input maxLength={32} pattern="[A-Z0-9][A-Z0-9_-]*" disabled={saving} value={payCorrection.code} onChange={(event) => setPayCorrection({ ...payCorrection, code: event.target.value.toUpperCase() })} /></label>
        <label><span>Timesheet hourly rate override (blank = normal rule)</span><input type="number" min="0" max="100000" step="0.0001" disabled={saving} value={payCorrection.rate} onChange={(event) => setPayCorrection({ ...payCorrection, rate: event.target.value })} /></label>
        <label><span>Audited reason</span><textarea required maxLength={2000} rows={3} disabled={saving} value={payCorrection.reason} onChange={(event) => setPayCorrection({ ...payCorrection, reason: event.target.value })} /></label>
        <p>Saving resets branch review. A new branch check and different corporate final reviewer are required. Approved or paid sheets cannot be changed here.</p>
        {error && <p role="alert" className="hr-review-error">{error}</p>}
        <footer><button type="button" className="btn btn-secondary" disabled={saving} onClick={() => setPayCorrection(null)}>Cancel</button><button type="submit" className="btn btn-primary" disabled={saving || !payCorrection.reason.trim()}>{saving ? 'Saving' : 'Save timesheet-only pay correction'}</button></footer>
      </form></div>}

      {breakReview && <div className="hr-review-backdrop"><section className="hr-review-dialog" role="dialog" aria-modal="true" aria-labelledby="timesheet-break-title">
        <header><h2 id="timesheet-break-title">Timesheet break evidence</h2><button type="button" onClick={() => setBreakReview(null)} aria-label="Close break evidence">×</button></header>
        <p>Missed, short and long breaks are review evidence, not automatic planned deductions. Existing worked-hour calculations deduct only recorded unpaid breaks. Manual recovery uses explicitly reviewed unpaid minutes instead.</p>
        {breakReview.rows === null && !error && <p role="status">Loading break evidence…</p>}
        {breakReview.rows?.length === 0 && <p>No linked scheduled shift break evidence for this period.</p>}
        {breakReview.rows?.map((row) => <p key={row.shift_id} className="hr-source-provenance">Shift {row.shift_id}: planned {row.planned_minutes} min ({row.unpaid ? 'unpaid' : 'paid'}), recorded {Number(row.taken_minutes).toFixed(1)} min — {row.review_status === 'not_recorded' ? 'missed / not recorded' : plainWords(row.review_status)}.</p>)}
        {error && <p role="alert" className="hr-review-error">{error}</p>}
        <footer><button className="btn btn-secondary" type="button" onClick={() => setBreakReview(null)}>Close</button></footer>
      </section></div>}

      {tab === 'timesheets' && (
        <section className="reports-section">
          <h2>{workingInBranch ? 'Branch timesheets' : 'Timesheets across branches'} ({timesheets.length})</h2>
          <p className="subtitle">{workingInBranch ? 'Branch review confirms local time and operational evidence. Corporate payroll gives final approval and exports paid time.' : 'Corporate payroll sees every branch’s sheets here. Branch check happens while working in the branch; final approval must come from a different reviewer than the branch check.'}</p>
          {corporatePayrollReviewer && <button className="btn btn-secondary btn-sm" onClick={() => { setError(null); const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' }); setScheduleRecovery({ staffId: '', from: today, to: today, rows: null, reason: '', overtime: '0', requestId: crypto.randomUUID() }); }}>Recover scheduled shift into timesheet</button>}
          {corporatePayrollReviewer && exportedBatchId && <button className="btn btn-secondary btn-sm" onClick={() => { setError(null); void downloadPayrollBatch(exportedBatchId); }}>Download last payroll batch</button>}
          {corporatePayrollReviewer && <button className="btn btn-primary btn-sm" style={{ marginBottom: '1rem' }} onClick={() => {
            const now = new Date();
            const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
            setError(null);
            setPayrollExport({ from: `${month}-01`, to: `${month}-${new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()}` });
          }}>
            Create payroll batch
          </button>}
          <TimesheetRows rows={timesheets} staffNames={staffNames} corporateReviewer={corporatePayrollReviewer} actorId={profile?.id}
            onCorrect={(item) => setTimesheetCorrection({ item, actualHours: String(item.actual_hours ?? ''), overtimeHours: String(item.overtime_hours ?? 0), reason: '' })}
            onPayCorrect={corporatePayrollReviewer ? (item) => { setError(null); setPayCorrection({ item, code: item.pay_code_override ?? '', rate: item.hourly_rate_override == null ? '' : String(item.hourly_rate_override), reason: '', requestId: crypto.randomUUID() }); } : undefined}
            onBreakReview={(item) => { void reviewTimesheetBreaks(item); }}
            onReview={(item, decision) => { setReviewNotes(''); setReview({ kind: 'timesheet', id: item.id, decision }); }} />
        </section>
      )}

      {tab === 'pay-review' && (
        <section className="reports-section">
          <h2>Pay Review ({dispatchPayLines.length})</h2>
          <p className="subtitle">Generated pay evidence from completed dispatch work. Resolve exceptions before approving related timesheets for payroll export.</p>
          {!payReviewGovernanceAvailable && <div className="alert alert-error" role="status">Pay-line decisions will be available after the pending finance-governance migration is deployed. Evidence remains read-only until then.</div>}
          <div className="metrics-grid" style={{ marginBottom: '1rem' }}>
            <div className="metric-card"><span>Total pay evidence</span><strong>NZ${dispatchPayLines.reduce((total, line) => total + Number(line.line_total || 0), 0).toFixed(2)}</strong></div>
            <div className="metric-card"><span>Unresolved</span><strong>{dispatchPayLines.filter((line) => line.pay_code === 'UNRESOLVED').length}</strong></div>
            <div className="metric-card"><span>Rule-backed lines</span><strong>{dispatchPayLines.filter((line) => line.rate_rule_id).length}</strong></div>
          </div>
          <div className="crm-branch-filter" aria-label="Pay review filter">
            <button type="button" className={`btn btn-sm ${payReviewFilter === 'exceptions' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setPayReviewFilter('exceptions')}>Needs review ({dispatchPayLines.filter((line) => line.pay_code === 'UNRESOLVED').length})</button>
            <button type="button" className={`btn btn-sm ${payReviewFilter === 'resolved' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setPayReviewFilter('resolved')}>Rule resolved ({dispatchPayLines.filter((line) => line.pay_code !== 'UNRESOLVED').length})</button>
            <button type="button" className={`btn btn-sm ${payReviewFilter === 'all' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setPayReviewFilter('all')}>All evidence</button>
          </div>
          <div className="reports-table-wrapper" style={{ marginBottom: '1rem' }}>
            <table className="reports-table">
              <thead><tr><th>Staff</th><th>Lines</th><th>Resolved pay</th><th>Exceptions</th></tr></thead>
              <tbody>{Object.entries(dispatchPayLines.reduce<Record<string, { count: number; total: number; unresolved: number }>>((summary, line) => { const key = line.officer_user_id ?? 'unassigned'; const current = summary[key] ?? { count: 0, total: 0, unresolved: 0 }; current.count += 1; current.total += Number(line.line_total || 0); current.unresolved += line.pay_code === 'UNRESOLVED' ? 1 : 0; summary[key] = current; return summary; }, {})).map(([staffId, summary]) => <tr key={staffId}><td>{staffId === 'unassigned' ? 'Officer not resolved' : staffNames[staffId] ?? staffId}</td><td>{summary.count}</td><td>NZ${summary.total.toFixed(2)}</td><td>{summary.unresolved}</td></tr>)}</tbody>
            </table>
          </div>
          <div className="reports-table-wrapper">
            <table className="reports-table">
              <thead><tr><th>Staff</th><th>Dispatch source</th><th>Pay item</th><th>Quantity</th><th>Rate</th><th>Total</th><th>Travel evidence</th><th>Evidence state</th><th>Review</th></tr></thead>
              <tbody>
                {dispatchPayLines.filter((line) => payReviewFilter === 'all' || (payReviewFilter === 'exceptions' ? line.pay_code === 'UNRESOLVED' : line.pay_code !== 'UNRESOLVED')).length === 0 ? (
                  <tr><td colSpan={9} className="text-center">No {payReviewFilter === 'exceptions' ? 'unresolved' : payReviewFilter === 'resolved' ? 'rule-resolved' : 'completed-dispatch'} pay evidence.</td></tr>
                ) : dispatchPayLines.filter((line) => payReviewFilter === 'all' || (payReviewFilter === 'exceptions' ? line.pay_code === 'UNRESOLVED' : line.pay_code !== 'UNRESOLVED')).map((line) => {
                  const unresolved = line.pay_code === 'UNRESOLVED';
                  const latestReview = dispatchPayLineReviews.find((review) => review.pay_line_id === line.id);
                  return <tr key={line.id}>
                    <td>{line.officer_user_id ? staffNames[line.officer_user_id] ?? line.officer_user_id : 'Officer not resolved'}</td>
                    <td><code>{line.source_dispatch_id.slice(0, 8)}</code></td>
                    <td><strong>{line.pay_code ?? 'Base pay'}</strong><br /><small>{line.description}</small></td>
                    <td>{Number(line.quantity).toFixed(2)} {line.rate_type === 'per_km' ? 'km' : 'hours'}</td>
                    <td>NZ${Number(line.unit_rate).toFixed(2)}</td>
                    <td>NZ${Number(line.line_total).toFixed(2)}</td>
                    <td>{line.distance_km != null ? `${Number(line.distance_km).toFixed(2)} km` : 'No distance'}<br /><small>{line.distance_reason?.replaceAll('_', ' ') ?? 'Not recorded'}</small></td>
                    <td><span className={`status-badge ${unresolved ? 'status-rejected' : 'status-approved'}`}>{unresolved ? (line.description.replace('Unresolved: ', 'Needs review')) : 'Rule resolved'}</span>{line.distance_reason && <small> · {line.distance_reason.replaceAll('_', ' ')}</small>}</td>
                    <td>{latestReview ? <><span className={`status-badge status-${latestReview.decision}`}>{latestReview.decision}</span>{latestReview.review_notes && <small> · {latestReview.review_notes}</small>}</> : <span className="status-badge status-pending">Pending</span>}{payReviewGovernanceAvailable && <button type="button" className="btn btn-sm btn-secondary" style={{ marginTop: '0.5rem' }} disabled={saving} onClick={() => setPayLineReview({ line, expectedReviewId: latestReview?.id ?? null, decision: unresolved ? 'rejected' : 'approved', notes: '' })}>{unresolved ? 'Reject for correction' : 'Review'}</button>}</td>
                  </tr>;
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {payLineReview && <div className="hr-review-backdrop"><form className="hr-review-dialog" role="dialog" aria-modal="true" aria-labelledby="pay-line-review-title" onSubmit={submitPayLineReview}><header><div><span>Payroll evidence</span><h2 id="pay-line-review-title">{payLineReview.decision === 'approved' ? 'Approve pay evidence' : 'Reject for correction'}</h2></div><button type="button" onClick={() => setPayLineReview(null)} aria-label="Close pay-line review">×</button></header><p>{payLineReview.line.pay_code ?? 'Base pay'} · NZ${Number(payLineReview.line.line_total).toFixed(2)} · dispatch {payLineReview.line.source_dispatch_id.slice(0, 8)}</p>{payLineReview.line.pay_code === 'UNRESOLVED' && <p>This evidence cannot be approved for payroll until the source work evidence or effective pay rule is corrected and recalculated.</p>}<label><span>Decision</span><select value={payLineReview.decision} disabled={payLineReview.line.pay_code === 'UNRESOLVED'} onChange={(event) => setPayLineReview({ ...payLineReview, decision: event.target.value as 'approved' | 'rejected' })}><option value="approved">Approve</option><option value="rejected">Reject for correction</option></select></label><label><span>Review notes</span><textarea rows={4} required={payLineReview.decision === 'rejected'} value={payLineReview.notes} onChange={(event) => setPayLineReview({ ...payLineReview, notes: event.target.value })} /></label><footer><button type="button" className="btn btn-secondary" onClick={() => setPayLineReview(null)}>Back</button><button type="submit" className="btn btn-primary" disabled={saving || (payLineReview.decision === 'rejected' && !payLineReview.notes.trim())}>{saving ? 'Saving' : 'Confirm decision'}</button></footer></form></div>}
      {tab === 'assets' && (
        <section className="reports-section">
          <header className="hr-asset-register-header">
            <div>
              <h2>Fleet &amp; Equipment ({assets.length})</h2>
              <p>Register equipment before officers sign it out. Shift assignment remains a separate officer action with its own receipt.</p>
            </div>
            <button type="button" className="btn btn-primary" onClick={() => openAssetRegister()}>Add asset</button>
          </header>
          <div className="reports-table-wrapper">
            <table className="reports-table">
              <thead>
                <tr><th>Asset</th><th>Type</th><th>Identifier</th><th>Assigned</th><th>Last check</th><th>Status</th><th>Action</th></tr>
              </thead>
              <tbody>
                {assets.length === 0 ? (
                  <tr><td colSpan={7} className="text-center"><strong>No fleet or equipment registered.</strong><br /><span>Add the first asset before an officer can sign it out to a shift.</span></td></tr>
                ) : (
                  assets.map((a) => (
                    <tr key={a.id}>
                      <td>{a.name}</td>
                      <td>{a.asset_type.replaceAll('_', ' ')}</td>
                      <td>{a.registration || [a.make, a.model].filter(Boolean).join(' ') || '—'}</td>
                      <td>{a.assigned_to ? staffNames[a.assigned_to] ?? 'Assigned' : '—'}</td>
                      <td>{a.last_inspection_date ? new Date(a.last_inspection_date).toLocaleDateString() : 'Never'}</td>
                      <td><span className={`status-badge status-${a.status}`}>{a.status.replaceAll('_', ' ')}</span></td>
                      <td><div className="hr-asset-actions"><button type="button" className="btn btn-sm btn-secondary" onClick={() => openAssetRegister(a)}>Edit register</button><button type="button" className="btn btn-sm btn-secondary" onClick={() => setAssetCheck({ asset: a, condition: 'good', odometer: '', fuel: '', defects: '' })}>Record check</button></div></td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {assetDraft && <div className="hr-review-backdrop"><form className="hr-review-dialog hr-asset-dialog" role="dialog" aria-modal="true" aria-labelledby="asset-register-title" onSubmit={saveAsset}><header><div><span>Fleet register</span><h2 id="asset-register-title">{assetDraft.assetId ? `Update ${assetDraft.name}` : 'Add fleet or equipment'}</h2></div><button type="button" onClick={() => setAssetDraft(null)} aria-label="Close asset register">×</button></header><p>{assetDraft.assetId ? 'Confirm the register state before officers next sign this asset out.' : 'This creates the accountable register record. It does not assign the asset to a person or shift.'}</p><div className="hr-asset-form-grid"><label><span>Name</span><input required maxLength={160} value={assetDraft.name} onChange={(event) => setAssetDraft({ ...assetDraft, name: event.target.value })} /></label><label><span>Type</span><select disabled={Boolean(assetDraft.assetId)} value={assetDraft.assetType} onChange={(event) => setAssetDraft({ ...assetDraft, assetType: event.target.value })}><option value="vehicle">Vehicle</option><option value="radio">Radio</option><option value="body_camera">Body camera</option><option value="torch">Torch</option><option value="uniform">Uniform</option><option value="first_aid_kit">First aid kit</option><option value="ems_device">EMS device</option><option value="other">Other</option></select></label><label><span>Registration</span><input value={assetDraft.registration} onChange={(event) => setAssetDraft({ ...assetDraft, registration: event.target.value })} placeholder="Vehicle plate, if applicable" /></label><label><span>Serial number</span><input value={assetDraft.serialNumber} onChange={(event) => setAssetDraft({ ...assetDraft, serialNumber: event.target.value })} /></label><label><span>Make</span><input value={assetDraft.make} onChange={(event) => setAssetDraft({ ...assetDraft, make: event.target.value })} /></label><label><span>Model</span><input value={assetDraft.model} onChange={(event) => setAssetDraft({ ...assetDraft, model: event.target.value })} /></label><label><span>Year</span><input type="number" min={1900} max={new Date().getFullYear() + 1} value={assetDraft.year} onChange={(event) => setAssetDraft({ ...assetDraft, year: event.target.value })} /></label><label><span>Status</span><select value={assetDraft.status} onChange={(event) => setAssetDraft({ ...assetDraft, status: event.target.value })}><option value="available">Available</option><option value="maintenance">Maintenance</option><option value="retired">Retired</option><option value="lost">Lost</option>{assetDraft.status === 'in_use' && <option value="in_use">In use (set by shift sign-out)</option>}</select></label><label><span>Next inspection</span><input type="date" value={assetDraft.nextInspectionDate} onChange={(event) => setAssetDraft({ ...assetDraft, nextInspectionDate: event.target.value })} /></label><label className="is-wide"><span>Notes</span><textarea rows={3} value={assetDraft.notes} onChange={(event) => setAssetDraft({ ...assetDraft, notes: event.target.value })} /></label></div><footer><button type="button" className="btn btn-secondary" onClick={() => setAssetDraft(null)} disabled={saving}>Keep current register</button><button type="submit" className="btn btn-primary" disabled={saving || !assetDraft.name.trim()}>{saving ? 'Saving' : assetDraft.assetId ? 'Confirm update' : 'Add to register'}</button></footer></form></div>}

      {tab === 'oncall' && (
        <section className="reports-section">
          <h2>On-Call Periods ({onCallPeriods.length})</h2>
          <form className="assessment-form" onSubmit={createOnCallPeriod}>
            <div className="form-row"><label><span>Officer</span><select required value={onCallForm.officerId} onChange={(event) => setOnCallForm({ ...onCallForm, officerId: event.target.value })}><option value="">Select active officer</option>{staff.filter((person) => person.id !== profile?.id).map((person) => <option value={person.id} key={person.id}>{person.display_name ?? person.email ?? person.id}</option>)}</select></label><label><span>Type</span><select value={onCallForm.type} onChange={(event) => setOnCallForm({ ...onCallForm, type: event.target.value })}><option value="standard">Standard</option><option value="before_shift">Before shift</option><option value="after_shift">After shift</option><option value="overnight">Overnight</option></select></label></div>
            <div className="form-row"><label><span>Starts</span><input type="datetime-local" required value={onCallForm.startsAt} onChange={(event) => setOnCallForm({ ...onCallForm, startsAt: event.target.value })} /></label><label><span>Ends</span><input type="datetime-local" required value={onCallForm.endsAt} onChange={(event) => setOnCallForm({ ...onCallForm, endsAt: event.target.value })} /></label></div>
            <div className="form-row"><label><span>Flat rate</span><input type="number" min="0" step="0.01" value={onCallForm.flatRate} onChange={(event) => setOnCallForm({ ...onCallForm, flatRate: event.target.value })} /></label><label><span>Notes</span><input value={onCallForm.notes} onChange={(event) => setOnCallForm({ ...onCallForm, notes: event.target.value })} /></label></div>
            <button type="submit" className="btn btn-primary" disabled={saving}>Create on-call period</button>
          </form>
          <div className="contacts-list">
            {onCallPeriods.length === 0 ? (
              <div className="empty-state"><p>No on-call periods scheduled.</p></div>
            ) : (
              onCallPeriods.map((p) => (
                <div key={p.id} className="contact-card">
                  <div className="contact-header">
                    <h3>{staffNames[p.officer_user_id] ?? 'Officer'}</h3>
                    <span className={`status-badge status-${p.status}`}>{p.status}</span>
                  </div>
                  <div className="contact-details">
                    <p>{p.period_type.replaceAll('_', ' ')} · {new Date(p.starts_at).toLocaleString('en-NZ')} – {new Date(p.ends_at).toLocaleString('en-NZ')}</p>
                    <p className="contact-meta">{p.flat_rate != null ? `Flat rate NZ$${Number(p.flat_rate).toFixed(2)}` : 'No flat rate set'}</p>
                  </div>
                  {p.status === 'accepted' && <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={() => void openCallout(p)}>Raise callout</button>}
                </div>
              ))
            )}
          </div>

          <h2 style={{ marginTop: '1.5rem' }}>Callouts ({callouts.length})</h2>
          <div className="contacts-list">
            {callouts.length === 0 ? (
              <div className="empty-state"><p>No callouts raised.</p></div>
            ) : (
              callouts.map((c) => {
                const summary = calloutPaySummaries[c.id];
                return (
                  <div key={c.id} className="contact-card">
                    <div className="contact-header">
                      <h3>{staffNames[c.officer_user_id] ?? 'Officer'}</h3>
                      <span className={`status-badge status-${c.status}`}>{c.status.replaceAll('_', ' ')}</span>
                    </div>
                    <div className="contact-details">
                      <p>{c.callout_received_at ? `Received ${new Date(c.callout_received_at).toLocaleString('en-NZ')}` : 'Not yet received'}</p>
                      <p className="contact-meta">
                        {summary ? `Worked ${Number(summary.worked_hours).toFixed(2)}h · Payable ${Number(summary.payable_hours).toFixed(2)}h` : 'Pay summary unavailable'}
                        {summary?.minimum_applied ? ` (${Number(summary.minimum_pay_hours)}h minimum applied)` : ''}
                        {summary?.response_minutes != null ? ` · Response ${Number(summary.response_minutes).toFixed(1)}m` : ''}
                      </p>
                    </div>
                    {c.status !== 'completed' && <button type="button" className="btn btn-sm btn-secondary" disabled={saving} onClick={() => void recordCalloutMilestone(c, ({ raised: 'departed', responding: 'arrived', on_site: 'work_started', working: 'work_ended', returning: 'returned' } as Record<string, string>)[c.status])}>Record next milestone</button>}
                  </div>
                );
              })
            )}
          </div>
        </section>
      )}

      {tab === 'court' && (
        <section className="reports-section">
          <h2>Court Appearances ({courtAppearances.length})</h2>
          <form className="assessment-form" onSubmit={scheduleCourtAppearance}>
            <p>Schedule hearings and tribunal work against the officer's roster. The server identifies work outside a rostered slot as overtime and notifies the officer.</p>
            <div className="form-row"><label><span>Officer</span><select required value={courtForm.officerId} onChange={(event) => setCourtForm({ ...courtForm, officerId: event.target.value })}><option value="">Select active officer</option>{staff.filter((person) => ['officer', 'admin_officer'].includes(person.role) && person.work_ready !== false).map((person) => <option value={person.id} key={person.id}>{person.display_name ?? person.email ?? person.id}</option>)}</select></label><label><span>Court or tribunal</span><input required value={courtForm.courtName} onChange={(event) => setCourtForm({ ...courtForm, courtName: event.target.value })} placeholder="e.g. Nelson District Court" /></label></div>
            <div className="form-row"><label><span>Appearance type</span><select value={courtForm.appearanceType} onChange={(event) => setCourtForm({ ...courtForm, appearanceType: event.target.value })}><option value="hearing">Hearing</option><option value="trial">Trial</option><option value="deposition">Deposition</option><option value="tribunal">Tribunal</option><option value="mediation">Mediation</option><option value="other">Other</option></select></label><label><span>Scheduled for</span><input type="datetime-local" required value={courtForm.scheduledAt} onChange={(event) => setCourtForm({ ...courtForm, scheduledAt: event.target.value })} /></label><label><span>Estimated hours</span><input type="number" min="0.25" max="24" step="0.25" required value={courtForm.estimatedHours} onChange={(event) => setCourtForm({ ...courtForm, estimatedHours: event.target.value })} /></label></div>
            <div className="form-row"><label><span>Case reference</span><input value={courtForm.caseReference} onChange={(event) => setCourtForm({ ...courtForm, caseReference: event.target.value })} /></label><label><span>Subpoena reference</span><input value={courtForm.subpoenaReference} onChange={(event) => setCourtForm({ ...courtForm, subpoenaReference: event.target.value })} /></label></div>
            <label><span>Instructions or preparation notes</span><textarea rows={3} value={courtForm.notes} onChange={(event) => setCourtForm({ ...courtForm, notes: event.target.value })} /></label>
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Scheduling' : 'Schedule court appearance'}</button>
          </form>
          <div className="contacts-list">
            {courtAppearances.length === 0 ? (
              <div className="empty-state"><p>No court appearances scheduled.</p></div>
            ) : (
              courtAppearances.map((c) => (
                <div key={c.id} className="contact-card">
                  <div className="contact-header">
                    <h3>{staffNames[c.officer_user_id] ?? 'Officer'}</h3>
                    <span className={`status-badge status-${c.status}`}>{c.status}</span>
                  </div>
                  <div className="contact-details">
                    <p>{c.appearance_type} · {c.court_name}</p>
                    <p className="contact-meta">
                      {new Date(c.scheduled_at).toLocaleString('en-NZ')} · est. {c.estimated_hours}h
                      {c.is_overtime ? ' · overtime' : ''}
                      {c.case_reference ? ` · ${c.case_reference}` : ''}
                      {c.subpoena_reference ? ` · subpoena ${c.subpoena_reference}` : ''}
                    </p>
                    {c.actual_start && <p className="contact-meta">Attended {new Date(c.actual_start).toLocaleString('en-NZ')}{c.actual_end ? ` – ${new Date(c.actual_end).toLocaleString('en-NZ')}` : ''}{c.outcome ? ` · ${c.outcome}` : ''}</p>}
                  </div>
                  {c.status === 'scheduled' && <button type="button" className="btn btn-sm btn-secondary" disabled={saving} onClick={() => setCourtOutcome({ appearance: c, status: 'attended', actualStart: '', actualEnd: '', outcome: '' })}>Record outcome</button>}
                </div>
              ))
            )}
          </div>
        </section>
      )}

      {courtOutcome && <div className="hr-review-backdrop"><form className="hr-review-dialog" role="dialog" aria-modal="true" aria-labelledby="court-outcome-title" onSubmit={recordCourtOutcome}><header><div><span>Court record</span><h2 id="court-outcome-title">Record appearance outcome</h2></div><button type="button" onClick={() => setCourtOutcome(null)} aria-label="Close court outcome">×</button></header><p>{staffNames[courtOutcome.appearance.officer_user_id] ?? 'Officer'} · {courtOutcome.appearance.appearance_type} at {courtOutcome.appearance.court_name}. The saved outcome becomes roster, overtime and audit evidence.</p><label><span>Outcome status</span><select value={courtOutcome.status} onChange={(event) => setCourtOutcome({ ...courtOutcome, status: event.target.value as 'attended' | 'adjourned' | 'cancelled' | 'excused' })}><option value="attended">Attended</option><option value="adjourned">Adjourned</option><option value="cancelled">Cancelled</option><option value="excused">Excused</option></select></label>{courtOutcome.status === 'attended' && <div className="form-row"><label><span>Actual start</span><input type="datetime-local" required value={courtOutcome.actualStart} onChange={(event) => setCourtOutcome({ ...courtOutcome, actualStart: event.target.value })} /></label><label><span>Actual end</span><input type="datetime-local" required value={courtOutcome.actualEnd} onChange={(event) => setCourtOutcome({ ...courtOutcome, actualEnd: event.target.value })} /></label></div>}<label><span>Outcome or next step</span><textarea rows={4} value={courtOutcome.outcome} onChange={(event) => setCourtOutcome({ ...courtOutcome, outcome: event.target.value })} placeholder="Decision, adjournment date, evidence requested, or why the officer was excused" /></label><footer><button type="button" className="btn btn-secondary" onClick={() => setCourtOutcome(null)}>Cancel</button><button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving' : 'Record outcome'}</button></footer></form></div>}

      {assetCheck && <div className="hr-review-backdrop"><form className="hr-review-dialog" role="dialog" aria-modal="true" aria-labelledby="asset-check-title" onSubmit={handleAssetCheck}><header><div><span>Fleet evidence</span><h2 id="asset-check-title">Record check</h2></div><button type="button" onClick={() => setAssetCheck(null)} aria-label="Close asset check">×</button></header><p>{assetCheck.asset.name}{assetCheck.asset.registration ? ` · ${assetCheck.asset.registration}` : ''}. Major issues move the asset to maintenance and alert administrators.</p><label><span>Condition</span><select value={assetCheck.condition} onChange={(e) => setAssetCheck({ ...assetCheck, condition: e.target.value })}><option value="good">Good</option><option value="minor_issue">Minor issue</option><option value="major_issue">Major issue</option><option value="unserviceable">Unserviceable</option></select></label>{assetCheck.asset.asset_type === 'vehicle' && <div className="form-row"><label><span>Odometer</span><input type="number" min={0} value={assetCheck.odometer} onChange={(e) => setAssetCheck({ ...assetCheck, odometer: e.target.value })} /></label><label><span>Fuel level</span><select value={assetCheck.fuel} onChange={(e) => setAssetCheck({ ...assetCheck, fuel: e.target.value })}><option value="">Not recorded</option><option value="full">Full</option><option value="three_quarter">Three quarter</option><option value="half">Half</option><option value="quarter">Quarter</option><option value="empty">Empty</option></select></label></div>}<label><span>Defects noted</span><textarea rows={3} value={assetCheck.defects} onChange={(e) => setAssetCheck({ ...assetCheck, defects: e.target.value })} /></label><footer><button type="button" className="btn btn-secondary" onClick={() => setAssetCheck(null)}>Cancel</button><button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving' : 'Record check'}</button></footer></form></div>}

      {payrollExport && <div className="hr-review-backdrop">
        <form className="hr-review-dialog" role="dialog" aria-modal="true" aria-labelledby="payroll-export-title" onSubmit={handlePayrollExport}>
          <header><div><span>Payroll</span><h2 id="payroll-export-title">Create payroll batch</h2></div><button type="button" disabled={saving} onClick={() => setPayrollExport(null)} aria-label="Close payroll export">×</button></header>
          <p>Every approved, unexported timesheet whose period falls inside this range is batched and marked paid. This cannot be undone from this screen.</p>
          <p>This records the batch and downloads its CSV. Payment and IRD submission are not available here.</p>
          <div className="form-row">
            <label><span>Period from</span><input type="date" required disabled={saving} value={payrollExport.from} onChange={(e) => setPayrollExport({ ...payrollExport, from: e.target.value })} /></label>
            <label><span>Period to</span><input type="date" required min={payrollExport.from} disabled={saving} value={payrollExport.to} onChange={(e) => setPayrollExport({ ...payrollExport, to: e.target.value })} /></label>
          </div>
          {error && <p className="hr-review-error" role="alert">{error}</p>}
          <footer><button type="button" className="btn btn-secondary" disabled={saving} onClick={() => setPayrollExport(null)}>Cancel</button><button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Recording' : 'Create payroll batch'}</button></footer>
        </form>
      </div>}

      {reviewAction && <div className="hr-review-backdrop"><form className="hr-review-dialog" role="dialog" aria-modal="true" aria-labelledby="performance-review-title" onSubmit={completeReview}><header><div><span>Performance review</span><h2 id="performance-review-title">Complete review</h2></div><button type="button" onClick={() => setReviewAction(null)} aria-label="Close performance review">×</button></header><p>{staffNames[reviewAction.staff_id] ?? 'Staff member'}. The review record and rating are retained once completed.</p><label><span>Rating</span><select value={reviewCompletion.rating} onChange={(event) => setReviewCompletion({ ...reviewCompletion, rating: event.target.value })}>{[1,2,3,4,5].map((rating) => <option value={rating} key={rating}>{rating} / 5</option>)}</select></label><label><span>Strengths</span><textarea rows={3} value={reviewCompletion.strengths} onChange={(event) => setReviewCompletion({ ...reviewCompletion, strengths: event.target.value })} /></label><label><span>Development goals</span><textarea rows={3} value={reviewCompletion.goals} onChange={(event) => setReviewCompletion({ ...reviewCompletion, goals: event.target.value })} /></label><label><span>Employee comments</span><textarea rows={3} value={reviewCompletion.comments} onChange={(event) => setReviewCompletion({ ...reviewCompletion, comments: event.target.value })} /></label><footer><button type="button" className="btn btn-secondary" onClick={() => setReviewAction(null)}>Cancel</button><button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving' : 'Complete review'}</button></footer></form></div>}

      {caseAction && <div className="hr-review-backdrop"><form className="hr-review-dialog" role="dialog" aria-modal="true" aria-labelledby="hr-case-action-title" onSubmit={manageHrCase}><header><div><span>Private HR case</span><h2 id="hr-case-action-title">{caseAction.action === 'note' ? 'Add case note' : `${caseAction.action[0].toUpperCase()}${caseAction.action.slice(1)} case`}</h2></div><button type="button" onClick={() => setCaseAction(null)} aria-label="Close HR case action">×</button></header><p>{caseAction.item.subject}. This is an employer-only record and is never linked to a field incident.</p><label><span>{caseAction.action === 'note' ? 'Case note' : 'Decision note'}</span><textarea required rows={4} value={caseAction.note} onChange={(event) => setCaseAction({ ...caseAction, note: event.target.value })} /></label><footer><button type="button" className="btn btn-secondary" onClick={() => setCaseAction(null)}>Cancel</button><button type="submit" className={caseAction.action === 'withdraw' ? 'btn btn-danger' : 'btn btn-primary'} disabled={saving || !caseAction.note.trim()}>{saving ? 'Saving' : caseAction.action === 'note' ? 'Record note' : 'Confirm action'}</button></footer></form></div>}

      {evidenceAction && <div className="hr-review-backdrop"><form className="hr-review-dialog" role="dialog" aria-modal="true" aria-labelledby="onboarding-evidence-title" onSubmit={recordOnboardingEvidence}><header><div><span>Staff onboarding evidence</span><h2 id="onboarding-evidence-title">{evidenceAction.action === 'add_skill' ? 'Add skill' : evidenceAction.action === 'assign_line_manager' ? 'Assign line manager' : evidenceAction.action === 'record_induction' ? 'Record site induction' : evidenceAction.action === 'record_credential' ? 'Record credential' : 'Register document'}</h2></div><button type="button" onClick={() => setEvidenceAction(null)} aria-label="Close evidence form">×</button></header><p>{evidenceAction.name}. {evidenceAction.action === 'record_credential' ? 'A verified, current credential is what makes an officer work ready. Record what you have sighted; renewals of an expiring credential are done from the Credentials tab.' : 'Record only confirmed evidence; the readiness evaluator will update after this receipt.'}</p>{evidenceAction.action === 'record_credential' && <><label><span>Credential type</span><select value={evidenceAction.credentialType} onChange={(event) => setEvidenceAction({ ...evidenceAction, credentialType: event.target.value })}>{CREDENTIAL_TYPES.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><div className="form-row"><label><span>Credential number</span><input value={evidenceAction.credentialNumber} onChange={(event) => setEvidenceAction({ ...evidenceAction, credentialNumber: event.target.value })} placeholder="As printed on the certificate" /></label><label><span>Issuing authority</span><input value={evidenceAction.issuingAuthority} onChange={(event) => setEvidenceAction({ ...evidenceAction, issuingAuthority: event.target.value })} placeholder="e.g. PSPLA" /></label></div><div className="form-row"><label><span>Issued</span><input type="date" value={evidenceAction.issuedDate} onChange={(event) => setEvidenceAction({ ...evidenceAction, issuedDate: event.target.value })} /></label><label><span>Expires</span><input type="date" value={evidenceAction.expiryDate} onChange={(event) => setEvidenceAction({ ...evidenceAction, expiryDate: event.target.value })} /></label></div><label className="roster-publish"><input type="checkbox" checked={evidenceAction.credentialVerified} onChange={(event) => setEvidenceAction({ ...evidenceAction, credentialVerified: event.target.checked })} /><span><b>I have sighted this credential and it is genuine</b><small>Verified credentials count towards work readiness. Verifying needs the number, the authority and an evidence note.</small></span></label></>}{evidenceAction.action === 'add_skill' && <><label><span>Skill from catalog</span><select required value={evidenceAction.skillId} onChange={(event) => setEvidenceAction({ ...evidenceAction, skillId: event.target.value })}><option value="">Select a skill</option>{catalogSkills.map((skill) => <option value={skill.id} key={skill.id}>{skill.skill_name} ({skill.skill_category})</option>)}</select></label><label><span>Proficiency</span><select value={evidenceAction.proficiency} onChange={(event) => setEvidenceAction({ ...evidenceAction, proficiency: event.target.value })}><option value="basic">Basic</option><option value="competent">Competent</option><option value="proficient">Proficient</option><option value="expert">Expert</option></select></label><label><span>Notes</span><textarea rows={3} value={evidenceAction.note} onChange={(event) => setEvidenceAction({ ...evidenceAction, note: event.target.value })} /></label></>}{evidenceAction.action === 'assign_line_manager' && <label><span>Line manager</span><select required value={evidenceAction.managerId} onChange={(event) => setEvidenceAction({ ...evidenceAction, managerId: event.target.value })}><option value="">Select active staff member</option>{staff.filter((person) => person.id !== evidenceAction.staffId).map((person) => <option value={person.id} key={person.id}>{person.display_name ?? person.email}</option>)}</select></label>}{evidenceAction.action === 'record_induction' && <><label><span>Site induction requirement</span><select required value={evidenceAction.siteRequirementId} onChange={(event) => setEvidenceAction({ ...evidenceAction, siteRequirementId: event.target.value, expiresAt: siteInductionRequirements.find((requirement) => requirement.id === event.target.value)?.expires_after_days ? new Date(Date.now() + Number(siteInductionRequirements.find((requirement) => requirement.id === event.target.value)?.expires_after_days) * 86_400_000).toISOString().slice(0, 10) : '' })}><option value="">Select site induction requirement</option>{siteInductionRequirements.filter((requirement) => requirement.active).map((requirement) => <option value={requirement.id} key={requirement.id}>{requirement.induction_name}{requirement.version ? ` · v${requirement.version}` : ''}</option>)}</select></label>{evidenceAction.siteRequirementId && <label><span>Expiry date</span><input type="date" value={evidenceAction.expiresAt} onChange={(event) => setEvidenceAction({ ...evidenceAction, expiresAt: event.target.value })} /></label>}</>}{evidenceAction.action === 'record_document' && <><label><span>Document type</span><select value={evidenceAction.documentType} onChange={(event) => setEvidenceAction({ ...evidenceAction, documentType: event.target.value })}><option value="policy_acknowledgement">Policy acknowledgement</option><option value="contract">Contract</option><option value="certificate">Certificate</option><option value="credential_evidence">Credential evidence</option><option value="other">Other</option></select></label><label><span>File name</span><input required value={evidenceAction.fileName} onChange={(event) => setEvidenceAction({ ...evidenceAction, fileName: event.target.value })} /></label><label><span>Existing secure storage path</span><input required value={evidenceAction.storagePath} onChange={(event) => setEvidenceAction({ ...evidenceAction, storagePath: event.target.value })} /></label></>}<label><span>Evidence note</span><textarea rows={3} value={evidenceAction.note} onChange={(event) => setEvidenceAction({ ...evidenceAction, note: event.target.value })} placeholder={evidenceAction.action === 'record_credential' ? 'What you sighted and how you checked it (at least 10 characters to verify)' : undefined} /></label><footer><button type="button" className="btn btn-secondary" onClick={() => setEvidenceAction(null)}>Cancel</button><button type="submit" className="btn btn-primary" disabled={saving || (evidenceAction.action === 'add_skill' && !evidenceAction.skillId.trim()) || (evidenceAction.action === 'assign_line_manager' && !evidenceAction.managerId) || (evidenceAction.action === 'record_induction' && !evidenceAction.siteRequirementId) || (evidenceAction.action === 'record_document' && (!evidenceAction.fileName.trim() || !evidenceAction.storagePath.trim())) || (evidenceAction.action === 'record_credential' && evidenceAction.credentialVerified && (!evidenceAction.credentialNumber.trim() || !evidenceAction.issuingAuthority.trim() || evidenceAction.note.trim().length < 10))}>{saving ? 'Saving' : evidenceAction.action === 'record_credential' ? (evidenceAction.credentialVerified ? 'Record and verify' : 'Record as unverified') : 'Record evidence'}</button></footer></form></div>}

      {onboardingAction && <div className="hr-review-backdrop"><form className="hr-review-dialog" role="dialog" aria-modal="true" aria-labelledby="staff-onboarding-title" onSubmit={manageOnboarding}><header><div><span>Staff onboarding</span><h2 id="staff-onboarding-title">{onboardingAction.ledgerId ? `Move to ${onboardingStageLabel(onboardingAction.nextStage ?? '')}?` : 'Start onboarding'}</h2></div><button type="button" onClick={() => setOnboardingAction(null)} aria-label="Close staff onboarding">×</button></header><p>{onboardingAction.name}. {onboardingAction.ledgerId ? `Needs: ${ONBOARDING_STEPS.find((step) => step.stage === onboardingAction.nextStage)?.needs ?? 'the previous step complete'}. The record is rechecked before the step advances.` : 'This opens step 1 (Identity) and records who started it.'}</p><label><span>Stage note</span><textarea required rows={4} value={onboardingAction.note} onChange={(event) => setOnboardingAction({ ...onboardingAction, note: event.target.value })} /></label><footer><button type="button" className="btn btn-secondary" onClick={() => setOnboardingAction(null)}>Cancel</button><button type="submit" className="btn btn-primary" disabled={saving || !onboardingAction.note.trim()}>{saving ? 'Saving' : onboardingAction.ledgerId ? 'Advance step' : 'Start onboarding'}</button></footer></form></div>}

      {candidateAction && <div className="hr-review-backdrop"><form className="hr-review-dialog" role="dialog" aria-modal="true" aria-labelledby="candidate-stage-title" onSubmit={advanceCandidate}><header><div><span>Recruitment</span><h2 id="candidate-stage-title">{candidateAction.nextStage === 'declined' ? 'Mark as not suitable' : `Move to ${candidateAction.nextStage.replaceAll('_', ' ')}`}</h2></div><button type="button" onClick={() => setCandidateAction(null)} aria-label="Close candidate stage">×</button></header><p>{candidateAction.candidate.first_name} {candidateAction.candidate.last_name}. {candidateAction.nextStage === 'declined' ? 'Record a factual, job-related reason. Do not record protected personal characteristics or unsupported assumptions. This saves the internal decision and audit history; it does not email the candidate.' : 'Stage history is retained for every candidate decision.'}</p><label><span>{candidateAction.nextStage === 'declined' ? 'Job-related reason' : 'Stage note'}</span><textarea required rows={4} value={candidateAction.note} onChange={(event) => setCandidateAction({ ...candidateAction, note: event.target.value })} /></label><footer><button type="button" className="btn btn-secondary" onClick={() => setCandidateAction(null)}>Cancel</button><button type="submit" className="btn btn-primary" disabled={saving || !candidateAction.note.trim()}>{saving ? 'Saving' : candidateAction.nextStage === 'declined' ? 'Decline candidate' : 'Advance candidate'}</button></footer></form></div>}

      {employmentAction && <div className="hr-review-backdrop"><form className="hr-review-dialog" role="dialog" aria-modal="true" aria-labelledby="employment-setup-title" onSubmit={saveEmploymentSetup}><header><div><span>Staff onboarding</span><h2 id="employment-setup-title">Complete employment setup</h2></div><button type="button" onClick={() => setEmploymentAction(null)} aria-label="Close employment setup">×</button></header><p>{employmentAction.name}. Employment type, dates, and payroll role are saved together and audited before onboarding can continue.</p><div className="form-row"><label><span>Employment type</span><select value={employmentAction.employmentType} onChange={(event) => setEmploymentAction({ ...employmentAction, employmentType: event.target.value })}><option value="permanent">Permanent</option><option value="part_time">Part time</option><option value="casual">Casual</option><option value="contractor">Contractor</option><option value="volunteer">Volunteer</option></select></label><label><span>Payroll role</span><select required value={employmentAction.roleCode} onChange={(event) => setEmploymentAction({ ...employmentAction, roleCode: event.target.value })}><option value="">Select payroll role</option>{roleCodes.map((code) => <option value={code.code} key={code.code}>{code.code} · {code.name}</option>)}</select></label></div><div className="form-row"><label><span>Start date</span><input type="date" required value={employmentAction.startDate} onChange={(event) => setEmploymentAction({ ...employmentAction, startDate: event.target.value })} /></label><label><span>End date</span><input type="date" min={employmentAction.startDate || undefined} value={employmentAction.endDate} onChange={(event) => setEmploymentAction({ ...employmentAction, endDate: event.target.value })} /></label></div>{roleCodes.length === 0 && <div className="hr-guidance" role="status"><p>No payroll roles are configured yet.</p><button type="button" className="btn btn-sm btn-secondary" onClick={() => { setEmploymentAction(null); setTab('staff'); setTabGroup('workforce'); setShowPayRoleCodeForm(true); }}>Create payroll role code</button></div>}<label><span>Reason for setup</span><textarea required rows={3} value={employmentAction.reason} onChange={(event) => setEmploymentAction({ ...employmentAction, reason: event.target.value })} /></label><footer><button type="button" className="btn btn-secondary" onClick={() => setEmploymentAction(null)}>Cancel</button><button type="submit" className="btn btn-primary" disabled={saving || !employmentAction.startDate || !employmentAction.roleCode || !employmentAction.reason.trim()}>{saving ? 'Saving' : 'Save employment setup'}</button></footer></form></div>}

      {offerAction && <div className="hr-review-backdrop"><form className="hr-review-dialog" role="dialog" aria-modal="true" aria-labelledby="offer-title" onSubmit={sendOffer}><header><div><span>Recruitment offer</span><h2 id="offer-title">{offerAction.candidate.stage === 'offer' ? 'Confirm acceptance and hire' : 'Record offer'}</h2></div><button type="button" onClick={() => { setOfferAction(null); setOfferError(null); }} aria-label="Close offer form">×</button></header><p>{offerAction.candidate.first_name} {offerAction.candidate.last_name}. {offerAction.candidate.stage === 'offer' ? 'Confirming acceptance creates their login and staff record for this branch and starts onboarding.' : 'Recording an offer does not create a login. Hire only after the candidate has accepted – you can come back to this candidate to confirm.'}</p><label><span>Application role</span><select value={offerAction.role} onChange={(event) => setOfferAction({ ...offerAction, role: event.target.value })}><option value="officer">Officer</option><option value="admin_officer">Senior officer</option></select></label><div className="form-row"><label><span>Employment type</span><select value={offerAction.employmentType} onChange={(event) => setOfferAction({ ...offerAction, employmentType: event.target.value })}><option value="permanent">Permanent</option><option value="part_time">Part time</option><option value="casual">Casual</option><option value="contractor">Contractor</option><option value="volunteer">Volunteer</option></select></label><label><span>Proposed start</span><input type="date" required value={offerAction.startDate} onChange={(event) => setOfferAction({ ...offerAction, startDate: event.target.value })} /></label></div><label><span>Offer note</span><textarea required rows={4} value={offerAction.note} onChange={(event) => setOfferAction({ ...offerAction, note: event.target.value })} /></label><label className="roster-publish"><input type="checkbox" checked={offerAction.accepted} onChange={(event) => setOfferAction({ ...offerAction, accepted: event.target.checked })} /><span><b>Candidate has accepted this offer</b><small>Provision an application identity and start staff onboarding only after verified acceptance.</small></span></label>{offerAction.accepted && <label><span>Delivery branch</span><select required aria-label="Delivery branch" value={offerAction.branchId} onChange={(event) => setOfferAction({ ...offerAction, branchId: event.target.value })}><option value="">Select the branch they will be rostered at</option>{hireBranches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>}{offerError && <p className="hr-review-error" role="alert">{offerError}</p>}<footer><button type="button" className="btn btn-secondary" onClick={() => { setOfferAction(null); setOfferError(null); }}>Cancel</button><button type="submit" className="btn btn-primary" disabled={saving || !offerAction.startDate || !offerAction.note.trim() || (offerAction.accepted && !offerAction.branchId)}>{saving ? 'Saving' : offerAction.accepted ? 'Confirm acceptance and hire' : 'Record offer'}</button></footer></form></div>}

      {review && <div className="hr-review-backdrop"><form className="hr-review-dialog" role="dialog" aria-modal="true" aria-labelledby="hr-review-title" onSubmit={handleReview}><header><div><span>Governed HR decision</span><h2 id="hr-review-title">{review.decision === 'branch_checked' ? 'Branch check' : review.decision === 'approved' ? 'Final approve' : review.decision === 'declined' ? 'Decline' : 'Return for correction'} {review.kind === 'leave' ? 'leave request' : 'timesheet'}?</h2></div><button type="button" onClick={() => setReview(null)} aria-label="Close review">×</button></header><p>{review.kind === 'leave' ? 'Leave approval will fail when active roster slots overlap the requested dates.' : review.decision === 'branch_checked' ? 'This confirms local time and evidence. A different corporate payroll reviewer must give final approval.' : review.decision === 'approved' ? 'Final approval makes these hours eligible for payroll export.' : 'The staff member must correct and resubmit this timesheet.'}</p><label><span>Review notes</span><textarea rows={4} required={review.decision === 'rejected' || review.decision === 'declined'} value={reviewNotes} onChange={(event) => setReviewNotes(event.target.value)} /></label>{error && <p className="hr-review-error" role="alert">{error}</p>}<footer><button type="button" className="btn btn-secondary" onClick={() => setReview(null)}>Back</button><button type="submit" className="btn btn-primary" disabled={saving || ((review.decision === 'rejected' || review.decision === 'declined') && !reviewNotes.trim())}>{saving ? 'Saving' : 'Confirm decision'}</button></footer></form></div>}
      {readinessReview && <div className="hr-review-backdrop"><form className="hr-review-dialog" role="dialog" aria-modal="true" aria-labelledby="readiness-review-title" onSubmit={handleReadinessReview}><header><div><span>Staff eligibility</span><h2 id="readiness-review-title">{readinessReview.next ? 'Mark work ready?' : 'Remove work readiness?'}</h2></div><button type="button" onClick={() => setReadinessReview(null)} aria-label="Close readiness review">×</button></header><p>{readinessReview.next ? 'Identity, employment, and current credential blockers are checked again by the server.' : 'The staff member will no longer be eligible for new roster assignments.'}</p><label><span>Readiness review notes</span><textarea rows={4} required value={readinessNotes} onChange={(event) => setReadinessNotes(event.target.value)} /></label><footer><button type="button" className="btn btn-secondary" onClick={() => setReadinessReview(null)}>Back</button><button type="submit" className="btn btn-primary" disabled={saving || !readinessNotes.trim()}>{saving ? 'Saving' : 'Confirm readiness'}</button></footer></form></div>}
      {credentialRenewal && <div className="hr-review-backdrop"><form className="hr-review-dialog" role="dialog" aria-modal="true" aria-labelledby="credential-renewal-title" onSubmit={handleCredentialRenewal}><header><div><span>Credential evidence</span><h2 id="credential-renewal-title">Record renewal</h2></div><button type="button" onClick={() => setCredentialRenewal(null)} aria-label="Close credential renewal">×</button></header><p>The existing {credentialRenewal.source.credential_type.replaceAll('_',' ')} record remains in history. This replacement is verified against your evidence notes.</p><label><span>Credential number</span><input required value={credentialRenewal.credentialNumber} onChange={(event)=>setCredentialRenewal({...credentialRenewal,credentialNumber:event.target.value})}/></label><label><span>Issuing authority</span><input required value={credentialRenewal.issuingAuthority} onChange={(event)=>setCredentialRenewal({...credentialRenewal,issuingAuthority:event.target.value})}/></label><div className="form-row"><label><span>Issued date</span><input type="date" required value={credentialRenewal.issuedDate} onChange={(event)=>setCredentialRenewal({...credentialRenewal,issuedDate:event.target.value})}/></label><label><span>New expiry date</span><input type="date" required min={credentialRenewal.source.expiry_date??undefined} value={credentialRenewal.expiryDate} onChange={(event)=>setCredentialRenewal({...credentialRenewal,expiryDate:event.target.value})}/></label></div><label><span>Verification evidence notes</span><textarea rows={4} required minLength={10} value={credentialRenewal.evidenceNotes} onChange={(event)=>setCredentialRenewal({...credentialRenewal,evidenceNotes:event.target.value})}/></label><footer><button type="button" className="btn btn-secondary" onClick={()=>setCredentialRenewal(null)}>Back</button><button type="submit" className="btn btn-primary" disabled={saving||!credentialRenewal.credentialNumber.trim()||!credentialRenewal.issuingAuthority.trim()||!credentialRenewal.issuedDate||!credentialRenewal.expiryDate||credentialRenewal.evidenceNotes.trim().length<10}>{saving?'Saving':'Confirm renewal'}</button></footer></form></div>}
      {coverageFinalization&&<div className="hr-review-backdrop"><form className="hr-review-dialog" role="dialog" aria-modal="true" aria-labelledby="coverage-finalization-title" onSubmit={finalizeCoverage}><header><div><span>Coverage ownership</span><h2 id="coverage-finalization-title">Finalize assignment</h2></div><button type="button" onClick={()=>setCoverageFinalization(null)} aria-label="Close coverage finalization">×</button></header><p>Confirm the claimant against an active work unit. Field work creates the linked operational shift through the governed roster workflow.</p><label><span>Select work unit</span><select required value={coverageFinalization.workUnitId} onChange={(event)=>setCoverageFinalization({...coverageFinalization,workUnitId:event.target.value})}><option value="">Select work unit</option>{coverageWorkUnits.map((unit)=><option value={unit.id} key={unit.id}>{unit.name} · {unit.work_unit_type}</option>)}</select></label><label><span>Finalization notes</span><textarea rows={3} value={coverageFinalization.notes} onChange={(event)=>setCoverageFinalization({...coverageFinalization,notes:event.target.value})}/></label><footer><button type="button" className="btn btn-secondary" onClick={()=>setCoverageFinalization(null)}>Back</button><button type="submit" className="btn btn-primary" disabled={saving||!coverageFinalization.workUnitId}>{saving?'Finalizing':'Confirm assignment'}</button></footer></form></div>}
      </div>
    </div>
  );
};

export default RosterHRPage;
