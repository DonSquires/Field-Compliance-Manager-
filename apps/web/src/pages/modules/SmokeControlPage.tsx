/**
 * SmokeControlPage.tsx (module: Smoke Control)
 *
 * Canonical schema: client_sites (site selector) + smoke_assessments
 * (organization_id, site_id, complaint_source, smoke_source_type, severity,
 * status, scene_description, action_taken, notes, address, assessed_at).
 * Optional complainant_site_id anchors the affected property when it is a known site.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Camera, CheckCircle2, X } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useServiceRelationships, type ServiceLocationSite } from '../../context/ServiceRelationshipContext';
import { supabase } from '../../lib/supabase';
import { imageFileToBase64 } from '../../lib/officerScan';
import '../PageStyles.css';

interface SmokeAssessment {
  id: string;
  site_id: string | null;
  organization_id: string;
  complaint_source: string | null;
  smoke_source_type: string | null;
  severity: string | null;
  status: string;
  scene_description: string | null;
  action_taken: string | null;
  notes: string | null;
  address: string | null;
  assessed_at: string;
  officer_name: string | null;
  notice_number: string | null;
  legal_basis: string | null;
  follow_up_required: boolean;
  source_confirmed: boolean;
  evidence_state: string;
  review_state: string;
  review_notes: string | null;
  photo_urls: Array<{ storage_path?: string; captured_at?: string }> | null;
  smoke_ai_analysis: {
    status?: string;
    classification?: string | null;
    confidence?: number | null;
    details?: {
      smoke_source?: string | null;
      severity?: string | null;
      visibility_impact?: string | null;
    };
    reasoning?: string | null;
    classifier?: string | null;
    provider?: string | null;
    model?: string | null;
    prompt_version?: string | null;
    failure_reason?: string | null;
  } | null;
  smoke_ai_review: {
    action?: string;
    smoke_source_type?: string;
    severity?: string;
    notes?: string;
    reviewed_at?: string;
  } | null;
}

interface AssessmentForm {
  complaint_source: string;
  smoke_source_type: string;
  severity: string;
  scene_description: string;
  notes: string;
  complaint_address: string;
  complainant_site_id: string;
  action_taken: string;
  notice_number: string;
  source_confirmed: boolean;
  follow_up_required: boolean;
}

const EMPTY_FORM: AssessmentForm = {
  complaint_source: 'neighbour',
  smoke_source_type: 'nuisance_burning',
  severity: 'moderate',
  scene_description: '',
  notes: '',
  complaint_address: '',
  complainant_site_id: '',
  action_taken: 'no_action',
  notice_number: '',
  source_confirmed: false,
  follow_up_required: false,
};

const SmokeControlPage: React.FC = () => {
  const { profile } = useAuth();
  const { selectedAgreementSites, selectedSite, selectSite, loading: relationshipLoading } = useServiceRelationships();
  const [assessments, setAssessments] = useState<SmokeAssessment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState<AssessmentForm>(EMPTY_FORM);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [preparingImage, setPreparingImage] = useState(false);
  const [evidenceNotice, setEvidenceNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [evidenceUrls, setEvidenceUrls] = useState<Record<string, string>>({});
  const [evidenceErrors, setEvidenceErrors] = useState<Record<string, string>>({});
  const [classificationReviewId, setClassificationReviewId] = useState<string | null>(null);
  const [classificationAction, setClassificationAction] = useState<'confirm' | 'correct' | 'reject'>('confirm');
  const [classificationSource, setClassificationSource] = useState('unknown');
  const [classificationSeverity, setClassificationSeverity] = useState('moderate');
  const [classificationNotes, setClassificationNotes] = useState('');
  const [workflowReviewId, setWorkflowReviewId] = useState<string | null>(null);
  const [workflowNotes, setWorkflowNotes] = useState('');
  const [legalReviewId, setLegalReviewId] = useState<string | null>(null);
  const [legalAction, setLegalAction] = useState('no_action');
  const [legalBasis, setLegalBasis] = useState('RMA s.17A');
  const [legalFollowUp, setLegalFollowUp] = useState(false);
  const [legalNotes, setLegalNotes] = useState('');
  const [savingReview, setSavingReview] = useState(false);

  useEffect(() => {
    if (relationshipLoading) return;
    if (selectedSite && selectedAgreementSites.some((site) => site.id === selectedSite.id)) return;
    selectSite(selectedAgreementSites[0]?.id ?? null);
  }, [relationshipLoading, selectedAgreementSites, selectedSite, selectSite]);

  useEffect(() => {
    if (!selectedSite || !selectedAgreementSites.some((site) => site.id === selectedSite.id)) {
      setAssessments([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    void loadAssessments(selectedSite.id).finally(() => setLoading(false));
  }, [selectedSite, selectedAgreementSites]);

  const loadAssessments = useCallback(async (siteId: string) => {
    try {
      // ATLAS READS: smoke_assessments (filtered by site)
      const { data, error: err } = await supabase
        .from('smoke_assessments')
        .select(
          'id, site_id, organization_id, complaint_source, smoke_source_type, severity, status, scene_description, action_taken, notes, address, assessed_at, officer_name, notice_number, legal_basis, follow_up_required, source_confirmed, evidence_state, review_state, review_notes, photo_urls, smoke_ai_analysis, smoke_ai_review'
        )
        .eq('site_id', siteId)
        .order('assessed_at', { ascending: false });

      if (err) throw err;
      const rows = (data as SmokeAssessment[]) || [];
      const signedEntries = await Promise.all(rows.map(async (row) => {
        const path = row.photo_urls?.find((photo) => photo.storage_path)?.storage_path;
        if (!path) return { id: row.id, url: null, error: 'No linked photo is available for this assessment.' };
        const { data: signed, error: signError } = await supabase.storage.from('scans').createSignedUrl(path, 15 * 60);
        if (signError || !signed?.signedUrl) {
          return { id: row.id, url: null, error: signError?.message || 'Private evidence could not be signed.' };
        }
        return { id: row.id, url: signed.signedUrl, error: null };
      }));
      setAssessments(rows);
      setEvidenceUrls(Object.fromEntries(signedEntries.filter((entry) => entry.url).map((entry) => [entry.id, entry.url as string])));
      setEvidenceErrors(Object.fromEntries(signedEntries.filter((entry) => entry.error).map((entry) => [entry.id, entry.error as string])));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load assessments');
    }
  }, []);

  const handleSelectSite = (site: ServiceLocationSite) => {
    selectSite(site.id);
  };

  useEffect(() => () => { if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl); }, [imagePreviewUrl]);

  const captureEvidence = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return;
    setPreparingImage(true); setError(null);
    try { if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl); setImagePreviewUrl(URL.createObjectURL(file)); setImageBase64(await imageFileToBase64(file)); }
    catch (captureError) { setImagePreviewUrl(null); setImageBase64(null); setError(captureError instanceof Error ? captureError.message : 'Evidence photo could not be prepared.'); }
    finally { setPreparingImage(false); }
  };

  const clearEvidence = () => { if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl); setImagePreviewUrl(null); setImageBase64(null); if (fileInputRef.current) fileInputRef.current.value = ''; };

  const handleSubmitAssessment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSite || !profile?.organizationId || !imageBase64) return;

    try {
      setSubmitting(true);
      setEvidenceNotice(null);
      setError(null);
      const requestId = crypto.randomUUID();

      // ATLAS WRITES: submit-smoke-assessment
      const { data, error: fnError } = await supabase.functions.invoke<{
        success?: boolean;
        assessment_id?: string;
        review_state?: string;
        is_out_of_hours?: boolean;
        classification?: { classification?: string };
        error?: string;
      }>('submit-smoke-assessment', {
        body: {
          client_request_id: requestId,
          assessed_at: new Date().toISOString(),
          site_id: selectedSite.id,
          address: selectedSite.address ?? formData.complaint_address.trim(),
          complaint_address: formData.complaint_address.trim() || null,
          complainant_site_id: formData.complainant_site_id || null,
          complaint_source: formData.complaint_source,
          smoke_source_type: formData.smoke_source_type,
          severity: formData.severity,
          action_taken: formData.action_taken,
          notice_number: formData.notice_number.trim() || null,
          scene_description: formData.scene_description.trim() || null,
          notes: formData.notes.trim() || null,
          source_confirmed: formData.source_confirmed,
          follow_up_required: formData.follow_up_required,
          image_base64: imageBase64,
        },
      });

      if (fnError || data?.error || !data?.assessment_id) {
        throw new Error(fnError?.message || data?.error || 'Smoke assessment submission was not confirmed.');
      }

      setEvidenceNotice(
        `Smoke assessment confirmed · Review state: ${data.review_state ?? 'submitted'}${
          data.is_out_of_hours ? ' · Out-of-hours coverage' : ''
        }${data.classification?.classification
          ? ` · Bob candidate: ${data.classification.classification} (human review required)`
          : ' · Photo classification unavailable; human review required'}.`
      );
      setFormData(EMPTY_FORM);
      clearEvidence();
      setShowForm(false);
      await loadAssessments(selectedSite.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit assessment');
    } finally {
      setSubmitting(false);
    }
  };

  const beginClassificationReview = (assessment: SmokeAssessment) => {
    const candidate = assessment.smoke_ai_analysis?.details?.smoke_source ?? assessment.smoke_source_type ?? 'unknown';
    const sourceMap: Record<string, string> = {
      domestic_fire: 'domestic_solid_fuel',
      burn_off: 'nuisance_burning',
      industrial: 'industrial',
      vehicle: 'vehicle_exhaust',
      rubbish: 'nuisance_burning',
    };
    const severityMap: Record<string, string> = {
      minor: 'low',
      moderate: 'moderate',
      significant: 'high',
      severe: 'critical',
    };
    setClassificationReviewId(assessment.id);
    setClassificationAction('confirm');
    setClassificationSource(sourceMap[candidate] ?? assessment.smoke_source_type ?? 'unknown');
    setClassificationSeverity(severityMap[assessment.smoke_ai_analysis?.details?.severity ?? ''] ?? assessment.severity ?? 'moderate');
    setClassificationNotes('');
    setEvidenceNotice(null);
  };

  const saveClassificationReview = async (assessment: SmokeAssessment) => {
    if (!classificationNotes.trim()) {
      setError('Photo-classification review notes are required.');
      return;
    }
    try {
      setSavingReview(true);
      setError(null);
      const { error: reviewError } = await supabase.rpc('review_smoke_photo_classification', {
        p_assessment_id: assessment.id,
        p_action: classificationAction,
        p_smoke_source_type: classificationAction === 'reject' ? null : classificationSource,
        p_severity: classificationAction === 'reject' ? null : classificationSeverity,
        p_notes: classificationNotes.trim(),
      });
      if (reviewError) throw reviewError;
      setClassificationReviewId(null);
      setEvidenceNotice(`Photo classification ${classificationAction === 'reject' ? 'rejected' : 'recorded with human authority'}.`);
      await loadAssessments(assessment.site_id as string);
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : 'Photo-classification review could not be saved.');
    } finally {
      setSavingReview(false);
    }
  };

  const saveWorkflowReview = async (assessment: SmokeAssessment, action: 'triage' | 'require_review' | 'close') => {
    if (!workflowNotes.trim()) {
      setError('Workflow review notes are required.');
      return;
    }
    try {
      setSavingReview(true);
      setError(null);
      const { error: reviewError } = await supabase.rpc('manage_smoke_assessment_review', {
        p_assessment_id: assessment.id,
        p_expected_review_state: assessment.review_state,
        p_action: action,
        p_notes: workflowNotes.trim(),
      });
      if (reviewError) throw reviewError;
      setWorkflowReviewId(null);
      setEvidenceNotice('Smoke assessment workflow review saved.');
      await loadAssessments(assessment.site_id as string);
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : 'Workflow review could not be saved.');
    } finally {
      setSavingReview(false);
    }
  };

  const beginLegalReview = (assessment: SmokeAssessment) => {
    setLegalReviewId(assessment.id);
    setLegalAction(assessment.action_taken ?? 'no_action');
    setLegalBasis(assessment.legal_basis ?? 'RMA s.17A');
    setLegalFollowUp(assessment.follow_up_required);
    setLegalNotes('');
    setEvidenceNotice(null);
  };

  const saveLegalReview = async (assessment: SmokeAssessment) => {
    if (!legalNotes.trim()) {
      setError('Supervisor decision notes are required.');
      return;
    }
    try {
      setSavingReview(true);
      setError(null);
      const { error: actionError } = await supabase.rpc('manage_smoke_assessment', {
        p_assessment_id: assessment.id,
        p_expected_status: assessment.status,
        p_action: legalAction,
        p_legal_basis: legalAction === 'no_action' ? null : legalBasis.trim() || null,
        p_follow_up_required: legalFollowUp,
        p_notes: legalNotes.trim(),
      });
      if (actionError) throw actionError;
      setLegalReviewId(null);
      setEvidenceNotice('Smoke action decision saved with an audit receipt.');
      await loadAssessments(assessment.site_id as string);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Smoke action decision could not be saved.');
    } finally {
      setSavingReview(false);
    }
  };

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading smoke control data...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container smoke-control-page">
      <header className="page-header">
        <h1>Smoke Control</h1>
        <p className="subtitle">Smoke complaint assessment and enforcement tracking</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}
      {evidenceNotice && <div className="alert alert-success" role="status">{evidenceNotice}</div>}

      <div className="smoke-layout">
        <div className="site-selector">
            <h2>Sites ({selectedAgreementSites.length})</h2>
          <div className="sites-list">
            {selectedAgreementSites.length === 0 ? (
              <div className="empty-state">
                <p>No sites configured for this organisation.</p>
              </div>
            ) : (
              selectedAgreementSites.map((site) => (
                <button
                  key={site.id}
                  className={`site-card ${selectedSite?.id === site.id ? 'active' : ''}`}
                  onClick={() => handleSelectSite(site)}
                >
                  <h3>{site.name}</h3>
                  <p className="site-address">{site.address}</p>
                  {site.site_type && <span className="site-type-badge">{site.site_type}</span>}
                </button>
              ))
            )}
          </div>
        </div>

        {selectedSite && (
          <div className="assessment-details">
            <div className="details-header">
              <h2>{selectedSite.name}</h2>
              <button className="btn btn-primary btn-sm" onClick={() => setShowForm(!showForm)}>
                {showForm ? 'Cancel' : '+ New Assessment'}
              </button>
            </div>

            {showForm && (
              <form className="assessment-form" onSubmit={handleSubmitAssessment}>
                <input ref={fileInputRef} className="sr-only" type="file" accept="image/*" capture="environment" onChange={captureEvidence} />
                <div className="form-group"><label>Smoke evidence</label>{imagePreviewUrl ? <div className="scan-preview"><img src={imagePreviewUrl} alt="Smoke evidence preview" /><span><CheckCircle2 size={15} /> Ready for inference and watermarking</span><button type="button" onClick={clearEvidence} title="Remove image"><X size={18} /><span className="sr-only">Remove image</span></button></div> : <button type="button" className="scan-camera-target" onClick={() => fileInputRef.current?.click()} disabled={preparingImage}><Camera size={28} /><strong>{preparingImage ? 'Preparing image' : 'Capture smoke evidence'}</strong><span>Photo evidence is required</span></button>}</div>
                <div className="form-group">
                  <label htmlFor="smoke-complaint-source">Complaint source</label>
                  <select
                    id="smoke-complaint-source"
                    value={formData.complaint_source}
                    onChange={(e) => setFormData({ ...formData, complaint_source: e.target.value })}
                  >
                    <option value="neighbour">Neighbour complaint</option>
                    <option value="council_hotline">Council hotline</option>
                    <option value="self_report">Self report</option>
                    <option value="other">Other</option>
                  </select>
                </div>

                <div className="form-group">
                  <label htmlFor="smoke-source-type">Smoke source type</label>
                  <select
                    id="smoke-source-type"
                    value={formData.smoke_source_type}
                    onChange={(e) => setFormData({ ...formData, smoke_source_type: e.target.value })}
                  >
                    <option value="nuisance_burning">Nuisance burning</option>
                    <option value="industrial">Industrial</option>
                    <option value="domestic_solid_fuel">Domestic solid fuel</option>
                    <option value="vehicle_exhaust">Vehicle exhaust</option>
                    <option value="agricultural">Agricultural</option>
                    <option value="unknown">Unknown</option>
                  </select>
                </div>

                <div className="form-group">
                  <label htmlFor="smoke-severity">Severity</label>
                  <select
                    id="smoke-severity"
                    value={formData.severity}
                    onChange={(e) => setFormData({ ...formData, severity: e.target.value })}
                  >
                    <option value="low">Low</option>
                    <option value="moderate">Moderate</option>
                    <option value="high">High</option>
                    <option value="critical">Critical</option>
                  </select>
                </div>

                <div className="form-group">
                  <label htmlFor="smoke-complaint-address">Complainant address</label>
                  <input id="smoke-complaint-address" value={formData.complaint_address} onChange={(e) => setFormData({ ...formData, complaint_address: e.target.value })} placeholder="Affected property, if different from source site" />
                </div>
                <div className="form-group">
                  <label htmlFor="smoke-complainant-site">Known affected site</label>
                  <select id="smoke-complainant-site" value={formData.complainant_site_id} onChange={(e) => setFormData({ ...formData, complainant_site_id: e.target.value })}>
                    <option value="">Not a known site</option>
                    {selectedAgreementSites.filter((site) => site.id !== selectedSite.id).map((site) => <option key={site.id} value={site.id}>{site.name}{site.address ? ` - ${site.address}` : ''}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label htmlFor="smoke-scene">Scene description</label>
                  <textarea
                    id="smoke-scene"
                    required
                    value={formData.scene_description}
                    onChange={(e) => setFormData({ ...formData, scene_description: e.target.value })}
                    rows={3}
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="smoke-action">Action taken</label>
                  <select id="smoke-action" value={formData.action_taken} onChange={(e) => setFormData({ ...formData, action_taken: e.target.value })}><option value="no_action">No action</option><option value="verbal_warning">Verbal warning</option><option value="abatement_notice">Abatement notice</option><option value="infringement_notice">Infringement notice</option><option value="prosecution_referral">Prosecution referral</option></select>
                </div>
                {['abatement_notice', 'infringement_notice'].includes(formData.action_taken) && (
                  <div className="form-group">
                    <label htmlFor="smoke-notice-number">Notice number</label>
                    <input id="smoke-notice-number" required value={formData.notice_number} onChange={(e) => setFormData({ ...formData, notice_number: e.target.value })} placeholder="Required statutory notice reference" />
                  </div>
                )}
                <div className="form-group">
                  <label htmlFor="smoke-notes">Notes</label>
                  <textarea
                    id="smoke-notes"
                    value={formData.notes}
                    onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                    rows={3}
                  />
                </div>

                <label className="form-checkbox"><input type="checkbox" checked={formData.source_confirmed} onChange={(e) => setFormData({ ...formData, source_confirmed: e.target.checked })} /> Source confirmed at the selected site</label>
                <label className="form-checkbox"><input type="checkbox" checked={formData.follow_up_required} onChange={(e) => setFormData({ ...formData, follow_up_required: e.target.checked })} /> Follow-up required</label>

                <button type="submit" className="btn btn-primary btn-block" disabled={submitting || preparingImage || !imageBase64 || !formData.scene_description.trim() || !formData.source_confirmed || (['abatement_notice', 'infringement_notice'].includes(formData.action_taken) && !formData.notice_number.trim())}>
                  {submitting ? 'Submitting assessment...' : 'Submit assessment'}
                </button>
              </form>
            )}

            <div className="assessment-history">
              <h3>Assessment History ({assessments.length})</h3>
              {assessments.length === 0 ? (
                <div className="empty-state">
                  <p>No assessments recorded for this site yet.</p>
                </div>
              ) : (
                <div className="assessments-list">
                  {assessments.map((assessment) => (
                    <article key={assessment.id} className="assessment-card smoke-review-card">
                      <div className="assessment-header">
                        <div>
                          <h4>{new Date(assessment.assessed_at).toLocaleString()}</h4>
                          <p className="contact-meta">{assessment.officer_name || 'Officer not recorded'} · {assessment.address || 'Source address not recorded'}</p>
                        </div>
                        <div className="smoke-status-stack">
                          <span className={`status-badge status-${assessment.status}`}>{assessment.status.replaceAll('_', ' ')}</span>
                          <span className={`severity-badge severity-${assessment.severity}`}>{assessment.severity || 'unrated'}</span>
                        </div>
                      </div>
                      <div className="smoke-review-layout">
                        <section className="smoke-evidence-panel" aria-label="Smoke photo evidence">
                          {evidenceUrls[assessment.id]
                            ? <img src={evidenceUrls[assessment.id]} alt={`Smoke evidence recorded at ${assessment.address || 'the source site'}`} />
                            : <div className="smoke-evidence-missing">{evidenceErrors[assessment.id] || 'No viewable evidence photo'}</div>}
                          <small>Private evidence · link expires in 15 minutes</small>
                        </section>

                        <div className="smoke-review-content">
                          <dl className="smoke-facts">
                            <div><dt>Officer source</dt><dd>{assessment.smoke_source_type?.replaceAll('_', ' ') || 'Not recorded'}{assessment.source_confirmed ? ' · confirmed on site' : ' · not confirmed'}</dd></div>
                            <div><dt>Custody</dt><dd>{assessment.evidence_state.replaceAll('_', ' ')}</dd></div>
                            <div><dt>Workflow</dt><dd>{assessment.review_state.replaceAll('_', ' ')}</dd></div>
                            <div><dt>Action</dt><dd>{assessment.action_taken?.replaceAll('_', ' ') || 'No action'}{assessment.notice_number ? ` · ${assessment.notice_number}` : ''}</dd></div>
                          </dl>
                          {assessment.scene_description && <p className="assessment-notes"><strong>Scene:</strong> {assessment.scene_description}</p>}
                          {assessment.notes && <p className="assessment-notes"><strong>Officer notes:</strong> {assessment.notes}</p>}

                          <section className="smoke-classifier-panel" aria-label="Bob smoke photo classification">
                            <div className="smoke-panel-heading">
                              <strong>Bob visible-image candidate</strong>
                              <span className="status-badge">
                                {assessment.smoke_ai_review?.action
                                  ? `human ${assessment.smoke_ai_review.action}`
                                  : 'human review required'}
                              </span>
                            </div>
                            {assessment.smoke_ai_analysis?.status === 'available' ? (
                              <>
                                <dl className="smoke-facts">
                                  <div><dt>Visible source</dt><dd>{assessment.smoke_ai_analysis.details?.smoke_source || assessment.smoke_ai_analysis.classification || 'Not identified'}</dd></div>
                                  <div><dt>Visual severity</dt><dd>{assessment.smoke_ai_analysis.details?.severity || 'Not identified'}</dd></div>
                                  <div><dt>Visibility</dt><dd>{assessment.smoke_ai_analysis.details?.visibility_impact || 'Not described'}</dd></div>
                                  <div><dt>Confidence</dt><dd>{typeof assessment.smoke_ai_analysis.confidence === 'number' ? `${Math.round(assessment.smoke_ai_analysis.confidence * 100)}% machine confidence` : 'Not supplied'}</dd></div>
                                </dl>
                                <p>{assessment.smoke_ai_analysis.reasoning || 'No model reasoning was retained.'}</p>
                                <small>
                                  {assessment.smoke_ai_analysis.classifier || 'bob_vision'} · {assessment.smoke_ai_analysis.provider || 'provider not retained'} · {assessment.smoke_ai_analysis.model || 'model not retained'} · {assessment.smoke_ai_analysis.prompt_version || 'prompt version not retained'}
                                </small>
                              </>
                            ) : (
                              <p>Photo classification is unavailable. The image remains evidence and cannot be treated as a smoke-source or severity decision.</p>
                            )}

                            {classificationReviewId === assessment.id ? (
                              <div className="smoke-review-form">
                                <label>Decision
                                  <select value={classificationAction} onChange={(event) => setClassificationAction(event.target.value as 'confirm' | 'correct' | 'reject')}>
                                    <option value="confirm">Confirm after human review</option>
                                    <option value="correct">Correct machine candidate</option>
                                    <option value="reject">Reject / insufficient visual evidence</option>
                                  </select>
                                </label>
                                {classificationAction !== 'reject' && <>
                                  <label>Canonical smoke source
                                    <select value={classificationSource} onChange={(event) => setClassificationSource(event.target.value)}>
                                      {['domestic_solid_fuel', 'industrial', 'vehicle_exhaust', 'agricultural', 'nuisance_burning', 'unknown'].map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}
                                    </select>
                                  </label>
                                  <label>Canonical severity
                                    <select value={classificationSeverity} onChange={(event) => setClassificationSeverity(event.target.value)}>
                                      {['low', 'moderate', 'high', 'critical'].map((value) => <option key={value} value={value}>{value}</option>)}
                                    </select>
                                  </label>
                                </>}
                                <label>Review notes<textarea rows={3} required value={classificationNotes} onChange={(event) => setClassificationNotes(event.target.value)} /></label>
                                <div className="smoke-button-row">
                                  <button type="button" className="btn btn-primary btn-sm" disabled={savingReview} onClick={() => void saveClassificationReview(assessment)}>{savingReview ? 'Saving...' : 'Save photo review'}</button>
                                  <button type="button" className="btn btn-secondary btn-sm" disabled={savingReview} onClick={() => setClassificationReviewId(null)}>Cancel</button>
                                </div>
                              </div>
                            ) : (
                              <button type="button" className="btn btn-secondary btn-sm" onClick={() => beginClassificationReview(assessment)}>
                                {assessment.smoke_ai_review?.action ? 'Review photo classification again' : 'Review photo classification'}
                              </button>
                            )}
                            {assessment.smoke_ai_review?.action && <small>Latest human decision: {assessment.smoke_ai_review.action} · {assessment.smoke_ai_review.notes}</small>}
                          </section>

                          <section className="smoke-decision-panel" aria-label="Smoke legal action">
                            <div className="smoke-panel-heading"><strong>Legal and operational action</strong><span>Separate from photo inference</span></div>
                            {legalReviewId === assessment.id ? (
                              <div className="smoke-review-form">
                                <label>Action
                                  <select value={legalAction} onChange={(event) => setLegalAction(event.target.value)}>
                                    {['no_action', 'verbal_warning', 'abatement_notice', 'infringement_notice', 'prosecution_referral'].map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}
                                  </select>
                                </label>
                                {legalAction !== 'no_action' && <label>Legal basis<input value={legalBasis} onChange={(event) => setLegalBasis(event.target.value)} /></label>}
                                <label className="form-checkbox"><input type="checkbox" checked={legalFollowUp} onChange={(event) => setLegalFollowUp(event.target.checked)} /> Follow-up required</label>
                                <label>Supervisor decision notes<textarea rows={3} required value={legalNotes} onChange={(event) => setLegalNotes(event.target.value)} /></label>
                                <div className="smoke-button-row">
                                  <button type="button" className="btn btn-primary btn-sm" disabled={savingReview} onClick={() => void saveLegalReview(assessment)}>{savingReview ? 'Saving...' : 'Save action decision'}</button>
                                  <button type="button" className="btn btn-secondary btn-sm" disabled={savingReview} onClick={() => setLegalReviewId(null)}>Cancel</button>
                                </div>
                              </div>
                            ) : (
                              <button type="button" className="btn btn-secondary btn-sm" onClick={() => beginLegalReview(assessment)}>Review legal action</button>
                            )}
                          </section>

                          <section className="smoke-workflow-panel" aria-label="Assessment workflow review">
                            <div className="smoke-panel-heading"><strong>Review workflow</strong><span>{assessment.review_state.replaceAll('_', ' ')}</span></div>
                            {workflowReviewId === assessment.id ? (
                              <div className="smoke-review-form">
                                <label>Workflow notes<textarea rows={3} required value={workflowNotes} onChange={(event) => setWorkflowNotes(event.target.value)} /></label>
                                <div className="smoke-button-row">
                                  <button type="button" className="btn btn-secondary btn-sm" disabled={savingReview} onClick={() => void saveWorkflowReview(assessment, 'triage')}>Triage</button>
                                  <button type="button" className="btn btn-secondary btn-sm" disabled={savingReview} onClick={() => void saveWorkflowReview(assessment, 'require_review')}>Require review</button>
                                  <button type="button" className="btn btn-primary btn-sm" disabled={savingReview} onClick={() => void saveWorkflowReview(assessment, 'close')}>Close workflow</button>
                                  <button type="button" className="btn btn-secondary btn-sm" disabled={savingReview} onClick={() => setWorkflowReviewId(null)}>Cancel</button>
                                </div>
                              </div>
                            ) : (
                              <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setWorkflowReviewId(assessment.id); setWorkflowNotes(assessment.review_notes ?? ''); }}>Review workflow state</button>
                            )}
                          </section>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default SmokeControlPage;
