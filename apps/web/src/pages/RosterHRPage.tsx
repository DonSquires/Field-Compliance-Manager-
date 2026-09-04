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

type RosterTab = 'staff' | 'credentials' | 'shift-templates' | 'coverage' | 'leave' | 'timesheets' | 'assets' | 'oncall' | 'court';

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
}

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
  { id: 'credentials', label: 'Credentials' },
  { id: 'shift-templates', label: 'Shift Templates' },
  { id: 'coverage', label: 'Open Shifts' },
  { id: 'oncall', label: 'On-Call' },
  { id: 'court', label: 'Court' },
  { id: 'assets', label: 'Assets' },
  { id: 'leave', label: 'Leave' },
  { id: 'timesheets', label: 'Timesheets' },
];

const RosterHRPage: React.FC = () => {
  const location = useLocation();
  const requestedCredentialId = new URLSearchParams(location.search).get('credential');
  const { profile } = useAuth();
  const [tab, setTab] = useState<RosterTab>(new URLSearchParams(location.search).get('tab') === 'credentials' ? 'credentials' : 'staff');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [readinessAssessments, setReadinessAssessments] = useState<ReadinessAssessment[]>([]);
  const [credentials, setCredentials] = useState<CredentialRow[]>([]);
  const [shiftTemplates, setShiftTemplates] = useState<ShiftTemplateRow[]>([]);
  const [leaveRequests, setLeaveRequests] = useState<LeaveRequestRow[]>([]);
  const [timesheets, setTimesheets] = useState<TimesheetRow[]>([]);
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

      const [profilesRes, staffProfilesRes, credentialsRes, templatesRes, leaveRes, timesheetsRes, coverageRes, readinessRes, workUnitsRes, assetsRes, onCallRes, calloutRes, courtRes] =
        await Promise.all([
          supabase
            .from('user_profiles')
            .select('id, display_name, role, email, phone')
            .eq('organization_id', orgId),
          supabase
            .from('staff_profiles')
            .select('id, user_id, employment_type, start_date, end_date, work_ready')
            .eq('organization_id', orgId),
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
        ]);

      if (profilesRes.error) throw profilesRes.error;
      if (staffProfilesRes.error) throw staffProfilesRes.error;
      if (credentialsRes.error) throw credentialsRes.error;
      if (templatesRes.error) throw templatesRes.error;
      if (leaveRes.error) throw leaveRes.error;
      if (timesheetsRes.error) throw timesheetsRes.error;
      if (coverageRes.error) throw coverageRes.error;
      if (readinessRes.error) throw readinessRes.error;
  if(workUnitsRes.error)throw workUnitsRes.error;

      setAssets((assetsRes.data as AssetRow[]) ?? []);
      setOnCallPeriods((onCallRes.data as OnCallRow[]) ?? []);
      setCallouts((calloutRes.data as CalloutRow[]) ?? []);
      setCourtAppearances((courtRes.data as CourtRow[]) ?? []);

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

      <div className="crm-branch-filter">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`btn btn-sm ${tab === t.id ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setTab(t.id)}
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
                    {s.staff_id && (() => { const assessment = readinessAssessments.find((item) => item.staff_id === s.staff_id); return assessment ? <div className="hr-readiness"><div><span>Identity</span><strong>{assessment.identity_status.replaceAll('_', ' ')}</strong></div><div><span>Employment</span><strong>{assessment.employment_status.replaceAll('_', ' ')}</strong></div><div><span>Credentials</span><strong>{assessment.credential_status.replaceAll('_', ' ')}</strong></div><div><span>Training advisory</span><strong>{assessment.training_status}</strong></div>{assessment.blockers.length > 0 && <p>{assessment.blockers.join(' · ')}</p>}<button type="button" className={`btn btn-sm ${assessment.work_ready ? 'btn-danger' : 'btn-primary'}`} onClick={() => { setReadinessNotes('');setReadinessReview({ staffId: assessment.staff_id, name: s.display_name || s.email || 'Staff member', current: assessment.work_ready, next: !assessment.work_ready }); }}>{assessment.work_ready ? 'Remove work readiness' : 'Mark work ready'}</button></div> : null; })()}
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      )}

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

      {review && <div className="hr-review-backdrop"><form className="hr-review-dialog" role="dialog" aria-modal="true" aria-labelledby="hr-review-title" onSubmit={handleReview}><header><div><span>Governed HR decision</span><h2 id="hr-review-title">{review.decision === 'approved' ? 'Approve' : review.decision === 'declined' ? 'Decline' : 'Reject'} {review.kind === 'leave' ? 'leave request' : 'timesheet'}?</h2></div><button type="button" onClick={() => setReview(null)} aria-label="Close review">×</button></header><p>{review.kind === 'leave' ? 'Leave approval will fail when active roster slots overlap the requested dates.' : 'Approved hours become eligible for the payroll export workflow.'}</p><label><span>Review notes</span><textarea rows={4} required={review.decision !== 'approved'} value={reviewNotes} onChange={(event) => setReviewNotes(event.target.value)} /></label><footer><button type="button" className="btn btn-secondary" onClick={() => setReview(null)}>Back</button><button type="submit" className="btn btn-primary" disabled={saving || (review.decision !== 'approved' && !reviewNotes.trim())}>{saving ? 'Saving' : 'Confirm decision'}</button></footer></form></div>}
      {readinessReview && <div className="hr-review-backdrop"><form className="hr-review-dialog" role="dialog" aria-modal="true" aria-labelledby="readiness-review-title" onSubmit={handleReadinessReview}><header><div><span>Staff eligibility</span><h2 id="readiness-review-title">{readinessReview.next ? 'Mark work ready?' : 'Remove work readiness?'}</h2></div><button type="button" onClick={() => setReadinessReview(null)} aria-label="Close readiness review">×</button></header><p>{readinessReview.next ? 'Identity, employment, and current credential blockers are checked again by the server.' : 'The staff member will no longer be eligible for new roster assignments.'}</p><label><span>Readiness review notes</span><textarea rows={4} required value={readinessNotes} onChange={(event) => setReadinessNotes(event.target.value)} /></label><footer><button type="button" className="btn btn-secondary" onClick={() => setReadinessReview(null)}>Back</button><button type="submit" className="btn btn-primary" disabled={saving || !readinessNotes.trim()}>{saving ? 'Saving' : 'Confirm readiness'}</button></footer></form></div>}
      {credentialRenewal && <div className="hr-review-backdrop"><form className="hr-review-dialog" role="dialog" aria-modal="true" aria-labelledby="credential-renewal-title" onSubmit={handleCredentialRenewal}><header><div><span>Credential evidence</span><h2 id="credential-renewal-title">Record renewal</h2></div><button type="button" onClick={() => setCredentialRenewal(null)} aria-label="Close credential renewal">×</button></header><p>The existing {credentialRenewal.source.credential_type.replaceAll('_',' ')} record remains in history. This replacement is verified against your evidence notes.</p><label><span>Credential number</span><input required value={credentialRenewal.credentialNumber} onChange={(event)=>setCredentialRenewal({...credentialRenewal,credentialNumber:event.target.value})}/></label><label><span>Issuing authority</span><input required value={credentialRenewal.issuingAuthority} onChange={(event)=>setCredentialRenewal({...credentialRenewal,issuingAuthority:event.target.value})}/></label><div className="form-row"><label><span>Issued date</span><input type="date" required value={credentialRenewal.issuedDate} onChange={(event)=>setCredentialRenewal({...credentialRenewal,issuedDate:event.target.value})}/></label><label><span>New expiry date</span><input type="date" required min={credentialRenewal.source.expiry_date??undefined} value={credentialRenewal.expiryDate} onChange={(event)=>setCredentialRenewal({...credentialRenewal,expiryDate:event.target.value})}/></label></div><label><span>Verification evidence notes</span><textarea rows={4} required minLength={10} value={credentialRenewal.evidenceNotes} onChange={(event)=>setCredentialRenewal({...credentialRenewal,evidenceNotes:event.target.value})}/></label><footer><button type="button" className="btn btn-secondary" onClick={()=>setCredentialRenewal(null)}>Back</button><button type="submit" className="btn btn-primary" disabled={saving||!credentialRenewal.credentialNumber.trim()||!credentialRenewal.issuingAuthority.trim()||!credentialRenewal.issuedDate||!credentialRenewal.expiryDate||credentialRenewal.evidenceNotes.trim().length<10}>{saving?'Saving':'Confirm renewal'}</button></footer></form></div>}
      {coverageFinalization&&<div className="hr-review-backdrop"><form className="hr-review-dialog" role="dialog" aria-modal="true" aria-labelledby="coverage-finalization-title" onSubmit={finalizeCoverage}><header><div><span>Coverage ownership</span><h2 id="coverage-finalization-title">Finalize assignment</h2></div><button type="button" onClick={()=>setCoverageFinalization(null)} aria-label="Close coverage finalization">×</button></header><p>Confirm the claimant against an active work unit. Field work creates the linked operational shift through the governed roster workflow.</p><label><span>Select work unit</span><select required value={coverageFinalization.workUnitId} onChange={(event)=>setCoverageFinalization({...coverageFinalization,workUnitId:event.target.value})}><option value="">Select work unit</option>{coverageWorkUnits.map((unit)=><option value={unit.id} key={unit.id}>{unit.name} · {unit.work_unit_type}</option>)}</select></label><label><span>Finalization notes</span><textarea rows={3} value={coverageFinalization.notes} onChange={(event)=>setCoverageFinalization({...coverageFinalization,notes:event.target.value})}/></label><footer><button type="button" className="btn btn-secondary" onClick={()=>setCoverageFinalization(null)}>Back</button><button type="submit" className="btn btn-primary" disabled={saving||!coverageFinalization.workUnitId}>{saving?'Finalizing':'Confirm assignment'}</button></footer></form></div>}
    </div>
  );
};

export default RosterHRPage;
