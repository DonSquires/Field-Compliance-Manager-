import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import type { BriefingPlace } from '../lib/safetyBriefing';
import './ShiftSafetyBriefing.css';

export interface TaskRiskAssessment {
  id: string; task: string; hazards: string; controls: string[]; likelihood: number; consequence: number;
  decision: 'proceed_with_controls' | 'stop_work'; signed_at: string;
  review_status?: string; review_outcome?: string | null;
}

export function DynamicRiskAssessment({ shiftId, places }: { shiftId: string; places: BriefingPlace[] }) {
  const [items, setItems] = useState<TaskRiskAssessment[]>([]);
  const [open, setOpen] = useState(false);
  const [placeKey, setPlaceKey] = useState('');
  const [task, setTask] = useState('');
  const [hazards, setHazards] = useState('');
  const [controls, setControls] = useState('');
  const [likelihood, setLikelihood] = useState('');
  const [consequence, setConsequence] = useState('');
  const [decision, setDecision] = useState('');
  const [understood, setUnderstood] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requestId = useRef(crypto.randomUUID());
  const currentShift = useRef(shiftId);
  currentShift.current = shiftId;
  const load = useCallback(async () => {
    // ATLAS READS: get_shift_risk_assessments
    const { data, error: failure } = await supabase.rpc('get_shift_risk_assessments', { p_shift_id: shiftId });
    if (failure || !Array.isArray(data)) throw new Error(failure?.message ?? 'Task assessments could not be loaded.');
    if (currentShift.current === shiftId) setItems(data as TaskRiskAssessment[]);
  }, [shiftId]);
  useEffect(() => {
    setItems([]); setOpen(false); setNotice(null); setError(null); setSaving(false);
    requestId.current = crypto.randomUUID();
    void load().catch((cause: Error) => { if (currentShift.current === shiftId) setError(cause.message); });
  }, [load, shiftId]);

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setError(null); setNotice(null);
    const place = places.find((p) => `${p.kind}:${p.id}` === placeKey);
    try {
      if (!place) throw new Error('Select the place being assessed.');
      // ATLAS WRITES: submit_dynamic_risk_assessment
      const { data, error: failure } = await supabase.rpc('submit_dynamic_risk_assessment', {
        p_shift_id: shiftId, p_place_kind: place.kind, p_place_id: place.id,
        p_task: task.trim(), p_hazards: hazards.trim(), p_controls: controls.split('\n').map((c) => c.trim()).filter(Boolean),
        p_likelihood: Number(likelihood), p_consequence: Number(consequence), p_decision: decision,
        p_understood: understood, p_client_request_id: requestId.current,
      });
      if (failure || !data?.id || !data?.signed_at) throw new Error(failure?.message ?? 'The signed assessment was not confirmed.');
      if (currentShift.current !== shiftId) return;
      setNotice(decision === 'stop_work'
        ? 'STOP WORK on this task. Move to safety and contact your supervisor. Your signed assessment is recorded and reviewers have been notified.'
        : 'Signed assessment recorded; proceed only with the stated controls. Supervisor review is pending.');
      setOpen(false); requestId.current = crypto.randomUUID();
      await load();
    } catch (cause) { if (currentShift.current === shiftId) setError(cause instanceof Error ? cause.message : 'The assessment was not saved.'); }
    finally { if (currentShift.current === shiftId) setSaving(false); }
  };

  return <section className="safety-task-assessments" aria-label="Dynamic task risk assessments">
    <details>
      <summary>Task risk assessments ({items.length})</summary>
      <p>Assess the specific task before doing it. This signed record is separate from reading the site briefing.</p>
      {error && <p role="alert" className="safety-briefing-error">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <button type="button" onClick={() => void load().catch((cause: Error) => setError(cause.message))}>Refresh task assessments</button>
      <button type="button" disabled={!places.length || saving} onClick={() => {
        setPlaceKey(places[0] ? `${places[0].kind}:${places[0].id}` : '');
        setTask(''); setHazards(''); setControls(''); setLikelihood(''); setConsequence(''); setDecision(''); setUnderstood(false);
        setOpen(true); setError(null); setNotice(null); requestId.current = crypto.randomUUID();
      }}>Assess a task</button>
      {!places.length && <p>No place is linked to this shift. Contact your supervisor.</p>}
      {open && <form className="safety-report-form" onSubmit={(e) => void submit(e)}>
        <label>Assessment place<select required value={placeKey} onChange={(e) => setPlaceKey(e.target.value)}>{places.map((p) => <option key={`${p.kind}:${p.id}`} value={`${p.kind}:${p.id}`}>{p.name}</option>)}</select></label>
        <label>Task to be done<input required minLength={3} maxLength={200} value={task} onChange={(e) => setTask(e.target.value)} /></label>
        <label>Hazards observed<textarea required minLength={3} maxLength={4000} value={hazards} onChange={(e) => setHazards(e.target.value)} /></label>
        <label>Task controls, one per line<textarea required value={controls} onChange={(e) => setControls(e.target.value)} /></label>
        <div className="safety-report-row">
          <label>Task likelihood (1-5)<input required type="number" min={1} max={5} step={1} value={likelihood} onChange={(e) => setLikelihood(e.target.value)} /></label>
          <label>Task consequence (1-5)<input required type="number" min={1} max={5} step={1} value={consequence} onChange={(e) => setConsequence(e.target.value)} /></label>
        </div>
        <label>Work decision<select required value={decision} onChange={(e) => setDecision(e.target.value)}>
          <option value="">Choose after assessing the task</option><option value="proceed_with_controls">Proceed with these controls</option><option value="stop_work">Unsafe - stop work and contact supervisor</option>
        </select></label>
        {decision === 'stop_work' && <p role="alert">Do not begin or resume this task. Move to safety and contact your supervisor now; a notification is not emergency assistance.</p>}
        <label><input type="checkbox" required checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />I assessed this task, understand the risks and controls, and confirm this decision.</label>
        <div className="safety-dialog-actions"><button type="button" disabled={saving} onClick={() => setOpen(false)}>Cancel assessment</button><button type="submit" disabled={saving}>{saving ? 'Recording...' : 'Sign and submit assessment'}</button></div>
      </form>}
      {items.length === 0 && <p>No task assessments recorded on this shift.</p>}
      {items.map((item) => <article key={item.id} className="safety-task-receipt">
        <strong>{item.task}</strong>
        <p>{item.decision === 'stop_work' ? 'STOP WORK - reassess before resuming this task' : 'Proceed only with the recorded controls'} | Score {item.likelihood * item.consequence}/25</p>
        <p>{item.hazards}</p><ul>{item.controls.map((c, i) => <li key={i}>{c}</li>)}</ul>
        <small>Signed {new Date(item.signed_at).toLocaleString('en-NZ')} | {item.review_status === 'closed' ? 'Reviewed by supervisor' : 'Awaiting supervisor review'}</small>
        {item.review_outcome && <p>Supervisor findings: {item.review_outcome}</p>}
      </article>)}
    </details>
  </section>;
}
