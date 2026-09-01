/**
 * FaceObservationReviewPage.tsx (Admin field-ops sub-area: 'face-review')
 *
 * Canonical schema: face_observations, person_records -- the face/ID
 * inference review pipeline (distinct from PersonSearchPage's
 * persons/entity_flags people-of-interest flags). Both tables are
 * SELECT-only under RLS; review decisions go through the
 * review_face_observation / review_person_record RPCs (org-admin only,
 * audited), added because there was previously no way to act on a
 * manual_review_required record at all.
 *
 * DEFERRED: no face/ID recognition vendor is integrated, so this page will
 * show nothing until a future inference pipeline populates
 * face_observations -- this only builds the human-review/audit gate the
 * schema already requires ("Consequential use requires human review and
 * audit"). person_identity_documents review is also deferred.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

interface FaceObservation {
  id: string;
  confidence: number | null;
  purpose: string;
  review_state: string;
  created_at: string;
}

interface PersonRecord {
  id: string;
  display_name: string | null;
  review_state: string;
  created_at: string;
}

const FaceObservationReviewPage: React.FC = () => {
  const { profile } = useAuth();
  const [observations, setObservations] = useState<FaceObservation[]>([]);
  const [pendingPersons, setPendingPersons] = useState<PersonRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [linkInputs, setLinkInputs] = useState<Record<string, string>>({});

  // ATLAS READS: face_observations, person_records
  const load = useCallback(async () => {
    const orgId = profile?.organizationId;
    if (!orgId) return;
    setLoading(true);
    setError(null);
    const [obsResponse, personResponse] = await Promise.all([
      supabase
        .from('face_observations')
        .select('id, confidence, purpose, review_state, created_at')
        .eq('organization_id', orgId)
        .eq('review_state', 'manual_review_required')
        .order('created_at', { ascending: false })
        .limit(50),
      supabase
        .from('person_records')
        .select('id, display_name, review_state, created_at')
        .eq('organization_id', orgId)
        .in('review_state', ['draft', 'manual_review_required'])
        .order('created_at', { ascending: false })
        .limit(50),
    ]);
    setObservations((obsResponse.data as FaceObservation[]) ?? []);
    setPendingPersons((personResponse.data as PersonRecord[]) ?? []);
    const failures = [obsResponse.error?.message, personResponse.error?.message].filter(Boolean);
    if (failures.length) setError(failures.join(' · '));
    setLoading(false);
  }, [profile?.organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  // ATLAS WRITES: face_observations, person_records (via review_face_observation / review_person_record)
  const handleReviewObservation = async (observationId: string, decision: 'verified' | 'rejected') => {
    setBusyId(observationId);
    setError(null);
    const linkName = linkInputs[observationId]?.trim();
    const { error: err } = await supabase.rpc('review_face_observation', {
      p_observation_id: observationId,
      p_decision: decision,
      p_new_person_display_name: decision === 'verified' ? linkName || null : null,
    });
    if (err) setError(err.message);
    else setObservations(observations.filter((o) => o.id !== observationId));
    setBusyId(null);
  };

  const handleReviewPerson = async (personId: string, decision: 'verified' | 'rejected') => {
    setBusyId(personId);
    setError(null);
    const { error: err } = await supabase.rpc('review_person_record', { p_person_record_id: personId, p_decision: decision });
    if (err) setError(err.message);
    else setPendingPersons(pendingPersons.filter((p) => p.id !== personId));
    setBusyId(null);
  };

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading review queue...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Face &amp; Person Record Review</h1>
        <p className="subtitle">{observations.length} face observation(s) · {pendingPersons.length} person record(s) awaiting review</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}

      <h2>Face observations</h2>
      <div className="contacts-list">
        {observations.length === 0 ? (
          <div className="empty-state">
            <p>No face observations awaiting review.</p>
          </div>
        ) : (
          observations.map((obs) => (
            <div key={obs.id} className="contact-card">
              <div className="contact-header">
                <h3>{obs.purpose}</h3>
                {obs.confidence != null && <span className="badge">{Math.round(obs.confidence * 100)}%</span>}
              </div>
              <div className="contact-details">
                <p className="contact-meta">Captured {new Date(obs.created_at).toLocaleString()}</p>
                <div className="form-group">
                  <label>Link to person (new display name, or leave blank to reject only)</label>
                  <input
                    value={linkInputs[obs.id] ?? ''}
                    onChange={(e) => setLinkInputs({ ...linkInputs, [obs.id]: e.target.value })}
                    placeholder="Person display name"
                  />
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button type="button" className="btn btn-primary" disabled={busyId === obs.id} onClick={() => handleReviewObservation(obs.id, 'verified')}>
                    Verify
                  </button>
                  <button type="button" className="btn btn-secondary" disabled={busyId === obs.id} onClick={() => handleReviewObservation(obs.id, 'rejected')}>
                    Reject
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      <h2 style={{ marginTop: '24px' }}>Person records</h2>
      <div className="contacts-list">
        {pendingPersons.length === 0 ? (
          <div className="empty-state">
            <p>No person records awaiting review.</p>
          </div>
        ) : (
          pendingPersons.map((person) => (
            <div key={person.id} className="contact-card">
              <div className="contact-header">
                <h3>{person.display_name || 'Unnamed record'}</h3>
                <span className="badge">{person.review_state}</span>
              </div>
              <div className="contact-details">
                <p className="contact-meta">Created {new Date(person.created_at).toLocaleString()}</p>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button type="button" className="btn btn-primary" disabled={busyId === person.id} onClick={() => handleReviewPerson(person.id, 'verified')}>
                    Verify
                  </button>
                  <button type="button" className="btn btn-secondary" disabled={busyId === person.id} onClick={() => handleReviewPerson(person.id, 'rejected')}>
                    Reject
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default FaceObservationReviewPage;
