import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AlertTriangle, Car, Check, Database, Eye, ExternalLink, History, Loader2, PawPrint, RefreshCw, UserRound, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { CCTVStillComparison, type EnhancementReceipt } from '../components/CCTVStillComparison';
import { supabase } from '../lib/supabase';
import {
  asRecord,
  candidateAction,
  describeConsoleFailure,
  entityTitle,
  formatClock,
  formatDate,
  inferenceReviewLabel,
  isReviewed,
  isWeakInferenceCandidate,
  OBSERVATION_SELECT,
  toObservation,
  vehicleAttributeCandidateFrom,
  weaponHintFrom,
  type ConsoleFailure,
  type ConsoleObservation,
  type EntityKind,
  type ReviewAction,
} from '../lib/cctvConsole';
import './PageStyles.css';
import './CCTVConsolePage.css';
import './CCTVTriagePage.css';

type KindFilter = 'all' | EntityKind;
type CameraLookup = { label: string; place: string; timeZone: string };
type TriageError = ConsoleFailure & { retry: (() => void) | null };

const KIND_ICON: Record<EntityKind, React.ReactNode> = {
  person: <UserRound size={14} aria-hidden="true" />,
  vehicle: <Car size={14} aria-hidden="true" />,
  animal: <PawPrint size={14} aria-hidden="true" />,
};
const KIND_OPTIONS: KindFilter[] = ['all', 'person', 'vehicle', 'animal'];

function placeLabel(row: Record<string, unknown>): string {
  const raw = row.locations;
  const location = Array.isArray(raw) ? raw[0] : raw;
  if (!location || typeof location !== 'object') return 'Place not loaded';
  const rec = location as Record<string, unknown>;
  const name = typeof rec.name === 'string' ? rec.name : null;
  if (!name) return 'Place not loaded';
  return typeof rec.address === 'string' && rec.address ? `${name} · ${rec.address}` : name;
}

const CCTVTriagePage: React.FC = () => {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const organizationId = profile?.organizationId ?? null;
  const requestedObservationId = new URLSearchParams(location.search).get('observation');

  const [observations, setObservations] = useState<ConsoleObservation[]>([]);
  const [cameras, setCameras] = useState<Record<string, CameraLookup>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<TriageError | null>(null);
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [showReviewed, setShowReviewed] = useState(Boolean(requestedObservationId));
  const [selectedId, setSelectedId] = useState<string | null>(requestedObservationId);
  const [previousObservations, setPreviousObservations] = useState<ConsoleObservation[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const [reviewBusy, setReviewBusy] = useState<string | null>(null);
  const [reviewMessage, setReviewMessage] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [newName, setNewName] = useState('');
  const [newPlate, setNewPlate] = useState('');
  const [personDetails, setPersonDetails] = useState('');
  const [personCategory, setPersonCategory] = useState('');
  const [vehicleNotes, setVehicleNotes] = useState('');
  const [correctingVehicleId, setCorrectingVehicleId] = useState<string | null>(null);
  const [correctMake, setCorrectMake] = useState('');
  const [correctModel, setCorrectModel] = useState('');
  const [correctColour, setCorrectColour] = useState('');
  const [correctBodyType, setCorrectBodyType] = useState('');
  const [correctYear, setCorrectYear] = useState('');
  const [originalDerivativeStill, setOriginalDerivativeStill] = useState<string | null>(null);
  const [enhancedStill, setEnhancedStill] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!organizationId) {
      setLoading(false);
      setError({ kind: 'permission', text: 'Organisation access could not be confirmed. The observation queue is unavailable.', retryable: false, retry: null });
      return;
    }
    setLoading(true);
    const [obsRes, importsRes] = await Promise.all([
      supabase.from('cctv_entity_observations').select(OBSERVATION_SELECT).eq('organization_id', organizationId).neq('review_state', 'superseded').order('observed_at').limit(1000),
      supabase.from('cctv_imports').select('id, camera_label, source_timezone, locations(name, address)').eq('organization_id', organizationId).neq('status', 'archived').limit(500),
    ]);
    if (obsRes.error) {
      setError({ ...describeConsoleFailure(obsRes.error.message, 'observation queue', navigator.onLine), retry: () => void load() });
      setLoading(false);
      return;
    }
    setError(null);
    const rows = ((obsRes.data as unknown as Record<string, unknown>[]) ?? []).map(toObservation).filter((row): row is ConsoleObservation => row !== null);
    setObservations(rows);
    if (requestedObservationId && rows.some((row) => row.id === requestedObservationId)) {
      setShowReviewed(true);
      setSelectedId(requestedObservationId);
    }
    const lookup: Record<string, CameraLookup> = {};
    for (const row of (importsRes.data as unknown as Record<string, unknown>[]) ?? []) {
      if (typeof row.id !== 'string') continue;
      lookup[row.id] = {
        label: typeof row.camera_label === 'string' ? row.camera_label : 'Camera',
        place: placeLabel(row),
        timeZone: typeof row.source_timezone === 'string' ? row.source_timezone : 'Pacific/Auckland',
      };
    }
    setCameras(lookup);
    setLoading(false);
  }, [organizationId, requestedObservationId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!organizationId) return;
    const channel = supabase
      .channel(`cctv-triage-${organizationId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cctv_entity_observations', filter: `organization_id=eq.${organizationId}` }, () => void load())
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [organizationId, load]);

  const filtered = useMemo(() => observations
    .filter((observation) => kindFilter === 'all' || observation.kind === kindFilter)
    .filter((observation) => showReviewed || !isReviewed(observation))
    .sort((a, b) => a.observedAtMs - b.observedAtMs), [observations, kindFilter, showReviewed]);

  const pendingCount = useMemo(() => observations.filter((observation) => !isReviewed(observation)).length, [observations]);
  const selected = filtered.find((observation) => observation.id === selectedId) ?? filtered[0] ?? null;
  const selectedCamera = selected?.importId ? cameras[selected.importId] ?? null : null;
  const captureRecognition = selected ? asRecord(selected.attributes.capture_recognition) : {};
  const enhancementReceipt = asRecord(captureRecognition.enhancement) as EnhancementReceipt;
  const recognitionComparison = asRecord(captureRecognition.recognition_comparison);
  const originalStoragePath = typeof captureRecognition.original_storage_path === 'string' ? captureRecognition.original_storage_path : null;
  const originalStorageBucket = typeof captureRecognition.original_storage_bucket === 'string' ? captureRecognition.original_storage_bucket : 'bob-uploads';
  const enhancedStoragePath = typeof captureRecognition.enhanced_storage_path === 'string' ? captureRecognition.enhanced_storage_path : null;
  const enhancedStorageBucket = typeof captureRecognition.enhanced_storage_bucket === 'string' ? captureRecognition.enhanced_storage_bucket : 'bob-uploads';
  const comparisonOriginal = originalDerivativeStill || selected?.thumbnail || null;

  useEffect(() => {
    let active = true;
    setOriginalDerivativeStill(null);
    setEnhancedStill(null);
    void Promise.all([
      originalStoragePath ? supabase.storage.from(originalStorageBucket).createSignedUrl(originalStoragePath, 15 * 60) : Promise.resolve({ data: null }),
      enhancedStoragePath ? supabase.storage.from(enhancedStorageBucket).createSignedUrl(enhancedStoragePath, 15 * 60) : Promise.resolve({ data: null }),
    ]).then(([original, enhanced]) => {
      if (!active) return;
      setOriginalDerivativeStill(original.data?.signedUrl ?? null);
      setEnhancedStill(enhanced.data?.signedUrl ?? null);
    });
    return () => { active = false; };
  }, [selected?.id, originalStorageBucket, originalStoragePath, enhancedStorageBucket, enhancedStoragePath]);

  useEffect(() => {
    let active = true;
    const loadHistory = async () => {
      if (!organizationId || !selected?.portfolioKey) { setPreviousObservations([]); setHistoryError(null); return; }
      setHistoryLoading(true); setHistoryError(null);
      const { data, error: historyLoadError } = await supabase
        .from('cctv_entity_observations')
        .select(OBSERVATION_SELECT)
        .eq('organization_id', organizationId)
        .eq('portfolio_key', selected.portfolioKey)
        .neq('id', selected.id)
        .neq('review_state', 'superseded')
        .order('observed_at', { ascending: false })
        .limit(50);
      if (!active) return;
      if (historyLoadError) setHistoryError(historyLoadError.message);
      else setPreviousObservations(((data as unknown as Record<string, unknown>[]) ?? []).map(toObservation).filter((row): row is ConsoleObservation => row !== null));
      setHistoryLoading(false);
    };
    void loadHistory();
    return () => { active = false; };
  }, [organizationId, selected?.id, selected?.portfolioKey]);

  // Each newly-selected observation gets its own blank reviewer inputs - otherwise a name/note typed
  // for one sighting would silently carry over and get saved against the next one.
  useEffect(() => {
    setNewName(selected?.kind === 'person' ? selected.profileName ?? '' : '');
    setPersonDetails(selected?.kind === 'person' && typeof selected.profileDetails.notes === 'string' ? selected.profileDetails.notes : '');
    setPersonCategory(selected?.kind === 'person' && typeof selected.profileDetails.category === 'string' ? selected.profileDetails.category : '');
    setNewPlate('');
    setVehicleNotes('');
    let cancelled = false;
    if (selected?.kind === 'vehicle' && selected.canonicalVehicleId) {
      void supabase.rpc('get_cctv_vehicle_note', { p_observation_id: selected.id }).then(({ data }) => {
        if (!cancelled) setVehicleNotes(typeof data === 'string' ? data : '');
      });
    }
    setNotes('');
    setReviewMessage(null);
    setCorrectingVehicleId(null);
    setCorrectMake('');
    setCorrectModel('');
    return () => { cancelled = true; };
  }, [selected?.id]);

  const patchObservation = useCallback((updated: ConsoleObservation) => {
    setObservations((current) => current.map((item) => (item.id === updated.id ? updated : item)));
  }, []);

  const runReview = useCallback(async (observation: ConsoleObservation, action: ReviewAction, targetId: string | null = null) => {
    setReviewBusy(`${observation.id}:${action}`);
    setReviewMessage(null);
    const { data, error: reviewError } = await supabase.rpc('review_cctv_entity_observation', {
      p_observation_id: observation.id,
      p_action: action,
      p_target_id: targetId,
      p_display_name: action === 'new_person' ? newName.trim() || null : null,
      p_plate: action === 'new_vehicle' || action === 'accept' ? newPlate.trim() || null : null,
      p_notes: notes.trim() || null,
    });
    setReviewBusy(null);
    if (reviewError) { setReviewMessage(reviewError.message); return; }
    const updated = data && typeof data === 'object' ? toObservation(data as Record<string, unknown>) : null;
    if (updated) patchObservation(updated);
    setReviewMessage(action === 'reject' ? 'Rejected.' : action === 'accept_portfolio' ? 'Applied to the whole portfolio.' : 'Saved.');
    // A portfolio-wide accept touches rows beyond the one the RPC returns.
    if (action === 'accept_portfolio') void load();
  }, [newName, newPlate, notes, patchObservation, load]);

  const runVehicleAttributeReview = useCallback(async (observation: ConsoleObservation, action: 'confirm' | 'correct' | 'reject') => {
    if (action === 'correct' && !correctMake.trim() && !correctModel.trim() && !correctColour.trim() && !correctBodyType.trim() && !correctYear.trim()) {
      setReviewMessage('Enter at least one corrected vehicle attribute.');
      return;
    }
    const year = correctYear.trim() ? Number(correctYear) : null;
    if (year !== null && (!Number.isInteger(year) || year < 1886 || year > new Date().getFullYear() + 2)) {
      setReviewMessage('Enter a valid four-digit vehicle year.');
      return;
    }
    setReviewBusy(`${observation.id}:attrs:${action}`);
    setReviewMessage(null);
    const { data, error: attrError } = await supabase.rpc('confirm_cctv_vehicle_attributes', {
      p_observation_id: observation.id,
      p_action: action,
      p_make: action === 'correct' ? correctMake.trim() || null : null,
      p_model: action === 'correct' ? correctModel.trim() || null : null,
      p_colour: action === 'correct' ? correctColour.trim() || null : null,
      p_body_type: action === 'correct' ? correctBodyType.trim() || null : null,
      p_year: action === 'correct' ? year : null,
      p_notes: notes.trim() || null,
    });
    setReviewBusy(null);
    if (attrError) { setReviewMessage(attrError.message); return; }
    const updated = data && typeof data === 'object' ? toObservation(data as Record<string, unknown>) : null;
    if (updated) patchObservation(updated);
    setCorrectingVehicleId(null);
    setCorrectMake('');
    setCorrectModel('');
    setCorrectColour('');
    setCorrectBodyType('');
    setCorrectYear('');
    setReviewMessage(action === 'reject' ? 'Vehicle attribute candidates dismissed.' : action === 'correct' ? 'Corrected attributes saved to the vehicle record.' : 'Vehicle attributes confirmed and saved.');
  }, [correctBodyType, correctColour, correctMake, correctModel, correctYear, notes, patchObservation]);

  const runWeaponHintReview = useCallback(async (observation: ConsoleObservation, status: 'confirmed' | 'dismissed') => {
    setReviewBusy(`${observation.id}:weapon:${status}`);
    setReviewMessage(null);
    const { data, error: weaponError } = await supabase.rpc('confirm_cctv_weapon_hint', {
      p_observation_id: observation.id,
      p_status: status,
      p_notes: notes.trim() || null,
    });
    setReviewBusy(null);
    if (weaponError) { setReviewMessage(weaponError.message); return; }
    const updated = data && typeof data === 'object' ? toObservation(data as Record<string, unknown>) : null;
    if (updated) patchObservation(updated);
    setReviewMessage(status === 'confirmed' ? 'Weapon flag confirmed.' : 'Weapon flag dismissed as a false positive.');
  }, [notes, patchObservation]);

  const updatePersonProfile = useCallback(async (observation: ConsoleObservation) => {
    if (!newName.trim()) return;
    setReviewBusy(`${observation.id}:profile`);
    setReviewMessage(null);
    const profileDetails: Record<string, string> = {};
    if (personDetails.trim()) profileDetails.notes = personDetails.trim();
    if (personCategory.trim()) profileDetails.category = personCategory.trim();
    const { error: profileError } = await supabase.rpc('update_cctv_person_profile', {
      p_observation_id: observation.id,
      p_display_name: newName.trim(),
      p_profile_details: profileDetails,
      p_notes: notes.trim() || null,
    });
    setReviewBusy(null);
    if (profileError) { setReviewMessage(profileError.message); return; }
    // The RPC updates every sighting of this person, not just the selected row - reload rather than patch one.
    void load();
    setReviewMessage('Person profile updated.');
  }, [newName, notes, personDetails, personCategory, load]);

  const updateVehicleNotes = useCallback(async (observation: ConsoleObservation) => {
    setReviewBusy(`${observation.id}:vehicle-notes`);
    setReviewMessage(null);
    const { error: notesError } = await supabase.rpc('update_cctv_vehicle_notes', {
      p_observation_id: observation.id,
      p_notes: vehicleNotes.trim() || null,
    });
    setReviewBusy(null);
    if (notesError) { setReviewMessage(notesError.message); return; }
    setReviewMessage('Vehicle note saved.');
  }, [vehicleNotes]);

  return (
    <div className="page-container cctv-console cctv-triage">
      <header className="cctv-triage__header">
        <div>
          <h1 className="page-title"><Eye size={20} aria-hidden="true" /> Review observations</h1>
          <p className="page-subtitle">Work through AI-flagged people, vehicles and animals one at a time - confirm identities, confirm or correct AI suggestions, and clear the queue.</p>
        </div>
        <button type="button" className="page-action" onClick={() => void load()} disabled={loading}><RefreshCw size={14} aria-hidden="true" /> Refresh</button>
      </header>

      {error ? (
        <div className="cctv-triage__error" role="alert">
          <span>{error.text}</span>
          {error.retryable && error.retry ? <button type="button" className="page-action" onClick={error.retry}>Retry</button> : null}
        </div>
      ) : null}

      <div className="cctv-triage__filters" role="group" aria-label="Filters">
        {KIND_OPTIONS.map((option) => (
          <button key={option} type="button" className={`cctv-console__chip${kindFilter === option ? ' is-on' : ''}`} onClick={() => setKindFilter(option)} aria-pressed={kindFilter === option}>
            {option === 'all' ? 'All' : <>{KIND_ICON[option]} {option}</>}
          </button>
        ))}
        <label className="cctv-console__toggle"><input type="checkbox" checked={showReviewed} onChange={(event) => setShowReviewed(event.target.checked)} /> show reviewed</label>
        <span className="cctv-triage__count">{pendingCount} pending</span>
      </div>

      <div className="cctv-triage__layout">
        <ul className="cctv-triage__queue" aria-label="Observation queue">
          {loading && filtered.length === 0 ? <li className="cctv-console__muted"><Loader2 size={14} className="spin" aria-hidden="true" /> Loading…</li> : null}
          {!loading && filtered.length === 0 ? <li className="cctv-console__muted">Nothing to review right now.</li> : null}
          {filtered.map((observation) => {
            const camera = observation.importId ? cameras[observation.importId] : null;
            const weapon = weaponHintFrom(observation);
            const tz = camera?.timeZone ?? 'Pacific/Auckland';
            return (
              <li key={observation.id}>
                <button
                  type="button"
                  className={`cctv-triage__row${selected?.id === observation.id ? ' is-selected' : ''}${isReviewed(observation) ? ' is-reviewed' : ''}`}
                  onClick={() => setSelectedId(observation.id)}
                  aria-pressed={selected?.id === observation.id}
                >
                  {observation.thumbnail ? <img className="cctv-triage__thumb" src={observation.thumbnail} alt="" /> : <span className="cctv-triage__thumb is-blank">{KIND_ICON[observation.kind]}</span>}
                  <span className="cctv-triage__row-text">
                    <strong>{entityTitle(observation)}</strong>
                    {weapon?.present && !weapon.reviewed ? <span className="cctv-triage__weapon-badge"><AlertTriangle size={12} aria-hidden="true" /> weapon flagged</span> : null}
                    <small>{camera ? `${camera.label} · ${camera.place}` : 'Camera not loaded'}</small>
                    <small>{formatDate(observation.observedAtMs, tz)} · {formatClock(observation.observedAtMs, tz)}</small>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        <section className="cctv-triage__detail" aria-label="Selected observation">
          {!selected ? (
            <p className="cctv-console__muted">Select an item from the queue to review it.</p>
          ) : (
            <>
              <div className="cctv-triage__detail-head">
                <div>
                  <h2>{entityTitle(selected)}</h2>
                  <p className="cctv-console__muted">
                    {selectedCamera ? `${selectedCamera.label} · ${selectedCamera.place}` : 'Camera not loaded'} · {formatDate(selected.observedAtMs, selectedCamera?.timeZone ?? 'Pacific/Auckland')} · {formatClock(selected.observedAtMs, selectedCamera?.timeZone ?? 'Pacific/Auckland')}
                  </p>
                </div>
                {selected.importId ? (
                  <button type="button" className="page-action" onClick={() => navigate(`/admin/field-ops?area=cctv-console&import=${selected.importId}`)}>
                    <ExternalLink size={14} aria-hidden="true" /> Watch in console
                  </button>
                ) : null}
              </div>

              {comparisonOriginal ? <CCTVStillComparison original={comparisonOriginal} enhanced={enhancedStill} receipt={Object.keys(enhancementReceipt).length ? enhancementReceipt : null} provider={typeof captureRecognition.provider === 'string' ? captureRecognition.provider : null} recognitionComparison={Object.keys(recognitionComparison).length ? recognitionComparison : null} subjectLabel={entityTitle(selected)} /> : null}

              <small className={`cctv-entity__state${isWeakInferenceCandidate(selected) ? ' is-weak' : ''}`}>
                {isReviewed(selected) ? selected.reviewState.replace(/_/g, ' ') : `${inferenceReviewLabel(selected)} · ${selected.candidates.length ? `${selected.candidates.length} possible match${selected.candidates.length === 1 ? '' : 'es'}` : selected.portfolioState === 'candidate' ? 'seen before in this footage' : 'first sighting'}`}
              </small>

              <div className="cctv-triage__record-state" aria-label="Canonical record status">
                <Database size={15} aria-hidden="true" />
                <span><strong>{selected.personRecordId ? 'Person profile linked' : selected.canonicalVehicleId ? 'Vehicle record linked' : 'No canonical record linked yet'}</strong>{selected.personRecordId || selected.canonicalVehicleId ? ' Updates below apply to the shared record and remain visible on later sightings.' : ' Confirm or record this observation below to create or link one.'}</span>
              </div>

              {selected.kind === 'vehicle' ? (
                <>
                  <dl className="cctv-entity__facts">
                    {['colour', 'body_type'].filter((key) => selected.attributes[key]).map((key) => <div key={key}><dt>{key.replace('_', ' ')}</dt><dd>{String(selected.attributes[key])}</dd></div>)}
                    {selected.attributes.make_model_source === 'human_confirmed' && selected.attributes.make ? <div><dt>make</dt><dd>{String(selected.attributes.make)}</dd></div> : null}
                    {selected.attributes.make_model_source === 'human_confirmed' && selected.attributes.model ? <div><dt>model</dt><dd>{String(selected.attributes.model)}</dd></div> : null}
                    {selected.attributes.plate_confidence ? <div><dt>plate read</dt><dd>{Math.round(Number(selected.attributes.plate_confidence) * 100)}%</dd></div> : null}
                  </dl>
                  {(() => {
                    const hint = vehicleAttributeCandidateFrom(selected);
                    if (!hint) return null;
                    const label = [
                      [hint.make, hint.model].filter(Boolean).join(' '),
                      hint.colour,
                      hint.bodyType,
                      hint.year,
                    ].filter(Boolean).join(' · ');
                    return (
                      <div className="cctv-entity__ai-hint-block">
                        <p className="cctv-entity__ai-hint" title="Machine-derived vehicle attributes remain provisional until a human confirms or corrects them.">
                          Vehicle attribute candidate: {label}
                          {hint.confidence !== null ? ` · ${Math.round(hint.confidence * 100)}% confidence` : ''}
                          {hint.source ? ` · ${hint.source}` : ' · source not recorded'}
                        </p>
                        {!hint.reviewed ? (
                          correctingVehicleId === selected.id ? (
                            <div className="cctv-entity__ai-hint-correct">
                              <label className="cctv-entity__field">Make <input value={correctMake} onChange={(event) => setCorrectMake(event.target.value)} placeholder={hint.make ?? 'e.g. Toyota'} /></label>
                              <label className="cctv-entity__field">Model <input value={correctModel} onChange={(event) => setCorrectModel(event.target.value)} placeholder={hint.model ?? 'e.g. Hilux'} /></label>
                              <label className="cctv-entity__field">Colour <input value={correctColour} onChange={(event) => setCorrectColour(event.target.value)} placeholder={hint.colour ?? 'e.g. white'} /></label>
                              <label className="cctv-entity__field">Body type <input value={correctBodyType} onChange={(event) => setCorrectBodyType(event.target.value)} placeholder={hint.bodyType ?? 'e.g. van'} /></label>
                              <label className="cctv-entity__field">Year <input type="number" value={correctYear} onChange={(event) => setCorrectYear(event.target.value)} placeholder={hint.year ? String(hint.year) : 'e.g. 2022'} /></label>
                              <div className="cctv-entity__actions">
                                <button type="button" className="page-action is-primary" disabled={reviewBusy !== null || (!correctMake.trim() && !correctModel.trim() && !correctColour.trim() && !correctBodyType.trim() && !correctYear.trim())} onClick={() => void runVehicleAttributeReview(selected, 'correct')}><Check size={14} aria-hidden="true" /> Save correction</button>
                                <button type="button" className="page-action" disabled={reviewBusy !== null} onClick={() => { setCorrectingVehicleId(null); setCorrectMake(''); setCorrectModel(''); setCorrectColour(''); setCorrectBodyType(''); setCorrectYear(''); }}>Cancel</button>
                              </div>
                            </div>
                          ) : (
                            <div className="cctv-entity__actions">
                              <button type="button" className="page-action is-primary" disabled={reviewBusy !== null} onClick={() => void runVehicleAttributeReview(selected, 'confirm')}><Check size={14} aria-hidden="true" /> Confirm</button>
                              <button type="button" className="page-action" disabled={reviewBusy !== null} onClick={() => setCorrectingVehicleId(selected.id)}>Correct</button>
                              <button type="button" className="page-action is-danger" disabled={reviewBusy !== null} onClick={() => void runVehicleAttributeReview(selected, 'reject')}><X size={14} aria-hidden="true" /> Dismiss</button>
                            </div>
                          )
                        ) : <small className="cctv-console__muted">Reviewed: {hint.reviewStatus?.replace(/_/g, ' ') || 'complete'}.</small>}
                      </div>
                    );
                  })()}
                </>
              ) : null}

              {selected.kind === 'animal' ? (
                <dl className="cctv-entity__facts">
                  <div><dt>species</dt><dd>{selected.species || 'unidentified'}{selected.speciesConfidence !== null ? ` (${Math.round(selected.speciesConfidence * 100)}%)` : ''}</dd></div>
                  <div><dt>pest</dt><dd>{selected.isPest === null ? 'unknown' : selected.isPest ? 'yes' : 'no'}</dd></div>
                  {selected.attributes.species_status ? <div><dt>model</dt><dd>{String(selected.attributes.species_status).replace(/_/g, ' ')}</dd></div> : null}
                </dl>
              ) : null}

              {selected.kind === 'person' ? (() => {
                const weapon = weaponHintFrom(selected);
                if (!weapon?.present) return null;
                return (
                  <div className="cctv-entity__weapon-alert" role="alert">
                    <p><AlertTriangle size={14} aria-hidden="true" /> Possible weapon flagged by AI (unverified){weapon.description ? `: ${weapon.description}` : ''}. Review this sighting now.</p>
                    {!weapon.reviewed ? (
                      <div className="cctv-entity__actions">
                        <button type="button" className="page-action is-primary" disabled={reviewBusy !== null} onClick={() => void runWeaponHintReview(selected, 'confirmed')}><Check size={14} aria-hidden="true" /> Confirm</button>
                        <button type="button" className="page-action" disabled={reviewBusy !== null} onClick={() => void runWeaponHintReview(selected, 'dismissed')}><X size={14} aria-hidden="true" /> False positive</button>
                      </div>
                    ) : <small className="cctv-console__muted">Reviewed.</small>}
                  </div>
                );
              })() : null}

              {selected.kind === 'person' ? (
                <dl className="cctv-entity__facts">
                  <div><dt>profile</dt><dd>{selected.profileName || 'Unknown person'}</dd></div>
                  {['upper_body_colour', 'lower_body_colour'].filter((key) => selected.attributes[key]).map((key) => <div key={key}><dt>{key.replace(/_/g, ' ')}</dt><dd>{String(selected.attributes[key])}</dd></div>)}
                  <div><dt>face</dt><dd>{selected.attributes.face_event_id ? 'captured' : 'not captured'}</dd></div>
                </dl>
              ) : null}

              {selected.candidates.length ? (
                <div className="cctv-entity__candidates">
                  <strong>Same or similar on record</strong>
                  {selected.candidates.slice(0, 5).map((candidate, index) => {
                    const mapped = candidateAction(selected, candidate);
                    return (
                      <div key={`${candidate.match_kind}-${candidate.match_id}-${index}`} className="cctv-entity__candidate">
                        <div className="cctv-entity__candidate-main">
                          {candidate.thumbnail ? <img className="cctv-entity__candidate-thumb" src={candidate.thumbnail} alt="" /> : <span className="cctv-entity__candidate-thumb is-blank" title="No preview stored for this kind of match">{KIND_ICON[selected.kind]}</span>}
                          <span>
                            <strong>{candidate.display_name || candidate.plate_number || (candidate.match_kind === 'observation' ? 'Earlier sighting' : 'Known record')}</strong>
                            <small>{candidate.basis?.replace(/_/g, ' ')} · {Math.round((candidate.score ?? 0) * 100)}%{candidate.last_seen_at ? ` · last seen ${formatDate(new Date(candidate.last_seen_at).getTime(), selectedCamera?.timeZone ?? 'Pacific/Auckland')}` : ''}</small>
                          </span>
                        </div>
                        <div className="cctv-entity__candidate-actions">
                          {candidate.cctv_import_id ? <a className="page-action" href={`/admin/field-ops?area=cctv-console&import=${candidate.cctv_import_id}`} target="_blank" rel="noopener noreferrer" title="Open this earlier sighting's footage in a new tab to compare before confirming"><ExternalLink size={14} aria-hidden="true" /> View footage</a> : null}
                          {mapped ? <button type="button" className="page-action" disabled={reviewBusy !== null || isReviewed(selected)} onClick={() => void runReview(selected, mapped.action, mapped.targetId)}>{mapped.label}</button> : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : null}

              <section className="cctv-triage__history" aria-label="Previous observations">
                <div className="cctv-triage__history-head"><span><History size={15} aria-hidden="true" /><strong>Previous observations</strong></span><em>{previousObservations.length}</em></div>
                {historyLoading ? <p className="cctv-console__muted"><Loader2 size={14} className="spin" aria-hidden="true" /> Loading sighting history…</p> : null}
                {historyError ? <p className="cctv-console__muted">History could not be loaded: {historyError}</p> : null}
                {!historyLoading && !historyError && previousObservations.length === 0 ? <p className="cctv-console__muted">No earlier or later sightings are linked to this record yet.</p> : null}
                {previousObservations.map((observation) => {
                  const camera = observation.importId ? cameras[observation.importId] : null;
                  const timezone = camera?.timeZone ?? 'Pacific/Auckland';
                  return <article key={observation.id} className="cctv-triage__history-row">
                    {observation.thumbnail ? <img src={observation.thumbnail} alt="" /> : <span className="cctv-triage__history-icon">{KIND_ICON[observation.kind]}</span>}
                    <span><strong>{entityTitle(observation)}</strong><small>{camera?.label ?? 'Camera'} · {formatDate(observation.observedAtMs, timezone)} · {formatClock(observation.observedAtMs, timezone)}</small><small>{observation.reviewState.replace(/_/g, ' ')}</small></span>
                    <div><button type="button" className="page-action" onClick={() => { setShowReviewed(true); setKindFilter('all'); setSelectedId(observation.id); }}><Eye size={13} aria-hidden="true" /> Review</button>{observation.importId ? <a className="page-action" href={`/admin/field-ops?area=cctv-console&import=${observation.importId}`} target="_blank" rel="noopener noreferrer"><ExternalLink size={13} aria-hidden="true" /> Footage</a> : null}</div>
                  </article>;
                })}
              </section>

              {!isReviewed(selected) ? (
                <>
                  <label className="cctv-entity__field">Notes <input value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Optional reviewer note" /></label>
                  {selected.kind === 'person' && !selected.personRecordId ? (
                    <label className="cctv-entity__field">New person <input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Display name, e.g. Unknown male, red jacket" /></label>
                  ) : null}
                  {selected.kind === 'vehicle' && !selected.plate ? (
                    <label className="cctv-entity__field">Plate (if you can read it) <input value={newPlate} onChange={(event) => setNewPlate(event.target.value.toUpperCase())} placeholder="e.g. ABC123" /></label>
                  ) : null}
                  <div className="cctv-entity__actions">
                    <button type="button" className="page-action is-primary" disabled={reviewBusy !== null} onClick={() => void runReview(selected, 'accept')}><Check size={14} aria-hidden="true" /> {selected.kind === 'vehicle' && (selected.plate || newPlate.trim()) ? 'Accept · record vehicle' : 'Accept'}</button>
                    {selected.kind === 'person' && !selected.personRecordId ? <button type="button" className="page-action" disabled={reviewBusy !== null || !newName.trim()} onClick={() => void runReview(selected, 'new_person')}><UserRound size={14} aria-hidden="true" /> New person</button> : null}
                    {selected.kind === 'vehicle' && !selected.plate ? <button type="button" className="page-action" disabled={reviewBusy !== null || !newPlate.trim()} onClick={() => void runReview(selected, 'new_vehicle')}><Car size={14} aria-hidden="true" /> Record vehicle</button> : null}
                    <button type="button" className="page-action is-danger" disabled={reviewBusy !== null} onClick={() => void runReview(selected, 'reject')}><X size={14} aria-hidden="true" /> Not a {selected.kind}</button>
                  </div>
                </>
              ) : (
                <div className="cctv-entity__actions">
                  {(selected.personRecordId || selected.canonicalVehicleId) && selected.portfolioKey ? <button type="button" className="page-action" disabled={reviewBusy !== null} onClick={() => void runReview(selected, 'accept_portfolio')}>Apply identity to unreviewed sightings in this portfolio</button> : null}
                  {selected.reviewNotes ? <p className="cctv-console__muted">{selected.reviewNotes}</p> : null}
                </div>
              )}

              {selected.kind === 'person' && selected.personRecordId ? (
                <div className="cctv-entity__profile-editor">
                  <label className="cctv-entity__field">Person name <input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Unknown Person #1" /></label>
                  <label className="cctv-entity__field">Category <select value={personCategory} onChange={(event) => setPersonCategory(event.target.value)}>
                    <option value="">Not set</option>
                    <option value="Visitor">Visitor</option>
                    <option value="Staff">Staff</option>
                    <option value="Contractor">Contractor</option>
                    <option value="Resident or tenant">Resident or tenant</option>
                    <option value="Known to site">Known to site</option>
                    <option value="Person of interest">Person of interest</option>
                  </select></label>
                  <label className="cctv-entity__field">Profile details <textarea value={personDetails} onChange={(event) => setPersonDetails(event.target.value)} placeholder="Optional details confirmed by the reviewer" rows={2} /></label>
                  <button type="button" className="page-action" disabled={reviewBusy !== null || !newName.trim()} onClick={() => void updatePersonProfile(selected)}><UserRound size={14} aria-hidden="true" /> Save person profile</button>
                </div>
              ) : null}
              {selected.kind === 'vehicle' && (selected.plate || selected.canonicalVehicleId) ? (
                <div className="cctv-entity__profile-editor">
                  <label className="cctv-entity__field">Vehicle note <textarea value={vehicleNotes} onChange={(event) => setVehicleNotes(event.target.value)} placeholder="e.g. Regular contractor, seen loitering near the fence line" rows={2} /></label>
                  <button type="button" className="page-action" disabled={reviewBusy !== null} onClick={() => void updateVehicleNotes(selected)}><Car size={14} aria-hidden="true" /> Save vehicle note</button>
                </div>
              ) : null}

              {reviewBusy?.startsWith(selected.id) ? <p className="cctv-console__muted"><Loader2 size={14} className="spin" aria-hidden="true" /> Saving…</p> : null}
              {reviewMessage ? <p className="cctv-console__muted" role="status">{reviewMessage}</p> : null}
            </>
          )}
        </section>
      </div>
    </div>
  );
};

export default CCTVTriagePage;
