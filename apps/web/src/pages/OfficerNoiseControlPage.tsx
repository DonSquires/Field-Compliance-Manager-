/**
 * OfficerNoiseControlPage.tsx (Officer module: 'noise_control')
 *
 * The two-place model (docs/canon/NOISE_CONTROL_TWO_PLACE_MODEL.md): one complaint job
 * carries the noise SOURCE (work anchor — assessment, END and seizure are recorded against
 * it) and the COMPLAINANT place (harm anchor, protected). Flow per job: dossier → arrive at
 * source (geofence verified, never blocked) → assess from as near the complainant as a
 * public position allows → action → optional complainant contact → depart. Every write is a
 * governed RPC with a client_request_id receipt; complainant identity is only ever read
 * through the audited RPC and is not kept in page state beyond the reveal.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Crosshair, MapPin, Phone, RefreshCw, Search, ShieldAlert } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import { useActiveModuleContext } from '../hooks/useActiveModuleContext';
import { useActiveShift } from '../hooks/useActiveShift';
import { ACTIVE_DISPATCH_JOB_STATUSES } from '../lib/dispatchStatus';
import { resolveAddressCandidates, resolveAddressForCoordinates } from '../lib/locationAddress';
import { supabase } from '../lib/supabase';
import './PageStyles.css';
import './OfficerNoiseControlPage.css';

interface NoiseAssessment {
  id: string;
  decibel_reading: number | null;
  noise_source: string | null;
  noise_source_address: string | null;
  prior_notice_count: number;
  action_taken: string | null;
  scene_description: string | null;
  assessed_at: string;
  review_status: string;
  reviewed_at: string | null;
  review_notes: string | null;
  follow_up_required: boolean;
  end_number: string | null;
  end_expires_at: string | null;
  assessment_distance_to_complainant_m: number | null;
  dispatch_job_id: string | null;
}

interface NoiseJob {
  id: string;
  job_type: string;
  priority: string;
  status: string;
  briefing_notes: string | null;
  sla_respond_by: string | null;
  sla_breached: boolean | null;
  sla_delay_reason: string | null;
  dispatched_at: string | null;
  on_scene_at: string | null;
  client_site_id: string | null;
  harmed_party_site_id: string | null;
  harmed_party_address: string | null;
  shift_id: string | null;
}

interface JobStop {
  id: string;
  place_role: 'work_place' | 'harmed_party_place';
  visit_number: number;
  status: string;
  actual_arrived_at: string | null;
  actual_departed_at: string | null;
  arrival_verification: string | null;
  arrival_distance_m: number | null;
  sla_status: string;
}

interface JobInteraction { id: string; party_role: string; mode: string; occurred_at: string; summary: string | null }
interface SourceHistory { id: string; assessed_at: string; action_taken: string | null; end_number: string | null; end_expires_at: string | null; permanent_abatement_active: boolean | null; is_problem_address: boolean | null; hs_flag_active: boolean | null; hs_notes: string | null }
interface Gps { lat: number | null; lng: number | null; accuracy: number | null; status: 'idle' | 'locating' | 'captured' | 'unavailable' }
type RevealedContact = { display_name: string | null; phone: string | null } | 'unavailable' | null;

const ACTIONS = ['no_action', 'verbal_warning', 'abatement_notice', 'direction_notice', 'enforcement_notice', 'equipment_seized', 'prosecution_referral'] as const;
const STATUTORY_ACTIONS: ReadonlyArray<string> = ['abatement_notice', 'direction_notice', 'enforcement_notice', 'equipment_seized'];
const VERIFICATION_LABEL: Record<string, string> = {
  verified_on_site: 'On site — GPS inside the place geofence',
  near_site: 'Near the place — within approach distance',
  off_site: 'Off site — GPS is away from this place; the report will say so',
  unverified_boundary: 'Boundary not yet verified on the map — distance recorded, not authoritative',
  no_geofence: 'This place has no geofence yet — attendance recorded by time only',
  no_gps: 'No GPS fix — attendance recorded by time only',
};
const IDLE_GPS: Gps = { lat: null, lng: null, accuracy: null, status: 'idle' };
const EMPTY_FORM = { decibel_reading: '', noise_source: '', noise_source_address: '', assessment_location: '', scene_description: '', action_taken: 'no_action', volume_score: '', tone_score: '0', end_number: '', notice_number: '', occupant_name: '', police_requested: false, police_present: false, follow_up_required: false, hs_checklist_completed: false };

function currentTimeScore(): number {
  const hour = Number(new Intl.DateTimeFormat('en-NZ', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Pacific/Auckland' }).format(new Date()));
  if (hour >= 7 && hour < 21) return 1;
  if (hour >= 21) return 2;
  if (hour < 2) return 3;
  return 4;
}

function captureGps(setter: (gps: Gps) => void, onFix?: (lat: number, lng: number) => void) {
  if (!navigator.geolocation) { setter({ ...IDLE_GPS, status: 'unavailable' }); return; }
  setter({ ...IDLE_GPS, status: 'locating' });
  navigator.geolocation.getCurrentPosition((position) => {
    const { latitude, longitude, accuracy } = position.coords;
    setter({ lat: latitude, lng: longitude, accuracy, status: 'captured' });
    onFix?.(latitude, longitude);
  }, () => setter({ ...IDLE_GPS, status: 'unavailable' }), { enableHighAccuracy: true, maximumAge: 30_000, timeout: 8_000 });
}

const clock = (value: string) => new Date(value).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' });

const OfficerNoiseControlPage: React.FC = () => {
  const location = useLocation();
  const requestedAssessmentId = new URLSearchParams(location.search).get('assessment');
  const { profile } = useAuth();
  const { selectedAgreementZones } = useServiceRelationships();
  const moduleContext = useActiveModuleContext('noise_control');
  const { shift: activeShift } = useActiveShift(profile?.id ?? '', profile?.organizationId ?? '');

  const [assessments, setAssessments] = useState<NoiseAssessment[]>([]);
  const [jobs, setJobs] = useState<NoiseJob[]>([]);
  const [sites, setSites] = useState<Record<string, { name: string | null; address: string | null }>>({});
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [stops, setStops] = useState<JobStop[]>([]);
  const [interactions, setInteractions] = useState<JobInteraction[]>([]);
  const [sourceHistory, setSourceHistory] = useState<SourceHistory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [gps, setGps] = useState<Gps>(IDLE_GPS);
  const [arrivalGps, setArrivalGps] = useState<Gps>(IDLE_GPS);
  const [bwcReference, setBwcReference] = useState('');
  const [addressResolution, setAddressResolution] = useState<{ status: 'idle' | 'resolving' | 'resolved' | 'unavailable'; message: string | null }>({ status: 'idle', message: null });
  const [contact, setContact] = useState({ mode: 'phone', summary: '' });
  const [revealedContact, setRevealedContact] = useState<RevealedContact>(null);
  const [delayReason, setDelayReason] = useState('');

  const selectedJob = useMemo(() => jobs.find((job) => job.id === selectedJobId) ?? null, [jobs, selectedJobId]);
  const sourceStop = useMemo(() => stops.filter((stop) => stop.place_role === 'work_place').sort((a, b) => b.visit_number - a.visit_number)[0] ?? null, [stops]);
  const complainantStop = useMemo(() => stops.filter((stop) => stop.place_role === 'harmed_party_place').sort((a, b) => b.visit_number - a.visit_number)[0] ?? null, [stops]);
  const arrivedAtSource = Boolean(sourceStop?.actual_arrived_at && !sourceStop.actual_departed_at);
  const endInForce = useMemo(() => sourceHistory.find((row) => row.end_expires_at && new Date(row.end_expires_at) > new Date()) ?? null, [sourceHistory]);
  const jobAssessments = useMemo(() => assessments.filter((a) => a.dispatch_job_id && a.dispatch_job_id === selectedJobId), [assessments, selectedJobId]);
  const sourceArrivalBreached = Boolean(selectedJob && sourceStop?.actual_arrived_at && (selectedJob.sla_breached || (selectedJob.sla_respond_by && new Date(sourceStop.actual_arrived_at) > new Date(selectedJob.sla_respond_by))));

  const volumeScore = form.volume_score === '' ? null : Number(form.volume_score);
  const matrixTotal = volumeScore === null ? null : volumeScore === 0 ? 0 : volumeScore + currentTimeScore() + Number(form.tone_score);
  const isStatutory = STATUTORY_ACTIONS.includes(form.action_taken);
  const statutoryNumberMissing = isStatutory && !form.end_number.trim() && !form.notice_number.trim();
  const endWithoutComplaint = form.action_taken === 'direction_notice' && !selectedJob;
  const seizureWithoutPolice = form.action_taken === 'equipment_seized' && !form.police_present;
  const canSubmit = Boolean(form.noise_source.trim() && form.noise_source_address.trim() && form.scene_description.trim() && form.volume_score !== '' && form.hs_checklist_completed) && !statutoryNumberMissing && !endWithoutComplaint && !seizureWithoutPolice;

  // ATLAS READS: noise_assessments
  const loadAssessments = useCallback(async () => {
    if (!profile?.id || !profile?.organizationId) {
      setAssessments([]);
      setError('Organisation access could not be confirmed. Noise assessments are unavailable.');
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const activeZoneIds = selectedAgreementZones.length > 0 ? selectedAgreementZones.map((zone) => zone.id) : null;
      const query = supabase
        .from('noise_assessments')
        .select('id, decibel_reading, noise_source, noise_source_address, prior_notice_count, action_taken, scene_description, assessed_at, review_status, reviewed_at, review_notes, follow_up_required, end_number, end_expires_at, assessment_distance_to_complainant_m, dispatch_job_id')
        .eq('officer_user_id', profile.id)
        .order('assessed_at', { ascending: false });
      const { data, error: err } = activeZoneIds && activeZoneIds.length > 0
        ? await query.in('zone_id', activeZoneIds)
        : await query.eq('organization_id', profile.organizationId ?? '');
      if (err) throw err;
      setAssessments((data as NoiseAssessment[]) || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load noise assessments');
    } finally {
      setLoading(false);
    }
  }, [profile?.id, profile?.organizationId, selectedAgreementZones]);

  // ATLAS READS: dispatch_jobs, client_sites
  const loadJobs = useCallback(async () => {
    if (!profile?.id || !profile?.organizationId) return;
    const { data, error: err } = await supabase
      .from('dispatch_jobs')
      .select('id, job_type, priority, status, briefing_notes, sla_respond_by, sla_breached, sla_delay_reason, dispatched_at, on_scene_at, client_site_id, harmed_party_site_id, harmed_party_address, shift_id')
      .eq('organization_id', profile.organizationId)
      .or('module_key.eq.noise_control,job_type.eq.noise_control')
      .in('status', ACTIVE_DISPATCH_JOB_STATUSES as readonly string[])
      .or(`assigned_officer_id.eq.${profile.id}${activeShift?.id ? `,shift_id.eq.${activeShift.id}` : ''}`)
      .order('sla_respond_by', { ascending: true });
    if (err) { setError(err.message); return; }
    const rows = (data as NoiseJob[]) || [];
    setJobs(rows);
    const siteIds = [...new Set(rows.flatMap((job) => [job.client_site_id, job.harmed_party_site_id]).filter((id): id is string => Boolean(id)))];
    if (siteIds.length) {
      const { data: siteRows } = await supabase.from('client_sites').select('id, name, address').in('id', siteIds);
      setSites(Object.fromEntries(((siteRows as Array<{ id: string; name: string | null; address: string | null }>) || []).map((site) => [site.id, { name: site.name, address: site.address }])));
    }
  }, [profile?.id, profile?.organizationId, activeShift?.id]);

  // ATLAS READS: shift_stops, job_party_interactions, noise_assessments (source dossier)
  const loadJobDetail = useCallback(async (job: NoiseJob | null) => {
    if (!job) { setStops([]); setInteractions([]); setSourceHistory([]); return; }
    const [stopResult, interactionResult, historyResult] = await Promise.all([
      supabase.from('shift_stops').select('id, place_role, visit_number, status, actual_arrived_at, actual_departed_at, arrival_verification, arrival_distance_m, sla_status').eq('dispatch_job_id', job.id).order('visit_number', { ascending: true }),
      supabase.from('job_party_interactions').select('id, party_role, mode, occurred_at, summary').eq('dispatch_job_id', job.id).order('occurred_at', { ascending: true }),
      job.client_site_id
        ? supabase.from('noise_assessments').select('id, assessed_at, action_taken, end_number, end_expires_at, permanent_abatement_active, is_problem_address, hs_flag_active, hs_notes').eq('site_id', job.client_site_id).order('assessed_at', { ascending: false }).limit(10)
        : Promise.resolve({ data: [], error: null }),
    ]);
    setStops((stopResult.data as JobStop[]) || []);
    setInteractions((interactionResult.data as JobInteraction[]) || []);
    setSourceHistory((historyResult.data as SourceHistory[]) || []);
  }, []);

  useEffect(() => { void loadAssessments(); }, [loadAssessments]);
  useEffect(() => { void loadJobs(); }, [loadJobs]);
  useEffect(() => { void loadJobDetail(selectedJob); setRevealedContact(null); }, [selectedJob, loadJobDetail]);
  useEffect(() => { if (requestedAssessmentId) document.getElementById(`officer-noise-${requestedAssessmentId}`)?.scrollIntoView({ block: 'center' }); }, [assessments, requestedAssessmentId]);
  useEffect(() => {
    if (!selectedJob) return;
    const sourceAddress = sites[selectedJob.client_site_id ?? '']?.address ?? '';
    setForm((current) => (current.noise_source_address.trim() ? current : { ...current, noise_source_address: sourceAddress }));
  }, [selectedJob, sites]);

  const runCommand = async (label: string, command: () => Promise<void>) => {
    try {
      setBusy(label);
      setError(null);
      setNotice(null);
      await command();
    } catch (err) {
      setError(err instanceof Error ? err.message : (err as { message?: string }).message ?? `${label} failed`);
    } finally {
      setBusy(null);
    }
  };

  const arriveAt = (placeRole: 'work_place' | 'harmed_party_place') => runCommand('arrive', async () => {
    if (!selectedJob) return;
    // ATLAS WRITES: arrive_at_dispatch_place
    const { data, error: err } = await supabase.rpc('arrive_at_dispatch_place', {
      p_client_request_id: crypto.randomUUID(),
      p_dispatch_job_id: selectedJob.id,
      p_place_role: placeRole,
      p_gps_lat: arrivalGps.lat,
      p_gps_lng: arrivalGps.lng,
      p_gps_accuracy: arrivalGps.accuracy,
      p_bwc_reference: bwcReference.trim() || null,
    });
    const receipt = (data as Array<{ stop_id: string; arrival_verification: string; arrival_distance_m: number | null }> | null)?.[0];
    if (err || !receipt?.stop_id) throw err ?? new Error('Arrival receipt was not confirmed.');
    setNotice(`Arrival recorded — ${VERIFICATION_LABEL[receipt.arrival_verification] ?? receipt.arrival_verification}${receipt.arrival_distance_m != null ? ` (${receipt.arrival_distance_m} m)` : ''}.`);
    await Promise.all([loadJobDetail(selectedJob), loadJobs()]);
  });

  const departFrom = (stop: JobStop) => runCommand('depart', async () => {
    // ATLAS WRITES: depart_dispatch_place
    const { data, error: err } = await supabase.rpc('depart_dispatch_place', {
      p_client_request_id: crypto.randomUUID(),
      p_stop_id: stop.id,
      p_officer_notes: null,
      p_gps_lat: arrivalGps.lat,
      p_gps_lng: arrivalGps.lng,
      p_sla_delay_reason: delayReason.trim() || null,
    });
    const receipt = (data as Array<{ stop_id: string; sla_status: string }> | null)?.[0];
    if (err || !receipt?.stop_id) throw err ?? new Error('Departure receipt was not confirmed.');
    setNotice(`Departure recorded (${receipt.sla_status.replaceAll('_', ' ')}).`);
    setDelayReason('');
    await Promise.all([loadJobDetail(selectedJob), loadJobs()]);
  });

  const revealComplainant = () => runCommand('reveal', async () => {
    if (!selectedJob) return;
    // ATLAS READS: get_dispatch_job_protected_party (guarded, audited)
    const { data, error: err } = await supabase.rpc('get_dispatch_job_protected_party', { p_dispatch_job_id: selectedJob.id, p_party_role: 'complainant' });
    if (err) throw err;
    const party = data as { available: boolean; display_name?: string | null; phone?: string | null } | null;
    setRevealedContact(party?.available ? { display_name: party.display_name ?? null, phone: party.phone ?? null } : 'unavailable');
  });

  const recordContact = () => runCommand('contact', async () => {
    if (!selectedJob) return;
    const inPerson = contact.mode === 'in_person';
    // ATLAS WRITES: record_job_party_interaction
    const { data, error: err } = await supabase.rpc('record_job_party_interaction', {
      p_client_request_id: crypto.randomUUID(),
      p_dispatch_job_id: selectedJob.id,
      p_party_role: 'complainant',
      p_mode: contact.mode,
      p_occurred_at: new Date().toISOString(),
      p_summary: contact.summary.trim() || null,
      p_noise_assessment_id: jobAssessments[0]?.id ?? null,
      p_shift_stop_id: inPerson ? complainantStop?.id ?? null : null,
      p_gps_lat: inPerson ? arrivalGps.lat : null,
      p_gps_lng: inPerson ? arrivalGps.lng : null,
      p_gps_accuracy: inPerson ? arrivalGps.accuracy : null,
    });
    const receipt = (data as Array<{ id: string }> | null)?.[0];
    if (err || !receipt?.id) throw err ?? new Error('Interaction receipt was not confirmed.');
    setContact({ mode: 'phone', summary: '' });
    setRevealedContact(null);
    setNotice('Complainant contact recorded and linked to this job.');
    await loadJobDetail(selectedJob);
  });

  const resolveNoiseSourceAddress = async () => {
    const query = form.noise_source_address.trim() || form.noise_source.trim();
    if (!query) return;
    setAddressResolution({ status: 'resolving', message: null });
    try {
      const candidate = (await resolveAddressCandidates(query, 1))[0];
      if (!candidate) { setAddressResolution({ status: 'unavailable', message: 'No address match was returned.' }); return; }
      setForm((current) => ({ ...current, noise_source_address: candidate.label }));
      setAddressResolution({ status: 'resolved', message: candidate.label });
    } catch (err) {
      setAddressResolution({ status: 'unavailable', message: err instanceof Error ? err.message : 'Address could not be resolved.' });
    }
  };

  const captureAssessmentPosition = () => captureGps(setGps, async (lat, lng) => {
    try {
      const address = await resolveAddressForCoordinates(lat, lng);
      if (address) setForm((current) => (current.assessment_location.trim() ? current : { ...current, assessment_location: address.label }));
    } catch { /* GPS evidence is retained even when address resolution is unavailable. */ }
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile?.id || !profile?.organizationId) return;
    const submittedAction = form.action_taken;
    void runCommand('submit', async () => {
      // ATLAS WRITES: submit_officer_noise_assessment
      const { data, error: err } = await supabase.rpc('submit_officer_noise_assessment', {
        p_client_request_id: crypto.randomUUID(),
        p_assessed_at: new Date().toISOString(),
        p_noise_source: form.noise_source.trim(),
        p_noise_source_address: form.noise_source_address.trim(),
        p_action_taken: form.action_taken,
        p_volume_score: Number(volumeScore) || 0,
        p_time_score: volumeScore === 0 ? 1 : currentTimeScore(),
        p_tone_score: volumeScore === 0 ? 0 : Number(form.tone_score),
        p_notice_number: form.notice_number.trim() || null,
        p_end_number: form.end_number.trim() || null,
        p_occupant_name: form.occupant_name.trim() || null,
        p_police_requested: form.police_requested,
        p_police_present: form.police_present,
        p_scene_description: form.scene_description.trim() || null,
        p_follow_up_required: form.follow_up_required,
        p_shift_id: activeShift?.id ?? selectedJob?.shift_id ?? null,
        p_dispatch_job_id: selectedJob?.id ?? null,
        p_gps_lat: gps.lat,
        p_gps_lng: gps.lng,
      });
      const receipt = (data as Array<{ id: string }> | null)?.[0];
      if (err || !receipt?.id) throw err ?? new Error('Noise assessment receipt was not confirmed.');
      setForm(EMPTY_FORM);
      setGps(IDLE_GPS);
      setShowForm(false);
      setNotice(submittedAction === 'direction_notice' ? 'Assessment recorded. The excessive noise direction binds this place for the period in the council rule (statutory maximum 8 days).' : 'Assessment recorded.');
      await Promise.all([loadAssessments(), loadJobDetail(selectedJob)]);
    });
  };

  const placeLabel = (siteId: string | null, fallback: string | null) => sites[siteId ?? '']?.address ?? sites[siteId ?? '']?.name ?? fallback ?? 'Address not recorded';

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
        <p className="subtitle">{jobs.length} open complaint job{jobs.length === 1 ? '' : 's'} · {assessments.length} assessments recorded{moduleContext.governingJurisdictionName ? ` · ${moduleContext.governingJurisdictionName}` : ''}</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">×</button>
          {error}
        </div>
      )}
      {notice && <div className="alert" role="status">{notice}</div>}

      <section aria-label="Complaint jobs">
        {jobs.length === 0 ? (
          <div className="empty-state"><p>No open noise complaint jobs are assigned to you. You can still record an officer-initiated assessment below; an excessive noise direction needs a received complaint (RMA s327).</p></div>
        ) : jobs.map((job) => {
          const isSelected = job.id === selectedJobId;
          const breached = Boolean(job.sla_breached || (job.sla_respond_by && !job.on_scene_at && new Date(job.sla_respond_by) < new Date()));
          return (
            <article key={job.id} className={`noise-job-card ${isSelected ? 'is-selected' : ''}`}>
              <div className="noise-job-header">
                <h3>Noise complaint · {job.priority}</h3>
                <span className={`noise-sla ${breached ? 'is-breached' : ''}`}>{job.sla_respond_by ? `${breached ? 'SLA breached · ' : ''}respond by ${clock(job.sla_respond_by)}` : 'No SLA clock'}</span>
              </div>
              <div className="noise-places">
                <div className="noise-place">
                  <span className="noise-place-label">Noise source · work place</span>
                  <span className="noise-place-address">{placeLabel(job.client_site_id, null)}</span>
                  <span className="noise-place-note">Assessment, direction and seizure are recorded against this address.</span>
                </div>
                <div className="noise-place">
                  <span className="noise-place-label">Complainant place · protected</span>
                  <span className="noise-place-address">{job.harmed_party_site_id || job.harmed_party_address ? placeLabel(job.harmed_party_site_id, job.harmed_party_address) : 'Not recorded by dispatch'}</span>
                  <span className="noise-place-note">Assess from as close to this address as a public position allows. Never on a served document.</span>
                </div>
              </div>
              {job.briefing_notes && <p className="contact-meta">{job.briefing_notes}</p>}
              <button className={`btn ${isSelected ? 'btn-secondary' : 'btn-primary'} btn-block`} onClick={() => { setSelectedJobId(isSelected ? null : job.id); setShowForm(false); }}>
                {isSelected ? 'Close this job' : 'Work this job'}
              </button>
            </article>
          );
        })}
      </section>

      {selectedJob && (
        <section className="noise-steps" aria-label="Job steps">
          <div className="noise-step">
            <div className="noise-step-title"><ShieldAlert size={16} /> Pre-arrival dossier · source address</div>
            <div className="noise-dossier">
              {endInForce ? <span className="noise-flag is-danger">END in force until {new Date(endInForce.end_expires_at ?? '').toLocaleString('en-NZ')} ({endInForce.end_number ?? 'no number'})</span> : <span className="noise-flag is-ok">No excessive noise direction in force</span>}
              {sourceHistory.some((row) => row.permanent_abatement_active) && <span className="noise-flag is-danger">Permanent abatement on record</span>}
              {sourceHistory.some((row) => row.is_problem_address) && <span className="noise-flag is-warn">Problem address</span>}
              {sourceHistory.some((row) => row.hs_flag_active) && <span className="noise-flag is-danger">H&amp;S flag — read notes before approaching</span>}
              <span className="noise-flag is-ok">{sourceHistory.length} prior assessment{sourceHistory.length === 1 ? '' : 's'} at this address</span>
            </div>
            {sourceHistory.filter((row) => row.hs_flag_active && row.hs_notes).slice(0, 1).map((row) => <p key={row.id} className="contact-meta">{row.hs_notes}</p>)}
          </div>

          <div className={`noise-step ${arrivedAtSource || sourceStop?.actual_departed_at ? 'is-done' : ''}`}>
            <div className="noise-step-title">{arrivedAtSource ? <CheckCircle2 size={16} /> : <MapPin size={16} />} Attendance · source</div>
            {stops.map((stop) => (
              <div key={stop.id} className="noise-stop-row">
                <span>{stop.place_role === 'work_place' ? 'Source' : 'Complainant place'} · visit {stop.visit_number} · {stop.actual_arrived_at ? `arrived ${clock(stop.actual_arrived_at)}` : 'not arrived'}{stop.actual_departed_at ? ` · departed ${clock(stop.actual_departed_at)}` : ''}</span>
                {stop.arrival_verification && <span className={`noise-verification is-${stop.arrival_verification}`}>{VERIFICATION_LABEL[stop.arrival_verification] ?? stop.arrival_verification}{stop.arrival_distance_m != null ? ` · ${stop.arrival_distance_m} m` : ''}</span>}
              </div>
            ))}
            <div className="form-row">
              <div className="form-group">
                <label htmlFor="noise-bwc">Body-worn camera reference</label>
                <input id="noise-bwc" value={bwcReference} onChange={(e) => setBwcReference(e.target.value)} placeholder="Stated on camera at arrival" />
              </div>
              <div className="form-group">
                <button type="button" className="btn btn-secondary" onClick={() => captureGps(setArrivalGps)} disabled={arrivalGps.status === 'locating'}><Crosshair size={15} /> {arrivalGps.status === 'locating' ? 'Getting GPS fix' : arrivalGps.status === 'captured' ? `GPS fixed (±${Math.round(arrivalGps.accuracy ?? 0)} m)` : 'Get GPS fix'}</button>
              </div>
            </div>
            {sourceArrivalBreached && !selectedJob.sla_delay_reason && arrivedAtSource && (
              <div className="form-group">
                <label htmlFor="noise-delay-reason">Delay reason (SLA breached — the client report must state it)</label>
                <input id="noise-delay-reason" value={delayReason} onChange={(e) => setDelayReason(e.target.value)} />
              </div>
            )}
            <div className="noise-actions">
              {!arrivedAtSource && <button type="button" className="btn btn-primary" onClick={() => void arriveAt('work_place')} disabled={busy !== null}>{busy === 'arrive' ? <RefreshCw size={16} className="is-spinning" /> : <MapPin size={16} />} Arrive at source</button>}
              {sourceStop && arrivedAtSource && <button type="button" className="btn btn-secondary" onClick={() => void departFrom(sourceStop)} disabled={busy !== null}>{busy === 'depart' ? <RefreshCw size={16} className="is-spinning" /> : null} Depart source</button>}
            </div>
            {arrivalGps.status === 'unavailable' && <p className="form-hint">GPS unavailable — attendance will be recorded by time only and the report will say so.</p>}
          </div>

          <div className={`noise-step ${jobAssessments.length ? 'is-done' : ''}`}>
            <div className="noise-step-title">{jobAssessments.length ? <CheckCircle2 size={16} /> : <Search size={16} />} Assessment {jobAssessments.length ? `· ${jobAssessments.length} recorded` : ''}</div>
            {jobAssessments.map((a) => <p key={a.id} className="contact-meta">{a.action_taken?.replaceAll('_', ' ')}{a.assessment_distance_to_complainant_m != null ? ` · assessed ${a.assessment_distance_to_complainant_m} m from the complainant boundary` : ''}{a.end_expires_at ? ` · END in force until ${new Date(a.end_expires_at).toLocaleString('en-NZ')}` : ''}</p>)}
            {!showForm && <button className="btn btn-primary btn-block" onClick={() => setShowForm(true)}>Record assessment</button>}
          </div>

          <div className={`noise-step ${interactions.length ? 'is-done' : ''}`}>
            <div className="noise-step-title"><Phone size={16} /> Complainant contact {interactions.length ? `· ${interactions.length} recorded` : '· optional'}</div>
            {interactions.map((i) => <p key={i.id} className="contact-meta">{i.mode.replaceAll('_', ' ')} · {clock(i.occurred_at)}{i.summary ? ` · ${i.summary}` : ''}</p>)}
            <div className="noise-contact-reveal">
              {revealedContact === null && <button type="button" className="btn btn-secondary btn-sm" onClick={() => void revealComplainant()} disabled={busy !== null}>Reveal complainant contact — this read is logged</button>}
              {revealedContact === 'unavailable' && <span>No complainant contact is recorded for this job, or your basis to read it has ended.</span>}
              {revealedContact && revealedContact !== 'unavailable' && <><span>{revealedContact.display_name ?? 'Name not recorded'}{revealedContact.phone ? ` · ${revealedContact.phone}` : ''}</span><small>Shown because you are the attending officer on a live job. Never repeat this to the noise source.</small></>}
            </div>
            <div className="form-row">
              <div className="form-group">
                <label htmlFor="noise-contact-mode">How you made contact</label>
                <select id="noise-contact-mode" value={contact.mode} onChange={(e) => setContact({ ...contact, mode: e.target.value })}>
                  <option value="phone">Phone</option>
                  <option value="in_person">In person (at the complainant's place)</option>
                  <option value="message">Message</option>
                  <option value="no_answer">No answer</option>
                </select>
              </div>
              <div className="form-group">
                <label htmlFor="noise-contact-summary">What was said (no names)</label>
                <input id="noise-contact-summary" value={contact.summary} onChange={(e) => setContact({ ...contact, summary: e.target.value })} />
              </div>
            </div>
            <div className="noise-actions">
              {contact.mode === 'in_person' && !complainantStop?.actual_arrived_at && <button type="button" className="btn btn-secondary" onClick={() => void arriveAt('harmed_party_place')} disabled={busy !== null || !(selectedJob.harmed_party_site_id || selectedJob.harmed_party_address)}><MapPin size={16} /> Arrive at complainant place</button>}
              <button type="button" className="btn btn-primary" onClick={() => void recordContact()} disabled={busy !== null || (contact.mode === 'in_person' && !complainantStop?.actual_arrived_at)}>{busy === 'contact' ? <RefreshCw size={16} className="is-spinning" /> : null} Record contact</button>
              {complainantStop?.actual_arrived_at && !complainantStop.actual_departed_at && <button type="button" className="btn btn-secondary" onClick={() => void departFrom(complainantStop)} disabled={busy !== null}>Depart complainant place</button>}
            </div>
          </div>
        </section>
      )}

      {!selectedJob && <button className="btn btn-secondary btn-sm" onClick={() => setShowForm(!showForm)}>{showForm ? 'Cancel' : '+ Officer-initiated assessment (no complaint job)'}</button>}

      {showForm && (
        <form className="assessment-form" onSubmit={handleSubmit}>
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="noise-decibels">Decibel reading</label>
              <input id="noise-decibels" type="number" min="0" max="160" step="0.1" value={form.decibel_reading} onChange={(e) => setForm({ ...form, decibel_reading: e.target.value })} />
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
            <label htmlFor="noise-assessment-location">Assessment position</label>
            <input id="noise-assessment-location" value={form.assessment_location} onChange={(e) => setForm({ ...form, assessment_location: e.target.value })} placeholder="Public position as near the complainant as possible" />
            <button type="button" className="btn btn-secondary btn-sm" onClick={captureAssessmentPosition} disabled={gps.status === 'locating'}><Crosshair size={15} /> {gps.status === 'locating' ? 'Capturing position' : gps.status === 'captured' ? 'Refresh GPS position' : 'Capture GPS position'}</button>
            <p className="noise-legal-note">The server records how far this position is from the complainant's boundary and from the source; the report states the distance, never the complainant's address (RMA s326: judged by its effect on a person not at the emitting place).</p>
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
            <select id="noise-action" value={form.action_taken} onChange={(e) => setForm({ ...form, action_taken: e.target.value })}>{ACTIONS.map((action) => <option key={action} value={action} disabled={action === 'direction_notice' && !selectedJob}>{action.replaceAll('_', ' ')}{action === 'direction_notice' && !selectedJob ? ' — needs a complaint job (s327)' : ''}</option>)}</select>
          </div>
          {isStatutory && (
            <div className="form-row">
              <div className="form-group"><label htmlFor="noise-end-number">END number</label><input id="noise-end-number" value={form.end_number} onChange={(e) => setForm({ ...form, end_number: e.target.value })} /></div>
              <div className="form-group"><label htmlFor="noise-notice-number">Notice number</label><input id="noise-notice-number" value={form.notice_number} onChange={(e) => setForm({ ...form, notice_number: e.target.value })} /></div>
            </div>
          )}
          <div className="form-group">
            <label htmlFor="noise-occupant">Occupier / responsible person (source side)</label>
            <input id="noise-occupant" value={form.occupant_name} onChange={(e) => setForm({ ...form, occupant_name: e.target.value })} />
          </div>
          <label className="form-checkbox"><input type="checkbox" checked={form.police_requested} onChange={(e) => setForm({ ...form, police_requested: e.target.checked })} /> Police requested</label>
          <label className="form-checkbox"><input type="checkbox" checked={form.police_present} onChange={(e) => setForm({ ...form, police_present: e.target.checked })} /> Police present (required for seizure — RMA s328(3))</label>
          <label className="form-checkbox"><input type="checkbox" checked={form.follow_up_required} onChange={(e) => setForm({ ...form, follow_up_required: e.target.checked })} /> Follow-up required</label>
          <label className="form-checkbox"><input type="checkbox" checked={form.hs_checklist_completed} onChange={(e) => setForm({ ...form, hs_checklist_completed: e.target.checked })} /> H&amp;S pre-visit check completed</label>
          {statutoryNumberMissing && <p className="form-hint">A notice or END number is required for a statutory action.</p>}
          {endWithoutComplaint && <p className="form-hint">An excessive noise direction needs a received complaint: work the complaint job, or record the assessment with another action.</p>}
          {seizureWithoutPolice && <p className="form-hint">Seizure is exercised accompanied by a constable. Tick "Police present" only when they are.</p>}
          <button type="submit" className="btn btn-primary btn-block" disabled={busy !== null || !canSubmit}>
            {busy === 'submit' ? <><RefreshCw size={16} className="is-spinning" />Saving assessment</> : 'Submit Assessment'}
          </button>
        </form>
      )}

      <div className="contacts-list" style={{ marginTop: '12px' }}>
        {assessments.length === 0 ? (
          <div className="empty-state"><p>No assessments recorded yet.</p></div>
        ) : (
          assessments.map((a) => (
            <div key={a.id} id={`officer-noise-${a.id}`} className={`contact-card ${a.id === requestedAssessmentId ? 'is-context-focus' : ''}`}>
              <div className="contact-header">
                <h3>{a.noise_source || 'Noise complaint'}</h3>
                {a.decibel_reading != null && <span className="badge">{a.decibel_reading} dB</span>}
              </div>
              <div className="contact-details">
                {a.noise_source_address && <p className="contact-meta">{a.noise_source_address}</p>}
                {a.scene_description && <p>{a.scene_description}</p>}
                <p className="contact-meta">{a.prior_notice_count} prior notice(s) · {new Date(a.assessed_at).toLocaleString()}</p>
                {a.action_taken && <p className="contact-meta">Action: {a.action_taken.replaceAll('_', ' ')}{a.end_number ? ` · ${a.end_number}` : ''}{a.end_expires_at ? ` · in force until ${new Date(a.end_expires_at).toLocaleString('en-NZ')}` : ''}</p>}
                {a.assessment_distance_to_complainant_m != null && <p className="contact-meta">Assessed {a.assessment_distance_to_complainant_m} m from the complainant boundary</p>}
                {a.review_status !== 'open' && <section className="noise-officer-review"><strong>Supervisor review · {a.review_status.replaceAll('_', ' ')}</strong><span>{a.review_notes ?? 'Review note unavailable'}</span><small>{a.follow_up_required ? 'Follow-up required' : 'No further follow-up'}{a.reviewed_at ? ` · ${new Date(a.reviewed_at).toLocaleString('en-NZ')}` : ''}</small></section>}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default OfficerNoiseControlPage;
