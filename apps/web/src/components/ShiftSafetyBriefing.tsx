/**
 * ShiftSafetyBriefing — the short, place-specific hazard highlights an officer reads before a shift
 * or a patrol stop, each linked to the exact section of the source H&S document.
 * Reads get_shift_safety_briefing; writes acknowledge_safety_briefing and report_place_hazard.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { AlertTriangle, CheckCircle2, FileText, Plus, RefreshCw, ShieldAlert, X } from 'lucide-react';
import {
  acknowledgeSafetyBriefing, briefingNeedsAcknowledgement, describeHazardSource, fetchShiftSafetyBriefing,
  HAZARD_CLASSES, hazardClassLabel, openHazardSource, reportPlaceHazard, RISK_LABELS,
  type BriefingPlace, type RiskLevel, type SafetyBriefing,
} from '../lib/safetyBriefing';
import './ShiftSafetyBriefing.css';
import { DynamicRiskAssessment } from './DynamicRiskAssessment';

const RISK_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function currentCoords(): Promise<{ lat: number | null; lng: number | null }> {
  if (!('geolocation' in navigator)) return Promise.resolve({ lat: null, lng: null });
  return new Promise((resolve) => navigator.geolocation.getCurrentPosition(
    ({ coords }) => resolve({ lat: coords.latitude, lng: coords.longitude }),
    () => resolve({ lat: null, lng: null }),
    { enableHighAccuracy: true, maximumAge: 30_000, timeout: 8_000 },
  ));
}

export function SafetyBriefingList({ briefing }: { briefing: SafetyBriefing }) {
  const [sourceMessage, setSourceMessage] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const hazards = [...briefing.hazards].sort((a, b) => (RISK_ORDER[a.risk_level] ?? 9) - (RISK_ORDER[b.risk_level] ?? 9));

  const openSource = async (hazardId: string) => {
    setOpening(hazardId); setSourceMessage(null);
    const result = await openHazardSource(hazardId);
    if (!result.opened) setSourceMessage(result.message ?? 'The source document could not be opened.');
    setOpening(null);
  };

  if (briefing.item_count === 0) {
    return <p className="safety-briefing-empty"><CheckCircle2 size={15} aria-hidden="true" /> No recorded hazards or warnings for {briefing.places.length ? briefing.places.map((place) => place.name).join(', ') : 'this shift'}. Stay alert and report anything new.</p>;
  }

  return (
    <div className="safety-briefing-list">
      {briefing.warnings.length > 0 && (
        <section aria-label="Safety warnings for these places">
          {briefing.warnings.map((warning) => (
            <article key={warning.id} className={`safety-briefing-item is-${warning.alert_level}`}>
              <header>
                <span className={`safety-risk-chip is-${warning.alert_level}`}>{RISK_LABELS[warning.alert_level] ?? warning.alert_level}</span>
                <strong>{hazardClassLabel(warning.hazard_class)}</strong>
              </header>
              <p>Warning raised by {warning.organization_name}{warning.reason ? ` — ${warning.reason}` : ''}.</p>
              {warning.contact_phone && <small>Questions: {warning.contact_phone}</small>}
            </article>
          ))}
        </section>
      )}
      {hazards.length > 0 && (
        <section aria-label="Site hazards">
          {hazards.map((hazard) => (
            <article key={hazard.id} className={`safety-briefing-item is-${hazard.risk_level}`}>
              <header>
                <span className={`safety-risk-chip is-${hazard.risk_level}`}>{RISK_LABELS[hazard.risk_level]}</span>
                <strong>{hazard.title}</strong>
                {hazard.status === 'reported' && <span className="safety-unreviewed">Reported — not yet reviewed</span>}
              </header>
              <small>{hazardClassLabel(hazard.hazard_class)} · {hazard.place_name}</small>
              {hazard.controls.length > 0 && (
                <ul aria-label="What to do">{hazard.controls.map((control) => <li key={control}>{control}</li>)}</ul>
              )}
              {hazard.details && <p>{hazard.details}</p>}
              <footer>
                <span>{describeHazardSource(hazard)}</span>
                {hazard.has_source_document && (
                  <button type="button" onClick={() => void openSource(hazard.id)} disabled={opening === hazard.id}>
                    <FileText size={14} aria-hidden="true" /> {opening === hazard.id ? 'Opening…' : `Open source${hazard.source_locator ? ` — ${hazard.source_locator}` : ''}`}
                  </button>
                )}
              </footer>
            </article>
          ))}
        </section>
      )}
      {sourceMessage && <p className="safety-briefing-error" role="alert"><AlertTriangle size={14} aria-hidden="true" /> {sourceMessage}</p>}
    </div>
  );
}

interface DialogProps {
  briefing: SafetyBriefing;
  title?: string;
  acknowledgeLabel: string;
  /** Called after the server records the acknowledgement. */
  onAcknowledged: () => void | Promise<void>;
  onClose: () => void;
  /** Loads the briefing again when it changed while it was being read. */
  onReload: () => Promise<SafetyBriefing | null>;
}

export function SafetyBriefingDialog({ briefing, title, acknowledgeLabel, onAcknowledged, onClose, onReload }: DialogProps) {
  const [current, setCurrent] = useState(briefing);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [needsReload, setNeedsReload] = useState(false);
  const requestId = useRef(crypto.randomUUID());

  useEffect(() => { setCurrent(briefing); requestId.current = crypto.randomUUID(); }, [briefing.briefing_hash]);

  const acknowledge = async () => {
    setSaving(true); setMessage(null);
    try {
      if (!needsReload) {
        const result = await acknowledgeSafetyBriefing(current, requestId.current, await currentCoords());
        if (result.ok) {
          await onAcknowledged();
          return;
        }
        if (!result.changed) { setMessage(result.message); return; }
        setNeedsReload(true);
      }
      const next = await onReload();
      if (!next) throw new Error('The updated safety briefing could not be loaded. Retry before confirming.');
      setCurrent(next);
      setNeedsReload(false);
      requestId.current = crypto.randomUUID();
      setMessage('The safety briefing was updated while you were reading. Check the changes, then confirm again.');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'The safety briefing could not be confirmed. Retry before starting work.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="safety-dialog-backdrop" role="presentation">
      <section className="safety-dialog" role="dialog" aria-modal="true" aria-labelledby="safety-briefing-title">
        <header>
          <div>
            <span className="safety-briefing-kicker"><ShieldAlert size={14} aria-hidden="true" /> Safety briefing</span>
            <h2 id="safety-briefing-title">{title ?? `Risks at ${current.places.map((place) => place.name).join(', ') || 'this shift'}`}</h2>
          </div>
          <button type="button" onClick={onClose} disabled={saving} aria-label="Close safety briefing"><X size={18} /></button>
        </header>
        {current.changed_since_acknowledgement && <p className="safety-briefing-changed">This briefing changed since you last confirmed it.</p>}
        <SafetyBriefingList briefing={current} />
        {message && <p className="safety-briefing-error" role="alert"><AlertTriangle size={14} aria-hidden="true" /> {message}</p>}
        <div className="safety-dialog-actions">
          {briefingNeedsAcknowledgement(current) && <button type="button" onClick={onClose} disabled={saving}>Not now</button>}
          {briefingNeedsAcknowledgement(current)
            ? <button type="button" onClick={() => void acknowledge()} disabled={saving}><CheckCircle2 size={15} aria-hidden="true" /> {saving ? 'Recording…' : needsReload ? 'Retry loading briefing' : acknowledgeLabel}</button>
            : <button type="button" onClick={onClose}>Close</button>}
        </div>
      </section>
    </div>
  );
}

export function ReportHazardForm({ shiftId, places, onReported, onCancel }: { shiftId: string; places: BriefingPlace[]; onReported: () => void; onCancel: () => void }) {
  const [placeKey, setPlaceKey] = useState(places[0] ? `${places[0].kind}:${places[0].id}` : '');
  const [title, setTitle] = useState('');
  const [hazardClass, setHazardClass] = useState('other');
  const [riskLevel, setRiskLevel] = useState<RiskLevel>('medium');
  const [details, setDetails] = useState('');
  const [controls, setControls] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(crypto.randomUUID());

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const [kind, id] = placeKey.split(':');
    if (!id || !title.trim()) { setError('Choose the place and describe the hazard.'); return; }
    setSaving(true); setError(null);
    try {
      await reportPlaceHazard({ shiftId, placeKind: kind as 'site' | 'zone', placeId: id, title, hazardClass, riskLevel, details, controls: controls.split('\n') }, requestId.current);
      onReported();
    } catch (reportError) {
      setError(reportError instanceof Error ? reportError.message : 'The hazard report was not saved.');
    }
    setSaving(false);
  };

  if (places.length === 0) return <p className="safety-briefing-empty">This shift has no site or zone yet, so a hazard cannot be placed. Tell your supervisor directly.</p>;

  return (
    <form className="safety-report-form" onSubmit={(event) => void submit(event)}>
      <label><span>Where</span>
        <select value={placeKey} onChange={(event) => setPlaceKey(event.target.value)}>
          {places.map((place) => <option key={`${place.kind}:${place.id}`} value={`${place.kind}:${place.id}`}>{place.name}</option>)}
        </select>
      </label>
      <label><span>What is the hazard</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Broken glass by the rear loading door" minLength={3} maxLength={160} required /></label>
      <div className="safety-report-row">
        <label><span>Type</span>
          <select value={hazardClass} onChange={(event) => setHazardClass(event.target.value)}>
            {HAZARD_CLASSES.map((value) => <option key={value} value={value}>{hazardClassLabel(value)}</option>)}
          </select>
        </label>
        <label><span>Risk</span>
          <select value={riskLevel} onChange={(event) => setRiskLevel(event.target.value as RiskLevel)}>
            {(['critical', 'high', 'medium', 'low'] as RiskLevel[]).map((value) => <option key={value} value={value}>{RISK_LABELS[value]}</option>)}
          </select>
        </label>
      </div>
      <label><span>Details (optional)</span><textarea rows={2} value={details} onChange={(event) => setDetails(event.target.value)} /></label>
      <label><span>What others should do — one per line (optional)</span><textarea rows={2} value={controls} onChange={(event) => setControls(event.target.value)} placeholder="Wear gloves&#10;Use the front entrance" /></label>
      <p className="safety-report-note">Other officers see this straight away as “reported — not yet reviewed” until a supervisor confirms it.</p>
      {error && <p className="safety-briefing-error" role="alert"><AlertTriangle size={14} aria-hidden="true" /> {error}</p>}
      <div className="safety-dialog-actions">
        <button type="button" onClick={onCancel} disabled={saving}>Cancel</button>
        <button type="submit" disabled={saving}><Plus size={15} aria-hidden="true" /> {saving ? 'Sending…' : 'Report hazard'}</button>
      </div>
    </form>
  );
}

const BANNER_REFRESH_MS = 120_000;

/** Mid-shift banner: re-asks for acknowledgement when the briefing changes and lets the officer report a hazard. */
export function OfficerSafetyBriefingBanner({ shift }: { shift: { id: string; status: string } | null }) {
  const [briefing, setBriefing] = useState<SafetyBriefing | null>(null);
  const [dialog, setDialog] = useState<'briefing' | 'report' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shiftId = shift?.status === 'in_progress' ? shift.id : null;
  const activeShiftId = useRef(shiftId);
  activeShiftId.current = shiftId;

  const load = useCallback(async () => {
    if (!shiftId) { setBriefing(null); return null; }
    try {
      const next = await fetchShiftSafetyBriefing(shiftId);
      if (activeShiftId.current !== shiftId) return null;
      setBriefing(next);
      setError(null);
      return next;
    } catch (cause) {
      if (activeShiftId.current !== shiftId) return null;
      setError(cause instanceof Error ? cause.message : 'The safety briefing could not be loaded.');
      return null;
    }
  }, [shiftId]);

  useEffect(() => {
    setBriefing(null); setDialog(null); setNotice(null); setError(null);
    void load();
    if (!shiftId) return undefined;
    const timer = window.setInterval(() => { void load(); }, BANNER_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load, shiftId]);

  if (!shiftId) return null;
  if (!briefing) return <div className="safety-briefing-banner" role={error ? 'alert' : 'status'}>
    <ShieldAlert size={17} aria-hidden="true" />
    <span>{error ? `Safety briefing unavailable: ${error} Check site risks with your supervisor before working.` : 'Loading safety briefing...'}</span>
    {error && <button type="button" onClick={() => void load()}>Retry safety briefing</button>}
  </div>;
  if (!briefing.is_assigned_officer) return null;
  const needsAck = briefingNeedsAcknowledgement(briefing);

  return (
    <>
      <div className={`safety-briefing-banner ${needsAck ? 'is-required' : ''}`} role={needsAck ? 'alert' : 'status'}>
        <ShieldAlert size={17} aria-hidden="true" />
        <div>
          <strong>{needsAck ? (briefing.changed_since_acknowledgement ? 'Safety briefing updated — read and confirm' : 'Read and confirm the safety briefing') : `Safety briefing: ${briefing.item_count} item${briefing.item_count === 1 ? '' : 's'}`}</strong>
          {notice && <small>{notice}</small>}
          {error && <small role="alert">Safety updates could not be checked: {error}</small>}
        </div>
        <button type="button" onClick={() => setDialog('briefing')}>{needsAck ? 'Read now' : 'View'}</button>
        <button type="button" onClick={() => { setNotice(null); setDialog('report'); }}><Plus size={14} aria-hidden="true" /> Report a hazard</button>
        <button type="button" onClick={() => void load()} aria-label="Refresh safety briefing"><RefreshCw size={14} /></button>
      </div>
      <DynamicRiskAssessment shiftId={shiftId} places={briefing.places} />
      {dialog === 'briefing' && (
        <SafetyBriefingDialog
          briefing={briefing}
          acknowledgeLabel="I've read and understood these risks"
          onAcknowledged={async () => { setDialog(null); setNotice('Briefing confirmed.'); await load(); }}
          onClose={() => setDialog(null)}
          onReload={load}
        />
      )}
      {dialog === 'report' && (
        <div className="safety-dialog-backdrop" role="presentation">
          <section className="safety-dialog" role="dialog" aria-modal="true" aria-labelledby="report-hazard-title">
            <header>
              <div><span className="safety-briefing-kicker"><ShieldAlert size={14} aria-hidden="true" /> New hazard</span><h2 id="report-hazard-title">Report a hazard</h2></div>
              <button type="button" onClick={() => setDialog(null)} aria-label="Close hazard report"><X size={18} /></button>
            </header>
            <ReportHazardForm shiftId={shiftId} places={briefing.places} onCancel={() => setDialog(null)} onReported={() => { setDialog(null); setNotice('Hazard reported. Your supervisor has been asked to review it.'); void load(); }} />
          </section>
        </div>
      )}
    </>
  );
}
