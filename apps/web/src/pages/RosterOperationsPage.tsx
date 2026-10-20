import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CalendarDays, ChevronLeft, ChevronRight, Clock3, Filter, Plus, RefreshCw, Search, ShieldCheck, UserCheck, Users, X } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth, type AppRole } from '../context/AuthContext';
import { moveRosterPeriod, NZ_HOLIDAY_REGIONS, nzRosterHolidays, rosterPeriod, type RosterHorizon } from '../lib/rosterCalendar';
import { contractedDaysWords, contractedHoursWords, plainWords, plural, shiftStatusLabel, slotStatusLabel, timeRange, workUnitTypeLabel } from '../lib/rosterWords';
import { credentialTypeLabel } from '../lib/credentialWords';
import { supabase } from '../lib/supabase';
import { readWorkflowContext, workflowContextQuery } from '../lib/workflowNavigation';
import { RosterTimesheetPanel } from './RosterHRPage';
import './RosterOperationsPage.css';
import './RosterCalendar.css';
import './RosterSlotActions.css';
import './RosterAvailability.css';

interface CoveragePreview { kind: 'patrol' | 'static' | string; ok: boolean; stop_count?: number; config_count?: number; contracted_days?: number[]; has_route?: boolean; day_of_week?: number; place_name?: string | null; place_kind?: string | null; boundary_verified?: boolean; has_module?: boolean; window_start?: string | null; window_end?: string | null; visits_max?: number; min_gap_minutes?: number; outside_window?: boolean; too_short_for_visits?: boolean; }
const weekdayName = (value: string) => new Date(value).toLocaleDateString('en-NZ', { weekday: 'long' });
/** What the rosterer reads under Start/End before creating the shift. Patrols default to every day, any time of day. */
export const coverageWords = (preview: CoveragePreview, startLocal: string): { tone: 'ok' | 'warn'; text: string } => {
  if (preview.kind === 'patrol') {
    if (!preview.has_route) return { tone: 'warn', text: 'This run has no patrol route yet, so the shift would have no stops. Set the route up on the work unit first.' };
    if (!preview.config_count) return { tone: 'warn', text: 'This route has no contracted stops at all yet, so the shift would have nothing to visit.' };
    if (!preview.stop_count) return { tone: 'warn', text: `No contracted stops on a ${weekdayName(startLocal)} for this run — the contract covers ${contractedDaysWords(preview.contracted_days)}. The shift would have nothing to visit unless stops are added.` };
    const hours = contractedHoursWords(preview.window_start, preview.window_end);
    if (preview.outside_window) return { tone: 'warn', text: `This shift is outside the contracted hours (${hours}) for this run. Every visit would already be late when the officer starts — move the shift into the window or vary the agreement.` };
    if (preview.too_short_for_visits) return { tone: 'warn', text: `${plural(preview.stop_count, 'contracted stop')} on a ${weekdayName(startLocal)}, but the contract wants ${preview.visits_max} visits at least ${preview.min_gap_minutes} min apart and this shift is too short to fit them. Lengthen the shift or expect the later visits to be missed.` };
    const spread = (preview.visits_max ?? 1) > 1 ? (preview.window_start ? '; visits are spread across the part of that window the shift covers' : '; visits are spread across the shift') : '';
    return { tone: 'ok', text: `${plural(preview.stop_count, 'contracted stop')} on a ${weekdayName(startLocal)} for this run (contracted ${contractedDaysWords(preview.contracted_days)}, ${hours}${spread}).` };
  }
  if (preview.kind === 'static') {
    if (!preview.has_module) return { tone: 'warn', text: 'This post has no static guarding module on its agreement, so the officer would have no task to work.' };
    if (!preview.boundary_verified) return { tone: 'warn', text: `${preview.place_name ?? 'The place'} has no verified boundary${preview.place_kind === 'zone' ? ' (it is a zone, not a site)' : ''}, so the officer cannot record arriving or leaving the post. Verify the site boundary first.` };
    return { tone: 'ok', text: `Post at ${preview.place_name}: verified boundary, attendance can be recorded.` };
  }
  return { tone: 'ok', text: 'Office / internal work: no stops or place needed.' };
};

interface AssignmentPreview { staff_id: string; work_ready: boolean; rules: { min_rest_hours_between_shifts: number; max_hours_per_week: number; max_consecutive_days: number; enforced: boolean } | null; rest_hours: number | null; week_start: string; week_hours: number; consecutive_days: number; availability_conflict: boolean; conflict: string | null; credential_warnings: { credential_type: string; expiry_date: string | null; verified: boolean }[]; }
const hoursWords = (value: number) => `${Number.isInteger(value) ? value : value.toFixed(1)} h`;
const dayWords = (value: string) => new Date(`${value}T00:00:00`).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' });
/** Rest, hours and days in a row for this officer if this shift is added — and whether the roster will refuse it. */
export const assignmentWords = (preview: AssignmentPreview): { tone: 'ok' | 'warn' | 'stop'; text: string }[] => {
  const notes: { tone: 'ok' | 'warn' | 'stop'; text: string }[] = [];
  if (preview.conflict) notes.push({ tone: 'stop', text: `The roster will refuse this: ${preview.conflict}.` });
  const load = `${hoursWords(preview.week_hours)} in the week starting ${dayWords(preview.week_start)}${preview.rules ? ` (limit ${hoursWords(preview.rules.max_hours_per_week)})` : ''} · ${preview.rest_hours === null ? 'no other shift nearby' : `${hoursWords(preview.rest_hours)} rest from the nearest other shift`} · day ${preview.consecutive_days} in a row${preview.rules ? ` (limit ${preview.rules.max_consecutive_days})` : ''}.`;
  if (!preview.conflict) notes.push({ tone: 'ok', text: load });
  if (!preview.rules) notes.push({ tone: 'warn', text: 'No rest and hours rules are set for this officer\'s employer, so the roster is not checking fatigue. Set them in People & HR › Rostering › Rest & hours rules.' });
  else if (!preview.rules.enforced) notes.push({ tone: 'warn', text: 'The employer\'s rest and hours rules are recorded but not enforced — the roster will accept this even if it breaks them.' });
  if (preview.availability_conflict && !preview.conflict) notes.push({ tone: 'warn', text: 'The officer has marked themselves unavailable for part of this time.' });
  for (const warning of preview.credential_warnings ?? []) notes.push({ tone: 'warn', text: warning.expiry_date ? `${credentialTypeLabel(warning.credential_type)} expires ${dayWords(warning.expiry_date)}, before this shift ends.` : `${credentialTypeLabel(warning.credential_type)} is not verified.` });
  return notes;
};

const clockWords = (value: string) => new Date(value).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' });
const minutesBetween = (a: string, b: string) => Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60_000);
/** `18:02 – 21:58 · 3h 56m · started 2 min late` — what actually happened against the roster. */
export const workedWords = (shift: Shift): string => {
  if (!shift.actual_start) return 'Not started';
  const offset = minutesBetween(shift.scheduled_start, shift.actual_start);
  const startNote = offset === 0 ? 'started on time' : offset > 0 ? `started ${plural(offset, 'min')} late` : `started ${plural(-offset, 'min')} early`;
  if (!shift.actual_end) return `${clockWords(shift.actual_start)} – still on shift · ${startNote}`;
  const worked = Math.max(0, minutesBetween(shift.actual_start, shift.actual_end));
  return `${clockWords(shift.actual_start)} – ${clockWords(shift.actual_end)} · ${Math.floor(worked / 60)}h ${String(worked % 60).padStart(2, '0')}m · ${startNote}`;
};
export const endedWords = (reason: string | null | undefined): string => reason === 'officer' ? 'The officer ended it' : reason === 'superseded_by_next_shift' ? 'Stopped when their next shift started — check what was left open' : 'Completed';
import './RosterCalendar.css';
import './RosterCommercialReadiness.css';

interface Staff { id: string; staffId: string; name: string; workReady: boolean; employmentType: string | null; credentialRisk: 'clear' | 'expiring' | 'expired' | 'unverified' | 'unknown'; credentialExpiry: string | null; }
/** Aggregate credential readiness; the assignment preview supplies type-specific warnings. */
export const credentialBlocker = (person: Pick<Staff, 'name' | 'credentialRisk' | 'credentialExpiry'>, endValue: string): string | null => {
  if (person.credentialRisk === 'unknown') return `${person.name}'s credentials have not been confirmed. Check People & HR › Credentials before assigning.`;
  if (person.credentialRisk === 'unverified') return `${person.name} has unverified credentials on file. Verify them in People & HR › Credentials first.`;
  if (person.credentialRisk === 'expired') return `${person.name} has an expired credential${person.credentialExpiry ? ` (${dayWords(person.credentialExpiry)})` : ''}. Record the renewal in People & HR › Credentials first.`;
  if (person.credentialExpiry && endValue && new Date(person.credentialExpiry).getTime() < new Date(endValue).getTime()) return `${person.name} has a credential expiring ${dayWords(person.credentialExpiry)}, before this shift ends. Record the renewal in People & HR › Credentials first.`;
  return null;
};
/** The branch RPC aggregates all credential types; it does not prove a specific licence. */
export const credentialBadgeWords = (person: Pick<Staff, 'workReady' | 'credentialRisk' | 'credentialExpiry'>): string => {
  if (person.credentialRisk === 'unknown') return 'Credentials not recorded';
  if (person.credentialRisk === 'unverified') return 'not verified';
  if (person.credentialRisk === 'expired') return 'Credential expired';
  if (person.credentialRisk === 'expiring') return `Credential expires ${person.credentialExpiry ? dayWords(person.credentialExpiry) : 'soon'}`;
  return 'Recorded credentials verified';
};
interface Shift { id: string; officer_user_id: string; service_type: string; scheduled_start: string; scheduled_end: string; status: string; shift_health: string | null; total_stops: number; completed_stops?: number | null; notes: string | null; actual_start?: string | null; actual_end?: string | null; ended_reason?: string | null; }
interface WorkUnit { id: string; name: string; work_unit_type: 'patrol' | 'static' | 'internal'; service_type: string; external_refs?: { deputy?: { code?: string; name?: string } } | null; }
interface RosterSlot { id: string; work_unit_id: string; staff_id: string | null; scheduled_start: string; scheduled_end: string; status: string; linked_shift_id: string | null; notes: string | null; }
interface HistoricalOfficer { display_name: string | null; email: string | null; }
interface HistoricalAssignment { id: string; officer_id: string; patrol_route_id: string | null; service_type: string; specific_date: string; shift: string; start_time: string | null; end_time: string | null; officer: HistoricalOfficer | HistoricalOfficer[] | null; external_refs: { source?: string; beat_names?: string[]; time_precision?: string; source_event_count?: number } | null; }
interface PatrolRoute { id: string; name: string; route_code: string | null; }
interface Leave { staff_id: string; starts_on: string; ends_on: string; }
type AvailabilityType = 'available' | 'preferred' | 'unavailable' | 'leave';
interface Availability { id: string; staff_id: string; day_of_week: number | null; specific_date: string | null; available_from: string | null; available_to: string | null; all_day: boolean; availability_type: AvailabilityType; notes: string | null; created_at: string; }
interface AvailabilityDialog {
  staffId: string;
  scheduleKind: 'date' | 'weekday';
  specificDate: string;
  dayOfWeek: number;
  allDay: boolean;
  availableFrom: string;
  availableTo: string;
  availabilityType: Exclude<AvailabilityType, 'leave'>;
  notes: string;
  clientRequestId: string;
  deleteTarget: Availability | null;
  deleteReason: string;
  deleteRequestId: string;
}
interface Coverage { id: string; shift_date: string; }
interface CommercialReadiness { slot_id: string; pay_status: string; billing_status: string; quote_status: string; geofence_status: string; cost_centre_status: string; }
interface LabourCost { slot_id: string; work_unit_name: string; scheduled_hours: number; pay_cost: number; billable: number; margin: number; rate_status: string; }
interface AttendanceException { shift_id: string; officer_user_id: string; service_type: string; scheduled_start: string; scheduled_end: string; status: string; exception_type: 'late_start' | 'active_overrun' | 'missed'; minutes_overdue: number; }
const ATTENDANCE_EXCEPTION_LABEL: Record<AttendanceException['exception_type'], string> = { late_start: 'Late shift start', active_overrun: 'Active shift overrun', missed: 'Shift missed – nobody attended' };
interface TemplatePreview { templates_applied: number; candidate_slots: number; existing_slots: number; new_slots: number; }
interface BatchPublishPreview { draft_count: number; leave_conflict_count: number; unassigned_count: number; field_shift_count: number; }
type ReadinessFilter = 'all' | 'ready' | 'risk';

const ROSTER_VIEW_BY_ROLE: Partial<Record<AppRole, { eyebrow: string; description: string }>> = {
  grand_master: { eyebrow: 'Roster oversight', description: 'Review workforce coverage for the selected delivery branch.' },
  master: { eyebrow: 'Roster oversight', description: 'Review workforce coverage across your selected branch.' },
  admin: { eyebrow: 'Team planning', description: 'Create, publish, and monitor shifts for your organisation.' },
  admin_officer: { eyebrow: 'Daily scheduling', description: 'Plan assigned shifts, coverage, and officer readiness.' },
};

const startOfWeek = (date: Date) => { const value = new Date(date); value.setDate(value.getDate() - ((value.getDay() + 6) % 7)); value.setHours(0, 0, 0, 0); return value; };
const addDays = (date: Date, days: number) => { const value = new Date(date); value.setDate(value.getDate() + days); return value; };
const isoDate = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
const localInput = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

const RosterOperationsPage: React.FC = () => {
  const { profile, operatingOrganizationId, operatingOrganizations, setOperatingOrganization } = useAuth();
  const rosterView = ROSTER_VIEW_BY_ROLE[profile?.role ?? 'unknown'] ?? ROSTER_VIEW_BY_ROLE.admin!;
  const navigate = useNavigate();
  const location = useLocation();
  const workflowContext = readWorkflowContext(location.search);
  const [periodAnchor, setPeriodAnchor] = useState(() => new Date());
  const [horizon, setHorizon] = useState<RosterHorizon>('week');
  const [calendarRegion, setCalendarRegion] = useState<string | null>(null);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [workUnits, setWorkUnits] = useState<WorkUnit[]>([]);
  const [slots, setSlots] = useState<RosterSlot[]>([]);
  const [historicalAssignments, setHistoricalAssignments] = useState<HistoricalAssignment[]>([]);
  const [patrolRoutes, setPatrolRoutes] = useState<PatrolRoute[]>([]);
  const [leave, setLeave] = useState<Leave[]>([]);
  const [availability, setAvailability] = useState<Availability[]>([]);
  const [coverage, setCoverage] = useState<Coverage[]>([]);
  const [commercialReadiness, setCommercialReadiness] = useState<CommercialReadiness[]>([]);
  const [labourCost, setLabourCost] = useState<LabourCost[]>([]);
  const [attendanceExceptions, setAttendanceExceptions] = useState<AttendanceException[]>([]);
  const [attendanceAction, setAttendanceAction] = useState<{ item: AttendanceException; notes: string } | null>(null);
  const [availabilityDialog, setAvailabilityDialog] = useState<AvailabilityDialog | null>(null);
  const [templateDialog, setTemplateDialog] = useState<TemplatePreview | 'loading' | null>(null);
  const [publishDialog, setPublishDialog] = useState<BatchPublishPreview | 'loading' | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedStaffId, setSelectedStaffId] = useState<string | null>(null);
  const [timesheetCount, setTimesheetCount] = useState<number | null>(null);
  const [timesheetsOpen, setTimesheetsOpen] = useState(false);
  const [rosterDataReady, setRosterDataReady] = useState(false);
  const loadVersion = useRef(0);
  const [readiness, setReadiness] = useState<ReadinessFilter>('all');
  const [scheduleMode, setScheduleMode] = useState<'staff' | 'work-unit'>('staff');
  const [selectedShiftId, setSelectedShiftId] = useState<string | null>(null);
  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null);
  const [slotAction, setSlotAction] = useState<'publish' | 'cancel' | 'reassign' | 'unpublish' | null>(null);
  const [slotReason, setSlotReason] = useState('');
  const [replacementStaffId, setReplacementStaffId] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [editingSlot, setEditingSlot] = useState<RosterSlot | null>(null);
  const [copyingSlot, setCopyingSlot] = useState<RosterSlot | null>(null);
  const [repeatDialog, setRepeatDialog] = useState<{ slot: RosterSlot; from: string; to: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ officerId: '', workUnitId: '', start: '', end: '', notes: '', publish: true });
  const [unitCoverage, setUnitCoverage] = useState<CoveragePreview | null>(null);
  const [assignmentPreview, setAssignmentPreview] = useState<AssignmentPreview | null>(null);

  const period = useMemo(() => rosterPeriod(periodAnchor, horizon), [horizon, periodAnchor]);
  const { days, start: weekStart, end: weekEnd } = period;

  // ATLAS READS: preview_work_unit_coverage — advisory before the slot exists, same day rule as generate_shift_stops
  useEffect(() => {
    if (!showCreate || !form.workUnitId || !form.start) { setUnitCoverage(null); return; }
    let cancelled = false;
    const startDate = new Date(form.start);
    const endDate = form.end ? new Date(form.end) : null;
    const shiftDate = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-${String(startDate.getDate()).padStart(2, '0')}`;
    supabase.rpc('preview_work_unit_coverage', { p_work_unit_id: form.workUnitId, p_shift_date: shiftDate, p_scheduled_start: startDate.toISOString(), p_scheduled_end: endDate && endDate > startDate ? endDate.toISOString() : null }).then(({ data }) => { const preview = data as CoveragePreview | null; if (!cancelled) setUnitCoverage(preview && typeof preview === 'object' && !Array.isArray(preview) && 'kind' in preview ? preview : null); });
    return () => { cancelled = true; };
  }, [showCreate, form.workUnitId, form.start, form.end]);
  // ATLAS READS: preview_roster_assignment — the same rest/hours/days check the slot trigger enforces, shown before the slot exists
  // the last refusal was about the previous officer/times; a changed shift starts clean
  useEffect(() => { if (showCreate) setError(null); }, [showCreate, form.officerId, form.start, form.end]);
  useEffect(() => {
    const person = staff.find((candidate) => candidate.id === form.officerId);
    if (!showCreate || !person || !form.start || !form.end || new Date(form.end) <= new Date(form.start)) { setAssignmentPreview(null); return; }
    let cancelled = false;
    supabase.rpc('preview_roster_assignment', { p_staff_id: person.staffId, p_scheduled_start: new Date(form.start).toISOString(), p_scheduled_end: new Date(form.end).toISOString() }).then(({ data }) => { const preview = data as AssignmentPreview | null; if (!cancelled) setAssignmentPreview(preview && typeof preview === 'object' && !Array.isArray(preview) && 'week_hours' in preview ? preview : null); });
    return () => { cancelled = true; };
  }, [showCreate, form.officerId, form.start, form.end, staff]);
  const holidays = useMemo(() => nzRosterHolidays(weekStart, weekEnd, calendarRegion), [calendarRegion, weekEnd, weekStart]);

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setRosterDataReady(false);
    const org = operatingOrganizationId ?? profile?.organizationId;
    if (!org) {
      setError('Select an authorised organisation to view the roster.');
      setStaff([]); setSlots([]); setShifts([]); setWorkUnits([]);
      setLoading(false);
      return;
    }
    const operatingContext = operatingOrganizations.find((context) => context.organizationId === org);
    // 'corporate_oversight' spans every branch at once (no single branch to roster against);
    // 'organisation_home' and 'branch_authorisation' are both a single, real roster to run.
    if (operatingContext && operatingContext.authorityBasis === 'corporate_oversight') {
      setStaff([]); setSlots([]); setShifts([]); setWorkUnits([]);
      setError('Select a delivery branch to view roster operations.');
      setLoading(false);
      return;
    }
    setLoading(true); setError(null);
    const canLoadBranchStaff = operatingContext?.authorityBasis === 'branch_authorisation' || operatingContext?.authorityBasis === 'organisation_home';
    if (!canLoadBranchStaff) {
      setStaff([]); setSlots([]); setShifts([]); setWorkUnits([]);
      setError('Roster authority is unavailable in this operating context. Select an authorised delivery branch.');
      setLoading(false);
      return;
    }
    const responses = await Promise.all([
      canLoadBranchStaff
        ? supabase.rpc('get_operating_branch_roster_staff', { p_operating_organization_id: org })
        : Promise.resolve({ data: [], error: null }),
      supabase.from('shifts').select('id,officer_user_id,service_type,scheduled_start,scheduled_end,status,shift_health,total_stops,completed_stops,notes,actual_start,actual_end,ended_reason').eq('organization_id', org).gte('scheduled_start', weekStart.toISOString()).lt('scheduled_start', weekEnd.toISOString()).order('scheduled_start'),
      supabase.from('roster_work_units').select('id,name,work_unit_type,service_type,external_refs').eq('organization_id', org).eq('active', true).order('name'),
      supabase.from('roster_slots').select('id,work_unit_id,staff_id,scheduled_start,scheduled_end,status,linked_shift_id,notes').eq('organization_id', org).gte('scheduled_start', weekStart.toISOString()).lt('scheduled_start', weekEnd.toISOString()).order('scheduled_start'),
      supabase.from('roster_assignments').select('id,officer_id,patrol_route_id,service_type,specific_date,shift,start_time,end_time,external_refs,officer:user_profiles!roster_assignments_officer_id_fkey(display_name,email)').eq('organization_id', org).gte('specific_date', isoDate(weekStart)).lt('specific_date', isoDate(weekEnd)).order('specific_date'),
      supabase.from('patrol_routes').select('id,name,route_code').eq('organization_id', org).order('name'),
      supabase.from('leave_requests').select('staff_id,starts_on,ends_on,status').eq('organization_id', org).eq('status', 'approved').lte('starts_on', isoDate(addDays(weekEnd, -1))).gte('ends_on', isoDate(weekStart)),
      supabase.from('staff_availability').select('id,staff_id,day_of_week,specific_date,available_from,available_to,all_day,availability_type,notes,created_at').eq('organization_id', org).or(`day_of_week.not.is.null,and(specific_date.gte.${isoDate(weekStart)},specific_date.lt.${isoDate(weekEnd)})`),
      supabase.from('shift_coverage_requests').select('id,shift_date').eq('organization_id', org).eq('status', 'open').gte('shift_date', isoDate(weekStart)).lt('shift_date', isoDate(weekEnd)),
      supabase.from('organization_calendar_settings').select('region_code').eq('organization_id', org),
      supabase.rpc('get_roster_commercial_readiness', { p_organization_id: org, p_from: weekStart.toISOString(), p_to: weekEnd.toISOString() }),
      supabase.rpc('get_roster_labour_cost', { p_organization_id: org, p_from: weekStart.toISOString(), p_to: weekEnd.toISOString() }),
      supabase.rpc('get_roster_attendance_exceptions', { p_organization_id: org, p_grace_minutes: 15, p_from: weekStart.toISOString(), p_to: weekEnd.toISOString() }),
    ]);
    const [rosterStaffRes, shiftRes, unitRes, slotRes, historicalRes, routeRes, leaveRes, availabilityRes, coverageRes, calendarRes, commercialRes, labourRes, attendanceRes] = responses;
    if (version !== loadVersion.current) return;
    const failures = responses.filter((response) => response.error).map((response) => response.error?.message);
    if (failures.length) setError(failures.join(' · '));
    const now = Date.now();
    setStaff(((rosterStaffRes.data ?? []) as Array<{ user_id: string; staff_id: string; display_name: string | null; email: string | null; employment_type: string | null; work_ready: boolean; credential_expiry: string | null; credential_verified: boolean | null }>).map((user) => {
      let credentialRisk: Staff['credentialRisk'] = user.credential_verified === null || user.credential_verified === undefined ? 'unknown' : user.credential_verified === false ? 'unverified' : 'clear';
      if (user.credential_expiry && new Date(user.credential_expiry).getTime() < now) credentialRisk = 'expired';
      else if (user.credential_expiry && new Date(user.credential_expiry).getTime() - now < 30 * 86_400_000) credentialRisk = 'expiring';
      return { id: user.user_id, staffId: user.staff_id, name: user.display_name || user.email || 'Unnamed staff', workReady: user.work_ready, employmentType: user.employment_type, credentialRisk, credentialExpiry: user.credential_expiry ?? null };
    }));
    setShifts((shiftRes.data as Shift[]) ?? []); setWorkUnits((unitRes.data as WorkUnit[]) ?? []); setSlots((slotRes.data as RosterSlot[]) ?? []); setHistoricalAssignments((historicalRes.data as HistoricalAssignment[]) ?? []); setPatrolRoutes((routeRes.data as PatrolRoute[]) ?? []); setLeave((leaveRes.data as Leave[]) ?? []); setAvailability((availabilityRes.data as Availability[]) ?? []); setCoverage((coverageRes.data as Coverage[]) ?? []); setCalendarRegion((calendarRes.data?.[0] as { region_code: string | null } | undefined)?.region_code ?? null); setCommercialReadiness((commercialRes.data as CommercialReadiness[]) ?? []); setLabourCost((labourRes.data as LabourCost[]) ?? []); setAttendanceExceptions((attendanceRes.data as AttendanceException[]) ?? []); setRosterDataReady(![rosterStaffRes, shiftRes, unitRes, slotRes, leaveRes, availabilityRes].some((response) => response.error) && canLoadBranchStaff); setLoading(false);
  }, [operatingOrganizationId, operatingOrganizations, profile?.organizationId, weekEnd, weekStart]);
  useEffect(() => { void load(); return () => { loadVersion.current += 1; }; }, [load]);
  const syncOfficerResponses = useCallback(async () => {
    const version = loadVersion.current;
    const org = operatingOrganizationId ?? profile?.organizationId;
    if (!org) return;
    const [shiftResponse, slotResponse] = await Promise.all([
      supabase.from('shifts').select('id,officer_user_id,service_type,scheduled_start,scheduled_end,status,shift_health,total_stops,completed_stops,notes,actual_start,actual_end,ended_reason').eq('organization_id', org).gte('scheduled_start', weekStart.toISOString()).lt('scheduled_start', weekEnd.toISOString()).order('scheduled_start'),
      supabase.from('roster_slots').select('id,work_unit_id,staff_id,scheduled_start,scheduled_end,status,linked_shift_id,notes').eq('organization_id', org).gte('scheduled_start', weekStart.toISOString()).lt('scheduled_start', weekEnd.toISOString()).order('scheduled_start'),
    ]);
    if (version !== loadVersion.current) return;
    if (!shiftResponse.error) setShifts((shiftResponse.data as Shift[]) ?? []);
    if (!slotResponse.error) setSlots((slotResponse.data as RosterSlot[]) ?? []);
  }, [operatingOrganizationId, profile?.organizationId, weekEnd, weekStart]);
  useEffect(() => {
    const interval = window.setInterval(() => void syncOfficerResponses(), 15_000);
    return () => window.clearInterval(interval);
  }, [syncOfficerResponses]);

  const visibleStaff = staff.filter((person) => (!search || person.name.toLowerCase().includes(search.toLowerCase())) && (readiness === 'all' || (readiness === 'ready' ? person.workReady && person.credentialRisk === 'clear' : !person.workReady || person.credentialRisk !== 'clear')));
  const scheduleStaff = visibleStaff.filter((person) => !selectedStaffId || person.staffId === selectedStaffId);
  const visibleWorkUnits = workUnits.filter((unit) => !search || unit.name.toLowerCase().includes(search.toLowerCase()));
  const selectedShift = shifts.find((shift) => shift.id === selectedShiftId) ?? null;
  const selectedSlot = slots.find((slot) => slot.id === selectedSlotId) ?? null;
  const selectedSlotUnit = selectedSlot ? workUnits.find((unit) => unit.id === selectedSlot.work_unit_id) ?? null : null;
  const selectedSlotStaff = selectedSlot ? staff.find((person) => person.staffId === selectedSlot.staff_id) ?? null : null;
  const selectedCommercialReadiness = selectedSlot ? commercialReadiness.find((item) => item.slot_id === selectedSlot.id) ?? null : null;
  const selectedOfficer = selectedShift ? staff.find((person) => person.id === selectedShift.officer_user_id) : null;
  const requestedWorkUnit = workUnits.find((unit) => unit.id === workflowContext.workUnitId) ?? null;
  const riskCount = staff.filter((person) => !person.workReady || person.credentialRisk !== 'clear').length;
  const draftCount = slots.filter((slot) => slot.status === 'draft').length;
  const openSlots = slots.filter((slot) => !slot.staff_id && !['cancelled', 'completed'].includes(slot.status));
  useEffect(() => {
    setSelectedStaffId(null); setSelectedShiftId(null); setSelectedSlotId(null); setTimesheetCount(null);
    setShowCreate(false); setAvailabilityDialog(null); setPublishDialog(null); setTemplateDialog(null); setRepeatDialog(null); setAttendanceAction(null);
    setNotice(null);
  }, [operatingOrganizationId]);
  const periodLabel = `${weekStart.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })} – ${addDays(weekEnd, -1).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' })}`;
  const totalHours = [...shifts, ...slots.filter((slot) => !slot.linked_shift_id)].reduce((sum, item) => sum + Math.max(0, (new Date(item.scheduled_end).getTime() - new Date(item.scheduled_start).getTime()) / 3_600_000), 0);
  const labourCostTotals = labourCost.reduce(
    (acc, row) => ({
      pay: acc.pay + Number(row.pay_cost ?? 0),
      margin: acc.margin + Number(row.margin ?? 0),
      unpriced: acc.unpriced + (row.rate_status === 'resolved' ? 0 : 1),
    }),
    { pay: 0, margin: 0, unpriced: 0 },
  );
  const restrictionsForDay = (staffId: string, day: Date) => availability.filter((record) => ['unavailable', 'leave'].includes(record.availability_type) && record.staff_id === staffId && (record.specific_date === isoDate(day) || (record.specific_date === null && record.day_of_week === ((day.getDay() + 6) % 7) + 1)));
  const availabilityOccurrences = days.flatMap((day) => staff.flatMap((person) => restrictionsForDay(person.staffId, day).map((record) => ({ day, person, record }))));
  const commercialExceptions = commercialReadiness.filter((item) => [item.pay_status, item.billing_status, item.quote_status, item.geofence_status, item.cost_centre_status].some((status) => !['ready', 'accepted', 'verified', 'not_applicable'].includes(status)));
  const hasAvailabilityConflict = (staffId: string, startValue: string, endValue: string) => {
    if (!startValue || !endValue) return false;
    const start = new Date(startValue); const end = new Date(endValue); const firstDay = new Date(start); firstDay.setHours(0, 0, 0, 0);
    for (let day = firstDay; day < end; day = addDays(day, 1)) {
      for (const record of restrictionsForDay(staffId, day)) {
        if (record.all_day || !record.available_from || !record.available_to) return true;
        const [fromHour, fromMinute] = record.available_from.split(':').map(Number); const [toHour, toMinute] = record.available_to.split(':').map(Number);
        const blockedStart = new Date(day); blockedStart.setHours(fromHour, fromMinute, 0, 0); const blockedEnd = new Date(day); blockedEnd.setHours(toHour, toMinute, 0, 0); if (blockedEnd <= blockedStart) blockedEnd.setDate(blockedEnd.getDate() + 1);
        if (start < blockedEnd && end > blockedStart) return true;
      }
    }
    return false;
  };

  const openCreate = (person?: Staff, day?: Date, workUnitOverride?: string) => {
    setCopyingSlot(null);
    if (!workUnitOverride && selectedSlot?.status === 'draft') {
      openEdit(selectedSlot);
      return;
    }
    const start = day ? new Date(day) : new Date(); start.setHours(8, 0, 0, 0); const end = new Date(start); end.setHours(16, 0, 0, 0);
    // Default path: workUnitId: requestedWorkUnit?.id ??
    const preferredWorkUnitId = workUnitOverride ?? requestedWorkUnit?.id ?? workUnits[0]?.id ?? '';
    setEditingSlot(null);
    setForm({ officerId: person?.id ?? '', workUnitId: preferredWorkUnitId, start: localInput(start), end: localInput(end), notes: '', publish: true }); setShowCreate(true);
  };

  const openEdit = (slot: RosterSlot) => {
    setCopyingSlot(null);
    const staffMember = staff.find((candidate) => candidate.staffId === slot.staff_id);
      setEditingSlot(slot);
    setForm({
      officerId: staffMember?.id ?? '',
      workUnitId: slot.work_unit_id,
      start: localInput(new Date(slot.scheduled_start)),
      end: localInput(new Date(slot.scheduled_end)),
      notes: slot.notes ?? '',
      publish: false,
    });
    setSelectedSlotId(null);
    setShowCreate(true);
  };

  const openCopy = (slot: RosterSlot) => {
    const staffMember = staff.find((candidate) => candidate.staffId === slot.staff_id);
    const start = new Date(slot.scheduled_start);
    const end = new Date(slot.scheduled_end);
    start.setDate(start.getDate() + 7);
    end.setDate(end.getDate() + 7);
    setCopyingSlot(slot);
    setEditingSlot(null);
    setForm({ officerId: staffMember?.id ?? '', workUnitId: slot.work_unit_id, start: localInput(start), end: localInput(end), notes: slot.notes ?? '', publish: false });
    setSelectedSlotId(null);
    setShowCreate(true);
  };

  const repeatSelected = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!repeatDialog) return;
    setSaving(true); setError(null); setNotice(null);
    const { data, error: repeatError } = await supabase.rpc('repeat_roster_slot_range', { p_source_slot_id: repeatDialog.slot.id, p_from_date: repeatDialog.from, p_to_date: repeatDialog.to });
    const receipt = Array.isArray(data) ? data[0] : data;
    if (repeatError || !receipt) setError(repeatError?.message ?? 'Roster repeat was not confirmed.');
    else { setNotice(`Repeated roster assignment: ${receipt.created_count} drafts created, ${receipt.skipped_conflict_count} conflicts skipped, ${receipt.leave_conflict_count} leave conflicts.`); setRepeatDialog(null); await load(); }
    setSaving(false);
  };

  const updateDraft = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editingSlot) return;
    setSaving(true); setError(null); setNotice(null);
    const person = staff.find((candidate) => candidate.id === form.officerId);
    if (!person) { setError('A work-ready staff member is required.'); setSaving(false); return; }
    const blocker = credentialBlocker(person, form.end); if (blocker) { setError(blocker); setSaving(false); return; }
    const { error: updateError } = await supabase.rpc('update_roster_slot', {
      p_slot_id: editingSlot.id,
      p_expected_status: editingSlot.status,
      p_staff_id: person.staffId,
      p_scheduled_start: new Date(form.start).toISOString(),
      p_scheduled_end: new Date(form.end).toISOString(),
      p_notes: form.notes.trim() || null,
    });
    if (updateError) setError(updateError.message);
    else { setNotice('Draft roster slot updated. Review it before publishing.'); setEditingSlot(null); setShowCreate(false); await load(); }
    setSaving(false);
  };

  const createAssignment = async (event: React.FormEvent) => {
    if (editingSlot) {
      await updateDraft(event);
      return;
    }
    event.preventDefault(); setSaving(true); setError(null); setNotice(null);
    const person = staff.find((candidate) => candidate.id === form.officerId); const unit = workUnits.find((candidate) => candidate.id === form.workUnitId);
    const blocker = person ? credentialBlocker(person, form.end) : null; if (blocker) { setError(blocker); setSaving(false); return; }
    if (person && hasAvailabilityConflict(person.staffId, form.start, form.end)) { setError(`${person.name} is unavailable during the selected assignment time.`); setSaving(false); return; }
    const slotResponse = await supabase.rpc('create_roster_slot', { p_client_request_id: crypto.randomUUID(),     p_work_unit_id: form.workUnitId, p_staff_id: person?.staffId ?? null, p_scheduled_start: new Date(form.start).toISOString(), p_scheduled_end: new Date(form.end).toISOString(), p_publish: form.publish, p_notes: form.notes.trim() || null });
    if (slotResponse.error || !slotResponse.data) { setError(slotResponse.error?.message ?? 'Roster slot creation was not confirmed.'); setSaving(false); return; }
    const slot = slotResponse.data as { id: string };
    if (form.publish && person && unit?.work_unit_type !== 'internal') {
      const materialized = await supabase.rpc('materialize_roster_slot', { p_slot_id: slot.id, p_expected_status: 'published' });
      if (materialized.error || !materialized.data) { setError(materialized.error?.message ?? 'The roster slot was saved, but the field shift could not be created from it.'); setSaving(false); await load(); return; }
    }
    const receipt = person
      ? `${copyingSlot ? 'Shift copied as a draft' : `Shift ${form.publish ? 'published' : 'saved as a draft'}`} for ${person.name}.${form.publish && !copyingSlot ? ' They will see it on their schedule and can accept or decline.' : ''}`
      : `Open shift ${form.publish ? 'published' : 'saved as a draft'} for ${unit?.name ?? 'the selected work unit'}.${form.publish ? ' Open it on the roster and offer it to available staff.' : ' Publish it when it is ready to advertise.'}`;
    setNotice(receipt); setCopyingSlot(null); setShowCreate(false); await load(); setSaving(false);
  };

  const manageSlot = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedSlot || !slotAction) return;
    setSaving(true); setError(null); setNotice(null);
    const { error: actionError } = slotAction === 'reassign'
      ? await supabase.rpc('reassign_roster_slot', { p_slot_id: selectedSlot.id, p_expected_status: selectedSlot.status, p_new_staff_id: replacementStaffId, p_reason: slotReason.trim() })
      : slotAction === 'unpublish'
      ? await supabase.rpc('unpublish_roster_slot', { p_client_request_id: crypto.randomUUID(), p_slot_id: selectedSlot.id, p_expected_status: selectedSlot.status, p_reason: slotReason.trim() })
      : await supabase.rpc('manage_roster_slot', { p_slot_id: selectedSlot.id, p_expected_status: selectedSlot.status, p_action: slotAction, p_reason: slotAction === 'cancel' ? slotReason.trim() : null });
    if (actionError) setError(actionError.message);
    else { setNotice(slotAction === 'publish' ? 'Roster slot published. The officer can now accept or decline it, and the field shift is ready.' : slotAction === 'unpublish' ? 'Roster slot recalled to draft. Its unstarted shift was cancelled.' : slotAction === 'reassign' ? 'Roster slot reassigned. The replacement officer has been asked to accept it.' : 'Roster slot cancelled, and its shift with it.'); setSlotAction(null); setSlotReason(''); setReplacementStaffId(''); setSelectedSlotId(null); await load(); }
    setSaving(false);
  };

  const batchPublishPeriod = async () => {
    const operatingBranchId = operatingOrganizationId ?? profile?.organizationId;
    if (!operatingBranchId) return;
    setSaving(true); setError(null); setNotice(null);
    const clientRequestId = crypto.randomUUID();
    const { data, error: rpcError } = await supabase.rpc('batch_publish_roster_slots', {
      p_client_request_id: clientRequestId,
      p_organization_id: operatingBranchId,
      p_from: weekStart.toISOString(),
      p_to: weekEnd.toISOString(),
    });
    const receipt = Array.isArray(data) ? data[0] : data;
    if (rpcError || !receipt) setError(rpcError?.message ?? 'Batch publishing was not confirmed.');
    else {
      const { data: failures } = await supabase.rpc('get_roster_batch_publish_failures', { p_client_request_id: clientRequestId });
      const failureCount = Array.isArray(failures) ? failures.length : 0;
      setNotice(`${plural(receipt.published_count, 'shift')} published and ${plural(receipt.materialized_count, 'field shift record')} created${receipt.conflict_count ? `; ${receipt.conflict_count} skipped because of approved leave` : ''}${failureCount ? `; ${failureCount} could not be turned into field shifts and are kept as drafts for review` : ''}. Officers can now accept or decline.`);
      setPublishDialog(null);
      await load();
    }
    setSaving(false);
  };

  const openPublishDialog = async () => {
    const operatingBranchId = operatingOrganizationId ?? profile?.organizationId;
    if (!operatingBranchId) return;
    setPublishDialog('loading'); setError(null); setNotice(null);
    const { data, error: previewError } = await supabase.rpc('preview_batch_publish_roster_slots', { p_organization_id: operatingBranchId, p_from: weekStart.toISOString(), p_to: weekEnd.toISOString() });
    const preview = Array.isArray(data) ? data[0] : data;
    if (previewError || !preview) { setError(previewError?.message ?? 'Publish check was not confirmed.'); setPublishDialog(null); }
    else setPublishDialog(preview as BatchPublishPreview);
  };

  const offerOvertime = async () => {
    if (!selectedSlot) return;
    setSaving(true); setError(null); setNotice(null);
    const { data, error: offerError } = await supabase.rpc('offer_overtime_by_seniority', {
      p_client_request_id: crypto.randomUUID(),
      p_roster_slot_id: selectedSlot.id,
      p_offer_count: 3,
      p_expires_in_minutes: 60,
    });
    const receipt = Array.isArray(data) ? data[0] : data;
    if (offerError || !receipt) setError(offerError?.message ?? 'Overtime offer was not confirmed.');
    else {
      setNotice(`Offered to ${receipt.offers_created} staff in seniority order (round ${receipt.offer_round}). Offers expire in 60 minutes.`);
      await load();
    }
    setSaving(false);
  };

  const generateFromTemplates = async () => {
    const operatingBranchId = operatingOrganizationId ?? profile?.organizationId;
    if (!operatingBranchId) return;
    setSaving(true); setError(null); setNotice(null);
    const { data, error: rpcError } = await supabase.rpc('generate_roster_from_templates', {
      p_client_request_id: crypto.randomUUID(),
      p_organization_id: operatingBranchId,
      p_from_date: isoDate(weekStart),
      p_to_date: isoDate(addDays(weekEnd, -1)),
    });
    const receipt = Array.isArray(data) ? data[0] : data;
    if (rpcError || !receipt) setError(rpcError?.message ?? 'Roster generation was not confirmed.');
    else {
      setNotice(`${plural(receipt.slots_generated, 'open draft shift')} created from ${plural(receipt.templates_applied, 'template')}${receipt.templates_skipped ? `; ${receipt.templates_skipped} skipped because their work unit is missing` : ''}. Assign staff to each one, then publish.`);
      setTemplateDialog(null);
      await load();
    }
    setSaving(false);
  };

  const openTemplateDialog = async () => {
    const operatingBranchId = operatingOrganizationId ?? profile?.organizationId;
    if (!operatingBranchId) return;
    setTemplateDialog('loading'); setError(null); setNotice(null);
    const { data, error: previewError } = await supabase.rpc('preview_roster_from_templates', { p_organization_id: operatingBranchId, p_from_date: isoDate(weekStart), p_to_date: isoDate(addDays(weekEnd, -1)) });
    const preview = Array.isArray(data) ? data[0] : data;
    if (previewError || !preview) { setError(previewError?.message ?? 'Template check was not confirmed.'); setTemplateDialog(null); }
    else setTemplateDialog(preview as TemplatePreview);
  };

  const acknowledgeAttendance = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!attendanceAction || !attendanceAction.notes.trim()) return;
    setSaving(true); setError(null); setNotice(null);
    const { error: actionError } = await supabase.rpc('acknowledge_roster_attendance_exception', { p_shift_id: attendanceAction.item.shift_id, p_exception_type: attendanceAction.item.exception_type, p_notes: attendanceAction.notes.trim() });
    if (actionError) setError(actionError.message);
    else { setNotice('Attendance exception acknowledged and recorded.'); setAttendanceAction(null); await load(); }
    setSaving(false);
  };

  const updateCalendarRegion = async (regionCode: string) => {
    const operatingBranchId = operatingOrganizationId ?? profile?.organizationId;
    if (!operatingBranchId) return;
    setSaving(true); setError(null);
    const nextRegion = regionCode || null;
    const { error: regionError } = await supabase.rpc('set_organization_calendar_region', { p_organization_id: operatingBranchId, p_region_code: nextRegion });
    if (regionError) setError(regionError.message); else { setCalendarRegion(nextRegion); setNotice('Regional public holiday calendar updated.'); }
    setSaving(false);
  };

  const openAvailabilityDialog = (staffMember?: Staff, specificDate = isoDate(weekStart)) => {
    setAvailabilityDialog({
      staffId: staffMember?.staffId ?? staff[0]?.staffId ?? '',
      scheduleKind: 'date',
      specificDate,
      dayOfWeek: 1,
      allDay: true,
      availableFrom: '08:00',
      availableTo: '17:00',
      availabilityType: 'unavailable',
      notes: '',
      clientRequestId: crypto.randomUUID(),
      deleteTarget: null,
      deleteReason: '',
      deleteRequestId: crypto.randomUUID(),
    });
    setError(null);
    setNotice(null);
  };

  const saveAvailability = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!availabilityDialog || !availabilityDialog.staffId) return;
    if (!availabilityDialog.allDay && availabilityDialog.availableFrom >= availabilityDialog.availableTo) {
      setError('Availability start time must be before its end time.');
      return;
    }
    if (availabilityDialog.availabilityType === 'unavailable' && !availabilityDialog.notes.trim()) {
      setError('Explain why this staff member cannot work.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      // ATLAS CALLS: manage_staff_availability (replay-safe availability configuration and audit receipt)
      const { data, error: availabilityError } = await supabase.rpc('manage_staff_availability', {
        p_client_request_id: availabilityDialog.clientRequestId,
        p_staff_id: availabilityDialog.staffId,
        p_action: 'create',
        p_day_of_week: availabilityDialog.scheduleKind === 'weekday' ? availabilityDialog.dayOfWeek : undefined,
        p_specific_date: availabilityDialog.scheduleKind === 'date' ? availabilityDialog.specificDate : undefined,
        p_available_from: availabilityDialog.allDay ? undefined : availabilityDialog.availableFrom,
        p_available_to: availabilityDialog.allDay ? undefined : availabilityDialog.availableTo,
        p_all_day: availabilityDialog.allDay,
        p_type: availabilityDialog.availabilityType,
        p_notes: availabilityDialog.notes.trim() || undefined,
      });
      if (availabilityError) {
        setError(availabilityError.message);
        return;
      }
      if (!data?.id) {
        setError('Availability was not confirmed by the server.');
        return;
      }
      setNotice('Staff availability saved with an audit receipt. Roster conflict checks now use this record.');
      setAvailabilityDialog({
        ...availabilityDialog,
        notes: '',
        clientRequestId: crypto.randomUUID(),
      });
      await load();
    } finally {
      setSaving(false);
    }
  };

  const deleteAvailability = async () => {
    if (!availabilityDialog?.deleteTarget || !availabilityDialog.deleteReason.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const { data, error: availabilityError } = await supabase.rpc('manage_staff_availability', {
        p_client_request_id: availabilityDialog.deleteRequestId,
        p_staff_id: availabilityDialog.staffId,
        p_action: 'delete',
        p_availability_id: availabilityDialog.deleteTarget.id,
        p_notes: availabilityDialog.deleteReason.trim(),
      });
      if (availabilityError) {
        setError(availabilityError.message);
        return;
      }
      if (!data?.id) {
        setError('Availability removal was not confirmed by the server.');
        return;
      }
      setNotice('Availability record removed with an audit receipt. Future roster checks no longer use it.');
      setAvailabilityDialog({
        ...availabilityDialog,
        deleteTarget: null,
        deleteReason: '',
        deleteRequestId: crypto.randomUUID(),
      });
      await load();
    } finally {
      setSaving(false);
    }
  };

  return <div className="roster-ops roster-command-workbench" data-surface="dark">
    <header className="roster-ops-header"><div><span>{rosterView.eyebrow}</span><h1>Roster</h1><p>{rosterView.description}</p></div><div><button onClick={() => void load()} disabled={loading} title="Refresh roster" aria-label="Refresh roster"><RefreshCw size={16} className={loading ? 'is-spinning' : ''} /></button>{workUnits.length > 0 && <><button onClick={() => void openPublishDialog()} disabled={saving || loading || draftCount === 0} title={draftCount ? 'Publish every draft shift in this period' : 'No draft shifts in this period'}>Publish {plural(draftCount, 'draft')}</button><button className="is-primary" onClick={() => openCreate()}><Plus size={16} />Create shift</button></>}</div></header>
    <div className="roster-command-bar" aria-label="Roster period and branch">
      <div className="roster-week-nav"><button onClick={() => setPeriodAnchor(moveRosterPeriod(periodAnchor, horizon, -1))} aria-label="Previous period" title="Previous period"><ChevronLeft size={16} /></button><button onClick={() => setPeriodAnchor(new Date())}>Today</button><input type="date" aria-label="Roster range start" value={isoDate(periodAnchor)} onChange={(event) => { if (event.target.value) setPeriodAnchor(new Date(`${event.target.value}T12:00:00`)); }} /><strong>{periodLabel}</strong><button onClick={() => setPeriodAnchor(moveRosterPeriod(periodAnchor, horizon, 1))} aria-label="Next period" title="Next period"><ChevronRight size={16} /></button></div>
      <select aria-label="Roster branch" value={operatingOrganizationId ?? profile?.organizationId ?? ''} onChange={(event) => setOperatingOrganization(event.target.value)}><option value="" disabled>Select branch</option>{operatingOrganizations.filter((context) => context.authorityBasis !== 'corporate_oversight').map((context) => <option key={context.organizationId} value={context.organizationId}>{context.organizationName}</option>)}</select>
      <span className="roster-command-count"><strong>{loading || !rosterDataReady ? '—' : openSlots.length}</strong> uncovered shifts</span>
      <button className="roster-command-count" aria-controls="roster-timesheet-dock" aria-expanded={timesheetsOpen} onClick={() => setTimesheetsOpen((open) => !open)}><strong>{timesheetCount ?? '—'}</strong> timesheet approvals</button>
    </div>
    {workflowContext.workUnitId&&<section className="roster-context-banner" role="status"><div><span>{workflowContext.handoffId?'Mobilisation handoff · roster evidence':'Account flow · roster action'}</span><strong>{requestedWorkUnit?.name??'Loading requested work unit'}</strong><p>{requestedWorkUnit?'Schedule the next officer assignment against the work unit selected during mobilisation.':'The requested work unit is not active in this provider roster.'}</p></div><div><button onClick={()=>navigate('/admin/roster')}>Clear focus</button>{workflowContext.handoffId&&<button onClick={()=>navigate(`/admin/handoffs${workflowContextQuery(workflowContext)}`)}>Return to handoff</button>}<button onClick={()=>navigate(`/admin/roster-targets${workflowContextQuery(workflowContext)}`)}>Open work unit</button><button className="is-primary" onClick={()=>openCreate()} disabled={!requestedWorkUnit}><Plus size={15}/>Create shift for this work unit</button></div></section>}
    {workUnits.length > 0 && <div className="roster-quick-actions"><button type="button" onClick={() => void openTemplateDialog()} disabled={saving || loading}>Fill from templates</button><button type="button" onClick={() => openAvailabilityDialog()} disabled={saving || loading || staff.length === 0}>Staff availability</button><button type="button" onClick={() => navigate(`/admin/roster-targets${workflowContextQuery(workflowContext)}`)}>Work units</button><button type="button" aria-controls="roster-timesheet-dock" aria-expanded={timesheetsOpen} onClick={() => setTimesheetsOpen(true)}>Timesheets &amp; approvals</button><button type="button" onClick={() => navigate('/admin/people-hr?tab=timesheets')}>Open HR workspace</button></div>}
    {availabilityDialog && <div className="roster-dialog-backdrop"><form className="roster-dialog roster-availability-dialog" onSubmit={saveAvailability} role="dialog" aria-modal="true" aria-labelledby="staff-availability-title"><header><div><span>Workforce readiness</span><h2 id="staff-availability-title">Staff availability</h2></div><button type="button" onClick={() => setAvailabilityDialog(null)} aria-label="Close staff availability"><X /></button></header><p className="roster-dialog-note">Configure when a staff member can or cannot be rostered. Approved leave remains governed in People, Pay &amp; HR.</p><label><span>Staff member</span><select value={availabilityDialog.staffId} onChange={(event) => setAvailabilityDialog({ ...availabilityDialog, staffId: event.target.value, deleteTarget: null, deleteReason: '' })}>{staff.map((person) => <option value={person.staffId} key={person.staffId}>{person.name}</option>)}</select></label><div className="roster-availability-grid"><label><span>Schedule</span><select value={availabilityDialog.scheduleKind} onChange={(event) => setAvailabilityDialog({ ...availabilityDialog, scheduleKind: event.target.value as AvailabilityDialog['scheduleKind'] })}><option value="date">One date</option><option value="weekday">Every weekday</option></select></label>{availabilityDialog.scheduleKind === 'date' ? <label><span>Date</span><input type="date" required value={availabilityDialog.specificDate} onChange={(event) => setAvailabilityDialog({ ...availabilityDialog, specificDate: event.target.value })} /></label> : <label><span>Weekday</span><select value={availabilityDialog.dayOfWeek} onChange={(event) => setAvailabilityDialog({ ...availabilityDialog, dayOfWeek: Number(event.target.value) })}>{['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((label, index) => <option value={index + 1} key={label}>{label}</option>)}</select></label>}<label><span>Availability</span><select value={availabilityDialog.availabilityType} onChange={(event) => setAvailabilityDialog({ ...availabilityDialog, availabilityType: event.target.value as AvailabilityDialog['availabilityType'] })}><option value="unavailable">Unavailable</option><option value="preferred">Preferred</option><option value="available">Available</option></select></label></div><label className="roster-availability-all-day"><input type="checkbox" checked={availabilityDialog.allDay} onChange={(event) => setAvailabilityDialog({ ...availabilityDialog, allDay: event.target.checked })} /><span>Applies all day</span></label>{!availabilityDialog.allDay && <div className="roster-availability-grid"><label><span>From</span><input type="time" required value={availabilityDialog.availableFrom} onChange={(event) => setAvailabilityDialog({ ...availabilityDialog, availableFrom: event.target.value })} /></label><label><span>To</span><input type="time" required value={availabilityDialog.availableTo} onChange={(event) => setAvailabilityDialog({ ...availabilityDialog, availableTo: event.target.value })} /></label></div>}<label><span>{availabilityDialog.availabilityType === 'unavailable' ? 'Reason' : 'Notes'}</span><textarea rows={2} required={availabilityDialog.availabilityType === 'unavailable'} value={availabilityDialog.notes} onChange={(event) => setAvailabilityDialog({ ...availabilityDialog, notes: event.target.value })} placeholder={availabilityDialog.availabilityType === 'unavailable' ? 'Why can this staff member not work?' : 'Optional roster planning context'} /></label><section className="roster-availability-current" aria-labelledby="current-availability-title"><header><div><span>Current period</span><h3 id="current-availability-title">Recorded availability</h3></div><strong>{availability.filter((record) => record.staff_id === availabilityDialog.staffId).length}</strong></header>{availability.filter((record) => record.staff_id === availabilityDialog.staffId).length === 0 ? <p>No availability records for this staff member in the displayed period.</p> : <div>{availability.filter((record) => record.staff_id === availabilityDialog.staffId).map((record) => <article key={record.id}><div><strong>{record.specific_date ? new Date(`${record.specific_date}T12:00:00`).toLocaleDateString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short' }) : `Every ${['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][(record.day_of_week ?? 1) - 1]}`}</strong><span>{record.all_day ? 'All day' : `${record.available_from?.slice(0, 5)}–${record.available_to?.slice(0, 5)}`} · {record.availability_type}</span>{record.notes && <small>{record.notes}</small>}</div><button type="button" disabled={saving} onClick={() => setAvailabilityDialog({ ...availabilityDialog, deleteTarget: record, deleteReason: '', deleteRequestId: crypto.randomUUID() })}>Remove</button></article>)}</div>}{availabilityDialog.deleteTarget && <div className="roster-availability-remove" role="group" aria-label="Confirm availability removal"><p>Remove this availability record? Existing roster decisions remain in history, but future conflict checks will stop using it.</p><label><span>Removal reason</span><textarea rows={2} required value={availabilityDialog.deleteReason} onChange={(event) => setAvailabilityDialog({ ...availabilityDialog, deleteReason: event.target.value })} /></label><div><button type="button" onClick={() => setAvailabilityDialog({ ...availabilityDialog, deleteTarget: null, deleteReason: '' })}>Keep record</button><button type="button" className="is-danger" disabled={saving || !availabilityDialog.deleteReason.trim()} onClick={() => void deleteAvailability()}>Confirm removal</button></div></div>}</section><footer><button type="button" onClick={() => setAvailabilityDialog(null)}>Close</button><button type="submit" disabled={saving || !availabilityDialog.staffId || (availabilityDialog.availabilityType === 'unavailable' && !availabilityDialog.notes.trim())}>Save availability</button></footer></form></div>}
    {repeatDialog && <div className="roster-dialog-backdrop"><form className="roster-dialog" onSubmit={repeatSelected} role="dialog" aria-modal="true" aria-labelledby="repeat-roster-title"><header><div><span>Roster planning</span><h2 id="repeat-roster-title">Repeat assignment</h2></div><button type="button" onClick={() => setRepeatDialog(null)}><X /></button></header><p>Creates draft assignments and skips overlapping or leave-conflicted days.</p><label><span>From date</span><input type="date" required value={repeatDialog.from} onChange={(event) => setRepeatDialog({ ...repeatDialog, from: event.target.value })} /></label><label><span>To date</span><input type="date" required value={repeatDialog.to} onChange={(event) => setRepeatDialog({ ...repeatDialog, to: event.target.value })} /></label><footer><button type="button" onClick={() => setRepeatDialog(null)}>Cancel</button><button type="submit" disabled={saving}>Create draft repeats</button></footer></form></div>}
    {publishDialog && <div className="roster-dialog-backdrop"><form className="roster-dialog" onSubmit={(event) => { event.preventDefault(); void batchPublishPeriod(); }} role="dialog" aria-modal="true" aria-labelledby="publish-period-title"><header><div><span>Publish</span><h2 id="publish-period-title">Publish {plural(draftCount, 'draft shift')}?</h2></div><button type="button" onClick={() => setPublishDialog(null)}><X /></button></header>{publishDialog === 'loading' ? <p className="roster-dialog-note">Checking the drafts in {periodLabel}…</p> : <ul className="roster-dialog-facts"><li><strong>{publishDialog.draft_count}</strong><span>draft shift{publishDialog.draft_count === 1 ? '' : 's'} in {periodLabel} will be published. Officers see them on their schedule and can accept or decline.</span></li>{publishDialog.leave_conflict_count > 0 && <li className="is-warning"><strong>{publishDialog.leave_conflict_count}</strong><span>clash with approved leave and will be skipped. Reassign them first.</span></li>}{publishDialog.unassigned_count > 0 && <li className="is-warning"><strong>{publishDialog.unassigned_count}</strong><span>have nobody assigned yet. They are published as open shifts for you to fill – assign someone or offer overtime.</span></li>}<li><strong>{publishDialog.field_shift_count}</strong><span>{publishDialog.field_shift_count === 1 ? 'is' : 'are'} field work (patrol run or static post) and get a shift record the officer can start. The rest are office or internal work.</span></li></ul>}<footer><button type="button" onClick={() => setPublishDialog(null)}>Back</button><button type="submit" disabled={saving || publishDialog === 'loading' || publishDialog.draft_count === 0}>Publish now</button></footer></form></div>}
    {templateDialog && <div className="roster-dialog-backdrop"><form className="roster-dialog" onSubmit={(event) => { event.preventDefault(); void generateFromTemplates(); }} role="dialog" aria-modal="true" aria-labelledby="template-fill-title"><header><div><span>Templates</span><h2 id="template-fill-title">Fill {periodLabel} from templates?</h2></div><button type="button" onClick={() => setTemplateDialog(null)}><X /></button></header>{templateDialog === 'loading' ? <p className="roster-dialog-note">Checking your shift templates…</p> : <ul className="roster-dialog-facts"><li><strong>{templateDialog.new_slots}</strong><span>new draft shift{templateDialog.new_slots === 1 ? '' : 's'} will be created from {plural(templateDialog.templates_applied, 'active template')}. Nobody is assigned yet – assign staff, then publish.</span></li><li><strong>{templateDialog.existing_slots}</strong><span>already exist for these times and will not be duplicated.</span></li></ul>}<footer><button type="button" onClick={() => setTemplateDialog(null)}>Back</button><button type="submit" disabled={saving || templateDialog === 'loading' || templateDialog.new_slots === 0}>Create drafts</button></footer></form></div>}
    {attendanceAction && <div className="roster-dialog-backdrop"><form className="roster-dialog" onSubmit={acknowledgeAttendance} role="dialog" aria-modal="true" aria-labelledby="attendance-action-title"><header><div><span>Attendance control</span><h2 id="attendance-action-title">Acknowledge exception</h2></div><button type="button" onClick={() => setAttendanceAction(null)}><X /></button></header><p>Record the supervisor decision for this {attendanceAction.item.exception_type.replaceAll('_', ' ')} exception.</p><label><span>Action notes</span><textarea required rows={4} value={attendanceAction.notes} onChange={(event) => setAttendanceAction({ ...attendanceAction, notes: event.target.value })} /></label><footer><button type="button" onClick={() => setAttendanceAction(null)}>Cancel</button><button type="submit" disabled={saving || !attendanceAction.notes.trim()}>Acknowledge exception</button></footer></form></div>}
    {error && <div className="roster-message is-error" role="alert"><AlertTriangle size={17} /><span>{error}</span><button onClick={() => setError(null)}><X size={16} /></button></div>}{notice && <div className="roster-message is-success" role="status"><ShieldCheck size={17} /><span>{notice}</span><button onClick={() => setNotice(null)}><X size={16} /></button></div>}
    {showCreate && staff.some((person) => person.workReady && person.credentialRisk !== 'clear') && <div className="roster-message is-warning" role="status"><AlertTriangle size={17} /><span>Credential-risk staff remain visible for planning context, but only credential-clear officers can be submitted for a new assignment.</span></div>}
    {!loading && rosterDataReady && workUnits.length === 0 && <section className="roster-context-banner roster-setup-banner" role="status"><div><span>Before you roster</span><strong>Nothing to roster against yet</strong><p>Every shift covers a work unit. Build a patrol run from a client agreement in Client Portfolios, or set up a static post or office work unit.{staff.length === 0 ? ' Add rosterable staff in People, Pay & HR as well.' : ` ${plural(staff.length, 'staff member')} will be ready to schedule once a work unit exists.`}</p></div><div><button type="button" onClick={() => navigate('/admin/crm')}>Client Portfolios</button><button type="button" onClick={() => navigate(`/admin/roster-targets${workflowContextQuery(workflowContext)}`)}>Work units</button>{staff.length === 0 && <button type="button" onClick={() => navigate('/admin/people-hr')}>People, Pay &amp; HR</button>}</div></section>}
    <div className="roster-workbench-panes">
    <aside className="roster-directory" aria-label="Officer directory">
      <header><strong>Officer directory</strong><span>{loading || !rosterDataReady ? '—' : visibleStaff.length}</span></header>
      <label className="roster-directory-search"><Search size={15} /><input aria-label="Search officers" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find officer" /></label>
      {scheduleMode === 'staff' && <div className="roster-readiness"><Filter size={14} />{([['all', 'All'], ['ready', 'Ready'], ['risk', 'At risk']] as Array<[ReadinessFilter, string]>).map(([item, label]) => <button className={readiness === item ? 'is-active' : ''} aria-pressed={readiness === item} onClick={() => setReadiness(item)} key={item}>{label}</button>)}</div>}
      <button className="roster-directory-all" aria-pressed={!selectedStaffId} onClick={() => setSelectedStaffId(null)}>All officers</button>
      <div className="roster-directory-list">
        {loading ? <p role="status">Loading authorised officers…</p> : !rosterDataReady ? <p role="status">Roster reads unavailable. Select an authorised branch or refresh.</p> : visibleStaff.length === 0 ? <p>No matching officers. Clear search or check branch eligibility in HR.</p> : visibleStaff.map((person) => {
          const constraints = days.filter((day) => restrictionsForDay(person.staffId, day).length > 0 || leave.some((record) => record.staff_id === person.staffId && record.starts_on <= isoDate(day) && record.ends_on >= isoDate(day))).length;
          const recorded = availability.some((record) => record.staff_id === person.staffId);
          return <button key={person.staffId} className="roster-directory-person" aria-pressed={selectedStaffId === person.staffId} onClick={() => { setSelectedStaffId(selectedStaffId === person.staffId ? null : person.staffId); setScheduleMode('staff'); }}><strong>{person.name}</strong><small>{person.employmentType ? plainWords(person.employmentType) : 'Employment not recorded'}</small><span className={person.credentialRisk === 'clear' ? 'is-ready' : 'is-risk'}>{credentialBadgeWords(person)}</span><small>{person.workReady ? 'Work ready' : 'Not work ready'} · {constraints ? `${constraints} restricted days` : recorded ? 'Availability recorded' : 'Availability not recorded'}</small></button>;
        })}
      </div>
    </aside>
    <main className="roster-schedule-pane" aria-label="Roster schedule and reconciliation">
    {(loading || workUnits.length > 0) && <>
    <div className="roster-schedule-mode" aria-label="Scheduling view"><button type="button" className={scheduleMode === 'staff' ? 'is-active' : ''} aria-pressed={scheduleMode === 'staff'} onClick={() => setScheduleMode('staff')}>Staff schedule</button><button type="button" className={scheduleMode === 'work-unit' ? 'is-active' : ''} aria-pressed={scheduleMode === 'work-unit'} onClick={() => setScheduleMode('work-unit')}>Work unit schedule</button>{selectedStaffId && <button type="button" onClick={() => setSelectedStaffId(null)}>Clear officer focus</button>}{scheduleMode === 'work-unit' && <input aria-label="Search work units" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find work unit" />}</div>
    <div className="roster-horizon-bar"><div className="roster-horizon" aria-label="Roster horizon">{([['week', 'Week'], ['fortnight', '2 weeks'], ['month', 'Month']] as const).map(([value, label]) => <button type="button" className={horizon === value ? 'is-active' : ''} aria-pressed={horizon === value} onClick={() => { setHorizon(value); setPeriodAnchor(new Date()); }} key={value}>{label}</button>)}</div><label><span>Regional holidays</span><select value={calendarRegion ?? ''} disabled={saving} onChange={(event) => void updateCalendarRegion(event.target.value)}><option value="">National only</option>{NZ_HOLIDAY_REGIONS.map(([code, name]) => <option value={code} key={code}>{name}</option>)}</select></label></div>
    {holidays.length > 0 && <section className="roster-holidays" aria-label="Public holidays">{holidays.map((holiday) => <div className={`is-${holiday.scope}`} key={`${holiday.date}-${holiday.name}`}><CalendarDays size={14} /><span>{new Date(`${holiday.date}T12:00:00`).toLocaleDateString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short' })}</span><strong>{holiday.name}</strong><i>{holiday.scope}</i></div>)}</section>}
    <details className="roster-secondary-dock"><summary>Historical source records · {historicalAssignments.length}</summary><section className="roster-history" aria-labelledby="roster-history-title">
      <header><div><span>Historical source records</span><h2 id="roster-history-title">Forestry roster history</h2></div><strong>{historicalAssignments.length}</strong></header>
      <div className="roster-history-table-wrap">
        {historicalAssignments.length === 0 ? <p className="roster-history-empty">No historical assignments in this period.</p> : <table><caption className="sr-only">Historical forestry roster assignments in {periodLabel}</caption><thead><tr><th scope="col">Date</th><th scope="col">Officer</th><th scope="col">Patrol</th><th scope="col">Shift</th><th scope="col">Beat evidence</th></tr></thead><tbody>{historicalAssignments.map((assignment) => {
          const historicalOfficer = Array.isArray(assignment.officer) ? assignment.officer[0] : assignment.officer;
          const officerName = historicalOfficer?.display_name ?? historicalOfficer?.email ?? staff.find((person) => person.id === assignment.officer_id)?.name ?? 'Unmatched officer';
          const routeName = patrolRoutes.find((route) => route.id === assignment.patrol_route_id)?.name ?? 'Forestry patrol';
          const shiftName = assignment.shift === 'swing' ? 'Evening' : assignment.shift.charAt(0).toUpperCase() + assignment.shift.slice(1);
          const times = assignment.start_time ? `${assignment.start_time.slice(0, 5)}${assignment.end_time ? `–${assignment.end_time.slice(0, 5)}` : ''}` : 'Time not recorded';
          const beats = assignment.external_refs?.beat_names?.join(', ') || `${assignment.external_refs?.source_event_count ?? 0} field entries`;
          return <tr key={assignment.id}><td>{new Date(`${assignment.specific_date}T12:00:00`).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' })}</td><td>{officerName}</td><td>{routeName}</td><td>{shiftName} · {times}</td><td>{beats}</td></tr>;
        })}</tbody></table>}
      </div>
    </section></details>
    <p className="roster-board-scroll-cue" role="note">Scroll within the schedule to keep the dates and staff or work units visible.</p>
    <div className={`roster-board is-${horizon}`} style={{ '--roster-days': days.length } as React.CSSProperties}>
      <div className="roster-board-head">
        <div>{scheduleMode === 'staff' ? 'Staff' : 'Work unit'}</div>
        {days.map((day) => {
          const holiday = holidays.find((item) => item.date === isoDate(day));
          return <div className={`${isoDate(day) === isoDate(new Date()) ? 'is-today' : ''} ${holiday ? 'is-holiday' : ''}`} title={holiday?.name} key={day.toISOString()}><span>{day.toLocaleDateString('en-NZ', { weekday: 'short' })}</span><strong>{day.getDate()}</strong>{holiday && <small>Holiday</small>}</div>;
        })}
      </div>
      {loading ? <div className="roster-empty"><RefreshCw className="is-spinning" />Loading roster</div> : !rosterDataReady ? <div className="roster-empty roster-empty-guide"><strong>Roster data could not be confirmed</strong><p>Refresh or select an authorised branch. Missing reads are not an empty roster.</p><button onClick={() => void load()}>Retry roster</button></div> : scheduleMode === 'staff' && staff.length === 0 ? <div className="roster-empty roster-empty-guide"><strong>No rosterable staff in this branch yet</strong><p>Staff appear here once People, Pay &amp; HR has added them, granted them access to this branch as roster eligible, and marked them work-ready.</p><button type="button" onClick={() => navigate('/admin/people-hr')}>Open People, Pay &amp; HR</button></div> : scheduleMode === 'staff' ? (scheduleStaff.length === 0 ? <div className="roster-empty roster-empty-guide"><strong>No staff match this search or filter</strong><button type="button" onClick={() => { setSearch(''); setReadiness('all'); setSelectedStaffId(null); }}>Show everyone</button></div> : <>
      {openSlots.length > 0 && <div className="roster-row roster-open-row">
        <div className="roster-person roster-open-label"><span>{openSlots.length}</span><div><strong>Open shifts</strong><small>Nobody assigned yet</small></div></div>
        {days.map((day) => {
          const key = isoDate(day);
          const dayOpen = openSlots.filter((slot) => isoDate(new Date(slot.scheduled_start)) === key);
          return <div className="roster-cell" key={key}>{dayOpen.map((slot) => { const unit = workUnits.find((item) => item.id === slot.work_unit_id); return <button type="button" className={`roster-shift roster-slot is-open type-${unit?.work_unit_type ?? 'internal'} status-${slot.status}`} onClick={() => setSelectedSlotId(slot.id)} title={`${unit?.name ?? 'Roster slot'} · ${slotStatusLabel(slot.status)}`} key={slot.id}><strong>{timeRange(slot.scheduled_start, slot.scheduled_end)}</strong><span>{unit?.name ?? 'Roster slot'}</span><small>{slotStatusLabel(slot.status)}</small></button>; })}</div>;
        })}
      </div>}
      {scheduleStaff.map((person) => (
        <div className="roster-row" key={person.id}>
          <button className="roster-person" onClick={() => openCreate(person)}><span>{person.name.split(' ').map((value) => value[0]).join('').slice(0, 2)}</span><div><strong>{person.name}</strong><small>{person.employmentType ?? 'Employment unset'}</small></div><i className={person.workReady && person.credentialRisk === 'clear' ? 'is-ready' : 'is-risk'}>{credentialBadgeWords(person)}</i></button>
          {days.map((day) => {
            const key = isoDate(day);
            const dayShifts = shifts.filter((shift) => shift.officer_user_id === person.id && isoDate(new Date(shift.scheduled_start)) === key);
            const daySlots = slots.filter((slot) => slot.staff_id === person.staffId && !slot.linked_shift_id && isoDate(new Date(slot.scheduled_start)) === key);
            const onLeave = leave.some((record) => record.staff_id === person.staffId && record.starts_on <= key && record.ends_on >= key);
            return <div className={`roster-cell ${onLeave ? 'is-leave' : ''}`} key={key}>{onLeave && <span className="roster-leave">Leave</span>}{dayShifts.map((shift) => <button className={`roster-shift status-${shift.status}`} onClick={() => setSelectedShiftId(shift.id)} title={`${shift.service_type.replaceAll('_', ' ')} · ${plainWords(shift.status)}`} key={shift.id}><strong>{timeRange(shift.scheduled_start, shift.scheduled_end)}</strong><span>{shift.service_type.replaceAll('_', ' ')}</span><small>{shiftStatusLabel(shift.status)}</small></button>)}{daySlots.map((slot) => { const unit = workUnits.find((item) => item.id === slot.work_unit_id); return <button type="button" className={`roster-shift roster-slot type-${unit?.work_unit_type ?? 'internal'} status-${slot.status}`} onClick={() => setSelectedSlotId(slot.id)} title={`${unit?.name ?? 'Roster slot'} · ${slotStatusLabel(slot.status)}`} key={slot.id}><strong>{timeRange(slot.scheduled_start, slot.scheduled_end)}</strong><span>{unit?.name ?? 'Roster slot'}</span><small>{slotStatusLabel(slot.status)}</small></button>; })}{!onLeave && dayShifts.length === 0 && daySlots.length === 0 && <button className="roster-add" onClick={() => openCreate(person, day)} aria-label={`Add shift for ${person.name} on ${day.toLocaleDateString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short' })}`}>+</button>}</div>;
          })}
        </div>
      ))}</>) : (visibleWorkUnits.length === 0 ? <div className="roster-empty roster-empty-guide"><strong>No work units match this search</strong><button type="button" onClick={() => { setSearch(''); }}>Show all work units</button></div> : <>
      {openSlots.length > 0 && <div className="roster-row roster-open-row">
        <div className="roster-person roster-open-label"><span>{openSlots.length}</span><div><strong>Open shifts</strong><small>Need assignment</small></div></div>
        {days.map((day) => {
          const key = isoDate(day);
          const dayOpen = openSlots.filter((slot) => isoDate(new Date(slot.scheduled_start)) === key);
          return <div className="roster-cell" key={key}>{dayOpen.map((slot) => { const unit = workUnits.find((item) => item.id === slot.work_unit_id); return <button type="button" className={`roster-shift roster-slot is-open type-${unit?.work_unit_type ?? 'internal'} status-${slot.status}`} onClick={() => setSelectedSlotId(slot.id)} title={`${unit?.name ?? 'Roster slot'} · ${slotStatusLabel(slot.status)}`} key={slot.id}><strong>{timeRange(slot.scheduled_start, slot.scheduled_end)}</strong><span>{unit?.name ?? 'Roster slot'}</span><small>{slotStatusLabel(slot.status)}</small></button>; })}</div>;
        })}
      </div>}
      {visibleWorkUnits.map((unit) => (
        <div className="roster-row" key={unit.id}>
          <button className="roster-person" onClick={() => openCreate(undefined, undefined, unit.id)}><span>{unit.name.split(' ').map((value) => value[0]).join('').slice(0, 2)}</span><div><strong>{unit.name}</strong><small>{workUnitTypeLabel(unit.work_unit_type)}</small></div><i className="is-ready">Schedule</i></button>
          {days.map((day) => {
            const key = isoDate(day);
            const dayAssignments = slots.filter((slot) => slot.work_unit_id === unit.id && isoDate(new Date(slot.scheduled_start)) === key);
            return <div className="roster-cell" key={key}>{dayAssignments.map((slot) => <button type="button" className={`roster-shift roster-slot type-${unit.work_unit_type} status-${slot.status}`} onClick={() => setSelectedSlotId(slot.id)} title={`${unit.name} · ${slotStatusLabel(slot.status)}`} key={slot.id}><strong>{timeRange(slot.scheduled_start, slot.scheduled_end)}</strong><span>{slot.staff_id ? 'Assigned' : 'Open'}</span><small>{slotStatusLabel(slot.status)}</small></button>)}{dayAssignments.length === 0 && <button className="roster-add" onClick={() => openCreate(undefined, day, unit.id)} aria-label={`Add shift for ${unit.name} on ${day.toLocaleDateString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short' })}`}>+</button>}</div>;
          })}
        </div>
      ))}</>)}
    </div>
    <details className="roster-secondary-dock roster-operational-dock"><summary>Operational exceptions &amp; all shifts</summary>
    <section className="roster-metrics"><div><Users size={18} /><span>Rosterable staff</span><strong>{staff.length}</strong></div><div><AlertTriangle size={18} /><span>Readiness risks</span><strong>{riskCount}</strong></div><div><Clock3 size={18} /><span>Scheduled hours</span><strong>{Math.round(totalHours)}</strong></div><div><CalendarDays size={18} /><span>Open coverage requests</span><strong>{coverage.length}</strong></div>{labourCost.length > 0 && <div><span>Labour forecast / unpriced slots</span><strong>NZ${labourCostTotals.pay.toFixed(0)} / {labourCostTotals.unpriced}</strong></div>}</section>
    {availabilityOccurrences.length > 0 && <section className="roster-availability-queue"><header><div><span>Staff constraints</span><h2>Availability restrictions</h2></div><strong>{availabilityOccurrences.length}</strong></header><div>{availabilityOccurrences.map(({ day, person, record }, index) => <button type="button" onClick={() => openAvailabilityDialog(person, isoDate(day))} key={`${person.staffId}-${isoDate(day)}-${index}`}><AlertTriangle size={15} /><div><strong>{person.name}</strong><small>{day.toLocaleDateString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short' })} · {record.all_day || !record.available_from || !record.available_to ? 'Unavailable all day' : `${record.available_from.slice(0, 5)}–${record.available_to.slice(0, 5)}`}</small></div><i>Manage</i></button>)}</div></section>}
    {commercialExceptions.length > 0 && <section className="roster-commercial-queue"><header><div><span>Finance & geography</span><h2>Commercial readiness exceptions</h2></div><strong>{commercialExceptions.length}</strong></header><div>{commercialExceptions.map((readiness) => { const slot = slots.find((item) => item.id === readiness.slot_id); const unit = slot ? workUnits.find((item) => item.id === slot.work_unit_id) : null; const issues = Object.entries(readiness).filter(([key, value]) => key !== 'slot_id' && !['ready', 'accepted', 'verified', 'not_applicable'].includes(value)).map(([key]) => key.replace('_status', '').replace('_', ' ')); return <button type="button" onClick={() => setSelectedSlotId(readiness.slot_id)} key={readiness.slot_id}><AlertTriangle size={15} /><div><strong>{unit?.name ?? 'Roster slot'}</strong><small>{issues.join(' · ')}</small></div><i>Review</i></button>; })}</div></section>}
    {attendanceExceptions.length > 0 && <section className="roster-commercial-queue roster-attendance-queue"><header><div><span>Attendance control</span><h2>Roster attendance exceptions</h2></div><strong>{attendanceExceptions.length}</strong></header><div>{attendanceExceptions.map((exception) => <article key={exception.shift_id} className={exception.exception_type === 'missed' ? 'is-missed' : ''}><AlertTriangle size={15} /><div><strong>{ATTENDANCE_EXCEPTION_LABEL[exception.exception_type]}</strong><small>{exception.service_type.replaceAll('_', ' ')} · {new Date(exception.scheduled_start).toLocaleString('en-NZ')}</small></div><i>{exception.exception_type === 'missed' ? `${exception.minutes_overdue} min unattended` : `${exception.minutes_overdue} min`}</i><button type="button" onClick={() => setAttendanceAction({ item: exception, notes: '' })}>Acknowledge</button></article>)}</div></section>}
    {slots.length > 0 && <section className="roster-slot-queue"><header><div><span>Everything rostered</span><h2>All shifts this period</h2></div><strong>{slots.length}</strong></header><div>{slots.map((slot) => { const unit = workUnits.find((item) => item.id === slot.work_unit_id); const person = staff.find((item) => item.staffId === slot.staff_id); return <button type="button" className={`status-${slot.status}`} onClick={() => setSelectedSlotId(slot.id)} key={slot.id}><span className={`type-${unit?.work_unit_type ?? 'internal'}`}>{unit ? workUnitTypeLabel(unit.work_unit_type) : 'slot'}</span><div><strong>{unit?.name ?? 'Roster slot'}</strong><small>{person?.name ?? (slot.staff_id ? 'Staff member' : 'Nobody assigned')} · {new Date(slot.scheduled_start).toLocaleString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</small></div><i>{slotStatusLabel(slot.status)}</i></button>; })}</div></section>}
    </details>
    </>}
    <details id="roster-timesheet-dock" className="roster-secondary-dock roster-timesheet-dock" open={timesheetsOpen} onToggle={(event) => setTimesheetsOpen(event.currentTarget.open)}><summary>Timesheet reconciliation · {timesheetCount ?? 'unknown'} awaiting review</summary><RosterTimesheetPanel key={`${operatingOrganizationId ?? profile?.organizationId}-${isoDate(weekStart)}-${isoDate(weekEnd)}`} from={isoDate(weekStart)} to={isoDate(addDays(weekEnd, -1))} staffId={selectedStaffId} staffNames={Object.fromEntries(staff.map((person) => [person.staffId, person.name]))} onPendingCount={setTimesheetCount} /></details>
    </main></div>
    {selectedShift && <aside className="roster-inspector"><header><div><span>Assignment</span><h2>{selectedOfficer?.name ?? 'Officer'}</h2></div><button onClick={() => setSelectedShiftId(null)} aria-label="Close"><X /></button></header><dl><div><dt>Service</dt><dd>{plainWords(selectedShift.service_type)}</dd></div><div><dt>Status</dt><dd>{shiftStatusLabel(selectedShift.status)}</dd></div><div><dt>Rostered</dt><dd>{new Date(selectedShift.scheduled_start).toLocaleString('en-NZ')} – {new Date(selectedShift.scheduled_end).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' })}</dd></div>{selectedShift.actual_start && <div><dt>Worked</dt><dd>{workedWords(selectedShift)}</dd></div>}{selectedShift.status === 'completed' && <div><dt>How it ended</dt><dd>{endedWords(selectedShift.ended_reason)}</dd></div>}<div><dt>Stops</dt><dd>{selectedShift.total_stops === 0 ? 'None on this shift' : `${selectedShift.completed_stops ?? 0} of ${selectedShift.total_stops} done`}</dd></div><div><dt>Health</dt><dd>{plainWords(selectedShift.shift_health, 'Not calculated yet')}</dd></div></dl>{selectedShift.notes && <p>{selectedShift.notes}</p>}</aside>}
    {selectedSlot && <aside className="roster-inspector roster-slot-inspector"><header><div><span>Roster slot</span><h2>{selectedSlotUnit?.name ?? 'Typed assignment'}</h2></div><button onClick={() => setSelectedSlotId(null)} aria-label="Close"><X /></button></header><dl><div><dt>Staff</dt><dd>{selectedSlotStaff?.name ?? (selectedSlot.staff_id ? 'Unknown' : 'Nobody assigned')}</dd></div><div><dt>Type</dt><dd>{workUnitTypeLabel(selectedSlotUnit?.work_unit_type)}</dd></div><div><dt>Status</dt><dd>{slotStatusLabel(selectedSlot.status)}</dd></div><div><dt>Start</dt><dd>{new Date(selectedSlot.scheduled_start).toLocaleString('en-NZ')}</dd></div><div><dt>End</dt><dd>{new Date(selectedSlot.scheduled_end).toLocaleString('en-NZ')}</dd></div><div><dt>Field shift</dt><dd>{selectedSlot.linked_shift_id ? 'Created \u2013 the officer can start it' : selectedSlotUnit?.work_unit_type === 'internal' ? 'Not needed for office work' : 'Created when published'}</dd></div>{selectedCommercialReadiness && <><div><dt>Wage rule</dt><dd>{plainWords(selectedCommercialReadiness.pay_status)}</dd></div><div><dt>Billing</dt><dd>{plainWords(selectedCommercialReadiness.billing_status)}</dd></div><div><dt>Quote</dt><dd>{plainWords(selectedCommercialReadiness.quote_status)}</dd></div><div><dt>Geofence</dt><dd>{plainWords(selectedCommercialReadiness.geofence_status)}</dd></div><div><dt>Cost centre</dt><dd>{plainWords(selectedCommercialReadiness.cost_centre_status)}</dd></div></>}</dl>{selectedSlot.notes && <p>{selectedSlot.notes}</p>}<footer>{!['completed', 'cancelled'].includes(selectedSlot.status) && <><button type="button" onClick={() => openCopy(selectedSlot)}>Copy selected</button><button type="button" onClick={() => setRepeatDialog({ slot: selectedSlot, from: isoDate(addDays(new Date(selectedSlot.scheduled_start), 7)), to: isoDate(addDays(new Date(selectedSlot.scheduled_start), 13)) })}>Repeat selected</button></>}{selectedSlot.status === 'draft' && <button className="is-primary" onClick={() => setSlotAction('publish')}>Publish slot</button>}{['draft', 'published', 'declined'].includes(selectedSlot.status) && <button disabled={saving} onClick={() => void offerOvertime()}>Offer overtime</button>}{['published', 'accepted'].includes(selectedSlot.status) && <button onClick={() => { setSlotReason(''); setSlotAction('unpublish'); }}>Recall to draft</button>}{['draft', 'published', 'accepted', 'declined'].includes(selectedSlot.status) && <button onClick={() => { setReplacementStaffId(''); setSlotReason(''); setSlotAction('reassign'); }}>Reassign</button>}{['draft', 'published', 'accepted'].includes(selectedSlot.status) && <button onClick={() => { setSlotReason(''); setSlotAction('cancel'); }}>Cancel slot</button>}</footer></aside>}
    {selectedSlot && slotAction && <div className="roster-dialog-backdrop"><form className="roster-dialog roster-slot-dialog" onSubmit={manageSlot} role="dialog" aria-modal="true" aria-labelledby="slot-action-title"><header><div><span>Roster lifecycle</span><h2 id="slot-action-title">{slotAction === 'publish' ? 'Publish roster slot?' : slotAction === 'unpublish' ? 'Recall roster slot to draft?' : slotAction === 'reassign' ? 'Reassign roster slot?' : 'Cancel roster slot?'}</h2></div><button type="button" onClick={() => setSlotAction(null)}><X /></button></header><p>{slotAction === 'publish' ? 'The officer will see this shift on their schedule and can accept or decline it. Field work also gets its shift record now; office and internal work stays a roster slot only.' : slotAction === 'unpublish' ? 'The slot goes back to draft. If its shift has not started, the shift is cancelled.' : slotAction === 'reassign' ? 'The replacement officer must accept the assignment. The shift only moves to them if nothing has been recorded on it yet.' : 'If the linked shift has not started and nothing has been recorded on it, it is cancelled too.'}</p>{slotAction === 'reassign' && <label><span>Replacement officer</span><select required value={replacementStaffId} onChange={(event) => setReplacementStaffId(event.target.value)}><option value="">Select work-ready staff</option>{staff.filter((person) => person.workReady && person.staffId !== selectedSlot.staff_id).map((person) => <option value={person.staffId} key={person.staffId}>{person.name}</option>)}</select></label>}{slotAction !== 'publish' && <label><span>{slotAction === 'reassign' ? 'Reassignment reason' : slotAction === 'unpublish' ? 'Recall reason' : 'Cancellation reason'}</span><textarea required rows={4} value={slotReason} onChange={(event) => setSlotReason(event.target.value)} /></label>}<footer><button type="button" onClick={() => setSlotAction(null)}>Back</button><button type="submit" disabled={saving || (slotAction !== 'publish' && (!slotReason.trim() || (slotAction === 'reassign' && !replacementStaffId)))}>{saving ? 'Saving' : slotAction === 'publish' ? 'Confirm publication' : slotAction === 'unpublish' ? 'Confirm recall' : slotAction === 'reassign' ? 'Confirm reassignment' : 'Confirm cancellation'}</button></footer></form></div>}
    {showCreate && <div className="roster-dialog-backdrop"><form className="roster-dialog" onSubmit={createAssignment} role="dialog" aria-modal="true" aria-labelledby="create-shift-title"><header><div><span>Roster assignment</span><h2 id="create-shift-title">Create shift</h2></div><button type="button" onClick={() => setShowCreate(false)}><X /></button></header><label htmlFor="roster-officer"><span>Officer</span></label><select id="roster-officer" required={Boolean(editingSlot)} value={form.officerId} onChange={(event) => setForm({ ...form, officerId: event.target.value })}><option value="">{editingSlot ? 'Select work-ready staff' : 'Open shift — advertise to available staff'}</option>{staff.filter((person) => person.workReady).map((person) => <option value={person.id} key={person.id}>{person.name}</option>)}</select><label htmlFor="roster-service"><span>Work unit</span></label><select id="roster-service" required value={form.workUnitId} onChange={(event) => setForm({ ...form, workUnitId: event.target.value })}><option value="">Select the work this shift covers</option>{workUnits.map((unit) => <option value={unit.id} key={unit.id}>{unit.name} · {unit.work_unit_type === 'patrol' ? 'patrol run' : unit.work_unit_type === 'static' ? 'static post' : 'office / internal'}</option>)}</select><div><label><span>Start</span><input type="datetime-local" required value={form.start} onChange={(event) => setForm({ ...form, start: event.target.value })} /></label><label><span>End</span><input type="datetime-local" required value={form.end} onChange={(event) => setForm({ ...form, end: event.target.value })} /></label></div>{unitCoverage && form.start && (() => { const words = coverageWords(unitCoverage, form.start); return <p className={`roster-coverage-note is-${words.tone}`} role={words.tone === 'warn' ? 'alert' : 'status'}>{words.tone === 'warn' ? <AlertTriangle size={15} aria-hidden="true" /> : <ShieldCheck size={15} aria-hidden="true" />}<span>{words.text}</span></p>; })()}{assignmentPreview && assignmentWords(assignmentPreview).map((note, index) => <p key={index} className={`roster-assignment-note is-${note.tone}`} role={note.tone === 'ok' ? 'status' : 'alert'}>{note.tone === 'ok' ? <UserCheck size={15} aria-hidden="true" /> : <AlertTriangle size={15} aria-hidden="true" />}<span>{note.text}</span></p>)}<label><span>Briefing notes</span><textarea rows={3} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label><label className="roster-publish"><input type="checkbox" aria-label="Publish immediately" checked={form.publish} onChange={(event) => setForm({ ...form, publish: event.target.checked })} /><span><UserCheck /><b>{form.officerId ? 'Publish immediately' : 'Advertise open shift immediately'}</b><small>{form.officerId ? 'The officer sees it straight away and can accept or decline. Leave off to keep it as a draft you publish later.' : 'Publish the unassigned slot so it can be offered to eligible staff. Leave off to keep it as a planning draft.'}</small></span></label>{error && <p className="roster-assignment-note is-stop roster-dialog-error" role="alert"><AlertTriangle size={15} aria-hidden="true" /><span>{error}</span></p>}<footer><button type="button" onClick={() => setShowCreate(false)}>Cancel</button><button type="submit" disabled={saving || Boolean(editingSlot && !form.officerId) || !form.workUnitId || !form.start || !form.end}>{saving ? 'Creating' : 'Create shift'}</button></footer></form></div>}
  </div>;
};

export default RosterOperationsPage;
