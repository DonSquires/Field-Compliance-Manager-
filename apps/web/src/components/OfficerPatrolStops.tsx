/**
 * OfficerPatrolStops — the contracted site visits of the officer's shift, one action at a time.
 * Reads get_officer_patrol_stops; writes only through manage_officer_patrol_stop (arrive / depart).
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { AlertTriangle, CheckCircle2, MapPin, RefreshCw, Signpost, TriangleAlert } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { plainWords } from '../lib/rosterWords';
import { briefingNeedsAcknowledgement, fetchShiftSafetyBriefing, type SafetyBriefing } from '../lib/safetyBriefing';
import { SafetyBriefingDialog } from './ShiftSafetyBriefing';
import './OfficerPatrolStops.css';

interface StopPlace { kind: 'site' | 'zone' | 'unknown'; name: string; address: string | null; access_instructions: string | null; hs_notes: string | null }
interface StopModule { module_key: string; is_required: boolean; status: string | null }
export interface PatrolStop {
  id: string; stop_order: number; visit_number: number; visits_total: number;
  status: 'pending' | 'en_route' | 'on_scene' | 'completed' | 'skipped' | 'cancelled';
  sla_status: string; sla_window_open: string | null; sla_arrive_by: string; sla_depart_by: string | null;
  required_dwell_minutes: number; officer_instructions: string | null;
  actual_arrived_at: string | null; actual_departed_at: string | null;
  arrival_verification: string | null; arrival_distance_m: number | null; officer_notes: string | null;
  module_key: string; modules?: StopModule[]; place: StopPlace;
}
interface StopsBundle { shift: { id: string; status: string; scheduled_start: string; scheduled_end: string; route_name: string | null }; stops: PatrolStop[] }
interface StopReceipt { reference: string; action: 'arrive' | 'depart'; occurred_at: string; stop_status: string; sla_status: string; arrival_verification: string | null; dwell_minutes: number | null; dwell_short: boolean; completed_stops: number; total_stops: number; billing_review_required?: boolean }

const time = (value: string | null) => value ? new Date(value).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' }) : null;
/** The toolset at this stop, in plain words: the modules the contract asks for, required ones first ("Parking enforcement"). */
export const stopToolset = (stop: Pick<PatrolStop, 'module_key' | 'modules'>): string => {
  const keys = (stop.modules ?? []).filter((module) => module.module_key !== 'general_patrol').map((module) => module.module_key);
  const source = keys.length ? keys : [stop.module_key];
  return source.map((key) => key === 'general_patrol' ? 'General patrol' : plainWords(key)).join(' · ');
};
const VERIFICATION_TEXT: Record<string, string> = {
  verified_on_site: 'GPS confirmed you on site',
  near_site: 'GPS placed you near the site',
  off_site: 'GPS placed you away from the site — recorded, not hidden',
  unverified_boundary: 'Site boundary not yet verified; GPS recorded',
  no_geofence: 'This place has no geofence yet; GPS recorded',
  no_gps: 'No GPS position was available',
};

async function currentPosition(): Promise<{ latitude: number; longitude: number; accuracy: number } | null> {
  if (!navigator.geolocation) return null;
  return new Promise((resolve) => navigator.geolocation.getCurrentPosition(
    ({ coords }) => resolve({ latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy }),
    () => resolve(null),
    { enableHighAccuracy: true, maximumAge: 15_000, timeout: 10_000 },
  ));
}

export function OfficerPatrolStops({ shiftId }: { shiftId: string }) {
  const [bundle, setBundle] = useState<StopsBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<StopReceipt | null>(null);
  const [notes, setNotes] = useState('');
  const [delayReason, setDelayReason] = useState('');
  const pendingRequest = useRef<Record<string, string>>({});
  const [stopBriefing, setStopBriefing] = useState<{ stop: PatrolStop; briefing: SafetyBriefing } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    // ATLAS READS: get_officer_patrol_stops
    const { data, error: rpcError } = await supabase.rpc('get_officer_patrol_stops', { p_shift_id: shiftId });
    if (rpcError) setError(rpcError.message);
    else setBundle((data as StopsBundle | null) ?? null);
    setLoading(false);
  }, [shiftId]);

  useEffect(() => { void load(); }, [load]);

  const stops = bundle?.stops ?? [];
  const current = stops.find((stop) => stop.status === 'on_scene') ?? stops.find((stop) => stop.status === 'pending' || stop.status === 'en_route') ?? null;
  const done = stops.filter((stop) => stop.status === 'completed').length;

  const act = async (stop: PatrolStop, action: 'arrive' | 'depart') => {
    setSaving(true); setError(null); setReceipt(null);
    if (action === 'arrive') {
      try {
        const briefing = await fetchShiftSafetyBriefing(shiftId, stop.id);
        if (briefingNeedsAcknowledgement(briefing)) {
          setStopBriefing({ stop, briefing }); setSaving(false); return;
        }
      } catch (briefingError) {
        setError(`The safety briefing for ${stop.place.name} could not be loaded (${briefingError instanceof Error ? briefingError.message : 'unknown error'}). Retry before entering.`);
        setSaving(false);
        return;
      }
    }
    const key = `${stop.id}:${action}`;
    pendingRequest.current[key] ??= crypto.randomUUID();
    const position = await currentPosition();
    // ATLAS WRITES: manage_officer_patrol_stop (expected-status check, receipt, audit on the server)
    const { data, error: rpcError } = await supabase.rpc('manage_officer_patrol_stop', {
      p_stop_id: stop.id, p_expected_status: stop.status, p_action: action, p_request_id: pendingRequest.current[key],
      p_notes: action === 'depart' ? notes.trim() || null : null,
      p_gps_lat: position?.latitude ?? null, p_gps_lng: position?.longitude ?? null, p_gps_accuracy_metres: position?.accuracy ?? null,
      p_sla_delay_reason: action === 'depart' ? delayReason.trim() || null : null,
    });
    if (rpcError) setError(rpcError.message);
    else {
      delete pendingRequest.current[key];
      setReceipt(data as StopReceipt);
      if (action === 'depart') { setNotes(''); setDelayReason(''); }
      await load();
    }
    setSaving(false);
  };

  const depart = (event: FormEvent) => { event.preventDefault(); if (current) void act(current, 'depart'); };

  if (loading && !bundle) return <section className="patrol-stops" aria-label="Contracted stops"><p className="patrol-stops-subtle"><RefreshCw size={14} className="is-spinning" /> Loading your contracted stops…</p></section>;
  if (!bundle) return null;

  return (
    <section className="patrol-stops" aria-label="Contracted stops">
      <header className="patrol-stops-header">
        <div>
          <span className="patrol-stops-kicker">Contracted stops</span>
          <h3>{stops.length === 0 ? 'No contracted stops on this shift' : `${done} of ${stops.length} stops done`}</h3>
        </div>
        <button type="button" className="patrol-stops-refresh" onClick={() => void load()} disabled={loading} aria-label="Refresh contracted stops"><RefreshCw size={15} className={loading ? 'is-spinning' : ''} /></button>
      </header>

      {stopBriefing && <SafetyBriefingDialog briefing={stopBriefing.briefing} title={`Risks at ${stopBriefing.stop.place.name}`} acknowledgeLabel="I've read these risks - record arrival" onClose={() => setStopBriefing(null)} onAcknowledged={async () => { const stop = stopBriefing.stop; setStopBriefing(null); await act(stop, 'arrive'); }} onReload={async () => { const next = await fetchShiftSafetyBriefing(shiftId, stopBriefing.stop.id); setStopBriefing({ stop: stopBriefing.stop, briefing: next }); return next; }} />}
      {error && <div className="patrol-stops-message is-error" role="alert"><AlertTriangle size={16} />{error}</div>}
      {receipt && (
        <div className="patrol-stops-message is-success" role="status">
          <CheckCircle2 size={16} />
          <span><strong>{receipt.action === 'arrive' ? 'Arrival' : 'Departure'} recorded</strong> at {time(receipt.occurred_at)} · receipt {receipt.reference}
            {receipt.action === 'arrive' && receipt.arrival_verification ? ` · ${VERIFICATION_TEXT[receipt.arrival_verification] ?? receipt.arrival_verification}` : ''}
            {receipt.action === 'depart' && receipt.dwell_minutes !== null ? ` · ${receipt.dwell_minutes} min on site${receipt.dwell_short ? ' (shorter than contracted)' : ''}` : ''}
            {receipt.billing_review_required ? ' · visit recorded; finance review required before invoicing' : ''}
            {receipt.sla_status === 'breached' ? ' · arrived after the contracted window' : ''}.
          </span>
        </div>
      )}

      {stops.length === 0 ? (
        <p className="patrol-stops-subtle">This shift has no contracted site visits. If it should, ask your supervisor to build the patrol run for the agreement.</p>
      ) : (
        <ol className="patrol-stops-list">
          {stops.map((stop, index) => {
            const isCurrent = current?.id === stop.id;
            const state = stop.status === 'completed' ? 'done' : stop.status === 'skipped' || stop.status === 'cancelled' ? 'off' : isCurrent ? 'current' : 'later';
            return (
              <li key={stop.id} className={`patrol-stop is-${state} ${stop.sla_status === 'breached' ? 'is-late' : ''}`} aria-current={isCurrent ? 'step' : undefined}>
                {/* stop_order is a generator sort key (order × 10 + visit); officers get a plain 1..N. */}
                <span className="patrol-stop-number">{state === 'done' ? <CheckCircle2 size={15} aria-hidden="true" /> : index + 1}</span>
                <div className="patrol-stop-body">
                  <div className="patrol-stop-title">
                    <strong>{stop.place.name}</strong>
                    <span className="patrol-stop-toolset">{stopToolset(stop)}</span>
                    <span>{stop.visits_total > 1 ? `Visit ${stop.visit_number} of ${stop.visits_total} · ` : ''}{stop.status === 'completed' ? `Done ${time(stop.actual_departed_at) ?? ''}` : stop.status === 'on_scene' ? `On site since ${time(stop.actual_arrived_at)}` : stop.status === 'skipped' ? 'Skipped by dispatch' : stop.status === 'cancelled' ? 'Cancelled by dispatch' : `Arrive ${stop.sla_window_open ? `between ${time(stop.sla_window_open)} and ` : 'by '}${time(stop.sla_arrive_by)}`} · stay {stop.required_dwell_minutes} min</span>
                  </div>
                  {stop.place.address && <p className="patrol-stop-address">{stop.place.address}</p>}
                  {(isCurrent || stop.status === 'on_scene') && (
                    <div className="patrol-stop-brief">
                      {stop.officer_instructions && <p><strong>Do here:</strong> {stop.officer_instructions}</p>}
                      {stop.place.access_instructions && <p><strong>Access:</strong> {stop.place.access_instructions}</p>}
                      {stop.place.hs_notes && <p className="is-safety"><TriangleAlert size={13} aria-hidden="true" /> <strong>Safety:</strong> {stop.place.hs_notes}</p>}
                      {!stop.officer_instructions && !stop.place.access_instructions && !stop.place.hs_notes && <p>No special instructions for this place.</p>}
                    </div>
                  )}
                  {stop.status === 'completed' && stop.officer_notes && <p className="patrol-stop-notes">Your notes: {stop.officer_notes}</p>}
                  {isCurrent && (stop.status === 'pending' || stop.status === 'en_route') && (
                    <button type="button" className="btn btn-primary patrol-stop-action" onClick={() => void act(stop, 'arrive')} disabled={saving}><MapPin size={16} aria-hidden="true" /> {saving ? 'Recording…' : `Arrived at ${stop.place.name}`}</button>
                  )}
                  {isCurrent && stop.status === 'on_scene' && (
                    <form className="patrol-stop-depart" onSubmit={depart}>
                      <label><span>What you found and did here{stop.sla_status === 'breached' ? '' : ' (needed only if you leave early)'}</span><textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="e.g. Gates locked, lights checked, nothing unusual" /></label>
                      {stop.sla_status === 'breached' && <label><span>Why you arrived after the contracted window</span><input value={delayReason} onChange={(event) => setDelayReason(event.target.value)} placeholder="e.g. Held at previous site by an alarm response" required /></label>}
                      <button type="submit" className="btn btn-primary patrol-stop-action" disabled={saving}><Signpost size={16} aria-hidden="true" /> {saving ? 'Recording…' : `Leaving ${stop.place.name}`}</button>
                    </form>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
