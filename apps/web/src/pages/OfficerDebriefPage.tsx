import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ClipboardCheck, Clock3, Home, RefreshCw, Send, ShieldAlert, Wrench, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useLocation } from 'react-router-dom';
import { describeLoadFailures } from '../lib/friendlyLoadError';
import { supabase } from '../lib/supabase';
import './OfficerDebriefPage.css';

interface ShiftOption { id: string; service_type: string; scheduled_start: string; scheduled_end: string; status: string; total_stops: number; completed_stops: number; }
interface DebriefRecord { id: string; shift_id: string; summary: string; safety_incident_reported: boolean; equipment_issue_reported: boolean; follow_up_required: boolean; follow_up_notes: string | null; submitted_at: string; }
interface DebriefFollowup { id:string;debrief_id:string;status:string;priority:string;owner_user_id:string|null;latest_note:string|null;resolved_at:string|null; }

const OfficerDebriefPage: React.FC<{ onNavigate?: (destination: 'home' | 'timesheet') => void }> = ({ onNavigate }) => {
  const location=useLocation();const requestedDebriefId=new URLSearchParams(location.search).get('debrief');
  const { profile } = useAuth();
  const [shifts, setShifts] = useState<ShiftOption[]>([]);
  const [debriefs, setDebriefs] = useState<DebriefRecord[]>([]);
  const [followups,setFollowups]=useState<Record<string,DebriefFollowup>>({});
  const [shiftId, setShiftId] = useState('');
  const [summary, setSummary] = useState('');
  const [safetyIncident, setSafetyIncident] = useState(false);
  const [equipmentIssue, setEquipmentIssue] = useState(false);
  const [followUp, setFollowUp] = useState(false);
  const [followUpNotes, setFollowUpNotes] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [completionShift, setCompletionShift] = useState<ShiftOption | null>(null);
  const [completedShiftId, setCompletedShiftId] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const eventIdRef = useRef(crypto.randomUUID());

  const loadDebriefData = useCallback(async () => {
    if (!profile?.id || !profile.organizationId) return;
    setLoading(true);
    setError(null);
    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const [shiftResponse, debriefResponse] = await Promise.all([
      supabase.from('shifts').select('id, service_type, scheduled_start, scheduled_end, status, total_stops, completed_stops').eq('organization_id', profile.organizationId).eq('officer_user_id', profile.id).in('status', ['accepted', 'in_progress', 'completed']).gte('scheduled_start', since).order('scheduled_start', { ascending: false }).limit(30),
      supabase.from('shift_debriefs').select('id, shift_id, summary, safety_incident_reported, equipment_issue_reported, follow_up_required, follow_up_notes, submitted_at').eq('officer_user_id', profile.id).order('submitted_at', { ascending: false }).limit(30),
    ]);
    const shiftRows = (shiftResponse.data as ShiftOption[]) ?? [];
    const debriefRows = (debriefResponse.data as DebriefRecord[]) ?? [];
    setShifts(shiftRows);
    setDebriefs(debriefRows);
    if(debriefRows.length){const{data:followupRows,error:followupError}=await supabase.from('debrief_followups').select('id,debrief_id,status,priority,owner_user_id,latest_note,resolved_at').in('debrief_id',debriefRows.map((debrief)=>debrief.id));if(followupError)setError(describeLoadFailures([['debrief follow-up status', followupError]]));else setFollowups(Object.fromEntries(((followupRows as DebriefFollowup[])??[]).map((item)=>[item.debrief_id,item])));}else setFollowups({});
    setShiftId((current) => current || shiftRows.find((shift) => !debriefRows.some((debrief) => debrief.shift_id === shift.id))?.id || '');
    const failure = describeLoadFailures([['shifts', shiftResponse.error], ['debriefs', debriefResponse.error]]);
    if (failure) setError(failure);
    setLoading(false);
  }, [profile?.id, profile?.organizationId]);

  useEffect(() => { void loadDebriefData(); }, [loadDebriefData]);
  useEffect(()=>{if(requestedDebriefId)document.getElementById(`officer-debrief-${requestedDebriefId}`)?.scrollIntoView({block:'center'});},[debriefs,requestedDebriefId]);

  const submittedShiftIds = useMemo(() => new Set(debriefs.map((debrief) => debrief.shift_id)), [debriefs]);
  const eligibleShifts = shifts.filter((shift) => !submittedShiftIds.has(shift.id));
  const selectedShift = shifts.find((shift) => shift.id === shiftId) ?? null;
  const canSubmit = Boolean(shiftId && summary.trim().length >= 10 && (!followUp || followUpNotes.trim()) && !submitting);

  const submitDebrief = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    setNotice(null);
    const { data, error: submitError } = await supabase.rpc('submit_shift_debrief', {
      p_shift_id: shiftId,
      p_client_event_id: eventIdRef.current,
      p_summary: summary.trim(),
      p_safety_incident_reported: safetyIncident,
      p_equipment_issue_reported: equipmentIssue,
      p_follow_up_required: followUp,
      p_follow_up_notes: followUp ? followUpNotes.trim() : null,
    });
    if (submitError || !(data as Array<{ id: string }> | null)?.[0]) {
      setError(submitError?.message ?? 'Debrief receipt was not confirmed. Your entries remain available for retry.');
    } else {
      setCompletionShift(selectedShift?.status === 'in_progress' ? selectedShift : null);
      setNotice(selectedShift?.status === 'in_progress' ? 'Debrief recorded. Complete the shift when all field work is finished.' : 'Debrief submitted with an auditable server receipt.');
      setSummary(''); setSafetyIncident(false); setEquipmentIssue(false); setFollowUp(false); setFollowUpNotes('');
      eventIdRef.current = crypto.randomUUID();
      await loadDebriefData();
    }
    setSubmitting(false);
  };

  const completeShift = async () => {
    if (!completionShift) return;
    setCompleting(true);setError(null);setNotice(null);
    const { data, error: completionError } = await supabase.rpc('complete_officer_shift', { p_shift_id: completionShift.id, p_expected_status: completionShift.status });
    const receipt = (data as Array<{ shift_id: string; shift_status: string; completed_at: string }> | null)?.[0];
    if (completionError || !receipt) setError(completionError?.message ?? 'Shift completion was not confirmed. Review remaining field work and retry.');
    else { setCompletionShift(null);setCompletedShiftId(receipt.shift_id);setNotice(`Shift completed at ${new Date(receipt.completed_at).toLocaleString('en-NZ')}. You are no longer on active duty for this shift.`);await loadDebriefData(); }
    setCompleting(false);
  };

  return <div className="officer-debrief">
    <header className="officer-debrief-header"><div><span>Shift handover</span><h1>Debrief</h1><p>Record operational context for the next supervisor or team.</p></div><button type="button" onClick={() => void loadDebriefData()} disabled={loading} title="Refresh debriefs"><RefreshCw size={17} className={loading ? 'is-spinning' : ''} /></button></header>
    {error && <div className="officer-debrief-message is-error" role="alert"><AlertTriangle size={17} /><span>{error}</span><button type="button" onClick={() => setError(null)} title="Dismiss"><X size={16} /></button></div>}
    {notice && <div className="officer-debrief-message is-success" role="status"><CheckCircle2 size={17} /><span>{notice}</span><button type="button" onClick={() => setNotice(null)} title="Dismiss"><X size={16} /></button></div>}
    {completionShift && <section className="officer-debrief-completion" aria-label="Shift completion"><div><span>Debrief received</span><strong>Finish {completionShift.service_type.replaceAll('_', ' ')} shift</strong><p>Completion confirms all stops, required module tasks, dispatch jobs, and welfare alerts are closed.</p></div><button type="button" onClick={() => void completeShift()} disabled={completing}>{completing ? <><RefreshCw size={16} className="is-spinning" />Completing</> : <><CheckCircle2 size={16} />Complete shift</>}</button></section>}
    {completedShiftId && <section className="officer-debrief-next" aria-label="After shift completion"><div><span>Shift receipt</span><strong>{completedShiftId.slice(0, 8)}</strong><p>Record worked time now, or return to the officer home screen.</p></div><div><button type="button" onClick={() => onNavigate?.('home')}><Home size={16} />Return home</button><button type="button" className="is-primary" onClick={() => onNavigate?.('timesheet')}><Clock3 size={16} />Open timesheet</button></div></section>}
    <div className="officer-debrief-layout">
      <form className="officer-debrief-form" onSubmit={submitDebrief}>
        <div className="officer-debrief-panel-heading"><div><span>New handover</span><h2>Shift account</h2></div><ClipboardCheck size={20} /></div>
        <label><span>Shift</span><select value={shiftId} onChange={(event) => { setShiftId(event.target.value); eventIdRef.current = crypto.randomUUID(); }} disabled={loading}><option value="">Select eligible shift</option>{eligibleShifts.map((shift) => <option value={shift.id} key={shift.id}>{new Date(shift.scheduled_start).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })} · {shift.service_type.replaceAll('_', ' ')} · {shift.status}</option>)}</select></label>
        {selectedShift && <div className="officer-debrief-shift"><Clock3 size={16} /><div><strong>{new Date(selectedShift.scheduled_start).toLocaleString('en-NZ', { dateStyle: 'medium', timeStyle: 'short' })}</strong><span>{selectedShift.completed_stops} of {selectedShift.total_stops} stops completed · shift remains {selectedShift.status.replaceAll('_', ' ')}</span></div></div>}
        <label><span>Operational summary</span><textarea required minLength={10} maxLength={5000} rows={6} value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="Work completed, exceptions, unresolved conditions, and context the next team needs" /><small>{summary.trim().length}/5000 · minimum 10 characters</small></label>
        <div className="officer-debrief-toggles"><label><input type="checkbox" checked={safetyIncident} onChange={(event) => setSafetyIncident(event.target.checked)} /><span><ShieldAlert size={17} /><b>Safety incident</b><small>A safety matter occurred during this shift</small></span></label><label><input type="checkbox" checked={equipmentIssue} onChange={(event) => setEquipmentIssue(event.target.checked)} /><span><Wrench size={17} /><b>Equipment issue</b><small>Equipment requires inspection or service</small></span></label><label><input type="checkbox" checked={followUp} onChange={(event) => setFollowUp(event.target.checked)} /><span><ClipboardCheck size={17} /><b>Follow-up required</b><small>A supervisor or next shift must take action</small></span></label></div>
        {followUp && <label><span>Required follow-up</span><textarea required rows={4} value={followUpNotes} onChange={(event) => setFollowUpNotes(event.target.value)} placeholder="Action required, owner if known, and urgency" /></label>}
        <div className="officer-debrief-submit"><span>Submission creates an append-only handover. Shift completion remains a separate confirmed action.</span><button type="submit" disabled={!canSubmit}>{submitting ? <><RefreshCw size={16} className="is-spinning" />Submitting</> : <><Send size={16} />Submit debrief</>}</button></div>
      </form>
      <aside className="officer-debrief-history"><div className="officer-debrief-panel-heading"><div><span>Receipts</span><h2>Recent debriefs</h2></div><strong>{debriefs.length}</strong></div>{loading ? <div className="officer-debrief-empty"><RefreshCw size={19} className="is-spinning" />Loading handovers</div> : debriefs.length === 0 ? <div className="officer-debrief-empty"><ClipboardCheck size={22} />No debriefs submitted yet</div> : <div className="officer-debrief-list">{debriefs.map((debrief) => { const shift = shifts.find((item) => item.id === debrief.shift_id);const followup=followups[debrief.id]; return <article id={`officer-debrief-${debrief.id}`} className={debrief.id===requestedDebriefId?'is-context-focus':undefined} key={debrief.id}><div><strong>{shift ? shift.service_type.replaceAll('_', ' ') : 'Shift debrief'}</strong><time dateTime={debrief.submitted_at}>{new Date(debrief.submitted_at).toLocaleString('en-NZ', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</time></div><p>{debrief.summary}</p><div>{debrief.safety_incident_reported && <span className="is-alert">Safety</span>}{debrief.equipment_issue_reported && <span>Equipment</span>}{debrief.follow_up_required && <span className="is-followup">Follow-up</span>}</div>{debrief.follow_up_notes && <small>{debrief.follow_up_notes}</small>}{followup&&<section className={`officer-debrief-followup status-${followup.status}`}><strong>Admin follow-up · {followup.status}</strong><span>{followup.latest_note??'Awaiting an admin action note.'}</span><small>{followup.priority} priority{followup.resolved_at?` · resolved ${new Date(followup.resolved_at).toLocaleString('en-NZ')}`:''}</small></section>}</article>; })}</div>}</aside>
    </div>
  </div>;
};

export default OfficerDebriefPage;