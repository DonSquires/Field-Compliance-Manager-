/**
 * RosterHRPage.tsx
 *
 * Canonical schema: user_profiles (identity/role) + staff_profiles (employment
 * detail, 1:1 via id) + staff_credentials (licences/warrants, expiry) +
 * shift_templates (recurring coverage patterns) + leave_requests (approval
 * queue) + timesheets (hours, approval, payroll export).
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';
import './RosterHRPage.css';

type RosterTab = 'staff' | 'recruitment' | 'onboarding' | 'performance' | 'cases' | 'credentials' | 'shift-templates' | 'coverage' | 'leave' | 'timesheets' | 'pay-review' | 'assets' | 'oncall' | 'court';
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

interface RoleCodeRow { code: string; name: string; }

interface ReadinessAssessment { staff_id: string; user_id: string | null; work_ready: boolean; identity_status: string; employment_status: string; credential_status: string; training_status: string; blockers: string[]; }

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

interface TimesheetRow {
  id: string;
  staff_id: string;
  period_start: string;
  period_end: string;
  scheduled_hours: number | null;
  actual_hours: number | null;
  work_derived_hours: number | null;
  adjustment_hours: number;
  work_summary: { source_count?: number } | null;
  status: string;
}

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
  registration: string | null;
  make: string | null;
  model: string | null;
  status: string;
  assigned_to: string | null;
  last_inspection_date: string | null;
  next_inspection_date: string | null;
}

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

interface CourtRow {
  id: string;
  officer_user_id: string;
  court_name: string;
  case_reference: string | null;
  appearance_type: string;
  scheduled_at: string;
  estimated_hours: number;
  status: string;
  is_overtime: boolean;
}

const TABS: { id: RosterTab; label: string }[] = [
  { id: 'staff', label: 'Staff' },
  { id: 'recruitment', label: 'Recruitment' },
  { id: 'onboarding', label: 'Onboarding' },
  { id: 'performance', label: 'Performance' },
  { id: 'cases', label: 'HR Cases' },
  { id: 'credentials', label: 'Credentials' },
  { id: 'shift-templates', label: 'Shift Templates' },
  { id: 'coverage', label: 'Open Shifts' },
  { id: 'oncall', label: 'On-Call' },
  { id: 'court', label: 'Court' },
  { id: 'assets', label: 'Assets' },
  { id: 'leave', label: 'Leave' },
  { id: 'timesheets', label: 'Timesheets' },
  { id: 'pay-review', label: 'Pay Review' },
];

const TAB_GROUPS: { id: RosterTabGroup; label: string; tabs: RosterTab[] }[] = [
  { id: 'workforce', label: 'Workforce', tabs: ['staff', 'onboarding', 'credentials'] },
  { id: 'people', label: 'People', tabs: ['recruitment', 'performance', 'cases', 'leave'] },
  { id: 'rostering', label: 'Rostering', tabs: ['shift-templates', 'coverage', 'oncall', 'court'] },
  { id: 'pay-assets', label: 'Pay & Assets', tabs: ['timesheets', 'pay-review', 'assets'] },
];

const tabGroupFor = (tab: RosterTab): RosterTabGroup => TAB_GROUPS.find((group) => group.tabs.includes(tab))?.id ?? 'workforce';

const RosterHRPage: React.FC = () => {
  const location = useLocation();
  const requestedCredentialId = new URLSearchParams(location.search).get('credential');
  const { profile } = useAuth();
  const [tab, setTab] = useState<RosterTab>(new URLSearchParams(location.search).get('tab') === 'credentials' ? 'credentials' : 'staff');
  const [tabGroup, setTabGroup] = useState<RosterTabGroup>(tabGroupFor(new URLSearchParams(location.search).get('tab') === 'credentials' ? 'credentials' : 'staff'));
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
  const [offerAction, setOfferAction] = useState<{ candidate: RecruitmentCandidate; role: string; employmentType: string; startDate: string; note: string; accepted: boolean } | null>(null);
  const [readinessAssessments, setReadinessAssessments] = useState<ReadinessAssessment[]>([]);
  const [credentials, setCredentials] = useState<CredentialRow[]>([]);
  const [shiftTemplates, setShiftTemplates] = useState<ShiftTemplateRow[]>([]);
  const [leaveRequests, setLeaveRequests] = useState<LeaveRequestRow[]>([]);
  const [timesheets, setTimesheets] = useState<TimesheetRow[]>([]);
  const [dispatchPayLines, setDispatchPayLines] = useState<DispatchPayLineRow[]>([]);
  const [dispatchPayLineReviews, setDispatchPayLineReviews] = useState<DispatchPayLineReviewRow[]>([]);
  const [payReviewGovernanceAvailable, setPayReviewGovernanceAvailable] = useState(false);
  const [payLineReview, setPayLineReview] = useState<{ line: DispatchPayLineRow; expectedReviewId: string | null; decision: 'approved' | 'rejected'; notes: string } | null>(null);
  const [payReviewFilter, setPayReviewFilter] = useState<'exceptions' | 'resolved' | 'all'>('exceptions');
  const [roleCodes, setRoleCodes] = useState<RoleCodeRow[]>([]);
  const [payRoleDrafts, setPayRoleDrafts] = useState<Record<string, string>>({});
  const [staffNames, setStaffNames] = useState<Record<string, string>>({});
  const [coverageRequests, setCoverageRequests] = useState<CoverageRequestRow[]>([]);
    const [coverageWorkUnits,setCoverageWorkUnits]=useState<CoverageWorkUnit[]>([]);
    const [coverageFinalization,setCoverageFinalization]=useState<{request:CoverageRequestRow;workUnitId:string;notes:string}|null>(null);
  const [showCoverageForm, setShowCoverageForm] = useState(false);
  const [review, setReview] = useState<{ kind: 'leave' | 'timesheet'; id: string; decision: 'approved' | 'declined' | 'rejected' } | null>(null);
  const [reviewNotes, setReviewNotes] = useState('');
  const [readinessReview, setReadinessReview] = useState<{ staffId: string; name: string; current: boolean; next: boolean } | null>(null);
  const [credentialRenewal, setCredentialRenewal] = useState<{ source: CredentialRow; credentialNumber: string; issuingAuthority: string; issuedDate: string; expiryDate: string; evidenceNotes: string } | null>(null);
  const [readinessNotes, setReadinessNotes] = useState('');
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
  const [onCallPeriods, setOnCallPeriods] = useState<OnCallRow[]>([]);
  const [callouts, setCallouts] = useState<CalloutRow[]>([]);
  const [courtAppearances, setCourtAppearances] = useState<CourtRow[]>([]);
  const [assetCheck, setAssetCheck] = useState<{ asset: AssetRow; condition: string; odometer: string; fuel: string; defects: string } | null>(null);
  const [payrollExport, setPayrollExport] = useState<{ from: string; to: string } | null>(null);
  const [onboardingAction, setOnboardingAction] = useState<{ staffId: string; ledgerId?: string; version?: number; nextStage?: string; name: string; note: string } | null>(null);
  const [evidenceAction, setEvidenceAction] = useState<{ staffId: string; name: string; action: 'add_skill' | 'assign_line_manager' | 'record_induction' | 'record_document'; note: string; skillName: string; skillCategory: string; proficiency: string; managerId: string; trainingName: string; documentType: string; fileName: string; storagePath: string } | null>(null);
  const [templateForm, setTemplateForm] = useState({
    name: '',
    shift_type: 'day',
    start_time: '08:00',
    end_time: '16:00',
    recurrence_type: 'weekly',
    required_staff_count: '1',
    notes: '',
  });

  // ATLAS READS: user_profiles, staff_profiles, staff_credentials,
  // shift_templates, leave_requests, timesheets, shift_coverage_requests
  const loadAll = useCallback(async () => {
    const orgId = profile?.organizationId;
    if (!orgId) return;

    try {
      setLoading(true);
      setError(null);

      const [profilesRes, staffProfilesRes, roleCodesRes, credentialsRes, templatesRes, leaveRes, timesheetsRes, payLinesRes, payLineReviewsRes, coverageRes, readinessRes, workUnitsRes, assetsRes, onCallRes, calloutRes, courtRes, onboardingRes, vacanciesRes, candidatesRes, cyclesRes, reviewsRes, casesRes] =
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
            .select('code, name')
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
          supabase
            .from('leave_requests')
            .select('id, staff_id, leave_type, starts_on, ends_on, status, reason')
            .eq('organization_id', orgId)
            .order('starts_on', { ascending: false }),
          supabase
            .from('timesheets')
            .select('id, staff_id, period_start, period_end, scheduled_hours, actual_hours, work_derived_hours, adjustment_hours, work_summary, status')
            .eq('organization_id', orgId)
            .order('period_start', { ascending: false }),
          supabase
            .from('dispatch_job_pay_lines')
            .select('id, source_dispatch_id, officer_user_id, rate_rule_id, pay_code, rate_type, description, quantity, unit_rate, line_total, distance_km, distance_reason, created_at')
            .eq('organization_id', orgId)
            .order('created_at', { ascending: false })
            .limit(100),
          supabase
            .from('dispatch_job_pay_line_reviews')
            .select('id, pay_line_id, decision, review_notes, reviewed_at, supersedes_review_id')
            .eq('organization_id', orgId)
            .order('reviewed_at', { ascending: false })
            .limit(200),
          supabase
            .from('shift_coverage_requests')
            .select('id, shift_date, start_time, end_time, required_staff_count, urgency, status, notes, claimed_by, roster_slot_id, site:site_id(name)')
            .eq('organization_id', orgId)
            .in('status', ['open', 'claimed'])
            .order('urgency', { ascending: false })
            .order('shift_date', { ascending: true }),
          supabase.rpc('get_staff_readiness_assessment', { p_organization_id: orgId }),
                  supabase.from('roster_work_units').select('id,name,work_unit_type').eq('organization_id',orgId).eq('active',true).order('name'),
          supabase.from('assets').select('id,asset_type,name,registration,make,model,status,assigned_to,last_inspection_date,next_inspection_date').eq('organization_id', orgId).order('asset_type').order('name'),
          supabase.from('on_call_periods').select('id,officer_user_id,period_type,starts_at,ends_at,flat_rate,status').eq('organization_id', orgId).order('starts_at', { ascending: false }).limit(50),
          supabase.from('callout_shifts').select('id,on_call_period_id,officer_user_id,status,minimum_pay_hours,callout_received_at,work_started_at,work_ended_at').eq('organization_id', orgId).order('callout_received_at', { ascending: false }).limit(50),
          supabase.from('court_appearances').select('id,officer_user_id,court_name,case_reference,appearance_type,scheduled_at,estimated_hours,status,is_overtime').eq('organization_id', orgId).order('scheduled_at', { ascending: false }).limit(50),
          supabase.rpc('get_staff_onboarding_readiness', { p_organization_id: orgId }),
          supabase.from('recruitment_vacancies').select('id,title,employment_type,location_summary,status,opens_on,closes_on').eq('organization_id', orgId).order('created_at', { ascending: false }),
          supabase.from('recruitment_candidates').select('id,vacancy_id,first_name,last_name,email,stage,status,offer_role,offer_employment_type,offer_start_date').eq('organization_id', orgId).order('created_at', { ascending: false }),
          supabase.from('performance_review_cycles').select('id,name,period_start,period_end,due_date,status').eq('organization_id', orgId).order('due_date', { ascending: false }),
          supabase.from('performance_reviews').select('id,staff_id,reviewer_user_id,status,rating,cycle_id').eq('organization_id', orgId).order('created_at', { ascending: false }),
          supabase.from('hr_cases').select('id,staff_id,case_type,severity,status,subject,opened_at').eq('organization_id', orgId).order('opened_at', { ascending: false }),
        ]);

      if (profilesRes.error) throw profilesRes.error;
      if (staffProfilesRes.error) throw staffProfilesRes.error;
      if (roleCodesRes.error) throw roleCodesRes.error;
      if (credentialsRes.error) throw credentialsRes.error;
      if (templatesRes.error) throw templatesRes.error;
      if (leaveRes.error) throw leaveRes.error;
      if (timesheetsRes.error) throw timesheetsRes.error;
      if (payLinesRes.error) throw payLinesRes.error;
      if (payLineReviewsRes.error && payLineReviewsRes.error.code !== 'PGRST205') throw payLineReviewsRes.error;
      if (coverageRes.error) throw coverageRes.error;
      if (readinessRes.error) throw readinessRes.error;
  if(workUnitsRes.error)throw workUnitsRes.error;
        if (onboardingRes.error) throw onboardingRes.error;
        if (vacanciesRes.error) throw vacanciesRes.error;
        if (candidatesRes.error) throw candidatesRes.error;
        if (cyclesRes.error) throw cyclesRes.error;
        if (reviewsRes.error) throw reviewsRes.error;
        if (casesRes.error) throw casesRes.error;

      setAssets((assetsRes.data as AssetRow[]) ?? []);
      setOnCallPeriods((onCallRes.data as OnCallRow[]) ?? []);
      setCallouts((calloutRes.data as CalloutRow[]) ?? []);
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
      setShiftTemplates((templatesRes.data as ShiftTemplateRow[]) || []);
      setLeaveRequests((leaveRes.data as LeaveRequestRow[]) || []);
      setTimesheets((timesheetsRes.data as TimesheetRow[]) || []);
      setDispatchPayLines((payLinesRes.data as DispatchPayLineRow[]) || []);
      setDispatchPayLineReviews((payLineReviewsRes.data as DispatchPayLineReviewRow[]) || []);
      setPayReviewGovernanceAvailable(!payLineReviewsRes.error);
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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load roster data');
    } finally {
      setLoading(false);
    }
  }, [profile?.organizationId]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (!requestedCredentialId) return;
    setTab('credentials');
    setTabGroup('workforce');
    document.getElementById(`credential-${requestedCredentialId}`)?.scrollIntoView({ block: 'center' });
  }, [credentials, requestedCredentialId]);

  const handleReview = async (event: React.FormEvent) => {
    event.preventDefault();if (!review) return;setSaving(true);setError(null);setNotice(null);
    const currentStatus = review.kind === 'leave' ? leaveRequests.find((item) => item.id === review.id)?.status : timesheets.find((item) => item.id === review.id)?.status;
    const { error: reviewError } = review.kind === 'leave'
      ? await supabase.rpc('review_leave_request', { p_request_id: review.id, p_expected_status: currentStatus, p_decision: review.decision, p_review_notes: reviewNotes.trim() || null })
      : await supabase.rpc('review_timesheet', { p_timesheet_id: review.id, p_expected_status: currentStatus, p_decision: review.decision, p_review_notes: reviewNotes.trim() || null });
    if (reviewError) setError(reviewError.message);else { setNotice(review.kind === 'leave' ? 'Leave decision confirmed and roster conflicts checked.' : 'Timesheet decision confirmed for payroll processing.');setReview(null);setReviewNotes('');await loadAll(); }setSaving(false);
  };

  const handleReadinessReview = async (event: React.FormEvent) => {
    event.preventDefault();if (!readinessReview || !readinessNotes.trim()) return;setSaving(true);setError(null);setNotice(null);
    const { error: readinessError } = await supabase.rpc('set_staff_work_readiness', { p_staff_id: readinessReview.staffId, p_expected_work_ready: readinessReview.current, p_work_ready: readinessReview.next, p_review_notes: readinessNotes.trim() });
    if (readinessError) setError(readinessError.message);else { setNotice(`${readinessReview.name} readiness updated and audited.`);setReadinessReview(null);setReadinessNotes('');await loadAll(); }setSaving(false);
  };

  const saveStaffPayRole = async (person: StaffRow) => {
    if (!person.staff_id) return;
    setSaving(true); setError(null); setNotice(null);
    const { error: payRoleError } = await supabase.rpc('set_staff_pay_role_code', {
      p_staff_id: person.staff_id,
      p_expected_role_code: person.role_code,
      p_role_code: (payRoleDrafts[person.id] ?? person.role_code ?? '').trim() || null,
    });
    if (payRoleError) setError(payRoleError.message);
    else { setNotice(`Payroll role updated for ${person.display_name || person.email || 'staff member'}.`); await loadAll(); }
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

  const handlePayrollExport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!payrollExport || !profile?.organizationId) return;
    setSaving(true); setError(null); setNotice(null);
    const { data, error: exportError } = await supabase.rpc('create_payroll_export_batch', {
      p_client_request_id: crypto.randomUUID(),
      p_organization_id: profile.organizationId,
      p_period_from: payrollExport.from,
      p_period_to: payrollExport.to,
      p_format: 'csv',
    });
    const receipt = Array.isArray(data) ? data[0] : data;
    if (exportError || !receipt) setError(exportError?.message ?? 'Payroll export was not confirmed.');
    else {
      setNotice(`Payroll batch created: ${receipt.timesheet_count} timesheets, ${Number(receipt.total_hours).toFixed(2)} hours.`);
      setPayrollExport(null);
      await loadAll();
    }
    setSaving(false);
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

  const recordOnboardingEvidence = async (event: React.FormEvent) => {
    event.preventDefault(); if (!evidenceAction) return;
    setSaving(true); setError(null); setNotice(null);
    const { error: evidenceError } = await supabase.rpc('manage_staff_onboarding_evidence', {
      p_client_request_id: crypto.randomUUID(), p_staff_id: evidenceAction.staffId, p_action: evidenceAction.action,
      p_skill_name: evidenceAction.skillName.trim() || null, p_skill_category: evidenceAction.skillCategory || null,
      p_proficiency_level: evidenceAction.proficiency || null, p_reports_to_user_id: evidenceAction.managerId || null,
      p_training_name: evidenceAction.trainingName.trim() || null, p_document_type: evidenceAction.documentType || null,
      p_file_name: evidenceAction.fileName.trim() || null, p_storage_path: evidenceAction.storagePath.trim() || null,
      p_notes: evidenceAction.note.trim() || null,
    });
    if (evidenceError) setError(evidenceError.message);
    else { setNotice('Staff onboarding evidence recorded.'); setEvidenceAction(null); await loadAll(); }
    setSaving(false);
  };

  const nextOnboardingStage = (stage: string) => ({ identity: 'employment', employment: 'evidence', evidence: 'supervision', supervision: 'induction', induction: 'review', review: 'ready' } as Record<string, string>)[stage] ?? null;

  const openEvidence = (staffId: string, name: string, action: 'add_skill' | 'assign_line_manager' | 'record_induction' | 'record_document') => {
    setEvidenceAction({ staffId, name, action, note: '', skillName: '', skillCategory: 'technical', proficiency: 'competent', managerId: '', trainingName: '', documentType: 'policy_acknowledgement', fileName: '', storagePath: '' });
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
      setOfferAction({ candidate: candidateAction.candidate, role: 'officer', employmentType: 'permanent', startDate: '', note: candidateAction.note, accepted: false });
      setCandidateAction(null);
      return;
    }
    setSaving(true); setError(null); setNotice(null);
    const { error: advanceError } = await supabase.rpc('manage_recruitment_candidate', { p_candidate_id: candidateAction.candidate.id, p_expected_stage: candidateAction.candidate.stage, p_next_stage: candidateAction.nextStage, p_note: candidateAction.note.trim(), p_offer_role: candidateAction.nextStage === 'offer' ? candidateAction.offerRole : null, p_offer_employment_type: candidateAction.nextStage === 'offer' ? candidateAction.offerEmploymentType : null, p_offer_start_date: candidateAction.nextStage === 'offer' ? candidateAction.offerStartDate : null });
    if (advanceError) setError(advanceError.message);
    else { setNotice(`Candidate moved to ${candidateAction.nextStage.replaceAll('_', ' ')}.`); setCandidateAction(null); await loadAll(); }
    setSaving(false);
  };

  const sendOffer = async (event: React.FormEvent) => {
    event.preventDefault(); if (!offerAction) return;
    setSaving(true); setError(null); setNotice(null);
    const { error: offerError } = await supabase.rpc('manage_recruitment_candidate', { p_candidate_id: offerAction.candidate.id, p_expected_stage: offerAction.candidate.stage, p_next_stage: 'offer', p_note: offerAction.note.trim(), p_offer_role: offerAction.role, p_offer_employment_type: offerAction.employmentType, p_offer_start_date: offerAction.startDate });
    if (offerError) setError(offerError.message);
    else if (offerAction.accepted && profile?.organizationId) {
      try {
        const candidate = offerAction.candidate;
        const { data: provisioned, error: provisionError } = await supabase.functions.invoke('create-user', { body: { email: candidate.email, display_name: `${candidate.first_name} ${candidate.last_name}`.trim(), role: offerAction.role, organization_id: profile.organizationId, staff: { employment_type: offerAction.employmentType, start_date: offerAction.startDate } } });
        if (provisionError || !provisioned?.user_id || !provisioned?.staff_id) throw provisionError ?? new Error('Identity provisioning receipt was not confirmed.');
        const { error: convertError } = await supabase.rpc('convert_recruitment_candidate_to_staff', { p_candidate_id: candidate.id, p_user_id: provisioned.user_id, p_staff_id: provisioned.staff_id, p_note: offerAction.note.trim() });
        if (convertError) throw convertError;
        setNotice(`${candidate.first_name} ${candidate.last_name} provisioned and handed to staff onboarding.`);
      } catch (conversionError) {
        setError(conversionError instanceof Error ? conversionError.message : 'Offer was recorded, but staff provisioning could not be confirmed.');
      }
      setOfferAction(null); await loadAll();
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

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading roster & HR data...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container roster-hr-page">
      <header className="page-header">
        <h1>Roster & HR</h1>
        <p className="subtitle">{staff.length} staff · Credentials, shifts, leave, timesheets</p>
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

      <div className="crm-branch-filter" aria-label="Roster and HR workspace">
        {TAB_GROUPS.map((group) => (
          <button type="button" key={group.id} className={`btn btn-sm ${tabGroup === group.id ? 'btn-primary' : 'btn-secondary'}`} onClick={() => { setTabGroup(group.id); setTab(group.tabs[0]); }}>
            {group.label}
          </button>
        ))}
      </div>
      <div className="roster-hr-tab-list" aria-label={`${TAB_GROUPS.find((group) => group.id === tabGroup)?.label} views`}>
        {TABS.filter((item) => tabGroupFor(item.id) === tabGroup).map((t) => (
          <button
            key={t.id}
            className={`btn btn-sm ${tab === t.id ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => { setTab(t.id); setTabGroup(tabGroupFor(t.id)); }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'staff' && (
        <section className="reports-section">
          <h2>Staff ({staff.length})</h2>
          <div className="contacts-list">
            {staff.length === 0 ? (
              <div className="empty-state">
                <p>No staff records for this organisation.</p>
              </div>
            ) : (
              staff.map((s) => (
                <div key={s.id} className="contact-card">
                  <div className="contact-header">
                    <h3>{s.display_name || s.email || 'Unnamed'}</h3>
                    <span className="contact-type-badge">{s.role}</span>
                  </div>
                  <div className="contact-details">
                    <p>{s.email}</p>
                    <p className="contact-meta">
                      {s.employment_type || 'employment type not set'}
                      {s.start_date ? ` · started ${new Date(s.start_date).toLocaleDateString()}` : ''}
                      {s.work_ready === false ? ' · NOT work ready' : ''}
                    </p>
                    {s.staff_id && <div className="form-row" style={{ marginTop: '0.75rem' }}><label><span>Payroll role</span><select value={payRoleDrafts[s.id] ?? s.role_code ?? ''} onChange={(event) => setPayRoleDrafts((drafts) => ({ ...drafts, [s.id]: event.target.value }))}><option value="">No role code assigned</option>{roleCodes.map((code) => <option value={code.code} key={code.code}>{code.code} · {code.name}</option>)}</select></label><button type="button" className="btn btn-sm btn-secondary" disabled={saving || ((payRoleDrafts[s.id] ?? s.role_code ?? '') === (s.role_code ?? ''))} onClick={() => void saveStaffPayRole(s)}>Save payroll role</button></div>}
                    {s.staff_id && (() => { const assessment = readinessAssessments.find((item) => item.staff_id === s.staff_id); return assessment ? <div className="hr-readiness"><div><span>Identity</span><strong>{assessment.identity_status.replaceAll('_', ' ')}</strong></div><div><span>Employment</span><strong>{assessment.employment_status.replaceAll('_', ' ')}</strong></div><div><span>Credentials</span><strong>{assessment.credential_status.replaceAll('_', ' ')}</strong></div><div><span>Training advisory</span><strong>{assessment.training_status}</strong></div>{assessment.blockers.length > 0 && <p>{assessment.blockers.join(' · ')}</p>}<button type="button" className={`btn btn-sm ${assessment.work_ready ? 'btn-danger' : 'btn-primary'}`} onClick={() => { setReadinessNotes('');setReadinessReview({ staffId: assessment.staff_id, name: s.display_name || s.email || 'Staff member', current: assessment.work_ready, next: !assessment.work_ready }); }}>{assessment.work_ready ? 'Remove work readiness' : 'Mark work ready'}</button></div> : null; })()}
                  </div>
                </div>
              ))
            )}
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
          <h3 style={{ marginTop: '1.5rem' }}>Candidates ({candidates.length})</h3><div className="contacts-list">{candidates.length === 0 ? <div className="empty-state"><p>No candidates recorded.</p></div> : candidates.map((candidate) => { const vacancy = vacancies.find((item) => item.id === candidate.vacancy_id); const nextStage = ({ applied: 'screening', screening: 'interview', interview: 'reference_check', reference_check: 'offer' } as Record<string, string>)[candidate.stage]; return <div key={candidate.id} className="contact-card"><div className="contact-header"><h3>{candidate.first_name} {candidate.last_name}</h3><span className={`status-badge status-${candidate.status}`}>{candidate.stage.replaceAll('_', ' ')}</span></div><div className="contact-details"><p>{candidate.email} · {vacancy?.title ?? 'Vacancy unavailable'}</p>{candidate.offer_start_date && <p className="contact-meta">Offer: {candidate.offer_role ?? 'role'} · starts {new Date(candidate.offer_start_date).toLocaleDateString()}</p>}</div>{nextStage && <button type="button" className="btn btn-sm btn-secondary" onClick={() => setCandidateAction({ candidate, nextStage, note: '' })}>Move to {nextStage.replaceAll('_', ' ')}</button>}</div>; })}</div>
        </section>
      )}

      {tab === 'performance' && <section className="reports-section"><h2>Performance Reviews</h2><button type="button" className="btn btn-sm btn-primary" onClick={() => setShowCycleForm((value) => !value)}>{showCycleForm ? 'Cancel' : 'New review cycle'}</button>{showCycleForm && <form className="assessment-form" onSubmit={createPerformanceCycle}><label><span>Cycle name</span><input required value={cycleForm.name} onChange={(event) => setCycleForm({ ...cycleForm, name: event.target.value })} /></label><div className="form-row"><label><span>Period start</span><input type="date" required value={cycleForm.start} onChange={(event) => setCycleForm({ ...cycleForm, start: event.target.value })} /></label><label><span>Period end</span><input type="date" required value={cycleForm.end} onChange={(event) => setCycleForm({ ...cycleForm, end: event.target.value })} /></label><label><span>Due</span><input type="date" required value={cycleForm.due} onChange={(event) => setCycleForm({ ...cycleForm, due: event.target.value })} /></label></div><button type="submit" className="btn btn-primary" disabled={saving}>Create draft cycle</button></form>}<div className="contacts-list">{performanceCycles.length === 0 ? <div className="empty-state"><p>No performance cycles configured.</p></div> : performanceCycles.map((cycle) => <div className="contact-card" key={cycle.id}><div className="contact-header"><h3>{cycle.name}</h3><span className={`status-badge status-${cycle.status}`}>{cycle.status}</span></div><div className="contact-details"><p>{new Date(cycle.period_start).toLocaleDateString()} – {new Date(cycle.period_end).toLocaleDateString()} · due {new Date(cycle.due_date).toLocaleDateString()}</p><p className="contact-meta">{performanceReviews.filter((review) => review.cycle_id === cycle.id).length} assigned reviews</p></div></div>)}</div></section>}

      {tab === 'performance' && <section className="reports-section"><div className="assessment-actions"><button type="button" className="btn btn-sm btn-secondary" onClick={() => setShowReviewForm((value) => !value)} disabled={!performanceCycles.some((cycle) => cycle.status === 'open')}>{showReviewForm ? 'Cancel assignment' : 'Assign review'}</button></div>{showReviewForm && <form className="assessment-form" onSubmit={createPerformanceReview}><label><span>Open review cycle</span><select required value={reviewForm.cycleId} onChange={(event) => setReviewForm({ ...reviewForm, cycleId: event.target.value })}><option value="">Select cycle</option>{performanceCycles.filter((cycle) => cycle.status === 'open').map((cycle) => <option value={cycle.id} key={cycle.id}>{cycle.name}</option>)}</select></label><div className="form-row"><label><span>Staff member</span><select required value={reviewForm.staffId} onChange={(event) => setReviewForm({ ...reviewForm, staffId: event.target.value })}><option value="">Select staff</option>{staff.filter((person) => person.staff_id).map((person) => <option value={person.staff_id!} key={person.staff_id}>{person.display_name ?? person.email}</option>)}</select></label><label><span>Reviewer</span><select required value={reviewForm.reviewerId} onChange={(event) => setReviewForm({ ...reviewForm, reviewerId: event.target.value })}><option value="">Select reviewer</option>{staff.map((person) => <option value={person.id} key={person.id}>{person.display_name ?? person.email}</option>)}</select></label></div><button type="submit" className="btn btn-primary" disabled={saving || !reviewForm.cycleId || !reviewForm.staffId || !reviewForm.reviewerId}>{saving ? 'Saving' : 'Assign review'}</button></form>}<h3>Cycle actions</h3><div className="contacts-list">{performanceCycles.map((cycle) => <div key={cycle.id} className="contact-card"><div className="contact-header"><h3>{cycle.name}</h3><span className={`status-badge status-${cycle.status}`}>{cycle.status}</span></div><div className="contact-details"><p>{performanceReviews.filter((review) => review.cycle_id === cycle.id).length} review records</p></div>{cycle.status === 'draft' && <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={() => void transitionCycle(cycle, 'open')}>Open cycle</button>}{cycle.status === 'open' && <button type="button" className="btn btn-sm btn-secondary" disabled={saving} onClick={() => void transitionCycle(cycle, 'close')}>Close cycle</button>}</div>)}</div><h3 style={{ marginTop: '1.5rem' }}>Assigned Reviews</h3><div className="contacts-list">{performanceReviews.length === 0 ? <div className="empty-state"><p>No reviews assigned.</p></div> : performanceReviews.map((review) => <div key={review.id} className="contact-card"><div className="contact-header"><h3>{staffNames[review.staff_id] ?? 'Staff member'}</h3><span className={`status-badge status-${review.status}`}>{review.status}</span></div><div className="contact-details"><p>Reviewer: {staffNames[review.reviewer_user_id] ?? 'Assigned reviewer'}{review.rating ? ` · rating ${review.rating}/5` : ''}</p></div>{review.status !== 'completed' && <button type="button" className="btn btn-sm btn-primary" onClick={() => { setReviewCompletion({ rating: '3', strengths: '', goals: '', comments: '' }); setReviewAction(review); }}>Complete review</button>}</div>)}</div></section>}

      {tab === 'cases' && <section className="reports-section"><h2>Private HR Cases</h2><button type="button" className="btn btn-sm btn-primary" onClick={() => setShowCaseForm((value) => !value)}>{showCaseForm ? 'Cancel' : 'Open HR case'}</button>{showCaseForm && <form className="assessment-form" onSubmit={createHrCase}><label><span>Staff member</span><select required value={caseForm.staffId} onChange={(event) => setCaseForm({ ...caseForm, staffId: event.target.value })}><option value="">Select staff member</option>{staff.filter((person) => person.staff_id).map((person) => <option key={person.staff_id} value={person.staff_id!}>{person.display_name ?? person.email}</option>)}</select></label><div className="form-row"><label><span>Case type</span><select value={caseForm.type} onChange={(event) => setCaseForm({ ...caseForm, type: event.target.value })}><option value="disciplinary">Disciplinary</option><option value="grievance">Grievance</option><option value="wellbeing">Wellbeing</option><option value="conduct">Conduct</option><option value="other">Other</option></select></label><label><span>Severity</span><select value={caseForm.severity} onChange={(event) => setCaseForm({ ...caseForm, severity: event.target.value })}><option value="low">Low</option><option value="standard">Standard</option><option value="high">High</option><option value="critical">Critical</option></select></label></div><label><span>Subject</span><input required value={caseForm.subject} onChange={(event) => setCaseForm({ ...caseForm, subject: event.target.value })} /></label><label><span>Summary</span><textarea required rows={4} value={caseForm.summary} onChange={(event) => setCaseForm({ ...caseForm, summary: event.target.value })} /></label><button type="submit" className="btn btn-primary" disabled={saving}>Open private case</button></form>}<div className="contacts-list">{hrCases.length === 0 ? <div className="empty-state"><p>No private HR cases recorded.</p></div> : hrCases.map((item) => <div className="contact-card" key={item.id}><div className="contact-header"><h3>{item.subject}</h3><span className={`status-badge status-${item.status}`}>{item.status}</span></div><div className="contact-details"><p>{staffNames[item.staff_id] ?? 'Staff member'} · {item.case_type} · {item.severity}</p><p className="contact-meta">Opened {new Date(item.opened_at).toLocaleString()}</p></div></div>)}</div></section>}

      {tab === 'cases' && <section className="reports-section"><h2>Case Actions</h2><div className="contacts-list">{hrCases.filter((item) => ['open','in_review'].includes(item.status)).length === 0 ? <div className="empty-state"><p>No open HR cases require action.</p></div> : hrCases.filter((item) => ['open','in_review'].includes(item.status)).map((item) => <div key={item.id} className="contact-card"><div className="contact-header"><h3>{item.subject}</h3><span className={`status-badge status-${item.status}`}>{item.status}</span></div><div className="contact-details"><p>{staffNames[item.staff_id] ?? 'Staff member'} · {item.case_type} · {item.severity}</p></div><div className="assessment-actions">{item.status === 'open' && <button type="button" className="btn btn-sm btn-secondary" onClick={() => setCaseAction({ item, action: 'review', note: '' })}>Start review</button>}<button type="button" className="btn btn-sm btn-secondary" onClick={() => setCaseAction({ item, action: 'note', note: '' })}>Add note</button><button type="button" className="btn btn-sm btn-primary" onClick={() => setCaseAction({ item, action: 'resolve', note: '' })}>Resolve</button><button type="button" className="btn btn-sm btn-danger" onClick={() => setCaseAction({ item, action: 'withdraw', note: '' })}>Withdraw</button></div></div>)}</div></section>}

      {tab === 'onboarding' && (
        <section className="reports-section">
          <h2>Staff Onboarding ({onboarding.length})</h2>
          <div className="contacts-list">
            {staff.filter((person) => person.staff_id).map((person) => {
              const ledger = onboarding.find((item) => item.staff_id === person.staff_id);
              const nextStage = ledger ? nextOnboardingStage(ledger.current_stage) : null;
              return <div key={person.id} className="contact-card">
                <div className="contact-header"><h3>{person.display_name ?? person.email ?? 'Staff member'}</h3><span className={`status-badge status-${ledger?.status ?? 'not_started'}`}>{ledger?.status?.replaceAll('_', ' ') ?? 'Not started'}</span></div>
                <div className="contact-details">
                  <p>{ledger ? `Stage: ${ledger.current_stage.replaceAll('_', ' ')}${ledger.target_start ? ` · target ${new Date(ledger.target_start).toLocaleDateString()}` : ''}` : 'Create a durable onboarding record after the identity invitation is sent.'}</p>
                  {ledger?.blockers?.length ? <p className="contact-meta">{ledger.blockers.join(' · ')}</p> : null}
                </div>
                {!ledger ? <button type="button" className="btn btn-sm btn-primary" onClick={() => setOnboardingAction({ staffId: person.staff_id!, name: person.display_name ?? person.email ?? 'Staff member', note: 'Onboarding started' })}>Start onboarding</button> : nextStage && <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={() => setOnboardingAction({ staffId: person.staff_id!, ledgerId: ledger.ledger_id, version: ledger.version, nextStage, name: ledger.display_name, note: '' })}>Advance to {nextStage}</button>}
              </div>;
            })}
          </div>
        </section>
      )}

      {tab === 'onboarding' && <section className="reports-section"><h2>Record Onboarding Evidence</h2><div className="contacts-list">{staff.filter((person) => person.staff_id).map((person) => <div className="contact-card" key={`evidence-${person.id}`}><div className="contact-header"><h3>{person.display_name ?? person.email ?? 'Staff member'}</h3><span className="contact-type-badge">Evidence</span></div><div className="assessment-actions"><button type="button" className="btn btn-sm btn-secondary" onClick={() => openEvidence(person.staff_id!, person.display_name ?? person.email ?? 'Staff member', 'add_skill')}>Add skill</button><button type="button" className="btn btn-sm btn-secondary" onClick={() => openEvidence(person.staff_id!, person.display_name ?? person.email ?? 'Staff member', 'assign_line_manager')}>Assign manager</button><button type="button" className="btn btn-sm btn-secondary" onClick={() => openEvidence(person.staff_id!, person.display_name ?? person.email ?? 'Staff member', 'record_induction')}>Record induction</button><button type="button" className="btn btn-sm btn-secondary" onClick={() => openEvidence(person.staff_id!, person.display_name ?? person.email ?? 'Staff member', 'record_document')}>Register document</button></div></div>)}</div></section>}

      {tab === 'credentials' && (
        <section className="reports-section">
          <h2>Credentials ({credentials.length})</h2>
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
                      No credentials recorded
                    </td>
                  </tr>
                ) : (
                  credentials.map((c) => (
                    <tr key={c.id} id={`credential-${c.id}`} className={c.id === requestedCredentialId ? 'is-context-focus' : undefined}>
                      <td>{staffNames[c.staff_id] || c.staff_id}</td>
                      <td>{c.credential_type}</td>
                      <td>{c.credential_number || '-'}</td>
                      <td>
                        <span className={isExpiringSoon(c.expiry_date) ? 'severity-badge severity-high' : ''}>
                          {c.expiry_date ? new Date(c.expiry_date).toLocaleDateString() : 'No expiry'}
                        </span>
                      </td>
                      <td>{c.verified ? '✓' : '—'}</td>
                      <td><button type="button" className="btn btn-sm btn-primary" disabled={!c.expiry_date} onClick={() => { credentialRequestId.current=crypto.randomUUID();setCredentialRenewal({ source:c,credentialNumber:c.credential_number??'',issuingAuthority:c.issuing_authority??'',issuedDate:new Date().toISOString().slice(0,10),expiryDate:'',evidenceNotes:'' }); }}>Record renewal</button></td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
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
                      <button className="btn btn-sm btn-secondary" onClick={() => { setReviewNotes('');setReview({ kind: 'leave', id: l.id, decision: 'approved' }); }}>
                        Approve
                      </button>
                      <button className="btn btn-sm btn-danger" onClick={() => { setReviewNotes('');setReview({ kind: 'leave', id: l.id, decision: 'declined' }); }}>
                        Decline
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </section>
      )}

      {tab === 'timesheets' && (
        <section className="reports-section">
          <h2>Timesheets ({timesheets.length})</h2>
          <button className="btn btn-primary btn-sm" style={{ marginBottom: '1rem' }} onClick={() => { const now = new Date(); setPayrollExport({ from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10), to: new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10) }); }}>
            Export approved to payroll
          </button>
          <div className="reports-table-wrapper">
            <table className="reports-table">
              <thead>
                <tr>
                  <th>Staff</th>
                  <th>Period</th>
                  <th>Scheduled</th>
                  <th>Derived work</th>
                  <th>Adjustment</th>
                  <th>Actual</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {timesheets.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="text-center">
                      No timesheets
                    </td>
                  </tr>
                ) : (
                  timesheets.map((t) => (
                    <tr key={t.id}>
                      <td>{staffNames[t.staff_id] || t.staff_id}</td>
                      <td>
                        {new Date(t.period_start).toLocaleDateString()} –{' '}
                        {new Date(t.period_end).toLocaleDateString()}
                      </td>
                      <td>{t.scheduled_hours ?? '-'}</td>
                      <td>{t.work_derived_hours ?? '-'}{t.work_summary?.source_count !== undefined ? ` · ${t.work_summary.source_count} sources` : ''}</td>
                      <td>{t.adjustment_hours || 0}</td>
                      <td>{t.actual_hours ?? '-'}</td>
                      <td>
                        <span className={`status-badge status-${t.status}`}>{t.status}</span>
                      </td>
                      <td>
                        {t.status === 'submitted' && (
                          <>
                            <button
                              className="btn btn-sm btn-secondary"
                              onClick={() => { setReviewNotes('');setReview({ kind: 'timesheet', id: t.id, decision: 'approved' }); }}
                            >
                              Approve
                            </button>{' '}
                            <button
                              className="btn btn-sm btn-danger"
                              onClick={() => { setReviewNotes('');setReview({ kind: 'timesheet', id: t.id, decision: 'rejected' }); }}
                            >
                              Reject
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
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
              <thead><tr><th>Staff</th><th>Dispatch source</th><th>Pay item</th><th>Quantity</th><th>Rate</th><th>Total</th><th>Evidence state</th><th>Review</th></tr></thead>
              <tbody>
                {dispatchPayLines.filter((line) => payReviewFilter === 'all' || (payReviewFilter === 'exceptions' ? line.pay_code === 'UNRESOLVED' : line.pay_code !== 'UNRESOLVED')).length === 0 ? (
                  <tr><td colSpan={8} className="text-center">No {payReviewFilter === 'exceptions' ? 'unresolved' : payReviewFilter === 'resolved' ? 'rule-resolved' : 'completed-dispatch'} pay evidence.</td></tr>
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
          <h2>Fleet &amp; Equipment ({assets.length})</h2>
          <div className="reports-table-wrapper">
            <table className="reports-table">
              <thead>
                <tr><th>Asset</th><th>Type</th><th>Identifier</th><th>Assigned</th><th>Last check</th><th>Status</th><th>Action</th></tr>
              </thead>
              <tbody>
                {assets.length === 0 ? (
                  <tr><td colSpan={7} className="text-center">No assets recorded</td></tr>
                ) : (
                  assets.map((a) => (
                    <tr key={a.id}>
                      <td>{a.name}</td>
                      <td>{a.asset_type.replaceAll('_', ' ')}</td>
                      <td>{a.registration || [a.make, a.model].filter(Boolean).join(' ') || '—'}</td>
                      <td>{a.assigned_to ? staffNames[a.assigned_to] ?? 'Assigned' : '—'}</td>
                      <td>{a.last_inspection_date ? new Date(a.last_inspection_date).toLocaleDateString() : 'Never'}</td>
                      <td><span className={`status-badge status-${a.status}`}>{a.status.replaceAll('_', ' ')}</span></td>
                      <td><button type="button" className="btn btn-sm btn-secondary" onClick={() => setAssetCheck({ asset: a, condition: 'good', odometer: '', fuel: '', defects: '' })}>Record check</button></td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === 'oncall' && (
        <section className="reports-section">
          <h2>On-Call Periods ({onCallPeriods.length})</h2>
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
                const worked = c.work_started_at && c.work_ended_at
                  ? (new Date(c.work_ended_at).getTime() - new Date(c.work_started_at).getTime()) / 3_600_000
                  : 0;
                const payable = Math.max(worked, Number(c.minimum_pay_hours));
                return (
                  <div key={c.id} className="contact-card">
                    <div className="contact-header">
                      <h3>{staffNames[c.officer_user_id] ?? 'Officer'}</h3>
                      <span className={`status-badge status-${c.status}`}>{c.status.replaceAll('_', ' ')}</span>
                    </div>
                    <div className="contact-details">
                      <p>{c.callout_received_at ? `Received ${new Date(c.callout_received_at).toLocaleString('en-NZ')}` : 'Not yet received'}</p>
                      <p className="contact-meta">
                        Worked {worked.toFixed(2)}h · Payable {payable.toFixed(2)}h
                        {payable > worked ? ` (${Number(c.minimum_pay_hours)}h minimum applied)` : ''}
                      </p>
                    </div>
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
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      )}

      {assetCheck && <div className="hr-review-backdrop"><form className="hr-review-dialog" role="dialog" aria-modal="true" aria-labelledby="asset-check-title" onSubmit={handleAssetCheck}><header><div><span>Fleet evidence</span><h2 id="asset-check-title">Record check</h2></div><button type="button" onClick={() => setAssetCheck(null)} aria-label="Close asset check">×</button></header><p>{assetCheck.asset.name}{assetCheck.asset.registration ? ` · ${assetCheck.asset.registration}` : ''}. Major issues move the asset to maintenance and alert administrators.</p><label><span>Condition</span><select value={assetCheck.condition} onChange={(e) => setAssetCheck({ ...assetCheck, condition: e.target.value })}><option value="good">Good</option><option value="minor_issue">Minor issue</option><option value="major_issue">Major issue</option><option value="unserviceable">Unserviceable</option></select></label>{assetCheck.asset.asset_type === 'vehicle' && <div className="form-row"><label><span>Odometer</span><input type="number" min={0} value={assetCheck.odometer} onChange={(e) => setAssetCheck({ ...assetCheck, odometer: e.target.value })} /></label><label><span>Fuel level</span><select value={assetCheck.fuel} onChange={(e) => setAssetCheck({ ...assetCheck, fuel: e.target.value })}><option value="">Not recorded</option><option value="full">Full</option><option value="three_quarter">Three quarter</option><option value="half">Half</option><option value="quarter">Quarter</option><option value="empty">Empty</option></select></label></div>}<label><span>Defects noted</span><textarea rows={3} value={assetCheck.defects} onChange={(e) => setAssetCheck({ ...assetCheck, defects: e.target.value })} /></label><footer><button type="button" className="btn btn-secondary" onClick={() => setAssetCheck(null)}>Cancel</button><button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving' : 'Record check'}</button></footer></form></div>}

      {payrollExport && <div className="hr-review-backdrop"><form className="hr-review-dialog" role="dialog" aria-modal="true" aria-labelledby="payroll-export-title" onSubmit={handlePayrollExport}><header><div><span>Payroll</span><h2 id="payroll-export-title">Export approved timesheets</h2></div><button type="button" onClick={() => setPayrollExport(null)} aria-label="Close payroll export">×</button></header><p>Every approved, unexported timesheet whose period falls inside this range is batched and marked paid. This cannot be undone from this screen.</p><div className="form-row"><label><span>Period from</span><input type="date" required value={payrollExport.from} onChange={(e) => setPayrollExport({ ...payrollExport, from: e.target.value })} /></label><label><span>Period to</span><input type="date" required value={payrollExport.to} onChange={(e) => setPayrollExport({ ...payrollExport, to: e.target.value })} /></label></div><footer><button type="button" className="btn btn-secondary" onClick={() => setPayrollExport(null)}>Cancel</button><button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Exporting' : 'Create payroll batch'}</button></footer></form></div>}

      {reviewAction && <div className="hr-review-backdrop"><form className="hr-review-dialog" role="dialog" aria-modal="true" aria-labelledby="performance-review-title" onSubmit={completeReview}><header><div><span>Performance review</span><h2 id="performance-review-title">Complete review</h2></div><button type="button" onClick={() => setReviewAction(null)} aria-label="Close performance review">×</button></header><p>{staffNames[reviewAction.staff_id] ?? 'Staff member'}. The review record and rating are retained once completed.</p><label><span>Rating</span><select value={reviewCompletion.rating} onChange={(event) => setReviewCompletion({ ...reviewCompletion, rating: event.target.value })}>{[1,2,3,4,5].map((rating) => <option value={rating} key={rating}>{rating} / 5</option>)}</select></label><label><span>Strengths</span><textarea rows={3} value={reviewCompletion.strengths} onChange={(event) => setReviewCompletion({ ...reviewCompletion, strengths: event.target.value })} /></label><label><span>Development goals</span><textarea rows={3} value={reviewCompletion.goals} onChange={(event) => setReviewCompletion({ ...reviewCompletion, goals: event.target.value })} /></label><label><span>Employee comments</span><textarea rows={3} value={reviewCompletion.comments} onChange={(event) => setReviewCompletion({ ...reviewCompletion, comments: event.target.value })} /></label><footer><button type="button" className="btn btn-secondary" onClick={() => setReviewAction(null)}>Cancel</button><button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving' : 'Complete review'}</button></footer></form></div>}

      {caseAction && <div className="hr-review-backdrop"><form className="hr-review-dialog" role="dialog" aria-modal="true" aria-labelledby="hr-case-action-title" onSubmit={manageHrCase}><header><div><span>Private HR case</span><h2 id="hr-case-action-title">{caseAction.action === 'note' ? 'Add case note' : `${caseAction.action[0].toUpperCase()}${caseAction.action.slice(1)} case`}</h2></div><button type="button" onClick={() => setCaseAction(null)} aria-label="Close HR case action">×</button></header><p>{caseAction.item.subject}. This is an employer-only record and is never linked to a field incident.</p><label><span>{caseAction.action === 'note' ? 'Case note' : 'Decision note'}</span><textarea required rows={4} value={caseAction.note} onChange={(event) => setCaseAction({ ...caseAction, note: event.target.value })} /></label><footer><button type="button" className="btn btn-secondary" onClick={() => setCaseAction(null)}>Cancel</button><button type="submit" className={caseAction.action === 'withdraw' ? 'btn btn-danger' : 'btn btn-primary'} disabled={saving || !caseAction.note.trim()}>{saving ? 'Saving' : caseAction.action === 'note' ? 'Record note' : 'Confirm action'}</button></footer></form></div>}

      {evidenceAction && <div className="hr-review-backdrop"><form className="hr-review-dialog" role="dialog" aria-modal="true" aria-labelledby="onboarding-evidence-title" onSubmit={recordOnboardingEvidence}><header><div><span>Staff onboarding evidence</span><h2 id="onboarding-evidence-title">{evidenceAction.action === 'add_skill' ? 'Add skill' : evidenceAction.action === 'assign_line_manager' ? 'Assign line manager' : evidenceAction.action === 'record_induction' ? 'Record induction' : 'Register document'}</h2></div><button type="button" onClick={() => setEvidenceAction(null)} aria-label="Close evidence form">×</button></header><p>{evidenceAction.name}. Record only confirmed evidence; the readiness evaluator will update after this receipt.</p>{evidenceAction.action === 'add_skill' && <><label><span>Skill</span><input required value={evidenceAction.skillName} onChange={(event) => setEvidenceAction({ ...evidenceAction, skillName: event.target.value })} /></label><div className="form-row"><label><span>Category</span><select value={evidenceAction.skillCategory} onChange={(event) => setEvidenceAction({ ...evidenceAction, skillCategory: event.target.value })}><option value="enforcement">Enforcement</option><option value="technical">Technical</option><option value="medical">Medical</option><option value="language">Language</option><option value="driving">Driving</option><option value="equipment">Equipment</option><option value="other">Other</option></select></label><label><span>Proficiency</span><select value={evidenceAction.proficiency} onChange={(event) => setEvidenceAction({ ...evidenceAction, proficiency: event.target.value })}><option value="basic">Basic</option><option value="competent">Competent</option><option value="proficient">Proficient</option><option value="expert">Expert</option></select></label></div></>}{evidenceAction.action === 'assign_line_manager' && <label><span>Line manager</span><select required value={evidenceAction.managerId} onChange={(event) => setEvidenceAction({ ...evidenceAction, managerId: event.target.value })}><option value="">Select active staff member</option>{staff.filter((person) => person.id !== evidenceAction.staffId).map((person) => <option value={person.id} key={person.id}>{person.display_name ?? person.email}</option>)}</select></label>}{evidenceAction.action === 'record_induction' && <label><span>Induction name</span><input required value={evidenceAction.trainingName} onChange={(event) => setEvidenceAction({ ...evidenceAction, trainingName: event.target.value })} /></label>}{evidenceAction.action === 'record_document' && <><label><span>Document type</span><select value={evidenceAction.documentType} onChange={(event) => setEvidenceAction({ ...evidenceAction, documentType: event.target.value })}><option value="policy_acknowledgement">Policy acknowledgement</option><option value="contract">Contract</option><option value="certificate">Certificate</option><option value="credential_evidence">Credential evidence</option><option value="other">Other</option></select></label><label><span>File name</span><input required value={evidenceAction.fileName} onChange={(event) => setEvidenceAction({ ...evidenceAction, fileName: event.target.value })} /></label><label><span>Existing secure storage path</span><input required value={evidenceAction.storagePath} onChange={(event) => setEvidenceAction({ ...evidenceAction, storagePath: event.target.value })} /></label></>}<label><span>Evidence note</span><textarea rows={3} value={evidenceAction.note} onChange={(event) => setEvidenceAction({ ...evidenceAction, note: event.target.value })} /></label><footer><button type="button" className="btn btn-secondary" onClick={() => setEvidenceAction(null)}>Cancel</button><button type="submit" className="btn btn-primary" disabled={saving || (evidenceAction.action === 'add_skill' && !evidenceAction.skillName.trim()) || (evidenceAction.action === 'assign_line_manager' && !evidenceAction.managerId) || (evidenceAction.action === 'record_induction' && !evidenceAction.trainingName.trim()) || (evidenceAction.action === 'record_document' && (!evidenceAction.fileName.trim() || !evidenceAction.storagePath.trim()))}>{saving ? 'Saving' : 'Record evidence'}</button></footer></form></div>}

      {onboardingAction && <div className="hr-review-backdrop"><form className="hr-review-dialog" role="dialog" aria-modal="true" aria-labelledby="staff-onboarding-title" onSubmit={manageOnboarding}><header><div><span>Staff onboarding</span><h2 id="staff-onboarding-title">{onboardingAction.ledgerId ? `Advance to ${onboardingAction.nextStage}` : 'Start onboarding'}</h2></div><button type="button" onClick={() => setOnboardingAction(null)} aria-label="Close staff onboarding">×</button></header><p>{onboardingAction.name}. The server will recheck canonical evidence before advancing.</p><label><span>Stage note</span><textarea required rows={4} value={onboardingAction.note} onChange={(event) => setOnboardingAction({ ...onboardingAction, note: event.target.value })} /></label><footer><button type="button" className="btn btn-secondary" onClick={() => setOnboardingAction(null)}>Cancel</button><button type="submit" className="btn btn-primary" disabled={saving || !onboardingAction.note.trim()}>{saving ? 'Saving' : onboardingAction.ledgerId ? 'Advance stage' : 'Start onboarding'}</button></footer></form></div>}

      {candidateAction && <div className="hr-review-backdrop"><form className="hr-review-dialog" role="dialog" aria-modal="true" aria-labelledby="candidate-stage-title" onSubmit={advanceCandidate}><header><div><span>Recruitment</span><h2 id="candidate-stage-title">Move to {candidateAction.nextStage.replaceAll('_', ' ')}</h2></div><button type="button" onClick={() => setCandidateAction(null)} aria-label="Close candidate stage">×</button></header><p>{candidateAction.candidate.first_name} {candidateAction.candidate.last_name}. Stage history is retained for every candidate decision.</p><label><span>Stage note</span><textarea required rows={4} value={candidateAction.note} onChange={(event) => setCandidateAction({ ...candidateAction, note: event.target.value })} /></label><footer><button type="button" className="btn btn-secondary" onClick={() => setCandidateAction(null)}>Cancel</button><button type="submit" className="btn btn-primary" disabled={saving || !candidateAction.note.trim()}>{saving ? 'Saving' : 'Advance candidate'}</button></footer></form></div>}

      {offerAction && <div className="hr-review-backdrop"><form className="hr-review-dialog" role="dialog" aria-modal="true" aria-labelledby="offer-title" onSubmit={sendOffer}><header><div><span>Recruitment offer</span><h2 id="offer-title">Record offer</h2></div><button type="button" onClick={() => setOfferAction(null)} aria-label="Close offer form">×</button></header><p>{offerAction.candidate.first_name} {offerAction.candidate.last_name}. Recording an offer does not provision an application account; provision only after the candidate has accepted.</p><label><span>Application role</span><select value={offerAction.role} onChange={(event) => setOfferAction({ ...offerAction, role: event.target.value })}><option value="officer">Officer</option><option value="admin_officer">Senior officer</option></select></label><div className="form-row"><label><span>Employment type</span><select value={offerAction.employmentType} onChange={(event) => setOfferAction({ ...offerAction, employmentType: event.target.value })}><option value="permanent">Permanent</option><option value="part_time">Part time</option><option value="casual">Casual</option><option value="contractor">Contractor</option><option value="volunteer">Volunteer</option></select></label><label><span>Proposed start</span><input type="date" required value={offerAction.startDate} onChange={(event) => setOfferAction({ ...offerAction, startDate: event.target.value })} /></label></div><label><span>Offer note</span><textarea required rows={4} value={offerAction.note} onChange={(event) => setOfferAction({ ...offerAction, note: event.target.value })} /></label><label className="roster-publish"><input type="checkbox" checked={offerAction.accepted} onChange={(event) => setOfferAction({ ...offerAction, accepted: event.target.checked })} /><span><b>Candidate has accepted this offer</b><small>Provision an application identity and start staff onboarding only after verified acceptance.</small></span></label><footer><button type="button" className="btn btn-secondary" onClick={() => setOfferAction(null)}>Cancel</button><button type="submit" className="btn btn-primary" disabled={saving || !offerAction.startDate || !offerAction.note.trim()}>{saving ? 'Saving' : offerAction.accepted ? 'Confirm acceptance and provision' : 'Record offer'}</button></footer></form></div>}

      {review && <div className="hr-review-backdrop"><form className="hr-review-dialog" role="dialog" aria-modal="true" aria-labelledby="hr-review-title" onSubmit={handleReview}><header><div><span>Governed HR decision</span><h2 id="hr-review-title">{review.decision === 'approved' ? 'Approve' : review.decision === 'declined' ? 'Decline' : 'Reject'} {review.kind === 'leave' ? 'leave request' : 'timesheet'}?</h2></div><button type="button" onClick={() => setReview(null)} aria-label="Close review">×</button></header><p>{review.kind === 'leave' ? 'Leave approval will fail when active roster slots overlap the requested dates.' : 'Approved hours become eligible for the payroll export workflow.'}</p><label><span>Review notes</span><textarea rows={4} required={review.decision !== 'approved'} value={reviewNotes} onChange={(event) => setReviewNotes(event.target.value)} /></label><footer><button type="button" className="btn btn-secondary" onClick={() => setReview(null)}>Back</button><button type="submit" className="btn btn-primary" disabled={saving || (review.decision !== 'approved' && !reviewNotes.trim())}>{saving ? 'Saving' : 'Confirm decision'}</button></footer></form></div>}
      {readinessReview && <div className="hr-review-backdrop"><form className="hr-review-dialog" role="dialog" aria-modal="true" aria-labelledby="readiness-review-title" onSubmit={handleReadinessReview}><header><div><span>Staff eligibility</span><h2 id="readiness-review-title">{readinessReview.next ? 'Mark work ready?' : 'Remove work readiness?'}</h2></div><button type="button" onClick={() => setReadinessReview(null)} aria-label="Close readiness review">×</button></header><p>{readinessReview.next ? 'Identity, employment, and current credential blockers are checked again by the server.' : 'The staff member will no longer be eligible for new roster assignments.'}</p><label><span>Readiness review notes</span><textarea rows={4} required value={readinessNotes} onChange={(event) => setReadinessNotes(event.target.value)} /></label><footer><button type="button" className="btn btn-secondary" onClick={() => setReadinessReview(null)}>Back</button><button type="submit" className="btn btn-primary" disabled={saving || !readinessNotes.trim()}>{saving ? 'Saving' : 'Confirm readiness'}</button></footer></form></div>}
      {credentialRenewal && <div className="hr-review-backdrop"><form className="hr-review-dialog" role="dialog" aria-modal="true" aria-labelledby="credential-renewal-title" onSubmit={handleCredentialRenewal}><header><div><span>Credential evidence</span><h2 id="credential-renewal-title">Record renewal</h2></div><button type="button" onClick={() => setCredentialRenewal(null)} aria-label="Close credential renewal">×</button></header><p>The existing {credentialRenewal.source.credential_type.replaceAll('_',' ')} record remains in history. This replacement is verified against your evidence notes.</p><label><span>Credential number</span><input required value={credentialRenewal.credentialNumber} onChange={(event)=>setCredentialRenewal({...credentialRenewal,credentialNumber:event.target.value})}/></label><label><span>Issuing authority</span><input required value={credentialRenewal.issuingAuthority} onChange={(event)=>setCredentialRenewal({...credentialRenewal,issuingAuthority:event.target.value})}/></label><div className="form-row"><label><span>Issued date</span><input type="date" required value={credentialRenewal.issuedDate} onChange={(event)=>setCredentialRenewal({...credentialRenewal,issuedDate:event.target.value})}/></label><label><span>New expiry date</span><input type="date" required min={credentialRenewal.source.expiry_date??undefined} value={credentialRenewal.expiryDate} onChange={(event)=>setCredentialRenewal({...credentialRenewal,expiryDate:event.target.value})}/></label></div><label><span>Verification evidence notes</span><textarea rows={4} required minLength={10} value={credentialRenewal.evidenceNotes} onChange={(event)=>setCredentialRenewal({...credentialRenewal,evidenceNotes:event.target.value})}/></label><footer><button type="button" className="btn btn-secondary" onClick={()=>setCredentialRenewal(null)}>Back</button><button type="submit" className="btn btn-primary" disabled={saving||!credentialRenewal.credentialNumber.trim()||!credentialRenewal.issuingAuthority.trim()||!credentialRenewal.issuedDate||!credentialRenewal.expiryDate||credentialRenewal.evidenceNotes.trim().length<10}>{saving?'Saving':'Confirm renewal'}</button></footer></form></div>}
      {coverageFinalization&&<div className="hr-review-backdrop"><form className="hr-review-dialog" role="dialog" aria-modal="true" aria-labelledby="coverage-finalization-title" onSubmit={finalizeCoverage}><header><div><span>Coverage ownership</span><h2 id="coverage-finalization-title">Finalize assignment</h2></div><button type="button" onClick={()=>setCoverageFinalization(null)} aria-label="Close coverage finalization">×</button></header><p>Confirm the claimant against an active work unit. Field work creates the linked operational shift through the governed roster workflow.</p><label><span>Select work unit</span><select required value={coverageFinalization.workUnitId} onChange={(event)=>setCoverageFinalization({...coverageFinalization,workUnitId:event.target.value})}><option value="">Select work unit</option>{coverageWorkUnits.map((unit)=><option value={unit.id} key={unit.id}>{unit.name} · {unit.work_unit_type}</option>)}</select></label><label><span>Finalization notes</span><textarea rows={3} value={coverageFinalization.notes} onChange={(event)=>setCoverageFinalization({...coverageFinalization,notes:event.target.value})}/></label><footer><button type="button" className="btn btn-secondary" onClick={()=>setCoverageFinalization(null)}>Back</button><button type="submit" className="btn btn-primary" disabled={saving||!coverageFinalization.workUnitId}>{saving?'Finalizing':'Confirm assignment'}</button></footer></form></div>}
    </div>
  );
};

export default RosterHRPage;
