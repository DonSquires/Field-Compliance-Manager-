/**
 * TimesheetsPage.tsx
 *
 * One page for timesheet review, approval and governed correction, plus the
 * roster commercial-readiness and attendance exceptions that block payroll and
 * invoicing. Every exception links to the record that fixes it.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, CalendarDays, CheckCircle2, Clock3, DollarSign, Edit3, ExternalLink, Filter, RefreshCw, Save, X, XCircle } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { plainWords } from '../lib/rosterWords';
import { loadServiceCatalog, serviceLabel, type ServiceCode } from '../lib/payCatalog';
import { formatHours, formatMinutes, formatMoney, shiftHoursFigures, shiftHoursTotals } from '../lib/shiftHoursTotals';
import { ServiceCodeSelect } from '../components/ServiceCodeSelect';
import { useWorkforceScope, workforceWeek } from '../lib/workforceScope';
import { ShiftHoursExportPanel, shiftHoursError } from '../components/ShiftHoursExportPanel';
import { parseShiftHoursRows, type ShiftHoursReviewRow } from '../lib/shiftHoursExport';
import { fromNzDateInput, nzDateInput } from '../lib/nzDateTime';
import './PageStyles.css';
import './TimesheetsPage.css';

type TimesheetTab = 'timesheets' | 'commercial' | 'attendance';

const TABS: TimesheetTab[] = ['timesheets', 'commercial', 'attendance'];

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

type ShiftHoursRow = ShiftHoursReviewRow;
interface ShiftHoursStaff { staff_id: string; user_id: string; display_name: string | null }
const SHIFT_HOURS_LABELS = { confirmed: 'Hours auto-confirmed', review: 'Needs review', missed: 'Missed shift', pending: 'Not finished' };

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

const MAX_WINDOW_DAYS = 62;


const when = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleString('en-NZ', { timeZone: 'Pacific/Auckland', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—';
const timeOnly = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleTimeString('en-NZ', { timeZone: 'Pacific/Auckland', hour: 'numeric', minute: '2-digit' }) : '';

const statusBadge = (status: string) => {
  const map: Record<string, string> = { draft: 'status-draft', submitted: 'status-submitted', branch_checked: 'status-branch', approved: 'status-approved', rejected: 'status-rejected', paid: 'status-paid' };
  return `status-badge ${map[status] ?? 'status-draft'}`;
};

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

  const { scope, setScope } = useWorkforceScope(profile?.id, branchId);
  const rangeStart = scope.from;
  const rangeEnd = scope.to;
  const setRangeStart = (from: string) => setScope({ ...scope, from });
  const setRangeEnd = (to: string) => setScope({ ...scope, to });

  const [shiftHoursRows, setShiftHoursRows] = useState<ShiftHoursRow[]>([]);
  const [shiftHoursStaff, setShiftHoursStaff] = useState<ShiftHoursStaff[]>([]);
  const [loadedStaffScope, setLoadedStaffScope] = useState<string | null>(null);
  const staffFilter = scope.staffId ?? 'all';
  const setStaffFilter = (staffId: string) => setScope({ ...scope,
    staffId: staffId === 'all' ? null : staffId,
    userId: shiftHoursStaff.find((staff) => staff.staff_id === staffId)?.user_id ?? null });
  const [editingHours, setEditingHours] = useState<ShiftHoursRow | null>(null);
  const [hoursForm, setHoursForm] = useState({ staffId: '', start: '', finish: '', unpaid: '0', reason: '' });
  const hoursRequest = useRef<{ fingerprint: string; id: string } | null>(null);
  const [approvalFilter, setApprovalFilter] = useState('all');
  const [selectedHours, setSelectedHours] = useState<string[]>([]);
  const [hoursReview, setHoursReview] = useState<{ rows: ShiftHoursRow[]; decision: 'approved' | 'rejected'; reason: string } | null>(null);
  const reviewRequest = useRef<{ fingerprint: string; id: string } | null>(null);
  const hoursDialog = useRef<HTMLDialogElement>(null);
  const reviewDialog = useRef<HTMLDialogElement>(null);
  const [loadedHoursScope, setLoadedHoursScope] = useState('');
  const currentHoursScope = JSON.stringify([branchId, rangeStart, rangeEnd, scope.staffId]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [saving, setSaving] = useState(false);

  const [commercialRows, setCommercialRows] = useState<CommercialReadinessRow[]>([]);
  const [commercialFilter, setCommercialFilter] = useState<'exceptions' | 'all' | ReadinessDimension>('exceptions');

  const [attendanceRows, setAttendanceRows] = useState<AttendanceExceptionRow[]>([]);
  const [attendanceGrace, setAttendanceGrace] = useState(15);
  const [editingShift, setEditingShift] = useState<ShiftRecord | null>(null);
  const [services, setServices] = useState<ServiceCode[]>([]);
  const [shiftForm, setShiftForm] = useState({ scheduledStart: '', scheduledEnd: '', actualStart: '', actualEnd: '', serviceType: '', status: '', reason: '' });

  const generation = useRef(0);
  const days = windowDays(rangeStart, rangeEnd);
  const rangeProblem = !rangeStart || !rangeEnd || !Number.isFinite(days) ? 'Choose valid start and end dates.'
    : rangeEnd < rangeStart ? 'The end date is before the start date.' : days > MAX_WINDOW_DAYS ? `Choose ${MAX_WINDOW_DAYS} days or fewer for this review.` : null;

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

  const loadShiftHours = useCallback(async () => {
    if (!branchId || rangeProblem) return;
    const version = ++generation.current;
    setLoading(true); setError(null); setSelectedHours([]);
    try {
      const [rows, staff] = await Promise.all([
        supabase.rpc('get_timesheet_shift_rows', { p_organization_id: branchId, p_from: rangeStart, p_to: rangeEnd, p_staff_id: scope.staffId }),
        supabase.rpc('get_operating_branch_roster_staff', { p_operating_organization_id: branchId }),
      ]);
      if (rows.error) throw rows.error;
      if (staff.error) throw staff.error;
      if (!Array.isArray(rows.data) || !Array.isArray(staff.data)) throw new Error('Shift hours and staff selection were not confirmed.');
      if (version !== generation.current) return;
      setShiftHoursRows(parseShiftHoursRows(rows.data));
      setLoadedHoursScope(JSON.stringify([branchId, rangeStart, rangeEnd, scope.staffId]));
      setShiftHoursStaff(staff.data as ShiftHoursStaff[]);
      setLoadedStaffScope(branchId);
    } catch (err) {
      if (version === generation.current) {
        setShiftHoursRows([]); setShiftHoursStaff([]);
        setError(shiftHoursError(err));
      }
    } finally { if (version === generation.current) setLoading(false); }
  }, [branchId, rangeProblem, rangeStart, rangeEnd, scope.staffId]);

  useEffect(() => {
    setEditingHours(null); setHoursReview(null); setSelectedHours([]);
  }, [currentHoursScope]);
  useEffect(() => {
    const dialog = hoursDialog.current;
    if (editingHours) dialog?.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, [editingHours]);
  useEffect(() => {
    const dialog = reviewDialog.current;
    if (hoursReview) dialog?.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, [hoursReview?.rows, hoursReview?.decision]);

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
      const rows = ((data as AttendanceExceptionRow[] | null) ?? []).filter((row) => !scope.userId || row.officer_user_id === scope.userId);
      setAttendanceRows(rows);
      await resolveNames([], rows.map((r) => r.officer_user_id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Attendance exceptions could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [branchId, rangeStart, rangeEnd, attendanceGrace, rangeProblem, resolveNames, scope.userId]);

  const reload = tab === 'timesheets' ? loadShiftHours : tab === 'commercial' ? loadCommercial : loadAttendance;

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

  const filteredCommercial = useMemo(() => commercialRows.filter((row) => {
    if (commercialFilter === 'all') return true;
    if (commercialFilter === 'exceptions') return DIMENSIONS.some((d) => !READY_STATES.has(String(row[d.field])));
    const dimension = DIMENSIONS.find((d) => d.key === commercialFilter);
    return dimension ? !READY_STATES.has(String(row[dimension.field])) : true;
  }), [commercialRows, commercialFilter]);

  const exceptionCounts = useMemo(() => Object.fromEntries(DIMENSIONS.map((d) => [d.key, commercialRows.filter((row) => !READY_STATES.has(String(row[d.field]))).length])) as Record<ReadinessDimension, number>, [commercialRows]);

  const openHoursEdit = (row: ShiftHoursRow) => {
    setEditingHours(row); setError(null); hoursRequest.current = null;
    setHoursForm({ staffId: row.staff_id ?? '', start: nzDateInput(row.payable_start ?? row.actual_start),
      finish: nzDateInput(row.payable_end ?? row.actual_end), unpaid: String(row.unpaid_minutes ?? 0), reason: '' });
  };

  const saveShiftHours = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editingHours || saving) return;
    setSaving(true); setError(null);
    try {
      const request = { p_shift_id: editingHours.id, p_expected_updated_at: editingHours.updated_at,
        p_expected_correction_updated_at: editingHours.correction_updated_at, p_staff_id: hoursForm.staffId,
        p_payable_start: fromNzDateInput(hoursForm.start, editingHours.payable_start ?? editingHours.actual_start),
        p_payable_end: fromNzDateInput(hoursForm.finish, editingHours.payable_end ?? editingHours.actual_end),
        p_unpaid_minutes: Number(hoursForm.unpaid), p_reason: hoursForm.reason.trim(),
        p_expected_source_revision: editingHours.source_revision };
      if (!request.p_payable_start || !request.p_payable_end || request.p_payable_end <= request.p_payable_start
        || !Number.isInteger(request.p_unpaid_minutes) || request.p_unpaid_minutes < 0
        || request.p_unpaid_minutes > (Date.parse(request.p_payable_end) - Date.parse(request.p_payable_start)) / 60000) {
        throw new Error('Enter a finish after the start and an unpaid break within the shift duration.');
      }
      const fingerprint = JSON.stringify(request);
      if (hoursRequest.current?.fingerprint !== fingerprint) hoursRequest.current = { fingerprint, id: crypto.randomUUID() };
      const { data, error: correctionError } = await supabase.rpc('correct_reviewed_timesheet_shift_hours', {
        ...request, p_client_request_id: hoursRequest.current.id,
      });
      if (correctionError) throw correctionError;
      if (!data || data.shift_id !== editingHours.id || data.staff_id !== hoursForm.staffId || data.hours_status !== 'review') {
        throw new Error('Payable correction receipt was not confirmed.');
      }
      setNotice('Payable shift hours saved for review. Recorded attendance remains unchanged.');
      setEditingHours(null); hoursRequest.current = null;
      await loadShiftHours();
    } catch (err) { setError(shiftHoursError(err)); }
    finally { setSaving(false); }
  };

  const reviewHours = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!hoursReview || saving || !branchId) return;
    const request = { p_organization_id: branchId, p_decision: hoursReview.decision, p_reason: hoursReview.reason.trim(),
      p_rows: hoursReview.rows.map((row) => ({ shift_id: row.id, source_revision: row.source_revision, review_revision: row.review_revision })) };
    const fingerprint = JSON.stringify(request);
    if (reviewRequest.current?.fingerprint !== fingerprint) reviewRequest.current = { fingerprint, id: crypto.randomUUID() };
    const requestId = reviewRequest.current.id;
    setSaving(true); setError(null);
    try {
      const { data, error: failure } = await supabase.rpc('review_shift_timesheet_hours', { ...request, p_client_request_id: requestId });
      if (failure) throw failure;
      if (!data || data.request_id !== requestId || data.decision !== request.p_decision || data.shift_count !== request.p_rows.length
        || !Array.isArray(data.shift_ids) || !request.p_rows.every((row) => data.shift_ids.includes(row.shift_id))) {
        throw new Error('Hours review receipt was not confirmed. Retry unchanged inputs to recover the receipt.');
      }
      setNotice(`${data.shift_count} shift hours ${data.decision}. No payment or invoice was created.`);
      setHoursReview(null); reviewRequest.current = null;
      await loadShiftHours();
    } catch (failure) { setError(shiftHoursError(failure)); }
    finally { setSaving(false); }
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
        p_scheduled_start: fromNzDateInput(shiftForm.scheduledStart, editingShift.scheduled_start),
        p_scheduled_end: fromNzDateInput(shiftForm.scheduledEnd, editingShift.scheduled_end),
        p_actual_start: fromNzDateInput(shiftForm.actualStart, editingShift.actual_start),
        p_actual_end: fromNzDateInput(shiftForm.actualEnd, editingShift.actual_end),
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

  const visibleShiftRows = (loadedHoursScope === currentHoursScope ? shiftHoursRows : []).filter((row) =>
    (staffFilter === 'all' || row.staff_id === staffFilter) && (statusFilter === 'all' || row.hours_status === statusFilter)
    && (approvalFilter === 'all' || row.review_status === approvalFilter)
    && (!search.trim() || [row.staff_name, row.location_name, row.client_name, row.id]
      .some((value) => value?.toLowerCase().includes(search.trim().toLowerCase()))));
  const selectedShiftRows = visibleShiftRows.filter((row) => selectedHours.includes(row.id) && row.can_edit_hours && !row.payroll_adjustment_pending);
  const shiftTotals = shiftHoursTotals(visibleShiftRows);
  const shiftCount = (count: number) => `${count} ${count === 1 ? 'shift' : 'shifts'}`;

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
        <button type="button" className="btn btn-secondary" onClick={() => setScope({ ...workforceWeek(), staffId: scope.staffId, userId: scope.userId })}>This week</button>
        <button type="button" className="btn btn-secondary" onClick={() => void reload()} disabled={loading || !!rangeProblem}><RefreshCw size={14} className={loading ? 'spin' : ''} /> Refresh</button>
        {rangeProblem && <span className="timesheets-range-warning" role="status">{rangeProblem}</span>}
      </section>

      {tab === 'timesheets' && (
        <section className="timesheets-section">
          {<>
            <div className="timesheets-filters">
              <label className="search-field">Search shifts<input aria-label="Search shifts" value={search} onChange={(event) => { setSearch(event.target.value); setSelectedHours([]); }} placeholder="Staff, location, client or reference" /></label>
              <label className="filter-field">Staff member<select aria-label="Filter shift hours by staff member" value={staffFilter} onChange={(event) => setStaffFilter(event.target.value)}>
                <option value="all">All staff</option>{(loadedStaffScope === branchId ? shiftHoursStaff : []).map((staff) => <option key={staff.staff_id} value={staff.staff_id}>{staff.display_name ?? 'Staff member'}</option>)}
              </select></label>
              <label className="filter-field">Hours approval<select aria-label="Hours approval status" value={approvalFilter} onChange={(event) => { setApprovalFilter(event.target.value); setSelectedHours([]); }}>
                <option value="all">All review states</option><option value="needs_review">Awaiting approval</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="finalised">Finalised</option>
              </select></label>
              <label className="filter-field">Hours status<select aria-label="Shift hours status" value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); setSelectedHours([]); }}>
                <option value="all">All statuses</option>{Object.entries(SHIFT_HOURS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select></label>
              {shiftHoursRows.length > 0 && <dl className="shift-hours-totals" role="group" aria-label="Totals for the shifts shown">
                <div><dt>Shifts</dt><dd>{shiftTotals.shifts}</dd></div>
                <div><dt>Rostered</dt><dd>{formatHours(shiftTotals.rosteredHours)}</dd></div>
                <div><dt>Worked</dt><dd>{formatHours(shiftTotals.workedHours)}</dd></div>
                <div><dt>Pay hours</dt><dd>{formatHours(shiftTotals.payHours)}</dd></div>
                {shiftTotals.ratesVisible && <>
                  <div><dt>Charge</dt><dd>{formatMoney(shiftTotals.chargeAmount)}{shiftTotals.missingChargeRate > 0 && <small>Charge rate missing for {shiftCount(shiftTotals.missingChargeRate)}</small>}</dd></div>
                  <div><dt>Pay</dt><dd>{formatMoney(shiftTotals.payAmount)}{shiftTotals.missingPayRate > 0 && <small>Pay rate missing for {shiftCount(shiftTotals.missingPayRate)}</small>}</dd></div>
                </>}
              </dl>}
            </div>
            <p>Shift hours are recorded automatically. Auto-confirmed means the times match; human hours approval is separate from payroll payment.</p>
            {shiftTotals.ratesVisible && <p>Pay and charge amounts above are hourly-rate references, not final payroll earnings or invoice totals.</p>}
            <div className="timesheets-filters" role="group" aria-label="Review selected shift hours">
              <button type="button" className="btn btn-secondary" disabled={loading || saving} onClick={() => setSelectedHours(visibleShiftRows.filter((row) => row.can_review_hours && row.review_status !== 'approved').slice(0, 100).map((row) => row.id))}>Select unapproved shown (max 100)</button>
              <span>{selectedShiftRows.length} selected</span>
              <button type="button" className="btn btn-primary" disabled={loading || saving || !selectedShiftRows.length || selectedShiftRows.some((row) => !row.can_review_hours)} onClick={() => { setError(null); setHoursReview({ rows: selectedShiftRows, decision: 'approved', reason: '' }); }}>Approve selected hours</button>
              <button type="button" className="btn btn-secondary" disabled={loading || saving || !selectedShiftRows.length} onClick={() => { setError(null); setHoursReview({ rows: selectedShiftRows, decision: 'rejected', reason: '' }); }}>Reject selected hours</button>
              <button type="button" className="btn btn-secondary" disabled={!selectedHours.length || saving} onClick={() => setSelectedHours([])}>Clear selection</button>
            </div>
            {loading ? <div className="timesheets-empty" role="status">Loading shift hours…</div> : shiftHoursRows.length === 0 ? <div className="timesheets-empty">{error ? 'Hours could not be verified. Use Refresh to retry.' : 'No shifts in this period.'}</div> :
              <div className="reports-table-wrapper"><table className="reports-table timesheets-table">
                <caption className="sr-only">One timesheet entry per shift. Pay hours are payable finish minus start, less the unpaid break.</caption>
                <thead><tr><th>Review selection</th><th>Staff member</th><th>Location / client</th><th>Service</th><th>Rostered start / finish</th><th>Recorded start / finish</th><th>Payable start / finish</th><th>Rostered hours</th><th>Unpaid break</th><th>Pay hours</th><th>Calculation / approval</th><th>Actions</th></tr></thead>
                <tbody>{visibleShiftRows.map((row) => { const figures = shiftHoursFigures(row); return (
                  <tr key={row.id} className={`shift-hours-${row.hours_status}`}>
                    <td><input type="checkbox" aria-label={`Select shift hours for ${row.staff_name ?? 'staff member'} at ${when(row.scheduled_start)}`} checked={selectedHours.includes(row.id)} disabled={saving || !row.can_edit_hours || row.payroll_adjustment_pending || (!selectedHours.includes(row.id) && selectedHours.length >= 100)} onChange={(event) => setSelectedHours((current) => event.target.checked ? [...current, row.id] : current.filter((id) => id !== row.id))} /></td>
                    <td>{row.staff_name ?? 'Staff identity unavailable'}</td><td>{row.location_name ?? 'Location not linked'}<small>{row.client_name ?? 'Agreement client not linked'}</small>{row.client_link_problem && <small>{row.client_link_problem}</small>}</td><td>{serviceLabel(row.service_type)}</td>
                    <td>{when(row.scheduled_start)}<br />{when(row.scheduled_end)}</td>
                    <td>{when(row.actual_start)}<br />{when(row.actual_end)}{figures.workedHours !== null && <small>Worked {formatHours(figures.workedHours)}</small>}</td>
                    <td>{when(row.payable_start)}<br />{when(row.payable_end)}</td>
                    <td>{formatHours(figures.rosteredHours)}</td>
                    <td>{formatMinutes(figures.unpaidMinutes)}<small>Recorded {Number(row.recorded_unpaid_minutes).toFixed(1)} · planned {row.planned_unpaid_minutes}</small></td>
                    <td>{formatHours(figures.payHours)}</td>
                    <td><strong>{SHIFT_HOURS_LABELS[row.hours_status]}</strong><small>Approval: {row.review_status === 'needs_review' ? 'Awaiting approval' : plainWords(row.review_status)}</small>
                      {row.manual_update && <small>Manual payable update</small>}
                      {row.review_reason && <small>Previous review: {row.review_reason}</small>}
                      {row.payroll_adjustment_pending && <small>Unallocated payroll adjustment requires reconciliation.</small>}
                      {row.hours_status === 'review' && <small>{row.correction_reason ?? [row.start_mismatch && 'Start differs', row.finish_mismatch && 'Finish differs', row.unpaid_break_mismatch && 'Unpaid break differs'].filter(Boolean).join('; ')}</small>}
                    </td>
                    <td>{row.can_edit_hours ? <button className="icon-btn" type="button" aria-label={`Edit shift hours for ${row.staff_name ?? 'staff member'}`} title="Edit payable shift hours; approval will need review again" disabled={saving} onClick={() => openHoursEdit(row)}><Edit3 size={16} /></button>
                      : <small>{row.review_status === 'finalised' ? 'Read-only: payroll finalised. An amendment is required.' : 'Employer payroll authority and an ended shift are required.'}</small>}</td>
                  </tr>); })}</tbody>
              </table></div>}
            {!loading && shiftHoursRows.length > 0 && !visibleShiftRows.length && <p role="status">No shifts match these filters. Clear the search or review filters.</p>}
            {selectedShiftRows.some((row) => !row.can_review_hours) && <p role="status">Some selected shifts need correction before approval. You can reject their incomplete hours with a reason.</p>}
            <ShiftHoursExportPanel organizationId={branchId} from={rangeStart} to={rangeEnd} staffId={scope.staffId}
              rows={visibleShiftRows} disabled={loading || saving || !!rangeProblem || !!error || loadedHoursScope !== currentHoursScope} />
          </>}
        </section>
      )}

      {editingHours && editingHours.organization_id === branchId && <dialog ref={hoursDialog} className="timesheet-dialog shift-hours-dialog" aria-labelledby="shift-hours-title" onCancel={(event) => { if (saving) event.preventDefault(); else setEditingHours(null); }}><form onSubmit={saveShiftHours}>
        <h2 id="shift-hours-title">Payable shift hours</h2>
        <p>Rostered: {when(editingHours.scheduled_start)} – {when(editingHours.scheduled_end)}</p>
        <p>Recorded: {when(editingHours.actual_start)} – {when(editingHours.actual_end)}</p>
        <label>Staff member<select aria-label="Payable staff member" required disabled={saving || editingHours.actual_start !== null || editingHours.actual_end !== null} value={hoursForm.staffId} onChange={(event) => setHoursForm({ ...hoursForm, staffId: event.target.value })}>
          <option value="">Select staff member</option>{shiftHoursStaff.map((staff) => <option key={staff.staff_id} value={staff.staff_id}>{staff.display_name ?? 'Staff member'}</option>)}
        </select></label>
        <label>Payable start<input type="datetime-local" required disabled={saving} value={hoursForm.start} onChange={(event) => setHoursForm({ ...hoursForm, start: event.target.value })} /></label>
        <label>Payable finish<input type="datetime-local" required disabled={saving} value={hoursForm.finish} onChange={(event) => setHoursForm({ ...hoursForm, finish: event.target.value })} /></label>
        <label>Unpaid break minutes<input type="number" min="0" step="1" required disabled={saving} value={hoursForm.unpaid} onChange={(event) => setHoursForm({ ...hoursForm, unpaid: event.target.value })} /></label>
        <button className="btn btn-secondary" type="button" disabled={saving} onClick={() => setHoursForm({ ...hoursForm, start: nzDateInput(editingHours.scheduled_start), finish: nzDateInput(editingHours.scheduled_end), unpaid: String(editingHours.planned_unpaid_minutes) })}><CalendarDays size={16} /> Use roster dates and times</button>
        <p>Times use Pacific/Auckland. Saving invalidates hours approval and reopens any approved, unexported payroll header. Recorded attendance stays unchanged.</p>
        <label>Reason for correction<textarea required minLength={5} maxLength={2000} disabled={saving} value={hoursForm.reason} onChange={(event) => setHoursForm({ ...hoursForm, reason: event.target.value })} /></label>
        {error && <p role="alert">{error}</p>}
        <div className="modal-actions"><button type="button" className="btn btn-secondary" disabled={saving} onClick={() => setEditingHours(null)}>Cancel</button><button type="submit" className="btn btn-primary" disabled={saving}><Save size={16} />{saving ? 'Saving…' : 'Save for review'}</button></div>
      </form></dialog>}

      {hoursReview && <dialog ref={reviewDialog} className="timesheet-dialog shift-hours-dialog" aria-labelledby="shift-review-title" onCancel={(event) => { if (saving) event.preventDefault(); else setHoursReview(null); }}><form onSubmit={reviewHours}>
        <h2 id="shift-review-title">{hoursReview.decision === 'approved' ? 'Approve shift hours' : 'Reject shift hours'}</h2>
        <p>{hoursReview.rows.length} shifts selected. Source hours review does not pay staff, approve a payroll period or issue an invoice.</p>
        <ul>{hoursReview.rows.map((row) => <li key={row.id}>{row.staff_name ?? 'Staff member'} · {row.location_name ?? 'Location not linked'} · {when(row.payable_start)} to {when(row.payable_end)} · {row.unpaid_minutes} minutes unpaid · {formatHours(shiftHoursFigures(row).payHours)}</li>)}</ul>
        <label>Reason for hours review<textarea required minLength={5} maxLength={2000} autoFocus disabled={saving} value={hoursReview.reason} onChange={(event) => setHoursReview({ ...hoursReview, reason: event.target.value })} /></label>
        {error && <p role="alert">{error}</p>}
        <div className="modal-actions"><button type="button" className="btn btn-secondary" disabled={saving} onClick={() => setHoursReview(null)}>Cancel</button><button type="submit" className="btn btn-primary" disabled={saving || hoursReview.reason.trim().length < 5}>{saving ? 'Saving...' : hoursReview.decision === 'approved' ? 'Confirm hours approval' : 'Confirm hours rejection'}</button></div>
      </form></dialog>}

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
