/**
 * OfficerNoiseControlPage.tsx (Officer module: 'noise_control')
 *
 * Canonical schema: noise_assessments (volume_score, time_score, tone_score,
 * matrix_total, action_taken, decibel_reading, noise_source,
 * complaint_address, noise_source_address, assessment_gps_lat/lng,
 * scene_description). Officer-scoped: filtered to the signed-in officer's
 * own assessments.
 *
 * TDC matrix scoring (Phase D) and the resulting action (Phase F) are
 * COMPUTED, never chosen by the officer. Escalation to an abatement notice
 * (an END) is anchored to the noise SOURCE address (dual-address model,
 * #157/#159): a repeat excessive finding tonight, or a prior END within 72
 * hours, at the same source address escalates past a verbal warning.
 * Anchoring is by noise_source_address text match (org-scoped) -- true
 * site_id/geofence anchoring needs address geocoding, a further improvement.
 *
 * Anything beyond a verbal warning requires a current, verified
 * noise_control_warrant credential (Phase F credential gate) before it can
 * be saved. Assessments with an abatement_notice action expose a "Record
 * Seizure" flow (noise_seizures) gated by the same warrant credential and
 * requiring police_present -- mandatory per RMA 1991 s.327. Dispatch
 * integration (dispatch_job_id wiring) and ReportsHubPage cards are
 * explicitly DEFERRED to a follow-up slice.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import {
  computeNoiseMatrix,
  determineNoiseAction,
  deriveTimeScoreFromHour,
  EXCESSIVE_THRESHOLD_DEFAULT,
  VOLUME_SCORE_LABELS,
  TIME_SCORE_LABELS,
  TONE_SCORE_LABELS,
} from '../lib/noiseMatrixSchema';
import './PageStyles.css';

interface NoiseAssessment {
  id: string;
  decibel_reading: number | null;
  noise_source: string | null;
  complaint_address: string | null;
  noise_source_address: string | null;
  prior_notice_count: number;
  action_taken: string | null;
  scene_description: string | null;
  volume_score: number | null;
  time_score: number | null;
  tone_score: number | null;
  matrix_total: number | null;
  assessed_at: string;
}

interface GpsState {
  status: 'idle' | 'locating' | 'captured' | 'unavailable';
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
}

interface SeizureFormState {
  item_description: string;
  make: string;
  model: string;
  serial_number: string;
  storage_location: string;
  police_present: boolean;
  police_name: string;
  seizure_form_number: string;
}

const emptySeizureForm: SeizureFormState = {
  item_description: '',
  make: '',
  model: '',
  serial_number: '',
  storage_location: '',
  police_present: false,
  police_name: '',
  seizure_form_number: '',
};

const ACTION_LABELS: Record<string, string> = {
  no_action: 'No action',
  verbal_warning: 'Verbal warning',
  abatement_notice: 'Abatement notice (END)',
};

const emptyForm = {
  decibel_reading: '',
  noise_source: '',
  complaint_address: '',
  noise_source_address: '',
  scene_description: '',
  volume_score: 0,
  time_score: deriveTimeScoreFromHour(new Date().getHours()),
  tone_score: 0,
};

const OfficerNoiseControlPage: React.FC = () => {
  const { profile } = useAuth();
  const [assessments, setAssessments] = useState<NoiseAssessment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [gps, setGps] = useState<GpsState>({ status: 'idle', lat: null, lng: null, accuracy: null });
  const [noiseConfig, setNoiseConfig] = useState({ excessiveThreshold: EXCESSIVE_THRESHOLD_DEFAULT, skipVerbalWarning: false });
  const [form, setForm] = useState(emptyForm);
  const [seizureAssessmentId, setSeizureAssessmentId] = useState<string | null>(null);
  const [seizureForm, setSeizureForm] = useState<SeizureFormState>(emptySeizureForm);
  const [seizureSubmitting, setSeizureSubmitting] = useState(false);
  const [seizureError, setSeizureError] = useState<string | null>(null);
  const [seizedAssessmentIds, setSeizedAssessmentIds] = useState<Set<string>>(new Set());

  // ATLAS READS: noise_assessments
  const loadAssessments = useCallback(async () => {
    if (!profile?.id) return;
    try {
      setLoading(true);
      setError(null);

      const { data, error: err } = await supabase
        .from('noise_assessments')
        .select(
          'id, decibel_reading, noise_source, complaint_address, noise_source_address, prior_notice_count, action_taken, scene_description, volume_score, time_score, tone_score, matrix_total, assessed_at',
        )
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

  // ATLAS READS: noise_module_config
  const loadNoiseConfig = useCallback(async () => {
    if (!profile?.organizationId) return;
    const { data } = await supabase
      .from('noise_module_config')
      .select('excessive_threshold, skip_verbal_warning')
      .eq('organization_id', profile.organizationId)
      .maybeSingle();
    if (data) {
      setNoiseConfig({
        excessiveThreshold: data.excessive_threshold ?? EXCESSIVE_THRESHOLD_DEFAULT,
        skipVerbalWarning: Boolean(data.skip_verbal_warning),
      });
    }
  }, [profile?.organizationId]);

  useEffect(() => {
    loadAssessments();
    loadNoiseConfig();
  }, [loadAssessments, loadNoiseConfig]);

  const acquireGps = () => {
    if (!navigator.geolocation) {
      setGps({ status: 'unavailable', lat: null, lng: null, accuracy: null });
      return;
    }
    setGps({ status: 'locating', lat: null, lng: null, accuracy: null });
    navigator.geolocation.getCurrentPosition(
      (position) => setGps({ status: 'captured', lat: position.coords.latitude, lng: position.coords.longitude, accuracy: position.coords.accuracy }),
      () => setGps({ status: 'unavailable', lat: null, lng: null, accuracy: null }),
      { enableHighAccuracy: true, maximumAge: 30_000, timeout: 8_000 },
    );
  };

  const matrix = computeNoiseMatrix(
    { volumeScore: form.volume_score, timeScore: form.time_score, toneScore: form.tone_score },
    noiseConfig.excessiveThreshold,
  );

  // ATLAS READS: staff_profiles, staff_credentials (Phase F credential gate, shared by the
  // abatement-notice submit path and the seizure recording workflow -- both require the same
  // current, verified noise_control_warrant).
  const hasVerifiedWarrant = async (): Promise<boolean> => {
    if (!profile?.id) return false;
    const { data: staff } = await supabase.from('staff_profiles').select('id').eq('user_id', profile.id).maybeSingle();
    const staffId = staff?.id;
    if (!staffId) return false;
    const { count } = await supabase
      .from('staff_credentials')
      .select('id', { count: 'exact', head: true })
      .eq('staff_id', staffId)
      .eq('credential_type', 'noise_control_warrant')
      .eq('verified', true)
      .or('expiry_date.is.null,expiry_date.gte.' + new Date().toISOString().slice(0, 10));
    return (count ?? 0) > 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile?.id || !profile?.organizationId || submitting) return;
    setSubmitting(true);
    setError(null);

    try {
      const sourceAddress = form.noise_source_address.trim() || null;
      let visitNumberTonight = 1;
      let priorEndWithin72hrs = false;

      if (sourceAddress) {
        const startOfTonight = new Date();
        startOfTonight.setHours(0, 0, 0, 0);
        const since72hrs = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();

        // ATLAS READS: noise_assessments (repeat-visit / prior-END lookup, anchored to the source address)
        const [tonightResult, priorEndResult] = await Promise.all([
          supabase
            .from('noise_assessments')
            .select('id', { count: 'exact', head: true })
            .eq('organization_id', profile.organizationId)
            .eq('noise_source_address', sourceAddress)
            .gte('assessed_at', startOfTonight.toISOString()),
          supabase
            .from('noise_assessments')
            .select('id', { count: 'exact', head: true })
            .eq('organization_id', profile.organizationId)
            .eq('noise_source_address', sourceAddress)
            .eq('action_taken', 'abatement_notice')
            .gte('assessed_at', since72hrs),
        ]);
        visitNumberTonight = (tonightResult.count ?? 0) + 1;
        priorEndWithin72hrs = (priorEndResult.count ?? 0) > 0;
      }

      const actionTaken = determineNoiseAction({
        isExcessive: matrix.isExcessive,
        visitNumberTonight,
        priorEndWithin72hrs,
        skipVerbalWarning: noiseConfig.skipVerbalWarning,
      });

      if (actionTaken !== 'no_action' && actionTaken !== 'verbal_warning') {
        const hasWarrant = await hasVerifiedWarrant();
        if (!hasWarrant) {
          setError('An abatement notice requires a current, verified noise control warrant. This assessment was not saved -- request a warrant check before proceeding.');
          setSubmitting(false);
          return;
        }
      }

      // ATLAS WRITES: noise_assessments
      const { data, error } = await supabase
        .from('noise_assessments')
        .insert([
          {
            organization_id: profile.organizationId,
            officer_user_id: profile.id,
            decibel_reading: form.decibel_reading ? parseFloat(form.decibel_reading) : null,
            noise_source: form.noise_source || null,
            complaint_address: form.complaint_address.trim() || null,
            noise_source_address: sourceAddress,
            assessment_gps_lat: gps.lat,
            assessment_gps_lng: gps.lng,
            assessment_gps_accuracy: gps.accuracy,
            scene_description: form.scene_description || null,
            volume_score: form.volume_score,
            time_score: form.volume_score === 0 ? null : form.time_score,
            tone_score: form.volume_score === 0 ? null : form.tone_score,
            matrix_total: matrix.matrixTotal,
            visit_number_tonight: visitNumberTonight,
            prior_end_within_72hrs: priorEndWithin72hrs,
            action_taken: actionTaken,
          },
        ])
        .select()
        .single();

      if (error) throw error;
      setAssessments([data as NoiseAssessment, ...assessments]);
      setForm(emptyForm);
      setGps({ status: 'idle', lat: null, lng: null, accuracy: null });
      setShowForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit assessment');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSeizureSubmit = async (assessmentId: string, e: React.FormEvent) => {
    e.preventDefault();
    if (!profile?.organizationId || seizureSubmitting) return;
    setSeizureSubmitting(true);
    setSeizureError(null);

    try {
      const hasWarrant = await hasVerifiedWarrant();
      if (!hasWarrant) {
        setSeizureError('Equipment seizure requires a current, verified noise control warrant.');
        setSeizureSubmitting(false);
        return;
      }
      if (!seizureForm.police_present) {
        setSeizureError('Police must be present for any equipment seizure (RMA 1991 s.327).');
        setSeizureSubmitting(false);
        return;
      }

      // ATLAS WRITES: noise_seizures
      const { error } = await supabase.from('noise_seizures').insert([
        {
          organization_id: profile.organizationId,
          noise_assessment_id: assessmentId,
          item_description: seizureForm.item_description,
          make: seizureForm.make || null,
          model: seizureForm.model || null,
          serial_number: seizureForm.serial_number || null,
          storage_location: seizureForm.storage_location || null,
          police_present: seizureForm.police_present,
          police_name: seizureForm.police_name || null,
          seizure_form_number: seizureForm.seizure_form_number || null,
        },
      ]);

      if (error) throw error;
      setSeizedAssessmentIds((prev) => new Set(prev).add(assessmentId));
      setSeizureAssessmentId(null);
      setSeizureForm(emptySeizureForm);
    } catch (err) {
      setSeizureError(err instanceof Error ? err.message : 'Failed to record seizure');
    } finally {
      setSeizureSubmitting(false);
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
              <label>Complaint address</label>
              <input
                type="text"
                placeholder="Where the complainant lives"
                value={form.complaint_address}
                onChange={(e) => setForm({ ...form, complaint_address: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label>Noise source address</label>
              <input
                type="text"
                placeholder="The property producing the noise"
                value={form.noise_source_address}
                onChange={(e) => setForm({ ...form, noise_source_address: e.target.value })}
              />
            </div>
          </div>
          <div className="form-group">
            <button type="button" className="btn btn-secondary btn-sm" onClick={acquireGps} disabled={gps.status === 'locating'}>
              {gps.status === 'captured' ? 'GPS captured' : gps.status === 'locating' ? 'Locating…' : 'Capture GPS'}
            </button>
            {gps.status === 'unavailable' && <span className="contact-meta"> Location unavailable</span>}
          </div>
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
              Matrix total {matrix.matrixTotal} — {matrix.isExcessive ? 'Excessive' : 'Acceptable'}. Final action (including
              repeat-visit escalation and the credential gate) is computed on submit.
            </p>
          </div>
          <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
            {submitting ? 'Submitting…' : 'Submit Assessment'}
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
                <h3>{a.noise_source_address || a.noise_source || 'Noise complaint'}</h3>
                {a.decibel_reading != null && <span className="badge">{a.decibel_reading} dB</span>}
              </div>
              <div className="contact-details">
                {a.scene_description && <p>{a.scene_description}</p>}
                <p className="contact-meta">
                  {a.prior_notice_count} prior notice(s) · {new Date(a.assessed_at).toLocaleString()}
                </p>
                {a.matrix_total != null && <p className="contact-meta">TDC matrix total: {a.matrix_total}</p>}
                {a.action_taken && <p className="contact-meta">Action: {ACTION_LABELS[a.action_taken] ?? a.action_taken}</p>}
                {a.action_taken === 'abatement_notice' && (
                  seizedAssessmentIds.has(a.id) ? (
                    <p className="contact-meta">Seizure recorded.</p>
                  ) : seizureAssessmentId === a.id ? (
                    <form className="assessment-form" onSubmit={(e) => handleSeizureSubmit(a.id, e)} style={{ marginTop: '8px' }}>
                      {seizureError && (
                        <div className="alert alert-error" role="alert">
                          {seizureError}
                        </div>
                      )}
                      <div className="form-group">
                        <label>Item description</label>
                        <input
                          required
                          value={seizureForm.item_description}
                          onChange={(e) => setSeizureForm({ ...seizureForm, item_description: e.target.value })}
                        />
                      </div>
                      <div className="form-group">
                        <label>Make</label>
                        <input value={seizureForm.make} onChange={(e) => setSeizureForm({ ...seizureForm, make: e.target.value })} />
                      </div>
                      <div className="form-group">
                        <label>Model</label>
                        <input value={seizureForm.model} onChange={(e) => setSeizureForm({ ...seizureForm, model: e.target.value })} />
                      </div>
                      <div className="form-group">
                        <label>Serial number</label>
                        <input
                          value={seizureForm.serial_number}
                          onChange={(e) => setSeizureForm({ ...seizureForm, serial_number: e.target.value })}
                        />
                      </div>
                      <div className="form-group">
                        <label>Storage location</label>
                        <input
                          value={seizureForm.storage_location}
                          onChange={(e) => setSeizureForm({ ...seizureForm, storage_location: e.target.value })}
                        />
                      </div>
                      <div className="form-group">
                        <label>
                          <input
                            type="checkbox"
                            checked={seizureForm.police_present}
                            onChange={(e) => setSeizureForm({ ...seizureForm, police_present: e.target.checked })}
                          />{' '}
                          Police present (mandatory)
                        </label>
                      </div>
                      <div className="form-group">
                        <label>Police name</label>
                        <input
                          value={seizureForm.police_name}
                          onChange={(e) => setSeizureForm({ ...seizureForm, police_name: e.target.value })}
                        />
                      </div>
                      <div className="form-group">
                        <label>Seizure form number</label>
                        <input
                          value={seizureForm.seizure_form_number}
                          onChange={(e) => setSeizureForm({ ...seizureForm, seizure_form_number: e.target.value })}
                        />
                      </div>
                      <button type="submit" className="btn btn-primary btn-block" disabled={seizureSubmitting}>
                        {seizureSubmitting ? 'Recording…' : 'Record Seizure'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-block"
                        onClick={() => {
                          setSeizureAssessmentId(null);
                          setSeizureError(null);
                        }}
                      >
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setSeizureAssessmentId(a.id)}>
                      Record Seizure
                    </button>
                  )
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default OfficerNoiseControlPage;
