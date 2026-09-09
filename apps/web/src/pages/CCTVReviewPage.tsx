import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  Car,
  CheckCircle2,
  CircleDot,
  Clock3,
  Eye,
  FileVideo2,
  Maximize2,
  Play,
  RotateCcw,
  RefreshCw,
  ShieldAlert,
  UserRound,
  X,
  XCircle,
  Trash2,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { consolidateResultData } from '../lib/motionConsolidation';
import type {
  ConsolidatedFaceEvent,
  ConsolidatedPersonEvent,
  ConsolidatedVehicleEvent,
  KeyframeItem,
} from '../lib/motionConsolidation';
import './PageStyles.css';
import './CCTVReviewPage.css';

type ReviewFilter = 'all' | 'queued' | 'processing' | 'manual_review_required' | 'complete' | 'failed' | 'archived';

type CCTVJob = {
  id: string;
  evidence_item_id: string | null;
  domain: string;
  status: string;
  stage?: string | null;
  error_message?: string | null;
  attempt_count?: number | null;
  progress_percent?: number | null;
  progress_current?: number | null;
  progress_total?: number | null;
  progress_label?: string | null;
  created_at: string;
  evidence: {
    storage_path: string | null;
    evidence_kind: string;
    metadata: Record<string, unknown> | null;
  } | null;
  result: { status: string; result: Record<string, unknown> } | null;
};

type PersonRecordOption = {
  id: string;
  display_name: string | null;
  review_state: string;
  metadata: Record<string, unknown> | null;
};

type FaceObservationLink = {
  id: string;
  person_record_id: string | null;
  metadata: {
    candidates?: FaceCandidate[];
    original_thumbnail?: string | null;
  } | null;
};

type FaceCandidate = {
  person_record_id: string;
  display_name: string;
  similarity: number;
  reference_thumbnail: string | null;
  review_state: string;
};

type CCTVReviewPageProps = {
  initialFilter?: ReviewFilter;
  libraryMode?: boolean;
};

const CCTV_DOMAINS = ['video_motion', 'vehicle', 'face'] as const;

const FILTERS: Array<{ value: ReviewFilter; label: string }> = [
  { value: 'all', label: 'All work' },
  { value: 'queued', label: 'Queued' },
  { value: 'processing', label: 'Processing' },
  { value: 'manual_review_required', label: 'Needs review' },
  { value: 'complete', label: 'Complete' },
  { value: 'failed', label: 'Failed' },
  { value: 'archived', label: 'Archived' },
];

function statusLabel(status: string): string {
  return status.replace(/_/g, ' ');
}

function timeLabel(value: string): string {
  return new Date(value).toLocaleString('en-NZ', { dateStyle: 'medium', timeStyle: 'short' });
}

const PROGRESS_STAGES = ['loading_evidence', 'converting', 'extracting_motion', 'running_inference', 'running_alpr', 'consolidating_observations', 'persisting_result'];

function progressLabel(job: CCTVJob): string {
  return job.progress_label || (job.stage ? statusLabel(job.stage) : statusLabel(job.status));
}

export const CCTVReviewPage: React.FC<CCTVReviewPageProps> = ({ initialFilter = 'all', libraryMode = false }) => {
  const { profile } = useAuth();
  const [jobs, setJobs] = useState<CCTVJob[]>([]);
  const [filter, setFilter] = useState<ReviewFilter>(initialFilter);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoLoading, setVideoLoading] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'events' | 'keyframes' | 'raw'>('events');
  const [enlargedImage, setEnlargedImage] = useState<{ src: string; title: string; subtitle?: string } | null>(null);
  const [personRecords, setPersonRecords] = useState<PersonRecordOption[]>([]);
  const [faceObservationLinks, setFaceObservationLinks] = useState<Record<string, FaceObservationLink>>({});
  const [identityDrafts, setIdentityDrafts] = useState<Record<string, { personRecordId: string; displayName: string }>>({});
  const [identitySaving, setIdentitySaving] = useState<string | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [decisionSaving, setDecisionSaving] = useState(false);
  const [decisionMessage, setDecisionMessage] = useState<string | null>(null);
  const [jobAction, setJobAction] = useState<'retry' | 'cancel' | 'close' | 'archive' | 'delete' | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);

  const loadJobs = useCallback(async () => {
    if (!profile?.organizationId) return;
    setLoading(true);
    setError(null);
    try {
      let query = supabase
        .from('inference_jobs')
        .select(
          'id, evidence_item_id, domain, status, stage, error_message, attempt_count, progress_percent, progress_current, progress_total, progress_label, created_at, evidence:evidence_item_id(storage_path, evidence_kind, metadata), result:inference_results(status, result)'
        )
        .eq('organization_id', profile.organizationId)
        .in('domain', [...CCTV_DOMAINS])
        .order('created_at', { ascending: false })
        .limit(100);
      if (filter === 'all') query = query.neq('status', 'archived');
      else query = query.eq('status', filter);
      const { data, error: queryError } = await query;
      if (queryError) throw queryError;
      const mappedJobs = ((data ?? []) as unknown as CCTVJob[]).map((job) => ({
        ...job,
        result: Array.isArray(job.result) ? job.result[0] ?? null : job.result,
      }));
      setJobs(mappedJobs);
      if (!selectedId && mappedJobs[0]?.id) setSelectedId(mappedJobs[0].id);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'CCTV review data could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [filter, profile?.organizationId, selectedId]);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  useEffect(() => {
    if (!profile?.organizationId) return;
    const channel = supabase
      .channel(`cctv-review-${profile.organizationId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'inference_jobs', filter: `organization_id=eq.${profile.organizationId}` },
        () => void loadJobs()
      )
      .on(
        // The playback MP4 remux finishes after the job is already marked complete, so its
        // metadata update on evidence_items needs its own trigger to refresh the video player.
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'evidence_items', filter: `organization_id=eq.${profile.organizationId}` },
        () => void loadJobs()
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [loadJobs, profile?.organizationId]);

  const selected = jobs.find((job) => job.id === selectedId) ?? null;

  const manageJob = useCallback(async (job: CCTVJob, action: 'retry' | 'cancel' | 'close' | 'archive' | 'delete') => {
    if (!profile?.organizationId) return;
    const confirmation = action === 'archive'
      ? 'Archive this CCTV queue item? The video and inference record will be retained and available under Archived.'
      : action === 'delete'
        ? 'Delete this terminal CCTV job? The queue record and inference results will be permanently removed; the original evidence video will be retained.'
        : action === 'close'
          ? 'Close this failed CCTV job without retrying it?'
      : action === 'cancel'
        ? 'Cancel this CCTV job?'
        : 'Retry this CCTV job?';
    if (!window.confirm(confirmation)) return;
    setJobAction(action);
    setError(null);
    try {
      const { error: actionError } = await supabase.rpc('manage_cctv_inference_job', {
        p_job_id: job.id,
        p_organization_id: profile.organizationId,
        p_action: action,
      });
      if (actionError) throw actionError;
      if (action === 'archive' || action === 'delete') setSelectedId(null);
      await loadJobs();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : `CCTV job could not be updated.`);
    } finally {
      setJobAction(null);
    }
  }, [loadJobs, profile?.organizationId]);

  const manageSelectedJob = useCallback((action: 'retry' | 'cancel' | 'close' | 'archive' | 'delete') => {
    if (selected) void manageJob(selected, action);
  }, [manageJob, selected]);

  // Load Signed URL for the selected video
  useEffect(() => {
    let active = true;
    const fetchSignedUrl = async () => {
      if (!selected?.evidence?.storage_path) {
        setVideoUrl(null);
        setVideoLoading(false);
        setVideoError(null);
        return;
      }
      setVideoLoading(true);
      setVideoError(null);
      const bucket = String(selected.evidence.metadata?.storage_bucket || 'bob-uploads');
      const playbackPath = selected.evidence.metadata?.playback_storage_path;
      const rawFileType = String(selected.evidence.metadata?.file_type || '');
      // Raw h264/h265 elementary streams (direct SD-card extraction) cannot play in a <video>
      // element until the vision worker remuxes them into MP4; show that state instead of a
      // broken player.
      if (!playbackPath && (rawFileType === 'video/h264' || rawFileType === 'video/h265')) {
        setVideoUrl(null);
        setVideoError('CONVERTING');
        setVideoLoading(false);
        return;
      }
      const storagePath = typeof playbackPath === 'string' ? playbackPath : selected.evidence.storage_path;
      try {
        const { data, error: signError } = await supabase.storage
          .from(bucket)
          .createSignedUrl(storagePath, 3600);
        if (signError) throw signError;
        if (active) {
          setVideoUrl(data?.signedUrl || null);
        }
      } catch (err) {
        if (active) {
          setVideoError(err instanceof Error ? err.message : 'Could not generate signed video URL.');
          setVideoUrl(null);
        }
      } finally {
        if (active) setVideoLoading(false);
      }
    };

    void fetchSignedUrl();
    return () => {
      active = false;
    };
  }, [selected?.id, selected?.evidence?.storage_path, selected?.evidence?.metadata?.storage_bucket, selected?.evidence?.metadata?.playback_storage_path, selected?.evidence?.metadata?.file_type]);

  // Consolidated observation data
  const consolidated = useMemo(() => {
    return consolidateResultData(selected?.result?.result);
  }, [selected?.result?.result]);

  useEffect(() => {
    let active = true;
    const loadFaceIdentityLinks = async () => {
      if (!profile?.organizationId || !selected?.evidence_item_id) {
        setPersonRecords([]);
        setFaceObservationLinks({});
        return;
      }
      const [{ data: observations, error: observationsError }, { data: records, error: recordsError }] = await Promise.all([
        supabase.from('face_observations').select('id, person_record_id, metadata').eq('organization_id', profile.organizationId).eq('evidence_item_id', selected.evidence_item_id),
        supabase.from('person_records').select('id, display_name, review_state, metadata').eq('organization_id', profile.organizationId).order('created_at', { ascending: true }),
      ]);
      if (!active) return;
      if (observationsError || recordsError) {
        setIdentityError(observationsError?.message || recordsError?.message || 'Face identity records could not be loaded.');
        return;
      }
      const nextRecords = (records ?? []) as PersonRecordOption[];
      const recordById = new Map(nextRecords.map((record) => [record.id, record]));
      const nextLinks: Record<string, FaceObservationLink> = {};
      for (const observation of (observations ?? []) as FaceObservationLink[]) {
        const record = observation.person_record_id ? recordById.get(observation.person_record_id) : null;
        const eventId = typeof record?.metadata?.source_event_id === 'string' ? record.metadata.source_event_id : null;
        if (eventId) nextLinks[eventId] = observation;
      }
      setPersonRecords(nextRecords);
      setFaceObservationLinks(nextLinks);
      setIdentityError(null);
    };
    void loadFaceIdentityLinks();
    return () => {
      active = false;
    };
  }, [profile?.organizationId, selected?.evidence_item_id]);

  const saveFaceIdentity = async (face: ConsolidatedFaceEvent) => {
    const link = faceObservationLinks[face.event_id];
    const draft = identityDrafts[face.event_id];
    if (!link?.id || !draft?.personRecordId) return;
    setIdentitySaving(face.event_id);
    setIdentityError(null);
    const { error: saveError } = await supabase.rpc('assign_face_observation_person', {
      p_observation_id: link.id,
      p_person_record_id: draft.personRecordId,
      p_display_name: draft.displayName.trim() || null,
    });
    if (saveError) {
      setIdentityError(saveError.message);
    } else {
      setPersonRecords((current) => current.map((record) => record.id === draft.personRecordId
        ? { ...record, display_name: draft.displayName.trim() || record.display_name }
        : record));
    }
    setIdentitySaving(null);
  };

  const recordReviewDecision = async (decision: 'confirmed' | 'dismissed') => {
    if (!selected || !profile?.organizationId) return;
    const reason = window.prompt(decision === 'confirmed' ? 'Record the verification reason.' : 'Record why this observation is dismissed.');
    if (!reason?.trim()) return;
    setDecisionSaving(true);
    setDecisionMessage(null);
    const { error: decisionError } = await supabase.rpc('record_cctv_review_decision', {
      p_job_id: selected.id,
      p_evidence_id: selected.evidence_item_id,
      p_organization_id: profile.organizationId,
      p_event_id: null,
      p_event_type: 'video',
      p_decision: decision,
      p_reason: reason.trim(),
    });
    setDecisionSaving(false);
    setDecisionMessage(decisionError ? decisionError.message : `Review decision recorded: ${decision}.`);
  };

  const jumpToTime = (seconds: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = Math.max(0, seconds);
      void videoRef.current.play().catch(() => {
        /* autoplay policy */
      });
    }
  };

  return (
    <div className="cctv-review-page">
      <header className="cctv-review-header">
        <div>
          <span>Field outcomes</span>
          <h1>{libraryMode ? 'Completed video library' : 'CCTV review'}</h1>
          <p>{libraryMode ? 'Review completed camera footage, keyframes, and governed observations.' : 'Review camera evidence, consolidated AI observations, and evidential findings.'}</p>
        </div>
        <button
          type="button"
          className="page-action"
          onClick={() => void loadJobs()}
          disabled={loading}
          title="Refresh CCTV review"
        >
          <RefreshCw size={17} className={loading ? 'is-spinning' : ''} /> Refresh
        </button>
      </header>

      <div className="cctv-review-layout">
        {/* Left Filter Rail */}
        <aside className="cctv-filter-rail" aria-label="CCTV review filters">
          <span>Review view</span>
          <h2>Work status</h2>
          {FILTERS.map((item) => (
            <button
              key={item.value}
              type="button"
              className={filter === item.value ? 'is-active' : ''}
              onClick={() => setFilter(item.value)}
            >
              {item.label}
              <strong>
                {item.value === 'all'
                  ? jobs.length
                  : jobs.filter((job) => job.status === item.value).length}
              </strong>
            </button>
          ))}
          <div className="cctv-review-note">
            <ShieldAlert size={17} />
            <span>
              Inference is advisory. Confirm identity, plate readings, and return visits against the primary video.
            </span>
          </div>
        </aside>

        {/* Center Queue List */}
        <section className="cctv-job-list" aria-label="CCTV review jobs">
          <div className="cctv-section-title">
            <div>
              <span>Evidence queue</span>
              <h2>{filter === 'all' ? 'Recent camera work' : statusLabel(filter)}</h2>
            </div>
            <strong>{jobs.length}</strong>
          </div>
          {error && (
            <div className="page-error">
              <AlertTriangle size={17} /> {error}
            </div>
          )}
          {loading ? (
            <div className="cctv-empty">
              <RefreshCw className="is-spinning" /> Loading review work
            </div>
          ) : jobs.length === 0 ? (
            <div className="cctv-empty">
              <FileVideo2 size={24} />
              <strong>No CCTV work here</strong>
              <span>Uploaded camera evidence will appear after an inference job is created.</span>
            </div>
          ) : (
            jobs.map((job) => {
              const jobConsolidated = consolidateResultData(job.result?.result);
              const faceCount = jobConsolidated.summary_counts.face_events;
              const personCount = jobConsolidated.summary_counts.person_events;
              const vehicleCount = jobConsolidated.summary_counts.vehicle_events;
              const frameCount = jobConsolidated.summary_counts.total_frames_parsed;

              return (
                <div key={job.id} className={`cctv-job-row ${selectedId === job.id ? 'is-selected' : ''}`}>
                  <button type="button" className="cctv-job-row-main" onClick={() => setSelectedId(job.id)}>
                    <span className="cctv-job-icon"><FileVideo2 size={19} /></span>
                    <span className="cctv-job-copy">
                      <strong>{job.evidence?.evidence_kind === 'photo' ? 'Camera snapshot' : 'CCTV video'}</strong>
                      <small>{timeLabel(job.created_at)} · {job.domain} · {String(job.id).slice(0, 8)}{job.stage ? ` · ${statusLabel(job.stage)}` : ''}</small>
                    </span>
                    <span className="cctv-job-findings">
                      {frameCount > 0 ? `${frameCount} frames` : 'Pending frames'}
                      {vehicleCount > 0 ? ` · ${vehicleCount} vehicle ${vehicleCount === 1 ? 'event' : 'events'}` : ''}
                      {faceCount + personCount > 0 ? ` · ${faceCount + personCount} person ${faceCount + personCount === 1 ? 'event' : 'events'}` : ''}
                    </span>
                    {['queued', 'processing'].includes(job.status) && (
                      <span className="cctv-progress-guide" aria-label={`Processing progress: ${progressLabel(job)}`}>
                        <span className="cctv-progress-track"><span style={{ width: `${Math.max(0, Math.min(100, job.progress_percent ?? 0))}%` }} /></span>
                        <small>{progressLabel(job)}{job.progress_total ? ` · ${job.progress_current ?? 0}/${job.progress_total}` : ''}</small>
                      </span>
                    )}
                    <span className={`cctv-status status-${job.status}`}><CircleDot size={13} /> {statusLabel(job.status)}</span>
                  </button>
                  {job.status === 'failed' && (
                    <div className="cctv-row-actions" aria-label="Failed CCTV job actions">
                      <button type="button" title="Retry failed job" disabled={jobAction !== null} onClick={() => void manageJob(job, 'retry')}><RotateCcw size={13} /><span>Retry</span></button>
                      <button type="button" title="Close failed job" disabled={jobAction !== null} onClick={() => void manageJob(job, 'close')}><XCircle size={13} /><span>Close</span></button>
                      <button type="button" title="Archive failed job" disabled={jobAction !== null} onClick={() => void manageJob(job, 'archive')}><Archive size={13} /><span>Archive</span></button>
                      <button type="button" title="Delete failed job" disabled={jobAction !== null} onClick={() => void manageJob(job, 'delete')}><Trash2 size={13} /><span>Delete</span></button>
                    </div>
                  )}
                  {job.error_message && <span className="cctv-job-error" title={job.error_message}>{job.error_message}</span>}
                </div>
              );
            })
          )}
        </section>

        {/* Right Detail Inspection Console */}
        <aside className="cctv-detail" aria-label="Selected CCTV evidence">
          {selected ? (
            <>
              <div className="cctv-detail-heading">
                <div>
                  <span>Evidence inspection</span>
                  <h2>{selected.evidence?.evidence_kind === 'photo' ? 'Camera snapshot' : 'CCTV video'}</h2>
                </div>
                <Eye size={19} />
              </div>

              <div className="cctv-card-actions">
                {['failed', 'inconclusive', 'manual_review_required'].includes(selected.status) && (
                  <button type="button" className="cctv-btn-jump" disabled={jobAction !== null} onClick={() => void manageSelectedJob('retry')}>
                    <RotateCcw size={13} /> {jobAction === 'retry' ? 'Retrying...' : 'Retry'}
                  </button>
                )}
                {['failed', 'inconclusive', 'manual_review_required'].includes(selected.status) && (
                  <button type="button" className="cctv-btn-jump" disabled={jobAction !== null} onClick={() => manageSelectedJob('close')}>
                    <XCircle size={13} /> {jobAction === 'close' ? 'Closing...' : 'Close'}
                  </button>
                )}
                {['queued', 'processing'].includes(selected.status) && (
                  <button type="button" className="cctv-btn-jump" disabled={jobAction !== null} onClick={() => void manageSelectedJob('cancel')}>
                    <XCircle size={13} /> {jobAction === 'cancel' ? 'Cancelling...' : 'Cancel'}
                  </button>
                )}
                {['complete', 'failed', 'inconclusive', 'manual_review_required', 'cancelled'].includes(selected.status) && (
                  <button type="button" className="cctv-btn-jump" disabled={jobAction !== null} onClick={() => void manageSelectedJob('archive')}>
                    <Archive size={13} /> {jobAction === 'archive' ? 'Archiving...' : 'Archive'}
                  </button>
                )}
                {['failed', 'inconclusive', 'cancelled', 'archived'].includes(selected.status) && (
                  <button type="button" className="cctv-btn-danger" disabled={jobAction !== null} onClick={() => manageSelectedJob('delete')}>
                    <Trash2 size={13} /> {jobAction === 'delete' ? 'Deleting...' : 'Delete job'}
                  </button>
                )}
              </div>

              {['queued', 'processing'].includes(selected.status) && (
                <div className="cctv-progress-panel" aria-label="CCTV processing progress">
                  <div className="cctv-progress-panel-heading"><strong>Processing progress</strong><span>{Math.round(selected.progress_percent ?? 0)}%</span></div>
                  <div className="cctv-progress-track cctv-progress-track-large"><span style={{ width: `${Math.max(0, Math.min(100, selected.progress_percent ?? 0))}%` }} /></div>
                  <div className="cctv-progress-steps">
                    {PROGRESS_STAGES.map((stage) => <span key={stage} className={selected.stage === stage ? 'is-current' : PROGRESS_STAGES.indexOf(selected.stage || '') > PROGRESS_STAGES.indexOf(stage) ? 'is-done' : ''}>{statusLabel(stage)}</span>)}
                  </div>
                  <small>{progressLabel(selected)}{selected.progress_total ? ` · iteration ${selected.progress_current ?? 0} of ${selected.progress_total}` : ''}</small>
                </div>
              )}

              {/* Video Player */}
              <div className="cctv-media-container">
                {videoLoading ? (
                  <div className="cctv-media-loading">
                    <RefreshCw className="is-spinning" size={20} />
                    <span>Loading secured video stream...</span>
                  </div>
                ) : videoUrl ? (
                  <div className="cctv-video-wrapper">
                    <video
                      ref={videoRef}
                      src={videoUrl}
                      controls
                      playsInline
                      preload="metadata"
                      className="cctv-video-player"
                    />
                  </div>
                ) : videoError === 'CONVERTING' ? (
                  <div className="cctv-media-loading">
                    <RefreshCw className="is-spinning" size={20} />
                    <span>Converting to a playable format for review...</span>
                  </div>
                ) : (
                  <div className="cctv-media-placeholder">
                    <FileVideo2 size={32} />
                    <span>{videoError || 'Video stream preview unavailable'}</span>
                  </div>
                )}
              </div>

              {/* Summary Stats Grid */}
              <div className="cctv-finding-grid">
                <div>
                  <UserRound size={17} />
                  <strong>{consolidated.summary_counts.face_events + consolidated.summary_counts.person_events}</strong>
                  <span>Consolidated Persons</span>
                </div>
                <div>
                  <Car size={17} />
                  <strong>{consolidated.summary_counts.vehicle_events}</strong>
                  <span>Consolidated Vehicles</span>
                </div>
                <div>
                  <FileVideo2 size={17} />
                  <strong>{consolidated.summary_counts.total_frames_parsed}</strong>
                  <span>Parsed Frames</span>
                </div>
              </div>
              {consolidated.quality_summary && (
                <div className="cctv-quality-panel" aria-label="Inference quality and governance">
                  <strong>Inference quality and governance</strong>
                  <span>{consolidated.quality_summary.review_required_count ?? 0} finding{consolidated.quality_summary.review_required_count === 1 ? '' : 's'} require human review.</span>
                  {(consolidated.quality_summary.single_frame_vehicle_count ?? 0) > 0 && <span>{consolidated.quality_summary.single_frame_vehicle_count} vehicle reading{consolidated.quality_summary.single_frame_vehicle_count === 1 ? '' : 's'} came from a single frame.</span>}
                  <span>Animal detection: {consolidated.quality_summary.animal_detection_status === 'model_not_staged' ? 'not enabled for this deployment' : consolidated.quality_summary.animal_detection_status || 'not reported'}.</span>
                </div>
              )}

              {/* Tabs */}
              <div className="cctv-tab-bar">
                <button
                  type="button"
                  className={activeTab === 'events' ? 'is-active' : ''}
                  onClick={() => setActiveTab('events')}
                >
                  Observations (
                  {consolidated.summary_counts.face_events + consolidated.summary_counts.person_events + consolidated.summary_counts.vehicle_events})
                </button>
                <button
                  type="button"
                  className={activeTab === 'keyframes' ? 'is-active' : ''}
                  onClick={() => setActiveTab('keyframes')}
                >
                  Frames ({consolidated.keyframes.length})
                </button>
                <button
                  type="button"
                  className={activeTab === 'raw' ? 'is-active' : ''}
                  onClick={() => setActiveTab('raw')}
                >
                  Provenance & Info
                </button>
              </div>

              {/* Tab 1: Consolidated Observation Events */}
              {activeTab === 'events' && (
                <div className="cctv-events-list">
                  {identityError && <div className="page-error">{identityError}</div>}
                  {consolidated.face_events.length === 0 && consolidated.person_events.length === 0 && consolidated.vehicle_events.length === 0 ? (
                    <div className="cctv-empty-small">
                      <Clock3 size={18} />
                      <span>No consolidated observations detected yet.</span>
                    </div>
                  ) : null}

                  {consolidated.person_events.map((person: ConsolidatedPersonEvent) => (
                    <div key={person.event_id} className="cctv-observation-card">
                      <div className="cctv-card-body">
                        <div className="cctv-card-header">
                          <span className="cctv-badge cctv-badge-confidence">Person detected</span>
                          <span className="cctv-badge cctv-badge-confidence">{Math.round(person.confidence * 100)}%</span>
                        </div>
                        <div className="cctv-card-meta">
                          <span><strong>Window:</strong> {person.first_seen_seconds}s – {person.last_seen_seconds}s</span>
                          <span><strong>Sightings:</strong> {person.frame_count} frames{person.visit_count ? ` · ${person.visit_count} visit${person.visit_count === 1 ? '' : 's'}` : ''}</span>
                          {person.attributes && (
                            <span>
                              <strong>Visual estimate:</strong>{' '}
                              {[person.attributes.upper_body_colour, person.attributes.lower_body_colour]
                                .filter((value): value is string => typeof value === 'string' && value.length > 0)
                                .map((value) => value.replaceAll('_', ' '))
                                .join(' upper/lower, ') || 'appearance unavailable'}
                              {' · height requires camera calibration'}
                            </span>
                          )}
                        </div>
                        <div className="cctv-card-actions">
                          <button type="button" className="cctv-btn-jump" onClick={() => jumpToTime(person.first_seen_seconds)}>
                            <Play size={12} /> Jump to {person.first_seen_seconds}s
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}

                  {/* Face Events */}
                  {consolidated.face_events.map((face: ConsolidatedFaceEvent) => (
                    <div key={face.event_id} className="cctv-observation-card">
                      <div className="cctv-card-thumb">
                        {face.thumbnail ? (
                          <button
                            type="button"
                            className="cctv-thumb-btn"
                            onClick={() =>
                              setEnlargedImage({
                                src: face.thumbnail!,
                                title: face.subject_label,
                                subtitle: `${face.first_seen_seconds}s - ${face.last_seen_seconds}s (${face.duration_seconds}s) · ${face.frame_count} frames`,
                              })
                            }
                            title="Click to enlarge face frame"
                          >
                            <img src={face.thumbnail} alt={face.subject_label} />
                            <Maximize2 size={12} className="cctv-thumb-zoom-icon" />
                          </button>
                        ) : (
                          <div className="cctv-no-thumb">
                            <UserRound size={22} />
                          </div>
                        )}
                      </div>
                      <div className="cctv-card-body">
                        <div className="cctv-card-header">
                          <span className="cctv-badge cctv-badge-person">
                            <UserRound size={12} /> {personRecords.find((record) => record.id === faceObservationLinks[face.event_id]?.person_record_id)?.display_name || face.subject_label}
                          </span>
                          {face.is_return ? (
                            <span className="cctv-badge cctv-badge-return">Return visit</span>
                          ) : (
                            <span className="cctv-badge cctv-badge-review">Review required</span>
                          )}
                        </div>
                        <div className="cctv-card-meta">
                          <span>
                            <strong>Window:</strong> {face.first_seen_seconds}s – {face.last_seen_seconds}s ({face.duration_seconds}s)
                          </span>
                          <span>
                            <strong>Sightings:</strong> {face.frame_count} frames{face.visit_count ? ` · ${face.visit_count} visit${face.visit_count === 1 ? '' : 's'}` : ''} consolidated
                          </span>
                        </div>
                        <div className="cctv-card-actions">
                          <button
                            type="button"
                            className="cctv-btn-jump"
                            onClick={() => jumpToTime(face.first_seen_seconds)}
                          >
                            <Play size={12} /> Jump to {face.first_seen_seconds}s
                          </button>
                        </div>
                        {faceObservationLinks[face.event_id]?.metadata?.candidates?.length ? (
                          <div className="cctv-candidate-list">
                            <strong>Potential matches for human review</strong>
                            {(faceObservationLinks[face.event_id].metadata?.candidates ?? []).map((candidate) => (
                              <div key={candidate.person_record_id} className="cctv-candidate-row">
                                {candidate.reference_thumbnail ? (
                                  <img src={candidate.reference_thumbnail} alt={`${candidate.display_name} reference`} />
                                ) : (
                                  <span className="cctv-candidate-no-thumb"><UserRound size={14} /></span>
                                )}
                                <span className="cctv-candidate-copy">
                                  <b>{candidate.display_name}</b>
                                  <small>{Math.round(candidate.similarity * 100)}% visual similarity · {candidate.review_state}</small>
                                </span>
                              </div>
                            ))}
                          </div>
                        ) : null}
                        {faceObservationLinks[face.event_id] ? (
                          <div className="cctv-identity-editor">
                            <label>
                              Person record
                              <select
                                value={identityDrafts[face.event_id]?.personRecordId || faceObservationLinks[face.event_id].person_record_id || ''}
                                onChange={(event) => {
                                  const personRecordId = event.target.value;
                                  const selectedRecord = personRecords.find((record) => record.id === personRecordId);
                                  setIdentityDrafts((current) => ({
                                    ...current,
                                    [face.event_id]: {
                                      personRecordId,
                                      displayName: current[face.event_id]?.displayName || selectedRecord?.display_name || '',
                                    },
                                  }));
                                }}
                              >
                                {personRecords.map((record) => (
                                  <option key={record.id} value={record.id}>
                                    {record.display_name || 'Unnamed person'}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label>
                              Display name
                              <input
                                value={identityDrafts[face.event_id]?.displayName ?? personRecords.find((record) => record.id === faceObservationLinks[face.event_id]?.person_record_id)?.display_name ?? ''}
                                onChange={(event) => setIdentityDrafts((current) => ({
                                  ...current,
                                  [face.event_id]: {
                                    personRecordId: current[face.event_id]?.personRecordId || faceObservationLinks[face.event_id].person_record_id || '',
                                    displayName: event.target.value,
                                  },
                                }))}
                              />
                            </label>
                            <button
                              type="button"
                              className="cctv-btn-jump"
                              disabled={identitySaving === face.event_id}
                              onClick={() => void saveFaceIdentity(face)}
                            >
                              {identitySaving === face.event_id ? 'Saving...' : 'Save identity'}
                            </button>
                          </div>
                        ) : (
                          <small className="cctv-identity-pending">Identity record pending for this observation.</small>
                        )}
                      </div>
                    </div>
                  ))}

                  {/* Vehicle Events */}
                  {consolidated.vehicle_events.map((veh: ConsolidatedVehicleEvent) => (
                    <div key={veh.event_id} className="cctv-observation-card">
                      <div className="cctv-card-thumb">
                        {veh.thumbnail ? (
                          <button
                            type="button"
                            className="cctv-thumb-btn"
                            onClick={() =>
                              setEnlargedImage({
                                src: veh.thumbnail!,
                                title: `Vehicle Plate: ${veh.plate}`,
                                subtitle: `${veh.first_seen_seconds}s - ${veh.last_seen_seconds}s · Confidence: ${Math.round(veh.confidence * 100)}%`,
                              })
                            }
                            title="Click to enlarge vehicle frame"
                          >
                            <img src={veh.thumbnail} alt={veh.plate} />
                            <Maximize2 size={12} className="cctv-thumb-zoom-icon" />
                          </button>
                        ) : (
                          <div className="cctv-no-thumb">
                            <Car size={22} />
                          </div>
                        )}
                      </div>
                      <div className="cctv-card-body">
                        <div className="cctv-card-header">
                          <span className="cctv-badge cctv-badge-vehicle"><Car size={12} /> Vehicle</span>
                          <span className="cctv-plate-value">Plate {veh.plate}</span>
                          {veh.is_return ? (
                            <span className="cctv-badge cctv-badge-return">Returned</span>
                          ) : (
                            <span className="cctv-badge cctv-badge-confidence">
                              {Math.round(veh.confidence * 100)}% ALPR
                            </span>
                          )}
                          {!veh.temporal_consensus && <span className="cctv-badge cctv-badge-review">Single-frame reading</span>}
                        </div>
                        <div className="cctv-card-meta">
                          <span>
                            <strong>Window:</strong> {veh.first_seen_seconds}s – {veh.last_seen_seconds}s ({veh.duration_seconds}s)
                          </span>
                          <span>
                            <strong>Sightings:</strong> {veh.frame_count} frames{veh.visit_count ? ` · ${veh.visit_count} visit${veh.visit_count === 1 ? '' : 's'}` : ''} consolidated
                          </span>
                          {(veh.vehicle_make || veh.vehicle_model || veh.vehicle_year || veh.vehicle_colour || veh.vehicle_type) && (
                            <span>
                              <strong>Vehicle:</strong>{' '}
                              {[veh.vehicle_make, veh.vehicle_model, veh.vehicle_year, veh.vehicle_colour, veh.vehicle_type]
                                .filter((value) => value !== null && value !== undefined && value !== '')
                                .join(' · ')}
                            </span>
                          )}
                          {veh.speed_px_per_second !== null && veh.speed_px_per_second !== undefined && (
                            <span>
                              <strong>Inferred speed:</strong>{' '}
                              {veh.speed_kmh !== null && veh.speed_kmh !== undefined
                                ? `${veh.speed_kmh.toFixed(1)} km/h`
                                : `${veh.speed_px_per_second.toFixed(1)} px/s · calibration required`}
                            </span>
                          )}
                        </div>
                        <div className="cctv-card-actions">
                          <button
                            type="button"
                            className="cctv-btn-jump"
                            onClick={() => jumpToTime(veh.first_seen_seconds)}
                          >
                            <Play size={12} /> Jump to {veh.first_seen_seconds}s
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Tab 2: Keyframes Gallery */}
              {activeTab === 'keyframes' && (
                <div className="cctv-keyframes-grid">
                  {consolidated.keyframes.length === 0 ? (
                    <div className="cctv-empty-small">
                      <Clock3 size={18} />
                      <span>No motion keyframes available for this job.</span>
                    </div>
                  ) : (
                    consolidated.keyframes.map((kf: KeyframeItem) => (
                      <div key={kf.sha256_hash} className="cctv-keyframe-item">
                        {kf.thumbnail ? (
                          <button
                            type="button"
                            className="cctv-keyframe-thumb"
                            onClick={() =>
                              setEnlargedImage({
                                src: kf.thumbnail!,
                                title: `Keyframe #${kf.frame_index}`,
                                subtitle: `Timestamp: ${kf.timestamp_seconds}s · Hash: ${kf.sha256_hash.slice(0, 16)}...`,
                              })
                            }
                            title="Click to view full keyframe"
                          >
                            <img src={kf.thumbnail} alt={`Frame ${kf.frame_index}`} />
                          </button>
                        ) : (
                          <div className="cctv-keyframe-thumb cctv-no-thumb">
                            <FileVideo2 size={20} />
                          </div>
                        )}
                        <div className="cctv-keyframe-label">
                          <button
                            type="button"
                            className="cctv-time-pill"
                            onClick={() => jumpToTime(kf.timestamp_seconds)}
                          >
                            <Play size={10} /> {kf.timestamp_seconds}s
                          </button>
                          <small>Frame #{kf.frame_index}</small>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}

              {/* Tab 3: Provenance & Raw Info */}
              {activeTab === 'raw' && (
                <dl className="cctv-provenance-list">
                  <div>
                    <dt>Job ID</dt>
                    <dd>{selected.id}</dd>
                  </div>
                  <div>
                    <dt>Captured</dt>
                    <dd>{timeLabel(selected.created_at)}</dd>
                  </div>
                  <div>
                    <dt>Storage Path</dt>
                    <dd>{selected.evidence?.storage_path || 'Not specified'}</dd>
                  </div>
                  <div>
                    <dt>Bucket</dt>
                    <dd>{String(selected.evidence?.metadata?.storage_bucket || 'bob-uploads')}</dd>
                  </div>
                  <div>
                    <dt>Domain</dt>
                    <dd>{selected.domain}</dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd>{statusLabel(selected.status)}</dd>
                  </div>
                </dl>
              )}

              {/* Governed Review Callout & Decision Buttons */}
              <div className="cctv-review-callout">
                <Clock3 size={17} />
                <div>
                  <strong>Governed Human Decision Required</strong>
                  <span>
                    Verify candidate plates and person identities before committing formal compliance or incident links.
                  </span>
                </div>
              </div>

              <div className="cctv-actions">
                <button
                  type="button"
                  className="cctv-btn-confirm"
                  disabled={decisionSaving || !profile?.organizationId || !selected}
                  onClick={() => void recordReviewDecision('confirmed')}
                  title="Confirm verified observations"
                >
                  <CheckCircle2 size={16} /> Confirm observation
                </button>
                <button
                  type="button"
                  className="cctv-btn-dismiss"
                  disabled={decisionSaving || !profile?.organizationId || !selected}
                  onClick={() => void recordReviewDecision('dismissed')}
                  title="Dismiss noise / false positive"
                >
                  <XCircle size={16} /> Dismiss
                </button>
              </div>
              {decisionMessage && <p className="cctv-decision-message" role="status">{decisionMessage}</p>}
            </>
          ) : (
            <div className="cctv-empty">
              <FileVideo2 size={24} />
              <strong>Select evidence</strong>
              <span>Choose a queue item to inspect its provenance, video stream, and findings.</span>
            </div>
          )}
        </aside>
      </div>

      {/* Frame Enlargement Modal */}
      {enlargedImage && (
        <div className="cctv-modal-overlay" onClick={() => setEnlargedImage(null)}>
          <div className="cctv-modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="cctv-modal-header">
              <div>
                <h3>{enlargedImage.title}</h3>
                {enlargedImage.subtitle && <p>{enlargedImage.subtitle}</p>}
              </div>
              <button
                type="button"
                className="cctv-modal-close"
                onClick={() => setEnlargedImage(null)}
                aria-label="Close"
              >
                <X size={20} />
              </button>
            </div>
            <div className="cctv-modal-body">
              <img src={enlargedImage.src} alt={enlargedImage.title} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CCTVReviewPage;
