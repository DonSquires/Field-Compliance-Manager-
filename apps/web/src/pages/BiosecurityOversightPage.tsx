/**
 * BiosecurityOversightPage.tsx (Admin field-ops sub-area: 'biosecurity')
 *
 * Canonical schema: biosecurity_assessments, org-wide oversight — distinct
 * from OfficerBiosecurityPage which is the officer's own submission view.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

interface BiosecurityAssessment {
  id: string;
  officer_name: string | null;
  species_name: string | null;
  density_estimate: string | null;
  action_taken: string | null;
  status: string;
  mpi_referral_number: string | null;
  assessed_at: string;
  location_name: string | null;
  protected_land_address: string | null;
  photo_url: string | null;
  evidence_state: string;
  review_state: string;
  review_notes: string | null;
  species_review_decision: string;
  bob_species_confirmed: boolean;
  biosecurity_ai_analysis: {
    status?: string;
    classification?: string | null;
    confidence?: number | null;
    details?: {
      species_name?: string | null;
      density?: string | null;
      threat_level?: string | null;
    };
    reasoning?: string | null;
    classifier?: string | null;
    provider?: string | null;
    model?: string | null;
    prompt_version?: string | null;
  };
  biosecurity_ai_review: {
    action?: string;
    notes?: string;
    reviewed_at?: string;
  };
}

const BiosecurityOversightPage: React.FC = () => {
  const { profile } = useAuth();
  const { selectedAgreementSites } = useServiceRelationships();
  const [assessments, setAssessments] = useState<BiosecurityAssessment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [reviewNotes, setReviewNotes] = useState('');
  const [evidenceUrls, setEvidenceUrls] = useState<Record<string, string>>({});
  const [classificationReviewId, setClassificationReviewId] = useState<string | null>(null);
  const [classificationAction, setClassificationAction] = useState<'confirm' | 'correct' | 'reject'>('confirm');
  const [correctedSpecies, setCorrectedSpecies] = useState('');
  const [correctedDensity, setCorrectedDensity] = useState('');
  const [classificationNotes, setClassificationNotes] = useState('');
  const [savingClassification, setSavingClassification] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // ATLAS READS: biosecurity_assessments
  const load = useCallback(async () => {
    const orgId = profile?.organizationId;
    if (!orgId) {
      setAssessments([]);
      setEvidenceUrls({});
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      setError(null);

      let query = supabase
        .from('biosecurity_assessments')
        .select('id, officer_name, species_name, density_estimate, action_taken, status, mpi_referral_number, assessed_at, location_name, protected_land_address, photo_url, evidence_state, review_state, review_notes, species_review_decision, bob_species_confirmed, biosecurity_ai_analysis, biosecurity_ai_review')
        .eq('organization_id', orgId);
      if (selectedAgreementSites.length > 0) {
        query = query.in('site_id', selectedAgreementSites.map((site) => site.id));
      }
      const { data, error: err } = await query
        .order('assessed_at', { ascending: false })
        .limit(100);

      if (err) throw err;
      const rows = (data as BiosecurityAssessment[]) || [];
      const signedEntries = await Promise.all(rows.filter((row) => row.photo_url).map(async (row) => {
        const { data: signed, error: signError } = await supabase.storage.from('scans').createSignedUrl(row.photo_url as string, 15 * 60);
        if (signError || !signed?.signedUrl) {
          throw new Error(signError?.message || `Evidence could not be signed for assessment ${row.id}`);
        }
        return [row.id, signed.signedUrl] as const;
      }));
      setAssessments(rows);
      setEvidenceUrls(Object.fromEntries(signedEntries));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load biosecurity assessments');
    } finally {
      setLoading(false);
    }
  }, [profile?.organizationId, selectedAgreementSites]);

  useEffect(() => {
    void load();
  }, [load]);

  const beginClassificationReview = (assessment: BiosecurityAssessment) => {
    setClassificationReviewId(assessment.id);
    setClassificationAction('confirm');
    setCorrectedSpecies(assessment.biosecurity_ai_analysis?.details?.species_name ?? assessment.species_name ?? '');
    setCorrectedDensity(assessment.biosecurity_ai_analysis?.details?.density ?? assessment.density_estimate ?? '');
    setClassificationNotes('');
    setNotice(null);
  };

  const reviewClassification = async (assessment: BiosecurityAssessment) => {
    if (!classificationNotes.trim()) {
      setError('Classification review notes are required.');
      return;
    }
    if (classificationAction === 'correct' && !correctedSpecies.trim() && !correctedDensity) {
      setError('Enter a corrected species or density value.');
      return;
    }
    try {
      setSavingClassification(true);
      setError(null);
      const { error: reviewError } = await supabase.rpc('review_biosecurity_photo_classification', {
        p_assessment_id: assessment.id,
        p_action: classificationAction,
        p_species_name: classificationAction === 'correct' ? correctedSpecies.trim() || null : null,
        p_density_estimate: classificationAction === 'correct' ? correctedDensity || null : null,
        p_notes: classificationNotes.trim(),
      });
      if (reviewError) throw reviewError;
      setClassificationReviewId(null);
      setNotice(`Photo classification ${classificationAction === 'reject' ? 'rejected' : 'recorded as human approved'}.`);
      await load();
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : 'Classification review could not be saved.');
    } finally {
      setSavingClassification(false);
    }
  };

  const reviewAssessment = async (assessment: BiosecurityAssessment, action: 'triage' | 'require_review' | 'close') => {
    if (!reviewNotes.trim()) {
      setError('Review notes are required before changing the assessment state.');
      return;
    }
    setError(null);
    const { error: reviewError } = await supabase.rpc('manage_biosecurity_assessment_review', {
      p_assessment_id: assessment.id,
      p_expected_review_state: assessment.review_state,
      p_action: action,
      p_notes: reviewNotes.trim(),
    });
    if (reviewError) {
      setError(reviewError.message);
      return;
    }
    setReviewingId(null);
    setReviewNotes('');
    setNotice('Assessment workflow review saved.');
    await load();
  };

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading biosecurity assessments...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Biosecurity</h1>
        <p className="subtitle">{assessments.length} assessments across the organisation</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}
      {notice && <div className="alert alert-success" role="status">{notice}</div>}

      <div className="contacts-list">
        {assessments.length === 0 ? (
          <div className="empty-state">
            <p>No assessments recorded yet.</p>
          </div>
        ) : (
          assessments.map((a) => (
            <div key={a.id} className="contact-card">
              <div className="contact-header">
                <h3>{a.species_name || 'Unidentified species'}</h3>
                <span className={`status-badge status-${a.status}`}>{a.status}</span>
              </div>
              <div className="biosecurity-review-layout">
                <section className="biosecurity-evidence-panel" aria-label="Photo evidence">
                  {evidenceUrls[a.id]
                    ? <img src={evidenceUrls[a.id]} alt={`Biosecurity evidence recorded by ${a.officer_name || 'the reporting officer'}`} />
                    : <div className="biosecurity-evidence-missing">No viewable photo evidence</div>}
                  <small>Private evidence · link expires in 15 minutes</small>
                </section>
                <div className="contact-details">
                  <p className="contact-meta">
                    {a.officer_name || 'Unknown officer'} · {a.density_estimate || 'density not recorded'} · {a.action_taken || 'no action recorded'} ·{' '}
                    {new Date(a.assessed_at).toLocaleString()}
                  </p>
                  {a.mpi_referral_number && <p className="contact-meta">MPI referral: {a.mpi_referral_number}</p>}
                  <p className="contact-meta"><strong>Observed:</strong> {a.location_name ?? 'Not recorded'} · <strong>Protected land:</strong> {a.protected_land_address ?? 'Not recorded'}</p>
                  <p className="contact-meta"><strong>Custody:</strong> {a.evidence_state} · <strong>Workflow:</strong> {a.review_state}</p>

                  <section className="biosecurity-classifier-panel" aria-label="Bob photo classification">
                    <div className="biosecurity-panel-heading">
                      <strong>Bob photo candidate</strong>
                      <span className={`status-badge status-${a.species_review_decision}`}>{a.species_review_decision.replaceAll('_', ' ')}</span>
                    </div>
                    {a.biosecurity_ai_analysis?.status === 'available' ? (
                      <>
                        <dl>
                          <div><dt>Species</dt><dd>{a.biosecurity_ai_analysis.details?.species_name || 'Not identified'}</dd></div>
                          <div><dt>Density</dt><dd>{a.biosecurity_ai_analysis.details?.density || 'Not identified'}</dd></div>
                          <div><dt>Threat</dt><dd>{a.biosecurity_ai_analysis.details?.threat_level || 'Not identified'}</dd></div>
                          <div><dt>Confidence</dt><dd>{typeof a.biosecurity_ai_analysis.confidence === 'number' ? `${Math.round(a.biosecurity_ai_analysis.confidence * 100)}% machine confidence` : 'Not supplied'}</dd></div>
                        </dl>
                        <p>{a.biosecurity_ai_analysis.reasoning || 'No model reasoning was retained.'}</p>
                        <small>
                          {a.biosecurity_ai_analysis.classifier || 'bob_vision'} · {a.biosecurity_ai_analysis.provider || 'provider not retained'} · {a.biosecurity_ai_analysis.model || 'model not retained'} · {a.biosecurity_ai_analysis.prompt_version || 'prompt version not retained'}
                        </small>
                      </>
                    ) : <p>Classification was unavailable. The photo remains evidence for human review.</p>}

                    {classificationReviewId === a.id ? (
                      <div className="biosecurity-review-form">
                        <label>Decision
                          <select value={classificationAction} onChange={(event) => setClassificationAction(event.target.value as 'confirm' | 'correct' | 'reject')}>
                            <option value="confirm">Confirm machine candidate</option>
                            <option value="correct">Correct candidate</option>
                            <option value="reject">Reject / insufficient evidence</option>
                          </select>
                        </label>
                        {classificationAction === 'correct' && <>
                          <label>Correct species<input value={correctedSpecies} onChange={(event) => setCorrectedSpecies(event.target.value)} /></label>
                          <label>Correct density
                            <select value={correctedDensity} onChange={(event) => setCorrectedDensity(event.target.value)}>
                              <option value="">Keep existing density</option>
                              {['isolated', 'scattered', 'moderate', 'dense', 'severe', 'not_found'].map((density) => <option key={density} value={density}>{density.replaceAll('_', ' ')}</option>)}
                            </select>
                          </label>
                        </>}
                        <label>Review notes<textarea value={classificationNotes} onChange={(event) => setClassificationNotes(event.target.value)} rows={3} required /></label>
                        <div className="biosecurity-button-row">
                          <button type="button" disabled={savingClassification} onClick={() => void reviewClassification(a)}>{savingClassification ? 'Saving...' : 'Save classification review'}</button>
                          <button type="button" disabled={savingClassification} onClick={() => setClassificationReviewId(null)}>Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <button type="button" onClick={() => beginClassificationReview(a)}>
                        {a.biosecurity_ai_review?.action ? 'Review classification again' : 'Review photo classification'}
                      </button>
                    )}
                    {a.biosecurity_ai_review?.action && <small>Latest human decision: {a.biosecurity_ai_review.action} · {a.biosecurity_ai_review.notes}</small>}
                  </section>

                  <section className="biosecurity-workflow-panel" aria-label="Assessment workflow review">
                    <strong>Operational workflow</strong>
                    {a.review_state !== 'closed' && (reviewingId === a.id ? (
                      <div className="biosecurity-review-form">
                        <label>Workflow notes<textarea aria-label={`Review notes for ${a.species_name ?? 'assessment'}`} value={reviewNotes} onChange={(event) => setReviewNotes(event.target.value)} placeholder="Required workflow notes" rows={2} /></label>
                        <div className="biosecurity-button-row">
                          <button type="button" onClick={() => void reviewAssessment(a, 'triage')}>Triage</button>
                          <button type="button" onClick={() => void reviewAssessment(a, 'close')}>Close review</button>
                          <button type="button" onClick={() => { setReviewingId(null); setReviewNotes(''); }}>Cancel</button>
                        </div>
                      </div>
                    ) : a.review_state === 'closed'
                      ? <p>Workflow closed. Classification evidence remains independently reviewable.</p>
                      : <button type="button" onClick={() => { setReviewingId(a.id); setReviewNotes(a.review_notes ?? ''); }}>Review assessment workflow</button>)}
                  </section>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default BiosecurityOversightPage;
