import { isAdminTierRole } from '../lib/roles';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useHref, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { credentialExpiryWords, credentialTypeLabel } from '../lib/credentialWords';
import { plainWords } from '../lib/rosterWords';
import './PageStyles.css';
import './StaffProfilePage.css';

type ProfileTab = 'overview' | 'onboarding' | 'employment' | 'credentials' | 'skills-training' | 'documents' | 'rostering' | 'health-safety' | 'assets' | 'history';
type RecordKind = 'credential' | 'skill' | 'training' | 'document' | 'induction' | 'asset' | 'timesheet' | 'leave' | 'case';

interface StaffProfile {
  id: string;
  organization_id: string;
  user_id: string | null;
  employee_number: string | null;
  employment_type: string;
  start_date: string | null;
  end_date: string | null;
  work_ready: boolean;
  role_code: string | null;
  payroll_id: string | null;
  seniority_date: string | null;
  overtime_eligible: boolean;
}

interface UserProfile {
  id: string;
  display_name: string | null;
  email: string | null;
  phone: string | null;
  role: string;
}

interface RoleCode { code: string; name: string; }
interface RecordRow { id: string; [key: string]: unknown; }

const PROFILE_TABS: Array<{ id: ProfileTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'onboarding', label: 'Onboarding' },
  { id: 'employment', label: 'Employment & pay' },
  { id: 'credentials', label: 'Credentials' },
  { id: 'skills-training', label: 'Skills & training' },
  { id: 'documents', label: 'Documents' },
  { id: 'rostering', label: 'Rostering' },
  { id: 'health-safety', label: 'H&S' },
  { id: 'assets', label: 'Assets' },
  { id: 'history', label: 'History' },
];

const isProfileTab = (value: string | null): value is ProfileTab => PROFILE_TABS.some((tab) => tab.id === value);
const text = (value: unknown, fallback = 'Not recorded') => typeof value === 'string' && value.trim() ? value : fallback;
const dateWords = (value: unknown, fallback = 'Not recorded') => typeof value === 'string' && value ? new Date(value).toLocaleDateString('en-NZ') : fallback;

const StaffProfilePage: React.FC = () => {
  const staffProfileHref = useHref('/admin/people-hr');
  const mainWorkspaceHref = useHref('/admin/people-hr?tab=staff');
  const location = useLocation();
  const navigate = useNavigate();
  const { profile: actor } = useAuth();
  const params = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const staffId = params.get('profile');
  const requestedTab = params.get('profileTab');
  const recordKind = params.get('recordKind') as RecordKind | null;
  const recordId = params.get('record');
  const [activeTab, setActiveTab] = useState<ProfileTab>(isProfileTab(requestedTab) ? requestedTab : 'overview');
  const [staffProfile, setStaffProfile] = useState<StaffProfile | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [roleCodes, setRoleCodes] = useState<RoleCode[]>([]);
  const [credentials, setCredentials] = useState<RecordRow[]>([]);
  const [skills, setSkills] = useState<RecordRow[]>([]);
  const [training, setTraining] = useState<RecordRow[]>([]);
  const [documents, setDocuments] = useState<RecordRow[]>([]);
  const [inductions, setInductions] = useState<RecordRow[]>([]);
  const [inductionRequirements, setInductionRequirements] = useState<RecordRow[]>([]);
  const [assets, setAssets] = useState<RecordRow[]>([]);
  const [timesheets, setTimesheets] = useState<RecordRow[]>([]);
  const [leave, setLeave] = useState<RecordRow[]>([]);
  const [cases, setCases] = useState<RecordRow[]>([]);
  const [availability, setAvailability] = useState<RecordRow[]>([]);
  const [readiness, setReadiness] = useState<RecordRow | null>(null);
  const [onboarding, setOnboarding] = useState<RecordRow | null>(null);
  const [payRoleDraft, setPayRoleDraft] = useState('');
  const [readinessReview, setReadinessReview] = useState<{ next: boolean; note: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const canManagePay = isAdminTierRole(actor?.role);

  const loadProfile = useCallback(async () => {
    if (!staffId) {
      setError('No staff profile was selected.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const { data: staffData, error: staffError } = await supabase
      .from('staff_profiles')
      .select('id,organization_id,user_id,employee_number,employment_type,start_date,end_date,work_ready,role_code,payroll_id,seniority_date,overtime_eligible')
      .eq('id', staffId)
      .limit(1);
    if (staffError || !staffData?.[0]) {
      setError(staffError?.message ?? 'The staff profile is unavailable or you do not have permission to view it.');
      setLoading(false);
      return;
    }
    const staff = (staffData as StaffProfile[]).find((item) => item.id === staffId) ?? staffData[0] as StaffProfile;
    const organizationId = staff.organization_id ?? actor?.organizationId;
    if (!organizationId) {
      setError('The staff profile is not attached to an organization.');
      setLoading(false);
      return;
    }
    staff.organization_id = organizationId;
    const userPromise = staff.user_id
      ? supabase.from('user_profiles').select('id,display_name,email,phone,role').eq('id', staff.user_id).limit(1)
      : Promise.resolve({ data: null, error: null });
    const [
      userResult, roleResult, credentialResult, skillResult, trainingResult, documentResult,
      inductionResult, inductionRequirementResult, assetResult, timesheetResult, leaveResult,
      caseResult, availabilityResult, readinessResult,
      onboardingResult,
    ] = await Promise.all([
      userPromise,
      supabase.from('reference_codes').select('code,name').eq('organization_id', staff.organization_id).eq('code_type', 'role_code').eq('is_active', true).order('sort_order').order('code'),
      supabase.from('staff_credentials').select('id,credential_type,credential_number,issuing_authority,issued_date,expiry_date,verified,verified_at,notes').eq('staff_id', staff.id).order('expiry_date'),
      supabase.from('staff_skills').select('id,skill_name,skill_category,proficiency_level,certified,certification_expiry,notes,updated_at').eq('staff_id', staff.id).order('skill_name'),
      supabase.from('staff_training_records').select('id,training_name,training_type,provider,completed_date,expiry_date,passed,score,notes,created_at').eq('staff_id', staff.id).order('completed_date', { ascending: false }),
      supabase.from('staff_documents').select('id,document_type,file_name,file_size_bytes,mime_type,description,notes,expiry_date,uploaded_at').eq('staff_id', staff.id).order('uploaded_at', { ascending: false }),
      supabase.from('staff_site_inductions').select('id,requirement_id,completed_at,expires_at,evidence_notes,verified_by').eq('staff_id', staff.id).order('completed_at', { ascending: false }),
      supabase.from('site_induction_requirements').select('id,induction_name,version,required,expires_after_days,active').eq('organization_id', staff.organization_id).order('induction_name'),
      staff.user_id
        ? supabase.from('assets').select('id,asset_type,name,serial_number,registration,status,last_inspection_date,next_inspection_date,notes,updated_at').eq('organization_id', staff.organization_id).eq('assigned_to', staff.user_id).order('name')
        : Promise.resolve({ data: [], error: null }),
      supabase.from('timesheets').select('id,period_start,period_end,scheduled_hours,actual_hours,overtime_hours,adjustment_hours,status,created_at').eq('staff_id', staff.id).order('period_start', { ascending: false }).limit(52),
      supabase.from('leave_requests').select('id,leave_type,starts_on,ends_on,status,reason,created_at').eq('staff_id', staff.id).order('starts_on', { ascending: false }).limit(50),
      supabase.from('hr_cases').select('id,case_type,severity,status,subject,opened_at,resolved_at').eq('staff_id', staff.id).order('opened_at', { ascending: false }).limit(50),
      supabase.from('staff_availability').select('id,day_of_week,specific_date,available_from,available_to,all_day,availability_type,notes').eq('staff_id', staff.id).order('specific_date'),
      supabase.rpc('get_staff_readiness_assessment', { p_organization_id: staff.organization_id }),
      supabase.rpc('get_staff_onboarding_readiness', { p_organization_id: staff.organization_id }),
    ]);
    const results = [
      userResult, roleResult, credentialResult, skillResult, trainingResult, documentResult,
      inductionResult, inductionRequirementResult, assetResult, timesheetResult, leaveResult,
      caseResult, availabilityResult, readinessResult,
      onboardingResult,
    ];
    const panelErrors = results.flatMap((result) => result.error ? [result.error.message] : []);
    setStaffProfile(staff);
    const users = (userResult.data ?? []) as UserProfile[];
    setUserProfile(users.find((item) => item.id === staff.user_id) ?? users[0] ?? null);
    setRoleCodes((roleResult.data ?? []) as RoleCode[]);
    setCredentials((credentialResult.data ?? []) as RecordRow[]);
    setSkills((skillResult.data ?? []) as RecordRow[]);
    setTraining((trainingResult.data ?? []) as RecordRow[]);
    setDocuments((documentResult.data ?? []) as RecordRow[]);
    setInductions((inductionResult.data ?? []) as RecordRow[]);
    setInductionRequirements((inductionRequirementResult.data ?? []) as RecordRow[]);
    setAssets((assetResult.data ?? []) as RecordRow[]);
    setTimesheets((timesheetResult.data ?? []) as RecordRow[]);
    setLeave((leaveResult.data ?? []) as RecordRow[]);
    setCases((caseResult.data ?? []) as RecordRow[]);
    setAvailability((availabilityResult.data ?? []) as RecordRow[]);
    setReadiness(((readinessResult.data ?? []) as RecordRow[]).find((item) => item.staff_id === staff.id) ?? null);
    setOnboarding(((onboardingResult.data ?? []) as RecordRow[]).find((item) => item.staff_id === staff.id) ?? null);
    setPayRoleDraft(staff.role_code ?? '');
    if (panelErrors.length > 0) setError(`Some profile sections could not be loaded: ${[...new Set(panelErrors)].join(' · ')}`);
    setLoading(false);
  }, [actor?.organizationId, staffId]);

  useEffect(() => { void loadProfile(); }, [loadProfile]);
  useEffect(() => { if (isProfileTab(requestedTab)) setActiveTab(requestedTab); }, [requestedTab]);

  const setTab = (next: ProfileTab) => {
    setActiveTab(next);
    const nextParams = new URLSearchParams(location.search);
    nextParams.set('profileTab', next);
    nextParams.delete('recordKind');
    nextParams.delete('record');
    navigate({ pathname: location.pathname, search: nextParams.toString() }, { replace: true });
  };

  const openRecord = (kind: RecordKind, id: string, tab: ProfileTab) => {
    const url = new URL(staffProfileHref, window.location.origin);
    url.searchParams.set('profile', staffId ?? '');
    url.searchParams.set('profileTab', tab);
    url.searchParams.set('recordKind', kind);
    url.searchParams.set('record', id);
    url.searchParams.set('popout', '1');
    const detailWindow = window.open(url.toString(), `fcm-staff-${staffId}-${kind}-${id}`, 'popup=yes,width=980,height=820,left=160,top=80');
    if (detailWindow) detailWindow.opener = null;
  };

  const savePayRole = async () => {
    if (!staffProfile) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    const { error: saveError } = await supabase.rpc('set_staff_pay_role_code', {
      p_staff_id: staffProfile.id,
      p_expected_role_code: staffProfile.role_code ?? null,
      p_role_code: payRoleDraft || null,
    });
    if (saveError) setError(saveError.message);
    else {
      setNotice(`Payroll role updated for ${userProfile?.display_name ?? 'staff member'}.`);
      await loadProfile();
    }
    setSaving(false);
  };

  const saveReadiness = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!staffProfile || !readinessReview?.note.trim()) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    const { error: saveError } = await supabase.rpc('set_staff_work_readiness', {
      p_staff_id: staffProfile.id,
      p_expected_work_ready: staffProfile.work_ready,
      p_work_ready: readinessReview.next,
      p_review_notes: readinessReview.note.trim(),
    });
    if (saveError) setError(saveError.message);
    else {
      setStaffProfile({ ...staffProfile, work_ready: readinessReview.next });
      setNotice(`${displayName} readiness updated and audited.`);
      setReadinessReview(null);
    }
    setSaving(false);
  };

  const requirementName = (id: unknown) => text(inductionRequirements.find((item) => item.id === id)?.induction_name, 'Site induction');
  const recordCollections: Record<RecordKind, RecordRow[]> = { credential: credentials, skill: skills, training, document: documents, induction: inductions, asset: assets, timesheet: timesheets, leave, case: cases };
  const selectedRecord = recordKind && recordId ? recordCollections[recordKind]?.find((item) => item.id === recordId) ?? null : null;
  const displayName = userProfile?.display_name || userProfile?.email || 'Staff member';

  if (loading) return <div className="staff-profile-loading" role="status">Loading staff profile…</div>;
  if (error && !staffProfile) return <div className="staff-profile-loading" role="alert">{error}</div>;
  if (!staffProfile) return null;

  const recordList = (rows: RecordRow[], kind: RecordKind, tab: ProfileTab, render: (row: RecordRow) => React.ReactNode, empty: string) => (
    <div className="staff-profile-record-list">
      {rows.length === 0 ? <div className="staff-profile-empty">{empty}</div> : rows.map((row) => (
        <button type="button" className="staff-profile-record-row" key={row.id} onClick={() => openRecord(kind, row.id, tab)}>
          {render(row)}
          <span className="staff-profile-row-action">Open details ↗</span>
        </button>
      ))}
    </div>
  );

  return (
    <div className="staff-profile-page">
      <header className="staff-profile-header">
        <div>
          <span className="staff-profile-kicker">Staff profile · {staffProfile.employee_number ?? 'No employee number'}</span>
          <h1>{displayName}</h1>
          <p>{text(userProfile?.email)} · {text(userProfile?.phone)} · {plainWords(staffProfile.employment_type)} · {staffProfile.role_code ?? 'Payroll role not assigned'}</p>
        </div>
        <div className="staff-profile-header-actions">
          <span className={`status-badge ${staffProfile.work_ready ? 'status-active' : 'status-pending'}`}>{staffProfile.work_ready ? 'Work ready' : 'Not work ready'}</span>
          <a className="btn btn-secondary" href={mainWorkspaceHref} target="_blank" rel="noopener noreferrer">Open main workspace</a>
          <button type="button" className="btn btn-secondary" onClick={() => window.close()}>Close window</button>
        </div>
      </header>
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {notice && <div className="alert alert-success" role="status">{notice}</div>}
      <nav className="staff-profile-tabs" aria-label="Staff profile sections">
        {PROFILE_TABS.map((tab) => <button type="button" key={tab.id} className={activeTab === tab.id ? 'is-active' : ''} onClick={() => setTab(tab.id)}>{tab.label}</button>)}
      </nav>

      <main className="staff-profile-workspace">
        <section className="staff-profile-content">
          {activeTab === 'overview' && <>
            <div className="staff-profile-summary-grid">
              <article><span>Employment</span><strong>{plainWords(staffProfile.employment_type)}</strong><small>{staffProfile.start_date ? `Started ${dateWords(staffProfile.start_date)}` : 'Start date not recorded'}</small></article>
              <article><span>Payroll role</span><strong>{staffProfile.role_code ?? 'Not assigned'}</strong><small>{staffProfile.payroll_id ? `Payroll ID ${staffProfile.payroll_id}` : 'Payroll ID not recorded'}</small></article>
              <article><span>Credentials</span><strong>{credentials.length}</strong><small>{credentials.filter((item) => item.verified).length} verified</small></article>
              <article><span>Skills & training</span><strong>{skills.length + training.length}</strong><small>{skills.length} skills · {training.length} training records</small></article>
              <article><span>H&S evidence</span><strong>{inductions.length}</strong><small>Site induction records</small></article>
              <article><span>Assigned assets</span><strong>{assets.length}</strong><small>Current register assignments</small></article>
            </div>
            <section className="staff-profile-panel"><h2>Readiness</h2>{readiness ? <dl className="staff-profile-facts"><div><dt>Identity</dt><dd>{plainWords(String(readiness.identity_status ?? 'unknown'))}</dd></div><div><dt>Employment</dt><dd>{plainWords(String(readiness.employment_status ?? 'unknown'))}</dd></div><div><dt>Credentials</dt><dd>{plainWords(String(readiness.credential_status ?? 'unknown'))}</dd></div><div><dt>Training</dt><dd>{plainWords(String(readiness.training_status ?? 'unknown'))}</dd></div></dl> : <p>No readiness assessment is available.</p>}{Array.isArray(readiness?.blockers) && readiness.blockers.length > 0 && <p className="staff-profile-warning">Holding this person back: {(readiness.blockers as string[]).join(' · ')}</p>}<div className="staff-profile-panel-actions"><button type="button" className={`btn ${staffProfile.work_ready ? 'btn-danger' : 'btn-primary'}`} onClick={() => setReadinessReview({ next: !staffProfile.work_ready, note: '' })}>{staffProfile.work_ready ? 'Remove work readiness' : 'Mark work ready'}</button><a className="btn btn-secondary" href="/admin/people-hr?tab=credentials" target="_blank" rel="noopener noreferrer">Open credential actions</a></div></section>
          </>}

          {activeTab === 'onboarding' && <section className="staff-profile-panel">
            <h2>Onboarding</h2>
            {onboarding ? <>
              <dl className="staff-profile-facts">
                <div><dt>Stage</dt><dd>{plainWords(String(onboarding.current_stage ?? 'not started'))}</dd></div>
                <div><dt>Status</dt><dd>{plainWords(String(onboarding.status ?? 'not started'))}</dd></div>
                <div><dt>Target start</dt><dd>{dateWords(onboarding.target_start, 'Not set')}</dd></div>
                <div><dt>Next action</dt><dd>{text(onboarding.next_action, 'Review onboarding')}</dd></div>
              </dl>
              {Array.isArray(onboarding.blockers) && onboarding.blockers.length > 0 && <p className="staff-profile-warning">Holding this person up: {(onboarding.blockers as string[]).join(' · ')}</p>}
              <div className="staff-profile-panel-actions">
                <a className="btn btn-primary" href="/admin/people-hr?tab=onboarding" target="_blank" rel="noopener noreferrer">Continue governed onboarding</a>
              </div>
            </> : <div className="staff-profile-empty">No onboarding ledger is recorded for this person.</div>}
          </section>}

          {activeTab === 'employment' && <section className="staff-profile-panel"><h2>Employment and payroll</h2><dl className="staff-profile-facts"><div><dt>Employment type</dt><dd>{plainWords(staffProfile.employment_type)}</dd></div><div><dt>Start date</dt><dd>{dateWords(staffProfile.start_date)}</dd></div><div><dt>End date</dt><dd>{dateWords(staffProfile.end_date, 'No end date')}</dd></div><div><dt>Seniority date</dt><dd>{dateWords(staffProfile.seniority_date)}</dd></div><div><dt>Overtime</dt><dd>{staffProfile.overtime_eligible ? 'Eligible' : 'Not eligible'}</dd></div></dl>{canManagePay ? <div className="staff-profile-pay-role"><label><span>Payroll role</span><select value={payRoleDraft} onChange={(event) => setPayRoleDraft(event.target.value)}><option value="">No payroll role assigned</option>{roleCodes.map((role) => <option value={role.code} key={role.code}>{role.code} · {role.name}</option>)}</select></label><button type="button" className="btn btn-primary" disabled={saving || payRoleDraft === (staffProfile.role_code ?? '')} onClick={() => void savePayRole()}>{saving ? 'Saving…' : 'Save payroll role'}</button>{roleCodes.length === 0 && <p className="staff-profile-warning">No payroll roles are configured. Create one in People, Pay &amp; HR before employment setup can be completed.</p>}</div> : <p>You do not have permission to change payroll roles.</p>}</section>}

          {activeTab === 'credentials' && <section className="staff-profile-panel"><h2>Credentials</h2><p>Verified, current credentials feed work readiness and roster eligibility.</p>{recordList(credentials, 'credential', 'credentials', (row) => <><strong>{credentialTypeLabel(String(row.credential_type))}</strong><span>{text(row.credential_number, 'No number')}</span><span>{credentialExpiryWords(row.expiry_date as string | null)}</span><span>{row.verified ? 'Verified' : 'Not verified'}</span></>, 'No credentials are recorded for this person.')}</section>}

          {activeTab === 'skills-training' && <><section className="staff-profile-panel"><h2>Skills</h2>{recordList(skills, 'skill', 'skills-training', (row) => <><strong>{text(row.skill_name)}</strong><span>{plainWords(String(row.proficiency_level ?? 'not assessed'))}</span><span>{row.certified ? 'Certified' : 'Not certified'}</span><span>{dateWords(row.certification_expiry, 'No expiry')}</span></>, 'No skills are assigned to this person.')}</section><section className="staff-profile-panel"><h2>Training</h2>{recordList(training, 'training', 'skills-training', (row) => <><strong>{text(row.training_name)}</strong><span>{text(row.provider, 'Provider not recorded')}</span><span>{dateWords(row.completed_date)}</span><span>{dateWords(row.expiry_date, 'No expiry')}</span></>, 'No training records are recorded for this person.')}</section></>}

          {activeTab === 'documents' && <section className="staff-profile-panel"><h2>Documents</h2><p>Only metadata is shown here; secure storage paths are not exposed in this profile view.</p>{recordList(documents, 'document', 'documents', (row) => <><strong>{text(row.file_name)}</strong><span>{plainWords(String(row.document_type ?? 'document'))}</span><span>{text(row.mime_type, 'Type not recorded')}</span><span>{dateWords(row.expiry_date, 'No expiry')}</span></>, 'No documents are registered for this person.')}</section>}

          {activeTab === 'rostering' && <><section className="staff-profile-panel"><h2>Availability</h2>{availability.length === 0 ? <div className="staff-profile-empty">No standing or date-specific availability is recorded.</div> : <div className="staff-profile-record-list">{availability.map((row) => <div className="staff-profile-record-row is-static" key={row.id}><strong>{row.specific_date ? dateWords(row.specific_date) : `Weekday ${Number(row.day_of_week) + 1}`}</strong><span>{row.all_day ? 'All day' : `${text(row.available_from)}–${text(row.available_to)}`}</span><span>{plainWords(String(row.availability_type ?? 'available'))}</span></div>)}</div>}</section><section className="staff-profile-panel"><h2>Timesheets</h2>{recordList(timesheets, 'timesheet', 'rostering', (row) => <><strong>{dateWords(row.period_start)} – {dateWords(row.period_end)}</strong><span>{Number(row.actual_hours ?? 0).toFixed(2)} actual hours</span><span>{Number(row.overtime_hours ?? 0).toFixed(2)} overtime</span><span>{plainWords(String(row.status))}</span></>, 'No timesheets are available for this person.')}</section></>}

          {activeTab === 'health-safety' && <><section className="staff-profile-panel"><h2>Site inductions</h2><p>Inductions are the current staff-specific H&amp;S readiness evidence. Operational incidents and place hazards remain on their owning work and place records.</p>{recordList(inductions, 'induction', 'health-safety', (row) => <><strong>{requirementName(row.requirement_id)}</strong><span>Completed {dateWords(row.completed_at)}</span><span>{dateWords(row.expires_at, 'No expiry')}</span><span>{text(row.evidence_notes, 'No evidence note')}</span></>, 'No site induction evidence is recorded for this person.')}</section><section className="staff-profile-panel"><h2>Personnel H&amp;S records</h2><div className="staff-profile-empty">No dedicated staff injury or wellbeing record pathway is present in the current workforce schema. Do not record clinical details in general HR notes.</div></section></>}

          {activeTab === 'assets' && <section className="staff-profile-panel"><h2>Assigned assets</h2>{recordList(assets, 'asset', 'assets', (row) => <><strong>{text(row.name)}</strong><span>{plainWords(String(row.asset_type ?? 'asset'))}</span><span>{text(row.registration ?? row.serial_number, 'No identifier')}</span><span>{plainWords(String(row.status))}</span></>, 'No assets are currently assigned to this person.')}</section>}

          {activeTab === 'history' && <><section className="staff-profile-panel"><h2>Leave history</h2>{recordList(leave, 'leave', 'history', (row) => <><strong>{plainWords(String(row.leave_type))}</strong><span>{dateWords(row.starts_on)} – {dateWords(row.ends_on)}</span><span>{plainWords(String(row.status))}</span></>, 'No leave records are available.')}</section><section className="staff-profile-panel"><h2>Private HR cases</h2>{recordList(cases, 'case', 'history', (row) => <><strong>{text(row.subject)}</strong><span>{plainWords(String(row.case_type))}</span><span>{plainWords(String(row.severity))}</span><span>{plainWords(String(row.status))}</span></>, 'No HR cases are available.')}</section></>}
        </section>

        {recordKind && recordId && <aside className="staff-profile-detail" aria-label="Selected record details">
          <header><div><span>{plainWords(recordKind)}</span><h2>Record details</h2></div><button type="button" onClick={() => { const next = new URLSearchParams(location.search); next.delete('recordKind'); next.delete('record'); navigate({ pathname: location.pathname, search: next.toString() }, { replace: true }); }} aria-label="Close record details">×</button></header>
          {selectedRecord ? <dl>{Object.entries(selectedRecord).filter(([key]) => !['id', 'storage_path'].includes(key)).map(([key, value]) => <div key={key}><dt>{plainWords(key)}</dt><dd>{value == null || value === '' ? 'Not recorded' : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value)}</dd></div>)}</dl> : <p role="alert">This record is unavailable or you do not have permission to view it.</p>}
        </aside>}
      </main>
      {readinessReview && <div className="staff-profile-dialog-backdrop"><form className="staff-profile-dialog" role="dialog" aria-modal="true" aria-labelledby="staff-readiness-title" onSubmit={saveReadiness}><header><div><span>Roster eligibility</span><h2 id="staff-readiness-title">{readinessReview.next ? 'Mark work ready?' : 'Remove work readiness?'}</h2></div><button type="button" onClick={() => setReadinessReview(null)} aria-label="Close readiness review">×</button></header><p>{readinessReview.next ? 'The server will recheck identity, employment, credentials and readiness blockers before allowing roster work.' : 'Removing readiness blocks new roster assignment without deleting employment or evidence records.'}</p><label><span>Readiness review notes</span><textarea required rows={4} value={readinessReview.note} onChange={(event) => setReadinessReview({ ...readinessReview, note: event.target.value })} /></label><footer><button type="button" className="btn btn-secondary" onClick={() => setReadinessReview(null)}>Cancel</button><button type="submit" className="btn btn-primary" disabled={saving || !readinessReview.note.trim()}>{saving ? 'Saving…' : 'Confirm readiness'}</button></footer></form></div>}
    </div>
  );
};

export default StaffProfilePage;
