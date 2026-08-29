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
  });

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
            status: 'open',
          },
        ])
        .select()
        .single();

      if (error) throw error;
      setAssessments([data as BiosecurityAssessment, ...assessments]);
      setForm({ species_name: '', density_estimate: 'scattered', action_taken: 'no_action', scene_description: '' });
      setShowForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit assessment');
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
            <label>Species</label>
            <input type="text" value={form.species_name} onChange={(e) => setForm({ ...form, species_name: e.target.value })} />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Density</label>
              <select
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
              <label>Action Taken</label>
              <select
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
          <div className="form-group">
            <label>Scene Description</label>
            <textarea rows={3} value={form.scene_description} onChange={(e) => setForm({ ...form, scene_description: e.target.value })} />
          </div>
          <button type="submit" className="btn btn-primary btn-block">
            Submit Assessment
          </button>
        </form>
      )}

      <div className="contacts-list" style={{ marginTop: '12px' }}>
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
