/**
 * TimesheetsPage.tsx
 *
 * One page for timesheet review, approval and governed correction, plus the
 * roster commercial-readiness and attendance exceptions that block payroll and
 * invoicing. Every exception links to the record that fixes it.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, CalendarDays, CheckCircle2, Clock3, DollarSign, Edit3, ExternalLink, Filter, RefreshCw, Save, Search, ShieldCheck, X, XCircle } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { plainWords } from '../lib/rosterWords';
import { loadPayCodes, loadServiceCatalog, serviceLabel, type PayCode, type ServiceCode } from '../lib/payCatalog';
import { PayCodeSelect } from '../components/PayCodeSelect';
import { timesheetSummaryMismatchReasons } from '../lib/timesheetTolerances';
import { ServiceCodeSelect } from '../components/ServiceCodeSelect';
import './PageStyles.css';
import './TimesheetsPage.css';

type TimesheetTab = 'timesheets' | 'commercial' | 'attendance';
type TimesheetDecision = 'branch_checked' | 'approved' | 'rejected';
const TABS: TimesheetTab[] = ['timesheets', 'commercial', 'attendance'];

interface TimesheetRow {
  id: string;
  organization_id?: string;
  staff_id: string;
  shift_id?: string | null;
  period_start: string;
  period_end: string;
  scheduled_hours: number | null;
  actual_hours: number | null;
  overtime_hours?: number | null;
  adjustment_hours: number | null;
  work_derived_hours: number | null;
  work_summary?: unknown;
  status: string;
  pay_code_override?: string | null;
  hourly_rate_override?: number | null;
  review_notes?: string | null;
  submitted_at: string | null;
  payroll_export_batch_id?: string | null;
  revision?: number;
  shift?: { service_type: string | null } | null;
}

interface CommercialReadinessRow {
  slot_id: string;
  pay_status: string;
  billing_status: string;
  quote_status: string;
  geofence_status: string;
  cost_centre_status: string;
  work_unit_name: string | null;
  work_unit_type: string | null;
  service_type: string | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  linked_shift_id: string | null;
  staff_id: string | null;
  staff_name: string | null;
  service_agreement_name: string | null;
  client_organization_id: string | null;
  site_id: string | null;
}

type ReadinessDimension = 'pay' | 'billing' | 'quote' | 'geofence' | 'cost_centre';

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
  officer_user_id: string | null;
  service_type: string;
  scheduled_start: string;
  scheduled_end: string;
  actual_start: string | null;
  actual_end: string | null;
  status: string;
  updated_at: string;
}

interface EffectivePay { pay_code: string | null; hourly_rate: number | null }

const READY_STATES = new Set(['ready', 'source_verified', 'not_applicable', 'accepted', 'verified']);
const DIMENSIONS: { key: ReadinessDimension; label: string; field: keyof CommercialReadinessRow }[] = [
  { key: 'pay', label: 'Pay', field: 'pay_status' },
  { key: 'billing', label: 'Billing', field: 'billing_status' },
  { key: 'quote', label: 'Quote', field: 'quote_status' },
  { key: 'geofence', label: 'Geofence', field: 'geofence_status' },
  { key: 'cost_centre', label: 'Cost centre', field: 'cost_centre_status' },
];
// Mirrors shifts_status_check; PostgREST cannot expose CHECK values.
const SHIFT_STATUSES = ['scheduled', 'published', 'accepted', 'declined', 'in_progress', 'completed', 'missed', 'cancelled'];
const EDITABLE_TIMESHEET = new Set(['submitted', 'branch_checked']);
const MAX_WINDOW_DAYS = 62;

const isoDate = (date: Date) => date.toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' });
const nzDateInput = (iso: string | null | undefined) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
};
const fromNzDateInput = (value: string) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const when = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—';
const timeOnly = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleTimeString('en-NZ', { hour: 'numeric', minute: '2-digit' }) : '';
const dayText = (value: string) => new Date(`${value}T00:00:00`).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' });
const hours = (value: number | null | undefined) => value === null || value === undefined ? '—' : Number(value).toFixed(2);
const statusBadge = (status: string) => {
  const map: Record<string, string> = { draft: 'status-draft', submitted: 'status-submitted', branch_checked: 'status-branch', approved: 'status-approved', rejected: 'status-rejected', paid: 'status-paid' };
  return `status-badge ${map[status] ?? 'status-draft'}`;
};
const decisionLabel = (decision: TimesheetDecision) => ({ branch_checked: 'Branch check', approved: 'Approval', rejected: 'Rejection' }[decision]);
const readinessClass = (status: string) => READY_STATES.has(status) ? 'ok' : status === 'mapped_unverified' || status === 'pending_materialization' ? 'mapped_unverified' : 'missing';
const windowDays = (from: string, to: string) => Math.round((new Date(`${to}T00:00:00`).getTime() - new Date(`${from}T00:00:00`).getTime()) / 86400000) + 1;

const TimesheetsPage: React.FC = () => {
  const { profile, operatingOrganizationId, operatingOrganizations } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const params = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const homeOrganizationId = profile?.organizationId ?? null;
  const branchId = operatingOrganizationId ?? homeOrganizationId;
  const workingInBranch = !!operatingOrganizationId && operatingOrganizationId !== homeOrganizationId;
  const isAdmin = ['grand_master', 'master', 'admin', 'admin_officer'].includes(profile?.role ?? '');
  const branchName = operatingOrganizations.find((o) => o.organizationId === branchId)?.organizationName;

  const requestedTab = params.get('tab');
  const [tab, setTab] = useState<TimesheetTab>(TABS.includes(requestedTab as TimesheetTab) ? requestedTab as TimesheetTab : 'timesheets');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const today = useMemo(() => isoDate(new Date()), []);
  const [rangeStart, setRangeStart] = useState(() => { const d = new Date(); d.setDate(d.getDate() - 14); return isoDate(d); });
  const [rangeEnd, setRangeEnd] = useState(today);

  const [timesheets, setTimesheets] = useState<TimesheetRow[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [saving, setSaving] = useState(false);
  const [editingTimesheet, setEditingTimesheet] = useState<TimesheetRow | null>(null);
  const [rejecting, setRejecting] = useState<{ row: TimesheetRow; notes: string } | null>(null);
  const [editForm, setEditForm] = useState({ actualHours: '', overtimeHours: '', payCode: '', hourlyRate: '', reason: '' });
  const [effectivePay, setEffectivePay] = useState<EffectivePay | null>(null);
  const [payCodes, setPayCodes] = useState<PayCode[]>([]);
  const [payRequestId, setPayRequestId] = useState(() => crypto.randomUUID());

  const [commercialRows, setCommercialRows] = useState<CommercialReadinessRow[]>([]);
  const [commercialFilter, setCommercialFilter] = useState<'exceptions' | 'all' | ReadinessDimension>('exceptions');

  const [attendanceRows, setAttendanceRows] = useState<AttendanceExceptionRow[]>([]);
  const [attendanceGrace, setAttendanceGrace] = useState(15);
  const [editingShift, setEditingShift] = useState<ShiftRecord | null>(null);
  const [services, setServices] = useState<ServiceCode[]>([]);
  const [shiftForm, setShiftForm] = useState({ scheduledStart: '', scheduledEnd: '', actualStart: '', actualEnd: '', serviceType: '', status: '', reason: '' });

  const generation = useRef(0);
  const days = windowDays(rangeStart, rangeEnd);
  const rangeProblem = rangeEnd < rangeStart ? 'The end date is before the start date.' : tab !== 'timesheets' && days > MAX_WINDOW_DAYS ? `Choose ${MAX_WINDOW_DAYS} days or fewer for readiness and attendance.` : null;

  const setQuery = useCallback((updates: Record<string, string | null>) => {
    const next = new URLSearchParams(location.search);
    Object.entries(updates).forEach(([key, value]) => { if (value) next.set(key, value); else next.delete(key); });
    navigate({ pathname: location.pathname, search: next.toString() ? `?${next.toString()}` : '' }, { replace: true });
  }, [location.pathname, location.search, navigate]);

  const chooseTab = (next: TimesheetTab) => { setTab(next); setQuery({ tab: next === 'timesheets' ? null : next }); };

  const resolveNames = useCallback(async (staffIds: string[], userIds: string[]) => {
    const staff = [...new Set(staffIds.filter(Boolean))];
    const users = new Set(userIds.filter(Boolean));
    const staffToUser: Record<string, string> = {};
    if (staff.length) {
      const { data } = await supabase.from('staff_profiles').select('id,user_id,employee_number').in('id', staff);
      (data ?? []).forEach((row) => { staffToUser[row.id] = row.user_id ?? row.id; users.add(row.user_id ?? row.id); });
      staff.forEach((id) => { if (!staffToUser[id]) { staffToUser[id] = id; users.add(id); } });
    }
    if (!users.size) return;
    const { data } = await supabase.from('user_profiles').select('id,display_name,email').in('id', [...users]);
    const byUser: Record<string, string> = {};
    (data ?? []).forEach((row) => { byUser[row.id] = row.display_name || row.email || 'Unnamed person'; });
    setNames((current) => {
      const next = { ...current };
      Object.entries(staffToUser).forEach(([staffId, userId]) => { if (byUser[userId]) next[staffId] = byUser[userId]; });
      Object.entries(byUser).forEach(([userId, name]) => { next[userId] = name; });
      return next;
    });
  }, []);

  const loadTimesheets = useCallback(async () => {
    if (!homeOrganizationId || rangeEnd < rangeStart) return;
    const version = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      let rows: TimesheetRow[];
      if (workingInBranch && branchId) {
        const { data, error: rpcError } = await supabase.rpc('get_branch_timesheet_queue', { p_operating_organization_id: branchId, p_from: rangeStart, p_to: rangeEnd });
        if (rpcError) throw rpcError;
        rows = (data as TimesheetRow[] | null) ?? [];
      } else {
        const { data, error: dbError } = await supabase.from('timesheets')
          .select('id,organization_id,staff_id,shift_id,period_start,period_end,scheduled_hours,actual_hours,overtime_hours,adjustment_hours,work_derived_hours,work_summary,status,pay_code_override,hourly_rate_override,review_notes,submitted_at,payroll_export_batch_id,revision,shift:shifts(service_type)')
          .eq('organization_id', homeOrganizationId)
          .lte('period_start', rangeEnd)
          .gte('period_end', rangeStart)
          .order('period_start', { ascending: false });
        if (dbError) throw dbError;
        rows = (data as unknown as TimesheetRow[] | null) ?? [];
      }
      if (version !== generation.current) return;
      setTimesheets(rows);
      await resolveNames(rows.map((r) => r.staff_id), []);
    } catch (err) {
      if (version === generation.current) setError(err instanceof Error ? err.message : 'Timesheets could not be loaded.');
    } finally {
      if (version === generation.current) setLoading(false);
    }
  }, [homeOrganizationId, workingInBranch, branchId, rangeStart, rangeEnd, resolveNames]);

  const loadCommercial = useCallback(async () => {
    if (!branchId || rangeProblem) return;
    setLoading(true);
    setError(null);
    try {
      const { data, error: rpcError } = await supabase.rpc('get_roster_commercial_readiness', {
        p_organization_id: branchId,
        p_from: new Date(`${rangeStart}T00:00:00`).toISOString(),
        p_to: new Date(`${rangeEnd}T23:59:59`).toISOString(),
      });
      if (rpcError) throw rpcError;
      setCommercialRows((data as CommercialReadinessRow[] | null) ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Commercial readiness could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [branchId, rangeStart, rangeEnd, rangeProblem]);

  const loadAttendance = useCallback(async () => {
    if (!branchId || rangeProblem) return;
    setLoading(true);
    setError(null);
    try {
      const { data, error: rpcError } = await supabase.rpc('get_roster_attendance_exceptions', {
        p_organization_id: branchId,
        p_grace_minutes: attendanceGrace,
        p_from: new Date(`${rangeStart}T00:00:00`).toISOString(),
        p_to: new Date(`${rangeEnd}T23:59:59`).toISOString(),
      });
      if (rpcError) throw rpcError;
      const rows = (data as AttendanceExceptionRow[] | null) ?? [];
      setAttendanceRows(rows);
      await resolveNames([], rows.map((r) => r.officer_user_id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Attendance exceptions could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [branchId, rangeStart, rangeEnd, attendanceGrace, rangeProblem, resolveNames]);

  const reload = tab === 'timesheets' ? loadTimesheets : tab === 'commercial' ? loadCommercial : loadAttendance;

  useEffect(() => { void reload(); }, [reload]);

  const openShiftEdit = useCallback(async (shiftId: string) => {
    setError(null);
    const { data, error: dbError } = await supabase.from('shifts')
      .select('id,organization_id,officer_user_id,service_type,scheduled_start,scheduled_end,actual_start,actual_end,status,updated_at')
      .eq('id', shiftId).maybeSingle();
    if (dbError || !data) { setError(dbError?.message ?? 'That shift could not be found or you cannot edit it.'); return; }
    const shift = data as ShiftRecord;
    setEditingShift(shift);
    setShiftForm({ scheduledStart: nzDateInput(shift.scheduled_start), scheduledEnd: nzDateInput(shift.scheduled_end), actualStart: nzDateInput(shift.actual_start), actualEnd: nzDateInput(shift.actual_end), serviceType: shift.service_type, status: shift.status, reason: '' });
    if (shift.officer_user_id) void resolveNames([], [shift.officer_user_id]);
    loadServiceCatalog(shift.organization_id).then(setServices).catch(() => setServices([]));
  }, [resolveNames]);

  const requestedShift = params.get('shift');
  useEffect(() => { if (requestedShift && isAdmin) void openShiftEdit(requestedShift); }, [isAdmin, openShiftEdit, requestedShift]);

  const closeShiftEdit = () => { setEditingShift(null); if (requestedShift) setQuery({ shift: null }); };

  const filteredTimesheets = useMemo(() => {
    let rows = timesheets;
    if (statusFilter !== 'all') rows = rows.filter((r) => r.status === statusFilter);
    const q = search.trim().toLowerCase();
    if (q) rows = rows.filter((r) => [names[r.staff_id], r.shift?.service_type, plainWords(r.status)].some((value) => value?.toLowerCase().includes(q)));
    return rows;
  }, [timesheets, statusFilter, search, names]);

  const statusOptions = useMemo(() => [...new Set(timesheets.map((r) => r.status))].sort(), [timesheets]);

  const filteredCommercial = useMemo(() => commercialRows.filter((row) => {
    if (commercialFilter === 'all') return true;
    if (commercialFilter === 'exceptions') return DIMENSIONS.some((d) => !READY_STATES.has(String(row[d.field])));
    const dimension = DIMENSIONS.find((d) => d.key === commercialFilter);
    return dimension ? !READY_STATES.has(String(row[dimension.field])) : true;
  }), [commercialRows, commercialFilter]);

  const exceptionCounts = useMemo(() => Object.fromEntries(DIMENSIONS.map((d) => [d.key, commercialRows.filter((row) => !READY_STATES.has(String(row[d.field]))).length])) as Record<ReadinessDimension, number>, [commercialRows]);

  const handleReview = async (item: TimesheetRow, decision: TimesheetDecision, notes?: string) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = workingInBranch && branchId
        ? await supabase.rpc('review_branch_timesheet', { p_operating_organization_id: branchId, p_timesheet_id: item.id, p_expected_status: item.status, p_decision: decision, p_review_notes: notes ?? null })
        : await supabase.rpc('review_timesheet', { p_timesheet_id: item.id, p_expected_status: item.status, p_decision: decision, p_review_notes: notes ?? null });
      if (result.error) throw result.error;
      setNotice(`${decisionLabel(decision)} recorded for ${names[item.staff_id] ?? 'this timesheet'}.`);
      setRejecting(null);
      await loadTimesheets();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The review could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const openTimesheetEdit = async (item: TimesheetRow) => {
    setEditingTimesheet(item);
    setEffectivePay(null);
    setPayRequestId(crypto.randomUUID());
    setEditForm({
      actualHours: item.actual_hours === null ? '' : String(item.actual_hours),
      overtimeHours: String(item.overtime_hours ?? 0),
      payCode: item.pay_code_override ?? '',
      hourlyRate: item.hourly_rate_override === null || item.hourly_rate_override === undefined ? '' : String(item.hourly_rate_override),
      reason: '',
    });
    if (workingInBranch || !item.organization_id) return;
    const [pay, codes] = await Promise.all([
      supabase.rpc('timesheet_effective_pay', { p_timesheet_id: item.id }),
      loadPayCodes(item.organization_id).catch(() => [] as PayCode[]),
    ]);
    const resolved = (Array.isArray(pay.data) ? pay.data[0] : pay.data) as EffectivePay | null;
    setEffectivePay(resolved ?? { pay_code: null, hourly_rate: null });
    setPayCodes(codes);
  };

  const submitTimesheetCorrection = async (event: React.FormEvent) => {
    event.preventDefault();
    const sheet = editingTimesheet;
    if (!sheet) return;
    const actual = Number(editForm.actualHours);
    const overtime = Number(editForm.overtimeHours || 0);
    const hoursChanged = actual !== Number(sheet.actual_hours ?? NaN) || overtime !== Number(sheet.overtime_hours ?? 0);
    const rate = editForm.hourlyRate.trim() === '' ? null : Number(editForm.hourlyRate);
    const payChanged = !workingInBranch && ((editForm.payCode || null) !== (sheet.pay_code_override ?? null) || rate !== (sheet.hourly_rate_override ?? null));
    if (!hoursChanged && !payChanged) { setError('Nothing has changed on this timesheet.'); return; }
    if (Number.isNaN(actual) || actual < 0 || Number.isNaN(overtime) || overtime < 0 || overtime > actual) { setError('Overtime cannot be more than the worked hours, and neither can be negative.'); return; }
    if (rate !== null && (Number.isNaN(rate) || rate < 0)) { setError('The hourly rate must be zero or more.'); return; }
    setSaving(true);
    setError(null);
    try {
      let revision = sheet.revision ?? 1;
      if (hoursChanged) {
        const { data, error: rpcError } = await supabase.rpc('correct_timesheet_hours', { p_timesheet_id: sheet.id, p_expected_status: sheet.status, p_actual_hours: actual, p_overtime_hours: overtime, p_reason: editForm.reason.trim() });
        if (rpcError) throw rpcError;
        const updated = (Array.isArray(data) ? data[0] : data) as TimesheetRow | null;
        revision = updated?.revision ?? revision;
      }
      if (payChanged) {
        const { error: payError } = await supabase.rpc('correct_timesheet_pay', { p_client_request_id: payRequestId, p_timesheet_id: sheet.id, p_expected_revision: revision, p_pay_code: editForm.payCode || null, p_hourly_rate: rate, p_reason: editForm.reason.trim() });
        if (payError) throw payError;
      }
      setNotice(`Timesheet for ${names[sheet.staff_id] ?? 'this person'} corrected. It now needs review again.`);
      setEditingTimesheet(null);
      await loadTimesheets();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The correction could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const submitShiftEdit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editingShift) return;
    if (shiftForm.scheduledEnd <= shiftForm.scheduledStart) { setError('The scheduled end must be after the start.'); return; }
    if (shiftForm.actualStart && shiftForm.actualEnd && shiftForm.actualEnd <= shiftForm.actualStart) { setError('The actual finish must be after the actual start.'); return; }
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
        p_reason: shiftForm.reason.trim(),
      });
      if (rpcError) throw rpcError;
      setNotice('Shift record updated.');
      closeShiftEdit();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The shift could not be updated.');
    } finally {
      setSaving(false);
    }
  };

  const acknowledgeAttendance = async (row: AttendanceExceptionRow) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const { error: rpcError } = await supabase.rpc('acknowledge_roster_attendance_exception', { p_shift_id: row.shift_id, p_exception_type: row.exception_type, p_notes: 'Acknowledged from timesheet review' });
      if (rpcError) throw rpcError;
      setNotice('Attendance exception acknowledged.');
      await loadAttendance();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The acknowledgement could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const fixLink = (row: CommercialReadinessRow, dimension: ReadinessDimension): { label: string; to: string } | null => {
    const status = String(row[DIMENSIONS.find((d) => d.key === dimension)!.field]);
    if (READY_STATES.has(status)) return null;
    if (status === 'pending_materialization') return { label: 'Open roster', to: '/admin/roster' };
    if (status === 'missing_attribution') return { label: 'Link stops to agreement', to: '/admin/roster' };
    if (dimension === 'pay') return row.staff_id
      ? { label: 'Set pay rate', to: `/admin/people-hr?profile=${row.staff_id}&profileTab=employment${row.service_type ? `&payService=${encodeURIComponent(row.service_type)}` : ''}` }
      : { label: 'Assign staff', to: '/admin/roster' };
    if (dimension === 'billing' || dimension === 'quote') return { label: status === 'missing_contract' ? 'Add agreement' : dimension === 'quote' ? 'Add quote' : 'Set charge rate', to: row.client_organization_id ? `/admin/crm?account=${row.client_organization_id}` : '/admin/crm' };
    if (dimension === 'geofence') return { label: status === 'missing' ? 'Draw boundary' : 'Verify boundary', to: row.site_id ? `/admin/site-360?site=${row.site_id}` : '/admin/sites' };
    return { label: 'Set cost centre', to: '/admin/roster-targets' };
  };

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(t);
  }, [notice]);

  const editable = editingTimesheet ? !workingInBranch && EDITABLE_TIMESHEET.has(editingTimesheet.status) && !editingTimesheet.payroll_export_batch_id : false;
  const staffLink = (staffId: string) => `/admin/people-hr?profile=${staffId}&profileTab=employment`;

  return (
    <div className="page-container timesheets-page">
      <header className="page-header">
        <button type="button" className="icon-btn back-btn" onClick={() => navigate('/admin/roster')} aria-label="Back to rosters"><ArrowLeft size={18} /></button>
        <div>
          <h1>Timesheets & approvals</h1>
          <p className="subtitle">{workingInBranch ? `Branch review · ${branchName ?? 'operating branch'}` : 'Employer payroll review'}</p>
        </div>
      </header>

      <nav className="timesheets-tabs" aria-label="Timesheets sections">
        <button type="button" className={tab === 'timesheets' ? 'active' : ''} aria-current={tab === 'timesheets' ? 'page' : undefined} onClick={() => chooseTab('timesheets')}><Clock3 size={16} /> Timesheets</button>
        <button type="button" className={tab === 'commercial' ? 'active' : ''} aria-current={tab === 'commercial' ? 'page' : undefined} onClick={() => chooseTab('commercial')}><DollarSign size={16} /> Commercial readiness</button>
        <button type="button" className={tab === 'attendance' ? 'active' : ''} aria-current={tab === 'attendance' ? 'page' : undefined} onClick={() => chooseTab('attendance')}><AlertTriangle size={16} /> Attendance exceptions</button>
      </nav>

      {(error || notice) && (
        <div className={`timesheets-alert ${error ? 'error' : 'notice'}`} role={error ? 'alert' : 'status'}>
          {error ? <XCircle size={18} /> : <CheckCircle2 size={18} />}
          <span>{error ?? notice}</span>
          <button type="button" onClick={() => { setError(null); setNotice(null); }} aria-label="Dismiss"><X size={14} /></button>
        </div>
      )}

      <section className="timesheets-toolbar">
        <label className="date-field"><CalendarDays size={14} /><span>From</span><input type="date" value={rangeStart} max={rangeEnd} onChange={(e) => setRangeStart(e.target.value)} /></label>
        <label className="date-field"><CalendarDays size={14} /><span>To</span><input type="date" value={rangeEnd} min={rangeStart} onChange={(e) => setRangeEnd(e.target.value)} /></label>
        <button type="button" className="btn btn-secondary" onClick={() => { setRangeStart(today); setRangeEnd(today); }}>Today</button>
        <button type="button" className="btn btn-secondary" onClick={() => void reload()} disabled={loading || !!rangeProblem}><RefreshCw size={14} className={loading ? 'spin' : ''} /> Refresh</button>
        {rangeProblem && <span className="timesheets-range-warning" role="status">{rangeProblem}</span>}
      </section>

      {tab === 'timesheets' && (
        <section className="timesheets-section">
          <div className="timesheets-filters">
            <div className="search-field"><Search size={14} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search staff, service, status…" aria-label="Search timesheets" /></div>
            <label className="filter-field"><Filter size={14} />
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Timesheet status">
                <option value="all">All statuses ({timesheets.length})</option>
                {statusOptions.map((status) => <option key={status} value={status}>{plainWords(status)} ({timesheets.filter((r) => r.status === status).length})</option>)}
              </select>
            </label>
          </div>

          {loading && timesheets.length === 0 ? <div className="timesheets-empty">Loading timesheets…</div>
            : filteredTimesheets.length === 0 ? (
              <div className="timesheets-empty">
                <strong>No timesheets in this period</strong>
                <p>A timesheet appears here once an officer ends a shift and submits it. To fix a shift that was never closed, open Attendance exceptions and edit the shift.</p>
              </div>
            ) : (
              <div className="reports-table-wrapper">
                <table className="reports-table timesheets-table">
                  <caption className="sr-only">Timesheet reconciliation and approval queue</caption>
                  <thead><tr><th scope="col">Staff</th><th scope="col">Period</th><th scope="col">Service</th><th scope="col">Scheduled</th><th scope="col">Worked</th><th scope="col">Overtime</th><th scope="col">Adjustment</th><th scope="col">Pay</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead>
                  <tbody>
                    {filteredTimesheets.map((row) => (
                      <tr key={row.id} className={timesheetSummaryMismatchReasons(row.work_summary).length ? 'timesheet-mismatch' : undefined}>
                        <td>{isAdmin ? <button type="button" className="link-button" onClick={() => navigate(staffLink(row.staff_id))} title="Open staff profile, employment and pay">{names[row.staff_id] ?? 'Staff member'}</button> : names[row.staff_id] ?? 'Staff member'}</td>
                        <td>{row.period_start === row.period_end ? dayText(row.period_start) : `${dayText(row.period_start)} – ${dayText(row.period_end)}`}<small className="timesheet-mismatch-note">{timesheetSummaryMismatchReasons(row.work_summary).join('; ')}</small></td>
                        <td>{row.shift?.service_type ? serviceLabel(row.shift.service_type) : '—'}</td>
                        <td>{hours(row.scheduled_hours)}</td>
                        <td>{hours(row.actual_hours)}</td>
                        <td>{hours(row.overtime_hours)}</td>
                        <td>{hours(row.adjustment_hours)}</td>
                        <td>{row.pay_code_override || row.hourly_rate_override != null ? <span title="Pay override on this timesheet only">{row.pay_code_override ?? 'Rule code'}{row.hourly_rate_override != null ? ` · $${Number(row.hourly_rate_override).toFixed(2)}` : ''}</span> : 'From pay rate'}</td>
                        <td><span className={statusBadge(row.status)}>{plainWords(row.status)}</span></td>
                        <td className="row-actions">
                          {isAdmin && <button type="button" className="icon-btn" title={EDITABLE_TIMESHEET.has(row.status) ? 'Correct timesheet' : 'View timesheet'} aria-label={`Open timesheet for ${names[row.staff_id] ?? 'staff member'}`} onClick={() => void openTimesheetEdit(row)}><Edit3 size={16} /></button>}
                          {row.status === 'submitted' && workingInBranch && <button type="button" className="btn btn-sm btn-secondary" onClick={() => void handleReview(row, 'branch_checked')} disabled={saving}><ShieldCheck size={14} /> Branch check</button>}
                          {!workingInBranch && isAdmin && EDITABLE_TIMESHEET.has(row.status) && <button type="button" className="btn btn-sm btn-primary" onClick={() => void handleReview(row, 'approved')} disabled={saving}><CheckCircle2 size={14} /> Approve</button>}
                          {isAdmin && (workingInBranch ? row.status === 'submitted' : EDITABLE_TIMESHEET.has(row.status)) && <button type="button" className="btn btn-sm btn-danger" onClick={() => setRejecting({ row, notes: '' })} disabled={saving}><XCircle size={14} /> {workingInBranch ? 'Return' : 'Reject'}</button>}
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
            <label className="filter-field"><Filter size={14} />
              <select value={commercialFilter} onChange={(e) => setCommercialFilter(e.target.value as typeof commercialFilter)} aria-label="Readiness filter">
                <option value="exceptions">Needs action ({commercialRows.filter((row) => DIMENSIONS.some((d) => !READY_STATES.has(String(row[d.field])))).length})</option>
                <option value="all">All roster slots ({commercialRows.length})</option>
                {DIMENSIONS.map((d) => <option key={d.key} value={d.key}>{d.label} gaps ({exceptionCounts[d.key]})</option>)}
              </select>
            </label>
          </div>

          {loading && commercialRows.length === 0 ? <div className="timesheets-empty">Loading commercial readiness…</div>
            : filteredCommercial.length === 0 ? <div className="timesheets-empty"><strong>Nothing needs action</strong><p>Roster slots in this period have pay, billing, quote, geofence and cost centre coverage.</p></div>
            : (
              <div className="reports-table-wrapper">
                <table className="reports-table commercial-table">
                  <caption className="sr-only">Roster slots and their commercial readiness</caption>
                  <thead><tr><th scope="col">Roster slot</th>{DIMENSIONS.map((d) => <th scope="col" key={d.key}>{d.label}</th>)}</tr></thead>
                  <tbody>
                    {filteredCommercial.map((row) => (
                      <tr key={row.slot_id}>
                        <td className="timesheet-ref">
                          <strong>{row.work_unit_name ?? 'Unnamed work unit'}</strong>
                          <small>{when(row.scheduled_start)}{row.scheduled_end ? ` – ${timeOnly(row.scheduled_end)}` : ''}</small>
                          <small>{row.staff_name ?? 'No staff assigned'}{row.service_agreement_name ? ` · ${row.service_agreement_name}` : ''}</small>
                        </td>
                        {DIMENSIONS.map((d) => {
                          const status = String(row[d.field]);
                          const fix = fixLink(row, d.key);
                          return <td key={d.key}>
                            <span className={`readiness-cell ${readinessClass(status)}`}>{plainWords(status)}</span>
                            {fix && <button type="button" className="readiness-fix" onClick={() => navigate(fix.to)}>{fix.label} <ExternalLink size={12} /></button>}
                          </td>;
                        })}
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
            <label className="filter-field"><Clock3 size={14} /><span>Grace minutes</span><input type="number" min="0" max="240" value={attendanceGrace} onChange={(e) => setAttendanceGrace(Math.max(0, parseInt(e.target.value, 10) || 0))} /></label>
          </div>

          {loading && attendanceRows.length === 0 ? <div className="timesheets-empty">Loading attendance exceptions…</div>
            : attendanceRows.length === 0 ? <div className="timesheets-empty"><strong>No attendance exceptions</strong><p>All shifts in this window are on time or already acknowledged.</p></div>
            : (
              <div className="reports-table-wrapper">
                <table className="reports-table attendance-table">
                  <caption className="sr-only">Shifts that started or finished late, or never closed</caption>
                  <thead><tr><th scope="col">Officer</th><th scope="col">Service</th><th scope="col">Scheduled</th><th scope="col">Status</th><th scope="col">Exception</th><th scope="col">Overdue</th><th scope="col">Actions</th></tr></thead>
                  <tbody>
                    {attendanceRows.map((row) => (
                      <tr key={`${row.shift_id}-${row.exception_type}`}>
                        <td>{names[row.officer_user_id] ?? 'Officer'}</td>
                        <td>{serviceLabel(row.service_type)}</td>
                        <td>{when(row.scheduled_start)} – {timeOnly(row.scheduled_end)}</td>
                        <td><span className={statusBadge(row.status)}>{plainWords(row.status)}</span></td>
                        <td>{plainWords(row.exception_type)}</td>
                        <td>{row.minutes_overdue} min</td>
                        <td className="row-actions">
                          {isAdmin && <button type="button" className="btn btn-sm btn-secondary" onClick={() => { setQuery({ shift: row.shift_id }); }}><Edit3 size={14} /> Edit shift</button>}
                          <button type="button" className="btn btn-sm btn-primary" onClick={() => void acknowledgeAttendance(row)} disabled={saving}><CheckCircle2 size={14} /> Acknowledge</button>
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
                <span>{editable ? 'Timesheet correction' : 'Timesheet'}</span>
                <h2 id="timesheet-edit-title">{names[editingTimesheet.staff_id] ?? 'Staff member'} · {dayText(editingTimesheet.period_start)}</h2>
              </div>
              <button type="button" onClick={() => setEditingTimesheet(null)} aria-label="Close"><X size={18} /></button>
            </header>
            <div className="dialog-body">
              {!editable && <p className="timesheet-dialog-note">{workingInBranch ? 'Branch reviewers check or return timesheets; the employer payroll team makes corrections.' : `Only submitted or branch-checked timesheets that are not yet exported can be corrected. This one is ${plainWords(editingTimesheet.status).toLowerCase()}.`}</p>}
              <div className="form-row">
                <label><span>Worked hours</span><input type="number" min="0" max="744" step="0.01" value={editForm.actualHours} disabled={!editable} onChange={(e) => setEditForm({ ...editForm, actualHours: e.target.value })} required /></label>
                <label><span>Of which overtime</span><input type="number" min="0" step="0.01" value={editForm.overtimeHours} disabled={!editable} onChange={(e) => setEditForm({ ...editForm, overtimeHours: e.target.value })} required /></label>
                <label><span>Adjustment (worked − recorded work)</span><input value={editForm.actualHours === '' ? '—' : (Number(editForm.actualHours) - Number(editingTimesheet.work_derived_hours ?? 0)).toFixed(2)} readOnly /></label>
              </div>
              {!workingInBranch && <fieldset className="timesheet-dialog-group">
                <legend>Pay for this timesheet only</legend>
                <p>{effectivePay ? effectivePay.pay_code || effectivePay.hourly_rate != null ? `Current pay: ${effectivePay.pay_code ?? 'no code'} at ${effectivePay.hourly_rate != null ? `$${Number(effectivePay.hourly_rate).toFixed(2)}/h` : 'no rate'}.` : 'No pay rate applies to this timesheet yet.' : 'Checking the pay rate…'} To change the ongoing rate, use <button type="button" className="link-button" onClick={() => navigate(staffLink(editingTimesheet.staff_id))}>Employment &amp; pay</button>.</p>
                <div className="form-row">
                  <PayCodeSelect label="Pay code override" codes={payCodes} value={editForm.payCode} disabled={!editable} emptyLabel="Use the pay rate's code" canCreate={isAdmin && editingTimesheet.organization_id === homeOrganizationId}
                    onChange={(code) => setEditForm((current) => ({ ...current, payCode: code }))} onCreated={(code) => setPayCodes((current) => [...current, code])} />
                  <label><span>Hourly rate override (NZD)</span><input type="number" min="0" step="0.01" placeholder="Use the pay rate" value={editForm.hourlyRate} disabled={!editable} onChange={(e) => setEditForm({ ...editForm, hourlyRate: e.target.value })} /></label>
                </div>
              </fieldset>}
              {editingTimesheet.shift_id && <p className="timesheet-dialog-note">Wrong start, finish, stops or service? <button type="button" className="link-button" onClick={() => { const id = editingTimesheet.shift_id!; setEditingTimesheet(null); setTab('attendance'); setQuery({ tab: 'attendance', shift: id }); }}>Edit the shift record</button>{editingTimesheet.shift?.service_type ? ` (${serviceLabel(editingTimesheet.shift.service_type)})` : ''}.</p>}
              {editable && <label><span>Reason for correction (required, kept in the audit trail)</span><textarea value={editForm.reason} onChange={(e) => setEditForm({ ...editForm, reason: e.target.value })} required minLength={5} /></label>}
            </div>
            <footer>
              <button type="button" className="btn btn-secondary" onClick={() => setEditingTimesheet(null)}>{editable ? 'Cancel' : 'Close'}</button>
              {editable && <button type="submit" className="btn btn-primary" disabled={saving || editForm.reason.trim().length < 5}><Save size={16} /> {saving ? 'Saving…' : 'Save correction'}</button>}
            </footer>
          </form>
        </div>
      )}

      {rejecting && (
        <div className="timesheet-dialog-backdrop">
          <form className="timesheet-dialog" role="dialog" aria-modal="true" aria-labelledby="timesheet-reject-title" onSubmit={(event) => { event.preventDefault(); void handleReview(rejecting.row, 'rejected', rejecting.notes.trim()); }}>
            <header>
              <div><span>{workingInBranch ? 'Return for correction' : 'Reject timesheet'}</span><h2 id="timesheet-reject-title">{names[rejecting.row.staff_id] ?? 'Staff member'} · {dayText(rejecting.row.period_start)}</h2></div>
              <button type="button" onClick={() => setRejecting(null)} aria-label="Close"><X size={18} /></button>
            </header>
            <div className="dialog-body">
              <p className="timesheet-dialog-note">The officer is notified and must correct and resubmit. If you can fix it yourself, cancel and use Correct timesheet instead.</p>
              <label><span>What needs to change (sent to the officer)</span><textarea value={rejecting.notes} onChange={(e) => setRejecting({ ...rejecting, notes: e.target.value })} required minLength={5} autoFocus /></label>
            </div>
            <footer>
              <button type="button" className="btn btn-secondary" onClick={() => setRejecting(null)}>Cancel</button>
              <button type="submit" className="btn btn-danger" disabled={saving || rejecting.notes.trim().length < 5}><XCircle size={16} /> {saving ? 'Saving…' : workingInBranch ? 'Return timesheet' : 'Reject timesheet'}</button>
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
                <h2 id="shift-edit-title">{editingShift.officer_user_id ? names[editingShift.officer_user_id] ?? 'Officer' : 'Unassigned'} · {when(editingShift.scheduled_start)}</h2>
              </div>
              <button type="button" onClick={closeShiftEdit} aria-label="Close"><X size={18} /></button>
            </header>
            <div className="dialog-body">
              <div className="form-row">
                <label><span>Scheduled start</span><input type="datetime-local" value={shiftForm.scheduledStart} onChange={(e) => setShiftForm({ ...shiftForm, scheduledStart: e.target.value })} required /></label>
                <label><span>Scheduled end</span><input type="datetime-local" value={shiftForm.scheduledEnd} min={shiftForm.scheduledStart} onChange={(e) => setShiftForm({ ...shiftForm, scheduledEnd: e.target.value })} required /></label>
              </div>
              <div className="form-row">
                <label><span>Actual start</span><input type="datetime-local" value={shiftForm.actualStart} onChange={(e) => setShiftForm({ ...shiftForm, actualStart: e.target.value })} /></label>
                <label><span>Actual finish</span><input type="datetime-local" value={shiftForm.actualEnd} min={shiftForm.actualStart || undefined} onChange={(e) => setShiftForm({ ...shiftForm, actualEnd: e.target.value })} /></label>
              </div>
              <div className="form-row">
                <ServiceCodeSelect label="Service" codes={services} value={shiftForm.serviceType} required allowEmpty={false} emptyLabel="Choose a service"
                  canCreate={isAdmin} organizationId={editingShift.organization_id}
                  onChange={(code) => setShiftForm((current) => ({ ...current, serviceType: code }))}
                  onCreated={(code) => setServices((current) => [...current, code].sort((a, b) => a.name.localeCompare(b.name)))} />
                <label><span>Status</span>
                  <select value={shiftForm.status} onChange={(e) => setShiftForm({ ...shiftForm, status: e.target.value })} required>
                    {SHIFT_STATUSES.map((status) => <option key={status} value={status}>{plainWords(status)}</option>)}
                  </select>
                </label>
              </div>
              <label><span>Reason for edit (required, kept in the audit trail)</span><textarea value={shiftForm.reason} onChange={(e) => setShiftForm({ ...shiftForm, reason: e.target.value })} required minLength={5} /></label>
            </div>
            <footer>
              <button type="button" className="btn btn-secondary" onClick={closeShiftEdit}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving || shiftForm.reason.trim().length < 5}><Save size={16} /> {saving ? 'Saving…' : 'Save shift'}</button>
            </footer>
          </form>
        </div>
      )}
    </div>
  );
};

export default TimesheetsPage;
