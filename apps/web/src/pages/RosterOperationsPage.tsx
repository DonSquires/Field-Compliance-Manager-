import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CalendarDays, ChevronLeft, ChevronRight, Clock3, Filter, Plus, RefreshCw, Search, ShieldCheck, UserCheck, Users, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './RosterOperationsPage.css';

interface Staff { id: string; staffId: string; name: string; workReady: boolean; employmentType: string | null; credentialRisk: 'clear' | 'expiring' | 'expired' | 'unverified'; }
interface Shift { id: string; officer_user_id: string; service_type: string; scheduled_start: string; scheduled_end: string; status: string; shift_health: string | null; total_stops: number; notes: string | null; }
interface WorkUnit { id: string; name: string; work_unit_type: 'patrol' | 'static' | 'internal'; service_type: string; }
interface RosterSlot { id: string; work_unit_id: string; staff_id: string; scheduled_start: string; scheduled_end: string; status: string; linked_shift_id: string | null; notes: string | null; }
interface Leave { staff_id: string; starts_on: string; ends_on: string; }
interface Coverage { id: string; shift_date: string; }
type ReadinessFilter = 'all' | 'ready' | 'risk';

const startOfWeek = (date: Date) => { const value = new Date(date); value.setDate(value.getDate() - ((value.getDay() + 6) % 7)); value.setHours(0, 0, 0, 0); return value; };
const addDays = (date: Date, days: number) => { const value = new Date(date); value.setDate(value.getDate() + days); return value; };
const isoDate = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
const localInput = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

const RosterOperationsPage: React.FC = () => {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [staff, setStaff] = useState<Staff[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [workUnits, setWorkUnits] = useState<WorkUnit[]>([]);
  const [slots, setSlots] = useState<RosterSlot[]>([]);
  const [leave, setLeave] = useState<Leave[]>([]);
  const [coverage, setCoverage] = useState<Coverage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [readiness, setReadiness] = useState<ReadinessFilter>('all');
  const [selectedShiftId, setSelectedShiftId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ officerId: '', workUnitId: '', start: '', end: '', notes: '', publish: true });

  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)), [weekStart]);
  const weekEnd = useMemo(() => addDays(weekStart, 7), [weekStart]);

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
      supabase.from('shift_coverage_requests').select('id,shift_date').eq('organization_id', org).eq('status', 'open').gte('shift_date', isoDate(weekStart)).lt('shift_date', isoDate(weekEnd)),
    ]);
    const [usersRes, staffRes, credentialRes, shiftRes, unitRes, slotRes, leaveRes, coverageRes] = responses;
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
    setShifts((shiftRes.data as Shift[]) ?? []); setWorkUnits((unitRes.data as WorkUnit[]) ?? []); setSlots((slotRes.data as RosterSlot[]) ?? []); setLeave((leaveRes.data as Leave[]) ?? []); setCoverage((coverageRes.data as Coverage[]) ?? []); setLoading(false);
  }, [profile?.organizationId, weekEnd, weekStart]);
  useEffect(() => { void load(); }, [load]);

  const visibleStaff = staff.filter((person) => (!search || person.name.toLowerCase().includes(search.toLowerCase())) && (readiness === 'all' || (readiness === 'ready' ? person.workReady && person.credentialRisk === 'clear' : !person.workReady || person.credentialRisk !== 'clear')));
  const selectedShift = shifts.find((shift) => shift.id === selectedShiftId) ?? null;
  const selectedOfficer = selectedShift ? staff.find((person) => person.id === selectedShift.officer_user_id) : null;
  const riskCount = staff.filter((person) => !person.workReady || person.credentialRisk !== 'clear').length;
  const totalHours = [...shifts, ...slots.filter((slot) => !slot.linked_shift_id)].reduce((sum, item) => sum + Math.max(0, (new Date(item.scheduled_end).getTime() - new Date(item.scheduled_start).getTime()) / 3_600_000), 0);

  const openCreate = (person?: Staff, day?: Date) => {
    const start = day ? new Date(day) : new Date(); start.setHours(8, 0, 0, 0); const end = new Date(start); end.setHours(16, 0, 0, 0);
    setForm({ officerId: person?.id ?? '', workUnitId: workUnits[0]?.id ?? '', start: localInput(start), end: localInput(end), notes: '', publish: true }); setShowCreate(true);
  };

  const createAssignment = async (event: React.FormEvent) => {
    event.preventDefault(); setSaving(true); setError(null); setNotice(null);
    const person = staff.find((candidate) => candidate.id === form.officerId); const unit = workUnits.find((candidate) => candidate.id === form.workUnitId);
    const slotResponse = await supabase.rpc('create_roster_slot', { p_client_request_id: crypto.randomUUID(), p_work_unit_id: form.workUnitId, p_staff_id: person?.staffId, p_scheduled_start: new Date(form.start).toISOString(), p_scheduled_end: new Date(form.end).toISOString(), p_publish: form.publish, p_notes: form.notes.trim() || null });
    if (slotResponse.error || !slotResponse.data) { setError(slotResponse.error?.message ?? 'Roster slot creation was not confirmed.'); setSaving(false); return; }
    const slot = slotResponse.data as { id: string };
    if (form.publish && unit?.work_unit_type !== 'internal') {
      const materialized = await supabase.rpc('materialize_roster_slot', { p_slot_id: slot.id, p_expected_status: 'published' });
      if (materialized.error || !materialized.data) { setError(materialized.error?.message ?? 'Roster slot was saved, but field shift materialization was not confirmed.'); setSaving(false); await load(); return; }
    }
    setNotice(`Shift ${form.publish ? 'published' : 'saved'} for ${person?.name ?? 'staff member'}.`); setShowCreate(false); await load(); setSaving(false);
  };

  return <div className="roster-ops">
    <header className="roster-ops-header"><div><span>Workforce operations</span><h1>Roster</h1><p>Live field shifts and typed workforce slots in one weekly plan.</p></div><div><button onClick={() => void load()} disabled={loading} title="Refresh roster"><RefreshCw size={16} className={loading ? 'is-spinning' : ''} /></button><button onClick={() => navigate('/admin/roster-targets')}>Work units</button><button className="is-primary" onClick={() => openCreate()}><Plus size={16} />Create shift</button></div></header>
    {error && <div className="roster-message is-error" role="alert"><AlertTriangle size={17} /><span>{error}</span><button onClick={() => setError(null)}><X size={16} /></button></div>}{notice && <div className="roster-message is-success" role="status"><ShieldCheck size={17} /><span>{notice}</span><button onClick={() => setNotice(null)}><X size={16} /></button></div>}
    <section className="roster-metrics"><div><Users size={18} /><span>Rosterable staff</span><strong>{staff.length}</strong></div><div className={riskCount ? 'is-warning' : ''}><AlertTriangle size={18} /><span>Readiness risks</span><strong>{riskCount}</strong></div><div><Clock3 size={18} /><span>Scheduled hours</span><strong>{Math.round(totalHours)}</strong></div><div className={coverage.length ? 'is-warning' : ''}><CalendarDays size={18} /><span>Open coverage</span><strong>{coverage.length}</strong></div></section>
    <div className="roster-toolbar"><div className="roster-week-nav"><button onClick={() => setWeekStart(addDays(weekStart, -7))}><ChevronLeft /></button><button onClick={() => setWeekStart(startOfWeek(new Date()))}>Today</button><strong>{weekStart.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })} – {addDays(weekStart, 6).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' })}</strong><button onClick={() => setWeekStart(addDays(weekStart, 7))}><ChevronRight /></button></div><label><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search staff" /></label><div className="roster-readiness"><Filter size={14} />{(['all', 'ready', 'risk'] as ReadinessFilter[]).map((item) => <button className={readiness === item ? 'is-active' : ''} onClick={() => setReadiness(item)} key={item}>{item}</button>)}</div></div>
    <div className="roster-board"><div className="roster-board-head"><div>Staff</div>{days.map((day) => <div className={isoDate(day) === isoDate(new Date()) ? 'is-today' : ''} key={day.toISOString()}><span>{day.toLocaleDateString('en-NZ', { weekday: 'short' })}</span><strong>{day.getDate()}</strong></div>)}</div>{loading ? <div className="roster-empty"><RefreshCw className="is-spinning" />Loading roster</div> : visibleStaff.map((person) => <div className="roster-row" key={person.id}><button className="roster-person" onClick={() => openCreate(person)}><span>{person.name.split(' ').map((value) => value[0]).join('').slice(0, 2)}</span><div><strong>{person.name}</strong><small>{person.employmentType ?? 'Employment unset'}</small></div><i className={person.workReady && person.credentialRisk === 'clear' ? 'is-ready' : 'is-risk'}>{person.workReady ? person.credentialRisk : 'not ready'}</i></button>{days.map((day) => { const key = isoDate(day); const dayShifts = shifts.filter((shift) => shift.officer_user_id === person.id && isoDate(new Date(shift.scheduled_start)) === key); const daySlots = slots.filter((slot) => slot.staff_id === person.staffId && !slot.linked_shift_id && isoDate(new Date(slot.scheduled_start)) === key); const onLeave = leave.some((record) => record.staff_id === person.staffId && record.starts_on <= key && record.ends_on >= key); return <div className={`roster-cell ${onLeave ? 'is-leave' : ''}`} key={key}>{onLeave && <span className="roster-leave">Leave</span>}{dayShifts.map((shift) => <button className={`roster-shift status-${shift.status}`} onClick={() => setSelectedShiftId(shift.id)} key={shift.id}><strong>{new Date(shift.scheduled_start).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' })}</strong><span>{shift.service_type.replaceAll('_', ' ')}</span></button>)}{daySlots.map((slot) => { const unit = workUnits.find((item) => item.id === slot.work_unit_id); return <div className={`roster-shift roster-slot type-${unit?.work_unit_type ?? 'internal'} status-${slot.status}`} key={slot.id}><strong>{new Date(slot.scheduled_start).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' })}</strong><span>{unit?.name ?? 'Roster slot'}</span></div>; })}{!onLeave && dayShifts.length === 0 && daySlots.length === 0 && <button className="roster-add" onClick={() => openCreate(person, day)}>+</button>}</div>; })}</div>)}</div>
    {selectedShift && <aside className="roster-inspector"><header><div><span>Assignment</span><h2>{selectedOfficer?.name ?? 'Officer'}</h2></div><button onClick={() => setSelectedShiftId(null)}><X /></button></header><dl><div><dt>Service</dt><dd>{selectedShift.service_type.replaceAll('_', ' ')}</dd></div><div><dt>Status</dt><dd>{selectedShift.status}</dd></div><div><dt>Start</dt><dd>{new Date(selectedShift.scheduled_start).toLocaleString('en-NZ')}</dd></div><div><dt>End</dt><dd>{new Date(selectedShift.scheduled_end).toLocaleString('en-NZ')}</dd></div><div><dt>Stops</dt><dd>{selectedShift.total_stops}</dd></div><div><dt>Health</dt><dd>{selectedShift.shift_health ?? 'Not calculated'}</dd></div></dl>{selectedShift.notes && <p>{selectedShift.notes}</p>}</aside>}
    {showCreate && <div className="roster-dialog-backdrop"><form className="roster-dialog" onSubmit={createAssignment} role="dialog" aria-modal="true" aria-labelledby="create-shift-title"><header><div><span>Roster assignment</span><h2 id="create-shift-title">Create shift</h2></div><button type="button" onClick={() => setShowCreate(false)}><X /></button></header><label htmlFor="roster-officer"><span>Officer</span></label><select id="roster-officer" required value={form.officerId} onChange={(event) => setForm({ ...form, officerId: event.target.value })}><option value="">Select work-ready staff</option>{staff.filter((person) => person.workReady).map((person) => <option value={person.id} key={person.id}>{person.name}</option>)}</select><label htmlFor="roster-service"><span>Work unit</span></label><select id="roster-service" required value={form.workUnitId} onChange={(event) => setForm({ ...form, workUnitId: event.target.value })}><option value="">Select typed work unit</option>{workUnits.map((unit) => <option value={unit.id} key={unit.id}>{unit.name} · {unit.work_unit_type}</option>)}</select><div><label><span>Start</span><input type="datetime-local" required value={form.start} onChange={(event) => setForm({ ...form, start: event.target.value })} /></label><label><span>End</span><input type="datetime-local" required value={form.end} onChange={(event) => setForm({ ...form, end: event.target.value })} /></label></div><label><span>Briefing notes</span><textarea rows={3} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label><label className="roster-publish"><input type="checkbox" checked={form.publish} onChange={(event) => setForm({ ...form, publish: event.target.checked })} /><span><UserCheck /><b>Publish immediately</b><small>Field work materializes a shift; internal work remains a workforce slot</small></span></label><footer><button type="button" onClick={() => setShowCreate(false)}>Cancel</button><button type="submit" disabled={saving || !form.officerId || !form.workUnitId || !form.start || !form.end}>{saving ? 'Creating' : 'Create shift'}</button></footer></form></div>}
  </div>;
};

export default RosterOperationsPage;
