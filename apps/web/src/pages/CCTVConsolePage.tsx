import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  Grid2x2,
  Keyboard,
  Link2,
  Loader2,
  Maximize2,
  Pause,
  PawPrint,
  Play,
  Plus,
  RefreshCw,
  Rewind,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  FastForward,
  Volume2,
  VolumeX,
  UserRound,
  Car,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import {
  candidateAction,
  clipAtTime,
  clampMs,
  DEFAULT_CCTV_INSPECTION,
  followClock,
  formatClock,
  formatDate,
  gridColumns,
  inferenceReviewLabel,
  initialView,
  isDefaultCCTVInspection,
  isEnhancementActive,
  isReviewed,
  isWeakInferenceCandidate,
  keyboardAction,
  nextClipAfter,
  nextInspectionZoom,
  nextRate,
  normalizeCCTVInspection,
  parseMs,
  previousClipBefore,
  timelineBounds,
  zoomView,
  GRID_LAYOUTS,
  PLAYBACK_RATES,
  entityTitle,
  type ClipJobStatus,
  type CCTVInspection,
  type ConsoleClip,
  type ConsoleMark,
  type ConsoleObservation,
  type EntityKind,
  type GridLayout,
  type PortfolioCandidate,
  type ReviewAction,
  type TimeView,
} from '../lib/cctvConsole';
import { CCTVTimeline } from '../components/CCTVTimeline';
import { CCTVPlayerTile } from '../components/CCTVPlayerTile';
import { enhancementReadout, type EnhancementPlan } from '../lib/cctvEnhance';
import './PageStyles.css';
import './CCTVConsolePage.css';

type ImportRow = {
  id: string;
  camera_label: string;
  camera_key: string;
  status: string;
  location_id: string;
  site_id: string | null;
  zone_id: string | null;
  source_timezone: string;
  source_device_kind: string;
  recorded_from: string | null;
  recorded_to: string | null;
  video_count: number;
  skipped_count: number;
  snapshot_count: number;
  created_at: string;
  locations: { name: string; address: string | null } | { name: string; address: string | null }[] | null;
};

type KindFilter = 'all' | EntityKind;

const SIGNED_URL_TTL_SECONDS = 3600;
const DETAIL_POLL_INTERVAL_MS = 10_000;
const KIND_ICON: Record<EntityKind, React.ReactNode> = {
  person: <UserRound size={14} aria-hidden="true" />,
  vehicle: <Car size={14} aria-hidden="true" />,
  animal: <PawPrint size={14} aria-hidden="true" />,
};

function placeLabelOf(row: ImportRow): string {
  const place = Array.isArray(row.locations) ? row.locations[0] : row.locations;
  if (!place) return 'Place not loaded';
  return place.address ? `${place.name} · ${place.address}` : place.name;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function singleRecord(value: unknown): Record<string, unknown> {
  return asRecord(Array.isArray(value) ? value[0] : value);
}

function toObservation(row: Record<string, unknown>): ConsoleObservation | null {
  const observedAtMs = parseMs(typeof row.observed_at === 'string' ? row.observed_at : null);
  if (observedAtMs === null || typeof row.id !== 'string') return null;
  const kind = row.entity_kind === 'person' || row.entity_kind === 'vehicle' || row.entity_kind === 'animal' ? row.entity_kind : null;
  if (!kind) return null;
  const personProfile = singleRecord(row.person_records);
  const profileName = typeof personProfile.display_name === 'string' ? personProfile.display_name : null;
  const profileMetadata = asRecord(personProfile.metadata);
  return {
    id: row.id,
    evidenceId: String(row.evidence_item_id ?? ''),
    importId: typeof row.cctv_import_id === 'string' ? row.cctv_import_id : null,
    sourceEventId: String(row.source_event_id ?? ''),
    kind,
    observedAtMs,
    observedToMs: parseMs(typeof row.observed_to === 'string' ? row.observed_to : null),
    label: kind === 'person' && profileName ? profileName : typeof row.candidate_label === 'string' ? row.candidate_label : null,
    plate: typeof row.candidate_plate === 'string' ? row.candidate_plate : null,
    species: typeof row.animal_type === 'string' ? row.animal_type : null,
    speciesConfidence: typeof row.species_confidence === 'number' ? row.species_confidence : null,
    isPest: typeof row.is_pest === 'boolean' ? row.is_pest : null,
    confidence: typeof row.model_confidence === 'number' ? row.model_confidence : null,
    qualityState: typeof row.quality_state === 'string' ? row.quality_state : 'clear',
    attributes: asRecord(row.attributes),
    thumbnail: typeof row.thumbnail === 'string' ? row.thumbnail : null,
    reviewState: typeof row.review_state === 'string' ? row.review_state : 'unreviewed',
    portfolioKey: typeof row.portfolio_key === 'string' ? row.portfolio_key : null,
    portfolioState: typeof row.portfolio_state === 'string' ? row.portfolio_state : 'unmatched',
    candidates: Array.isArray(row.portfolio_candidates) ? row.portfolio_candidates as PortfolioCandidate[] : [],
    personRecordId: typeof row.person_record_id === 'string' ? row.person_record_id : null,
    canonicalPersonId: typeof row.canonical_person_id === 'string' ? row.canonical_person_id : null,
    profileName,
    profileDetails: asRecord(profileMetadata.profile_details),
    canonicalVehicleId: typeof row.canonical_vehicle_id === 'string' ? row.canonical_vehicle_id : null,
    reviewedAt: typeof row.reviewed_at === 'string' ? row.reviewed_at : null,
    reviewNotes: typeof row.review_notes === 'string' ? row.review_notes : null,
  };
}

function markSeverity(value: unknown, source: unknown, kind: unknown): ConsoleMark['severity'] {
  if (source === 'inference' && kind === 'quality_event') return 'quality';
  return value === 'alert' || value === 'detection' ? value : 'motion';
}

const CCTVConsolePage: React.FC = () => {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const organizationId = profile?.organizationId ?? null;
  const requestedImportId = new URLSearchParams(location.search).get('import');

  const [imports, setImports] = useState<ImportRow[]>([]);
  const [importsLoading, setImportsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedImportId, setSelectedImportId] = useState<string | null>(requestedImportId);
  const [tileImportIds, setTileImportIds] = useState<string[]>([]);
  const [layout, setLayout] = useState<GridLayout>(1);
  const [masterIndex, setMasterIndex] = useState(0);

  const [clipsByImport, setClipsByImport] = useState<Record<string, ConsoleClip[]>>({});
  const [marksByImport, setMarksByImport] = useState<Record<string, ConsoleMark[]>>({});
  const [observationsByImport, setObservationsByImport] = useState<Record<string, ConsoleObservation[]>>({});
  const [detailLoading, setDetailLoading] = useState(false);

  const [clockMs, setClockMs] = useState<number | null>(null);
  const [view, setView] = useState<TimeView | null>(null);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [muted, setMuted] = useState(true);
  const [inspectionsByImport, setInspectionsByImport] = useState<Record<string, CCTVInspection>>({});
  const [showInspectionTools, setShowInspectionTools] = useState(false);
  const [enhancementState, setEnhancementState] = useState<{ plan: EnhancementPlan | null; mode: 'gpu' | 'css' } | null>(null);

  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [showReviewed, setShowReviewed] = useState(false);
  const [selectedObservationId, setSelectedObservationId] = useState<string | null>(null);
  const [reviewBusy, setReviewBusy] = useState<string | null>(null);
  const [reviewMessage, setReviewMessage] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [personDetails, setPersonDetails] = useState('');
  const [newPlate, setNewPlate] = useState('');
  const [notes, setNotes] = useState('');
  const [showKeys, setShowKeys] = useState(false);
  const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({});

  const gridRef = useRef<HTMLDivElement | null>(null);
  const urlCache = useRef<Map<string, { url: string; expiresAt: number }>>(new Map());
  const durationOverrides = useRef<Map<string, number>>(new Map());

  const selectedImport = imports.find((row) => row.id === selectedImportId) ?? null;
  const timeZone = selectedImport?.source_timezone || 'Pacific/Auckland';
  const activeImportIds = useMemo(() => tileImportIds.slice(0, layout).filter(Boolean), [tileImportIds, layout]);
  const visibleClips = useMemo(() => activeImportIds.flatMap((id) => clipsByImport[id] ?? []), [activeImportIds, clipsByImport]);
  const visibleMarks = useMemo(() => activeImportIds.flatMap((id) => marksByImport[id] ?? []), [activeImportIds, marksByImport]);
  const visibleObservations = useMemo(
    () => activeImportIds.flatMap((id) => observationsByImport[id] ?? []).sort((a, b) => a.observedAtMs - b.observedAtMs),
    [activeImportIds, observationsByImport],
  );
  const bounds = useMemo(() => timelineBounds(visibleClips, visibleMarks, visibleObservations), [visibleClips, visibleMarks, visibleObservations]);
  const masterImportId = activeImportIds[masterIndex] ?? activeImportIds[0] ?? null;
  const masterClips = masterImportId ? clipsByImport[masterImportId] ?? [] : [];
  const activeInspection = selectedImportId ? inspectionsByImport[selectedImportId] ?? DEFAULT_CCTV_INSPECTION : DEFAULT_CCTV_INSPECTION;
  const inspectionAdjusted = !isDefaultCCTVInspection(activeInspection);
  const enhancementActive = isEnhancementActive(activeInspection);

  const loadImports = useCallback(async () => {
    if (!organizationId) { setImports([]); setImportsLoading(false); setError('Organisation access could not be confirmed. The CCTV console is unavailable.'); return; }
    setImportsLoading(true);
    const { data, error: loadError } = await supabase
      .from('cctv_imports')
      .select('id, camera_label, camera_key, status, location_id, site_id, zone_id, source_timezone, source_device_kind, recorded_from, recorded_to, video_count, skipped_count, snapshot_count, created_at, locations(name, address)')
      .eq('organization_id', organizationId)
      .neq('status', 'archived')
      .order('created_at', { ascending: false })
      .limit(200);
    if (loadError) setError(loadError.message);
    const rows = (data as unknown as ImportRow[]) ?? [];
    setImports(rows);
    setImportsLoading(false);
    setSelectedImportId((current) => current && rows.some((row) => row.id === current) ? current : rows[0]?.id ?? null);
  }, [organizationId]);

  useEffect(() => { void loadImports(); }, [loadImports]);

  useEffect(() => {
    if (requestedImportId) setSelectedImportId(requestedImportId);
  }, [requestedImportId]);

  const loadImportDetail = useCallback(async (importId: string) => {
    if (!organizationId) return;
    setDetailLoading(true);
    const [evidenceRes, marksRes, observationsRes] = await Promise.all([
      supabase.from('evidence_items').select('id, storage_path, captured_at, metadata').eq('organization_id', organizationId).eq('cctv_import_id', importId).order('captured_at'),
      supabase.from('cctv_device_events').select('id, source, source_ref, event_start_at, event_end_at, severity, thumbnail_path, metadata').eq('cctv_import_id', importId).order('event_start_at').limit(5000),
      supabase.from('cctv_entity_observations').select('id, evidence_item_id, cctv_import_id, source_event_id, entity_kind, observed_at, observed_to, candidate_label, candidate_plate, animal_type, species_confidence, is_pest, model_confidence, quality_state, attributes, thumbnail, review_state, portfolio_key, portfolio_state, portfolio_candidates, person_record_id, canonical_person_id, canonical_vehicle_id, reviewed_at, review_notes, person_records(display_name, metadata)').eq('organization_id', organizationId).eq('cctv_import_id', importId).order('observed_at').limit(2000),
    ]);
    const failure = evidenceRes.error ?? marksRes.error ?? observationsRes.error;
    if (failure) setError(failure.message);
    const evidenceRows = (evidenceRes.data as Array<{ id: string; storage_path: string | null; captured_at: string; metadata: Record<string, unknown> | null }>) ?? [];
    const evidenceIds = evidenceRows.map((row) => row.id);
    const { data: jobRows } = evidenceIds.length
      ? await supabase.from('inference_jobs').select('id, evidence_item_id, status').in('evidence_item_id', evidenceIds).eq('domain', 'video_motion')
      : { data: [] };
    const jobByEvidence = new Map<string, { id: string; status: string }>();
    for (const job of (jobRows as Array<{ id: string; evidence_item_id: string; status: string }>) ?? []) jobByEvidence.set(job.evidence_item_id, { id: job.id, status: job.status });
    const clips: ConsoleClip[] = evidenceRows.flatMap((row) => {
      const metadata = row.metadata ?? {};
      const startMs = parseMs(typeof metadata.recorded_start_at === 'string' ? metadata.recorded_start_at : null) ?? parseMs(row.captured_at);
      if (startMs === null || !row.storage_path) return [];
      const known = durationOverrides.current.get(row.id);
      const slotEnd = parseMs(typeof metadata.recorded_end_at === 'string' ? metadata.recorded_end_at : null);
      const endMs = known ? startMs + known : slotEnd && slotEnd > startMs ? slotEnd : startMs + 30 * 60_000;
      const job = jobByEvidence.get(row.id);
      return [{
        evidenceId: row.id,
        importId,
        jobId: job?.id ?? null,
        jobStatus: (job?.status as ClipJobStatus) ?? 'none',
        fileName: typeof metadata.file_name === 'string' ? metadata.file_name : row.storage_path.split('/').pop() || row.id,
        startMs,
        endMs,
        bucket: typeof metadata.storage_bucket === 'string' ? metadata.storage_bucket : 'bob-uploads',
        playbackPath: typeof metadata.playback_storage_path === 'string' ? metadata.playback_storage_path : null,
        sourcePath: row.storage_path,
        fileType: typeof metadata.file_type === 'string' ? metadata.file_type : 'video/mp4',
      }];
    });
    const marks: ConsoleMark[] = ((marksRes.data as Array<Record<string, unknown>>) ?? []).flatMap((row) => {
      const startMs = parseMs(typeof row.event_start_at === 'string' ? row.event_start_at : null);
      if (startMs === null) return [];
      const metadata = asRecord(row.metadata);
      const endMs = parseMs(typeof row.event_end_at === 'string' ? row.event_end_at : null) ?? startMs + 2000;
      const kind = typeof metadata.kind === 'string' ? metadata.kind : String(row.source);
      const label = kind === 'quality_event' ? `Camera ${String(metadata.quality_kind || 'disturbance').replace(/_/g, ' ')}`
        : kind === 'motion_window' ? `Motion window · ${Object.entries(asRecord(metadata.entity_counts)).map(([k, v]) => `${v} ${k}`).join(', ') || 'no entities'}`
          : 'Camera motion event';
      return [{ id: String(row.id), startMs, endMs, severity: markSeverity(row.severity, row.source, kind), source: String(row.source), kind, thumbnailPath: typeof row.thumbnail_path === 'string' ? row.thumbnail_path : null, label }];
    });
    const observations = ((observationsRes.data as Array<Record<string, unknown>>) ?? []).map(toObservation).filter((item): item is ConsoleObservation => Boolean(item));
    setClipsByImport((current) => ({ ...current, [importId]: clips }));
    setMarksByImport((current) => ({ ...current, [importId]: marks }));
    setObservationsByImport((current) => ({ ...current, [importId]: observations }));
    setDetailLoading(false);
  }, [organizationId]);

  // Opening a camera from the list puts it in the first tile; the clock restarts when tile 1 changes camera
  // (below), not when a tile is merely clicked to become the clock master.
  useEffect(() => {
    if (!selectedImportId) return;
    setTileImportIds((current) => current.includes(selectedImportId) ? current : [selectedImportId, ...current.slice(1)]);
    void loadImportDetail(selectedImportId);
  }, [selectedImportId, loadImportDetail]);

  const firstTile = tileImportIds[0] ?? null;
  useEffect(() => {
    setClockMs(null);
    setView(null);
    setPlaying(false);
    setSelectedObservationId(null);
    setMasterIndex(0);
  }, [firstTile]);

  useEffect(() => {
    for (const id of activeImportIds) if (!clipsByImport[id]) void loadImportDetail(id);
  }, [activeImportIds, clipsByImport, loadImportDetail]);

  const hasActiveJob = useMemo(
    () => activeImportIds.some((importId) => (clipsByImport[importId] ?? []).some((clip) => clip.jobStatus === 'queued' || clip.jobStatus === 'processing')),
    [activeImportIds, clipsByImport],
  );

  // Realtime is a prompt refresh; active jobs also poll so a missing table publication cannot leave a reviewer stale.
  useEffect(() => {
    if (!hasActiveJob) return;
    const timer = window.setInterval(() => {
      for (const importId of activeImportIds) void loadImportDetail(importId);
    }, DETAIL_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [hasActiveJob, activeImportIds, loadImportDetail]);

  useEffect(() => {
    if (!organizationId) return;
    const channel = supabase
      .channel(`cctv-console-${organizationId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cctv_entity_observations', filter: `organization_id=eq.${organizationId}` }, (payload) => {
        const importId = (payload.new as { cctv_import_id?: string } | null)?.cctv_import_id ?? (payload.old as { cctv_import_id?: string } | null)?.cctv_import_id;
        if (importId && activeImportIds.includes(importId)) void loadImportDetail(importId);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'inference_jobs', filter: `organization_id=eq.${organizationId}` }, () => {
        for (const id of activeImportIds) void loadImportDetail(id);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cctv_imports', filter: `organization_id=eq.${organizationId}` }, () => void loadImports())
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [organizationId, activeImportIds, loadImportDetail, loadImports]);

  // First clock position: the first unreviewed entity, else the start of the footage.
  useEffect(() => {
    if (!bounds || clockMs !== null) return;
    const firstPending = visibleObservations.find((observation) => !isReviewed(observation));
    const start = firstPending ? firstPending.observedAtMs : (masterClips[0]?.startMs ?? bounds.startMs);
    const footage = visibleClips.length
      ? { startMs: Math.min(...visibleClips.map((clip) => clip.startMs)), endMs: Math.max(...visibleClips.map((clip) => clip.endMs)) }
      : null;
    setClockMs(start);
    setView(initialView(bounds, start, footage));
  }, [bounds, clockMs, visibleObservations, masterClips, visibleClips]);

  useEffect(() => {
    if (!bounds) return;
    setView((current) => current ? { startMs: Math.max(bounds.startMs, Math.min(current.startMs, bounds.endMs - 10_000)), endMs: Math.min(bounds.endMs, Math.max(current.endMs, bounds.startMs + 10_000)) } : current);
  }, [bounds]);

  const seek = useCallback((ms: number) => {
    if (!bounds) return;
    const next = clampMs(ms, bounds);
    setClockMs(next);
    setView((current) => current ? followClock(current, next, bounds) : current);
  }, [bounds]);

  const handleTick = useCallback((ms: number) => {
    setClockMs(ms);
    if (bounds) setView((current) => current && playing ? followClock(current, ms, bounds) : current);
  }, [bounds, playing]);

  const handleClipEnded = useCallback((clip: ConsoleClip) => {
    // Clips of one camera do not overlap, so "the next clip" is the first one that starts after this one.
    const next = nextClipAfter(masterClips, clip.startMs);
    if (next) seek(next.startMs);
    else setPlaying(false);
  }, [masterClips, seek]);

  // Gaps: while playing, if no camera in view has footage at the clock, skip to the next clip start; if only
  // the clock master is dark while another tile has footage, keep the clock running in real time.
  useEffect(() => {
    if (!playing || clockMs === null || !bounds) return;
    if (clipAtTime(masterClips, clockMs)) return;
    if (!clipAtTime(visibleClips, clockMs)) {
      const next = nextClipAfter(visibleClips, clockMs);
      if (next) seek(next.startMs);
      else setPlaying(false);
      return;
    }
    let last = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const advanced = (now - last) * rate;
      last = now;
      setClockMs((current) => current === null ? current : current + advanced);
    }, 200);
    return () => window.clearInterval(timer);
  }, [playing, clockMs, bounds, masterClips, visibleClips, rate, seek]);

  const handleDurationKnown = useCallback((evidenceId: string, durationMs: number) => {
    durationOverrides.current.set(evidenceId, durationMs);
    setClipsByImport((current) => {
      const next: Record<string, ConsoleClip[]> = {};
      for (const [importId, clips] of Object.entries(current)) {
        next[importId] = clips.map((clip) => clip.evidenceId === evidenceId && Math.abs(clip.endMs - (clip.startMs + durationMs)) > 500 ? { ...clip, endMs: clip.startMs + durationMs } : clip);
      }
      return next;
    });
  }, []);

  const resolveUrl = useCallback(async (clip: ConsoleClip) => {
    const path = clip.playbackPath ?? clip.sourcePath;
    const key = `${clip.bucket}:${path}`;
    const cached = urlCache.current.get(key);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.url;
    const { data, error: signError } = await supabase.storage.from(clip.bucket).createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
    if (signError || !data?.signedUrl) throw new Error(signError?.message || 'Signed URL unavailable');
    urlCache.current.set(key, { url: data.signedUrl, expiresAt: Date.now() + SIGNED_URL_TTL_SECONDS * 1000 });
    return data.signedUrl;
  }, []);

  // Snapshot thumbnails for the marks nearest the clock give the reviewer a still even before playback.
  const nearbySnapshots = useMemo(() => {
    if (clockMs === null) return [];
    return visibleMarks
      .filter((mark) => mark.thumbnailPath && Math.abs(mark.startMs - clockMs) <= 90_000)
      .sort((a, b) => Math.abs(a.startMs - clockMs) - Math.abs(b.startMs - clockMs))
      .slice(0, 6);
  }, [visibleMarks, clockMs]);

  useEffect(() => {
    const missing = nearbySnapshots.filter((mark) => mark.thumbnailPath && !thumbUrls[mark.id]);
    if (!missing.length) return;
    let cancelled = false;
    void Promise.all(missing.map(async (mark) => {
      const { data } = await supabase.storage.from('bob-uploads').createSignedUrl(mark.thumbnailPath as string, SIGNED_URL_TTL_SECONDS);
      return [mark.id, data?.signedUrl ?? ''] as const;
    })).then((pairs) => {
      if (cancelled) return;
      setThumbUrls((current) => ({ ...current, ...Object.fromEntries(pairs.filter(([, url]) => url)) }));
    });
    return () => { cancelled = true; };
  }, [nearbySnapshots, thumbUrls]);

  const togglePlay = useCallback(() => {
    if (clockMs === null) return;
    if (!playing && !clipAtTime(masterClips, clockMs)) {
      const next = nextClipAfter(masterClips, clockMs);
      if (next) seek(next.startMs);
    }
    setPlaying((current) => !current);
  }, [clockMs, playing, masterClips, seek]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const action = keyboardAction({ key: event.key, targetTag: target?.tagName, isEditable: target?.isContentEditable, metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey });
      if (!action) return;
      event.preventDefault();
      switch (action.type) {
        case 'toggle_play': togglePlay(); break;
        case 'seek': if (clockMs !== null) seek(clockMs + action.deltaMs); break;
        case 'rate': setRate((current) => nextRate(current, action.direction)); break;
        case 'layout': setLayout(action.layout); break;
        case 'fullscreen': void gridRef.current?.requestFullscreen?.(); break;
        case 'mute': setMuted((current) => !current); break;
        case 'escape': setSelectedObservationId(null); break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [togglePlay, seek, clockMs]);

  const jumpClip = (direction: 1 | -1) => {
    if (clockMs === null) return;
    if (direction === 1) {
      const next = nextClipAfter(masterClips, clockMs);
      if (next) seek(next.startMs);
      return;
    }
    const current = clipAtTime(masterClips, clockMs);
    if (current && clockMs - current.startMs > 2000) { seek(current.startMs); return; }
    const previous = previousClipBefore(masterClips, current ? current.startMs : clockMs);
    if (previous) seek(previous.startMs);
  };

  const pendingObservations = useMemo(() => visibleObservations.filter((observation) => !isReviewed(observation)), [visibleObservations]);
  const panelObservations = useMemo(
    () => visibleObservations.filter((observation) => (kindFilter === 'all' || observation.kind === kindFilter) && (showReviewed || !isReviewed(observation))),
    [visibleObservations, kindFilter, showReviewed],
  );
  const selectedObservation = visibleObservations.find((observation) => observation.id === selectedObservationId) ?? null;

  useEffect(() => {
    setNewName(selectedObservation?.kind === 'person' ? selectedObservation.profileName ?? '' : '');
    setPersonDetails(selectedObservation?.kind === 'person' && typeof selectedObservation.profileDetails.notes === 'string' ? selectedObservation.profileDetails.notes : '');
    setNewPlate('');
    setNotes('');
    setReviewMessage(null);
  }, [selectedObservationId]);

  const selectObservation = (observation: ConsoleObservation) => {
    setSelectedObservationId(observation.id);
    setPlaying(false);
    seek(observation.observedAtMs);
    const tileIndex = activeImportIds.indexOf(observation.importId ?? '');
    if (tileIndex >= 0) setMasterIndex(tileIndex);
  };

  const updateInspection = useCallback((patch: Partial<CCTVInspection>) => {
    if (!selectedImportId) return;
    setInspectionsByImport((current) => ({
      ...current,
      [selectedImportId]: normalizeCCTVInspection({ ...(current[selectedImportId] ?? DEFAULT_CCTV_INSPECTION), ...patch }),
    }));
  }, [selectedImportId]);

  const resetInspection = useCallback(() => {
    if (!selectedImportId) return;
    setInspectionsByImport((current) => ({ ...current, [selectedImportId]: { ...DEFAULT_CCTV_INSPECTION } }));
    setEnhancementState(null);
  }, [selectedImportId]);

  const cycleEnhance = useCallback(() => {
    // auto -> on -> off -> auto; auto engages whenever the picture is zoomed in.
    const next = activeInspection.enhance === 'auto' ? 'on' : activeInspection.enhance === 'on' ? 'off' : 'auto';
    updateInspection({ enhance: next });
  }, [activeInspection.enhance, updateInspection]);

  const handleEnhancementPlan = useCallback((plan: EnhancementPlan | null, mode: 'gpu' | 'css') => {
    setEnhancementState((current) => current && current.plan === plan && current.mode === mode ? current : { plan, mode });
  }, []);

  const runReview = async (observation: ConsoleObservation, action: ReviewAction, targetId: string | null = null) => {
    setReviewBusy(`${observation.id}:${action}`);
    setReviewMessage(null);
    const { data, error: reviewError } = await supabase.rpc('review_cctv_entity_observation', {
      p_observation_id: observation.id,
      p_action: action,
      p_target_id: targetId,
      p_display_name: action === 'new_person' ? newName.trim() || null : null,
      p_plate: action === 'new_vehicle' || action === 'accept' ? newPlate.trim() || null : null,
      p_notes: notes.trim() || null,
    });
    setReviewBusy(null);
    if (reviewError) { setReviewMessage(reviewError.message); return; }
    const updated = data && typeof data === 'object' ? toObservation(data as Record<string, unknown>) : null;
    if (updated && observation.importId) {
      setObservationsByImport((current) => ({ ...current, [observation.importId as string]: (current[observation.importId as string] ?? []).map((item) => item.id === updated.id ? updated : item) }));
    }
    if (observation.importId) void loadImportDetail(observation.importId);
    setReviewMessage(action === 'reject' ? 'Rejected.' : action === 'accept_portfolio' ? 'Applied to the whole portfolio.' : 'Saved.');
    // Move on to the next unreviewed entity so review flows like a queue.
    const next = pendingObservations.find((item) => item.id !== observation.id && item.observedAtMs >= observation.observedAtMs) ?? pendingObservations.find((item) => item.id !== observation.id) ?? null;
    if (next && action !== 'merge_portfolio') selectObservation(next);
  };

  const updatePersonProfile = async (observation: ConsoleObservation) => {
    if (!newName.trim()) return;
    setReviewBusy(`${observation.id}:profile`);
    setReviewMessage(null);
    const { error: profileError } = await supabase.rpc('update_cctv_person_profile', {
      p_observation_id: observation.id,
      p_display_name: newName.trim(),
      p_profile_details: personDetails.trim() ? { notes: personDetails.trim() } : {},
      p_notes: notes.trim() || null,
    });
    setReviewBusy(null);
    if (profileError) { setReviewMessage(profileError.message); return; }
    if (observation.importId) void loadImportDetail(observation.importId);
    setReviewMessage('Person profile updated.');
  };

  const addCamera = (importId: string) => {
    if (tileImportIds.includes(importId)) return;
    const next = [...tileImportIds];
    const slot = next.findIndex((value, index) => index < layout && !value);
    if (slot >= 0) next[slot] = importId;
    else if (next.length < layout) next.push(importId);
    else { setLayout(layout === 1 ? 2 : layout === 2 ? 4 : 9); next.push(importId); }
    setTileImportIds(next);
  };

  const removeCamera = (importId: string) => {
    setTileImportIds((current) => current.map((value) => value === importId ? '' : value));
    if (importId === selectedImportId) setSelectedImportId(activeImportIds.find((id) => id !== importId) ?? null);
  };

  const activateTile = (importId: string) => {
    setMasterIndex(Math.max(0, activeImportIds.indexOf(importId)));
    setSelectedImportId(importId);
  };

  const columns = gridColumns(layout);
  const tiles = Array.from({ length: layout }, (_, index) => tileImportIds[index] || null);

  return (
    <div className="page-container cctv-console">
      <header className="cctv-console__header">
        <div>
          <h1 className="page-title"><Camera size={20} aria-hidden="true" /> CCTV console</h1>
          <p className="page-subtitle">
            {selectedImport ? <>{selectedImport.camera_label} · {placeLabelOf(selectedImport)} · {selectedImport.recorded_from ? `${formatDate(parseMs(selectedImport.recorded_from) ?? 0, timeZone)} · ` : ''}{selectedImport.video_count} clips{selectedImport.skipped_count ? `, ${selectedImport.skipped_count} empty slots skipped` : ''}</> : 'Choose a camera import to review.'}
          </p>
        </div>
        <div className="cctv-console__header-actions">
          <button type="button" className="page-action" onClick={() => setShowKeys((current) => !current)} aria-expanded={showKeys}><Keyboard size={16} aria-hidden="true" /> Keys</button>
          <button type="button" className="page-action" onClick={() => navigate('/admin/field-ops?area=cctv-import')}><Plus size={16} aria-hidden="true" /> Import footage</button>
          <button type="button" className="page-action" onClick={() => navigate('/admin/field-ops?area=cctv-review')}>Job queue &amp; exports</button>
        </div>
      </header>
      {showKeys ? (
        <div className="cctv-console__keys" role="note">
          <span><kbd>Space</kbd> play / pause</span><span><kbd>←</kbd><kbd>→</kbd> ±10 s</span><span><kbd>↑</kbd><kbd>↓</kbd> ±1 s</span>
          <span><kbd>[</kbd><kbd>]</kbd> speed</span><span><kbd>1</kbd><kbd>2</kbd><kbd>4</kbd><kbd>9</kbd> grid</span><span><kbd>f</kbd> fullscreen</span><span><kbd>m</kbd> mute</span><span><kbd>Esc</kbd> clear selection</span>
        </div>
      ) : null}
      {error ? <div className="page-error" role="alert"><AlertTriangle size={16} aria-hidden="true" /> {error}</div> : null}

      <div className="cctv-console__layout">
        <aside className="cctv-console__cameras" aria-label="Camera imports">
          <div className="cctv-console__aside-head"><strong>Cameras</strong><button type="button" className="cctv-console__icon-btn" onClick={() => void loadImports()} aria-label="Refresh cameras"><RefreshCw size={14} aria-hidden="true" /></button></div>
          {importsLoading ? <p className="cctv-console__muted"><Loader2 size={14} className="spin" aria-hidden="true" /> Loading…</p> : null}
          {!importsLoading && imports.length === 0 ? <p className="cctv-console__muted">No camera footage has been imported yet. Use “Import footage” to bring an SD card in.</p> : null}
          <ul>
            {imports.map((row) => {
              const inView = activeImportIds.includes(row.id);
              const pending = (observationsByImport[row.id] ?? []).filter((observation) => !isReviewed(observation)).length;
              return (
                <li key={row.id} className={`cctv-console__camera${row.id === selectedImportId ? ' is-selected' : ''}${inView ? ' is-in-view' : ''}`}>
                  <button type="button" className="cctv-console__camera-main" onClick={() => setSelectedImportId(row.id)}>
                    <span className="cctv-console__camera-label">{row.camera_label}</span>
                    <span className="cctv-console__camera-place">{placeLabelOf(row)}</span>
                    <span className="cctv-console__camera-meta">{row.recorded_from ? formatDate(parseMs(row.recorded_from) ?? 0, row.source_timezone) : 'No footage yet'} · {row.video_count} clips · <span className={`cctv-console__status is-${row.status}`}>{row.status.replace(/_/g, ' ')}</span>{observationsByImport[row.id] ? ` · ${pending} to review` : ''}</span>
                  </button>
                  {inView
                    ? <button type="button" className="cctv-console__icon-btn" onClick={() => removeCamera(row.id)} aria-label={`Remove ${row.camera_label} from the view`} disabled={activeImportIds.length === 1}><X size={14} aria-hidden="true" /></button>
                    : <button type="button" className="cctv-console__icon-btn" onClick={() => addCamera(row.id)} aria-label={`Add ${row.camera_label} to the view`}><Plus size={14} aria-hidden="true" /></button>}
                </li>
              );
            })}
          </ul>
        </aside>

        <main className="cctv-console__stage">
          <div className="cctv-console__grid-wrap" ref={gridRef}>
            <div className="cctv-console__grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
              {tiles.map((importId, index) => {
                const row = importId ? imports.find((item) => item.id === importId) ?? null : null;
                if (!row || clockMs === null) {
                  return (
                    <div key={`empty-${index}`} className="cctv-tile is-empty">
                      <span>{row ? 'Loading footage…' : 'Empty tile — add a camera from the list'}</span>
                    </div>
                  );
                }
                return (
                  <CCTVPlayerTile key={row.id} label={row.camera_label} placeLabel={placeLabelOf(row)} clips={clipsByImport[row.id] ?? []} clockMs={clockMs}
                    playing={playing} rate={rate} muted={muted} isMaster={row.id === masterImportId} active={row.id === selectedImportId}
                    timeZone={row.source_timezone} resolveUrl={resolveUrl} onTick={handleTick} onClipEnded={handleClipEnded} onDurationKnown={handleDurationKnown}
                    onActivate={() => activateTile(row.id)}
                    inspection={row.id === selectedImportId ? activeInspection : undefined}
                    onInspectionChange={row.id === selectedImportId ? updateInspection : undefined}
                    onEnhancementPlan={row.id === selectedImportId ? handleEnhancementPlan : undefined}
                    onRemove={activeImportIds.length > 1 ? () => removeCamera(row.id) : undefined} />
                );
              })}
            </div>
          </div>

          <div className="cctv-console__controls" role="toolbar" aria-label="Playback controls">
            <button type="button" className="cctv-console__ctl" onClick={() => jumpClip(-1)} aria-label="Previous clip"><ChevronLeft size={18} aria-hidden="true" /></button>
            <button type="button" className="cctv-console__ctl" onClick={() => clockMs !== null && seek(clockMs - 10_000)} aria-label="Back 10 seconds"><Rewind size={18} aria-hidden="true" /></button>
            <button type="button" className="cctv-console__ctl is-primary" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'} disabled={clockMs === null}>{playing ? <Pause size={20} aria-hidden="true" /> : <Play size={20} aria-hidden="true" />}</button>
            <button type="button" className="cctv-console__ctl" onClick={() => clockMs !== null && seek(clockMs + 10_000)} aria-label="Forward 10 seconds"><FastForward size={18} aria-hidden="true" /></button>
            <button type="button" className="cctv-console__ctl" onClick={() => jumpClip(1)} aria-label="Next clip"><ChevronRight size={18} aria-hidden="true" /></button>
            <span className="cctv-console__clock" aria-live="off">{clockMs !== null ? <><strong>{formatClock(clockMs, timeZone)}</strong><small>{formatDate(clockMs, timeZone)} · {timeZone}</small></> : '—'}</span>
            <label className="cctv-console__rate">Speed
              <select value={rate} onChange={(event) => setRate(Number(event.target.value))} aria-label="Playback speed">
                {PLAYBACK_RATES.map((option) => <option key={option} value={option}>{option}×</option>)}
              </select>
            </label>
            <button type="button" className="cctv-console__ctl" onClick={() => setMuted((current) => !current)} aria-label={muted ? 'Unmute' : 'Mute'}>{muted ? <VolumeX size={18} aria-hidden="true" /> : <Volume2 size={18} aria-hidden="true" />}</button>
            <div className="cctv-console__inspection-controls" role="group" aria-label="Active camera image inspection">
              <button type="button" className="cctv-console__ctl" onClick={() => updateInspection({ zoom: nextInspectionZoom(activeInspection.zoom, -1) })} disabled={activeInspection.zoom <= 1 || !selectedImportId} aria-label="Zoom out" title="Zoom out"><ZoomOut size={16} aria-hidden="true" /></button>
              <output className="cctv-console__inspection-value" aria-label={`Active camera zoom ${activeInspection.zoom} times`}>{activeInspection.zoom}×</output>
              <button type="button" className="cctv-console__ctl" onClick={() => updateInspection({ zoom: nextInspectionZoom(activeInspection.zoom, 1) })} disabled={activeInspection.zoom >= 4 || !selectedImportId} aria-label="Zoom in" title="Zoom in (or scroll on the picture)"><ZoomIn size={16} aria-hidden="true" /></button>
              <button type="button" className={`cctv-console__ctl${enhancementActive ? ' is-on' : ''}`} onClick={cycleEnhance} disabled={!selectedImportId} aria-pressed={enhancementActive}
                aria-label={`Enhance: ${activeInspection.enhance === 'auto' ? 'automatic when zoomed' : activeInspection.enhance === 'on' ? 'always on' : 'off'}`}
                title={activeInspection.enhance === 'auto' ? 'Enhance: automatic when zoomed. Click for always on.' : activeInspection.enhance === 'on' ? 'Enhance: always on. Click to turn off.' : 'Enhance: off. Click for automatic when zoomed.'}>
                <Sparkles size={16} aria-hidden="true" /> {activeInspection.enhance === 'auto' ? 'Auto' : activeInspection.enhance === 'on' ? 'On' : 'Off'}
              </button>
              <button type="button" className={`cctv-console__ctl${showInspectionTools ? ' is-on' : ''}`} onClick={() => setShowInspectionTools((current) => !current)} disabled={!selectedImportId} aria-pressed={showInspectionTools} aria-expanded={showInspectionTools} aria-controls="cctv-image-adjustments" aria-label="Image adjustments" title="Image adjustments"><SlidersHorizontal size={16} aria-hidden="true" /></button>
              <button type="button" className="cctv-console__ctl" onClick={resetInspection} disabled={!inspectionAdjusted || !selectedImportId} aria-label="Reset image inspection" title="Reset image inspection"><RotateCcw size={16} aria-hidden="true" /></button>
            </div>
            <div className="cctv-console__layouts" role="group" aria-label="Grid layout">
              {GRID_LAYOUTS.map((option) => <button key={option} type="button" className={`cctv-console__ctl${layout === option ? ' is-on' : ''}`} onClick={() => setLayout(option)} aria-pressed={layout === option} aria-label={`${option} tile grid`}>{option === 1 ? <Maximize2 size={16} aria-hidden="true" /> : <><Grid2x2 size={16} aria-hidden="true" />{option}</>}</button>)}
            </div>
            <div className="cctv-console__zoom" role="group" aria-label="Timeline zoom">
              <button type="button" className="cctv-console__ctl" onClick={() => bounds && setView(bounds)}>Fit</button>
              <button type="button" className="cctv-console__ctl" onClick={() => bounds && clockMs !== null && setView(zoomView(bounds, clockMs, 3_600_000 / Math.max(1, bounds.endMs - bounds.startMs), bounds))}>1 h</button>
              <button type="button" className="cctv-console__ctl" onClick={() => bounds && clockMs !== null && setView(zoomView(bounds, clockMs, 600_000 / Math.max(1, bounds.endMs - bounds.startMs), bounds))}>10 min</button>
            </div>
          </div>

          {showInspectionTools ? (
            <div id="cctv-image-adjustments" className="cctv-console__inspection-panel" aria-label="Active camera image adjustments">
              <p className="cctv-console__inspection-readout" role="status">
                <Sparkles size={13} aria-hidden="true" />
                {enhancementActive
                  ? <>Enhanced view is display-only; the recording is unchanged. {enhancementState?.mode === 'css' ? 'Basic adjustments only in this browser. ' : ''}{enhancementReadout(enhancementState?.plan ?? null)}</>
                  : activeInspection.enhance === 'off' ? 'Enhancement is off. Zoom, wheel and drag still work on the raw picture.' : 'Enhancement engages automatically when you zoom in. Scroll on the picture to zoom, drag to pan, click to re-centre.'}
              </p>
              <label className="cctv-console__inspection-field"><span>Brightness <output>{activeInspection.brightness}%</output></span><input type="range" min="60" max="160" step="5" value={activeInspection.brightness} onChange={(event) => updateInspection({ brightness: Number(event.target.value) })} /></label>
              <label className="cctv-console__inspection-field"><span>Contrast <output>{activeInspection.contrast}%</output></span><input type="range" min="60" max="180" step="5" value={activeInspection.contrast} onChange={(event) => updateInspection({ contrast: Number(event.target.value) })} /></label>
              <label className="cctv-console__inspection-field"><span>Colour <output>{activeInspection.saturation}%</output></span><input type="range" min="0" max="200" step="5" value={activeInspection.saturation} onChange={(event) => updateInspection({ saturation: Number(event.target.value) })} /></label>
              <label className="cctv-console__inspection-field"><span>Detail <output>{activeInspection.detail}%</output></span><input type="range" min="0" max="200" step="5" value={activeInspection.detail} onChange={(event) => updateInspection({ detail: Number(event.target.value) })} disabled={!enhancementActive} /></label>
            </div>
          ) : null}

          {bounds && view && clockMs !== null ? (
            <CCTVTimeline view={view} bounds={bounds} clockMs={clockMs} clips={visibleClips} marks={visibleMarks} observations={visibleObservations}
              selectedObservationId={selectedObservationId} timeZone={timeZone} onSeek={seek} onViewChange={setView}
              onSelectObservation={(id) => { const found = visibleObservations.find((item) => item.id === id); if (found) selectObservation(found); }} />
          ) : (
            <div className="cctv-console__timeline-empty">{detailLoading ? <><Loader2 size={16} className="spin" aria-hidden="true" /> Loading the camera’s timeline…</> : 'No footage, snapshots or detections yet for this camera.'}</div>
          )}
          <div className="cctv-console__legend" aria-hidden="true">
            <span><i className="is-alert" /> alert (plate read / pest)</span><span><i className="is-detection" /> detection</span><span><i className="is-motion" /> camera motion</span><span><i className="is-quality" /> camera disturbance</span><span><i className="is-pin" /> entity · dimmed once reviewed</span>
          </div>

          {nearbySnapshots.length ? (
            <div className="cctv-console__snapshots" aria-label="Camera snapshots near the current time">
              {nearbySnapshots.map((mark) => (
                <button key={mark.id} type="button" className="cctv-console__snapshot" onClick={() => seek(mark.startMs)} title={formatClock(mark.startMs, timeZone)}>
                  {thumbUrls[mark.id] ? <img src={thumbUrls[mark.id]} alt={`Camera snapshot at ${formatClock(mark.startMs, timeZone)}`} loading="lazy" /> : <span className="cctv-console__snapshot-blank" />}
                  <small>{formatClock(mark.startMs, timeZone)}</small>
                </button>
              ))}
            </div>
          ) : null}
        </main>

        <aside className="cctv-console__entities" aria-label="Entities seen">
          <div className="cctv-console__aside-head">
            <strong>Entities</strong>
            <span className="cctv-console__count">{pendingObservations.length} to review</span>
          </div>
          <div className="cctv-console__filters" role="group" aria-label="Entity filters">
            {(['all', 'person', 'vehicle', 'animal'] as KindFilter[]).map((option) => (
              <button key={option} type="button" className={`cctv-console__chip${kindFilter === option ? ' is-on' : ''}`} onClick={() => setKindFilter(option)} aria-pressed={kindFilter === option}>
                {option === 'all' ? 'All' : <>{KIND_ICON[option]} {option}</>}
              </button>
            ))}
            <label className="cctv-console__toggle"><input type="checkbox" checked={showReviewed} onChange={(event) => setShowReviewed(event.target.checked)} /> show reviewed</label>
          </div>
          {detailLoading && panelObservations.length === 0 ? <p className="cctv-console__muted"><Loader2 size={14} className="spin" aria-hidden="true" /> Loading…</p> : null}
          {!detailLoading && panelObservations.length === 0 ? (
            <p className="cctv-console__muted">
              {visibleObservations.length ? 'Everything here has been reviewed. Tick “show reviewed” to see it.' : visibleClips.some((clip) => clip.jobStatus === 'queued' || clip.jobStatus === 'processing') ? 'Inference is still running on this footage; entities appear here as each clip finishes.' : 'No people, vehicles or animals were reported for this footage.'}
            </p>
          ) : null}
          <ul className="cctv-console__entity-list">
            {panelObservations.map((observation) => {
              const selected = observation.id === selectedObservationId;
              const weakCandidate = isWeakInferenceCandidate(observation);
              return (
                <li key={observation.id} className={`cctv-entity${selected ? ' is-selected' : ''}${isReviewed(observation) ? ' is-reviewed' : ''}${weakCandidate ? ' is-weak' : ''} is-${observation.kind}`}>
                  <button type="button" className="cctv-entity__main" onClick={() => selectObservation(observation)} aria-pressed={selected}>
                    {observation.thumbnail ? <img className="cctv-entity__thumb" src={observation.thumbnail} alt="" /> : <span className="cctv-entity__thumb is-blank">{KIND_ICON[observation.kind]}</span>}
                    <span className="cctv-entity__text">
                      <strong>{entityTitle(observation)}</strong>
                      <small>{formatClock(observation.observedAtMs, timeZone)}{observation.observedToMs ? ` – ${formatClock(observation.observedToMs, timeZone)}` : ''}{observation.confidence !== null ? ` · ${Math.round(observation.confidence * 100)}%` : ''}{observation.qualityState !== 'clear' ? ` · ${observation.qualityState}` : ''}</small>
                      <small className={`cctv-entity__state${weakCandidate ? ' is-weak' : ''}`}>{isReviewed(observation) ? observation.reviewState.replace(/_/g, ' ') : `${inferenceReviewLabel(observation)} · ${observation.candidates.length ? `${observation.candidates.length} possible match${observation.candidates.length === 1 ? '' : 'es'}` : observation.portfolioState === 'candidate' ? 'seen before in this footage' : 'first sighting'}`}</small>
                    </span>
                  </button>
                  {selected ? (
                    <div className="cctv-entity__review">
                      {observation.kind === 'vehicle' ? (
                        <dl className="cctv-entity__facts">
                          {['colour', 'body_type', 'make', 'model'].filter((key) => observation.attributes[key]).map((key) => <div key={key}><dt>{key.replace('_', ' ')}</dt><dd>{String(observation.attributes[key])}</dd></div>)}
                          {observation.attributes.plate_confidence ? <div><dt>plate read</dt><dd>{Math.round(Number(observation.attributes.plate_confidence) * 100)}%</dd></div> : null}
                        </dl>
                      ) : null}
                      {observation.kind === 'animal' ? (
                        <dl className="cctv-entity__facts">
                          <div><dt>species</dt><dd>{observation.species || 'unidentified'}{observation.speciesConfidence !== null ? ` (${Math.round(observation.speciesConfidence * 100)}%)` : ''}</dd></div>
                          <div><dt>pest</dt><dd>{observation.isPest === null ? 'unknown' : observation.isPest ? 'yes' : 'no'}</dd></div>
                          {observation.attributes.species_status ? <div><dt>model</dt><dd>{String(observation.attributes.species_status).replace(/_/g, ' ')}</dd></div> : null}
                        </dl>
                      ) : null}
                      {observation.kind === 'person' ? (
                        <dl className="cctv-entity__facts">
                          <div><dt>profile</dt><dd>{observation.profileName || 'Unknown person'}</dd></div>
                          {['upper_body_colour', 'lower_body_colour'].filter((key) => observation.attributes[key]).map((key) => <div key={key}><dt>{key.replace(/_/g, ' ')}</dt><dd>{String(observation.attributes[key])}</dd></div>)}
                          <div><dt>face</dt><dd>{observation.attributes.face_event_id ? 'captured' : 'not captured'}</dd></div>
                        </dl>
                      ) : null}

                      {observation.candidates.length ? (
                        <div className="cctv-entity__candidates">
                          <strong>Same or similar on record</strong>
                          {observation.candidates.slice(0, 5).map((candidate, index) => {
                            const mapped = candidateAction(observation, candidate);
                            return (
                              <div key={`${candidate.match_kind}-${candidate.match_id}-${index}`} className="cctv-entity__candidate">
                                <span>
                                  <strong>{candidate.display_name || candidate.plate_number || (candidate.match_kind === 'observation' ? 'Earlier sighting' : 'Known record')}</strong>
                                  <small>{candidate.basis?.replace(/_/g, ' ')} · {Math.round((candidate.score ?? 0) * 100)}%{candidate.last_seen_at ? ` · last seen ${formatDate(parseMs(candidate.last_seen_at) ?? 0, timeZone)}` : ''}</small>
                                </span>
                                {mapped ? <button type="button" className="page-action" disabled={reviewBusy !== null || isReviewed(observation)} onClick={() => void runReview(observation, mapped.action, mapped.targetId)}><Link2 size={14} aria-hidden="true" /> {mapped.label}</button> : null}
                              </div>
                            );
                          })}
                        </div>
                      ) : null}

                      {!isReviewed(observation) ? (
                        <>
                          <label className="cctv-entity__field">Notes <input value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Optional reviewer note" /></label>
                          {observation.kind === 'person' && !observation.personRecordId ? (
                            <label className="cctv-entity__field">New person <input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Display name, e.g. Unknown male, red jacket" /></label>
                          ) : null}
                          {observation.kind === 'vehicle' && !observation.plate ? (
                            <label className="cctv-entity__field">Plate (if you can read it) <input value={newPlate} onChange={(event) => setNewPlate(event.target.value.toUpperCase())} placeholder="e.g. ABC123" /></label>
                          ) : null}
                          <div className="cctv-entity__actions">
                            <button type="button" className="page-action is-primary" disabled={reviewBusy !== null} onClick={() => void runReview(observation, 'accept')}><Check size={14} aria-hidden="true" /> {observation.kind === 'vehicle' && (observation.plate || newPlate.trim()) ? 'Accept · record vehicle' : 'Accept'}</button>
                            {observation.kind === 'person' && !observation.personRecordId ? <button type="button" className="page-action" disabled={reviewBusy !== null || !newName.trim()} onClick={() => void runReview(observation, 'new_person')}><UserRound size={14} aria-hidden="true" /> New person</button> : null}
                            {observation.kind === 'vehicle' && !observation.plate ? <button type="button" className="page-action" disabled={reviewBusy !== null || !newPlate.trim()} onClick={() => void runReview(observation, 'new_vehicle')}><Car size={14} aria-hidden="true" /> Record vehicle</button> : null}
                            <button type="button" className="page-action is-danger" disabled={reviewBusy !== null} onClick={() => void runReview(observation, 'reject')}><X size={14} aria-hidden="true" /> Not a {observation.kind}</button>
                          </div>
                        </>
                      ) : (
                        <div className="cctv-entity__actions">
                          {(observation.personRecordId || observation.canonicalVehicleId) && observation.portfolioKey ? <button type="button" className="page-action" disabled={reviewBusy !== null} onClick={() => void runReview(observation, 'accept_portfolio')}>Apply identity to unreviewed sightings in this portfolio</button> : null}
                          {observation.reviewNotes ? <p className="cctv-console__muted">{observation.reviewNotes}</p> : null}
                        </div>
                      )}
                      {observation.kind === 'person' && observation.personRecordId ? (
                        <div className="cctv-entity__profile-editor">
                          <label className="cctv-entity__field">Person name <input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Unknown Person #1" /></label>
                          <label className="cctv-entity__field">Profile details <textarea value={personDetails} onChange={(event) => setPersonDetails(event.target.value)} placeholder="Optional details confirmed by the reviewer" rows={2} /></label>
                          <button type="button" className="page-action" disabled={reviewBusy !== null || !newName.trim()} onClick={() => void updatePersonProfile(observation)}><UserRound size={14} aria-hidden="true" /> Save person profile</button>
                        </div>
                      ) : null}
                      {reviewBusy?.startsWith(observation.id) ? <p className="cctv-console__muted"><Loader2 size={14} className="spin" aria-hidden="true" /> Saving…</p> : null}
                      {reviewMessage ? <p className="cctv-console__muted" role="status">{reviewMessage}</p> : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {selectedObservation && selectedObservation.evidenceId ? (
            <p className="cctv-console__muted cctv-console__footnote">
              <button type="button" className="cctv-import-link" onClick={() => navigate(`/admin/field-ops?area=cctv-review`)}>Open this clip in the job queue</button> for exports and report receipts.
            </p>
          ) : null}
        </aside>
      </div>
    </div>
  );
};

export default CCTVConsolePage;
