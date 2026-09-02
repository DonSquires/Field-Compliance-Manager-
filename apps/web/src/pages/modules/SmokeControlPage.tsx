import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Camera, CheckCircle2, Crosshair, RefreshCw, Scale, Wind, X } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useServiceRelationships } from '../../context/ServiceRelationshipContext';
import { getCurrentPosition, imageFileToBase64 } from '../../lib/officerScan';
import { supabase } from '../../lib/supabase';
import '../PageStyles.css';

interface SmokeAssessment {
  id: string;
  site_id: string | null;
  officer_user_id: string | null;
  officer_name: string | null;
  complaint_source: string | null;
  smoke_source_type: string | null;
  severity: string | null;
  status: string;
  scene_description: string | null;
  action_taken: string | null;
  legal_basis: string | null;
  follow_up_required: boolean;
  notice_number: string | null;
  notes: string | null;
  address: string | null;
  complaint_address: string | null;
  photo_urls: Array<{ storage_path?: string }>;
  reviewed_at: string | null;
  review_notes: string | null;
  bob_classification: string | null;
  bob_confidence: number | null;
  smoke_ai_analysis: {
    evidence_grade?: string;
    manual_review_required?: boolean;
    legal_use_boundary?: string;
  } | null;
  assessed_at: string;
}

interface EvidencePhoto { name: string; imageBase64: string; previewUrl: string }

const EMPTY_FORM = {
  complaintSource: 'neighbour',
  smokeSourceType: 'unknown',
  severity: 'moderate',
  complaintAddress: '',
  sourceAddress: '',
  sceneDescription: '',
  notes: '',
  sourceConfirmed: false,
  checklist: [false, false, false, false],
};

const CHECKLIST = ['Safe approach confirmed', 'Wind direction assessed', 'Public exposure checked', 'Emergency fire risk excluded'];
const ADMIN_ROLES = new Set(['grand_master', 'master', 'admin']);

const SmokeAdvisory = ({ assessment }: { assessment: SmokeAssessment }) => assessment.bob_classification ? <div className={`smoke-ai-advisory ${assessment.smoke_ai_analysis?.manual_review_required ? 'requires-review' : ''}`}>
  <div><strong>Observational AI advisory</strong><span>{assessment.smoke_ai_analysis?.evidence_grade ?? 'ungraded'} evidence · {Math.round((assessment.bob_confidence ?? 0) * 100)}% minimum field confidence</span></div>
  <p>{assessment.bob_classification}</p>
  {assessment.smoke_ai_analysis?.manual_review_required && <b>Manual review required</b>}
  <small>{assessment.smoke_ai_analysis?.legal_use_boundary}</small>
</div> : null;

const SmokeControlPage: React.FC = () => {
  const { profile } = useAuth();
  const relationships = useServiceRelationships();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [assessments, setAssessments] = useState<SmokeAssessment[]>([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [photos, setPhotos] = useState<EvidencePhoto[]>([]);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [location, setLocation] = useState<{ status: 'locating' | 'ready' | 'unavailable'; lat: number | null; lng: number | null; accuracy: number | null }>({ status: 'locating', lat: null, lng: null, accuracy: null });
  const [reviewing, setReviewing] = useState<SmokeAssessment | null>(null);
  const [classifyingId, setClassifyingId] = useState<string | null>(null);
  const [decision, setDecision] = useState({ action: 'no_action', legalBasis: '', followUp: false, notes: '' });
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const isAdmin = ADMIN_ROLES.has(profile?.role ?? '');
  const selectedSite = relationships.selectedSite;

  useEffect(() => {
    if (relationships.loading) return;
    if (selectedSite && relationships.selectedAgreementSites.some((site) => site.id === selectedSite.id)) return;
    relationships.selectSite(relationships.selectedAgreementSites[0]?.id ?? null);
  }, [relationships, selectedSite]);

  const loadAssessments = useCallback(async () => {
    if (!selectedSite) {
      setAssessments([]);
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      const { data, error: queryError } = await supabase.from('smoke_assessments').select('id, site_id, officer_user_id, officer_name, complaint_source, smoke_source_type, severity, status, scene_description, action_taken, legal_basis, follow_up_required, notice_number, notes, address, complaint_address, photo_urls, reviewed_at, review_notes, bob_classification, bob_confidence, smoke_ai_analysis, assessed_at').eq('site_id', selectedSite.id).order('assessed_at', { ascending: false });
      if (queryError) throw queryError;
      setAssessments((data as SmokeAssessment[]) ?? []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Smoke assessments could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [selectedSite]);

  const acquireLocation = useCallback(async () => {
    setLocation({ status: 'locating', lat: null, lng: null, accuracy: null });
    try {
      const position = await getCurrentPosition();
      setLocation({ status: 'ready', lat: position.coords.latitude, lng: position.coords.longitude, accuracy: position.coords.accuracy });
    } catch {
      setLocation({ status: 'unavailable', lat: null, lng: null, accuracy: null });
    }
  }, []);

  useEffect(() => { void loadAssessments(); }, [loadAssessments]);
  useEffect(() => { void acquireLocation(); }, [acquireLocation]);
  useEffect(() => () => photos.forEach((photo) => URL.revokeObjectURL(photo.previewUrl)), [photos]);
  useEffect(() => {
    if (selectedSite) setForm((current) => ({ ...current, sourceAddress: selectedSite.address ?? '' }));
  }, [selectedSite]);

  const handlePhotos = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []).slice(0, 3);
    setError(null);
    try {
      const prepared = await Promise.all(files.map(async (file) => ({ name: file.name, imageBase64: await imageFileToBase64(file), previewUrl: URL.createObjectURL(file) })));
      photos.forEach((photo) => URL.revokeObjectURL(photo.previewUrl));
      setPhotos(prepared);
    } catch (imageError) {
      setError(imageError instanceof Error ? imageError.message : 'Smoke evidence could not be prepared.');
    }
  };

  const submitAssessment = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedSite || location.lat === null || location.lng === null || photos.length < 1 || form.checklist.some((item) => !item) || !form.sourceConfirmed) return;
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const { data, error: invokeError } = await supabase.functions.invoke('submit-smoke-assessment', { body: {
        client_request_id: requestId,
        payload: { site_id: selectedSite.id, complaint_source: form.complaintSource, smoke_source_type: form.smokeSourceType, severity: form.severity, complaint_address: form.complaintAddress, source_address: form.sourceAddress, scene_description: form.sceneDescription, notes: form.notes, source_confirmed: form.sourceConfirmed, checklist: form.checklist, gps_lat: location.lat, gps_lng: location.lng, gps_accuracy: location.accuracy },
        photos: photos.map((photo) => ({ file_name: photo.name, image_base64: photo.imageBase64 })),
      } });
      if (invokeError) throw invokeError;
      if (!data?.success || !data.receipt?.assessment_id) throw new Error('Smoke assessment receipt was not returned.');
      let inferenceWarning = false;
      try {
        // ATLAS INVOKES: classify-smoke-assessment
        const { data: classification, error: classificationError } = await supabase.functions.invoke('classify-smoke-assessment', { body: { assessment_id: data.receipt.assessment_id } });
        if (classificationError || !classification?.success) throw classificationError ?? new Error('Smoke analysis did not complete.');
      } catch {
        inferenceWarning = true;
      }
      setNotice(data.receipt.created === false ? 'Existing Smoke assessment receipt recovered.' : inferenceWarning ? 'Smoke assessment submitted. AI analysis needs retry or manual review.' : 'Smoke assessment submitted with observational AI advisory.');
      photos.forEach((photo) => URL.revokeObjectURL(photo.previewUrl));
      setPhotos([]);
      setForm({ ...EMPTY_FORM, sourceAddress: selectedSite.address ?? '' });
      setRequestId(crypto.randomUUID());
      await loadAssessments();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Smoke assessment could not be submitted.');
    } finally {
      setSubmitting(false);
    }
  };

  const reviewAssessment = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!reviewing) return;
    setSubmitting(true);
    setError(null);
    try {
      const { error: reviewError } = await supabase.rpc('manage_smoke_assessment', { p_assessment_id: reviewing.id, p_expected_status: reviewing.status, p_action: decision.action, p_legal_basis: decision.legalBasis || null, p_follow_up_required: decision.followUp, p_notes: decision.notes });
      if (reviewError) throw reviewError;
      setNotice('Smoke Control decision recorded.');
      setReviewing(null);
      setDecision({ action: 'no_action', legalBasis: '', followUp: false, notes: '' });
      await loadAssessments();
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : 'Smoke assessment decision could not be recorded.');
    } finally {
      setSubmitting(false);
    }
  };

  const retryClassification = async (assessmentId: string) => {
    setClassifyingId(assessmentId);
    setError(null);
    try {
      const { data, error: classificationError } = await supabase.functions.invoke('classify-smoke-assessment', { body: { assessment_id: assessmentId } });
      if (classificationError || !data?.success) throw classificationError ?? new Error('Smoke analysis did not complete.');
      setNotice('Observational AI advisory recorded.');
      await loadAssessments();
    } catch (classificationError) {
      setError(classificationError instanceof Error ? classificationError.message : 'Smoke analysis did not complete.');
    } finally {
      setClassifyingId(null);
    }
  };

  return <div className="page-container smoke-control-page">
    <header className="page-header"><h1>Smoke Control</h1><p className="subtitle">Evidence-backed nuisance assessment and legal response</p></header>
    {error && <div className="alert alert-error" role="alert"><AlertTriangle size={18} />{error}<button className="alert-close" onClick={() => setError(null)} aria-label="Close alert"><X size={16} /></button></div>}
    {notice && <div className="alert alert-success" role="status"><CheckCircle2 size={18} />{notice}</div>}
    <div className="smoke-enterprise-layout">
      <aside className="site-selector"><h2>Source sites</h2><div className="sites-list">{relationships.selectedAgreementSites.map((site) => <button type="button" key={site.id} className={`site-card ${selectedSite?.id === site.id ? 'active' : ''}`} onClick={() => relationships.selectSite(site.id)}><h3>{site.name}</h3><p className="site-address">{site.address}</p></button>)}</div></aside>
      <main className="smoke-workspace">
        {selectedSite && <form className="assessment-form smoke-capture" onSubmit={submitAssessment}>
          <div className="form-section-header"><Wind size={21} /><div><h2>Field assessment</h2><p>Record facts and evidence. Formal action remains supervisor-owned.</p></div></div>
          <div className="form-grid form-grid-2"><div className="form-group"><label>Complaint source</label><select value={form.complaintSource} onChange={(event) => setForm({ ...form, complaintSource: event.target.value })}><option value="neighbour">Neighbour</option><option value="council_hotline">Council hotline</option><option value="self_report">Self report</option><option value="other">Other</option></select></div><div className="form-group"><label>Observed source</label><select value={form.smokeSourceType} onChange={(event) => setForm({ ...form, smokeSourceType: event.target.value })}><option value="domestic_solid_fuel">Domestic solid fuel</option><option value="industrial">Industrial</option><option value="vehicle_exhaust">Vehicle exhaust</option><option value="agricultural">Agricultural</option><option value="nuisance_burning">Nuisance burning</option><option value="unknown">Unknown</option></select></div></div>
          <div className="form-grid form-grid-2"><div className="form-group"><label>Severity</label><select value={form.severity} onChange={(event) => setForm({ ...form, severity: event.target.value })}><option value="low">Low</option><option value="moderate">Moderate</option><option value="high">High</option><option value="critical">Critical</option></select></div><div className="form-group"><label>Source address</label><input required value={form.sourceAddress} onChange={(event) => setForm({ ...form, sourceAddress: event.target.value })} /></div></div>
          <div className="form-group"><label>Complainant / affected address</label><input required value={form.complaintAddress} onChange={(event) => setForm({ ...form, complaintAddress: event.target.value })} /></div>
          <div className="form-group"><label>Scene description</label><textarea required rows={3} value={form.sceneDescription} onChange={(event) => setForm({ ...form, sceneDescription: event.target.value })} /></div>
          <fieldset className="noise-checklist"><legend>Health and safety</legend>{CHECKLIST.map((label, index) => <label key={label}><input type="checkbox" checked={form.checklist[index]} onChange={(event) => setForm({ ...form, checklist: form.checklist.map((item, itemIndex) => itemIndex === index ? event.target.checked : item) })} />{label}</label>)}</fieldset>
          <label className="smoke-confirm"><input type="checkbox" checked={form.sourceConfirmed} onChange={(event) => setForm({ ...form, sourceConfirmed: event.target.checked })} />I observed and confirmed the recorded smoke source</label>
          <input ref={fileInputRef} className="sr-only" type="file" accept="image/*" capture="environment" multiple onChange={handlePhotos} />
          <button type="button" className="smoke-evidence-button" onClick={() => fileInputRef.current?.click()}><Camera size={20} />{photos.length ? `${photos.length} evidence photo${photos.length === 1 ? '' : 's'} ready` : 'Capture 1-3 evidence photos'}</button>
          {photos.length > 0 && <div className="smoke-photo-strip">{photos.map((photo) => <img key={photo.previewUrl} src={photo.previewUrl} alt="Smoke evidence preview" />)}</div>}
          <div className={`parking-location location-${location.status}`}><Crosshair size={17} /><span>{location.status === 'ready' ? `GPS ready, accuracy ${Math.round(location.accuracy ?? 0)} m` : location.status === 'locating' ? 'Acquiring GPS' : 'GPS required for Smoke evidence'}</span><button type="button" onClick={() => void acquireLocation()}><RefreshCw size={16} /><span className="sr-only">Refresh GPS</span></button></div>
          <div className="form-group"><label>Officer notes</label><textarea rows={2} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></div>
          <button className="btn btn-primary btn-block" disabled={submitting || location.status !== 'ready' || photos.length < 1 || form.checklist.some((item) => !item) || !form.sourceConfirmed}>{submitting ? 'Submitting assessment...' : 'Submit Smoke assessment'}</button>
        </form>}

        <section className="assessment-history"><div className="section-heading"><h2>Assessment history</h2><span>{assessments.length}</span></div>{loading ? <div className="loading-state"><div className="spinner"></div></div> : assessments.length === 0 ? <div className="empty-state"><p>No Smoke assessments for this source site.</p></div> : <div className="assessments-list">{assessments.map((assessment) => <article className="assessment-card" key={assessment.id}><div className="assessment-header"><div><h3>{assessment.smoke_source_type?.replaceAll('_', ' ') ?? 'Unknown source'}</h3><small>{new Date(assessment.assessed_at).toLocaleString()} · {assessment.officer_name ?? 'Officer'}</small></div><span className={`severity-badge severity-${assessment.severity}`}>{assessment.severity}</span></div><div className="smoke-address-pair"><span>Source: {assessment.address}</span><span>Affected: {assessment.complaint_address}</span></div><p>{assessment.scene_description}</p><div className="smoke-evidence-meta"><span>{assessment.photo_urls?.length ?? 0} private photo(s)</span><span>{assessment.action_taken?.replaceAll('_', ' ') ?? 'awaiting review'}</span>{assessment.notice_number && <strong>{assessment.notice_number}</strong>}</div><SmokeAdvisory assessment={assessment} />{!assessment.bob_classification && assessment.status === 'open' && <button type="button" className="btn btn-secondary btn-sm" disabled={classifyingId === assessment.id} onClick={() => void retryClassification(assessment.id)}>{classifyingId === assessment.id ? 'Analyzing evidence...' : 'Retry AI analysis'}</button>}{assessment.review_notes && <div className="parking-provenance"><Scale size={16} /><span>{assessment.review_notes}{assessment.legal_basis ? ` · ${assessment.legal_basis}` : ''}</span></div>}{isAdmin && (assessment.status === 'open' || assessment.status === 'follow_up') && <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setReviewing(assessment); setDecision({ action: assessment.action_taken ?? 'no_action', legalBasis: assessment.legal_basis ?? '', followUp: assessment.follow_up_required, notes: '' }); }}>Review legal outcome</button>}</article>)}</div>}</section>
      </main>
    </div>
    {reviewing && <div className="place-manager-backdrop"><form className="smoke-review-dialog" onSubmit={reviewAssessment} role="dialog" aria-modal="true"><header><div><span>Supervisor decision</span><h2>{reviewing.smoke_source_type?.replaceAll('_', ' ')}</h2></div><button type="button" onClick={() => setReviewing(null)} aria-label="Close review"><X size={18} /></button></header><SmokeAdvisory assessment={reviewing} /><div className="form-group"><label>Action</label><select value={decision.action} onChange={(event) => setDecision({ ...decision, action: event.target.value })}><option value="no_action">No action</option><option value="verbal_warning">Verbal warning</option><option value="abatement_notice">Abatement notice</option><option value="infringement_notice">Infringement notice</option><option value="prosecution_referral">Prosecution referral</option></select></div><div className="form-group"><label>Legal basis</label><input value={decision.legalBasis} onChange={(event) => setDecision({ ...decision, legalBasis: event.target.value })} required={['abatement_notice','infringement_notice','prosecution_referral'].includes(decision.action)} placeholder="Applicable bylaw or statutory provision" /></div><label className="smoke-confirm"><input type="checkbox" checked={decision.followUp} onChange={(event) => setDecision({ ...decision, followUp: event.target.checked })} />Follow-up inspection required</label><div className="form-group"><label>Decision notes</label><textarea required rows={4} value={decision.notes} onChange={(event) => setDecision({ ...decision, notes: event.target.value })} /></div><button className="btn btn-primary btn-block" disabled={submitting}>Record governed decision</button></form></div>}
  </div>;
};

export default SmokeControlPage;