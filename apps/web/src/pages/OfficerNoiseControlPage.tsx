/**
 * OfficerNoiseControlPage.tsx (Officer module: 'noise_control')
 *
 * Canonical schema: noise_assessments (decibel_reading, noise_source,
 * prior_notice_count, action_taken, scene_description). Officer-scoped:
 * filtered to the signed-in officer's own assessments.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { Crosshair, MapPin, RefreshCw, Search } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { resolveAddressCandidates, resolveAddressForCoordinates } from '../lib/locationAddress';
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

const ACTIONS = ['no_action', 'verbal_warning', 'abatement_notice', 'direction_notice', 'enforcement_notice', 'equipment_seized', 'prosecution_referral'] as const;

function currentTimeScore(): number {
  const hour = Number(new Intl.DateTimeFormat('en-NZ', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Pacific/Auckland' }).format(new Date()));
  if (hour >= 7 && hour < 21) return 1;
  if (hour < 24) return 2;
  if (hour < 2) return 3;
  return 4;
}

const OfficerNoiseControlPage: React.FC = () => {
  const location=useLocation();
  const requestedAssessmentId=new URLSearchParams(location.search).get('assessment');
  const { profile } = useAuth();
  const [assessments, setAssessments] = useState<NoiseAssessment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ decibel_reading: '', noise_source: '', noise_source_address: '', assessment_location: '', scene_description: '', action_taken: 'no_action', volume_score: '', tone_score: '0', hs_checklist_completed: false });
  const [gps, setGps] = useState<{ lat: number | null; lng: number | null; accuracy: number | null; status: 'idle' | 'locating' | 'captured' | 'unavailable' }>({ lat: null, lng: null, accuracy: null, status: 'idle' });
  const [addressResolution, setAddressResolution] = useState<{ status: 'idle' | 'resolving' | 'resolved' | 'unavailable'; message: string | null }>({ status: 'idle', message: null });
  const [submitting, setSubmitting] = useState(false);
  const volumeScore = form.volume_score === '' ? null : Number(form.volume_score);
  const matrixTotal = volumeScore === null ? null : volumeScore === 0 ? 0 : volumeScore + currentTimeScore() + Number(form.tone_score);
  const canSubmit = Boolean(form.noise_source.trim() && form.noise_source_address.trim() && form.scene_description.trim() && form.volume_score !== '' && form.hs_checklist_completed);

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

  const captureAssessmentLocation = () => {
    if (!navigator.geolocation) { setGps({ lat: null, lng: null, accuracy: null, status: 'unavailable' }); return; }
    setGps({ lat: null, lng: null, accuracy: null, status: 'locating' });
    navigator.geolocation.getCurrentPosition(async (position) => {
      const { latitude, longitude, accuracy } = position.coords;
      setGps({ lat: latitude, lng: longitude, accuracy, status: 'captured' });
      try {
        const address = await resolveAddressForCoordinates(latitude, longitude);
        if (address) setForm((current) => current.assessment_location.trim() ? current : { ...current, assessment_location: address.label });
      } catch { /* GPS evidence is still retained if address resolution is unavailable. */ }
    }, () => setGps({ lat: null, lng: null, accuracy: null, status: 'unavailable' }), { enableHighAccuracy: true, maximumAge: 30_000, timeout: 8_000 });
  };

  const resolveNoiseSourceAddress = async () => {
    const query = form.noise_source_address.trim() || form.noise_source.trim();
    if (!query) return;
    setAddressResolution({ status: 'resolving', message: null });
    try {
      const candidate = (await resolveAddressCandidates(query, 1))[0];
      if (!candidate) {
        setAddressResolution({ status: 'unavailable', message: 'No address match was returned.' });
        return;
      }
      setForm((current) => ({ ...current, noise_source_address: candidate.label }));
      setAddressResolution({ status: 'resolved', message: candidate.label });
    } catch (error) {
      setAddressResolution({ status: 'unavailable', message: error instanceof Error ? error.message : 'Address could not be resolved.' });
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile?.id || !profile?.organizationId) return;

    try {
      setSubmitting(true);
      setError(null);
      const requestId = crypto.randomUUID();

      // ATLAS WRITES: submit_officer_noise_assessment
      const { data, error } = await supabase.rpc('submit_officer_noise_assessment', {
        p_client_request_id: requestId,
        p_assessed_at: new Date().toISOString(),
        p_noise_source: form.noise_source.trim(),
        p_noise_source_address: form.noise_source_address.trim(),
        p_action_taken: form.action_taken,
        p_volume_score: Number(volumeScore) || 0,
        p_time_score: volumeScore === 0 ? 1 : currentTimeScore(),
        p_tone_score: volumeScore === 0 ? 0 : Number(form.tone_score),
        p_scene_description: form.scene_description.trim() || null,
        p_gps_lat: gps.lat,
        p_gps_lng: gps.lng,
      });

      const receipt = (data as Array<{ id: string }> | null)?.[0];
      if (error || !receipt?.id) throw error ?? new Error('Noise assessment receipt was not confirmed.');

      setForm({ decibel_reading: '', noise_source: '', noise_source_address: '', assessment_location: '', scene_description: '', action_taken: 'no_action', volume_score: '', tone_score: '0', hs_checklist_completed: false });
      setGps({ lat: null, lng: null, accuracy: null, status: 'idle' });
      setShowForm(false);
      await loadAssessments();
    } catch (err) {
      setError(err instanceof Error ? err.message : (err as { message?: string }).message ?? 'Failed to submit assessment');
    } finally {
      setSubmitting(false);
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
              <label htmlFor="noise-decibels">Decibel reading</label>
              <input
                id="noise-decibels"
                type="number"
                min="0"
                max="160"
                step="0.1"
                value={form.decibel_reading}
                onChange={(e) => setForm({ ...form, decibel_reading: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label htmlFor="noise-source">Noise source</label>
              <input id="noise-source" required value={form.noise_source} onChange={(e) => setForm({ ...form, noise_source: e.target.value })} />
            </div>
          </div>
          <div className="form-group">
            <label htmlFor="noise-source-address">Noise source address</label>
            <input id="noise-source-address" required value={form.noise_source_address} onChange={(e) => { setForm({ ...form, noise_source_address: e.target.value }); setAddressResolution({ status: 'idle', message: null }); }} placeholder="Address producing the noise" />
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void resolveNoiseSourceAddress()} disabled={addressResolution.status === 'resolving' || !(form.noise_source_address.trim() || form.noise_source.trim())}>{addressResolution.status === 'resolving' ? <RefreshCw size={15} className="is-spinning" /> : <Search size={15} />} Resolve address</button>
            {addressResolution.message && <small className="form-hint"><MapPin size={13} /> {addressResolution.message}</small>}
          </div>
          <div className="form-group">
            <label htmlFor="noise-assessment-location">Assessment location</label>
            <input id="noise-assessment-location" value={form.assessment_location} onChange={(e) => setForm({ ...form, assessment_location: e.target.value })} placeholder="Where you measured from" />
            <button type="button" className="btn btn-secondary btn-sm" onClick={captureAssessmentLocation} disabled={gps.status === 'locating'}><Crosshair size={15} /> {gps.status === 'locating' ? 'Capturing location' : gps.status === 'captured' ? 'Refresh GPS location' : 'Capture GPS location'}</button>
          </div>
          <div className="form-row">
            <div className="form-group"><label htmlFor="noise-volume">Volume score</label><select id="noise-volume" required value={form.volume_score} onChange={(e) => setForm({ ...form, volume_score: e.target.value })}><option value="">Select score</option><option value="0">0 · No noise</option><option value="1">1 · Barely audible</option><option value="2">2 · Clearly audible</option><option value="3">3 · Loud</option><option value="4">4 · Extremely loud</option></select></div>
            <div className="form-group"><label htmlFor="noise-tone">Bass / tone score</label><select id="noise-tone" disabled={volumeScore === 0} value={form.tone_score} onChange={(e) => setForm({ ...form, tone_score: e.target.value })}><option value="0">0 · No bass</option><option value="1">1 · Slight bass</option><option value="2">2 · Heavy bass</option></select></div>
          </div>
          {matrixTotal !== null && <p className="form-hint">Assessment matrix score: {matrixTotal}{volumeScore === 0 ? ' · no action threshold' : ` · time score ${currentTimeScore()}`}</p>}
          <div className="form-group">
            <label htmlFor="noise-scene">Scene description</label>
            <textarea id="noise-scene" required rows={3} value={form.scene_description} onChange={(e) => setForm({ ...form, scene_description: e.target.value })} />
          </div>
          <div className="form-group">
            <label htmlFor="noise-action">Action taken</label>
            <select id="noise-action" value={form.action_taken} onChange={(e) => setForm({ ...form, action_taken: e.target.value })}>{ACTIONS.map((action) => <option key={action} value={action}>{action.replaceAll('_', ' ')}</option>)}</select>
          </div>
          <label className="form-checkbox"><input type="checkbox" checked={form.hs_checklist_completed} onChange={(e) => setForm({ ...form, hs_checklist_completed: e.target.checked })} /> H&amp;S pre-visit check completed</label>
          <button type="submit" className="btn btn-primary btn-block" disabled={submitting || !canSubmit}>
            {submitting ? <><RefreshCw size={16} className="is-spinning" />Saving assessment</> : 'Submit Assessment'}
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
