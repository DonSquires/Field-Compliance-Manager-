import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CalendarDays, ChevronLeft, ChevronRight, Clock3, Filter, Plus, RefreshCw, Search, ShieldCheck, UserCheck, Users, X } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { moveRosterPeriod, NZ_HOLIDAY_REGIONS, nzRosterHolidays, rosterPeriod, type RosterHorizon } from '../lib/rosterCalendar';
import { supabase } from '../lib/supabase';
import { readWorkflowContext, workflowContextQuery } from '../lib/workflowNavigation';
import './RosterOperationsPage.css';
import './RosterSlotActions.css';
import './RosterAvailability.css';
import './RosterCalendar.css';
import './RosterCommercialReadiness.css';

interface Staff { id: string; staffId: string; name: string; workReady: boolean; employmentType: string | null; credentialRisk: 'clear' | 'expiring' | 'expired' | 'unverified'; }
interface Shift { id: string; officer_user_id: string; service_type: string; scheduled_start: string; scheduled_end: string; status: string; shift_health: string | null; total_stops: number; notes: string | null; }
interface WorkUnit { id: string; name: string; work_unit_type: 'patrol' | 'static' | 'internal'; service_type: string; }
interface RosterSlot { id: string; work_unit_id: string; staff_id: string; scheduled_start: string; scheduled_end: string; status: string; linked_shift_id: string | null; notes: string | null; }
interface Leave { staff_id: string; starts_on: string; ends_on: string; }
interface Availability { staff_id: string; day_of_week: number | null; specific_date: string | null; available_from: string | null; available_to: string | null; all_day: boolean; availability_type: string; }
interface Coverage { id: string; shift_date: string; }
interface CommercialReadiness { slot_id: string; pay_status: string; billing_status: string; quote_status: string; geofence_status: string; cost_centre_status: string; }
type ReadinessFilter = 'all' | 'ready' | 'risk';

const startOfWeek = (date: Date) => { const value = new Date(date); value.setDate(value.getDate() - ((value.getDay() + 6) % 7)); value.setHours(0, 0, 0, 0); return value; };
const addDays = (date: Date, days: number) => { const value = new Date(date); value.setDate(value.getDate() + days); return value; };
const isoDate = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
const localInput = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

const RosterOperationsPage: React.FC = () => {
  const { profile } = useAuth();
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
  const [leave, setLeave] = useState<Leave[]>([]);
  const [availability, setAvailability] = useState<Availability[]>([]);
  const [coverage, setCoverage] = useState<Coverage[]>([]);
  const [commercialReadiness, setCommercialReadiness] = useState<CommercialReadiness[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [readiness, setReadiness] = useState<ReadinessFilter>('all');
  const [selectedShiftId, setSelectedShiftId] = useState<string | null>(null);
  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null);
  const [slotAction, setSlotAction] = useState<'publish' | 'cancel' | 'reassign' | null>(null);
  const [slotReason, setSlotReason] = useState('');
  const [replacementStaffId, setReplacementStaffId] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ officerId: '', workUnitId: '', start: '', end: '', notes: '', publish: true });

  const period = useMemo(() => rosterPeriod(periodAnchor, horizon), [horizon, periodAnchor]);
  const { days, start: weekStart, end: weekEnd } = period;
  const holidays = useMemo(() => nzRosterHolidays(weekStart, weekEnd, calendarRegion), [calendarRegion, weekEnd, weekStart]);

  const load = useCallback(async () => {
    if (!profile?.organizationId) return;
    setLoading(true); setError(null);
    const org = profile.organizationId;
    const responses = await Promise.all([
      supabase.from('user_profiles').select('id,display_name,email,role').eq('organization_id', org).in('role', ['officer', 'admin_officer']).is('deactivated_at', null),
      supabase.from('staff_profiles').select('id,user_id,employment_type,work_ready').eq('organization_id', org),
      supabase.from('staff_credentials').select('staff_id,expiry_date,verified').eq('organization_id', org),
      supabase.from('shifts').select('id,officer_user_id,service_type,scheduled_start,scheduled_end,status,shift_health,total_stops,notes').eq('organization_id', org).gte('scheduled_start', weekStart.toISOString()).lt('scheduled_start', weekEnd.toISOString()).order('scheduled_start'),
      supabase.from('roster_work_units').select('id,name,work_unit_type,service_type').eq('organization_id', org).eq('active', true).order('name'),
      supabase.from('roster_slots').select('id,work_unit_id,staff_id,scheduled_start,scheduled_end,status,linked_shift_id,notes').eq('organization_id', org).gte('scheduled_start', weekStart.toISOString()).lt('scheduled_start', weekEnd.toISOString()).order('scheduled_start'),
      supabase.from('leave_requests').select('staff_id,starts_on,ends_on,status').eq('organization_id', org).eq('status', 'approved').lte('starts_on', isoDate(addDays(weekEnd, -1))).gte('ends_on', isoDate(weekStart)),
      supabase.from('staff_availability').select('staff_id,day_of_week,specific_date,available_from,available_to,all_day,availability_type').eq('organization_id', org).in('availability_type', ['unavailable', 'leave']).or(`day_of_week.not.is.null,and(specific_date.gte.${isoDate(weekStart)},specific_date.lt.${isoDate(weekEnd)})`),
      supabase.from('shift_coverage_requests').select('id,shift_date').eq('organization_id', org).eq('status', 'open').gte('shift_date', isoDate(weekStart)).lt('shift_date', isoDate(weekEnd)),
      supabase.from('organization_calendar_settings').select('region_code').eq('organization_id', org),
      supabase.rpc('get_roster_commercial_readiness', { p_organization_id: org, p_from: weekStart.toISOString(), p_to: weekEnd.toISOString() }),
    ]);
    const [usersRes, staffRes, credentialRes, shiftRes, unitRes, slotRes, leaveRes, availabilityRes, coverageRes, calendarRes, commercialRes] = responses;
    const failures = responses.filter((response) => response.error).map((response) => response.error?.message);
    if (failures.length) setError(failures.join(' · '));
    const staffRows = (staffRes.data ?? []) as Array<{ id: string; user_id: string | null; employment_type: string | null; work_ready: boolean }>;
    const byUser = new Map(staffRows.map((row) => [row.user_id ?? row.id, row]));
    const credentials = (credentialRes.data ?? []) as Array<{ staff_id: string; expiry_date: string | null; verified: boolean }>;
    const now = Date.now();
    setStaff(((usersRes.data ?? []) as Array<{ id: string; display_name: string | null; email: string | null }>).map((user) => {
      const employment = byUser.get(user.id); const staffId = employment?.id ?? user.id; const ownCredentials = credentials.filter((credential) => credential.staff_id === staffId);
      let credentialRisk: Staff['credentialRisk'] = ownCredentials.some((credential) => !credential.verified) ? 'unverified' : 'clear';
      if (ownCredentials.some((credential) => credential.expiry_date && new Date(credential.expiry_date).getTime() < now)) credentialRisk = 'expired';
      else if (ownCredentials.some((credential) => credential.expiry_date && new Date(credential.expiry_date).getTime() - now < 30 * 86_400_000)) credentialRisk = 'expiring';
      return { id: user.id, staffId, name: user.display_name || user.email || 'Unnamed staff', workReady: Boolean(employment?.work_ready), employmentType: employment?.employment_type ?? null, credentialRisk };
    }));
    setShifts((shiftRes.data as Shift[]) ?? []); setWorkUnits((unitRes.data as WorkUnit[]) ?? []); setSlots((slotRes.data as RosterSlot[]) ?? []); setLeave((leaveRes.data as Leave[]) ?? []); setAvailability((availabilityRes.data as Availability[]) ?? []); setCoverage((coverageRes.data as Coverage[]) ?? []); setCalendarRegion((calendarRes.data?.[0] as { region_code: string | null } | undefined)?.region_code ?? null); setCommercialReadiness((commercialRes.data as CommercialReadiness[]) ?? []); setLoading(false);
  }, [profile?.organizationId, weekEnd, weekStart]);
  useEffect(() => { void load(); }, [load]);
  const syncOfficerResponses = useCallback(async () => {
    if (!profile?.organizationId) return;
    const org = profile.organizationId;
    const [shiftResponse, slotResponse] = await Promise.all([
      supabase.from('shifts').select('id,officer_user_id,service_type,scheduled_start,scheduled_end,status,shift_health,total_stops,notes').eq('organization_id', org).gte('scheduled_start', weekStart.toISOString()).lt('scheduled_start', weekEnd.toISOString()).order('scheduled_start'),
      supabase.from('roster_slots').select('id,work_unit_id,staff_id,scheduled_start,scheduled_end,status,linked_shift_id,notes').eq('organization_id', org).gte('scheduled_start', weekStart.toISOString()).lt('scheduled_start', weekEnd.toISOString()).order('scheduled_start'),
    ]);
    if (!shiftResponse.error) setShifts((shiftResponse.data as Shift[]) ?? []);
    if (!slotResponse.error) setSlots((slotResponse.data as RosterSlot[]) ?? []);
  }, [profile?.organizationId, weekEnd, weekStart]);
  useEffect(() => {
    const interval = window.setInterval(() => void syncOfficerResponses(), 15_000);
    return () => window.clearInterval(interval);
  }, [syncOfficerResponses]);

  const visibleStaff = staff.filter((person) => (!search || person.name.toLowerCase().includes(search.toLowerCase())) && (readiness === 'all' || (readiness === 'ready' ? person.workReady && person.credentialRisk === 'clear' : !person.workReady || person.credentialRisk !== 'clear')));
  const selectedShift = shifts.find((shift) => shift.id === selectedShiftId) ?? null;
  const selectedSlot = slots.find((slot) => slot.id === selectedSlotId) ?? null;
  const selectedSlotUnit = selectedSlot ? workUnits.find((unit) => unit.id === selectedSlot.work_unit_id) ?? null : null;
  const selectedSlotStaff = selectedSlot ? staff.find((person) => person.staffId === selectedSlot.staff_id) ?? null : null;
  const selectedCommercialReadiness = selectedSlot ? commercialReadiness.find((item) => item.slot_id === selectedSlot.id) ?? null : null;
  const selectedOfficer = selectedShift ? staff.find((person) => person.id === selectedShift.officer_user_id) : null;
  const requestedWorkUnit = workUnits.find((unit) => unit.id === workflowContext.workUnitId) ?? null;
  const riskCount = staff.filter((person) => !person.workReady || person.credentialRisk !== 'clear').length;
  const totalHours = [...shifts, ...slots.filter((slot) => !slot.linked_shift_id)].reduce((sum, item) => sum + Math.max(0, (new Date(item.scheduled_end).getTime() - new Date(item.scheduled_start).getTime()) / 3_600_000), 0);
  const restrictionsForDay = (staffId: string, day: Date) => availability.filter((record) => record.staff_id === staffId && (record.specific_date === isoDate(day) || (record.specific_date === null && record.day_of_week === ((day.getDay() + 6) % 7) + 1)));
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

  const openCreate = (person?: Staff, day?: Date) => {
    const start = day ? new Date(day) : new Date(); start.setHours(8, 0, 0, 0); const end = new Date(start); end.setHours(16, 0, 0, 0);
    setForm({ officerId: person?.id ?? '', workUnitId: requestedWorkUnit?.id ?? workUnits[0]?.id ?? '', start: localInput(start), end: localInput(end), notes: '', publish: true }); setShowCreate(true);
  };

  const createAssignment = async (event: React.FormEvent) => {
    event.preventDefault(); setSaving(true); setError(null); setNotice(null);
    const person = staff.find((candidate) => candidate.id === form.officerId); const unit = workUnits.find((candidate) => candidate.id === form.workUnitId);
    if (person && hasAvailabilityConflict(person.staffId, form.start, form.end)) { setError(`${person.name} is unavailable during the selected assignment time.`); setSaving(false); return; }
    const slotResponse = await supabase.rpc('create_roster_slot', { p_client_request_id: crypto.randomUUID(), p_work_unit_id: form.workUnitId, p_staff_id: person?.staffId, p_scheduled_start: new Date(form.start).toISOString(), p_scheduled_end: new Date(form.end).toISOString(), p_publish: form.publish, p_notes: form.notes.trim() || null });
    if (slotResponse.error || !slotResponse.data) { setError(slotResponse.error?.message ?? 'Roster slot creation was not confirmed.'); setSaving(false); return; }
    const slot = slotResponse.data as { id: string };
    if (form.publish && unit?.work_unit_type !== 'internal') {
      const materialized = await supabase.rpc('materialize_roster_slot', { p_slot_id: slot.id, p_expected_status: 'published' });
      if (materialized.error || !materialized.data) { setError(materialized.error?.message ?? 'Roster slot was saved, but field shift materialization was not confirmed.'); setSaving(false); await load(); return; }
    }
    setNotice(`Shift ${form.publish ? 'published' : 'saved'} for ${person?.name ?? 'staff member'}.`); setShowCreate(false); await load(); setSaving(false);
  };

  const manageSlot = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedSlot || !slotAction) return;
    setSaving(true); setError(null); setNotice(null);
    const { error: actionError } = slotAction === 'reassign'
      ? await supabase.rpc('reassign_roster_slot', { p_slot_id: selectedSlot.id, p_expected_status: selectedSlot.status, p_new_staff_id: replacementStaffId, p_reason: slotReason.trim() })
      : await supabase.rpc('manage_roster_slot', { p_slot_id: selectedSlot.id, p_expected_status: selectedSlot.status, p_action: slotAction, p_reason: slotAction === 'cancel' ? slotReason.trim() : null });
    if (actionError) setError(actionError.message);
    else { setNotice(slotAction === 'publish' ? 'Roster slot published and field work materialized where required.' : slotAction === 'reassign' ? 'Roster slot reassigned and returned for officer response.' : 'Roster slot cancelled with synchronized field state.'); setSlotAction(null); setSlotReason(''); setReplacementStaffId(''); setSelectedSlotId(null); await load(); }
    setSaving(false);
  };

  const updateCalendarRegion = async (regionCode: string) => {
    if (!profile?.organizationId) return;
    setSaving(true); setError(null);
    const nextRegion = regionCode || null;
    const { error: regionError } = await supabase.rpc('set_organization_calendar_region', { p_organization_id: profile.organizationId, p_region_code: nextRegion });
    if (regionError) setError(regionError.message); else { setCalendarRegion(nextRegion); setNotice('Regional public holiday calendar updated.'); }
    setSaving(false);
  };

  return <div className="roster-ops">
    <header className="roster-ops-header"><div><span>Workforce operations</span><h1>Roster</h1><p>Live field shifts, workforce constraints, and public holidays across selectable planning horizons.</p></div><div><button onClick={() => void load()} disabled={loading} title="Refresh roster"><RefreshCw size={16} className={loading ? 'is-spinning' : ''} /></button><button onClick={() => navigate(`/admin/roster-targets${workflowContextQuery(workflowContext)}`)}>Work units</button><button className="is-primary" onClick={() => openCreate()}><Plus size={16} />Create shift</button></div></header>
    {workflowContext.workUnitId&&<section className="roster-context-banner" role="status"><div><span>{workflowContext.handoffId?'Mobilisation handoff · roster evidence':'Account flow · roster action'}</span><strong>{requestedWorkUnit?.name??'Loading requested work unit'}</strong><p>{requestedWorkUnit?'Schedule the next officer assignment against the work unit selected during mobilisation.':'The requested work unit is not active in this provider roster.'}</p></div><div><button onClick={()=>navigate('/admin/roster')}>Clear focus</button>{workflowContext.handoffId&&<button onClick={()=>navigate(`/admin/handoffs${workflowContextQuery(workflowContext)}`)}>Return to handoff</button>}<button onClick={()=>navigate(`/admin/roster-targets${workflowContextQuery(workflowContext)}`)}>Open work unit</button><button className="is-primary" onClick={()=>openCreate()} disabled={!requestedWorkUnit}><Plus size={15}/>Create shift for this work unit</button></div></section>}
    {error && <div className="roster-message is-error" role="alert"><AlertTriangle size={17} /><span>{error}</span><button onClick={() => setError(null)}><X size={16} /></button></div>}{notice && <div className="roster-message is-success" role="status"><ShieldCheck size={17} /><span>{notice}</span><button onClick={() => setNotice(null)}><X size={16} /></button></div>}
    <section className="roster-metrics"><div><Users size={18} /><span>Rosterable staff</span><strong>{staff.length}</strong></div><div className={riskCount ? 'is-warning' : ''}><AlertTriangle size={18} /><span>Readiness risks</span><strong>{riskCount}</strong></div><div><Clock3 size={18} /><span>Scheduled hours</span><strong>{Math.round(totalHours)}</strong></div><div className={coverage.length ? 'is-warning' : ''}><CalendarDays size={18} /><span>Open coverage</span><strong>{coverage.length}</strong></div></section>
    <div className="roster-horizon-bar"><div className="roster-horizon" aria-label="Roster horizon">{([['week', 'Week'], ['fortnight', '2 weeks'], ['month', 'Month']] as const).map(([value, label]) => <button type="button" className={horizon === value ? 'is-active' : ''} aria-pressed={horizon === value} onClick={() => { setHorizon(value); setPeriodAnchor(new Date()); }} key={value}>{label}</button>)}</div><label><span>Regional holidays</span><select value={calendarRegion ?? ''} disabled={saving} onChange={(event) => void updateCalendarRegion(event.target.value)}><option value="">National only</option>{NZ_HOLIDAY_REGIONS.map(([code, name]) => <option value={code} key={code}>{name}</option>)}</select></label></div>
    <div className="roster-toolbar"><div className="roster-week-nav"><button onClick={() => setPeriodAnchor(moveRosterPeriod(periodAnchor, horizon, -1))} title="Previous period"><ChevronLeft /></button><button onClick={() => setPeriodAnchor(new Date())}>Today</button><strong>{weekStart.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })} – {addDays(weekEnd, -1).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' })}</strong><button onClick={() => setPeriodAnchor(moveRosterPeriod(periodAnchor, horizon, 1))} title="Next period"><ChevronRight /></button></div><label><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search staff" /></label><div className="roster-readiness"><Filter size={14} />{(['all', 'ready', 'risk'] as ReadinessFilter[]).map((item) => <button className={readiness === item ? 'is-active' : ''} onClick={() => setReadiness(item)} key={item}>{item}</button>)}</div></div>
    {holidays.length > 0 && <section className="roster-holidays" aria-label="Public holidays">{holidays.map((holiday) => <div className={`is-${holiday.scope}`} key={`${holiday.date}-${holiday.name}`}><CalendarDays size={14} /><span>{new Date(`${holiday.date}T12:00:00`).toLocaleDateString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short' })}</span><strong>{holiday.name}</strong><i>{holiday.scope}</i></div>)}</section>}
    <div className="roster-board" style={{ '--roster-days': days.length } as React.CSSProperties}>
      <div className="roster-board-head">
        <div>Staff</div>
        {days.map((day) => {
          const holiday = holidays.find((item) => item.date === isoDate(day));
          return <div className={`${isoDate(day) === isoDate(new Date()) ? 'is-today' : ''} ${holiday ? 'is-holiday' : ''}`} title={holiday?.name} key={day.toISOString()}><span>{day.toLocaleDateString('en-NZ', { weekday: 'short' })}</span><strong>{day.getDate()}</strong>{holiday && <small>Holiday</small>}</div>;
        })}
      </div>
      {loading ? <div className="roster-empty"><RefreshCw className="is-spinning" />Loading roster</div> : visibleStaff.map((person) => (
        <div className="roster-row" key={person.id}>
          <button className="roster-person" onClick={() => openCreate(person)}><span>{person.name.split(' ').map((value) => value[0]).join('').slice(0, 2)}</span><div><strong>{person.name}</strong><small>{person.employmentType ?? 'Employment unset'}</small></div><i className={person.workReady && person.credentialRisk === 'clear' ? 'is-ready' : 'is-risk'}>{person.workReady ? person.credentialRisk : 'not ready'}</i></button>
          {days.map((day) => {
            const key = isoDate(day);
            const dayShifts = shifts.filter((shift) => shift.officer_user_id === person.id && isoDate(new Date(shift.scheduled_start)) === key);
            const daySlots = slots.filter((slot) => slot.staff_id === person.staffId && !slot.linked_shift_id && isoDate(new Date(slot.scheduled_start)) === key);
            const onLeave = leave.some((record) => record.staff_id === person.staffId && record.starts_on <= key && record.ends_on >= key);
            return <div className={`roster-cell ${onLeave ? 'is-leave' : ''}`} key={key}>{onLeave && <span className="roster-leave">Leave</span>}{dayShifts.map((shift) => <button className={`roster-shift status-${shift.status}`} onClick={() => setSelectedShiftId(shift.id)} key={shift.id}><strong>{new Date(shift.scheduled_start).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' })}</strong><span>{shift.service_type.replaceAll('_', ' ')}</span></button>)}{daySlots.map((slot) => { const unit = workUnits.find((item) => item.id === slot.work_unit_id); return <div className={`roster-shift roster-slot type-${unit?.work_unit_type ?? 'internal'} status-${slot.status}`} key={slot.id}><strong>{new Date(slot.scheduled_start).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' })}</strong><span>{unit?.name ?? 'Roster slot'}</span></div>; })}{!onLeave && dayShifts.length === 0 && daySlots.length === 0 && <button className="roster-add" onClick={() => openCreate(person, day)}>+</button>}</div>;
          })}
        </div>
      ))}
    </div>
    {availabilityOccurrences.length > 0 && <section className="roster-availability-queue"><header><div><span>Staff constraints</span><h2>Availability restrictions</h2></div><strong>{availabilityOccurrences.length}</strong></header><div>{availabilityOccurrences.map(({ day, person, record }, index) => <button type="button" onClick={() => openCreate(person, day)} key={`${person.staffId}-${isoDate(day)}-${index}`}><AlertTriangle size={15} /><div><strong>{person.name}</strong><small>{day.toLocaleDateString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short' })} · {record.all_day || !record.available_from || !record.available_to ? 'Unavailable all day' : `${record.available_from.slice(0, 5)}–${record.available_to.slice(0, 5)}`}</small></div><i>{record.availability_type}</i></button>)}</div></section>}
    {commercialExceptions.length > 0 && <section className="roster-commercial-queue"><header><div><span>Finance & geography</span><h2>Commercial readiness exceptions</h2></div><strong>{commercialExceptions.length}</strong></header><div>{commercialExceptions.map((readiness) => { const slot = slots.find((item) => item.id === readiness.slot_id); const unit = slot ? workUnits.find((item) => item.id === slot.work_unit_id) : null; const issues = Object.entries(readiness).filter(([key, value]) => key !== 'slot_id' && !['ready', 'accepted', 'verified', 'not_applicable'].includes(value)).map(([key]) => key.replace('_status', '').replace('_', ' ')); return <button type="button" onClick={() => setSelectedSlotId(readiness.slot_id)} key={readiness.slot_id}><AlertTriangle size={15} /><div><strong>{unit?.name ?? 'Roster slot'}</strong><small>{issues.join(' · ')}</small></div><i>Review</i></button>; })}</div></section>}
    {slots.length > 0 && <section className="roster-slot-queue"><header><div><span>Typed assignments</span><h2>Slot lifecycle</h2></div><strong>{slots.length}</strong></header><div>{slots.map((slot) => { const unit = workUnits.find((item) => item.id === slot.work_unit_id); const person = staff.find((item) => item.staffId === slot.staff_id); return <button type="button" onClick={() => setSelectedSlotId(slot.id)} key={slot.id}><span className={`type-${unit?.work_unit_type ?? 'internal'}`}>{unit?.work_unit_type ?? 'slot'}</span><div><strong>{unit?.name ?? 'Roster slot'}</strong><small>{person?.name ?? 'Staff member'} · {new Date(slot.scheduled_start).toLocaleString('en-NZ', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</small></div><i>{slot.status}</i></button>; })}</div></section>}
    {selectedShift && <aside className="roster-inspector"><header><div><span>Assignment</span><h2>{selectedOfficer?.name ?? 'Officer'}</h2></div><button onClick={() => setSelectedShiftId(null)}><X /></button></header><dl><div><dt>Service</dt><dd>{selectedShift.service_type.replaceAll('_', ' ')}</dd></div><div><dt>Status</dt><dd>{selectedShift.status}</dd></div><div><dt>Start</dt><dd>{new Date(selectedShift.scheduled_start).toLocaleString('en-NZ')}</dd></div><div><dt>End</dt><dd>{new Date(selectedShift.scheduled_end).toLocaleString('en-NZ')}</dd></div><div><dt>Stops</dt><dd>{selectedShift.total_stops}</dd></div><div><dt>Health</dt><dd>{selectedShift.shift_health ?? 'Not calculated'}</dd></div></dl>{selectedShift.notes && <p>{selectedShift.notes}</p>}</aside>}
    {selectedSlot && <aside className="roster-inspector roster-slot-inspector"><header><div><span>Roster slot</span><h2>{selectedSlotUnit?.name ?? 'Typed assignment'}</h2></div><button onClick={() => setSelectedSlotId(null)}><X /></button></header><dl><div><dt>Staff</dt><dd>{selectedSlotStaff?.name ?? 'Unknown'}</dd></div><div><dt>Type</dt><dd>{selectedSlotUnit?.work_unit_type ?? 'Unknown'}</dd></div><div><dt>Status</dt><dd>{selectedSlot.status}</dd></div><div><dt>Start</dt><dd>{new Date(selectedSlot.scheduled_start).toLocaleString('en-NZ')}</dd></div><div><dt>End</dt><dd>{new Date(selectedSlot.scheduled_end).toLocaleString('en-NZ')}</dd></div><div><dt>Field shift</dt><dd>{selectedSlot.linked_shift_id?.slice(0, 8) ?? 'Workforce only'}</dd></div>{selectedCommercialReadiness && <><div><dt>Wage rule</dt><dd>{selectedCommercialReadiness.pay_status.replaceAll('_', ' ')}</dd></div><div><dt>Billing</dt><dd>{selectedCommercialReadiness.billing_status.replaceAll('_', ' ')}</dd></div><div><dt>Quote</dt><dd>{selectedCommercialReadiness.quote_status.replaceAll('_', ' ')}</dd></div><div><dt>Geofence</dt><dd>{selectedCommercialReadiness.geofence_status.replaceAll('_', ' ')}</dd></div><div><dt>Cost centre</dt><dd>{selectedCommercialReadiness.cost_centre_status.replaceAll('_', ' ')}</dd></div></>}</dl>{selectedSlot.notes && <p>{selectedSlot.notes}</p>}<footer>{selectedSlot.status === 'draft' && <button className="is-primary" onClick={() => setSlotAction('publish')}>Publish slot</button>}{['draft', 'published', 'accepted', 'declined'].includes(selectedSlot.status) && <button onClick={() => { setReplacementStaffId(''); setSlotReason(''); setSlotAction('reassign'); }}>Reassign</button>}{['draft', 'published', 'accepted'].includes(selectedSlot.status) && <button onClick={() => { setSlotReason(''); setSlotAction('cancel'); }}>Cancel slot</button>}</footer></aside>}
    {selectedSlot && slotAction && <div className="roster-dialog-backdrop"><form className="roster-dialog roster-slot-dialog" onSubmit={manageSlot} role="dialog" aria-modal="true" aria-labelledby="slot-action-title"><header><div><span>Roster lifecycle</span><h2 id="slot-action-title">{slotAction === 'publish' ? 'Publish roster slot?' : slotAction === 'reassign' ? 'Reassign roster slot?' : 'Cancel roster slot?'}</h2></div><button type="button" onClick={() => setSlotAction(null)}><X /></button></header><p>{slotAction === 'publish' ? 'Field work will materialize into the operational shift system. Internal work remains a workforce slot.' : slotAction === 'reassign' ? 'The replacement officer must respond to the assignment. Linked field ownership changes only when no execution evidence exists.' : 'Cancellation synchronizes any linked field shift only when no execution evidence exists.'}</p>{slotAction === 'reassign' && <label><span>Replacement officer</span><select required value={replacementStaffId} onChange={(event) => setReplacementStaffId(event.target.value)}><option value="">Select work-ready staff</option>{staff.filter((person) => person.workReady && person.staffId !== selectedSlot.staff_id).map((person) => <option value={person.staffId} key={person.staffId}>{person.name}</option>)}</select></label>}{slotAction !== 'publish' && <label><span>{slotAction === 'reassign' ? 'Reassignment reason' : 'Cancellation reason'}</span><textarea required rows={4} value={slotReason} onChange={(event) => setSlotReason(event.target.value)} /></label>}<footer><button type="button" onClick={() => setSlotAction(null)}>Back</button><button type="submit" disabled={saving || (slotAction !== 'publish' && (!slotReason.trim() || (slotAction === 'reassign' && !replacementStaffId)))}>{saving ? 'Saving' : slotAction === 'publish' ? 'Confirm publication' : slotAction === 'reassign' ? 'Confirm reassignment' : 'Confirm cancellation'}</button></footer></form></div>}
    {showCreate && <div className="roster-dialog-backdrop"><form className="roster-dialog" onSubmit={createAssignment} role="dialog" aria-modal="true" aria-labelledby="create-shift-title"><header><div><span>Roster assignment</span><h2 id="create-shift-title">Create shift</h2></div><button type="button" onClick={() => setShowCreate(false)}><X /></button></header><label htmlFor="roster-officer"><span>Officer</span></label><select id="roster-officer" required value={form.officerId} onChange={(event) => setForm({ ...form, officerId: event.target.value })}><option value="">Select work-ready staff</option>{staff.filter((person) => person.workReady).map((person) => <option value={person.id} key={person.id}>{person.name}</option>)}</select><label htmlFor="roster-service"><span>Work unit</span></label><select id="roster-service" required value={form.workUnitId} onChange={(event) => setForm({ ...form, workUnitId: event.target.value })}><option value="">Select typed work unit</option>{workUnits.map((unit) => <option value={unit.id} key={unit.id}>{unit.name} · {unit.work_unit_type}</option>)}</select><div><label><span>Start</span><input type="datetime-local" required value={form.start} onChange={(event) => setForm({ ...form, start: event.target.value })} /></label><label><span>End</span><input type="datetime-local" required value={form.end} onChange={(event) => setForm({ ...form, end: event.target.value })} /></label></div><label><span>Briefing notes</span><textarea rows={3} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label><label className="roster-publish"><input type="checkbox" checked={form.publish} onChange={(event) => setForm({ ...form, publish: event.target.checked })} /><span><UserCheck /><b>Publish immediately</b><small>Field work materializes a shift; internal work remains a workforce slot</small></span></label><footer><button type="button" onClick={() => setShowCreate(false)}>Cancel</button><button type="submit" disabled={saving || !form.officerId || !form.workUnitId || !form.start || !form.end}>{saving ? 'Creating' : 'Create shift'}</button></footer></form></div>}
  </div>;
};

export default RosterOperationsPage;
