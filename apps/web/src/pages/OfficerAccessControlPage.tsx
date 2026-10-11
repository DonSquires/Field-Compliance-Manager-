import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, CheckCircle2, MapPin, ShieldCheck, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import { imageFileToBase64 } from '../lib/officerScan';
import { supabase } from '../lib/supabase';
import './PageStyles.css';
import './OfficerAccessControlPage.css';

type EventKind = 'entry_request' | 'exit' | 'credential_check' | 'visitor_arrival' | 'door_security_check';
type SubjectKind = 'person' | 'vehicle' | 'mixed' | 'unknown';
type OfficerDecision = 'admitted' | 'refused' | 'escorted' | 'departed' | 'record_only';
type DecisionBasis =
  | 'credential_present'
  | 'known_person'
  | 'visitor_authorization'
  | 'supervisor_authorization'
  | 'safety_refusal'
  | 'policy_refusal'
  | 'no_decision'
  | 'other';

interface RecognitionSummary {
  status?: string;
  classification?: string | null;
  confidence?: number | null;
  details?: {
    subject_kind?: string | null;
    person_present?: boolean | null;
    face_visible?: boolean | null;
    credential_visible?: boolean | null;
    vehicle_present?: boolean | null;
  };
  reasoning?: string | null;
  failure_reason?: string | null;
  probes?: RecognitionProbe[];
}

interface RecognitionCandidate {
  candidate_id: string;
  entity_kind: 'person' | 'vehicle';
  match_kind: string;
  display_name: string;
  score: number;
  basis: string;
  person_record_id: string | null;
  canonical_vehicle_id: string | null;
  plate_number: string | null;
  reference_thumbnail: string | null;
  last_seen_at: string | null;
}

interface RecognitionProbe {
  probe_id: string;
  probe_kind: 'face' | 'person' | 'vehicle' | 'plate';
  source_variant: 'source' | 'enhanced';
  detector_confidence: number | null;
  plate_number: string | null;
  plate_confidence: number | null;
  attributes: Record<string, unknown>;
  candidates: RecognitionCandidate[];
}

interface AccessEvent {
  id: string;
  site_id: string | null;
  zone_id: string | null;
  observed_at: string;
  event_kind: EventKind;
  subject_kind: SubjectKind;
  officer_decision: OfficerDecision;
  decision_basis: DecisionBasis;
  claimed_identity: string | null;
  credential_reference: string | null;
  notes: string | null;
  evidence_state: string;
  recognition_summary: RecognitionSummary;
  recognition_review_state: string;
  geofence_context: { resolution_status?: string; on_site?: boolean };
}

interface SubmissionReceipt {
  eventId: string;
  receivedAt: string;
  officerDecision: OfficerDecision;
  evidenceState: string;
  recognitionReviewState: string;
  geofenceStatus: string;
  recognition: RecognitionSummary;
  probeImageUrl: string | null;
}

const EMPTY_FORM = {
  eventKind: 'entry_request' as EventKind,
  subjectKind: 'person' as SubjectKind,
  officerDecision: 'record_only' as OfficerDecision,
  decisionBasis: 'no_decision' as DecisionBasis,
  claimedIdentity: '',
  credentialReference: '',
  notes: '',
};

function label(value: string) {
  return value.replaceAll('_', ' ');
}

function captureCoordinates(): Promise<{ lat: number; lng: number }> {
  if (!navigator.geolocation) return Promise.reject(new Error('This device does not provide location services.'));
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }),
      (error) => reject(new Error(error.message || 'Location permission was not granted.')),
      { enableHighAccuracy: true, maximumAge: 30_000, timeout: 15_000 },
    );
  });
}

function RecognitionComparison({
  recognition,
  probeImageUrl,
}: {
  recognition: RecognitionSummary;
  probeImageUrl: string | null;
}) {
  const probes = recognition.probes ?? [];
  return (
    <section className="access-recognition-comparison" aria-label="Possible recognition matches">
      <header>
        <div>
          <span>Discovery result</span>
          <h3>Possible people and vehicles</h3>
        </div>
        {typeof recognition.confidence === 'number' && (
          <strong>{Math.round(recognition.confidence * 100)}% strongest raw signal</strong>
        )}
      </header>
      <p>{recognition.reasoning || 'Compare the probe with each reference before deciding what to record.'}</p>
      <div className="access-recognition-layout">
        <div className="access-recognition-probe">
          <span>Input image</span>
          {probeImageUrl ? <img src={probeImageUrl} alt="Recognition input used for candidate matching" /> : null}
        </div>
        <div className="access-recognition-results">
          {probes.length === 0 ? (
            <p>No usable face, person, vehicle, or plate probe was found in this image.</p>
          ) : probes.map((probe) => (
            <article key={probe.probe_id}>
              <header>
                <strong>{label(probe.probe_kind)} probe</strong>
                <span>
                  {probe.plate_number ? `${probe.plate_number} · ` : ''}
                  {probe.source_variant === 'enhanced' ? 'deterministically enhanced crop' : 'original source'}
                </span>
              </header>
              {probe.candidates.length === 0 ? (
                <p>No stored record exceeded the configured similarity threshold.</p>
              ) : (
                <div className="access-recognition-candidates">
                  {probe.candidates.map((candidate) => (
                    <div key={`${probe.probe_id}-${candidate.candidate_id}`} className="access-recognition-candidate">
                      {candidate.reference_thumbnail ? (
                        <img src={candidate.reference_thumbnail} alt={`${candidate.display_name} comparison reference`} />
                      ) : (
                        <div className="access-recognition-placeholder" aria-hidden="true">
                          {candidate.entity_kind === 'vehicle' ? 'VEHICLE' : 'PERSON'}
                        </div>
                      )}
                      <div>
                        <strong>{candidate.display_name}</strong>
                        <span>{Math.round(candidate.score * 100)}% similarity · {label(candidate.basis)}</span>
                        {candidate.last_seen_at ? <small>Last seen {new Date(candidate.last_seen_at).toLocaleString()}</small> : null}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>
      </div>
      <em>These are discovery candidates, not confirmed identity or permission to enter.</em>
    </section>
  );
}

const OfficerAccessControlPage: React.FC = () => {
  const { profile } = useAuth();
  const {
    selectedSite,
    selectedZone,
    selectedAgreementSites,
    selectedAgreementZones,
    selectSite,
    selectZone,
    loading: placeLoading,
  } = useServiceRelationships();
  const accessZones = selectedAgreementZones.filter((zone) => zone.zone_type === 'access_control');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const requestId = useRef(crypto.randomUUID());
  const [events, setEvents] = useState<AccessEvent[]>([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [preparingImage, setPreparingImage] = useState(false);
  const [recognizing, setRecognizing] = useState(false);
  const [recognitionPreview, setRecognitionPreview] = useState<RecognitionSummary | null>(null);
  const [recognitionError, setRecognitionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<SubmissionReceipt | null>(null);

  const selectedPlaceId = selectedZone?.id ?? selectedSite?.id ?? null;
  const selectedPlaceName = selectedZone?.name ?? selectedSite?.name ?? null;

  const loadEvents = useCallback(async () => {
    if (!profile?.id) {
      setEvents([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { data, error: loadError } = await supabase
        .from('access_control_events')
        .select(
          'id,site_id,zone_id,observed_at,event_kind,subject_kind,officer_decision,decision_basis,claimed_identity,credential_reference,notes,evidence_state,recognition_summary,recognition_review_state,geofence_context',
        )
        .eq('officer_user_id', profile.id)
        .order('observed_at', { ascending: false })
        .limit(25);
      if (loadError) throw loadError;
      setEvents((data as AccessEvent[]) ?? []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Access-control events could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [profile?.id]);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  useEffect(() => () => {
    if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
  }, [imagePreviewUrl]);

  const recognizeEvidence = async (base64: string) => {
    setRecognizing(true);
    setRecognitionPreview(null);
    setRecognitionError(null);
    try {
      const { data, error: recognitionInvokeError } = await supabase.functions.invoke<{
        success?: boolean;
        recognition?: RecognitionSummary;
        error?: string;
      }>('recognize-access-subject', {
        body: { image_base64: base64 },
      });
      if (recognitionInvokeError || data?.error || !data?.recognition) {
        throw new Error(recognitionInvokeError?.message || data?.error || 'Recognition returned no candidate receipt.');
      }
      setRecognitionPreview(data.recognition);
    } catch (recognitionFailure) {
      setRecognitionError(
        recognitionFailure instanceof Error
          ? recognitionFailure.message
          : 'Possible matches could not be generated.',
      );
    } finally {
      setRecognizing(false);
    }
  };

  const captureEvidence = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setPreparingImage(true);
    setError(null);
    try {
      if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
      setImagePreviewUrl(URL.createObjectURL(file));
      const base64 = await imageFileToBase64(file);
      setImageBase64(base64);
      await recognizeEvidence(base64);
    } catch (captureError) {
      setImagePreviewUrl(null);
      setImageBase64(null);
      setRecognitionPreview(null);
      setRecognitionError(null);
      setError(captureError instanceof Error ? captureError.message : 'Evidence photo could not be prepared.');
    } finally {
      setPreparingImage(false);
    }
  };

  const clearEvidence = () => {
    if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    setImagePreviewUrl(null);
    setImageBase64(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!profile?.id || !selectedPlaceId) return;
    setSubmitting(true);
    setError(null);
    setReceipt(null);
    try {
      const coordinates = await captureCoordinates();
      const { data, error: submitError } = await supabase.functions.invoke<{
        success?: boolean;
        event_id?: string;
        received_at?: string;
        evidence_state?: string;
        recognition_review_state?: string;
        geofence_status?: string;
        officer_decision?: OfficerDecision;
        recognition?: RecognitionSummary;
        probe_image_url?: string | null;
        error?: string;
      }>('submit-access-control-event', {
        body: {
          client_request_id: requestId.current,
          observed_at: new Date().toISOString(),
          site_id: selectedSite?.id ?? null,
          zone_id: selectedZone?.id ?? null,
          event_kind: form.eventKind,
          subject_kind: form.subjectKind,
          officer_decision: form.officerDecision,
          decision_basis: form.decisionBasis,
          claimed_identity: form.claimedIdentity.trim() || null,
          credential_reference: form.credentialReference.trim() || null,
          notes: form.notes.trim() || null,
          gps_lat: coordinates.lat,
          gps_lng: coordinates.lng,
          image_base64: imageBase64,
        },
      });
      if (submitError || data?.error || !data?.event_id) {
        throw new Error(submitError?.message || data?.error || 'Access-control event was not confirmed.');
      }

      setReceipt({
        eventId: data.event_id,
        receivedAt: data.received_at ?? new Date().toISOString(),
        officerDecision: data.officer_decision ?? form.officerDecision,
        evidenceState: data.evidence_state ?? 'not_provided',
        recognitionReviewState: data.recognition_review_state ?? 'not_requested',
        geofenceStatus: data.geofence_status ?? 'not_evaluated',
        recognition: data.recognition ?? { status: 'not_requested' },
        probeImageUrl: data.probe_image_url ?? null,
      });
      requestId.current = crypto.randomUUID();
      setForm(EMPTY_FORM);
      clearEvidence();
      await loadEvents();
    } catch (submitFailure) {
      setError(submitFailure instanceof Error ? submitFailure.message : 'Access-control event could not be submitted.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading || placeLoading) {
    return <div className="page-container"><div className="loading-state"><div className="spinner" /><p>Loading access-control work...</p></div></div>;
  }

  return (
    <div className="page-container access-control-officer">
      <header className="page-header">
        <div>
          <h1>Access control</h1>
          <p className="subtitle">Discover possible matches, compare the evidence, then record the officer action.</p>
        </div>
      </header>

      {error && <div className="alert alert-error" role="alert">{error}</div>}

      <section className="access-authority-banner" aria-label="Access-control authority">
        <ShieldCheck size={24} aria-hidden="true" />
        <div>
          <strong>Recognition discovers candidates; you confirm the record and decide access.</strong>
          <span>Face, person, vehicle, and plate matching may suggest likely records. Similarity does not prove identity, credential validity, or entitlement.</span>
        </div>
      </section>

      <section className="reports-section">
        <h2>Place</h2>
        {selectedAgreementSites.length === 0 && accessZones.length === 0 ? (
          <div className="empty-state">
            <MapPin size={28} aria-hidden="true" />
            <h3>No assigned access-control place</h3>
            <p>An active service agreement must assign a site or access-control zone before an event can be recorded.</p>
          </div>
        ) : (
          <div className="access-place-options" role="group" aria-label="Access-control place">
            {selectedAgreementSites.map((site) => (
              <button
                type="button"
                key={site.id}
                className={selectedSite?.id === site.id ? 'is-selected' : ''}
                onClick={() => selectSite(site.id)}
              >
                <strong>{site.name}</strong>
                <span>{site.address || 'Site address not recorded'}</span>
              </button>
            ))}
            {accessZones.map((zone) => (
              <button
                type="button"
                key={zone.id}
                className={selectedZone?.id === zone.id ? 'is-selected' : ''}
                onClick={() => selectZone(zone.id)}
              >
                <strong>{zone.name}</strong>
                <span>Access-control zone</span>
              </button>
            ))}
          </div>
        )}
      </section>

      <form className="access-event-form" onSubmit={submit}>
        <header>
          <span>New field record</span>
          <h2>{selectedPlaceName ? `Event at ${selectedPlaceName}` : 'Select a place first'}</h2>
        </header>

        <div className="access-form-grid">
          <label><span>Event</span><select value={form.eventKind} onChange={(event) => setForm({ ...form, eventKind: event.target.value as EventKind })}>
            {(['entry_request', 'exit', 'credential_check', 'visitor_arrival', 'door_security_check'] as EventKind[]).map((value) => <option key={value} value={value}>{label(value)}</option>)}
          </select></label>
          <label><span>Subject</span><select value={form.subjectKind} onChange={(event) => setForm({ ...form, subjectKind: event.target.value as SubjectKind })}>
            {(['person', 'vehicle', 'mixed', 'unknown'] as SubjectKind[]).map((value) => <option key={value} value={value}>{label(value)}</option>)}
          </select></label>
          <label><span>Officer action</span><select value={form.officerDecision} onChange={(event) => setForm({ ...form, officerDecision: event.target.value as OfficerDecision })}>
            {(['admitted', 'refused', 'escorted', 'departed', 'record_only'] as OfficerDecision[]).map((value) => <option key={value} value={value}>{label(value)}</option>)}
          </select></label>
          <label><span>Decision basis</span><select value={form.decisionBasis} onChange={(event) => setForm({ ...form, decisionBasis: event.target.value as DecisionBasis })}>
            {(['credential_present', 'known_person', 'visitor_authorization', 'supervisor_authorization', 'safety_refusal', 'policy_refusal', 'no_decision', 'other'] as DecisionBasis[]).map((value) => <option key={value} value={value}>{label(value)}</option>)}
          </select></label>
        </div>

        <label><span>Claimed identity (optional, not verified)</span><input value={form.claimedIdentity} maxLength={200} onChange={(event) => setForm({ ...form, claimedIdentity: event.target.value })} placeholder="Name stated by the person" /></label>
        <label><span>Credential reference (optional)</span><input value={form.credentialReference} maxLength={160} onChange={(event) => setForm({ ...form, credentialReference: event.target.value })} placeholder="Badge, permit, pass, or visitor reference" /></label>
        <label><span>Officer notes</span><textarea value={form.notes} maxLength={4000} onChange={(event) => setForm({ ...form, notes: event.target.value })} placeholder="What was presented, checked, said, and done?" /></label>

        <section className="access-evidence-capture">
          <div>
            <h3>Optional evidence photo</h3>
            <p>Capture only where site policy and lawful purpose permit. The original and watermarked derivative are preserved separately.</p>
          </div>
          <input ref={fileInputRef} type="file" accept="image/*" capture="environment" onChange={captureEvidence} hidden />
          {imagePreviewUrl ? (
            <div className="access-photo-preview">
              <img src={imagePreviewUrl} alt="Access-control evidence ready to submit" />
              <button type="button" onClick={clearEvidence} aria-label="Remove access-control evidence"><X size={18} /> Remove</button>
            </div>
          ) : (
            <button type="button" className="btn-secondary" onClick={() => fileInputRef.current?.click()} disabled={preparingImage}>
              <Camera size={18} /> {preparingImage ? 'Preparing photo...' : 'Capture evidence'}
            </button>
          )}
          {recognizing ? <div className="loading-state"><div className="spinner" /><p>Finding possible matches...</p></div> : null}
          {recognitionError ? (
            <div className="alert alert-error" role="alert">
              Recognition could not complete: {recognitionError}
              {imageBase64 ? <button type="button" onClick={() => void recognizeEvidence(imageBase64)}>Retry recognition</button> : null}
            </div>
          ) : null}
          {recognitionPreview?.status === 'available' ? (
            <RecognitionComparison recognition={recognitionPreview} probeImageUrl={imagePreviewUrl} />
          ) : null}
        </section>

        <div className="access-submit-note">
          <MapPin size={18} aria-hidden="true" />
          <span>Current GPS is captured on submit. Unresolved or mismatched place context is shown explicitly and never converted into a verified arrival.</span>
        </div>
        <button type="submit" className="btn-primary" disabled={!selectedPlaceId || submitting || preparingImage || recognizing}>
          {submitting ? 'Recording event...' : 'Record access event'}
        </button>
      </form>

      {receipt && (
        <section className="access-receipt" aria-live="polite">
          <header><CheckCircle2 size={24} aria-hidden="true" /><div><span>Event received</span><h2>Receipt {receipt.eventId.slice(0, 8)}</h2></div></header>
          <dl>
            <div><dt>Officer action</dt><dd>{label(receipt.officerDecision)}</dd></div>
            <div><dt>Place evidence</dt><dd>{label(receipt.geofenceStatus)}</dd></div>
            <div><dt>Photo evidence</dt><dd>{label(receipt.evidenceState)}</dd></div>
          </dl>
          <div className="access-receipt-authority">
            <strong>Officer record</strong>
            <p>Your action is the operational record. Bob did not change it.</p>
          </div>
          <div className="access-receipt-bob">
            <strong>Bob recognition discovery</strong>
            {receipt.recognition.status === 'available' ? (
              <>
                <p>{receipt.recognition.classification || 'Visible scene candidate'}{typeof receipt.recognition.confidence === 'number' ? ` · ${Math.round(receipt.recognition.confidence * 100)}% raw field confidence` : ''}</p>
                <small>{receipt.recognition.reasoning}</small>
                <RecognitionComparison recognition={receipt.recognition} probeImageUrl={receipt.probeImageUrl} />
              </>
            ) : (
              <p>{receipt.recognition.status === 'not_requested' ? 'No photo was submitted; no machine candidate was created.' : 'Classification unavailable; no fallback candidate was invented.'}</p>
            )}
            <em>{label(receipt.recognitionReviewState)}. Bob can rank possible matches; only a user can confirm identity, validate a credential, or grant entry.</em>
          </div>
        </section>
      )}

      <section className="reports-section">
        <h2>Your recent events ({events.length})</h2>
        {events.length === 0 ? <div className="empty-state"><p>No access-control events recorded yet.</p></div> : (
          <div className="access-event-list">
            {events.map((event) => (
              <article key={event.id}>
                <header><strong>{label(event.event_kind)}</strong><span>{new Date(event.observed_at).toLocaleString()}</span></header>
                <p>{label(event.officer_decision)} · {label(event.decision_basis)} · {label(event.subject_kind)}</p>
                <small>Place {label(event.geofence_context?.resolution_status ?? 'not_evaluated')} · Evidence {label(event.evidence_state)} · Bob {label(event.recognition_review_state)}</small>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};

export default OfficerAccessControlPage;
