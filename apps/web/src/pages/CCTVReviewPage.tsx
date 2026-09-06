import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Car,
  CheckCircle2,
  CircleDot,
  Clock3,
  Eye,
  FileVideo2,
  Maximize2,
  Play,
  RefreshCw,
  ShieldAlert,
  UserRound,
  X,
  XCircle,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { consolidateResultData } from '../lib/motionConsolidation';
import type {
  ConsolidatedFaceEvent,
  ConsolidatedVehicleEvent,
  KeyframeItem,
} from '../lib/motionConsolidation';
import './PageStyles.css';
import './CCTVReviewPage.css';

type ReviewFilter = 'all' | 'queued' | 'processing' | 'manual_review_required' | 'complete' | 'failed';

type CCTVJob = {
  id: string;
  evidence_item_id: string | null;
  domain: string;
  status: string;
  created_at: string;
  evidence: {
    storage_path: string | null;
    evidence_kind: string;
    metadata: Record<string, unknown> | null;
  } | null;
  result: { status: string; result: Record<string, unknown> } | null;
};

const CCTV_DOMAINS = ['video_motion', 'vehicle', 'face'] as const;

const FILTERS: Array<{ value: ReviewFilter; label: string }> = [
  { value: 'all', label: 'All work' },
  { value: 'queued', label: 'Queued' },
  { value: 'processing', label: 'Processing' },
  { value: 'manual_review_required', label: 'Needs review' },
  { value: 'complete', label: 'Complete' },
  { value: 'failed', label: 'Failed' },
];

function statusLabel(status: string): string {
  return status.replace(/_/g, ' ');
}

function timeLabel(value: string): string {
  return new Date(value).toLocaleString('en-NZ', { dateStyle: 'medium', timeStyle: 'short' });
}

export const CCTVReviewPage: React.FC = () => {
  const { profile } = useAuth();
  const [jobs, setJobs] = useState<CCTVJob[]>([]);
  const [filter, setFilter] = useState<ReviewFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoLoading, setVideoLoading] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'events' | 'keyframes' | 'raw'>('events');
  const [enlargedImage, setEnlargedImage] = useState<{ src: string; title: string; subtitle?: string } | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);

  const loadJobs = useCallback(async () => {
    if (!profile?.organizationId) return;
    setLoading(true);
    setError(null);
    try {
      let query = supabase
        .from('inference_jobs')
        .select(
          'id, evidence_item_id, domain, status, created_at, evidence:evidence_item_id(storage_path, evidence_kind, metadata), result:inference_results(status, result)'
        )
        .eq('organization_id', profile.organizationId)
        .in('domain', [...CCTV_DOMAINS])
        .order('created_at', { ascending: false })
        .limit(100);
      if (filter !== 'all') query = query.eq('status', filter);
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
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [loadJobs, profile?.organizationId]);

  const selected = jobs.find((job) => job.id === selectedId) ?? null;

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
      const storagePath = selected.evidence.storage_path;
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
  }, [selected?.id, selected?.evidence?.storage_path, selected?.evidence?.metadata?.storage_bucket]);

  // Consolidated observation data
  const consolidated = useMemo(() => {
    return consolidateResultData(selected?.result?.result);
  }, [selected?.result?.result]);

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
          <h1>CCTV review</h1>
          <p>Review camera evidence, consolidated AI observations, and evidential findings.</p>
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
              const vehicleCount = jobConsolidated.summary_counts.vehicle_events;
              const frameCount = jobConsolidated.summary_counts.total_frames_parsed;

              return (
                <button
                  key={job.id}
                  type="button"
                  className={`cctv-job-row ${selectedId === job.id ? 'is-selected' : ''}`}
                  onClick={() => setSelectedId(job.id)}
                >
                  <span className="cctv-job-icon">
                    <FileVideo2 size={19} />
                  </span>
                  <span className="cctv-job-copy">
                    <strong>{job.evidence?.evidence_kind === 'photo' ? 'Camera snapshot' : 'CCTV video'}</strong>
                    <small>
                      {timeLabel(job.created_at)} · {job.domain} · {String(job.id).slice(0, 8)}
                    </small>
                  </span>
                  <span className="cctv-job-findings">
                    {frameCount > 0 ? `${frameCount} frames` : 'Pending frames'}
                    {vehicleCount > 0 ? ` · ${vehicleCount} vehicle ${vehicleCount === 1 ? 'event' : 'events'}` : ''}
                    {faceCount > 0 ? ` · ${faceCount} person ${faceCount === 1 ? 'event' : 'events'}` : ''}
                  </span>
                  <span className={`cctv-status status-${job.status}`}>
                    <CircleDot size={13} /> {statusLabel(job.status)}
                  </span>
                </button>
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
                  <strong>{consolidated.summary_counts.face_events}</strong>
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

              {/* Tabs */}
              <div className="cctv-tab-bar">
                <button
                  type="button"
                  className={activeTab === 'events' ? 'is-active' : ''}
                  onClick={() => setActiveTab('events')}
                >
                  Observations (
                  {consolidated.summary_counts.face_events + consolidated.summary_counts.vehicle_events})
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
                  {consolidated.face_events.length === 0 && consolidated.vehicle_events.length === 0 ? (
                    <div className="cctv-empty-small">
                      <Clock3 size={18} />
                      <span>No consolidated observations detected yet.</span>
                    </div>
                  ) : null}

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
                            <UserRound size={12} /> {face.subject_label}
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
                            <strong>Sightings:</strong> {face.frame_count} frames consolidated
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
                          <span className="cctv-plate-badge">{veh.plate}</span>
                          {veh.is_return ? (
                            <span className="cctv-badge cctv-badge-return">Returned</span>
                          ) : (
                            <span className="cctv-badge cctv-badge-confidence">
                              {Math.round(veh.confidence * 100)}% ALPR
                            </span>
                          )}
                        </div>
                        <div className="cctv-card-meta">
                          <span>
                            <strong>Window:</strong> {veh.first_seen_seconds}s – {veh.last_seen_seconds}s ({veh.duration_seconds}s)
                          </span>
                          <span>
                            <strong>Sightings:</strong> {veh.frame_count} frames consolidated
                          </span>
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
                  onClick={() => {
                    alert('Consolidated observations verified. Link to incident or person record.');
                  }}
                  title="Confirm verified observations"
                >
                  <CheckCircle2 size={16} /> Confirm observation
                </button>
                <button
                  type="button"
                  className="cctv-btn-dismiss"
                  onClick={() => {
                    alert('Observation dismissed as background noise.');
                  }}
                  title="Dismiss noise / false positive"
                >
                  <XCircle size={16} /> Dismiss
                </button>
              </div>
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
