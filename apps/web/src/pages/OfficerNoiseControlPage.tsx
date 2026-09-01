/**
 * OfficerNoiseControlPage.tsx (Officer module: 'noise_control')
 *
 * Canonical schema: noise_assessments (volume_score, time_score, tone_score,
 * matrix_total, action_taken, decibel_reading, noise_source,
 * scene_description). Officer-scoped: filtered to the signed-in officer's
 * own assessments.
 *
 * TDC matrix scoring (Phase D) determines action_taken by rule — the officer
 * never selects an action directly. Escalation beyond a verbal warning
 * (abatement notice, seizure) requires repeat-visit detection anchored to the
 * noise source address, which is a separate, not-yet-built phase; this page
 * only computes the first-tier no_action / verbal_warning outcome.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import {
  computeNoiseMatrix,
  deriveTimeScoreFromHour,
  VOLUME_SCORE_LABELS,
  TIME_SCORE_LABELS,
  TONE_SCORE_LABELS,
} from '../lib/noiseMatrixSchema';
import './PageStyles.css';

interface NoiseAssessment {
  id: string;
  decibel_reading: number | null;
  noise_source: string | null;
  prior_notice_count: number;
  action_taken: string | null;
  scene_description: string | null;
  volume_score: number | null;
  time_score: number | null;
  tone_score: number | null;
  matrix_total: number | null;
  assessed_at: string;
}

const OfficerNoiseControlPage: React.FC = () => {
  const { profile } = useAuth();
  const [assessments, setAssessments] = useState<NoiseAssessment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    decibel_reading: '',
    noise_source: '',
    scene_description: '',
    volume_score: 0,
    time_score: deriveTimeScoreFromHour(new Date().getHours()),
    tone_score: 0,
  });

  // ATLAS READS: noise_assessments
  const loadAssessments = useCallback(async () => {
    if (!profile?.id) return;
    try {
      setLoading(true);
      setError(null);

      const { data, error: err } = await supabase
        .from('noise_assessments')
        .select('id, decibel_reading, noise_source, prior_notice_count, action_taken, scene_description, volume_score, time_score, tone_score, matrix_total, assessed_at')
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

  const matrix = computeNoiseMatrix({
    volumeScore: form.volume_score,
    timeScore: form.time_score,
    toneScore: form.tone_score,
  });

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
            volume_score: form.volume_score,
            time_score: form.volume_score === 0 ? null : form.time_score,
            tone_score: form.volume_score === 0 ? null : form.tone_score,
            matrix_total: matrix.matrixTotal,
            action_taken: matrix.actionTaken,
          },
        ])
        .select()
        .single();

      if (error) throw error;
      setAssessments([data as NoiseAssessment, ...assessments]);
      setForm({
        decibel_reading: '',
        noise_source: '',
        scene_description: '',
        volume_score: 0,
        time_score: deriveTimeScoreFromHour(new Date().getHours()),
        tone_score: 0,
      });
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
          <div className="form-row">
            <div className="form-group">
              <label>Volume</label>
              <select
                value={form.volume_score}
                onChange={(e) => setForm({ ...form, volume_score: Number(e.target.value) })}
              >
                {Object.entries(VOLUME_SCORE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {value} — {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label>Time of day</label>
              <select
                value={form.time_score}
                disabled={form.volume_score === 0}
                onChange={(e) => setForm({ ...form, time_score: Number(e.target.value) })}
              >
                {Object.entries(TIME_SCORE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label>Tone</label>
              <select
                value={form.tone_score}
                disabled={form.volume_score === 0}
                onChange={(e) => setForm({ ...form, tone_score: Number(e.target.value) })}
              >
                {Object.entries(TONE_SCORE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="form-group">
            <label>Determined action (computed, not selected)</label>
            <p className="contact-meta">
              Matrix total {matrix.matrixTotal} — {matrix.isExcessive ? 'Excessive' : 'Acceptable'} —{' '}
              {matrix.actionTaken === 'verbal_warning' ? 'Verbal warning' : 'No action'}
            </p>
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
                <h3>{a.noise_source || 'Noise complaint'}</h3>
                {a.decibel_reading != null && <span className="badge">{a.decibel_reading} dB</span>}
              </div>
              <div className="contact-details">
                {a.scene_description && <p>{a.scene_description}</p>}
                <p className="contact-meta">
                  {a.prior_notice_count} prior notice(s) · {new Date(a.assessed_at).toLocaleString()}
                </p>
                {a.matrix_total != null && <p className="contact-meta">TDC matrix total: {a.matrix_total}</p>}
                {a.action_taken && <p className="contact-meta">Action: {a.action_taken}</p>}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default OfficerNoiseControlPage;
