/**
 * TimesheetsPage.tsx
 *
 * Independent page for timesheet review, approval, and manual correction.
 * Also surfaces commercial-readiness exceptions and roster attendance exceptions
 * so admin can add rates or correct shift records without leaving the workflow.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, CalendarDays, CheckCircle2, Clock3, DollarSign, Edit3, Filter, MapPin, RefreshCw, Save, Search, ShieldCheck, UserCheck, X, XCircle } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { plainWords } from '../lib/rosterWords';
import './PageStyles.css';
import './TimesheetsPage.css';

type TimesheetTab = 'timesheets' | 'commercial' | 'attendance';

type TimesheetDecision = 'branch_checked' | 'approved' | 'rejected';

interface TimesheetRow {
  id: string;
  staff_id: string;
  shift_id: string | null;
  period_start: string;
  period_end: string;
  scheduled_hours: number | null;
  actual_hours: number | null;
  overtime_hours: number | null;
  adjustment_hours: number | null;
  work_derived_hours: number | null;
  status: string;
  pay_code_override: string | null;
  hourly_rate_override: number | null;
  service_type: string | null;
  location_id: string | null;
  zone_id: string | null;
  notes: string | null;
  review_notes: string | null;
  submitted_at: string | null;
  submitted_by: string | null;
  branch_reviewed_by: string | null;
  branch_reviewed_at: string | null;
  branch_reviewed_organization_id: string | null;
  corporate_reviewed_by: string | null;
  corporate_reviewed_at: string | null;
  revision: number;
}

interface StaffName {
  staff_id: string;
  display_name: string | null;
}

interface CommercialReadinessRow {
  slot_id: string;
  pay_status: string;
  billing_status: string;
  quote_status: string;
  geofence_status: string;
  cost_centre_status: string;
}

interface AttendanceExceptionRow {
  shift_id: string;
  officer_user_id: string;
  service_type: string;
  scheduled_start: string;
  scheduled_end: string;
  status: string;
  exception_type: string;
  minutes_overdue: number;
}

interface ShiftRecord {
  id: string;
  organization_id: string;
  officer_user_id: string;
  service_type: string;
  location_id: string | null;
  zone_id: string | null;
  scheduled_start: string;
  scheduled_end: string;
  actual_start: string | null;
  actual_end: string | null;
  status: string;
  updated_at: string;
}

const isoDate = (date: Date) => date.toISOString().slice(0, 10);
const nzDateInput = (iso: string | null | undefined) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const tz = d.getTimezoneOffset();
  const local = new Date(d.getTime() - tz * 60000);
  return local.toISOString().slice(0, 16);
};
const fromNzDateInput = (value: string) => {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
};
const statusBadge = (status: string) => {
  const map: Record<string, string> = {
    draft: 'status-draft',
    submitted: 'status-submitted',
    branch_checked: 'status-branch',
    approved: 'status-approved',
    rejected: 'status-rejected',
    paid: 'status-paid',
  };
  return `status-badge ${map[status] ?? 'status-draft'}`;
};
const decisionLabel = (decision: TimesheetDecision) =>
  ({ branch_checked: 'Branch check', approved: 'Approve', rejected: 'Reject' }[decision]);

const TimesheetsPage: React.FC = () => {
  const { profile, operatingOrganizationId, operatingOrganizations } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const branchId = operatingOrganizationId ?? profile?.organizationId ?? null;
  const isAdmin = useMemo(() => {
    const role = profile?.role;
    return role === 'grand_master' || role === 'master' || role === 'admin' || role === 'admin_officer';
  }, [profile?.role]);
  const corporatePayrollReviewer = isAdmin;
  const workingInBranch = !!operatingOrganizationId;

  const [tab, setTab] = useState<TimesheetTab>('timesheets');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Date range
  const today = useMemo(() => isoDate(new Date()), []);
  const [rangeStart, setRangeStart] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 14);
    return isoDate(d);
  });
  const [rangeEnd, setRangeEnd] = useState(today);

  // Timesheets
  const [timesheets, setTimesheets] = useState<TimesheetRow[]>([]);
  const [staffNames, setStaffNames] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [saving, setSaving] = useState(false);
  const [editingTimesheet, setEditingTimesheet] = useState<TimesheetRow | null>(null);
  const [editForm, setEditForm] = useState({
    actualHours: '',
    overtimeHours: '',
    adjustmentHours: '',
    serviceType: '',
    notes: '',
    reason: '',
  });

  // Commercial readiness
  const [commercialRows, setCommercialRows] = useState<CommercialReadinessRow[]>([]);
  const [commercialFilter, setCommercialFilter] = useState<string>('all');
  const [rateForm, setRateForm] = useState<{
    slotId: string;
    ruleKind: 'pay' | 'billing';
    name: string;
    rateType: string;
    amount: string;
    payCode: string;
    serviceType: string;
    effectiveFrom: string;
    effectiveTo: string;
  } | null>(null);

  // Attendance exceptions
  const [attendanceRows, setAttendanceRows] = useState<AttendanceExceptionRow[]>([]);
  const [attendanceGrace, setAttendanceGrace] = useState(15);
  const [editingShift, setEditingShift] = useState<ShiftRecord | null>(null);
  const [shiftForm, setShiftForm] = useState({
    scheduledStart: '',
    scheduledEnd: '',
    actualStart: '',
    actualEnd: '',
    serviceType: '',
    status: '',
    reason: '',
  });

  const generation = useRef(0);

  const loadStaffNames = useCallback(async (staffIds: string[]) => {
    if (!profile?.organizationId || staffIds.length === 0) return;
    const { data } = await supabase
      .from('staff_profiles')
      .select('staff_id, display_name')
      .in('staff_id', Array.from(new Set(staffIds)))
      .eq('organization_id', profile.organizationId);
    const map: Record<string, string> = {};
    (data as StaffName[] | null)?.forEach((s) => {
      map[s.staff_id] = s.display_name ?? 'Unknown';
    });
    setStaffNames(map);
  }, [profile?.organizationId]);

  const loadTimesheets = useCallback(async () => {
    if (!profile?.organizationId) return;
    const version = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      let rows: TimesheetRow[] = [];
      if (workingInBranch && branchId) {
        const { data, error: rpcError } = await supabase.rpc('get_branch_timesheet_queue', {
          p_operating_organization_id: branchId,
          p_from: rangeStart,
          p_to: rangeEnd,
        });
        if (rpcError) throw rpcError;
        rows = (data as TimesheetRow[] | null) ?? [];
      } else {
        const { data, error: dbError } = await supabase
          .from('timesheets')
          .select('*')
          .eq('organization_id', profile.organizationId)
          .gte('period_start', rangeStart)
          .lte('period_end', rangeEnd)
          .order('period_start', { ascending: false });
        if (dbError) throw dbError;
        rows = (data as TimesheetRow[] | null) ?? [];
      }
      if (version !== generation.current) return;
      setTimesheets(rows);
      await loadStaffNames(rows.map((r) => r.staff_id));
    } catch (err) {
      if (version === generation.current) {
        setError(err instanceof Error ? err.message : 'Failed to load timesheets');
      }
    } finally {
      if (version === generation.current) setLoading(false);
    }
  }, [profile?.organizationId, branchId, workingInBranch, rangeStart, rangeEnd, loadStaffNames]);

  const loadCommercial = useCallback(async () => {
    if (!profile?.organizationId) return;
    setLoading(true);
    setError(null);
    try {
      const { data, error: rpcError } = await supabase.rpc('get_roster_commercial_readiness', {
        p_organization_id: profile.organizationId,
        p_from: new Date(rangeStart).toISOString(),
        p_to: new Date(rangeEnd + 'T23:59:59').toISOString(),
      });
      if (rpcError) throw rpcError;
      setCommercialRows((data as CommercialReadinessRow[] | null) ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load commercial readiness');
    } finally {
      setLoading(false);
    }
  }, [profile?.organizationId, rangeStart, rangeEnd]);

  const loadAttendance = useCallback(async () => {
    if (!profile?.organizationId) return;
    setLoading(true);
    setError(null);
    try {
      const { data, error: rpcError } = await supabase.rpc('get_roster_attendance_exceptions', {
        p_organization_id: profile.organizationId,
        p_grace_minutes: attendanceGrace,
        p_from: new Date(rangeStart).toISOString(),
        p_to: new Date(rangeEnd + 'T23:59:59').toISOString(),
      });
      if (rpcError) throw rpcError;
      setAttendanceRows((data as AttendanceExceptionRow[] | null) ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load attendance exceptions');
    } finally {
      setLoading(false);
    }
  }, [profile?.organizationId, rangeStart, rangeEnd, attendanceGrace]);

  useEffect(() => {
    if (tab === 'timesheets') loadTimesheets();
    else if (tab === 'commercial') loadCommercial();
    else if (tab === 'attendance') loadAttendance();
  }, [tab, loadTimesheets, loadCommercial, loadAttendance]);

  const filteredTimesheets = useMemo(() => {
    let rows = timesheets;
    if (statusFilter !== 'all') rows = rows.filter((r) => r.status === statusFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter((r) => {
        const name = (staffNames[r.staff_id] ?? '').toLowerCase();
        return name.includes(q) || r.service_type?.toLowerCase().includes(q) || r.status.includes(q);
      });
    }
    return rows;
  }, [timesheets, statusFilter, search, staffNames]);

  const filteredCommercial = useMemo(() => {
    if (commercialFilter === 'all') return commercialRows;
    return commercialRows.filter((r) =>
      r.pay_status === commercialFilter ||
      r.billing_status === commercialFilter ||
      r.quote_status === commercialFilter ||
      r.geofence_status === commercialFilter ||
      r.cost_centre_status === commercialFilter
    );
  }, [commercialRows, commercialFilter]);

  const handleReview = async (item: TimesheetRow, decision: TimesheetDecision) => {
    if (!profile?.organizationId || saving) return;
    setSaving(true);
    setError(null);
    try {
      let result;
      if (workingInBranch && branchId) {
        result = await supabase.rpc('review_branch_timesheet', {
          p_operating_organization_id: branchId,
          p_timesheet_id: item.id,
          p_expected_status: item.status,
          p_decision: decision,
        });
      } else {
        result = await supabase.rpc('review_timesheet', {
          p_timesheet_id: item.id,
          p_expected_status: item.status,
          p_decision: decision,
        });
      }
      if (result.error) throw result.error;
      setNotice(`Timesheet ${decisionLabel(decision).toLowerCase()} recorded.`);
      await loadTimesheets();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Review failed');
    } finally {
      setSaving(false);
    }
  };

  const openTimesheetEdit = (item: TimesheetRow) => {
    setEditingTimesheet(item);
    setEditForm({
      actualHours: String(item.actual_hours ?? ''),
      overtimeHours: String(item.overtime_hours ?? ''),
      adjustmentHours: String(item.adjustment_hours ?? ''),
      serviceType: item.service_type ?? '',
      notes: item.notes ?? '',
      reason: '',
    });
  };

  const submitTimesheetCorrection = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editingTimesheet) return;
    setSaving(true);
    setError(null);
    try {
      const actual = parseFloat(editForm.actualHours);
      const overtime = parseFloat(editForm.overtimeHours);
      if (Number.isNaN(actual) || actual < 0) throw new Error('Actual hours must be a non-negative number');
      if (Number.isNaN(overtime) || overtime < 0) throw new Error('Overtime hours must be a non-negative number');
      const { error: rpcError } = await supabase.rpc('correct_timesheet_hours', {
        p_timesheet_id: editingTimesheet.id,
        p_expected_status: editingTimesheet.status,
        p_actual_hours: actual,
        p_overtime_hours: overtime,
        p_reason: editForm.reason,
      });
      if (rpcError) throw rpcError;

      if (editForm.adjustmentHours || editForm.serviceType || editForm.notes) {
        const { error: updError } = await supabase
          .from('timesheets')
          .update({
            adjustment_hours: editForm.adjustmentHours ? parseFloat(editForm.adjustmentHours) : null,
            service_type: editForm.serviceType || null,
            notes: editForm.notes || null,
          })
          .eq('id', editingTimesheet.id)
          .eq('organization_id', profile?.organizationId ?? '');
        if (updError) throw updError;
      }

      setNotice('Timesheet corrected.');
      setEditingTimesheet(null);
      await loadTimesheets();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Correction failed');
    } finally {
      setSaving(false);
    }
  };

  const openRateForm = (row: CommercialReadinessRow, kind: 'pay' | 'billing') => {
    setRateForm({
      slotId: row.slot_id,
      ruleKind: kind,
      name: '',
      rateType: 'hourly',
      amount: '',
      payCode: '',
      serviceType: '',
      effectiveFrom: today,
      effectiveTo: '',
    });
  };

  const submitRate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!rateForm || !branchId) return;
    setSaving(true);
    setError(null);
    try {
      const amount = parseFloat(rateForm.amount);
      if (Number.isNaN(amount) || amount < 0) throw new Error('Amount must be a non-negative number');
      const { error: rpcError } = await supabase.rpc('manage_operating_branch_rate_rule', {
        p_operating_organization_id: branchId,
        p_client_request_id: crypto.randomUUID(),
        p_action: 'create',
        p_rule_kind: rateForm.ruleKind,
        p_name: rateForm.name,
        p_rate_type: rateForm.rateType,
        p_amount: amount,
        p_pay_code: rateForm.ruleKind === 'pay' ? rateForm.payCode : null,
        p_service_type: rateForm.serviceType || null,
        p_effective_from: rateForm.effectiveFrom || null,
        p_effective_to: rateForm.effectiveTo || null,
      });
      if (rpcError) throw rpcError;
      setNotice(`${rateForm.ruleKind === 'pay' ? 'Pay' : 'Billing'} rate rule created.`);
      setRateForm(null);
      await loadCommercial();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rate creation failed');
    } finally {
      setSaving(false);
    }
  };

  const openShiftEdit = async (row: AttendanceExceptionRow) => {
    if (!profile?.organizationId) return;
    setLoading(true);
    try {
      const { data, error: dbError } = await supabase
        .from('shifts')
        .select('*')
        .eq('id', row.shift_id)
        .eq('organization_id', profile.organizationId)
        .single();
      if (dbError) throw dbError;
      const shift = data as ShiftRecord;
      setEditingShift(shift);
      setShiftForm({
        scheduledStart: nzDateInput(shift.scheduled_start),
        scheduledEnd: nzDateInput(shift.scheduled_end),
        actualStart: nzDateInput(shift.actual_start),
        actualEnd: nzDateInput(shift.actual_end),
        serviceType: shift.service_type,
        status: shift.status,
        reason: '',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load shift');
    } finally {
      setLoading(false);
    }
  };

  const submitShiftEdit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editingShift || !profile?.organizationId) return;
    setSaving(true);
    setError(null);
    try {
      const { error: rpcError } = await supabase.rpc('manage_shift_record', {
        p_shift_id: editingShift.id,
        p_expected_updated_at: editingShift.updated_at,
        p_scheduled_start: fromNzDateInput(shiftForm.scheduledStart),
        p_scheduled_end: fromNzDateInput(shiftForm.scheduledEnd),
        p_actual_start: fromNzDateInput(shiftForm.actualStart),
        p_actual_end: fromNzDateInput(shiftForm.actualEnd),
        p_service_type: shiftForm.serviceType || null,
        p_status: shiftForm.status || null,
        p_reason: shiftForm.reason || null,
      });
      if (rpcError) throw rpcError;
      setNotice('Shift record updated.');
      setEditingShift(null);
      await loadAttendance();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Shift update failed');
    } finally {
      setSaving(false);
    }
  };

  const acknowledgeAttendance = async (row: AttendanceExceptionRow) => {
    if (!profile?.organizationId || saving) return;
    setSaving(true);
    setError(null);
    try {
      const { error: rpcError } = await supabase.rpc('acknowledge_roster_attendance_exception', {
        p_shift_id: row.shift_id,
        p_exception_type: row.exception_type,
        p_notes: `Acknowledged from timesheet review`,
      });
      if (rpcError) throw rpcError;
      setNotice('Attendance exception acknowledged.');
      await loadAttendance();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Acknowledgement failed');
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (!notice && !error) return;
    const t = window.setTimeout(() => { setNotice(null); setError(null); }, 6000);
    return () => window.clearTimeout(t);
  }, [notice, error]);

  return (
    <div className="page-container timesheets-page">
      <header className="page-header">
        <button type="button" className="icon-btn back-btn" onClick={() => navigate('/admin/roster-operations')} aria-label="Back to roster operations"><ArrowLeft size={18} /></button>
        <div>
          <h1>Timesheets & approvals</h1>
          <p className="subtitle">{workingInBranch ? `Branch: ${operatingOrganizations.find((o) => o.organizationId === branchId)?.organizationName ?? branchId}` : 'Corporate payroll view'}</p>
        </div>
      </header>

      <nav className="timesheets-tabs" aria-label="Timesheets sections">
        <button type="button" className={tab === 'timesheets' ? 'active' : ''} onClick={() => setTab('timesheets')}><Clock3 size={16} /> Timesheets</button>
        <button type="button" className={tab === 'commercial' ? 'active' : ''} onClick={() => setTab('commercial')}><DollarSign size={16} /> Commercial readiness</button>
        <button type="button" className={tab === 'attendance' ? 'active' : ''} onClick={() => setTab('attendance')}><AlertTriangle size={16} /> Attendance exceptions</button>
      </nav>

      {(error || notice) && (
        <div className={`timesheets-alert ${error ? 'error' : 'notice'}`} role={error ? 'alert' : 'status'}>
          {error ? <XCircle size={18} /> : <CheckCircle2 size={18} />}
          <span>{error ?? notice}</span>
          <button type="button" onClick={() => { setError(null); setNotice(null); }} aria-label="Dismiss"><X size={14} /></button>
        </div>
      )}

      <section className="timesheets-toolbar">
        <label className="date-field">
          <CalendarDays size={14} />
          <span>From</span>
          <input type="date" value={rangeStart} onChange={(e) => setRangeStart(e.target.value)} />
        </label>
        <label className="date-field">
          <CalendarDays size={14} />
          <span>To</span>
          <input type="date" value={rangeEnd} onChange={(e) => setRangeEnd(e.target.value)} />
        </label>
        <button type="button" className="btn btn-secondary" onClick={() => { setRangeStart(today); setRangeEnd(today); }}>Today</button>
        <button type="button" className="btn btn-secondary" onClick={tab === 'timesheets' ? loadTimesheets : tab === 'commercial' ? loadCommercial : loadAttendance} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'spin' : ''} /> Refresh
        </button>
      </section>

      {tab === 'timesheets' && (
        <section className="timesheets-section">
          <div className="timesheets-filters">
            <div className="search-field">
              <Search size={14} />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search staff, service, status…" />
            </div>
            <label className="filter-field">
              <Filter size={14} />
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <option value="all">All statuses</option>
                <option value="draft">Draft</option>
                <option value="submitted">Submitted</option>
                <option value="branch_checked">Branch checked</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
                <option value="paid">Paid</option>
              </select>
            </label>
          </div>

          {loading && timesheets.length === 0 ? (
            <div className="timesheets-empty">Loading timesheets…</div>
          ) : filteredTimesheets.length === 0 ? (
            <div className="timesheets-empty">
              <strong>No timesheets found</strong>
              <p>Adjust the date range or filters, or check that branch operating authority is set.</p>
            </div>
          ) : (
            <div className="reports-table-wrapper">
              <table className="reports-table timesheets-table">
                <caption className="sr-only">Timesheet reconciliation and approval queue</caption>
                <thead>
                  <tr>
                    <th scope="col">Staff</th>
                    <th scope="col">Period</th>
                    <th scope="col">Service</th>
                    <th scope="col">Scheduled</th>
                    <th scope="col">Actual</th>
                    <th scope="col">Overtime</th>
                    <th scope="col">Adjustment</th>
                    <th scope="col">Status</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTimesheets.map((row) => (
                    <tr key={row.id}>
                      <td>{staffNames[row.staff_id] ?? row.staff_id.slice(0, 8)}</td>
                      <td>{row.period_start} → {row.period_end}</td>
                      <td>{row.service_type ?? '—'}</td>
                      <td>{row.scheduled_hours ?? '—'}</td>
                      <td>{row.actual_hours ?? '—'}</td>
                      <td>{row.overtime_hours ?? '—'}</td>
                      <td>{row.adjustment_hours ?? '—'}</td>
                      <td><span className={statusBadge(row.status)}>{plainWords(row.status)}</span></td>
                      <td className="row-actions">
                        <button type="button" className="icon-btn" title="Edit timesheet" onClick={() => openTimesheetEdit(row)}><Edit3 size={16} /></button>
                        {row.status === 'submitted' && workingInBranch && (
                          <button type="button" className="btn btn-sm btn-secondary" onClick={() => handleReview(row, 'branch_checked')} disabled={saving}><ShieldCheck size={14} /> Branch check</button>
                        )}
                        {row.status === 'branch_checked' && corporatePayrollReviewer && (
                          <button type="button" className="btn btn-sm btn-primary" onClick={() => handleReview(row, 'approved')} disabled={saving}><CheckCircle2 size={14} /> Approve</button>
                        )}
                        {(row.status === 'submitted' || row.status === 'branch_checked') && corporatePayrollReviewer && (
                          <button type="button" className="btn btn-sm btn-danger" onClick={() => handleReview(row, 'rejected')} disabled={saving}><XCircle size={14} /> Reject</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {tab === 'commercial' && (
        <section className="timesheets-section">
          <div className="timesheets-filters">
            <label className="filter-field">
              <Filter size={14} />
              <select value={commercialFilter} onChange={(e) => setCommercialFilter(e.target.value)}>
                <option value="all">All exceptions</option>
                <option value="ok">Resolved</option>
                <option value="missing">Missing</option>
                <option value="missing_rule">Missing rule</option>
                <option value="missing_rate">Missing rate</option>
                <option value="missing_contract">Missing contract</option>
                <option value="missing_quote">Missing quote</option>
                <option value="mapped_unverified">Unverified geofence</option>
                <option value="missing_cost_centre">Missing cost centre</option>
              </select>
            </label>
          </div>

          {loading && commercialRows.length === 0 ? (
            <div className="timesheets-empty">Loading commercial readiness…</div>
          ) : filteredCommercial.length === 0 ? (
            <div className="timesheets-empty"><strong>No commercial readiness exceptions</strong><p>All roster slots in this period have pay, billing, quote, geofence and cost centre coverage.</p></div>
          ) : (
            <div className="reports-table-wrapper">
              <table className="reports-table commercial-table">
                <thead>
                  <tr><th scope="col">Slot</th><th scope="col">Pay</th><th scope="col">Billing</th><th scope="col">Quote</th><th scope="col">Geofence</th><th scope="col">Cost centre</th><th scope="col">Actions</th></tr>
                </thead>
                <tbody>
                  {filteredCommercial.map((row) => (
                    <tr key={row.slot_id}>
                      <td>{row.slot_id.slice(0, 8)}</td>
                      <td><span className={`readiness-cell ${row.pay_status}`}>{plainWords(row.pay_status)}</span></td>
                      <td><span className={`readiness-cell ${row.billing_status}`}>{plainWords(row.billing_status)}</span></td>
                      <td><span className={`readiness-cell ${row.quote_status}`}>{plainWords(row.quote_status)}</span></td>
                      <td><span className={`readiness-cell ${row.geofence_status}`}>{plainWords(row.geofence_status)}</span></td>
                      <td><span className={`readiness-cell ${row.cost_centre_status}`}>{plainWords(row.cost_centre_status)}</span></td>
                      <td className="row-actions">
                        {row.pay_status !== 'ok' && <button type="button" className="btn btn-sm btn-secondary" onClick={() => openRateForm(row, 'pay')}><DollarSign size={14} /> Add pay rate</button>}
                        {row.billing_status !== 'ok' && <button type="button" className="btn btn-sm btn-secondary" onClick={() => openRateForm(row, 'billing')}><DollarSign size={14} /> Add bill rate</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {tab === 'attendance' && (
        <section className="timesheets-section">
          <div className="timesheets-filters">
            <label className="filter-field">
              <Clock3 size={14} />
              <span>Grace minutes</span>
              <input type="number" min="0" max="240" value={attendanceGrace} onChange={(e) => setAttendanceGrace(parseInt(e.target.value, 10) || 0)} />
            </label>
          </div>

          {loading && attendanceRows.length === 0 ? (
            <div className="timesheets-empty">Loading attendance exceptions…</div>
          ) : attendanceRows.length === 0 ? (
            <div className="timesheets-empty"><strong>No attendance exceptions</strong><p>All shifts in this window are on time or already acknowledged.</p></div>
          ) : (
            <div className="reports-table-wrapper">
              <table className="reports-table attendance-table">
                <thead>
                  <tr><th scope="col">Officer</th><th scope="col">Service</th><th scope="col">Scheduled</th><th scope="col">Status</th><th scope="col">Exception</th><th scope="col">Minutes overdue</th><th scope="col">Actions</th></tr>
                </thead>
                <tbody>
                  {attendanceRows.map((row) => (
                    <tr key={row.shift_id}>
                      <td>{row.officer_user_id.slice(0, 8)}</td>
                      <td>{row.service_type}</td>
                      <td>{new Date(row.scheduled_start).toLocaleString()} → {new Date(row.scheduled_end).toLocaleString()}</td>
                      <td><span className={statusBadge(row.status)}>{plainWords(row.status)}</span></td>
                      <td>{plainWords(row.exception_type)}</td>
                      <td>{row.minutes_overdue}</td>
                      <td className="row-actions">
                        <button type="button" className="btn btn-sm btn-secondary" onClick={() => openShiftEdit(row)}><Edit3 size={14} /> Edit shift</button>
                        <button type="button" className="btn btn-sm btn-primary" onClick={() => acknowledgeAttendance(row)} disabled={saving}><CheckCircle2 size={14} /> Acknowledge</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {editingTimesheet && (
        <div className="timesheet-dialog-backdrop">
          <form className="timesheet-dialog" onSubmit={submitTimesheetCorrection} role="dialog" aria-modal="true" aria-labelledby="timesheet-edit-title">
            <header>
              <div>
                <span>Timesheet correction</span>
                <h2 id="timesheet-edit-title">Edit timesheet</h2>
              </div>
              <button type="button" onClick={() => setEditingTimesheet(null)} aria-label="Close"><X size={18} /></button>
            </header>
            <div className="dialog-body">
              <div className="form-row">
                <label><span>Actual hours</span><input type="number" min="0" step="0.01" value={editForm.actualHours} onChange={(e) => setEditForm({ ...editForm, actualHours: e.target.value })} required /></label>
                <label><span>Overtime hours</span><input type="number" min="0" step="0.01" value={editForm.overtimeHours} onChange={(e) => setEditForm({ ...editForm, overtimeHours: e.target.value })} required /></label>
                <label><span>Adjustment hours</span><input type="number" step="0.01" value={editForm.adjustmentHours} onChange={(e) => setEditForm({ ...editForm, adjustmentHours: e.target.value })} /></label>
              </div>
              <div className="form-row">
                <label><span>Service type</span><input value={editForm.serviceType} onChange={(e) => setEditForm({ ...editForm, serviceType: e.target.value })} /></label>
                <label><span>Notes</span><input value={editForm.notes} onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })} /></label>
              </div>
              <label><span>Reason for correction (required)</span><textarea value={editForm.reason} onChange={(e) => setEditForm({ ...editForm, reason: e.target.value })} required minLength={5} /></label>
            </div>
            <footer>
              <button type="button" className="btn btn-secondary" onClick={() => setEditingTimesheet(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}><Save size={16} /> {saving ? 'Saving…' : 'Save correction'}</button>
            </footer>
          </form>
        </div>
      )}

      {rateForm && (
        <div className="timesheet-dialog-backdrop">
          <form className="timesheet-dialog" onSubmit={submitRate} role="dialog" aria-modal="true" aria-labelledby="rate-edit-title">
            <header>
              <div>
                <span>{rateForm.ruleKind === 'pay' ? 'Pay rate' : 'Billing rate'}</span>
                <h2 id="rate-edit-title">Add {rateForm.ruleKind === 'pay' ? 'pay' : 'billing'} rate rule</h2>
              </div>
              <button type="button" onClick={() => setRateForm(null)} aria-label="Close"><X size={18} /></button>
            </header>
            <div className="dialog-body">
              <div className="form-row">
                <label><span>Name</span><input value={rateForm.name} onChange={(e) => setRateForm({ ...rateForm, name: e.target.value })} required /></label>
                <label><span>Rate type</span>
                  <select value={rateForm.rateType} onChange={(e) => setRateForm({ ...rateForm, rateType: e.target.value })} required>
                    <option value="hourly">Hourly</option>
                    <option value="flat">Flat</option>
                    <option value="daily">Daily</option>
                    <option value="per_km">Per km</option>
                    <option value="per_unit">Per unit</option>
                    <option value="percentage">Percentage</option>
                    <option value="per_hour_travel">Per hour travel</option>
                    <option value="per_hour_allowance">Per hour allowance</option>
                    <option value="oncall_flat">On-call flat</option>
                    <option value="callout">Callout</option>
                    <option value="higher_duties_flat">Higher duties flat</option>
                    <option value="per_visit">Per visit</option>
                    <option value="per_notice">Per notice</option>
                  </select>
                </label>
              </div>
              <div className="form-row">
                <label><span>Amount</span><input type="number" min="0" step="0.01" value={rateForm.amount} onChange={(e) => setRateForm({ ...rateForm, amount: e.target.value })} required /></label>
                {rateForm.ruleKind === 'pay' && <label><span>Pay code</span><input value={rateForm.payCode} onChange={(e) => setRateForm({ ...rateForm, payCode: e.target.value })} required /></label>}
                <label><span>Service type</span><input value={rateForm.serviceType} onChange={(e) => setRateForm({ ...rateForm, serviceType: e.target.value })} /></label>
              </div>
              <div className="form-row">
                <label><span>Effective from</span><input type="date" value={rateForm.effectiveFrom} onChange={(e) => setRateForm({ ...rateForm, effectiveFrom: e.target.value })} /></label>
                <label><span>Effective to</span><input type="date" value={rateForm.effectiveTo} onChange={(e) => setRateForm({ ...rateForm, effectiveTo: e.target.value })} /></label>
              </div>
            </div>
            <footer>
              <button type="button" className="btn btn-secondary" onClick={() => setRateForm(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}><Save size={16} /> {saving ? 'Saving…' : 'Create rate rule'}</button>
            </footer>
          </form>
        </div>
      )}

      {editingShift && (
        <div className="timesheet-dialog-backdrop">
          <form className="timesheet-dialog" onSubmit={submitShiftEdit} role="dialog" aria-modal="true" aria-labelledby="shift-edit-title">
            <header>
              <div>
                <span>Shift record</span>
                <h2 id="shift-edit-title">Edit shift record</h2>
              </div>
              <button type="button" onClick={() => setEditingShift(null)} aria-label="Close"><X size={18} /></button>
            </header>
            <div className="dialog-body">
              <div className="form-row">
                <label><span>Scheduled start</span><input type="datetime-local" value={shiftForm.scheduledStart} onChange={(e) => setShiftForm({ ...shiftForm, scheduledStart: e.target.value })} required /></label>
                <label><span>Scheduled end</span><input type="datetime-local" value={shiftForm.scheduledEnd} onChange={(e) => setShiftForm({ ...shiftForm, scheduledEnd: e.target.value })} required /></label>
              </div>
              <div className="form-row">
                <label><span>Actual start</span><input type="datetime-local" value={shiftForm.actualStart} onChange={(e) => setShiftForm({ ...shiftForm, actualStart: e.target.value })} /></label>
                <label><span>Actual end</span><input type="datetime-local" value={shiftForm.actualEnd} onChange={(e) => setShiftForm({ ...shiftForm, actualEnd: e.target.value })} /></label>
              </div>
              <div className="form-row">
                <label><span>Service type</span><input value={shiftForm.serviceType} onChange={(e) => setShiftForm({ ...shiftForm, serviceType: e.target.value })} required /></label>
                <label><span>Status</span>
                  <select value={shiftForm.status} onChange={(e) => setShiftForm({ ...shiftForm, status: e.target.value })} required>
                    <option value="scheduled">Scheduled</option>
                    <option value="published">Published</option>
                    <option value="accepted">Accepted</option>
                    <option value="in_progress">In progress</option>
                    <option value="completed">Completed</option>
                    <option value="missed">Missed</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                </label>
              </div>
              <label><span>Reason for edit (required)</span><textarea value={shiftForm.reason} onChange={(e) => setShiftForm({ ...shiftForm, reason: e.target.value })} required minLength={5} /></label>
            </div>
            <footer>
              <button type="button" className="btn btn-secondary" onClick={() => setEditingShift(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}><Save size={16} /> {saving ? 'Saving…' : 'Save shift'}</button>
            </footer>
          </form>
        </div>
      )}
    </div>
  );
};

export default TimesheetsPage;
