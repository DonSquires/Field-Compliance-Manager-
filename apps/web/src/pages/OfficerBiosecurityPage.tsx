/**
 * OfficerBiosecurityPage.tsx (Officer module: 'biosecurity')
 *
 * Canonical schema: biosecurity_assessments (species_name, density_estimate,
 * action_taken, mpi_referral_number). Officer-scoped: filtered to the
 * signed-in officer's own assessments.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

type DensityEstimate = 'isolated' | 'scattered' | 'moderate' | 'dense' | 'severe' | 'not_found';
type ActionTaken = 'no_action' | 'advisory_notice' | 'notice_of_direction' | 'infringement_notice' | 'mpi_referral';

interface BiosecurityAssessment {
  id: string;
  species_name: string | null;
  density_estimate: DensityEstimate | null;
  action_taken: ActionTaken | null;
  scene_description: string | null;
  status: string;
  assessed_at: string;
}

const OfficerBiosecurityPage: React.FC = () => {
  const { profile } = useAuth();
  const [assessments, setAssessments] = useState<BiosecurityAssessment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    species_name: '',
    density_estimate: 'scattered' as DensityEstimate,
    action_taken: 'no_action' as ActionTaken,
    scene_description: '',
    location_name: '',
    protected_land_address: '',
    notice_number: '',
    mpi_referral_number: '',
    follow_up_required: false,
  });
  const [submitting, setSubmitting] = useState(false);
  const actionNeedsNotice = form.action_taken === 'notice_of_direction' || form.action_taken === 'infringement_notice';
  const actionNeedsReferral = form.action_taken === 'mpi_referral';
  const canSubmit = Boolean(form.location_name.trim())
    && (form.density_estimate === 'not_found' || Boolean(form.species_name.trim()))
    && (!actionNeedsNotice || Boolean(form.notice_number.trim()))
    && (!actionNeedsReferral || Boolean(form.mpi_referral_number.trim()));

  // ATLAS READS: biosecurity_assessments
  const loadAssessments = useCallback(async () => {
    if (!profile?.id) return;
    try {
      setLoading(true);
      setError(null);

      const { data, error: err } = await supabase
        .from('biosecurity_assessments')
        .select('id, species_name, density_estimate, action_taken, scene_description, status, assessed_at')
        .eq('officer_user_id', profile.id)
        .order('assessed_at', { ascending: false });

      if (err) throw err;
      setAssessments((data as BiosecurityAssessment[]) || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load biosecurity assessments');
    } finally {
      setLoading(false);
    }
  }, [profile?.id]);

  useEffect(() => {
    loadAssessments();
  }, [loadAssessments]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile?.id || !profile?.organizationId) return;

    try {
      setSubmitting(true);
      setError(null);
      // ATLAS WRITES: biosecurity_assessments
      const { data, error } = await supabase
        .from('biosecurity_assessments')
        .insert([
          {
            organization_id: profile.organizationId,
            officer_user_id: profile.id,
            species_name: form.species_name || null,
            density_estimate: form.density_estimate,
            action_taken: form.action_taken,
            scene_description: form.scene_description || null,
            location_name: form.location_name || null,
            protected_land_address: form.protected_land_address || null,
            notice_number: form.notice_number || null,
            mpi_referral_number: form.mpi_referral_number || null,
            follow_up_required: form.follow_up_required,
            status: 'open',
          },
        ])
        .select()
        .single();

      if (error) throw error;
      setAssessments([data as BiosecurityAssessment, ...assessments]);
      setForm({ species_name: '', density_estimate: 'scattered', action_taken: 'no_action', scene_description: '', location_name: '', protected_land_address: '', notice_number: '', mpi_referral_number: '', follow_up_required: false });
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
          <p>Loading biosecurity assessments...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Biosecurity</h1>
        <p className="subtitle">{assessments.length} assessments recorded</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}

      <button className="btn btn-primary btn-sm" onClick={() => setShowForm(!showForm)}>
        {showForm ? 'Cancel' : '+ New Assessment'}
      </button>

      {showForm && (
        <form className="assessment-form" onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="biosecurity-species">Species</label>
            <input id="biosecurity-species" type="text" required={form.density_estimate !== 'not_found'} value={form.species_name} onChange={(e) => setForm({ ...form, species_name: e.target.value })} />
          </div>
          <div className="form-group">
            <label htmlFor="biosecurity-location">Observed location</label>
            <input id="biosecurity-location" type="text" required value={form.location_name} onChange={(e) => setForm({ ...form, location_name: e.target.value })} />
          </div>
          <div className="form-group">
            <label htmlFor="biosecurity-protected-land">Protected land address</label>
            <input id="biosecurity-protected-land" type="text" value={form.protected_land_address} onChange={(e) => setForm({ ...form, protected_land_address: e.target.value })} />
            <small className="form-hint">Record this when the threatened land differs from where the risk was observed.</small>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="biosecurity-density">Density</label>
              <select
                id="biosecurity-density"
                value={form.density_estimate}
                onChange={(e) => setForm({ ...form, density_estimate: e.target.value as DensityEstimate })}
              >
                <option value="isolated">Isolated</option>
                <option value="scattered">Scattered</option>
                <option value="moderate">Moderate</option>
                <option value="dense">Dense</option>
                <option value="severe">Severe</option>
                <option value="not_found">Not Found</option>
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="biosecurity-action">Action Taken</label>
              <select
                id="biosecurity-action"
                value={form.action_taken}
                onChange={(e) => setForm({ ...form, action_taken: e.target.value as ActionTaken })}
              >
                <option value="no_action">No Action</option>
                <option value="advisory_notice">Advisory Notice</option>
                <option value="notice_of_direction">Notice of Direction</option>
                <option value="infringement_notice">Infringement Notice</option>
                <option value="mpi_referral">MPI Referral</option>
              </select>
            </div>
          </div>
          {actionNeedsNotice && (
            <div className="form-group">
              <label htmlFor="biosecurity-notice">Notice number</label>
              <input id="biosecurity-notice" type="text" required value={form.notice_number} onChange={(e) => setForm({ ...form, notice_number: e.target.value })} />
            </div>
          )}
          {actionNeedsReferral && (
            <div className="form-group">
              <label htmlFor="biosecurity-referral">MPI referral number</label>
              <input id="biosecurity-referral" type="text" required value={form.mpi_referral_number} onChange={(e) => setForm({ ...form, mpi_referral_number: e.target.value })} />
            </div>
          )}
          <div className="form-group">
            <label htmlFor="biosecurity-scene">Scene Description</label>
            <textarea id="biosecurity-scene" rows={3} value={form.scene_description} onChange={(e) => setForm({ ...form, scene_description: e.target.value })} />
          </div>
          <label className="form-checkbox"><input type="checkbox" checked={form.follow_up_required} onChange={(e) => setForm({ ...form, follow_up_required: e.target.checked })} /> Follow-up required</label>
          <button type="submit" className="btn btn-primary btn-block" disabled={submitting || !canSubmit}>
            {submitting ? 'Saving assessment' : 'Submit Assessment'}
          </button>
        </form>
      )}

      <div className="contacts-list" style={{ marginTop: '12px' }}>
        {assessments.length === 0 && !error ? (
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
                {a.scene_description && <p>{a.scene_description}</p>}
                <p className="contact-meta">
                  {a.density_estimate} · {a.action_taken} · {new Date(a.assessed_at).toLocaleString()}
                </p>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default OfficerBiosecurityPage;
