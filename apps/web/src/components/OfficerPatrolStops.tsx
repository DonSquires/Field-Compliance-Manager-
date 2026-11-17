/**
 * OfficerPatrolStops — the contracted site visits of the officer's shift, one action at a time.
 * Reads the sanitized stop projection; writes only through manage_officer_patrol_stop (arrive / depart).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, MapPin, RefreshCw, Signpost } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useOfficerUnsavedWork } from '../context/OfficerUnsavedWorkContext';
import { plainWords } from '../lib/rosterWords';
import { briefingNeedsAcknowledgement, fetchShiftSafetyBriefing, type SafetyBriefing } from '../lib/safetyBriefing';
import { SafetyBriefingDialog } from './ShiftSafetyBriefing';
import { OfficerStopChecks, checksOutstanding, validStopChecks, type StopCheck } from './OfficerStopChecks';
import { OfficerPatrolMap, type PatrolMapPoint } from './OfficerPatrolMap';
import { OfficerPatrolBriefing } from './OfficerPatrolBriefing';
import type { PatrolJourney } from '../lib/officerPatrolJourney';
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
  module_key: string; modules?: StopModule[]; checks: StopCheck[]; place: StopPlace;
  actual_travel_distance_km?: number | null; travel_from_stop_id?: string | null;
  travel_distance_method?: 'recorded_km' | 'odometer_difference' | null; travel_distance_version?: number;
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

export function OfficerPatrolStops({ shiftId, journey, renderCheckpoints, onDirtyChange }: {
  shiftId: string;
  journey?: PatrolJourney | null;
  renderCheckpoints?: (stopId: string) => ReactNode;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [bundle, setBundle] = useState<StopsBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<StopReceipt | null>(null);
  const [notes, setNotes] = useState('');
  const [delayReason, setDelayReason] = useState('');
  const pendingRequest = useRef<Record<string, string>>({});
  const [stopBriefing, setStopBriefing] = useState<{ stop: PatrolStop; briefing: SafetyBriefing } | null>(null);
  const [travelDrafts, setTravelDrafts] = useState<Record<string, { distance: string; start: string; end: string; useOdometer: boolean }>>({});
  const [travelReceipt, setTravelReceipt] = useState<{ distance_km: number; reference: string } | null>(null);
  const [openDetails, setOpenDetails] = useState<Record<string, boolean>>({});
  const [checksDirty, setChecksDirty] = useState(false);
  const loadVersion = useRef(0);
  const dirty = Boolean(notes || delayReason || saving || checksDirty
    || Object.values(travelDrafts).some((draft) => draft.distance || draft.start || draft.end));
  useOfficerUnsavedWork(dirty);
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setLoading(true); setError(null);
    // ATLAS READS: get_officer_patrol_stops_sanitized
    const { data, error: rpcError } = await supabase.rpc('get_officer_patrol_stops_sanitized', { p_shift_id: shiftId });
    if (version !== loadVersion.current) return;
    if (rpcError) {
      setError(`Stops could not be refreshed and may be out of date. Retry or contact operations. ${rpcError.message}`);
    } else if (!data || typeof data !== 'object' || data.shift?.id !== shiftId || !Array.isArray(data.stops)
      || data.stops.some((stop: PatrolStop) => !stop || !stop.place || typeof stop.place.name !== 'string' || !validStopChecks(stop.checks))) {
      setBundle(null);
      setError('The assigned stop details could not be confirmed. Retry or contact operations.');
    } else setBundle(data as StopsBundle);
    setLoading(false);
  }, [shiftId]);

  useEffect(() => { setBundle(null); void load(); return () => { loadVersion.current += 1; }; }, [load]);

  const stops = bundle?.stops ?? [];
  const current = stops.find((stop) => stop.status === 'on_scene') ?? stops.find((stop) => stop.status === 'pending' || stop.status === 'en_route') ?? null;
  const done = stops.filter((stop) => stop.status === 'completed').length;
  const planMatches = Boolean(journey && journey.stops.length === stops.length
    && journey.stops.every((stop) => stops.some((item) => item.id === stop.id)));
  const mapPoints = useMemo<PatrolMapPoint[]>(() => (journey?.stops ?? []).flatMap((stop, index) => {
    const position = stop.place.coordinates;
    return position ? [{ id: stop.id, name: stop.place.name ?? 'Assigned place', order: index + 1, latitude: position.lat, longitude: position.lng }] : [];
  }), [journey]);
  const groups: Array<{ key: string; label: string; stops: Array<{ stop: PatrolStop; index: number }> }> = [];
  const orderedStops = planMatches && journey
    ? journey.stops.map((entry) => stops.find((stop) => stop.id === entry.id)).filter((stop): stop is PatrolStop => Boolean(stop))
    : stops;
  orderedStops.forEach((stop, index) => {
    const entry = planMatches ? journey?.stops.find((item) => item.id === stop.id) : undefined;
    const clients = entry?.clients.slice().sort((a, b) => a.id.localeCompare(b.id)) ?? [];
    const key = entry ? `${entry.client_attribution_complete}:${clients.map((client) => client.id).join(',')}` : 'unavailable';
    const names = clients.map((client) => client.name).join(' / ');
    const label = names ? `${names}${entry?.client_attribution_complete ? '' : ' (client attribution incomplete)'}` : 'Client organisation not confirmed';
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      group = { key, label, stops: [] };
      groups.push(group);
    }
    group.stops.push({ stop, index });
  });

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

  const saveTravel = async (stop: PatrolStop, fromStop: PatrolStop) => {
    const draft = travelDrafts[stop.id];
    if (!draft) return;
    const distance = draft.distance.trim() ? Number(draft.distance) : null;
    const start = draft.start.trim() ? Number(draft.start) : null;
    const end = draft.end.trim() ? Number(draft.end) : null;
    if (draft.useOdometer ? start === null || end === null || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start
      : distance === null || !Number.isFinite(distance) || distance < 0) {
      setError('Enter measured kilometres, or two odometer readings that do not decrease.'); return;
    }
    setSaving(true); setError(null); setTravelReceipt(null);
    const key = `${stop.id}:travel`;
    pendingRequest.current[key] ??= crypto.randomUUID();
    try {
      const { data, error: travelError } = await supabase.rpc('record_patrol_travel_distance', {
        p_request_id: pendingRequest.current[key], p_from_stop_id: fromStop.id, p_to_stop_id: stop.id,
        p_distance_km: draft.useOdometer ? null : distance,
        p_odometer_start_km: draft.useOdometer ? start : null, p_odometer_end_km: draft.useOdometer ? end : null,
        p_expected_version: stop.travel_distance_version ?? 0,
      });
      if (travelError || !data) throw travelError ?? new Error('Travel distance was not confirmed.');
      delete pendingRequest.current[key];
      setTravelDrafts((drafts) => { const next = { ...drafts }; delete next[stop.id]; return next; });
      setTravelReceipt(data as { distance_km: number; reference: string });
      await load();
    } catch (failure) {
      setError((failure as { message?: string })?.message ?? 'Travel distance could not be saved. Refresh before retrying.');
    } finally { setSaving(false); }
  };

  if (loading && !bundle) return <section className="patrol-stops" aria-label="Contracted stops"><p className="patrol-stops-subtle"><RefreshCw size={14} className="is-spinning" /> Loading your contracted stops…</p></section>;
  if (!bundle) return error
    ? <section className="patrol-stops" aria-label="Contracted stops">
      <div className="patrol-stops-message is-error" role="alert"><AlertTriangle size={16} />{error}</div>
      <button type="button" className="patrol-stops-refresh" onClick={() => void load()} disabled={loading} aria-label="Refresh contracted stops"><RefreshCw size={15} className={loading ? 'is-spinning' : ''} /></button>
    </section>
    : null;

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
      {travelReceipt && <div className="patrol-stops-message is-success" role="status"><CheckCircle2 size={16} /><span>{travelReceipt.distance_km} km travel recorded · receipt {travelReceipt.reference}</span></div>}
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
        <>
        {journey && !planMatches && <p role="alert">The stop list and patrol plan do not match. Refresh or contact operations before relying on the map or client grouping.</p>}
        {!journey && <p>Client grouping and the planned stop map are unavailable until the patrol plan loads.</p>}
        {planMatches && journey && <OfficerPatrolMap points={mapPoints} totalStops={journey.stops.length} />}
        {groups.map((group, groupIndex) => <section key={`${group.key}:${groupIndex}`} aria-label={group.label}>
          <h4 className="patrol-stops-client">{group.label}</h4>
          <ol className="patrol-stops-list">
          {group.stops.map(({ stop, index }) => {
            const isCurrent = current?.id === stop.id;
            const state = stop.status === 'completed' ? 'done' : stop.status === 'skipped' || stop.status === 'cancelled' ? 'off' : isCurrent ? 'current' : 'later';
            const fromStop = stop.actual_arrived_at ? stops.filter((candidate) => candidate.id !== stop.id && candidate.status === 'completed' && candidate.actual_departed_at
              && new Date(candidate.actual_departed_at).getTime() <= new Date(stop.actual_arrived_at!).getTime())
              .sort((left, right) => new Date(right.actual_departed_at!).getTime() - new Date(left.actual_departed_at!).getTime())[0] : null;
            const travelDraft = travelDrafts[stop.id] ?? { distance: '', start: '', end: '', useOdometer: false };
            const editTravel = (patch: Partial<typeof travelDraft>) => setTravelDrafts((drafts) => ({ ...drafts, [stop.id]: { ...travelDraft, ...patch } }));
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
                  <details className="patrol-stop-detail" onToggle={(event) => {
                    const open = event.currentTarget.open;
                    setOpenDetails((currentDetails) => ({ ...currentDetails, [stop.id]: open }));
                  }}>
                    <summary>Site information and checkpoints</summary>
                    <p>{stop.place.address ?? 'Address not supplied.'}</p>
                    {openDetails[stop.id] && !(isCurrent && (stop.status === 'pending' || stop.status === 'en_route'))
                      && <OfficerPatrolBriefing shiftId={shiftId} stopId={stop.id} />}
                    {renderCheckpoints ? renderCheckpoints(stop.id) : <p>Checkpoint details are unavailable. Retry loading the patrol plan.</p>}
                  </details>
                  {stop.status === 'completed' && stop.officer_notes && <p className="patrol-stop-notes">Your notes: {stop.officer_notes}</p>}
                  {fromStop && (stop.status === 'on_scene' || stop.status === 'completed') && <details className="patrol-stop-notes">
                    <summary>{stop.actual_travel_distance_km == null ? `Record travel from ${fromStop.place.name}` : `${stop.actual_travel_distance_km} km recorded travel`}</summary>
                    <form className="patrol-stop-depart" onSubmit={(event) => { event.preventDefault(); void saveTravel(stop, fromStop); }}>
                      <strong>{fromStop.place.name} to {stop.place.name}</strong>
                      <label><span><input type="checkbox" checked={travelDraft.useOdometer} disabled={saving} onChange={(event) => editTravel({ useOdometer: event.target.checked })} />Use odometer readings</span></label>
                      {travelDraft.useOdometer ? <>
                        <label><span>Odometer at departure (km)</span><input type="number" min="0" step="0.001" required value={travelDraft.start} disabled={saving} onChange={(event) => editTravel({ start: event.target.value })} /></label>
                        <label><span>Odometer at arrival (km)</span><input type="number" min="0" step="0.001" required value={travelDraft.end} disabled={saving} onChange={(event) => editTravel({ end: event.target.value })} /></label>
                      </> : <label><span>Kilometres travelled</span><input type="number" min="0" max="1000000" step="0.001" required value={travelDraft.distance} disabled={saving} onChange={(event) => editTravel({ distance: event.target.value })} /></label>}
                      <button type="submit" className="btn btn-secondary" disabled={saving}><CheckCircle2 size={16} aria-hidden="true" />{saving ? 'Recording...' : 'Record travel'}</button>
                    </form>
                  </details>}
                  {isCurrent && (stop.status === 'pending' || stop.status === 'en_route') && (
                    <>
                      <OfficerPatrolBriefing shiftId={shiftId} stopId={stop.id} />
                      <button type="button" className="btn btn-primary patrol-stop-action" onClick={() => void act(stop, 'arrive')} disabled={saving}><MapPin size={16} aria-hidden="true" /> {saving ? 'Recording…' : `Arrived at ${stop.place.name}`}</button>
                    </>
                  )}
                  {isCurrent && stop.status === 'on_scene' && (
                    <>
                    <OfficerStopChecks stopId={stop.id} checks={stop.checks} onRecorded={() => void load()} onDirtyChange={setChecksDirty} />
                    <form className="patrol-stop-depart" onSubmit={depart}>
                      <label><span>What you found and did here{stop.sla_status === 'breached' ? '' : ' (needed only if you leave early)'}</span><textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="e.g. Gates locked, lights checked, nothing unusual" /></label>
                      {stop.sla_status === 'breached' && <label><span>Why you arrived after the contracted window</span><input value={delayReason} onChange={(event) => setDelayReason(event.target.value)} placeholder="e.g. Held at previous site by an alarm response" required /></label>}
                      {checksOutstanding(stop.checks) && <p className="patrol-stop-hint">Record every check first</p>}
                      <button type="submit" className="btn btn-primary patrol-stop-action" disabled={saving || checksOutstanding(stop.checks)}><Signpost size={16} aria-hidden="true" /> {saving ? 'Recording…' : `Leaving ${stop.place.name}`}</button>
                    </form>
                    </>
                  )}
                </div>
              </li>
            );
          })}
          </ol>
        </section>)}
        </>
      )}
    </section>
  );
}
