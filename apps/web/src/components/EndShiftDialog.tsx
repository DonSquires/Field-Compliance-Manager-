import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Circle, RefreshCw, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useOfficerUnsavedWork } from '../context/OfficerUnsavedWorkContext';
import './EndShiftDialog.css';

export interface EndShiftReadiness {
  shift_id: string;
  status: string;
  service_type: string;
  scheduled_end: string;
  actual_start: string | null;
  open_stops: Array<{ stop_id: string; place: string; status: string; module_key: string | null }>;
  open_stop_count: number;
  open_required_task_count: number;
  open_dispatch_job_count: number;
  active_welfare_alert_count: number;
  debrief_submitted: boolean;
  blockers: string[];
  can_end: boolean;
  can_end_after_debrief: boolean;
}

export type EndShiftDestination = 'stops' | 'dispatch' | 'debrief' | 'timesheet' | 'home';

interface EndShiftDialogProps {
  shiftId: string;
  shiftStatus: string;
  serviceType: string;
  onClose: () => void;
  onEnded: (receipt: { completed_at: string }) => Promise<void> | void;
  onNavigate: (destination: EndShiftDestination) => void;
}

const currentPosition = () => new Promise<{ lat: number | null; lng: number | null }>((resolve) => {
  if (typeof navigator === 'undefined' || !navigator.geolocation) { resolve({ lat: null, lng: null }); return; }
  navigator.geolocation.getCurrentPosition((position) => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }), () => resolve({ lat: null, lng: null }), { enableHighAccuracy: true, timeout: 5000, maximumAge: 30000 });
});

const workedFor = (start: string | null) => {
  if (!start) return null;
  const minutes = Math.max(0, Math.round((Date.now() - new Date(start).getTime()) / 60_000));
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
};

/** One place to end a shift: shows what is still open, takes the debrief if it is missing, then ends. */
export function EndShiftDialog({ shiftId, shiftStatus, serviceType, onClose, onEnded, onNavigate }: EndShiftDialogProps) {
  const [readiness, setReadiness] = useState<EndShiftReadiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);
  const [summary, setSummary] = useState('');
  const [safetyIncident, setSafetyIncident] = useState(false);
  const [equipmentIssue, setEquipmentIssue] = useState(false);
  const [followUp, setFollowUp] = useState(false);
  const [followUpNotes, setFollowUpNotes] = useState('');
  const [debriefEventId] = useState(() => crypto.randomUUID());
  const dirty = Boolean(ending || summary || safetyIncident || equipmentIssue || followUp || followUpNotes);
  const clearUnsavedWork = useOfficerUnsavedWork(dirty);
  const leaveDialog = (action: () => void) => {
    if (dirty && !window.confirm('Your debrief is not confirmed. Leave and lose the unsubmitted writing?')) return;
    clearUnsavedWork();
    action();
  };

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    // ATLAS READS: get_shift_end_readiness
    const { data, error: readError } = await supabase.rpc('get_shift_end_readiness', { p_shift_id: shiftId });
    if (readError || !data) setError(readError?.message ?? 'Shift status could not be checked.');
    else setReadiness(data as EndShiftReadiness);
    setLoading(false);
  }, [shiftId]);
  useEffect(() => { void load(); }, [load]);

  const needsDebrief = readiness ? !readiness.debrief_submitted : false;
  const debriefReady = !needsDebrief || summary.trim().length >= 10;
  const canEnd = Boolean(readiness && (readiness.can_end || (readiness.can_end_after_debrief && debriefReady)));

  const endShift = async () => {
    if (!readiness) return;
    setEnding(true); setError(null);
    if (needsDebrief) {
      // ATLAS WRITES: submit_shift_debrief (the debrief is part of ending the shift when it has not been recorded yet)
      const { error: debriefError } = await supabase.rpc('submit_shift_debrief', { p_shift_id: shiftId, p_client_event_id: debriefEventId, p_summary: summary.trim(), p_safety_incident_reported: safetyIncident, p_equipment_issue_reported: equipmentIssue, p_follow_up_required: followUp, p_follow_up_notes: followUp ? (followUpNotes.trim() || null) : null });
      if (debriefError) { setError(debriefError.message); setEnding(false); return; }
    }
    const coords = await currentPosition();
    // ATLAS WRITES: complete_officer_shift (server re-checks every rule; the end position is recorded, never a gate)
    const { data, error: endError } = await supabase.rpc('complete_officer_shift', { p_shift_id: shiftId, p_expected_status: shiftStatus, p_gps_lat: coords.lat, p_gps_lng: coords.lng });
    const receipt = (Array.isArray(data) ? data[0] : data) as { shift_id: string; shift_status: string; completed_at: string } | null;
    if (endError || !receipt) { setError(endError?.message ?? 'The shift was not ended. Check what is still open and try again.'); await load(); setEnding(false); return; }
    await onEnded({ completed_at: receipt.completed_at });
    setEnding(false);
  };

  const item = (done: boolean, label: string, detail: string | null, action?: { label: string; destination: EndShiftDestination }) => (
    <li className={done ? 'is-done' : 'is-open'} key={label}>
      {done ? <CheckCircle2 size={18} aria-hidden="true" /> : <Circle size={18} aria-hidden="true" />}
      <div><strong>{label}</strong>{detail && <span>{detail}</span>}</div>
      {!done && action && <button type="button" onClick={() => leaveDialog(() => onNavigate(action.destination))}>{action.label}</button>}
    </li>
  );

  const stopsDestination: EndShiftDestination = 'stops';
  return (
    <div className="end-shift-backdrop">
      <div className="end-shift-dialog" role="dialog" aria-modal="true" aria-labelledby="end-shift-title">
        <header>
          <div><span>Finish up</span><h2 id="end-shift-title">End {serviceType.replaceAll('_', ' ')} shift</h2></div>
          <button type="button" onClick={() => leaveDialog(onClose)} aria-label="Close"><X size={18} /></button>
        </header>
        {error && <p className="end-shift-error" role="alert"><AlertTriangle size={16} aria-hidden="true" /> {error}</p>}
        {loading || !readiness ? <p className="end-shift-note"><RefreshCw size={16} className="is-spinning" aria-hidden="true" /> Checking what is still open…</p> : <>
          <p className="end-shift-note">{readiness.actual_start ? `On shift for ${workedFor(readiness.actual_start)}.` : ''} Everything below needs a tick before the shift can end.</p>
          <ul className="end-shift-checklist" aria-label="Before the shift can end">
            {item(readiness.open_stop_count === 0 && readiness.open_required_task_count === 0, readiness.open_stop_count === 0 && readiness.open_required_task_count === 0 ? 'Every stop is done' : `${readiness.open_stop_count} ${readiness.open_stop_count === 1 ? 'stop' : 'stops'} still open`, readiness.open_stops.length ? readiness.open_stops.map((stop) => stop.place).join(', ') : readiness.open_required_task_count ? `${readiness.open_required_task_count} required ${readiness.open_required_task_count === 1 ? 'task' : 'tasks'} not done` : null, { label: 'Open stops', destination: stopsDestination })}
            {item(readiness.open_dispatch_job_count === 0, readiness.open_dispatch_job_count === 0 ? 'No dispatch jobs open' : `${readiness.open_dispatch_job_count} dispatch ${readiness.open_dispatch_job_count === 1 ? 'job' : 'jobs'} still open`, null, { label: 'Open dispatch', destination: 'dispatch' })}
            {item(readiness.active_welfare_alert_count === 0, readiness.active_welfare_alert_count === 0 ? 'No welfare alerts active' : `${readiness.active_welfare_alert_count} welfare ${readiness.active_welfare_alert_count === 1 ? 'alert' : 'alerts'} to resolve`, readiness.active_welfare_alert_count ? 'Resolve it from the safety panel, or call your supervisor.' : null)}
            {item(readiness.debrief_submitted, readiness.debrief_submitted ? 'Debrief recorded' : 'Debrief', readiness.debrief_submitted ? null : 'A few words about the shift, below.')}
          </ul>
          {needsDebrief && <div className="end-shift-debrief">
            <label><span>How did the shift go?</span><textarea rows={3} value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="What happened, anything the next officer or your supervisor should know (at least 10 characters)" /></label>
            <div className="end-shift-flags">
              <label><input type="checkbox" checked={safetyIncident} onChange={(event) => setSafetyIncident(event.target.checked)} /><span>Safety incident</span></label>
              <label><input type="checkbox" checked={equipmentIssue} onChange={(event) => setEquipmentIssue(event.target.checked)} /><span>Equipment issue</span></label>
              <label><input type="checkbox" checked={followUp} onChange={(event) => setFollowUp(event.target.checked)} /><span>Needs follow-up</span></label>
            </div>
            {followUp && <label><span>What needs following up?</span><textarea rows={2} value={followUpNotes} onChange={(event) => setFollowUpNotes(event.target.value)} /></label>}
          </div>}
          {readiness.status !== 'in_progress' && <p className="end-shift-error" role="status">This shift is {readiness.status.replaceAll('_', ' ')}, so there is nothing to end.</p>}
          <footer>
            <button type="button" onClick={() => leaveDialog(onClose)}>Not yet</button>
            <button type="button" className="is-primary" disabled={!canEnd || ending} onClick={() => void endShift()}>{ending ? 'Ending…' : needsDebrief ? 'Record debrief and end shift' : 'End shift'}</button>
          </footer>
        </>}
      </div>
    </div>
  );
}
