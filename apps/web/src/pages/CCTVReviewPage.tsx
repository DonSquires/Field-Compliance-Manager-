import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  Car,
  CheckCircle2,
  CircleDot,
  Clock3,
  Database,
  Download,
  Eye,
  ExternalLink,
  FileVideo2,
  Maximize2,
  Play,
  Printer,
  RotateCcw,
  RefreshCw,
  Search,
  ShieldAlert,
  UserRound,
  X,
  XCircle,
  Trash2,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { consolidateResultData } from '../lib/motionConsolidation';
import { buildCCTVPrintableReport, type CCTVReportReceiptProvenance } from '../lib/cctvReport';
import { describeJobFailure, summariseFailures, type JobFailure } from '../lib/cctvJobFailure';
import { filterUsableReportImages, type ReportEvidenceImage } from '../lib/cctvImageQuality';
import { entityTitle, inferenceReviewLabel, isReviewed, OBSERVATION_SELECT, toObservation, type ConsoleObservation } from '../lib/cctvConsole';
import type {
  ConsolidatedFaceEvent,
  ConsolidatedPersonEvent,
  ConsolidatedVehicleEvent,
  KeyframeItem,
} from '../lib/motionConsolidation';
import './PageStyles.css';
import './CCTVReviewPage.css';

type ReviewFilter = 'all' | 'queued' | 'processing' | 'manual_review_required' | 'complete' | 'failed' | 'archived';
type ReviewWorkspaceMode = 'split' | 'queue' | 'inspect';

const REVIEW_SELECTION_KEY = 'fcm.cctv.review.selectedJob';
const REVIEW_MODE_KEY = 'fcm.cctv.review.workspaceMode';

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

type InferenceUsage = {
  daily_frame_budget: number;
  budget_is_default: boolean;
  budget_reason: string | null;
  frames_used_today: number;
  exhausted: boolean;
  deferred_jobs: number;
  days: Array<{ day: string; jobs: number; frames_sent: number; gpu_calls: number; gpu_ms: number }>;
};

type DesktopReviewBatch = {
  batch_id: string;
  clip_index: number;
  clip_total: number;
  channel?: number | null;
  start_time?: string | null;
  end_time?: string | null;
};

type PersonRecordOption = {
  id: string;
  display_name: string | null;
  review_state: string;
  metadata: Record<string, unknown> | null;
};

type VehicleRecordOption = {
  id: string;
  plate: string;
  make: string | null;
  model: string | null;
};

type IncidentRecordOption = {
  id: string;
  incident_type: string;
  status: string;
  occurred_at: string;
};

type IdentityDraftState = {
  personRecordId: string;
  displayName: string;
  draftId?: string;
  status?: string;
  authorityLevel?: string;
};

type ReviewEventState = {
  id?: string;
  review_state: string;
  reviewer_notes: string | null;
  linked_vehicle_id?: string | null;
  linked_incident_id?: string | null;
};

type FaceObservationLink = {
  id: string;
  person_record_id: string | null;
  metadata: {
    candidates?: FaceCandidate[];
    original_thumbnail?: string | null;
    source_event_id?: string | null;
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

type PrintableCCTVReport = {
  html: string;
  fileName: string;
  previewWindow: Window;
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

function evidencePlaceContext(metadata: Record<string, unknown> | null): string {
  const source = metadata || {};
  const labels = ['site_name', 'zone_name', 'location_name', 'place_name']
    .map((key) => typeof source[key] === 'string' ? source[key].trim() : '')
    .filter(Boolean);
  return labels.length ? labels.join(' · ') : 'Unassigned place context';
}

function evidenceDisplayName(evidence: CCTVJob['evidence']): string {
  const metadataName = evidence?.metadata && typeof evidence.metadata.file_name === 'string' ? evidence.metadata.file_name.trim() : '';
  if (metadataName) return metadataName;
  const pathName = evidence?.storage_path?.split('/').filter(Boolean).pop();
  return pathName || (evidence?.evidence_kind === 'photo' ? 'Camera snapshot' : 'CCTV video');
}

function desktopReviewBatch(metadata: Record<string, unknown> | null): DesktopReviewBatch | null {
  const value = metadata?.desktop_review_batch;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const batchId = typeof source.batch_id === 'string' ? source.batch_id : '';
  const clipIndex = Number(source.clip_index);
  const clipTotal = Number(source.clip_total);
  if (!batchId || !Number.isFinite(clipIndex) || !Number.isFinite(clipTotal)) return null;
  return {
    batch_id: batchId,
    clip_index: clipIndex,
    clip_total: clipTotal,
    channel: Number.isFinite(Number(source.channel)) ? Number(source.channel) : null,
    start_time: typeof source.start_time === 'string' ? source.start_time : null,
    end_time: typeof source.end_time === 'string' ? source.end_time : null,
  };
}

export const CCTVReviewPage: React.FC<CCTVReviewPageProps> = ({ initialFilter = 'all', libraryMode = false }) => {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [jobs, setJobs] = useState<CCTVJob[]>([]);
  const [filter, setFilter] = useState<ReviewFilter>(initialFilter);
  const [queueSearch, setQueueSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const requested = new URLSearchParams(window.location.search).get('reviewJob');
    try { return requested || window.localStorage.getItem(REVIEW_SELECTION_KEY); } catch { return requested; }
  });
  const [workspaceMode, setWorkspaceMode] = useState<ReviewWorkspaceMode>(() => {
    const requested = new URLSearchParams(window.location.search).get('reviewMode');
    if (requested === 'queue' || requested === 'inspect' || requested === 'split') return requested;
    try {
      const remembered = window.localStorage.getItem(REVIEW_MODE_KEY);
      return remembered === 'queue' || remembered === 'inspect' || remembered === 'split' ? remembered : 'split';
    } catch { return 'split'; }
  });
  const isReviewPopout = new URLSearchParams(window.location.search).get('reviewPopout') === '1';
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoLoading, setVideoLoading] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'events' | 'records' | 'keyframes' | 'raw'>('events');
  const [observationRecords, setObservationRecords] = useState<ConsoleObservation[]>([]);
  const [observationRecordsLoading, setObservationRecordsLoading] = useState(false);
  const [observationRecordsError, setObservationRecordsError] = useState<string | null>(null);
  const [enlargedImage, setEnlargedImage] = useState<{ src: string; title: string; subtitle?: string } | null>(null);
  const [personRecords, setPersonRecords] = useState<PersonRecordOption[]>([]);
  const [vehicleRecords, setVehicleRecords] = useState<VehicleRecordOption[]>([]);
  const [incidentRecords, setIncidentRecords] = useState<IncidentRecordOption[]>([]);
  const [faceObservationLinks, setFaceObservationLinks] = useState<Record<string, FaceObservationLink>>({});
  const [identityDrafts, setIdentityDrafts] = useState<Record<string, IdentityDraftState>>({});
  const [identitySaving, setIdentitySaving] = useState<string | null>(null);
  const [observationSaving, setObservationSaving] = useState<string | null>(null);
  const [vehicleDrafts, setVehicleDrafts] = useState<Record<string, string>>({});
  const [incidentDrafts, setIncidentDrafts] = useState<Record<string, string>>({});
  const [reviewEventStates, setReviewEventStates] = useState<Record<string, ReviewEventState>>({});
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [decisionSaving, setDecisionSaving] = useState(false);
  const [decisionMessage, setDecisionMessage] = useState<string | null>(null);
  const [reportReceipt, setReportReceipt] = useState<{ reportId: string; generatedAt: string; sha256: string; observationCount: number } | null>(null);
  const [printableReport, setPrintableReport] = useState<PrintableCCTVReport | null>(null);
  const [verifyDraft, setVerifyDraft] = useState<{ receiptId: string; sha256: string }>({ receiptId: '', sha256: '' });
  const [verifyResult, setVerifyResult] = useState<{ text: string; ok: boolean | null } | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [usage, setUsage] = useState<InferenceUsage | null>(null);
  const [budgetDraft, setBudgetDraft] = useState('');
  const [budgetSaving, setBudgetSaving] = useState(false);
  const [budgetMessage, setBudgetMessage] = useState<string | null>(null);
  const [exportSaving, setExportSaving] = useState(false);
  const [exportReceipt, setExportReceipt] = useState<{ id: string; manifestSha256: string } | null>(null);
  const [currentExport, setCurrentExport] = useState<{ id: string; approval_state: string; manifest_sha256: string; manifest: Record<string, unknown> } | null>(null);
  const [exportDownloadUrl, setExportDownloadUrl] = useState<string | null>(null);
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchJobs, setBatchJobs] = useState<CCTVJob[]>([]);
  const [resultLoading, setResultLoading] = useState(false);
  const [jobAction, setJobAction] = useState<'retry' | 'reprocess' | 'cancel' | 'close' | 'archive' | 'delete' | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const isAdmin = ['admin', 'master', 'grand_master'].includes(profile?.role ?? '');

  const chooseWorkspaceMode = useCallback((mode: ReviewWorkspaceMode) => {
    setWorkspaceMode(mode);
    try { window.localStorage.setItem(REVIEW_MODE_KEY, mode); } catch { /* browser storage can be unavailable */ }
  }, []);

  const selectReviewJob = useCallback((jobId: string) => {
    setSelectedId(jobId);
    try { window.localStorage.setItem(REVIEW_SELECTION_KEY, jobId); } catch { /* browser storage can be unavailable */ }
  }, []);

  useEffect(() => {
    const syncSelection = (event: StorageEvent) => {
      if (event.key === REVIEW_SELECTION_KEY && event.newValue) setSelectedId(event.newValue);
    };
    window.addEventListener('storage', syncSelection);
    return () => window.removeEventListener('storage', syncSelection);
  }, []);

  // Org-scoped metering readout; refreshed with the queue so a paused job and its reason appear together.
  const loadUsage = useCallback(async () => {
    if (!profile?.organizationId) return;
    const { data } = await supabase.rpc('cctv_inference_usage', { p_organization_id: profile.organizationId, p_days: 14 });
    if (data && typeof data === 'object') {
      const next = data as InferenceUsage;
      setUsage(next);
      setBudgetDraft((current) => current || String(next.daily_frame_budget));
    }
  }, [profile?.organizationId]);

  const saveBudget = useCallback(async () => {
    if (!profile?.organizationId) return;
    const frames = Number(budgetDraft);
    if (!Number.isFinite(frames) || frames < 100) { setBudgetMessage('A daily budget must be at least 100 frames.'); return; }
    setBudgetSaving(true);
    setBudgetMessage(null);
    const { error: budgetError } = await supabase.rpc('set_cctv_inference_budget', { p_organization_id: profile.organizationId, p_daily_frame_budget: Math.round(frames), p_reason: 'Set from CCTV review' });
    setBudgetSaving(false);
    if (budgetError) { setBudgetMessage(budgetError.message); return; }
    setBudgetMessage(`Daily budget set to ${Math.round(frames).toLocaleString()} frames.`);
    await loadUsage();
  }, [budgetDraft, loadUsage, profile?.organizationId]);

  useEffect(() => { void loadUsage(); }, [loadUsage, jobs]);

  const loadJobs = useCallback(async () => {
    if (!profile?.organizationId) {
      setJobs([]);
      setError('Organisation access could not be confirmed. CCTV review is unavailable.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      let query = supabase
        .from('inference_jobs')
        .select('id, evidence_item_id, domain, status, stage, error_message, attempt_count, progress_percent, progress_current, progress_total, progress_label, created_at')
        .eq('organization_id', profile.organizationId)
        .in('domain', [...CCTV_DOMAINS])
        .order('created_at', { ascending: false })
        .limit(100);
      if (filter === 'all') query = query.neq('status', 'archived');
      else query = query.eq('status', filter);
      const { data, error: queryError } = await query;
      if (queryError) throw queryError;
      const rows = (data ?? []) as Array<Omit<CCTVJob, 'evidence' | 'result'>>;
      const evidenceIds = rows.map((job) => job.evidence_item_id).filter((id): id is string => Boolean(id));
      const { data: evidenceRows, error: evidenceError } = evidenceIds.length
        ? await supabase.from('evidence_items').select('id, storage_path, evidence_kind, metadata').in('id', evidenceIds)
        : { data: [], error: null };
      if (evidenceError) throw evidenceError;
      const evidenceById = new Map((evidenceRows ?? []).map((evidence) => [evidence.id, evidence]));
      const mappedJobs = rows.map((job) => ({
        ...job,
        evidence: job.evidence_item_id ? evidenceById.get(job.evidence_item_id) ?? null : null,
        result: null,
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
  const visibleJobs = useMemo(() => {
    const query = queueSearch.trim().toLocaleLowerCase('en-NZ');
    if (!query) return jobs;
    return jobs.filter((job) => [evidenceDisplayName(job.evidence), job.id, job.status, job.stage ?? '', job.domain]
      .some((value) => value.toLocaleLowerCase('en-NZ').includes(query)));
  }, [jobs, queueSearch]);
  const selectedBatch = desktopReviewBatch(selected?.evidence?.metadata || null);
  const selectedBatchJobs = selectedBatch
    ? (batchJobs.length > 0 ? batchJobs : jobs.filter((job) => desktopReviewBatch(job.evidence?.metadata || null)?.batch_id === selectedBatch.batch_id))
    : selected ? [selected] : [];
  const selectedBatchComplete = !selectedBatch || selectedBatchJobs.length >= selectedBatch.clip_total;
  const selectedBatchClipIndexes = selectedBatchJobs
    .map((job) => desktopReviewBatch(job.evidence?.metadata || null)?.clip_index)
    .filter((clipIndex): clipIndex is number => Number.isFinite(clipIndex));
  const selectedBatchConsolidated = selectedBatchJobs.map((job) => consolidateResultData(job.result?.result));
  const pendingObservationCount = selectedBatchConsolidated.reduce((count, result) => (
    count + result.person_events.length + result.vehicle_events.filter((event) => event.temporal_consensus).length + result.face_events.filter((event) => identityDrafts[event.event_id]?.authorityLevel !== 'approved').length
  ), 0);
  const reportReady = selectedBatchComplete && pendingObservationCount === 0;

  const loadEvidenceObservationRecords = useCallback(async () => {
    if (!profile?.organizationId || !selected?.evidence_item_id) { setObservationRecords([]); setObservationRecordsError(null); return; }
    setObservationRecordsLoading(true); setObservationRecordsError(null);
    const { data, error: recordsError } = await supabase
      .from('cctv_entity_observations')
      .select(OBSERVATION_SELECT)
      .eq('organization_id', profile.organizationId)
      .eq('evidence_item_id', selected.evidence_item_id)
      .neq('review_state', 'superseded')
      .order('observed_at');
    if (recordsError) setObservationRecordsError(recordsError.message);
    else setObservationRecords(((data as unknown as Record<string, unknown>[]) ?? []).map(toObservation).filter((row): row is ConsoleObservation => row !== null));
    setObservationRecordsLoading(false);
  }, [profile?.organizationId, selected?.evidence_item_id]);

  useEffect(() => { void loadEvidenceObservationRecords(); }, [loadEvidenceObservationRecords]);

  useEffect(() => {
    if (!profile?.organizationId || !selected?.evidence_item_id) return;
    const channel = supabase.channel(`cctv-review-records-${selected.evidence_item_id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cctv_entity_observations', filter: `organization_id=eq.${profile.organizationId}` }, (payload) => {
        const evidenceId = (payload.new as { evidence_item_id?: string } | null)?.evidence_item_id ?? (payload.old as { evidence_item_id?: string } | null)?.evidence_item_id;
        if (evidenceId === selected.evidence_item_id) void loadEvidenceObservationRecords();
      })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [loadEvidenceObservationRecords, profile?.organizationId, selected?.evidence_item_id]);

  const openObservationRecord = useCallback((observationId: string) => {
    const path = `/admin/field-ops?area=cctv-triage&observation=${observationId}`;
    navigate(path);
  }, [navigate]);

  const openInspectionWindow = useCallback(() => {
    if (!selected) return;
    const url = new URL(window.location.href);
    url.searchParams.set('reviewMode', 'inspect');
    url.searchParams.set('reviewJob', selected.id);
    url.searchParams.set('reviewPopout', '1');
    window.open(url.toString(), `fcm-cctv-inspector-${selected.id}`, 'popup=yes,width=1440,height=1000,left=120,top=60');
  }, [selected]);

  useEffect(() => {
    let active = true;
    const loadSelectedResult = async () => {
      if (!selectedId) return;
      setResultLoading(true);
      const { data, error: resultError } = await supabase
        .from('inference_results')
        .select('status, result')
        .eq('inference_job_id', selectedId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!active) return;
      if (resultError) setIdentityError(`Inference detail could not be loaded: ${resultError.message}`);
      else if (data) setJobs((current) => current.map((job) => job.id === selectedId ? { ...job, result: data as CCTVJob['result'] } : job));
      setResultLoading(false);
    };
    void loadSelectedResult();
    return () => { active = false; };
  }, [selectedId]);

  useEffect(() => {
    setReportReceipt(null);
    setBatchJobs([]);
    setExportReceipt(null);
    setCurrentExport(null);
    setExportDownloadUrl(null);
  }, [selectedId]);

  useEffect(() => {
    let active = true;
    const loadCurrentExport = async () => {
      if (!profile?.organizationId || !selected?.evidence_item_id) return;
      const { data, error: exportError } = await supabase
        .from('cctv_exports')
        .select('id, approval_state, manifest_sha256, manifest')
        .eq('organization_id', profile.organizationId)
        .eq('evidence_item_id', selected.evidence_item_id)
        .order('generated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!active) return;
      if (exportError) setIdentityError(exportError.message);
      else setCurrentExport(data as { id: string; approval_state: string; manifest_sha256: string; manifest: Record<string, unknown> } | null);
    };
    void loadCurrentExport();
    return () => { active = false; };
  }, [profile?.organizationId, selected?.evidence_item_id]);

  const loadSelectedBatch = async () => {
    if (!selectedBatch || !profile?.organizationId) return;
    setBatchLoading(true);
    setError(null);
    try {
      const { data: evidenceRows, error: evidenceError } = await supabase
        .from('evidence_items')
        .select('id, storage_path, evidence_kind, metadata')
        .eq('organization_id', profile.organizationId)
        .contains('metadata', { desktop_review_batch: { batch_id: selectedBatch.batch_id } });
      if (evidenceError) throw evidenceError;
      const evidenceIds = (evidenceRows ?? []).map((evidence) => evidence.id);
      if (evidenceIds.length === 0) {
        setBatchJobs([]);
        return;
      }
      const { data: jobRows, error: batchError } = await supabase
        .from('inference_jobs')
        .select('id, evidence_item_id, domain, status, stage, error_message, attempt_count, progress_percent, progress_current, progress_total, progress_label, created_at')
        .eq('organization_id', profile.organizationId)
        .in('evidence_item_id', evidenceIds)
        .in('domain', [...CCTV_DOMAINS])
        .order('created_at', { ascending: false });
      if (batchError) throw batchError;
      const jobIds = (jobRows ?? []).map((job) => job.id);
      const { data: resultRows, error: resultError } = jobIds.length
        ? await supabase.from('inference_results').select('inference_job_id, status, result, created_at').in('inference_job_id', jobIds).order('created_at', { ascending: false })
        : { data: [], error: null };
      if (resultError) throw resultError;
      const evidenceById = new Map((evidenceRows ?? []).map((evidence) => [evidence.id, evidence]));
      const resultByJobId = new Map<string, CCTVJob['result']>();
      for (const result of resultRows ?? []) {
        if (result.inference_job_id && !resultByJobId.has(result.inference_job_id)) resultByJobId.set(result.inference_job_id, { status: result.status, result: result.result });
      }
      const mappedJobs = (jobRows ?? []).map((job) => ({
        ...job,
        evidence: job.evidence_item_id ? evidenceById.get(job.evidence_item_id) ?? null : null,
        result: resultByJobId.get(job.id) ?? null,
      }));
      setBatchJobs(mappedJobs);
    } catch (batchError) {
      setError(batchError instanceof Error ? batchError.message : 'The selected SD-card batch could not be loaded.');
    } finally {
      setBatchLoading(false);
    }
  };

  const manageJob = useCallback(async (job: CCTVJob, action: 'retry' | 'reprocess' | 'cancel' | 'close' | 'archive' | 'delete') => {
    if (!profile?.organizationId) return;
    const confirmation = action === 'archive'
      ? 'Archive this CCTV queue item? The video and inference record will be retained and available under Archived.'
      : action === 'delete'
        ? 'Delete this terminal CCTV job? The queue record and inference results will be permanently removed; the original evidence video will be retained.'
        : action === 'close'
          ? 'Close this failed CCTV job without retrying it?'
      : action === 'cancel'
        ? 'Cancel this CCTV job?'
        : action === 'reprocess'
          ? 'Reprocess this completed job with the current inference code? Every AI observation from it that no one has reviewed yet will be cleared and replaced with fresh results; anything already accepted, rejected or linked is left untouched.'
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

  const manageSelectedJob = useCallback((action: 'retry' | 'reprocess' | 'cancel' | 'close' | 'archive' | 'delete') => {
    if (selected) void manageJob(selected, action);
  }, [manageJob, selected]);

  // Verifies a printed page against the receipt the database holds for it; wording comes from the verdicts, not from the hash.
  const verifyReceipt = useCallback(async () => {
    const receiptId = verifyDraft.receiptId.trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(receiptId)) {
      setVerifyResult({ text: 'Enter the receipt id printed on the report (a 36-character id).', ok: null });
      return;
    }
    setVerifying(true);
    setVerifyResult(null);
    const { data, error: verifyError } = await supabase.rpc('verify_cctv_report_receipt', { p_receipt_id: receiptId, p_sha256: verifyDraft.sha256.trim() || null });
    setVerifying(false);
    if (verifyError) { setVerifyResult({ text: verifyError.message, ok: false }); return; }
    const result = data as { found: boolean; receipt_intact?: boolean; presented_matches?: boolean | null; issued_at?: string; evidence_integrity_now?: string | null; evidence_sha256_at_issue?: string | null; evidence_sha256_now?: string | null; superseded_by?: string | null; review_consistency_at_issue?: string | null } | null;
    if (!result?.found) { setVerifyResult({ text: 'No receipt with that id exists in this organisation. The page was not issued here, or the id was mistyped.', ok: false }); return; }
    const parts: string[] = [];
    if (!result.receipt_intact) parts.push('The stored receipt no longer hashes to its own signature — report this to the custodian immediately.');
    else if (result.presented_matches === false) parts.push('The hash on the page does NOT match this receipt. The page is not the report the receipt was issued for.');
    else if (result.presented_matches === true) parts.push(`The page matches receipt issued ${result.issued_at ? timeLabel(result.issued_at) : ''}.`);
    else parts.push(`Receipt found, issued ${result.issued_at ? timeLabel(result.issued_at) : ''}; enter the page's hash to confirm it is the same report.`);
    if (result.evidence_sha256_at_issue && result.evidence_sha256_now && result.evidence_sha256_at_issue !== result.evidence_sha256_now) parts.push('The recording\'s hash differs from the one sealed at issue.');
    if (result.evidence_integrity_now === 'mismatch') parts.push('The recording currently FAILS its integrity check.');
    if (result.review_consistency_at_issue && result.review_consistency_at_issue.startsWith('client_claims')) parts.push('At issue the database still held undecided sightings; treat review states as provisional.');
    if (result.superseded_by) parts.push(`A later receipt (${result.superseded_by.slice(0, 8)}…) supersedes this one.`);
    const ok = Boolean(result.receipt_intact) && result.presented_matches !== false && result.evidence_integrity_now !== 'mismatch';
    setVerifyResult({ text: parts.join(' '), ok });
  }, [verifyDraft]);

  // Each failed job with what went wrong, in the reviewer's terms, and whether a retry can plausibly change it.
  const jobFailures = useMemo(() => {
    const map = new Map<string, JobFailure>();
    for (const job of jobs) {
      if (job.status !== 'failed') continue;
      const fileName = typeof job.evidence?.metadata?.file_name === 'string' ? job.evidence.metadata.file_name : job.evidence?.storage_path?.split('/').pop() ?? null;
      map.set(job.id, describeJobFailure(job.error_message, fileName));
    }
    return map;
  }, [jobs]);
  const failureSummary = useMemo(() => summariseFailures([...jobFailures.values()]), [jobFailures]);

  // Retries only the failures a retry is expected to fix; permanent ones stay visible with their next step.
  const retryFixableFailures = useCallback(async () => {
    if (!profile?.organizationId) return;
    const fixable = jobs.filter((job) => jobFailures.get(job.id)?.retryLikelyHelps);
    if (!fixable.length) return;
    if (!window.confirm(`Retry ${fixable.length} failed job${fixable.length === 1 ? '' : 's'} whose failure looks transient? Jobs with damaged or unreadable footage are left alone.`)) return;
    setJobAction('retry');
    setError(null);
    const problems: string[] = [];
    for (const job of fixable) {
      const { error: actionError } = await supabase.rpc('manage_cctv_inference_job', { p_job_id: job.id, p_organization_id: profile.organizationId, p_action: 'retry' });
      if (actionError) problems.push(`${String(job.id).slice(0, 8)}: ${actionError.message}`);
    }
    setJobAction(null);
    if (problems.length) setError(`${problems.length} of ${fixable.length} retries were refused — ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? '…' : ''}`);
    await loadJobs();
  }, [jobs, jobFailures, loadJobs, profile?.organizationId]);

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
        setVehicleRecords([]);
        setIncidentRecords([]);
        setFaceObservationLinks({});
        setIdentityDrafts({});
        setVehicleDrafts({});
        setIncidentDrafts({});
        setReviewEventStates({});
        return;
      }
      const [{ data: observations, error: observationsError }, { data: records, error: recordsError }, { data: vehicles, error: vehiclesError }, { data: incidents, error: incidentsError }, { data: drafts, error: draftsError }, { data: reviewEvents, error: reviewEventsError }] = await Promise.all([
        supabase.rpc('get_cctv_face_observation_links', { p_organization_id: profile.organizationId, p_evidence_item_id: selected.evidence_item_id }),
        supabase.rpc('get_cctv_review_person_records', { p_organization_id: profile.organizationId }),
        supabase.from('vehicles').select('id, plate, make, model').eq('organization_id', profile.organizationId).order('plate', { ascending: true }),
        supabase.from('incidents').select('id, incident_type, status, occurred_at').eq('organization_id', profile.organizationId).in('status', ['open', 'in_review', 'escalated']).order('occurred_at', { ascending: false }),
        supabase.from('cctv_identity_drafts').select('id, event_id, proposed_person_record_id, proposed_display_name, status, authority_level').eq('organization_id', profile.organizationId).eq('evidence_item_id', selected.evidence_item_id),
        supabase.from('cctv_review_events').select('id, source_event_id, review_state, reviewer_notes, linked_vehicle_id, linked_incident_id').eq('organization_id', profile.organizationId).eq('evidence_item_id', selected.evidence_item_id),
      ]);
      if (!active) return;
      if (observationsError || recordsError || vehiclesError || incidentsError || draftsError || reviewEventsError) {
        setIdentityError(observationsError?.message || recordsError?.message || vehiclesError?.message || incidentsError?.message || draftsError?.message || reviewEventsError?.message || 'CCTV review records could not be loaded.');
        return;
      }
      const nextRecords = (records ?? []) as PersonRecordOption[];
      const nextLinks: Record<string, FaceObservationLink> = {};
      const nextDrafts: Record<string, IdentityDraftState> = {};
      const nextReviewStates: Record<string, ReviewEventState> = {};
      for (const observation of (observations ?? []) as FaceObservationLink[]) {
        const eventId = typeof observation.metadata?.source_event_id === 'string' ? observation.metadata.source_event_id : null;
        if (eventId) nextLinks[eventId] = observation;
      }
      for (const draft of drafts ?? []) {
        if (draft.event_id) {
          nextDrafts[draft.event_id] = {
            personRecordId: draft.proposed_person_record_id ?? '',
            displayName: draft.proposed_display_name ?? '',
            draftId: draft.id,
            status: draft.status,
            authorityLevel: draft.authority_level,
          };
        }
      }
      for (const reviewEvent of reviewEvents ?? []) {
        if (reviewEvent.source_event_id) nextReviewStates[reviewEvent.source_event_id] = reviewEvent;
      }
      setPersonRecords(nextRecords);
      setVehicleRecords((vehicles ?? []) as VehicleRecordOption[]);
      setIncidentRecords((incidents ?? []) as IncidentRecordOption[]);
      setFaceObservationLinks(nextLinks);
      setIdentityDrafts(nextDrafts);
      setReviewEventStates(nextReviewStates);
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
    try {
      const { data, error: saveError } = await supabase.rpc('record_cctv_identity_draft', {
        p_job_id: selected?.id,
        p_evidence_id: selected?.evidence_item_id,
        p_organization_id: profile?.organizationId,
        p_event_id: face.event_id,
        p_event_type: 'face',
        p_subject_kind: 'person',
        p_proposed_person_record_id: draft.personRecordId,
        p_proposed_display_name: draft.displayName.trim() || null,
        p_candidate_matches: link.metadata?.candidates ?? [],
        p_reason: 'Provisional person match awaiting human review',
      });
      if (saveError) throw saveError;
      if (data) {
        setIdentityDrafts((current) => ({
          ...current,
          [face.event_id]: {
            ...current[face.event_id],
            personRecordId: draft.personRecordId,
            displayName: draft.displayName,
            draftId: data.id,
            status: data.status,
            authorityLevel: data.authority_level,
          },
        }));
      }
    } catch (saveError) {
      setIdentityError(saveError instanceof Error ? saveError.message : 'Draft identity could not be saved.');
    }
    setIdentitySaving(null);
  };

  const approveFaceIdentity = async (face: ConsolidatedFaceEvent) => {
    const link = faceObservationLinks[face.event_id];
    const draft = identityDrafts[face.event_id];
    if (!link?.id || !draft?.draftId || !draft?.personRecordId || !profile?.organizationId || !selected?.id) return;
    setIdentitySaving(face.event_id);
    setIdentityError(null);
    try {
      const { error: approveError } = await supabase.rpc('approve_cctv_identity_draft', {
        p_draft_id: draft.draftId,
        p_final_action: 'match_existing',
        p_final_person_record_id: draft.personRecordId,
        p_review_notes: `Approved by reviewer for ${face.subject_label || 'person'} observation`,
      });
      if (approveError) throw approveError;

      const { error: assignError } = await supabase.rpc('assign_face_observation_person', {
        p_observation_id: link.id,
        p_person_record_id: draft.personRecordId,
        p_display_name: draft.displayName.trim() || null,
      });
      if (assignError) throw assignError;

      const { error: reviewEventError } = await supabase.rpc('record_cctv_review_event', {
        p_job_id: selected.id,
        p_evidence_id: selected.evidence_item_id,
        p_organization_id: profile.organizationId,
        p_source_event_id: face.event_id,
        p_event_type: 'face',
        p_review_state: 'accepted',
        p_reviewer_notes: `Accepted after explicit person-record approval for ${face.subject_label || 'person'} observation`,
        p_person_record_id: draft.personRecordId,
      });
      if (reviewEventError) throw reviewEventError;

      setIdentityDrafts((current) => ({
        ...current,
        [face.event_id]: {
          ...current[face.event_id],
          status: 'approved',
          authorityLevel: 'approved',
        },
      }));
      setReviewEventStates((current) => ({
        ...current,
        [face.event_id]: { review_state: 'accepted', reviewer_notes: `Accepted after explicit person-record approval for ${face.subject_label || 'person'} observation` },
      }));
      setPersonRecords((current) => current.map((record) => record.id === draft.personRecordId
        ? { ...record, display_name: draft.displayName.trim() || record.display_name }
        : record));
    } catch (approveError) {
      setIdentityError(approveError instanceof Error ? approveError.message : 'Identity approval could not be completed.');
    }
    setIdentitySaving(null);
  };

  const recordObservationState = async (eventId: string, eventType: 'person' | 'face' | 'vehicle', reviewState: 'uncertain' | 'rejected') => {
    if (!selected || !selected.evidence_item_id || !profile?.organizationId) return;
    const reason = window.prompt(`Record why this ${eventType} observation is ${reviewState}.`);
    if (!reason?.trim()) return;
    setObservationSaving(eventId);
    setIdentityError(null);
    const { error: reviewError } = await supabase.rpc('record_cctv_review_event', {
      p_job_id: selected.id,
      p_evidence_id: selected.evidence_item_id,
      p_organization_id: profile.organizationId,
      p_source_event_id: eventId,
      p_event_type: eventType,
      p_review_state: reviewState,
      p_reviewer_notes: reason.trim(),
    });
    if (reviewError) setIdentityError(reviewError.message);
    else {
      setReviewEventStates((current) => ({ ...current, [eventId]: { review_state: reviewState, reviewer_notes: reason.trim() } }));
      setDecisionMessage(`${eventType} observation marked ${reviewState}.`);
    }
    setObservationSaving(null);
  };

  const acceptVehicleObservation = async (vehicle: ConsolidatedVehicleEvent) => {
    const vehicleId = vehicleDrafts[vehicle.event_id] || reviewEventStates[vehicle.event_id]?.linked_vehicle_id || '';
    if (!selected || !selected.evidence_item_id || !profile?.organizationId || !vehicleId) return;
    setObservationSaving(vehicle.event_id);
    setIdentityError(null);
    const { error: reviewError } = await supabase.rpc('record_cctv_review_event', {
      p_job_id: selected.id,
      p_evidence_id: selected.evidence_item_id,
      p_organization_id: profile.organizationId,
      p_source_event_id: vehicle.event_id,
      p_event_type: 'vehicle',
      p_review_state: 'accepted',
      p_reviewer_notes: `Accepted ALPR observation for plate ${vehicle.plate}`,
      p_vehicle_id: vehicleId,
    });
    if (reviewError) setIdentityError(reviewError.message);
    else {
      setReviewEventStates((current) => ({
        ...current,
        [vehicle.event_id]: { review_state: 'accepted', reviewer_notes: `Accepted ALPR observation for plate ${vehicle.plate}`, linked_vehicle_id: vehicleId },
      }));
      setDecisionMessage(`Vehicle observation ${vehicle.plate} accepted and linked.`);
    }
    setObservationSaving(null);
  };

  const linkObservationIncident = async (eventId: string, eventType: 'person' | 'face' | 'vehicle') => {
    const incidentId = incidentDrafts[eventId] || reviewEventStates[eventId]?.linked_incident_id || '';
    if (!selected || !selected.evidence_item_id || !profile?.organizationId || !incidentId) return;
    setObservationSaving(eventId);
    setIdentityError(null);
    const { error: linkError } = await supabase.rpc('record_cctv_review_event', {
      p_job_id: selected.id,
      p_evidence_id: selected.evidence_item_id,
      p_organization_id: profile.organizationId,
      p_source_event_id: eventId,
      p_event_type: eventType,
      p_review_state: reviewEventStates[eventId]?.review_state === 'accepted' ? 'accepted' : 'needs_more_context',
      p_reviewer_notes: 'Linked to an existing incident by a human reviewer.',
      p_incident_id: incidentId,
    });
    if (linkError) setIdentityError(linkError.message);
    else {
      setReviewEventStates((current) => ({ ...current, [eventId]: { ...current[eventId], review_state: current[eventId]?.review_state || 'needs_more_context', reviewer_notes: 'Linked to an existing incident by a human reviewer.', linked_incident_id: incidentId } }));
      setDecisionMessage(`${eventType} observation linked to incident.`);
    }
    setObservationSaving(null);
  };

  const createExportDraft = async () => {
    if (!selected || !selected.evidence_item_id || !profile?.organizationId) return;
    const acceptedEvents = Object.values(reviewEventStates).filter((event) => event.review_state === 'accepted' && event.id);
    if (acceptedEvents.length === 0) {
      setDecisionMessage('Accept and link at least one observation before creating an export draft.');
      return;
    }
    const purpose = window.prompt('Export purpose, for example: incident review or legal disclosure.');
    if (!purpose?.trim()) return;
    const recipientScope = window.prompt('Recipient scope, for example: internal investigation team.');
    if (!recipientScope?.trim()) return;
    setExportSaving(true);
    setIdentityError(null);
    const manifestClips = selectedBatchJobs.map((job) => {
      const batch = desktopReviewBatch(job.evidence?.metadata || null);
      const metadata = job.evidence?.metadata || {};
      const result = consolidateResultData(job.result?.result);
      return {
        clip_index: batch?.clip_index ?? null,
        clip_total: batch?.clip_total ?? null,
        evidence_item_id: job.evidence_item_id,
        source_storage_path: job.evidence?.storage_path || null,
        source_sha256: typeof metadata.sha256 === 'string' ? metadata.sha256 : typeof metadata.source_sha256 === 'string' ? metadata.source_sha256 : null,
        playback_storage_path: typeof metadata.playback_storage_path === 'string' ? metadata.playback_storage_path : null,
        derived_keyframe_hashes: result.keyframes.map((keyframe) => keyframe.sha256_hash),
      };
    });
    const manifest = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      source_job_id: selected.id,
      source_evidence_id: selected.evidence_item_id,
      batch_id: selectedBatch?.batch_id || null,
      accepted_event_count: acceptedEvents.length,
      review_event_ids: acceptedEvents.map((event) => event.id),
      media_assets: manifestClips,
      source_metadata: selected.evidence?.metadata || {},
    };
    const { data, error: exportError } = await supabase.rpc('create_cctv_export_draft', {
      p_job_id: selected.id,
      p_evidence_id: selected.evidence_item_id,
      p_organization_id: profile.organizationId,
      p_purpose: purpose.trim(),
      p_recipient_scope: recipientScope.trim(),
      p_legal_hold: false,
      p_selected_event_ids: acceptedEvents.map((event) => event.id),
      p_manifest: manifest,
    });
    const draft = Array.isArray(data) ? data[0] : data;
    if (exportError || !draft) setIdentityError(exportError?.message || 'CCTV export draft could not be created.');
    else {
      setExportReceipt({ id: draft.id, manifestSha256: draft.manifest_sha256 });
      setCurrentExport({ id: draft.id, approval_state: draft.approval_state, manifest_sha256: draft.manifest_sha256, manifest: draft.manifest });
      setDecisionMessage('CCTV export draft created. It still requires approval and sealing.');
    }
    setExportSaving(false);
  };

  const transitionExport = async (action: 'submitted' | 'approved' | 'sealed') => {
    if (!currentExport) return;
    setExportSaving(true);
    const rpc = action === 'sealed' ? 'seal_cctv_export' : 'approve_cctv_export';
    const args = action === 'sealed'
      ? { p_export_id: currentExport.id }
      : { p_export_id: currentExport.id, p_approval_state: action };
    const { data, error: transitionError } = await supabase.rpc(rpc, args);
    const result = Array.isArray(data) ? data[0] : data;
    if (transitionError || !result) setIdentityError(transitionError?.message || 'CCTV export transition failed.');
    else {
      setCurrentExport({ id: result.id, approval_state: result.approval_state, manifest_sha256: result.manifest_sha256, manifest: result.manifest || currentExport.manifest });
      setDecisionMessage(`CCTV export is now ${result.approval_state}.`);
    }
    setExportSaving(false);
  };

  const issueAndDownloadExport = async () => {
    if (!currentExport || currentExport.approval_state !== 'sealed' || !profile?.organizationId) return;
    setExportSaving(true);
    setIdentityError(null);
    const bucket = 'bob-uploads';
    const path = `cctv-exports/${profile.organizationId}/${currentExport.id}/manifest-${currentExport.manifest_sha256}.json`;
    const { error: uploadError } = await supabase.storage.from(bucket).upload(path, JSON.stringify(currentExport.manifest), {
      contentType: 'application/json',
      upsert: false,
    });
    if (uploadError && !uploadError.message.toLowerCase().includes('already exists')) {
      setIdentityError(uploadError.message);
      setExportSaving(false);
      return;
    }
    const { data: issued, error: issueError } = await supabase.rpc('issue_cctv_export', {
      p_export_id: currentExport.id,
      p_artifact_bucket: bucket,
      p_artifact_path: path,
    });
    const issuedExport = Array.isArray(issued) ? issued[0] : issued;
    if (issueError || !issuedExport) {
      setIdentityError(issueError?.message || 'Sealed CCTV export could not be issued.');
      setExportSaving(false);
      return;
    }
    const { data: signed, error: signedError } = await supabase.storage.from(bucket).createSignedUrl(path, 600);
    if (signedError || !signed?.signedUrl) setIdentityError(signedError?.message || 'A signed export URL could not be created.');
    else {
      setExportDownloadUrl(signed.signedUrl);
      window.open(signed.signedUrl, '_blank', 'noopener,noreferrer');
      setCurrentExport({ ...currentExport, approval_state: 'issued' });
      setDecisionMessage('Sealed CCTV export issued with a short-lived signed download URL.');
    }
    setExportSaving(false);
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

  const draftBobDocument = () => {
    if (!selected?.evidence_item_id) return;
    navigate(`/admin/document-studio?sourceType=cctv&sourceId=${selected.evidence_item_id}&auto=1`);
  };

  const printSelectedReport = async (requestedStatus: 'draft' | 'review_ready' = 'draft') => {
    if (!selected || !selected.evidence_item_id || !profile?.organizationId) {
      setDecisionMessage('A printable report requires an organization-scoped evidence item.');
      return;
    }
    const reportWindow = window.open('', '_blank');
    if (!reportWindow) {
      setDecisionMessage('The printable report could not open. Allow pop-ups for this site and try again.');
      return;
    }
    reportWindow.opener = null;
    reportWindow.document.write('<!doctype html><html><body><p>Preparing governed CCTV report...</p></body></html>');
    reportWindow.document.close();
    const batchConsolidated = selectedBatchJobs.map((job) => ({ job, result: consolidateResultData(job.result?.result) }));
    const observations = batchConsolidated.flatMap(({ result }) => [
      ...result.person_events.map((event) => ({
        kind: 'Person',
        label: `Person observation ${event.event_id.slice(0, 8)}`,
        confidence: event.confidence,
        startSeconds: event.first_seen_seconds,
        endSeconds: event.last_seen_seconds,
        reviewState: 'Review required',
      })),
      ...result.face_events.map((event) => ({
        kind: 'Face',
        label: event.subject_label || 'Unknown person',
        confidence: null,
        startSeconds: event.first_seen_seconds,
        endSeconds: event.last_seen_seconds,
        reviewState: identityDrafts[event.event_id]?.authorityLevel === 'approved' ? 'Approved identity' : identityDrafts[event.event_id]?.status === 'draft' ? 'Draft match' : 'Review required',
      })),
      ...result.vehicle_events.map((event) => ({
        kind: 'Vehicle',
        label: event.plate || 'Unreadable plate',
        confidence: event.confidence,
        startSeconds: event.first_seen_seconds,
        endSeconds: event.last_seen_seconds,
        reviewState: event.temporal_consensus ? 'Review required' : 'Single-frame reading',
      })),
    ]);
    const reportCounts = batchConsolidated.reduce((counts, { result }) => ({
      personCount: counts.personCount + result.summary_counts.face_events + result.summary_counts.person_events,
      vehicleCount: counts.vehicleCount + result.summary_counts.vehicle_events,
      animalCount: counts.animalCount + (result.animal_events || []).length,
      frameCount: counts.frameCount + result.summary_counts.total_frames_parsed,
    }), { personCount: 0, vehicleCount: 0, animalCount: 0, frameCount: 0 });
    const reportHasPendingReview = observations.some((observation) => observation.reviewState !== 'Approved identity' && observation.reviewState !== 'Confirmed');
    const canIssueFinalReport = selectedBatchComplete && !reportHasPendingReview;
    if (requestedStatus === 'review_ready' && !canIssueFinalReport) {
      reportWindow.close();
      setDecisionMessage('The final report requires a complete batch and an explicit review decision for every observation.');
      return;
    }
    const reportStatus = requestedStatus === 'review_ready' ? 'review_ready' : 'draft';
    const generatedAt = new Date().toLocaleString('en-NZ');
    const place = evidencePlaceContext(selected.evidence?.metadata || null);
    const observedTimes = observations.flatMap((observation) => [observation.startSeconds, observation.endSeconds]).filter((value): value is number => typeof value === 'number');
    const firstObserved = observedTimes.length ? Math.min(...observedTimes) : null;
    const lastObserved = observedTimes.length ? Math.max(...observedTimes) : null;
    const assessment = {
      what: `${reportCounts.personCount} person observation${reportCounts.personCount === 1 ? '' : 's'} and ${reportCounts.vehicleCount} vehicle observation${reportCounts.vehicleCount === 1 ? '' : 's'} were consolidated from ${reportCounts.frameCount} parsed frames.`,
      when: firstObserved === null ? 'No observation time window was reported.' : `${firstObserved}s to ${lastObserved ?? firstObserved}s in the reviewed footage.`,
      where: place,
      why: 'Assess camera evidence for potential client safety, security, or compliance concerns without treating AI output as an enforcement or identity decision.',
      how: 'Motion extraction and provisional person, face, vehicle, and plate analysis were consolidated before an explicit human review decision.',
    };
    const eventImages = batchConsolidated.flatMap(({ result }) => [
      ...result.person_events.map((event) => ({ kind: 'person' as const, src: event.thumbnail, label: 'Person observation', timestampSeconds: event.first_seen_seconds, sha256Hash: event.best_frame_hash, reviewState: reviewEventStates[event.event_id]?.review_state || 'Review required' })),
      ...result.face_events.map((event) => ({ kind: 'person' as const, src: event.thumbnail, label: event.subject_label || 'Person face observation', timestampSeconds: event.first_seen_seconds, sha256Hash: event.best_frame_hash, reviewState: reviewEventStates[event.event_id]?.review_state || 'Review required' })),
      ...result.vehicle_events.map((event) => ({ kind: 'vehicle' as const, src: event.thumbnail, label: event.plate ? `Vehicle ${event.plate}` : 'Vehicle observation', timestampSeconds: event.first_seen_seconds, sha256Hash: event.best_frame_hash, reviewState: reviewEventStates[event.event_id]?.review_state || 'Review required' })),
      ...(result.animal_events || []).map((event) => ({ kind: 'animal' as const, src: event.thumbnail, label: event.animal_type || 'Animal observation', timestampSeconds: event.first_seen_seconds, sha256Hash: event.best_frame_hash, reviewState: 'Review required' })),
    ]).filter((image): image is ReportEvidenceImage => typeof image.src === 'string' && image.src.startsWith('data:image/') && typeof image.sha256Hash === 'string')
      .filter((image, index, images) => images.findIndex((candidate) => candidate.sha256Hash === image.sha256Hash) === index);
    const evidenceImages = await filterUsableReportImages(eventImages, 6);
    const reportPayload = {
      schema_version: 1,
      title: 'CCTV evidence report',
      report_status: reportStatus,
      generated_at: generatedAt,
      place,
      job_id: selected.id,
      evidence_id: selected.evidence_item_id,
      batch_id: selectedBatch?.batch_id || null,
      clip_count: selectedBatch?.clip_total || null,
      loaded_clip_count: selectedBatchJobs.length,
      batch_complete: selectedBatchComplete,
      person_count: reportCounts.personCount,
      vehicle_count: reportCounts.vehicleCount,
      animal_count: reportCounts.animalCount,
      frame_count: reportCounts.frameCount,
      assessment,
      evidence_images: evidenceImages.map(({ label, timestampSeconds, sha256Hash, reviewState }) => ({ label, timestamp_seconds: timestampSeconds, sha256_hash: sha256Hash, review_state: reviewState })),
      observations,
    };
    const { data: receiptData, error: receiptError } = await supabase.rpc('issue_cctv_report_receipt', {
      p_job_id: selected.id,
      p_evidence_id: selected.evidence_item_id,
      p_organization_id: profile.organizationId,
      p_batch_id: selectedBatch?.batch_id || null,
      p_payload: reportPayload,
    });
    const receipt = Array.isArray(receiptData) ? receiptData[0] : receiptData;
    if (receiptError || !receipt) {
      reportWindow.close();
      setDecisionMessage(receiptError?.message || 'The CCTV report receipt could not be issued. The report was not opened.');
      return;
    }
    const issuedReceipt = receipt as { report_id: string; generated_at: string; observation_count: number; sha256: string; provenance?: CCTVReportReceiptProvenance['provenance'] };
    const report = buildCCTVPrintableReport({
      title: reportStatus === 'draft' ? 'CCTV evidence report (Draft)' : 'CCTV evidence report',
      reportStatus,
      generatedAt,
      place: reportPayload.place,
      jobId: reportPayload.job_id,
      evidenceId: reportPayload.evidence_id,
      batchId: reportPayload.batch_id,
      clipCount: reportPayload.clip_count,
      loadedClipCount: reportPayload.loaded_clip_count,
      batchComplete: reportPayload.batch_complete,
      personCount: reportCounts.personCount,
      vehicleCount: reportCounts.vehicleCount,
      animalCount: reportCounts.animalCount,
      frameCount: reportCounts.frameCount,
      assessment,
      evidenceImages,
      observations,
      // The printed page names the receipt the database just issued for this payload, with the server's provenance.
      receipt: { reportId: issuedReceipt.report_id, issuedAt: issuedReceipt.generated_at, sha256: issuedReceipt.sha256, provenance: issuedReceipt.provenance ?? null },
    });
    reportWindow.document.open();
    reportWindow.document.write(report);
    reportWindow.document.close();
    reportWindow.focus();
    setPrintableReport({
      html: report,
      fileName: `cctv-report-${issuedReceipt.report_id.slice(0, 8)}.html`,
      previewWindow: reportWindow,
    });
    setReportReceipt({
      reportId: receipt.report_id,
      generatedAt: receipt.generated_at,
      sha256: receipt.sha256,
      observationCount: receipt.observation_count,
    });
  };

  const printCCTVReport = () => {
    if (!printableReport) return;
    if (printableReport.previewWindow.closed) {
      setDecisionMessage('The report preview tab is closed. Generate the report again to print or save it as PDF.');
      return;
    }
    printableReport.previewWindow.focus();
    printableReport.previewWindow.print();
  };

  const downloadCCTVReport = () => {
    if (!printableReport) return;
    const objectUrl = URL.createObjectURL(new Blob([printableReport.html], { type: 'text/html;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = printableReport.fileName;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
  };

  return (
    <div className={`cctv-review-page${isReviewPopout ? ' is-review-popout' : ''}`}>
      <header className="cctv-review-header">
        <div>
          <span>Field outcomes</span>
          <h1>{libraryMode ? 'Completed video library' : 'CCTV review'}</h1>
          <p>{libraryMode ? 'Review completed camera footage, keyframes, and governed observations.' : 'Review camera evidence, consolidated AI observations, and evidential findings.'}</p>
        </div>
        <div className="cctv-review-header-actions">
          {!libraryMode && (
            <button type="button" className="page-action" onClick={() => navigate('/admin/field-ops?area=cctv-console')} title="Open the CCTV console: synchronised playback, timeline and entity review">
              <Eye size={17} /> CCTV console
            </button>
          )}
          {!libraryMode && (
            <button type="button" className="page-action" onClick={() => navigate('/admin/field-ops?area=cctv-import')} title="Import an SD card or camera folder">
              <Archive size={17} /> Import camera footage
            </button>
          )}
          <button
            type="button"
            className="page-action"
            onClick={() => void loadJobs()}
            disabled={loading}
            title="Refresh CCTV review"
          >
            <RefreshCw size={17} className={loading ? 'is-spinning' : ''} /> Refresh
          </button>
        </div>
      </header>

      <div className="cctv-workspace-toolbar" aria-label="Review workspace layout">
        <div className="cctv-workspace-modes" role="group" aria-label="Choose review layout">
          <button type="button" className={workspaceMode === 'queue' ? 'is-active' : ''} aria-pressed={workspaceMode === 'queue'} onClick={() => chooseWorkspaceMode('queue')}><FileVideo2 size={15} /> Queue</button>
          <button type="button" className={workspaceMode === 'split' ? 'is-active' : ''} aria-pressed={workspaceMode === 'split'} onClick={() => chooseWorkspaceMode('split')}><Eye size={15} /> Split review</button>
          <button type="button" className={workspaceMode === 'inspect' ? 'is-active' : ''} aria-pressed={workspaceMode === 'inspect'} onClick={() => chooseWorkspaceMode('inspect')}><Maximize2 size={15} /> Inspector</button>
        </div>
        <div className="cctv-workspace-selection">
          <span>{selected ? `${selected.evidence?.evidence_kind === 'photo' ? 'Snapshot' : 'Video'} · ${timeLabel(selected.created_at)}` : 'No evidence selected'}</span>
          <button type="button" onClick={openInspectionWindow} disabled={!selected} title="Open the selected evidence inspector on another screen"><ExternalLink size={15} /> Open inspector window</button>
        </div>
      </div>

      <div className={`cctv-review-layout mode-${workspaceMode}`}>
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
          {usage ? (
            <div className={`cctv-usage-panel${usage.exhausted ? ' is-exhausted' : ''}`} aria-label="Inference usage and budget">
              <span>GPU inference today</span>
              <strong>{usage.frames_used_today.toLocaleString()} / {usage.daily_frame_budget.toLocaleString()} frames</strong>
              <div className="cctv-usage-bar" role="progressbar" aria-valuemin={0} aria-valuemax={usage.daily_frame_budget} aria-valuenow={Math.min(usage.frames_used_today, usage.daily_frame_budget)}><span style={{ width: `${Math.min(100, (usage.frames_used_today / Math.max(1, usage.daily_frame_budget)) * 100)}%` }} /></div>
              <small>{usage.exhausted ? `Budget spent — ${usage.deferred_jobs} job${usage.deferred_jobs === 1 ? '' : 's'} paused until it resets at midnight UTC. Nothing fails; work resumes on its own.` : usage.deferred_jobs ? `${usage.deferred_jobs} job${usage.deferred_jobs === 1 ? '' : 's'} paused for budget.` : `${usage.budget_is_default ? 'Platform default budget' : 'Budget set for this organisation'}${usage.budget_reason ? ` — ${usage.budget_reason}` : ''}.`}</small>
              {usage.days.length ? <small>Last {usage.days.length} day{usage.days.length === 1 ? '' : 's'}: {usage.days.reduce((total, day) => total + day.frames_sent, 0).toLocaleString()} frames · {usage.days.reduce((total, day) => total + day.gpu_calls, 0).toLocaleString()} GPU calls · {usage.days.reduce((total, day) => total + day.jobs, 0)} analyses</small> : null}
              {isAdmin ? (
                <form className="cctv-usage-budget" onSubmit={(event) => { event.preventDefault(); void saveBudget(); }} aria-label="Set daily frame budget">
                  <label>Daily frame budget <input type="number" min={100} step={100} value={budgetDraft} onChange={(event) => setBudgetDraft(event.target.value)} /></label>
                  <button type="submit" className="cctv-btn-jump" disabled={budgetSaving || !budgetDraft || Number(budgetDraft) < 100}>{budgetSaving ? 'Saving…' : 'Set budget'}</button>
                </form>
              ) : null}
              {budgetMessage ? <small role="status">{budgetMessage}</small> : null}
            </div>
          ) : null}
        </aside>

        {/* Center Queue List */}
        <section className="cctv-job-list" aria-label="CCTV review jobs">
          <div className="cctv-section-title">
            <div>
              <span>Evidence queue</span>
              <h2>{filter === 'all' ? 'Recent camera work' : statusLabel(filter)}</h2>
            </div>
            <div className="cctv-queue-tools">
              <label><Search size={14} /><input type="search" value={queueSearch} onChange={(event) => setQueueSearch(event.target.value)} aria-label="Find CCTV evidence" placeholder="Find file or job" /></label>
              <strong>{visibleJobs.length}</strong>
            </div>
          </div>
          {jobFailures.size > 0 && (
            <div className="cctv-failure-summary" role="status">
              <AlertTriangle size={15} aria-hidden="true" />
              <span>
                {jobFailures.size} failed {jobFailures.size === 1 ? 'job' : 'jobs'} here: {failureSummary.retryable} where a retry should help, {failureSummary.permanent} where the footage itself is the problem.
              </span>
              {failureSummary.retryable > 0 && (
                <button type="button" disabled={jobAction !== null} onClick={() => void retryFixableFailures()}><RotateCcw size={13} aria-hidden="true" /> Retry the {failureSummary.retryable} fixable</button>
              )}
            </div>
          )}
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
          ) : visibleJobs.length === 0 ? (
            <div className="cctv-empty"><Search size={22} /><strong>No matching camera work</strong><span>Clear the search or choose another status.</span></div>
          ) : (
            visibleJobs.map((job) => {
              const jobConsolidated = consolidateResultData(job.result?.result);
              const faceCount = jobConsolidated.summary_counts.face_events;
              const personCount = jobConsolidated.summary_counts.person_events;
              const vehicleCount = jobConsolidated.summary_counts.vehicle_events;
              const frameCount = jobConsolidated.summary_counts.total_frames_parsed;
              const batch = desktopReviewBatch(job.evidence?.metadata || null);

              return (
                <div key={job.id} className={`cctv-job-row ${selectedId === job.id ? 'is-selected' : ''}`}>
                  <button type="button" className="cctv-job-row-main" onClick={() => selectReviewJob(job.id)}>
                    <span className="cctv-job-icon"><FileVideo2 size={19} /></span>
                    <span className="cctv-job-copy">
                      <strong title={evidenceDisplayName(job.evidence)}>{evidenceDisplayName(job.evidence)}</strong>
                      <small>{job.evidence?.evidence_kind === 'photo' ? 'Camera snapshot' : 'CCTV video'} · {timeLabel(job.created_at)} · {String(job.id).slice(0, 8)}{job.stage ? ` · ${statusLabel(job.stage)}` : ''}</small>
                      {batch && <small className="cctv-batch-link">Desktop batch {batch.batch_id.slice(0, 8)} · clip {batch.clip_index}/{batch.clip_total}{batch.channel ? ` · camera ${batch.channel}` : ''}</small>}
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
                  {job.status === 'failed' && (() => {
                    const failure = jobFailures.get(job.id);
                    return (
                      <div className="cctv-row-actions" aria-label="Failed CCTV job actions">
                        <button type="button" className={failure && !failure.retryLikelyHelps ? 'is-unlikely' : undefined} title={failure ? (failure.retryLikelyHelps ? 'Retry — this failure looks transient' : 'Retry is unlikely to help: ' + failure.nextStep) : 'Retry failed job'} disabled={jobAction !== null} onClick={() => void manageJob(job, 'retry')}><RotateCcw size={13} /><span>{failure && !failure.retryLikelyHelps ? 'Retry anyway' : 'Retry'}</span></button>
                        <button type="button" title="Close failed job" disabled={jobAction !== null} onClick={() => void manageJob(job, 'close')}><XCircle size={13} /><span>Close</span></button>
                        <button type="button" title="Archive failed job" disabled={jobAction !== null} onClick={() => void manageJob(job, 'archive')}><Archive size={13} /><span>Archive</span></button>
                        <button type="button" title="Delete failed job" disabled={jobAction !== null} onClick={() => void manageJob(job, 'delete')}><Trash2 size={13} /><span>Delete</span></button>
                      </div>
                    );
                  })()}
                  {job.status === 'failed' && jobFailures.get(job.id) ? (() => {
                    const failure = jobFailures.get(job.id) as JobFailure;
                    return (
                      <details className={`cctv-job-failure is-${failure.retryLikelyHelps ? 'transient' : 'permanent'}`}>
                        <summary><strong>{failure.title}</strong> <span>{failure.retryLikelyHelps ? 'Retry should help' : 'Retry will not fix this'}</span></summary>
                        <p>{failure.explanation}</p>
                        <p><strong>Next step:</strong> {failure.nextStep}</p>
                        {job.error_message ? <p className="cctv-job-failure__raw"><span>Worker message (for engineers):</span> <code>{job.error_message}</code></p> : null}
                      </details>
                    );
                  })() : job.error_message ? <span className="cctv-job-error" title={job.error_message}>{job.error_message}</span> : null}
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
                  <h2 title={evidenceDisplayName(selected.evidence)}>{evidenceDisplayName(selected.evidence)}</h2>
                  <small className="cctv-place-context">Place: {evidencePlaceContext(selected.evidence?.metadata || null)}</small>
                  {selectedBatch && <small className="cctv-place-context">Desktop batch {selectedBatch.batch_id.slice(0, 8)} · clip {selectedBatch.clip_index} of {selectedBatch.clip_total}{selectedBatch.start_time && selectedBatch.end_time ? ` · ${selectedBatch.start_time} to ${selectedBatch.end_time}` : ''}</small>}
                </div>
                <Eye size={19} />
              </div>

              {/* Primary evidence stays first: administrative report/export controls follow the picture. */}
              <div className="cctv-media-container">
                {videoLoading ? (
                  <div className="cctv-media-loading">
                    <RefreshCw className="is-spinning" size={20} />
                    <span>Loading secured video stream...</span>
                  </div>
                ) : videoUrl ? (
                  <div className="cctv-video-wrapper">
                    <video ref={videoRef} src={videoUrl} controls playsInline preload="metadata" className="cctv-video-player" />
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

              {selectedBatch && (
                <div className="cctv-batch-summary" aria-label="SD-card batch review status">
                  <div>
                    <strong>SD-card batch review</strong>
                    <span>{selectedBatchClipIndexes.length} of {selectedBatch.clip_total} clips loaded</span>
                  </div>
                  <button type="button" className="cctv-btn-jump" onClick={() => void loadSelectedBatch()} disabled={batchLoading}>
                    <RefreshCw size={12} className={batchLoading ? 'is-spinning' : ''} /> {batchLoading ? 'Loading batch...' : 'Load full batch'}
                  </button>
                  <div className="cctv-batch-clip-list">
                    {Array.from({ length: selectedBatch.clip_total }, (_, index) => index + 1).map((clipIndex) => {
                      const clipJob = selectedBatchJobs.find((job) => desktopReviewBatch(job.evidence?.metadata || null)?.clip_index === clipIndex);
                      return <span key={clipIndex} className={clipJob ? `is-${clipJob.status}` : 'is-missing'} title={clipJob ? `Clip ${clipIndex}: ${statusLabel(clipJob.status)}` : `Clip ${clipIndex}: not loaded`}>{clipIndex}</span>;
                    })}
                  </div>
                  {!selectedBatchComplete && <small>Missing clips remain outside the current queue view. Do not issue a complete-card report yet.</small>}
                </div>
              )}

              <div className={`cctv-report-readiness ${reportReady ? 'is-ready' : 'is-pending'}`} aria-label="CCTV report readiness">
                <div>
                  <strong>{reportReady ? 'Final report ready' : 'Review required before final report'}</strong>
                  <span>{pendingObservationCount} unresolved observation{pendingObservationCount === 1 ? '' : 's'}{!selectedBatchComplete ? ' · batch is incomplete' : ''}</span>
                </div>
                <small>{reportReady ? 'All loaded observations have an approved review state.' : 'Use the draft report for working evidence, then resolve every observation before issuing final evidence.'}</small>
              </div>

              <div className="cctv-card-actions">
                <button type="button" className="cctv-btn-jump" disabled={exportSaving} onClick={() => void createExportDraft()} title="Create an approval-gated export draft from accepted observations">
                  {exportSaving ? 'Creating export...' : 'Create export draft'}
                </button>
                <button type="button" className="cctv-btn-jump" disabled={resultLoading} onClick={() => void printSelectedReport()} title="Preview a draft evidence report">
                  <Eye size={13} /> Preview draft report
                </button>
                <button type="button" className="cctv-btn-jump" disabled={!selected?.evidence_item_id} onClick={draftBobDocument} title="Draft an incident report with Bob from this CCTV evidence">
                  Bob: Draft incident report
                </button>
                <button type="button" className="cctv-btn-confirm" disabled={!reportReady} onClick={() => void printSelectedReport('review_ready')} title={reportReady ? 'Preview the final evidence report' : 'Resolve all observations and load the complete batch first'}>
                  <Eye size={13} /> Final report preview
                </button>
                {['failed', 'inconclusive', 'manual_review_required'].includes(selected.status) && (
                  <button type="button" className="cctv-btn-jump" disabled={jobAction !== null} onClick={() => void manageSelectedJob('retry')}>
                    <RotateCcw size={13} /> {jobAction === 'retry' ? 'Retrying...' : 'Retry'}
                  </button>
                )}
                {selected.status === 'complete' && (
                  <button type="button" className="cctv-btn-jump" disabled={jobAction !== null} onClick={() => void manageSelectedJob('reprocess')} title="Re-run this footage through today's inference code; unreviewed AI observations are replaced, reviewed ones are untouched">
                    <RotateCcw size={13} /> {jobAction === 'reprocess' ? 'Reprocessing...' : 'Reprocess'}
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

              <div className="cctv-records-summary" aria-label="Observation record summary">
                <Database size={17} aria-hidden="true" />
                <span><strong>{observationRecords.length} observation record{observationRecords.length === 1 ? '' : 's'}</strong><small>{observationRecords.filter((observation) => observation.personRecordId || observation.canonicalVehicleId).length} linked to canonical people or vehicles · {observationRecords.filter((observation) => !isReviewed(observation)).length} awaiting review</small></span>
                <button type="button" className="cctv-btn-jump" onClick={() => setActiveTab('records')}>Records &amp; history</button>
              </div>

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
                  className={activeTab === 'records' ? 'is-active' : ''}
                  onClick={() => setActiveTab('records')}
                >
                  Records ({observationRecords.length})
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
                          {reviewEventStates[person.event_id] && <span className="cctv-badge cctv-badge-review">{statusLabel(reviewEventStates[person.event_id].review_state)}</span>}
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
                          <button type="button" className="cctv-btn-dismiss" disabled={observationSaving === person.event_id} onClick={() => void recordObservationState(person.event_id, 'person', 'uncertain')}>Uncertain</button>
                          <button type="button" className="cctv-btn-dismiss" disabled={observationSaving === person.event_id} onClick={() => void recordObservationState(person.event_id, 'person', 'rejected')}>Reject</button>
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
                          {reviewEventStates[face.event_id] && <span className="cctv-badge cctv-badge-review">{statusLabel(reviewEventStates[face.event_id].review_state)}</span>}
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
                          <button type="button" className="cctv-btn-dismiss" disabled={observationSaving === face.event_id} onClick={() => void recordObservationState(face.event_id, 'face', 'uncertain')}>Uncertain</button>
                          <button type="button" className="cctv-btn-dismiss" disabled={observationSaving === face.event_id} onClick={() => void recordObservationState(face.event_id, 'face', 'rejected')}>Reject</button>
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
                            {identityDrafts[face.event_id]?.draftId && (
                              <div className="cctv-review-note">
                                <ShieldAlert size={17} />
                                <span>
                                  Draft match saved for human review. This suggestion is provisional and not yet authoritative.
                                </span>
                              </div>
                            )}
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
                                        ...(current[face.event_id] ?? {}),
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
                                    ...(current[face.event_id] ?? {}),
                                    personRecordId: current[face.event_id]?.personRecordId || faceObservationLinks[face.event_id].person_record_id || '',
                                    displayName: event.target.value,
                                  },
                                }))}
                              />
                            </label>
                            <div className="cctv-card-actions">
                              <button
                                type="button"
                                className="cctv-btn-jump"
                                disabled={identitySaving === face.event_id || !identityDrafts[face.event_id]?.personRecordId}
                                onClick={() => void saveFaceIdentity(face)}
                              >
                                {identitySaving === face.event_id ? 'Saving...' : identityDrafts[face.event_id]?.draftId ? 'Update draft' : 'Save draft'}
                              </button>
                              {identityDrafts[face.event_id]?.draftId && (
                                <button
                                  type="button"
                                  className="cctv-btn-confirm"
                                  disabled={identitySaving === face.event_id}
                                  onClick={() => void approveFaceIdentity(face)}
                                >
                                  {identitySaving === face.event_id ? 'Approving...' : 'Approve draft'}
                                </button>
                              )}
                            </div>
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
                          {reviewEventStates[veh.event_id] && <span className="cctv-badge cctv-badge-review">{statusLabel(reviewEventStates[veh.event_id].review_state)}</span>}
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
                          <button type="button" className="cctv-btn-dismiss" disabled={observationSaving === veh.event_id} onClick={() => void recordObservationState(veh.event_id, 'vehicle', 'uncertain')}>Uncertain</button>
                          <button type="button" className="cctv-btn-dismiss" disabled={observationSaving === veh.event_id} onClick={() => void recordObservationState(veh.event_id, 'vehicle', 'rejected')}>Reject</button>
                        </div>
                        <div className="cctv-identity-editor cctv-vehicle-link-editor">
                          <label>
                            Incident link
                            <select value={incidentDrafts[veh.event_id] || reviewEventStates[veh.event_id]?.linked_incident_id || ''} onChange={(event) => setIncidentDrafts((current) => ({ ...current, [veh.event_id]: event.target.value }))}>
                              <option value="">Select an active incident</option>
                              {incidentRecords.map((incident) => <option key={incident.id} value={incident.id}>{incident.incident_type} · {incident.status} · {timeLabel(incident.occurred_at)}</option>)}
                            </select>
                          </label>
                          <button type="button" className="cctv-btn-jump" disabled={observationSaving === veh.event_id || !(incidentDrafts[veh.event_id] || reviewEventStates[veh.event_id]?.linked_incident_id)} onClick={() => void linkObservationIncident(veh.event_id, 'vehicle')}>Link incident</button>
                        </div>
                        <div className="cctv-identity-editor cctv-vehicle-link-editor">
                          <label>
                            Canonical vehicle
                            <select
                              value={vehicleDrafts[veh.event_id] || reviewEventStates[veh.event_id]?.linked_vehicle_id || ''}
                              onChange={(event) => setVehicleDrafts((current) => ({ ...current, [veh.event_id]: event.target.value }))}
                            >
                              <option value="">Select a vehicle record</option>
                              {vehicleRecords.map((record) => <option key={record.id} value={record.id}>{record.plate}{record.make || record.model ? ` · ${[record.make, record.model].filter(Boolean).join(' ')}` : ''}</option>)}
                            </select>
                          </label>
                          <button type="button" className="cctv-btn-confirm" disabled={observationSaving === veh.event_id || !(vehicleDrafts[veh.event_id] || reviewEventStates[veh.event_id]?.linked_vehicle_id) || reviewEventStates[veh.event_id]?.review_state === 'accepted'} onClick={() => void acceptVehicleObservation(veh)}>
                            {reviewEventStates[veh.event_id]?.review_state === 'accepted' ? 'Vehicle linked' : 'Accept and link'}
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {activeTab === 'records' && (
                <div className="cctv-records-list" aria-label="Observation records for selected evidence">
                  {observationRecordsLoading ? <div className="cctv-empty-small"><RefreshCw className="is-spinning" size={16} /> Loading observation records…</div> : null}
                  {observationRecordsError ? <div className="page-error"><AlertTriangle size={16} /> Observation records could not be loaded: {observationRecordsError}</div> : null}
                  {!observationRecordsLoading && !observationRecordsError && observationRecords.length === 0 ? <div className="cctv-empty-small"><Database size={18} /><span>No governed observation records have been created for this video yet.</span></div> : null}
                  {observationRecords.map((observation) => {
                    const priorMatches = observation.candidates.filter((candidate) => candidate.match_kind === 'observation').length;
                    const identityMatches = observation.candidates.filter((candidate) => candidate.match_kind === 'person_record' && candidate.person_record_id);
                    const recordLabel = observation.personRecordId ? observation.profileName || 'Person profile linked' : observation.canonicalVehicleId ? observation.plate ? `Vehicle ${observation.plate}` : 'Vehicle record linked' : identityMatches.length ? `Possible person: ${identityMatches[0].display_name || 'review required'}` : observation.kind === 'animal' ? 'Animal observation' : 'No canonical record yet';
                    return <article key={observation.id} className="cctv-record-card">
                      {observation.thumbnail ? <img src={observation.thumbnail} alt="" /> : <span className="cctv-record-card__blank"><Database size={19} /></span>}
                      <div className="cctv-record-card__body">
                        <div><strong>{entityTitle(observation)}</strong><span className={`cctv-record-state is-${isReviewed(observation) ? 'reviewed' : 'pending'}`}>{isReviewed(observation) ? observation.reviewState.replace(/_/g, ' ') : 'Review needed'}</span></div>
                        <p>{recordLabel}</p>
                        <small>{inferenceReviewLabel(observation)} · {identityMatches.length ? `${identityMatches.length} possible person match${identityMatches.length === 1 ? '' : 'es'}` : priorMatches ? `${priorMatches} matched prior sighting${priorMatches === 1 ? '' : 's'}` : observation.portfolioKey ? 'History ready' : 'First unlinked sighting'}</small>
                      </div>
                      <div className="cctv-record-card__actions"><button type="button" className="cctv-btn-jump" onClick={() => openObservationRecord(observation.id)}>{observation.personRecordId || observation.canonicalVehicleId ? 'Update record' : 'Add or link record'}</button><a className="cctv-btn-jump" href={`/admin/field-ops?area=cctv-triage&observation=${observation.id}`} target="_blank" rel="noopener noreferrer" title="Open this observation and its previous sightings on another screen"><ExternalLink size={13} /> History on screen 2</a></div>
                    </article>;
                  })}
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
                    <dt>Organization scope</dt>
                    <dd>{profile?.organizationId || 'Current operator scope'}</dd>
                  </div>
                  <div>
                    <dt>Evidence ID</dt>
                    <dd>{selected.evidence_item_id || 'Not specified'}</dd>
                  </div>
                  <div>
                    <dt>Place context</dt>
                    <dd>{evidencePlaceContext(selected.evidence?.metadata || null)}</dd>
                  </div>
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
                  <div>
                    <dt>Decision authority</dt>
                    <dd>Human reviewer required before compliance or incident action</dd>
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
              {reportReceipt && (
                <div className="cctv-quality-panel" aria-label="CCTV report receipt">
                  <strong>Report receipt issued</strong>
                  <span>{reportReceipt.observationCount} observations · {timeLabel(reportReceipt.generatedAt)}</span>
                  <span>Receipt ID: {reportReceipt.reportId}</span>
                  <span>SHA-256: {reportReceipt.sha256}</span>
                  {printableReport && <div className="cctv-card-actions"><button type="button" className="cctv-btn-jump" onClick={printCCTVReport}><Printer size={13} /> Print / Save as PDF</button><button type="button" className="cctv-btn-jump" onClick={downloadCCTVReport}><Download size={13} /> Download HTML</button></div>}
                </div>
              )}
              <form className="cctv-quality-panel cctv-verify-receipt" aria-label="Verify a printed report" onSubmit={(event) => { event.preventDefault(); void verifyReceipt(); }}>
                <strong>Verify a printed report</strong>
                <span>Enter the receipt id and report hash printed in its receipt block.</span>
                <label>Receipt id <input value={verifyDraft.receiptId} onChange={(event) => setVerifyDraft({ ...verifyDraft, receiptId: event.target.value })} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" spellCheck={false} /></label>
                <label>Report hash <input value={verifyDraft.sha256} onChange={(event) => setVerifyDraft({ ...verifyDraft, sha256: event.target.value })} placeholder="64 hex characters (optional)" spellCheck={false} /></label>
                <button type="submit" className="cctv-btn-jump" disabled={verifying || !verifyDraft.receiptId.trim()}><ShieldAlert size={13} /> {verifying ? 'Checking…' : 'Verify receipt'}</button>
                {verifyResult ? <p className={`cctv-decision-message${verifyResult.ok === false ? ' is-bad' : verifyResult.ok ? ' is-good' : ''}`} role="status">{verifyResult.text}</p> : null}
              </form>
              {exportReceipt && (
                <div className="cctv-quality-panel" aria-label="CCTV export draft receipt">
                  <strong>Export draft created</strong>
                  <span>Approval and sealing are still required.</span>
                  <span>Export ID: {exportReceipt.id}</span>
                  <span>Manifest SHA-256: {exportReceipt.manifestSha256}</span>
                </div>
              )}
              {currentExport && (
                <div className="cctv-quality-panel" aria-label="CCTV export lifecycle">
                  <strong>Export lifecycle: {statusLabel(currentExport.approval_state)}</strong>
                  <span>Manifest SHA-256: {currentExport.manifest_sha256}</span>
                  <div className="cctv-card-actions">
                    {currentExport.approval_state === 'draft' && <button type="button" className="cctv-btn-jump" disabled={exportSaving} onClick={() => void transitionExport('submitted')}>Submit for approval</button>}
                    {currentExport.approval_state === 'submitted' && <button type="button" className="cctv-btn-confirm" disabled={exportSaving} onClick={() => void transitionExport('approved')}>Approve export</button>}
                    {currentExport.approval_state === 'approved' && <button type="button" className="cctv-btn-confirm" disabled={exportSaving} onClick={() => void transitionExport('sealed')}>Seal export</button>}
                    {currentExport.approval_state === 'sealed' && <button type="button" className="cctv-btn-confirm" disabled={exportSaving} onClick={() => void issueAndDownloadExport()}>Issue and download</button>}
                    {currentExport.approval_state === 'issued' && exportDownloadUrl && <a className="cctv-btn-jump" href={exportDownloadUrl} target="_blank" rel="noreferrer">Open issued export</a>}
                  </div>
                </div>
              )}
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
