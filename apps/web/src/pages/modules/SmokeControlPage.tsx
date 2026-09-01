/**
 * SmokeControlPage.tsx (Officer module: 'smoke_control')
 *
 * Canonical schema: client_sites (site selector) + smoke_assessments
 * (organization_id, site_id, complaint_source, smoke_source_type, severity,
 * action_taken, scene_description, notes, gps_lat/lng, photo_urls,
 * bob_classification, bob_confidence, bob_recommendation, legal_basis,
 * follow_up_required, status), + notices (direction notice on escalation).
 *
 * Rebuilt to match Bob's module_smoke_control / workflow_smoke_control
 * knowledge cards: "officer observes excessive smoke on patrol ->
 * smoke_assessments row (location, description, evidence photo) -> if
 * excessive: notices row (direction, bylaw clause)". The previous version
 * used complaint_source/smoke_source_type values that did not match the
 * CHECK constraints (would have failed on submit), and had no GPS or photo
 * capture at all.
 *
 * Photo + GPS + AI-assisted classification go through
 * submit-smoke-assessment (Storage has no client-writable bucket policy in
 * this app, and the classification call needs a signed URL the client
 * cannot mint itself). The classification is ADVISORY ONLY -- action_taken
 * remains the officer's own call against the applicable bylaw standard, per
 * the module card ("Manual detail is lighter here -- consult the module
 * config/manual for the assessment standard before acting").
 */

import React, { useState, useEffect, useRef } from 'react';
import { Camera, CheckCircle2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useServiceRelationships, type ServiceLocationSite } from '../../context/ServiceRelationshipContext';
import { getCurrentPosition, imageFileToBase64 } from '../../lib/officerScan';
import { supabase } from '../../lib/supabase';
import '../PageStyles.css';

interface SmokeAssessment {
  id: string;
  site_id: string | null;
  organization_id: string;
  complaint_source: string | null;
  smoke_source_type: string | null;
  severity: string | null;
  status: string;
  action_taken: string | null;
  scene_description: string | null;
  notes: string | null;
  address: string | null;
  legal_basis: string | null;
  follow_up_required: boolean;
  bob_classification: string | null;
  bob_confidence: number | null;
  bob_recommendation: string | null;
  photo_urls: string[] | null;
  assessed_at: string;
}

interface AssessmentForm {
  complaint_source: string;
  smoke_source_type: string;
  severity: string;
  action_taken: string;
  scene_description: string;
  notes: string;
  follow_up_required: boolean;
  is_out_of_hours: boolean;
}

interface GpsState {
  status: 'idle' | 'locating' | 'captured' | 'unavailable';
  lat: number | null;
  lng: number | null;
}

const EMPTY_FORM: AssessmentForm = {
  complaint_source: 'neighbour',
  smoke_source_type: 'unknown',
  severity: 'moderate',
  action_taken: 'no_action',
  scene_description: '',
  notes: '',
  follow_up_required: false,
  is_out_of_hours: false,
};

const ACTION_LABELS: Record<string, string> = {
  no_action: 'No action',
  verbal_warning: 'Verbal warning',
  abatement_notice: 'Abatement notice (direction)',
  infringement_notice: 'Infringement notice',
  prosecution_referral: 'Prosecution referral',
};

const SmokeControlPage: React.FC = () => {
  const { profile } = useAuth();
  const { selectedAgreementSites, selectedSite, selectSite, loading: relationshipLoading } = useServiceRelationships();
  const [assessments, setAssessments] = useState<SmokeAssessment[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState<AssessmentForm>(EMPTY_FORM);
  const [gps, setGps] = useState<GpsState>({ status: 'idle', lat: null, lng: null });
  const [imageBase64, setImageBase64] = useState<string>();
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string>();
  const [preparingImage, setPreparingImage] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => () => {
    if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
  }, [imagePreviewUrl]);

  const loadAssessments = async (siteId: string) => {
    try {
      // ATLAS READS: smoke_assessments (filtered by site)
      const { data, error: err } = await supabase
        .from('smoke_assessments')
        .select(
          'id, site_id, organization_id, complaint_source, smoke_source_type, severity, status, action_taken, scene_description, notes, address, legal_basis, follow_up_required, bob_classification, bob_confidence, bob_recommendation, photo_urls, assessed_at'
        )
        .eq('site_id', siteId)
        .order('assessed_at', { ascending: false });

      if (err) throw err;
      setAssessments((data as SmokeAssessment[]) || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load assessments');
    }
  };

  const handleSelectSite = (site: ServiceLocationSite) => {
    selectSite(site.id);
  };

  const acquireGps = async () => {
    setGps({ status: 'locating', lat: null, lng: null });
    try {
      const position = await getCurrentPosition();
      setGps({ status: 'captured', lat: position.coords.latitude, lng: position.coords.longitude });
    } catch {
      setGps({ status: 'unavailable', lat: null, lng: null });
    }
  };

  const clearCapture = () => {
    if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    setImagePreviewUrl(undefined);
    setImageBase64(undefined);
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setPreparingImage(true);
    try {
      if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
      setImagePreviewUrl(URL.createObjectURL(file));
      setImageBase64(await imageFileToBase64(file));
    } catch (err) {
      setImagePreviewUrl(undefined);
      setImageBase64(undefined);
      setError(err instanceof Error ? err.message : 'The image could not be prepared.');
    } finally {
      setPreparingImage(false);
    }
  };

  const handleSubmitAssessment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSite || !profile?.organizationId || submitting) return;

    setSubmitting(true);
    setError(null);
    setReceipt(null);
    try {
      // ATLAS WRITES: smoke_assessments, notices (via submit-smoke-assessment)
      const { data, error: fnError } = await supabase.functions.invoke('submit-smoke-assessment', {
        body: {
          site_id: selectedSite.id,
          complaint_source: formData.complaint_source,
          smoke_source_type: formData.smoke_source_type,
          severity: formData.severity,
          action_taken: formData.action_taken,
          scene_description: formData.scene_description || null,
          notes: formData.notes || null,
          follow_up_required: formData.follow_up_required,
          is_out_of_hours: formData.is_out_of_hours,
          gps_lat: gps.lat,
          gps_lng: gps.lng,
          image_base64: imageBase64,
        },
      });

      if (fnError) throw fnError;
      const result = data as { success: boolean; error?: string; data?: { assessment: SmokeAssessment; notice: { id: string } | null } };
      if (!result.success || !result.data) throw new Error(result.error ?? 'Assessment was not confirmed');

      setAssessments([result.data.assessment, ...assessments]);
      setReceipt(result.data.notice ? 'Assessment recorded and a direction notice was created.' : 'Assessment recorded.');
      setFormData(EMPTY_FORM);
      setGps({ status: 'idle', lat: null, lng: null });
      clearCapture();
      setShowForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit assessment');
    } finally {
      setSubmitting(false);
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
      {receipt && <div className="alert alert-success">{receipt}</div>}

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
                <div className="form-group">
                  <label>Complaint Source</label>
                  <select value={formData.complaint_source} onChange={(e) => setFormData({ ...formData, complaint_source: e.target.value })}>
                    <option value="neighbour">Neighbour complaint</option>
                    <option value="council_hotline">Council hotline</option>
                    <option value="self_report">Patrol self-report</option>
                    <option value="other">Other</option>
                  </select>
                </div>

                <div className="form-group">
                  <label>Smoke Source Type</label>
                  <select value={formData.smoke_source_type} onChange={(e) => setFormData({ ...formData, smoke_source_type: e.target.value })}>
                    <option value="domestic_solid_fuel">Domestic solid fuel</option>
                    <option value="industrial">Industrial</option>
                    <option value="vehicle_exhaust">Vehicle exhaust</option>
                    <option value="agricultural">Agricultural</option>
                    <option value="nuisance_burning">Nuisance burning</option>
                    <option value="unknown">Unknown</option>
                  </select>
                </div>

                <div className="form-group">
                  <label>Severity</label>
                  <select value={formData.severity} onChange={(e) => setFormData({ ...formData, severity: e.target.value })}>
                    <option value="low">Low</option>
                    <option value="moderate">Moderate</option>
                    <option value="high">High</option>
                    <option value="critical">Critical</option>
                  </select>
                </div>

                <div className="form-group">
                  <label>Scene Description</label>
                  <textarea value={formData.scene_description} onChange={(e) => setFormData({ ...formData, scene_description: e.target.value })} rows={3} />
                </div>

                <div className="form-group">
                  <label>Photo evidence</label>
                  <input ref={fileInputRef} className="sr-only" type="file" accept="image/*" capture="environment" onChange={handleFileChange} />
                  {imagePreviewUrl ? (
                    <div className="fc-photo-preview">
                      <img src={imagePreviewUrl} alt="Smoke evidence preview" />
                      <span className="fc-photo-label">
                        <CheckCircle2 size={15} aria-hidden="true" /> Evidence captured
                      </span>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={clearCapture}>
                        Remove photo
                      </button>
                    </div>
                  ) : (
                    <button type="button" className="fc-camera-target" onClick={() => fileInputRef.current?.click()} disabled={preparingImage}>
                      <span className="fc-camera-icon">
                        <Camera size={24} strokeWidth={1.7} aria-hidden="true" />
                      </span>
                      <strong>{preparingImage ? 'Preparing image' : 'Capture smoke evidence'}</strong>
                    </button>
                  )}
                  <p className="contact-meta">Uploaded photos get an AI-assisted opacity/source estimate -- advisory only; you make the final call.</p>
                </div>

                <div className={`officer-report-gps state-${gps.status}`}>
                  <strong>
                    {gps.status === 'captured' ? 'GPS captured' : gps.status === 'locating' ? 'Locating' : gps.status === 'unavailable' ? 'GPS unavailable' : 'Add GPS evidence'}
                  </strong>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => void acquireGps()} disabled={gps.status === 'locating'}>
                    {gps.status === 'captured' ? 'Refresh' : 'Capture'}
                  </button>
                </div>

                <div className="form-group">
                  <label>Action Taken</label>
                  <select value={formData.action_taken} onChange={(e) => setFormData({ ...formData, action_taken: e.target.value })}>
                    {Object.entries(ACTION_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <p className="contact-meta">Abatement notice, infringement notice, or prosecution referral will create a direction notice automatically.</p>
                </div>

                <div className="form-group">
                  <label>
                    <input type="checkbox" checked={formData.follow_up_required} onChange={(e) => setFormData({ ...formData, follow_up_required: e.target.checked })} /> Follow-up required
                  </label>
                </div>
                <div className="form-group">
                  <label>
                    <input type="checkbox" checked={formData.is_out_of_hours} onChange={(e) => setFormData({ ...formData, is_out_of_hours: e.target.checked })} /> Out of hours
                  </label>
                </div>

                <div className="form-group">
                  <label>Notes</label>
                  <textarea value={formData.notes} onChange={(e) => setFormData({ ...formData, notes: e.target.value })} rows={3} />
                </div>

                <button type="submit" className="btn btn-primary btn-block" disabled={submitting || preparingImage}>
                  {submitting ? 'Submitting…' : 'Submit Assessment'}
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
                    <div key={assessment.id} className="assessment-card">
                      <div className="assessment-header">
                        <div>
                          <h4>{new Date(assessment.assessed_at).toLocaleString()}</h4>
                          <span className={`status-badge status-${assessment.status}`}>{assessment.status}</span>
                        </div>
                        {assessment.severity && <span className={`severity-badge severity-${assessment.severity}`}>{assessment.severity}</span>}
                      </div>
                      {assessment.smoke_source_type && <p className="assessment-source">Source: {assessment.smoke_source_type}</p>}
                      {assessment.action_taken && <p className="assessment-source">Action: {ACTION_LABELS[assessment.action_taken] ?? assessment.action_taken}</p>}
                      {assessment.bob_classification && (
                        <p className="contact-meta">
                          AI estimate: {assessment.bob_classification}
                          {assessment.bob_confidence != null && ` (${Math.round(assessment.bob_confidence * 100)}% confidence)`} — advisory only
                        </p>
                      )}
                      {assessment.scene_description && <p className="assessment-notes">{assessment.scene_description}</p>}
                      {assessment.notes && <p className="assessment-notes">{assessment.notes}</p>}
                    </div>
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

