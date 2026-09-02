import React, { useCallback, useEffect, useState } from 'react';
import { Camera, LoaderCircle, MapPin } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { getCurrentPosition, imageFileToBase64 } from '../lib/officerScan';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

type NoiseAction = 'no_noise' | 'acceptable' | 'verbal_warning';

const H_AND_S_ITEMS = [
  'Phone is fully charged',
  'Risk assessment completed for this address',
  'Access and exit routes identified',
  'Vehicle parked for quick unobstructed departure',
  'Body Worn Camera activated on arrival',
];

const initialForm = {
  noise_source: '', scene_description: '', complaint_address: '', noise_source_address: '',
  assessment_location: '', received_at: '', arrived_at: '', volume_score: '0',
  time_score: '1', tone_score: '0', action: 'no_noise' as NoiseAction,
  incident_report_text: '',
};

interface NoiseAssessment {
  id: string;
  job_number: string | null;
  noise_source: string | null;
  matrix_total: number | null;
  action_taken: string | null;
  scene_description: string | null;
  assessed_at: string;
  review_status: string;
  reviewed_at: string | null;
  review_notes: string | null;
  follow_up_required: boolean;
}

const OfficerNoiseControlPage: React.FC = () => {
  const location = useLocation();
  const requestedAssessmentId = new URLSearchParams(location.search).get('assessment');
  const { profile } = useAuth();
  const [assessments, setAssessments] = useState<NoiseAssessment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [locating, setLocating] = useState(false);
  const [form, setForm] = useState(initialForm);
  const [hsItems, setHsItems] = useState<boolean[]>(H_AND_S_ITEMS.map(() => false));
  const [coordinates, setCoordinates] = useState<{ latitude: number; longitude: number; accuracy: number } | null>(null);
  const [assessmentPhoto, setAssessmentPhoto] = useState<File | null>(null);
  const [sourcePhoto, setSourcePhoto] = useState<File | null>(null);
  const [servicePhoto, setServicePhoto] = useState<File | null>(null);
  const [clientRequestId, setClientRequestId] = useState(() => crypto.randomUUID());
  const matrixTotal = Number(form.volume_score) === 0 ? 0 : Number(form.volume_score) + Number(form.time_score) + Number(form.tone_score);

  // ATLAS READS: noise_assessments
  const loadAssessments = useCallback(async () => {
    if (!profile?.id) return;
    try {
      setLoading(true);
      setError(null);
      const { data, error: loadError } = await supabase
        .from('noise_assessments')
        .select('id, job_number, noise_source, matrix_total, action_taken, scene_description, assessed_at, review_status, reviewed_at, review_notes, follow_up_required')
        .eq('officer_user_id', profile.id)
        .order('assessed_at', { ascending: false });
      if (loadError) throw loadError;
      setAssessments((data as NoiseAssessment[]) || []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load noise assessments');
    } finally {
      setLoading(false);
    }
  }, [profile?.id]);

  useEffect(() => { loadAssessments(); }, [loadAssessments]);
  useEffect(() => {
    if (requestedAssessmentId) document.getElementById(`officer-noise-${requestedAssessmentId}`)?.scrollIntoView({ block: 'center' });
  }, [assessments, requestedAssessmentId]);

  const captureLocation = async () => {
    try {
      setLocating(true);
      setError(null);
      const position = await getCurrentPosition();
      setCoordinates({ latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy });
      const now = new Date();
      setForm((current) => ({ ...current, arrived_at: current.arrived_at || new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16) }));
    } catch (locationError) {
      setError(locationError instanceof Error ? locationError.message : 'Location could not be captured');
    } finally {
      setLocating(false);
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!profile?.id || !coordinates || !assessmentPhoto) {
      setError('Capture the assessment location and assessment-point photograph before submitting.');
      return;
    }
    try {
      setSubmitting(true);
      setError(null);
      const photos = await Promise.all([
        { category: 'assessment', file: assessmentPhoto },
        { category: 'source', file: sourcePhoto },
        { category: 'service', file: servicePhoto },
      ].filter((item): item is { category: string; file: File } => Boolean(item.file)).map(async ({ category, file }) => ({
        category,
        file_name: file.name,
        image_base64: await imageFileToBase64(file),
      })));
      // ATLAS INVOKES: submit-noise-assessment
      const { data, error: submissionError } = await supabase.functions.invoke('submit-noise-assessment', {
        body: {
          client_request_id: clientRequestId,
          payload: {
            ...form,
            received_at: new Date(form.received_at).toISOString(), arrived_at: new Date(form.arrived_at).toISOString(), departed_at: new Date().toISOString(),
            volume_score: Number(form.volume_score), time_score: Number(form.time_score), tone_score: Number(form.tone_score),
            hs_checklist_items: hsItems,
            arrival_gps_lat: coordinates.latitude, arrival_gps_lng: coordinates.longitude, arrival_gps_accuracy: coordinates.accuracy,
            assessment_gps_lat: coordinates.latitude, assessment_gps_lng: coordinates.longitude, assessment_gps_accuracy: coordinates.accuracy,
          },
          photos,
        },
      });
      if (submissionError || !data?.success) throw submissionError ?? new Error(data?.error ?? 'Assessment was not recorded');
      await loadAssessments();
      setForm(initialForm);
      setHsItems(H_AND_S_ITEMS.map(() => false));
      setCoordinates(null);
      setAssessmentPhoto(null);
      setSourcePhoto(null);
      setServicePhoto(null);
      setClientRequestId(crypto.randomUUID());
      setShowForm(false);
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : 'Failed to submit assessment');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div className="page-container"><div className="loading-state"><div className="spinner"></div><p>Loading noise assessments...</p></div></div>;

  return (
    <div className="page-container">
      <header className="page-header"><div><p className="eyebrow">Field evidence</p><h1>Noise Control</h1><p className="subtitle">{assessments.length} assessments recorded</p></div></header>
      {error && <div className="alert alert-error" role="alert"><button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">×</button>{error}</div>}
      <button className="btn btn-primary btn-sm" onClick={() => setShowForm(!showForm)}>{showForm ? 'Cancel' : '+ New Assessment'}</button>

      {showForm && (
        <form className="assessment-form noise-capture-form" onSubmit={handleSubmit}>
          <div className="noise-form-heading"><div><p className="eyebrow">Evidence-led attendance</p><h2>Noise assessment</h2></div><div className={`noise-matrix-result ${matrixTotal >= 5 ? 'is-excessive' : ''}`}><strong>{matrixTotal}</strong><span>TDC total</span></div></div>
          <div className="form-row"><div className="form-group"><label>Complaint received</label><input required type="datetime-local" value={form.received_at} onChange={(event) => setForm({ ...form, received_at: event.target.value })} /></div><div className="form-group"><label>Arrival time</label><input required type="datetime-local" value={form.arrived_at} onChange={(event) => setForm({ ...form, arrived_at: event.target.value })} /></div></div>
          <div className="noise-location-bar"><div><MapPin size={17} /><span>{coordinates ? `${coordinates.latitude.toFixed(6)}, ${coordinates.longitude.toFixed(6)} (±${Math.round(coordinates.accuracy)}m)` : 'Arrival and assessment GPS not captured'}</span></div><button type="button" className="btn btn-secondary btn-sm" onClick={captureLocation} disabled={locating}>{locating ? <LoaderCircle className="spin-icon" size={15} /> : <MapPin size={15} />}{coordinates ? 'Recapture' : 'Capture GPS'}</button></div>
          <fieldset className="noise-fieldset"><legend>Health and safety gate</legend>{H_AND_S_ITEMS.map((item, index) => <label key={item} className="form-checkbox"><input type="checkbox" checked={hsItems[index]} onChange={(event) => setHsItems((current) => current.map((checked, itemIndex) => itemIndex === index ? event.target.checked : checked))} />{item}</label>)}</fieldset>
          <div className="form-group"><label>Noise source classification</label><input required type="text" placeholder="Amplified music, machinery, voices..." value={form.noise_source} onChange={(event) => setForm({ ...form, noise_source: event.target.value })} /></div>
          <div className="form-row"><div className="form-group"><label>Complaint address</label><input required type="text" value={form.complaint_address} onChange={(event) => setForm({ ...form, complaint_address: event.target.value })} /></div><div className="form-group"><label>Noise source address</label><input required type="text" value={form.noise_source_address} onChange={(event) => setForm({ ...form, noise_source_address: event.target.value })} /></div></div>
          <div className="form-group"><label>Assessment location</label><input required type="text" placeholder="Where you stood to assess the noise" value={form.assessment_location} onChange={(event) => setForm({ ...form, assessment_location: event.target.value })} /></div>
          <fieldset className="noise-fieldset"><legend>TDC assessment</legend><div className="noise-score-grid"><div className="form-group"><label>Volume</label><select value={form.volume_score} onChange={(event) => setForm({ ...form, volume_score: event.target.value, action: event.target.value === '0' ? 'no_noise' : form.action })}><option value="0">0 · No noise</option><option value="1">1 · Barely audible</option><option value="2">2 · Clearly audible</option><option value="3">3 · Loud</option><option value="4">4 · Extremely loud</option></select></div><div className="form-group"><label>Time</label><select disabled={form.volume_score === '0'} value={form.time_score} onChange={(event) => setForm({ ...form, time_score: event.target.value })}><option value="1">1 · 7am-9pm</option><option value="2">2 · 9pm-midnight</option><option value="3">3 · Midnight-2am</option><option value="4">4 · 2am-7am</option></select></div><div className="form-group"><label>Tone / bass</label><select value={form.tone_score} onChange={(event) => setForm({ ...form, tone_score: event.target.value })}><option value="0">0 · No bass</option><option value="1">1 · Slight bass</option><option value="2">2 · Heavy bass</option></select></div></div></fieldset>
          <div className="form-group"><label>Scene description</label><textarea required rows={3} value={form.scene_description} onChange={(event) => setForm({ ...form, scene_description: event.target.value })} /></div>
          <div className="form-group"><label>Incident report</label><textarea required rows={5} value={form.incident_report_text} onChange={(event) => setForm({ ...form, incident_report_text: event.target.value })} /></div>
          <div className="form-group"><label>Action</label><select value={form.action} onChange={(event) => setForm({ ...form, action: event.target.value as NoiseAction })}><option value="no_noise" disabled={matrixTotal !== 0}>No noise · no action</option><option value="acceptable" disabled={matrixTotal === 0 || matrixTotal >= 5}>Acceptable · no enforcement</option><option value="verbal_warning" disabled={matrixTotal < 5}>Verbal warning</option></select></div>
          <fieldset className="noise-fieldset"><legend>Photographic evidence</legend><div className="noise-photo-grid"><label className="noise-photo-control"><Camera size={18} /><span>Assessment point *</span><input required type="file" accept="image/*" capture="environment" onChange={(event) => setAssessmentPhoto(event.target.files?.[0] ?? null)} /><small>{assessmentPhoto?.name ?? 'Street context and assessment position'}</small></label><label className="noise-photo-control"><Camera size={18} /><span>Source address</span><input type="file" accept="image/*" capture="environment" onChange={(event) => setSourcePhoto(event.target.files?.[0] ?? null)} /><small>{sourcePhoto?.name ?? 'Property number or source context'}</small></label><label className="noise-photo-control"><Camera size={18} /><span>Service evidence</span><input type="file" accept="image/*" capture="environment" onChange={(event) => setServicePhoto(event.target.files?.[0] ?? null)} /><small>{servicePhoto?.name ?? 'Notice location or service evidence'}</small></label></div></fieldset>
          <button type="submit" className="btn btn-primary btn-block" disabled={submitting || !coordinates || !assessmentPhoto || !hsItems.every(Boolean)}>{submitting ? <><LoaderCircle className="spin-icon" size={16} /> Recording assessment...</> : 'Submit governed assessment'}</button>
        </form>
      )}

      <div className="contacts-list">
        {assessments.length === 0 ? <div className="empty-state"><p>No assessments recorded yet.</p></div> : assessments.map((assessment) => (
          <div key={assessment.id} id={`officer-noise-${assessment.id}`} className={`contact-card ${assessment.id === requestedAssessmentId ? 'is-context-focus' : ''}`}>
            <div className="contact-header"><h3>{assessment.noise_source || 'Noise complaint'}</h3>{assessment.matrix_total != null && <span className="badge">TDC {assessment.matrix_total}</span>}</div>
            <div className="contact-details">{assessment.scene_description && <p>{assessment.scene_description}</p>}<p className="contact-meta">{assessment.job_number ?? 'Job pending'} · {new Date(assessment.assessed_at).toLocaleString()}</p>{assessment.action_taken && <p className="contact-meta">Action: {assessment.action_taken.replaceAll('_', ' ')}</p>}{assessment.review_status !== 'open' && <section className="noise-officer-review"><strong>Supervisor review · {assessment.review_status.replaceAll('_', ' ')}</strong><span>{assessment.review_notes ?? 'Review note unavailable'}</span><small>{assessment.follow_up_required ? 'Follow-up required' : 'No further follow-up'}{assessment.reviewed_at ? ` · ${new Date(assessment.reviewed_at).toLocaleString('en-NZ')}` : ''}</small></section>}</div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default OfficerNoiseControlPage;
