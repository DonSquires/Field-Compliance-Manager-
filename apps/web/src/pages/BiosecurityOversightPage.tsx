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
}

const BiosecurityOversightPage: React.FC = () => {
  const { profile } = useAuth();
  const { selectedAgreementSites } = useServiceRelationships();
  const [assessments, setAssessments] = useState<BiosecurityAssessment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [reviewNotes, setReviewNotes] = useState('');

  // ATLAS READS: biosecurity_assessments
  useEffect(() => {
    const load = async () => {
      const orgId = profile?.organizationId;
      if (!orgId) {
        setLoading(false);
        return;
      }
      try {
        setLoading(true);
        setError(null);

        let query = supabase
          .from('biosecurity_assessments')
          .select('id, officer_name, species_name, density_estimate, action_taken, status, mpi_referral_number, assessed_at, location_name, protected_land_address, photo_url, evidence_state, review_state, review_notes')
          .eq('organization_id', orgId);
        if (selectedAgreementSites.length > 0) {
          query = query.in('site_id', selectedAgreementSites.map((site) => site.id));
        }
        const { data, error: err } = await query
          .order('assessed_at', { ascending: false })
          .limit(100);

        if (err) throw err;
        setAssessments((data as BiosecurityAssessment[]) || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load biosecurity assessments');
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [profile?.organizationId, selectedAgreementSites]);

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
    setAssessments((current) => current.map((item) => item.id === assessment.id
      ? { ...item, review_state: action === 'close' ? 'closed' : action === 'triage' ? 'triaged' : 'requires_supervisor_review', review_notes: reviewNotes.trim() }
      : item));
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
              <div className="contact-details">
                <p className="contact-meta">
                  {a.officer_name || 'Unknown officer'} · {a.density_estimate} · {a.action_taken} ·{' '}
                  {new Date(a.assessed_at).toLocaleString()}
                </p>
                {a.mpi_referral_number && <p className="contact-meta">MPI referral: {a.mpi_referral_number}</p>}
                <p className="contact-meta">Observed: {a.location_name ?? 'Not recorded'} · Protected land: {a.protected_land_address ?? 'Not recorded'}</p>
                <p className="contact-meta">Evidence: {a.evidence_state} · Review: {a.review_state}</p>
                {a.review_state !== 'closed' && (reviewingId === a.id ? (
                  <div>
                    <textarea aria-label={`Review notes for ${a.species_name ?? 'assessment'}`} value={reviewNotes} onChange={(event) => setReviewNotes(event.target.value)} placeholder="Required review notes" rows={2} />
                    <button type="button" onClick={() => void reviewAssessment(a, 'triage')}>Triage</button>
                    <button type="button" onClick={() => void reviewAssessment(a, 'close')}>Close review</button>
                    <button type="button" onClick={() => { setReviewingId(null); setReviewNotes(''); }}>Cancel</button>
                  </div>
                ) : <button type="button" onClick={() => { setReviewingId(a.id); setReviewNotes(a.review_notes ?? ''); }}>Review assessment</button>)}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default BiosecurityOversightPage;
