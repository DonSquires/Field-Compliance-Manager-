import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { CalendarClock, CheckCircle2, Plus, RefreshCw, UserCheck, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { slotStatusLabel } from '../lib/rosterWords';
import './CrmRosterHandoffPanel.css';

interface AgreementRef {
  id: string;
  name: string;
  agreement_type: string;
  invitation_status: string;
  provider_organization_id: string;
}

interface AgreementLocation {
  id: string;
  service_agreement_id: string;
}

interface WorkUnit {
  id: string;
  name: string;
  work_unit_type: 'patrol' | 'static' | 'internal' | 'workshop';
  service_type: string;
  service_agreement_location_id: string | null;
}

interface StaffOption {
  user_id: string;
  staff_id: string;
  display_name: string | null;
  email: string | null;
  work_ready: boolean;
}

interface RosterSlot {
  id: string;
  work_unit_id: string;
  staff_id: string | null;
  scheduled_start: string;
  scheduled_end: string;
  status: string;
  linked_shift_id: string | null;
}

const localInput = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const nextEveningWindow = () => {
  const start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(18, 0, 0, 0);
  const end = new Date(start);
  end.setHours(23, 0, 0, 0);
  return { start: localInput(start), end: localInput(end) };
};

export function CrmRosterHandoffPanel({
  agreement,
  onChanged,
}: {
  agreement: AgreementRef;
  onChanged?: () => void | Promise<void>;
}) {
  const initialWindow = useMemo(nextEveningWindow, []);
  const [workUnits, setWorkUnits] = useState<WorkUnit[]>([]);
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [slots, setSlots] = useState<RosterSlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({ officerId: '', workUnitId: '', start: initialWindow.start, end: initialWindow.end, notes: '' });

  const load = useCallback(async () => {
    if (agreement.agreement_type !== 'operational') {
      setWorkUnits([]); setStaff([]); setSlots([]); setLoading(false);
      return;
    }
    setLoading(true); setError(null);
    const locationResponse = await supabase.from('service_agreement_locations').select('id,service_agreement_id').eq('service_agreement_id', agreement.id).eq('status', 'active');
    if (locationResponse.error) { setError(locationResponse.error.message); setLoading(false); return; }
    const locationIds = new Set(((locationResponse.data as AgreementLocation[]) ?? []).map((location) => location.id));
    const [unitResponse, staffResponse] = await Promise.all([
      supabase.from('roster_work_units').select('id,name,work_unit_type,service_type,service_agreement_location_id').eq('organization_id', agreement.provider_organization_id).eq('active', true).order('name'),
      supabase.rpc('get_operating_branch_roster_staff', { p_operating_organization_id: agreement.provider_organization_id }),
    ]);
    const nextUnits = ((unitResponse.data as WorkUnit[]) ?? []).filter((unit) => unit.service_agreement_location_id && locationIds.has(unit.service_agreement_location_id));
    const unitIds = nextUnits.map((unit) => unit.id);
    const slotResponse = unitIds.length
      ? await supabase.from('roster_slots').select('id,work_unit_id,staff_id,scheduled_start,scheduled_end,status,linked_shift_id').in('work_unit_id', unitIds).order('scheduled_start', { ascending: false }).limit(8)
      : { data: [], error: null };
    const failures = [unitResponse.error, staffResponse.error, slotResponse.error].filter(Boolean);
    if (failures.length) setError(failures[0]?.message ?? 'Roster handoff evidence could not be loaded.');
    const nextStaff = ((staffResponse.data as StaffOption[]) ?? []).filter((person) => person.work_ready);
    setWorkUnits(nextUnits);
    setStaff(nextStaff);
    setSlots((slotResponse.data as RosterSlot[]) ?? []);
    setForm((current) => ({
      ...current,
      workUnitId: nextUnits.some((unit) => unit.id === current.workUnitId) ? current.workUnitId : (nextUnits[0]?.id ?? ''),
      officerId: nextStaff.some((person) => person.user_id === current.officerId) ? current.officerId : (nextStaff[0]?.user_id ?? ''),
    }));
    setLoading(false);
  }, [agreement.agreement_type, agreement.id, agreement.invitation_status, agreement.provider_organization_id]);

  useEffect(() => { void load(); }, [load]);

  const unitName = useCallback((id: string) => workUnits.find((unit) => unit.id === id)?.name ?? 'Work unit', [workUnits]);
  const staffName = useCallback((staffId: string | null) => staff.find((person) => person.staff_id === staffId)?.display_name ?? staff.find((person) => person.staff_id === staffId)?.email ?? 'Unassigned', [staff]);

  const publishAssignment = async (event: FormEvent) => {
    event.preventDefault();
    const person = staff.find((candidate) => candidate.user_id === form.officerId);
    if (!person || !form.workUnitId) return;
    setSaving(true); setError(null); setNotice(null);
    const { data: slot, error: slotError } = await supabase.rpc('create_roster_slot', {
      p_client_request_id: crypto.randomUUID(),
      p_work_unit_id: form.workUnitId,
      p_staff_id: person.staff_id,
      p_scheduled_start: new Date(form.start).toISOString(),
      p_scheduled_end: new Date(form.end).toISOString(),
      p_publish: true,
      p_notes: form.notes.trim() || null,
    });
    if (slotError || !slot) {
      setError(slotError?.message ?? 'Roster slot creation was not confirmed.');
      setSaving(false);
      return;
    }
    const { data: materialized, error: materializeError } = await supabase.rpc('materialize_roster_slot', { p_slot_id: (slot as { id: string }).id, p_expected_status: 'published' });
    if (materializeError || !materialized) {
      setError(materializeError?.message ?? 'Roster slot was saved, but field shift materialization was not confirmed.');
      setSaving(false);
      await load();
      return;
    }
    setNotice(`Published shift for ${person.display_name ?? person.email ?? 'selected officer'}.`);
    setShowForm(false);
    setForm((current) => ({ ...current, notes: '' }));
    await load();
    await onChanged?.();
    setSaving(false);
  };

  if (agreement.agreement_type !== 'operational') return null;

  return <section className="crm-roster-handoff" aria-label={`Roster handoff for ${agreement.name}`}>
    <header>
      <div><span>Roster handoff</span><strong>Assign the first field shift</strong><p>Publish a work-ready officer against an agreement-linked work unit without leaving this client portfolio.</p></div>
      <div><button type="button" onClick={() => void load()} disabled={loading} aria-label="Refresh roster handoff"><RefreshCw size={15} className={loading ? 'is-spinning' : ''} /></button><button type="button" className="btn btn-sm btn-primary" disabled={workUnits.length === 0 || staff.length === 0} onClick={() => setShowForm((current) => !current)}>{showForm ? <X size={15} /> : <Plus size={15} />}{showForm ? 'Close' : 'Assign shift'}</button></div>
    </header>
    {error && <p className="is-error" role="alert">{error}</p>}
    {notice && <p className="is-success" role="status"><CheckCircle2 size={14} />{notice}</p>}
    {loading ? <p><CalendarClock size={14} /> Loading roster handoff…</p> : <>
      {slots.length === 0 ? <p className="crm-roster-handoff-empty">No roster slot has been published for this agreement yet.</p> : <div className="crm-roster-handoff-list">{slots.map((slot) => <article key={slot.id}><div><strong>{unitName(slot.work_unit_id)}</strong><span>{staffName(slot.staff_id)} · {new Date(slot.scheduled_start).toLocaleString('en-NZ')} – {new Date(slot.scheduled_end).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' })}</span></div><em className={slot.linked_shift_id && !['completed', 'cancelled'].includes(slot.status) ? 'is-live' : ''}>{slot.status === 'completed' ? 'Completed' : slot.linked_shift_id ? `${slotStatusLabel(slot.status)} · shift created` : slotStatusLabel(slot.status)}</em></article>)}</div>}
      {showForm && <form onSubmit={publishAssignment}>
        <label><span>Field officer</span><select required value={form.officerId} onChange={(event) => setForm({ ...form, officerId: event.target.value })}>{staff.map((person) => <option key={person.user_id} value={person.user_id}>{person.display_name ?? person.email ?? 'Unnamed officer'}</option>)}</select></label>
        <label><span>Work unit</span><select required value={form.workUnitId} onChange={(event) => setForm({ ...form, workUnitId: event.target.value })}>{workUnits.map((unit) => <option key={unit.id} value={unit.id}>{unit.name} · {unit.service_type.replaceAll('_', ' ')}</option>)}</select></label>
        <label><span>Start</span><input required type="datetime-local" value={form.start} onChange={(event) => setForm({ ...form, start: event.target.value })} /></label>
        <label><span>End</span><input required type="datetime-local" value={form.end} onChange={(event) => setForm({ ...form, end: event.target.value })} /></label>
        <label className="is-wide"><span>Officer notes</span><textarea rows={2} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} placeholder="Attendance, access, and safety handoff" /></label>
        <footer><span><UserCheck size={13} /> Creates a published slot, then materializes the officer shift.</span><button type="submit" disabled={saving || !form.officerId || !form.workUnitId || !form.start || !form.end}>{saving ? 'Publishing' : 'Publish shift'}</button></footer>
      </form>}
    </>}
  </section>;
}
