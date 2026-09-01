/**
 * OfficerNoiseControlPage.tsx (Officer module: 'noise_control')
 *
 * Canonical schema: noise_assessments (decibel_reading, noise_source,
 * prior_notice_count, action_taken, scene_description). Officer-scoped:
 * filtered to the signed-in officer's own assessments.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

interface NoiseAssessment {
  id: string;
  decibel_reading: number | null;
  noise_source: string | null;
  prior_notice_count: number;
  action_taken: string | null;
  scene_description: string | null;
  assessed_at: string;
  review_status: string;
  reviewed_at: string | null;
  review_notes: string | null;
  follow_up_required: boolean;
}

const OfficerNoiseControlPage: React.FC = () => {
  const location=useLocation();
  const requestedAssessmentId=new URLSearchParams(location.search).get('assessment');
  const { profile } = useAuth();
  const [assessments, setAssessments] = useState<NoiseAssessment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ decibel_reading: '', noise_source: '', scene_description: '', action_taken: '' });

  // ATLAS READS: noise_assessments
  const loadAssessments = useCallback(async () => {
    if (!profile?.id) return;
    try {
      setLoading(true);
      setError(null);

      const { data, error: err } = await supabase
        .from('noise_assessments')
        .select('id, decibel_reading, noise_source, prior_notice_count, action_taken, scene_description, assessed_at, review_status, reviewed_at, review_notes, follow_up_required')
        .eq('officer_user_id', profile.id)
        .order('assessed_at', { ascending: false });

      if (err) throw err;
      setAssessments((data as NoiseAssessment[]) || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load noise assessments');
    } finally {
      setLoading(false);
    }
  }, [profile?.id]);

  useEffect(() => {
    loadAssessments();
  }, [loadAssessments]);
  useEffect(()=>{if(requestedAssessmentId)document.getElementById(`officer-noise-${requestedAssessmentId}`)?.scrollIntoView({block:'center'});},[assessments,requestedAssessmentId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile?.id || !profile?.organizationId) return;

    try {
      // ATLAS WRITES: noise_assessments
      const { data, error } = await supabase
        .from('noise_assessments')
        .insert([
          {
            organization_id: profile.organizationId,
            officer_user_id: profile.id,
            decibel_reading: form.decibel_reading ? parseFloat(form.decibel_reading) : null,
            noise_source: form.noise_source || null,
            scene_description: form.scene_description || null,
            action_taken: form.action_taken || null,
          },
        ])
        .select()
        .single();

      if (error) throw error;
      setAssessments([data as NoiseAssessment, ...assessments]);
      setForm({ decibel_reading: '', noise_source: '', scene_description: '', action_taken: '' });
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
          <p>Loading noise assessments...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Noise Control</h1>
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
          <div className="form-row">
            <div className="form-group">
              <label>Decibel Reading</label>
              <input
                type="number"
                step="0.1"
                value={form.decibel_reading}
                onChange={(e) => setForm({ ...form, decibel_reading: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label>Noise Source</label>
              <input type="text" value={form.noise_source} onChange={(e) => setForm({ ...form, noise_source: e.target.value })} />
            </div>
          </div>
          <div className="form-group">
            <label>Scene Description</label>
            <textarea rows={3} value={form.scene_description} onChange={(e) => setForm({ ...form, scene_description: e.target.value })} />
          </div>
          <div className="form-group">
            <label>Action Taken</label>
            <input type="text" value={form.action_taken} onChange={(e) => setForm({ ...form, action_taken: e.target.value })} />
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
            <div key={a.id} id={`officer-noise-${a.id}`} className={`contact-card ${a.id===requestedAssessmentId?'is-context-focus':''}`}>
              <div className="contact-header">
                <h3>{a.noise_source || 'Noise complaint'}</h3>
                {a.decibel_reading != null && <span className="badge">{a.decibel_reading} dB</span>}
              </div>
              <div className="contact-details">
                {a.scene_description && <p>{a.scene_description}</p>}
                <p className="contact-meta">
                  {a.prior_notice_count} prior notice(s) · {new Date(a.assessed_at).toLocaleString()}
                </p>
                {a.action_taken && <p className="contact-meta">Action: {a.action_taken}</p>}
                {a.review_status!=='open'&&<section className="noise-officer-review"><strong>Supervisor review · {a.review_status.replaceAll('_',' ')}</strong><span>{a.review_notes??'Review note unavailable'}</span><small>{a.follow_up_required?'Follow-up required':'No further follow-up'}{a.reviewed_at?` · ${new Date(a.reviewed_at).toLocaleString('en-NZ')}`:''}</small></section>}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default OfficerNoiseControlPage;
