import { isAdminTierRole } from '../lib/roles';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  Bookmark,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ExternalLink,
  Film,
  Grid2x2,
  ImageDown,
  Keyboard,
  Link2,
  Loader2,
  Lock,
  Maximize2,
  Pause,
  PawPrint,
  Play,
  Plus,
  RefreshCw,
  Rewind,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  StepBack,
  StepForward,
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
  asRecord,
  bytesLabel,
  cameraItem,
  candidateAction,
  clipAtTime,
  clipItem,
  clipStatusLabel,
  clampMs,
  createRefreshCoalescer,
  custodyBadge,
  DEFAULT_CCTV_INSPECTION,
  describeConsoleFailure,
  durationLabel,
  fitTiles,
  followClock,
  formatClock,
  formatDate,
  gridColumns,
  groupClipsByDay,
  importIdsOf,
  inferenceReviewLabel,
  initialView,
  isDefaultCCTVInspection,
  isEnhancementActive,
  isReviewed,
  isWeakInferenceCandidate,
  keyboardAction,
  layoutForCount,
  nextClipAfter,
  nextInspectionZoom,
  nextRate,
  normalizeCCTVInspection,
  observationCountsByEvidence,
  parseClipIntegrity,
  parseMs,
  previousClipBefore,
  timelineBounds,
  toObservation,
  vehicleAttributeCandidateFrom,
  weaponHintFrom,
  zoomView,
  GRID_LAYOUTS,
  PLAYBACK_RATES,
  entityTitle,
  type ClipJobStatus,
  type CCTVInspection,
  type ConsoleClip,
  type ConsoleFailure,
  type ConsoleMark,
  type ConsoleObservation,
  type EntityKind,
  type GridLayout,
  type PortfolioCandidate,
  type ReviewAction,
  type SceneSynopsis,
  type TimeView,
  type ViewItem,
} from '../lib/cctvConsole';
import { CCTVTimeline } from '../components/CCTVTimeline';
import { CCTVPlayerTile, type CCTVPlayerTileHandle } from '../components/CCTVPlayerTile';
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
type BookmarkDraft = { evidenceId: string; atMs: number; title: string; notes: string; severity: 'low' | 'standard' | 'high' | 'critical'; observationId: string | null };
type LockDraft = { evidenceId: string; reason: string };
type CustodyEvent = { at: string; kind: string; actor_user_id: string | null; detail: Record<string, unknown> };
type BiometricGovernance = { live_face_templates: number; live_templates: number; expired_templates: number; rejected_still_holding_templates: number; oldest_live_template_at: string | null; last_expiry_run_at: string | null; purpose: string; default_retention: string };
type CustodyRecord = {
  evidence_item_id: string;
  storage_path: string | null;
  captured_at: string;
  sha256_hash: string | null;
  source_size_bytes: number | null;
  source_hashed_at: string | null;
  is_court_ready: boolean;
  locked_at: string | null;
  lock: { locked_by?: string; reason?: string; locked_at?: string } | null;
  retention_hold: boolean;
  retention_reason: string | null;
  integrity: { state?: string; checked_at?: string; checked_by?: string; check_count?: number; mismatch_count?: number; first_verified_at?: string } | null;
  events: CustodyEvent[];
};

const CUSTODY_EVENT_LABEL: Record<string, string> = {
  cctv_evidence_locked: 'Evidence lock applied',
  cctv_bookmark_created: 'Bookmark recorded as an incident',
  cctv_evidence_integrity_verified: 'Stored bytes verified against the recorded hash',
  cctv_evidence_integrity_mismatch: 'Stored bytes did NOT match the recorded hash',
  cctv_evidence_integrity_unanchored: 'Bytes measured before any hash was recorded',
  cctv_report_issued: 'Report receipt issued',
};

const SIGNED_URL_TTL_SECONDS = 3600;
const DETAIL_POLL_INTERVAL_MS = 30_000;
// Realtime change bursts (progress ticks, observation inserts) collapse into one reload per import per window.
const DETAIL_REFRESH_COALESCE_MS = 1500;
type ConsoleError = ConsoleFailure & { retry: (() => void) | null };
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

function markSeverity(value: unknown, source: unknown, kind: unknown): ConsoleMark['severity'] {
  if (source === 'inference' && kind === 'quality_event') return 'quality';
  return value === 'alert' || value === 'detection' ? value : 'motion';
}

const CCTVConsolePage: React.FC = () => {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const organizationId = profile?.organizationId ?? null;
  const search = new URLSearchParams(location.search);
  const requestedImportId = search.get('import');
  const popout = search.get('popout') === '1';
  const isAdmin = isAdminTierRole(profile?.role);

  const [imports, setImports] = useState<ImportRow[]>([]);
  const [importsLoading, setImportsLoading] = useState(true);
  const [error, setError] = useState<ConsoleError | null>(null);
  const [selectedImportId, setSelectedImportId] = useState<string | null>(requestedImportId);
  const [tiles, setTiles] = useState<Array<ViewItem | null>>([]);
  const [layout, setLayout] = useState<GridLayout>(1);
  const [masterIndex, setMasterIndex] = useState(0);
  const [activeTileId, setActiveTileId] = useState<string | null>(null);
  const [expandedDays, setExpandedDays] = useState<Record<string, boolean>>({});

  const [clipsByImport, setClipsByImport] = useState<Record<string, ConsoleClip[]>>({});
  const [marksByImport, setMarksByImport] = useState<Record<string, ConsoleMark[]>>({});
  const [observationsByImport, setObservationsByImport] = useState<Record<string, ConsoleObservation[]>>({});
  const [detailLoading, setDetailLoading] = useState(false);

  const [clockMs, setClockMs] = useState<number | null>(null);
  // Incremented on every explicit seek (timeline, pin, keyboard) so recordings on their own clocks can tell a
  // deliberate jump from the ordinary ticking of the shared clock.
  const [seekNonce, setSeekNonce] = useState(0);
  const [view, setView] = useState<TimeView | null>(null);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [muted, setMuted] = useState(true);
  const [inspectionsByTile, setInspectionsByTile] = useState<Record<string, CCTVInspection>>({});
  const [showInspectionTools, setShowInspectionTools] = useState(false);
  const [enhancementState, setEnhancementState] = useState<{ plan: EnhancementPlan | null; mode: 'gpu' | 'css' } | null>(null);

  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [showReviewed, setShowReviewed] = useState(false);
  const [selectedObservationId, setSelectedObservationId] = useState<string | null>(null);
  const [reviewBusy, setReviewBusy] = useState<string | null>(null);
  const [reviewMessage, setReviewMessage] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [personDetails, setPersonDetails] = useState('');
  const [personCategory, setPersonCategory] = useState('');
  const [newPlate, setNewPlate] = useState('');
  const [vehicleNotes, setVehicleNotes] = useState('');
  const [notes, setNotes] = useState('');
  const [correctingVehicleId, setCorrectingVehicleId] = useState<string | null>(null);
  const [correctMake, setCorrectMake] = useState('');
  const [correctModel, setCorrectModel] = useState('');
  const [correctColour, setCorrectColour] = useState('');
  const [correctBodyType, setCorrectBodyType] = useState('');
  const [correctYear, setCorrectYear] = useState('');
  const [showKeys, setShowKeys] = useState(false);
  const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({});
  const [bookmarkDraft, setBookmarkDraft] = useState<BookmarkDraft | null>(null);
  const [lockDraft, setLockDraft] = useState<LockDraft | null>(null);
  const [custody, setCustody] = useState<{ evidenceId: string; loading: boolean; record: CustodyRecord | null; error: string | null } | null>(null);
  const [governance, setGovernance] = useState<BiometricGovernance | null>(null);
  const [showGovernance, setShowGovernance] = useState(false);
  const [evidenceBusy, setEvidenceBusy] = useState<string | null>(null);
  const [evidenceMessage, setEvidenceMessage] = useState<string | null>(null);

  const reviewPaneRef = useRef<HTMLElement | null>(null);
  const tileRefs = useRef<Record<string, CCTVPlayerTileHandle | null>>({});
  const urlCache = useRef<Map<string, { url: string; expiresAt: number }>>(new Map());
  const durationOverrides = useRef<Map<string, number>>(new Map());

  const selectedImport = imports.find((row) => row.id === selectedImportId) ?? null;
  const timeZone = selectedImport?.source_timezone || 'Pacific/Auckland';
  const wallItems = useMemo(() => tiles.slice(0, layout).filter((item): item is ViewItem => Boolean(item)), [tiles, layout]);
  const activeImportIds = useMemo(() => importIdsOf(wallItems), [wallItems]);
  const cameraItems = useMemo(() => wallItems.filter((item) => item.kind === 'camera'), [wallItems]);
  const cameraImportIds = useMemo(() => importIdsOf(cameraItems), [cameraItems]);
  // Camera tiles contribute every clip of their camera; recordings opened on their own contribute just themselves,
  // so the timeline shows and controls whatever is actually on the wall.
  const visibleClips = useMemo(() => {
    const seen = new Set<string>();
    const result: ConsoleClip[] = [];
    for (const clip of cameraImportIds.flatMap((id) => clipsByImport[id] ?? [])) {
      if (!seen.has(clip.evidenceId)) { seen.add(clip.evidenceId); result.push(clip); }
    }
    for (const item of wallItems) {
      if (item.kind !== 'clip' || seen.has(item.evidenceId)) continue;
      const clip = (clipsByImport[item.importId] ?? []).find((candidate) => candidate.evidenceId === item.evidenceId);
      if (clip) { seen.add(clip.evidenceId); result.push(clip); }
    }
    return result.sort((a, b) => a.startMs - b.startMs);
  }, [cameraImportIds, clipsByImport, wallItems]);
  const visibleMarks = useMemo(() => cameraImportIds.flatMap((id) => marksByImport[id] ?? []), [cameraImportIds, marksByImport]);
  const visibleObservations = useMemo(
    () => activeImportIds.flatMap((id) => observationsByImport[id] ?? []).sort((a, b) => a.observedAtMs - b.observedAtMs),
    [activeImportIds, observationsByImport],
  );
  const bounds = useMemo(() => timelineBounds(visibleClips, visibleMarks, visibleObservations), [visibleClips, visibleMarks, visibleObservations]);
  const masterItem = cameraItems[Math.min(masterIndex, Math.max(0, cameraItems.length - 1))] ?? null;
  const masterClips = masterItem ? clipsByImport[masterItem.importId] ?? [] : [];
  const activeTile = wallItems.find((item) => item.id === activeTileId) ?? wallItems[0] ?? null;
  // The clock is driven by the master camera; with only recordings on the wall, by the active recording.
  const clockDriverId = masterItem?.id ?? activeTile?.id ?? null;
  const activeInspection = activeTile ? inspectionsByTile[activeTile.id] ?? DEFAULT_CCTV_INSPECTION : DEFAULT_CCTV_INSPECTION;
  const inspectionAdjusted = !isDefaultCCTVInspection(activeInspection);
  const enhancementActive = isEnhancementActive(activeInspection);
  const selectedClips = useMemo(() => (selectedImportId ? clipsByImport[selectedImportId] ?? [] : []), [selectedImportId, clipsByImport]);
  const selectedObservationsAll = useMemo(() => (selectedImportId ? observationsByImport[selectedImportId] ?? [] : []), [selectedImportId, observationsByImport]);
  const evidenceCounts = useMemo(() => observationCountsByEvidence(selectedObservationsAll), [selectedObservationsAll]);
  const dayGroups = useMemo(() => groupClipsByDay(selectedClips, timeZone), [selectedClips, timeZone]);
  const clipsById = useMemo(() => {
    const map = new Map<string, ConsoleClip>();
    for (const clips of Object.values(clipsByImport)) for (const clip of clips) map.set(clip.evidenceId, clip);
    return map;
  }, [clipsByImport]);

  // The recording under the active tile: the pinned clip, or whichever clip of the active camera is at the clock.
  const activeClip = useMemo(() => {
    if (!activeTile) return null;
    if (activeTile.kind === 'clip') return clipsById.get(activeTile.evidenceId) ?? null;
    return clockMs === null ? null : clipAtTime(clipsByImport[activeTile.importId] ?? [], clockMs);
  }, [activeTile, clipsById, clipsByImport, clockMs]);

  const loadImports = useCallback(async () => {
    if (!organizationId) {
      setImports([]);
      setImportsLoading(false);
      setError({ kind: 'permission', text: 'Organisation access could not be confirmed. The CCTV console is unavailable.', retryable: false, retry: null });
      return;
    }
    setImportsLoading(true);
    const { data, error: loadError } = await supabase
      .from('cctv_imports')
      .select('id, camera_label, camera_key, status, location_id, site_id, zone_id, source_timezone, source_device_kind, recorded_from, recorded_to, video_count, skipped_count, snapshot_count, created_at, locations(name, address)')
      .eq('organization_id', organizationId)
      .neq('status', 'archived')
      .order('created_at', { ascending: false })
      .limit(200);
    if (loadError) {
      setError({ ...describeConsoleFailure(loadError.message, 'camera list', navigator.onLine), retry: () => void loadImports() });
      setImportsLoading(false);
      return;
    }
    setError((current) => (current?.retryable ? null : current));
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
    const { data, error: detailError } = await supabase.rpc('get_cctv_console_import_detail', { p_import_id: importId });
    if (detailError) {
      // Keep whatever this camera already showed; a dropped connection must not blank the wall or the timeline.
      setError({ ...describeConsoleFailure(detailError.message, 'recordings, events and observations for this camera', navigator.onLine), retry: () => void loadImportDetail(importId) });
      setDetailLoading(false);
      return;
    }
    const detail = asRecord(data);
    const evidenceRows = (Array.isArray(detail.evidence) ? detail.evidence : []) as Array<{ id: string; storage_path: string | null; captured_at: string; metadata: Record<string, unknown> | null; sha256_hash: string | null; is_court_ready: boolean | null; locked_at: string | null; retention_hold: boolean | null }>;
    const jobRows = (Array.isArray(detail.jobs) ? detail.jobs : []) as Array<{ id: string; evidence_item_id: string; status: string }>;
    const synopsisRows = (Array.isArray(detail.synopses) ? detail.synopses : []) as Array<{ evidence_id: string; approval_status: string; generated_summary: string | null; generated_at: string | null }>;
    const markRows = (Array.isArray(detail.marks) ? detail.marks : []) as Array<Record<string, unknown>>;
    const observationRows = (Array.isArray(detail.observations) ? detail.observations : []) as Array<Record<string, unknown>>;
    setError((current) => (current?.retryable ? null : current));
    const jobByEvidence = new Map<string, { id: string; status: string }>();
    for (const job of jobRows) jobByEvidence.set(job.evidence_item_id, { id: job.id, status: job.status });
    const synopsisByEvidence = new Map<string, SceneSynopsis>();
    for (const row of synopsisRows) {
      if (row.generated_summary) synopsisByEvidence.set(row.evidence_id, { text: row.generated_summary, approvalStatus: row.approval_status, generatedAt: row.generated_at });
    }
    const clips: ConsoleClip[] = evidenceRows.flatMap((row) => {
      const metadata = row.metadata ?? {};
      const startMs = parseMs(typeof metadata.recorded_start_at === 'string' ? metadata.recorded_start_at : null) ?? parseMs(row.captured_at);
      if (startMs === null || !row.storage_path) return [];
      const fileType = typeof metadata.file_type === 'string' ? metadata.file_type : 'video/mp4';
      const mediaKind = fileType.startsWith('image/') ? 'photo' : 'video';
      const known = durationOverrides.current.get(row.id);
      const slotEnd = parseMs(typeof metadata.recorded_end_at === 'string' ? metadata.recorded_end_at : null);
      const endMs = mediaKind === 'photo' ? startMs + 1000 : known ? startMs + known : slotEnd && slotEnd > startMs ? slotEnd : startMs + 30 * 60_000;
      const job = jobByEvidence.get(row.id);
      return [{
        evidenceId: row.id,
        importId,
        jobId: job?.id ?? null,
        jobStatus: (job?.status as ClipJobStatus) ?? 'none',
        fileName: typeof metadata.file_name === 'string' ? metadata.file_name : row.storage_path.split('/').pop() || row.id,
        mediaKind,
        startMs,
        endMs,
        bucket: typeof metadata.storage_bucket === 'string' ? metadata.storage_bucket : 'bob-uploads',
        playbackPath: typeof metadata.playback_storage_path === 'string' ? metadata.playback_storage_path : null,
        sourcePath: row.storage_path,
        fileType,
        sizeBytes: typeof metadata.file_size_bytes === 'number' ? metadata.file_size_bytes : typeof metadata.source_size_bytes === 'number' ? metadata.source_size_bytes : null,
        sha256: row.sha256_hash ?? (typeof metadata.source_sha256 === 'string' ? metadata.source_sha256 : null),
        courtReady: Boolean(row.is_court_ready),
        lockedAt: row.locked_at,
        retentionHold: Boolean(row.retention_hold),
        integrity: parseClipIntegrity(metadata.integrity),
        sceneSynopsis: synopsisByEvidence.get(row.id) ?? null,
      }];
    });
    const marks: ConsoleMark[] = markRows.flatMap((row) => {
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
    const observations = observationRows.map(toObservation).filter((item): item is ConsoleObservation => Boolean(item));
    setClipsByImport((current) => ({ ...current, [importId]: clips }));
    setMarksByImport((current) => ({ ...current, [importId]: marks }));
    setObservationsByImport((current) => ({ ...current, [importId]: observations }));
    setDetailLoading(false);
  }, [organizationId]);

  // Reactive reloads (realtime, poll) go through one coalescer so a burst of change events is one query set.
  const refreshCoalescer = useMemo(() => createRefreshCoalescer(loadImportDetail, DETAIL_REFRESH_COALESCE_MS), [loadImportDetail]);
  useEffect(() => () => refreshCoalescer.dispose(), [refreshCoalescer]);
  const requestDetailRefresh = useCallback((importId: string) => refreshCoalescer.request(importId), [refreshCoalescer]);

  // Choosing a camera loads its recordings and, when the wall is empty, puts the camera in tile 1.
  useEffect(() => {
    if (!selectedImportId) return;
    setTiles((current) => (current.some(Boolean) ? current : [cameraItem(selectedImportId)]));
    void loadImportDetail(selectedImportId);
  }, [selectedImportId, loadImportDetail]);

  const firstTileKey = tiles[0]?.id ?? null;
  useEffect(() => {
    setClockMs(null);
    setView(null);
    setPlaying(false);
    setSelectedObservationId(null);
    setMasterIndex(0);
  }, [firstTileKey]);

  useEffect(() => {
    for (const id of activeImportIds) if (!clipsByImport[id]) void loadImportDetail(id);
  }, [activeImportIds, clipsByImport, loadImportDetail]);

  useEffect(() => {
    if (!activeTileId || !wallItems.some((item) => item.id === activeTileId)) setActiveTileId(wallItems[0]?.id ?? null);
  }, [wallItems, activeTileId]);

  const hasActiveJob = useMemo(
    () => activeImportIds.some((importId) => (clipsByImport[importId] ?? []).some((clip) => clip.jobStatus === 'queued' || clip.jobStatus === 'processing')),
    [activeImportIds, clipsByImport],
  );

  // Realtime is a prompt refresh; active jobs also poll so a missing table publication cannot leave a reviewer stale.
  useEffect(() => {
    if (!hasActiveJob) return;
    const timer = window.setInterval(() => {
      for (const importId of activeImportIds) requestDetailRefresh(importId);
    }, DETAIL_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [hasActiveJob, activeImportIds, requestDetailRefresh]);

  useEffect(() => {
    if (!organizationId) return;
    const channel = supabase
      .channel(`cctv-console-${organizationId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cctv_entity_observations', filter: `organization_id=eq.${organizationId}` }, (payload) => {
        const importId = (payload.new as { cctv_import_id?: string } | null)?.cctv_import_id ?? (payload.old as { cctv_import_id?: string } | null)?.cctv_import_id;
        if (importId && activeImportIds.includes(importId)) requestDetailRefresh(importId);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'inference_jobs', filter: `organization_id=eq.${organizationId}` }, () => {
        for (const id of activeImportIds) requestDetailRefresh(id);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cctv_imports', filter: `organization_id=eq.${organizationId}` }, () => void loadImports())
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [organizationId, activeImportIds, requestDetailRefresh, loadImports]);

  // When the browser comes back online, reload whatever failed instead of leaving a stale banner.
  useEffect(() => {
    const handler = () => { if (error?.retryable) error.retry?.(); };
    window.addEventListener('online', handler);
    return () => window.removeEventListener('online', handler);
  }, [error]);

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
    setSeekNonce((current) => current + 1);
    setView((current) => current ? followClock(current, next, bounds) : current);
    // With only recordings on the wall, a jump into another recording hands the clock to that recording.
    if (!cameraItems.length) {
      const driver = wallItems.find((item) => item.id === clockDriverId);
      const driverClip = driver?.kind === 'clip' ? clipsById.get(driver.evidenceId) ?? null : null;
      if (!driverClip || next < driverClip.startMs || next > driverClip.endMs) {
        const covering = wallItems.find((item) => {
          if (item.kind !== 'clip') return false;
          const clip = clipsById.get(item.evidenceId);
          return Boolean(clip && next >= clip.startMs && next <= clip.endMs);
        });
        if (covering) setActiveTileId(covering.id);
      }
    }
  }, [bounds, cameraItems.length, wallItems, clockDriverId, clipsById]);

  const handleTick = useCallback((ms: number) => {
    setClockMs(ms);
    if (bounds) setView((current) => current && playing ? followClock(current, ms, bounds) : current);
  }, [bounds, playing]);

  const handleClipEnded = useCallback((clip: ConsoleClip) => {
    const next = nextClipAfter(masterClips, clip.startMs);
    if (next) seek(next.startMs);
    else setPlaying(false);
  }, [masterClips, seek]);

  // Gaps: while playing, if no camera in view has footage at the clock, skip to the next clip start; if only
  // the clock master is dark while another tile has footage, keep the clock running in real time.
  useEffect(() => {
    if (!playing || clockMs === null || !bounds || !cameraItems.length) return;
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
  }, [playing, clockMs, bounds, masterClips, visibleClips, rate, seek, cameraItems.length]);

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

  // ── wall composition ──
  const placeTile = useCallback((item: ViewItem, slot?: number) => {
    setTiles((current) => {
      if (current.some((existing) => existing?.id === item.id)) return current;
      const next = [...current];
      const target = slot ?? next.findIndex((value, index) => index < layout && !value);
      if (target >= 0 && target < layout) { next[target] = item; return next; }
      if (next.length < layout) { next.push(item); return next; }
      next.push(item);
      setLayout(layoutForCount(next.filter(Boolean).length));
      return next;
    });
    setActiveTileId(item.id);
  }, [layout]);

  const replaceWall = useCallback((items: ViewItem[]) => {
    setTiles(items);
    setLayout(layoutForCount(items.length));
    setActiveTileId(items[0]?.id ?? null);
    setMasterIndex(0);
  }, []);

  const removeTile = useCallback((id: string) => {
    setTiles((current) => current.map((item) => (item?.id === id ? null : item)));
  }, []);

  const showRecordingAlone = (clip: ConsoleClip) => replaceWall([clipItem(clip)]);
  const addRecordingToWall = (clip: ConsoleClip) => placeTile(clipItem(clip));
  const openDayOnWall = (clips: ConsoleClip[]) => replaceWall(clips.slice(0, 9).map(clipItem));
  const followCamera = (importId: string) => placeTile(cameraItem(importId));
  const jumpToRecording = (clip: ConsoleClip) => {
    if (!cameraItems.some((item) => item.importId === clip.importId)) placeTile(cameraItem(clip.importId), 0);
    window.setTimeout(() => seek(clip.startMs), 0);
  };

  // ── pop-out ──
  const popoutUrl = useMemo(() => {
    const params = new URLSearchParams({ area: 'cctv-console', popout: '1' });
    if (selectedImportId) params.set('import', selectedImportId);
    return `/admin/field-ops?${params.toString()}`;
  }, [selectedImportId]);
  const openPopout = () => {
    const width = Math.min(window.screen.availWidth, 1920);
    const height = Math.min(window.screen.availHeight, 1080);
    window.open(popoutUrl, `fcm-cctv-wall-${selectedImportId ?? 'wall'}`, `popup=yes,width=${width},height=${height},left=0,top=0`);
  };

  const stepFrame = useCallback((direction: 1 | -1) => {
    const handle = activeTile ? tileRefs.current[activeTile.id] : null;
    if (!handle) return;
    if (activeTile?.kind === 'camera') setPlaying(false);
    const at = handle.stepFrame(direction);
    if (at !== null && activeTile?.kind === 'camera') setClockMs(at);
  }, [activeTile]);

  const captureSnapshot = useCallback(async () => {
    const handle = activeTile ? tileRefs.current[activeTile.id] : null;
    const clip = activeClip;
    if (!handle || !clip) { setEvidenceMessage('Pick a tile with footage before taking a still.'); return; }
    const snapshot = await handle.captureFrame();
    if (!snapshot) { setEvidenceMessage('The still could not be captured from this picture.'); return; }
    const stamp = new Date(snapshot.atMs).toISOString().replace(/[:.]/g, '-');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(snapshot.blob);
    link.download = `${clip.fileName.replace(/\.[^.]+$/, '')}_${stamp}${snapshot.enhanced ? '_ENHANCED-DISPLAY-ONLY' : ''}.png`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
    setEvidenceMessage(snapshot.enhanced ? 'Still saved from the enhanced view; it is labelled display-only and is not the original recording.' : 'Still saved from the original picture.');
  }, [activeTile, activeClip]);

  const startBookmark = useCallback(() => {
    const clip = activeClip;
    if (!clip) { setEvidenceMessage('Pick a tile with footage before adding a bookmark.'); return; }
    const handle = activeTile ? tileRefs.current[activeTile.id] : null;
    const atMs = handle?.currentMs() ?? clockMs ?? clip.startMs;
    const linked = selectedObservationId && visibleObservations.some((o) => o.id === selectedObservationId && o.evidenceId === clip.evidenceId) ? selectedObservationId : null;
    setBookmarkDraft({ evidenceId: clip.evidenceId, atMs, title: '', notes: '', severity: 'standard', observationId: linked });
  }, [activeClip, activeTile, clockMs, selectedObservationId, visibleObservations]);

  const saveBookmark = async () => {
    if (!bookmarkDraft || !bookmarkDraft.title.trim()) return;
    setEvidenceBusy('bookmark');
    setEvidenceMessage(null);
    const { data, error: bookmarkError } = await supabase.rpc('create_cctv_bookmark', {
      p_evidence_id: bookmarkDraft.evidenceId,
      p_at: new Date(bookmarkDraft.atMs).toISOString(),
      p_title: bookmarkDraft.title.trim(),
      p_notes: bookmarkDraft.notes.trim() || null,
      p_until: null,
      p_severity: bookmarkDraft.severity,
      p_observation_id: bookmarkDraft.observationId,
      p_client_request_id: crypto.randomUUID(),
    });
    setEvidenceBusy(null);
    if (bookmarkError) { setEvidenceMessage(bookmarkError.message); return; }
    const incidentId = (data as { incident_id?: string } | null)?.incident_id;
    setBookmarkDraft(null);
    setEvidenceMessage(`Bookmark recorded as incident ${incidentId ? incidentId.slice(0, 8) : ''} at ${formatClock(bookmarkDraft.atMs, timeZone)}.`);
  };

  const saveLock = async () => {
    if (!lockDraft || lockDraft.reason.trim().length < 5) return;
    setEvidenceBusy('lock');
    setEvidenceMessage(null);
    const { data, error: lockError } = await supabase.rpc('lock_cctv_evidence', { p_evidence_id: lockDraft.evidenceId, p_reason: lockDraft.reason.trim() });
    setEvidenceBusy(null);
    if (lockError) { setEvidenceMessage(lockError.message); return; }
    const result = data as { locked_at?: string; already_locked?: boolean } | null;
    setLockDraft(null);
    setEvidenceMessage(result?.already_locked ? 'This recording was already locked.' : 'Evidence lock applied. Retention cannot purge this recording.');
    const clip = clipsById.get(lockDraft.evidenceId);
    if (clip) void loadImportDetail(clip.importId);
  };

  // The custody record is read through the governed RPC so the trail comes from audit_log and receipts, not from
  // whatever the browser happens to hold.
  const openCustody = async (evidenceId: string) => {
    setCustody({ evidenceId, loading: true, record: null, error: null });
    const { data, error: custodyError } = await supabase.rpc('cctv_evidence_custody', { p_evidence_id: evidenceId });
    if (custodyError) {
      setCustody({ evidenceId, loading: false, record: null, error: describeConsoleFailure(custodyError.message, 'custody record', navigator.onLine).text });
      return;
    }
    setCustody({ evidenceId, loading: false, record: data as CustodyRecord, error: null });
  };

  useEffect(() => {
    if (custody && !clipsById.has(custody.evidenceId)) setCustody(null);
  }, [custody, clipsById]);

  // Biometric holdings for this organisation: counts only, from the governed readout. Refreshed when the panel opens.
  useEffect(() => {
    if (!showGovernance || !organizationId) return;
    let cancelled = false;
    void supabase.rpc('cctv_biometric_governance', { p_organization_id: organizationId }).then(({ data }) => {
      if (!cancelled && data && typeof data === 'object') setGovernance(data as BiometricGovernance);
    });
    return () => { cancelled = true; };
  }, [showGovernance, organizationId, observationsByImport]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const action = keyboardAction({ key: event.key, targetTag: target?.tagName, isEditable: target?.isContentEditable, metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey });
      if (!action) return;
      event.preventDefault();
      switch (action.type) {
        case 'toggle_play': togglePlay(); break;
        case 'seek': if (clockMs !== null) seek(clockMs + action.deltaMs); break;
        case 'frame': stepFrame(action.direction); break;
        case 'rate': setRate((current) => nextRate(current, action.direction)); break;
        case 'layout': setLayout(action.layout); break;
        case 'fullscreen': void reviewPaneRef.current?.requestFullscreen?.(); break;
        case 'mute': setMuted((current) => !current); break;
        case 'bookmark': startBookmark(); break;
        case 'snapshot': void captureSnapshot(); break;
        case 'escape': setSelectedObservationId(null); setBookmarkDraft(null); setLockDraft(null); break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [togglePlay, seek, clockMs, stepFrame, startBookmark, captureSnapshot]);

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

  const syncOpenClips = () => {
    const activeSeconds = activeTile ? (tileRefs.current[activeTile.id]?.currentMs() ?? clockMs ?? 0) : (clockMs ?? 0);
    const activeClipStart = activeClip?.startMs ?? activeSeconds;
    const relativeSeconds = Math.max(0, (activeSeconds - activeClipStart) / 1000);
    for (const item of wallItems) tileRefs.current[item.id]?.syncTo(relativeSeconds);
    setEvidenceMessage(`Open clips aligned at ${Math.round(relativeSeconds)} seconds. Their recorded timestamps remain unchanged.`);
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
    setPersonCategory(selectedObservation?.kind === 'person' && typeof selectedObservation.profileDetails.category === 'string' ? selectedObservation.profileDetails.category : '');
    setNewPlate('');
    setVehicleNotes('');
    let cancelled = false;
    if (selectedObservation?.kind === 'vehicle' && selectedObservation.canonicalVehicleId) {
      void supabase.rpc('get_cctv_vehicle_note', { p_observation_id: selectedObservation.id }).then(({ data }) => {
        if (!cancelled) setVehicleNotes(typeof data === 'string' ? data : '');
      });
    }
    setNotes('');
    setReviewMessage(null);
    return () => { cancelled = true; };
  }, [selectedObservationId]);

  const selectObservation = (observation: ConsoleObservation) => {
    setSelectedObservationId(observation.id);
    setPlaying(false);
    if (observation.importId && !cameraItems.some((item) => item.importId === observation.importId)) placeTile(cameraItem(observation.importId), 0);
    window.setTimeout(() => seek(observation.observedAtMs), 0);
    const tileIndex = cameraItems.findIndex((item) => item.importId === observation.importId);
    if (tileIndex >= 0) { setMasterIndex(tileIndex); setActiveTileId(cameraItems[tileIndex].id); }
  };

  const updateInspection = useCallback((patch: Partial<CCTVInspection>) => {
    if (!activeTile) return;
    const key = activeTile.id;
    setInspectionsByTile((current) => ({ ...current, [key]: normalizeCCTVInspection({ ...(current[key] ?? DEFAULT_CCTV_INSPECTION), ...patch }) }));
  }, [activeTile]);

  const resetInspection = useCallback(() => {
    if (!activeTile) return;
    setInspectionsByTile((current) => ({ ...current, [activeTile.id]: { ...DEFAULT_CCTV_INSPECTION } }));
    setEnhancementState(null);
  }, [activeTile]);

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
    const next = pendingObservations.find((item) => item.id !== observation.id && item.observedAtMs >= observation.observedAtMs) ?? pendingObservations.find((item) => item.id !== observation.id) ?? null;
    if (next && action !== 'merge_portfolio') selectObservation(next);
  };

  const runVehicleAttributeReview = async (observation: ConsoleObservation, action: 'confirm' | 'correct' | 'reject') => {
    if (action === 'correct' && !correctMake.trim() && !correctModel.trim() && !correctColour.trim() && !correctBodyType.trim() && !correctYear.trim()) {
      setReviewMessage('Enter at least one corrected vehicle attribute.');
      return;
    }
    const year = correctYear.trim() ? Number(correctYear) : null;
    if (year !== null && (!Number.isInteger(year) || year < 1886 || year > new Date().getFullYear() + 2)) {
      setReviewMessage('Enter a valid four-digit vehicle year.');
      return;
    }
    setReviewBusy(`${observation.id}:attrs:${action}`);
    setReviewMessage(null);
    const { error: attrError } = await supabase.rpc('confirm_cctv_vehicle_attributes', {
      p_observation_id: observation.id,
      p_action: action,
      p_make: action === 'correct' ? correctMake.trim() || null : null,
      p_model: action === 'correct' ? correctModel.trim() || null : null,
      p_colour: action === 'correct' ? correctColour.trim() || null : null,
      p_body_type: action === 'correct' ? correctBodyType.trim() || null : null,
      p_year: action === 'correct' ? year : null,
      p_notes: notes.trim() || null,
    });
    setReviewBusy(null);
    if (attrError) { setReviewMessage(attrError.message); return; }
    setCorrectingVehicleId(null);
    setCorrectMake('');
    setCorrectModel('');
    setCorrectColour('');
    setCorrectBodyType('');
    setCorrectYear('');
    if (observation.importId) void loadImportDetail(observation.importId);
    setReviewMessage(action === 'reject' ? 'Vehicle attribute candidates dismissed.' : action === 'correct' ? 'Corrected attributes saved to the vehicle record.' : 'Vehicle attributes confirmed and saved.');
  };

  const runWeaponHintReview = async (observation: ConsoleObservation, status: 'confirmed' | 'dismissed') => {
    setReviewBusy(`${observation.id}:weapon:${status}`);
    setReviewMessage(null);
    const { error: weaponError } = await supabase.rpc('confirm_cctv_weapon_hint', {
      p_observation_id: observation.id,
      p_status: status,
      p_notes: notes.trim() || null,
    });
    setReviewBusy(null);
    if (weaponError) { setReviewMessage(weaponError.message); return; }
    if (observation.importId) void loadImportDetail(observation.importId);
    setReviewMessage(status === 'confirmed' ? 'Weapon flag confirmed.' : 'Weapon flag dismissed as a false positive.');
  };

  const updatePersonProfile = async (observation: ConsoleObservation) => {
    if (!newName.trim()) return;
    setReviewBusy(`${observation.id}:profile`);
    setReviewMessage(null);
    const profileDetails: Record<string, string> = {};
    if (personDetails.trim()) profileDetails.notes = personDetails.trim();
    if (personCategory.trim()) profileDetails.category = personCategory.trim();
    const { error: profileError } = await supabase.rpc('update_cctv_person_profile', {
      p_observation_id: observation.id,
      p_display_name: newName.trim(),
      p_profile_details: profileDetails,
      p_notes: notes.trim() || null,
    });
    setReviewBusy(null);
    if (profileError) { setReviewMessage(profileError.message); return; }
    if (observation.importId) void loadImportDetail(observation.importId);
    setReviewMessage('Person profile updated.');
  };

  const updateVehicleNotes = async (observation: ConsoleObservation) => {
    setReviewBusy(`${observation.id}:vehicle-notes`);
    setReviewMessage(null);
    const { error: notesError } = await supabase.rpc('update_cctv_vehicle_notes', {
      p_observation_id: observation.id,
      p_notes: vehicleNotes.trim() || null,
    });
    setReviewBusy(null);
    if (notesError) { setReviewMessage(notesError.message); return; }
    setReviewMessage('Vehicle note saved.');
  };

  const columns = gridColumns(layout);
  const wallTiles = fitTiles(tiles, layout);
  const importById = useMemo(() => new Map(imports.map((row) => [row.id, row])), [imports]);
  const onWallIds = useMemo(() => new Set(wallItems.map((item) => item.id)), [wallItems]);

  return (
    <div className={`page-container cctv-console${popout ? ' is-popout' : ''}`}>
      <header className="cctv-console__header">
        <div>
          <h1 className="page-title"><Camera size={20} aria-hidden="true" /> CCTV console{popout ? <span className="cctv-console__popout-badge">Pop-out review</span> : null}</h1>
          <p className="page-subtitle">
            {selectedImport ? <>{selectedImport.camera_label} · {placeLabelOf(selectedImport)} · {selectedImport.recorded_from ? `${formatDate(parseMs(selectedImport.recorded_from) ?? 0, timeZone)} · ` : ''}{selectedImport.video_count} video{selectedImport.video_count === 1 ? '' : 's'} · {selectedImport.snapshot_count} photo{selectedImport.snapshot_count === 1 ? '' : 's'}{selectedImport.skipped_count ? `, ${selectedImport.skipped_count} empty slots skipped` : ''}</> : 'Choose a camera to review.'}
          </p>
        </div>
        {!popout ? <div className="cctv-console__header-actions">
          <button type="button" className="page-action" onClick={() => setShowKeys((current) => !current)} aria-expanded={showKeys}><Keyboard size={16} aria-hidden="true" /> Keys</button>
          <button type="button" className="page-action" onClick={openPopout} title="Open cameras and entity review in their own window"><ExternalLink size={16} aria-hidden="true" /> Pop out wall</button>
          <button type="button" className="page-action" onClick={() => void reviewPaneRef.current?.requestFullscreen?.()} title="Full-screen video review (f)"><Maximize2 size={16} aria-hidden="true" /> Full screen</button>
          <button type="button" className="page-action" onClick={() => navigate('/admin/field-ops?area=cctv-import')}><Plus size={16} aria-hidden="true" /> Import footage</button>
          <button type="button" className="page-action" onClick={() => navigate('/admin/field-ops?area=cctv-review')}>Job queue &amp; exports</button>
        </div> : null}
      </header>
      {showKeys ? (
        <div className="cctv-console__keys" role="note">
          <span><kbd>Space</kbd> play / pause</span><span><kbd>←</kbd><kbd>→</kbd> ±10 s</span><span><kbd>↑</kbd><kbd>↓</kbd> ±1 s</span><span><kbd>,</kbd><kbd>.</kbd> one frame</span>
          <span><kbd>[</kbd><kbd>]</kbd> speed</span><span><kbd>1</kbd><kbd>2</kbd><kbd>4</kbd><kbd>9</kbd> grid</span><span><kbd>f</kbd> full screen</span><span><kbd>m</kbd> mute</span><span><kbd>b</kbd> bookmark</span><span><kbd>s</kbd> still</span><span><kbd>Esc</kbd> clear selection</span>
        </div>
      ) : null}
      {error ? (
        <div className="page-error" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <span className="cctv-console__error-text">{error.text}</span>
          {error.retryable && error.retry ? <button type="button" className="cctv-console__error-retry" onClick={error.retry}><RefreshCw size={14} aria-hidden="true" /> Retry</button> : null}
          <button type="button" className="cctv-console__icon-btn" onClick={() => setError(null)} aria-label="Dismiss message"><X size={14} aria-hidden="true" /></button>
        </div>
      ) : null}

      <div className="cctv-console__layout">
        <aside className="cctv-console__cameras" aria-label="Cameras and recordings">
          <div className="cctv-console__aside-head"><strong>Cameras</strong><button type="button" className="cctv-console__icon-btn" onClick={() => void loadImports()} aria-label="Refresh cameras"><RefreshCw size={14} aria-hidden="true" /></button></div>
          {importsLoading ? <p className="cctv-console__muted"><Loader2 size={14} className="spin" aria-hidden="true" /> Loading…</p> : null}
          {!importsLoading && imports.length === 0 ? <p className="cctv-console__muted">No camera footage has been imported yet. Use “Import footage” to bring an SD card in.</p> : null}
          <ul className="cctv-console__camera-list">
            {imports.map((row) => {
              const onWall = onWallIds.has(cameraItem(row.id).id);
              const pending = (observationsByImport[row.id] ?? []).filter((observation) => !isReviewed(observation)).length;
              return (
                <li key={row.id} className={`cctv-console__camera${row.id === selectedImportId ? ' is-selected' : ''}${onWall ? ' is-in-view' : ''}`}>
                  <button type="button" className="cctv-console__camera-main" onClick={() => setSelectedImportId(row.id)} aria-pressed={row.id === selectedImportId}>
                    <span className="cctv-console__camera-label">{row.camera_label}</span>
                    <span className="cctv-console__camera-place">{placeLabelOf(row)}</span>
                    <span className="cctv-console__camera-meta">{row.recorded_from ? formatDate(parseMs(row.recorded_from) ?? 0, row.source_timezone) : row.snapshot_count ? 'Photos ready' : 'No media yet'} · {row.video_count} video{row.video_count === 1 ? '' : 's'} · {row.snapshot_count} photo{row.snapshot_count === 1 ? '' : 's'} · <span className={`cctv-console__status is-${row.status}`}>{row.status.replace(/_/g, ' ')}</span>{observationsByImport[row.id] ? ` · ${pending} to review` : ''}</span>
                  </button>
                  {onWall
                    ? <button type="button" className="cctv-console__icon-btn" onClick={() => removeTile(cameraItem(row.id).id)} aria-label={`Remove ${row.camera_label} from the wall`} disabled={wallItems.length === 1}><X size={14} aria-hidden="true" /></button>
                    : <button type="button" className="cctv-console__icon-btn" onClick={() => followCamera(row.id)} aria-label={`Add ${row.camera_label} to the wall`} title="Follow this camera on the shared clock"><Plus size={14} aria-hidden="true" /></button>}
                </li>
              );
            })}
          </ul>

          {selectedImport ? (
            <section className="cctv-console__recordings" aria-label={`Recordings from ${selectedImport.camera_label}`}>
              <div className="cctv-console__aside-head">
                <strong>Photos &amp; videos</strong>
                <span className="cctv-console__count is-neutral">{selectedClips.length}</span>
              </div>
              {detailLoading && selectedClips.length === 0 ? <p className="cctv-console__muted"><Loader2 size={14} className="spin" aria-hidden="true" /> Loading recordings…</p> : null}
              {!detailLoading && selectedClips.length === 0 ? <p className="cctv-console__muted">No photos or videos have been registered for this camera yet.</p> : null}
              {dayGroups.map((group, groupIndex) => {
                const expanded = expandedDays[group.day] ?? groupIndex === 0;
                const pendingInDay = group.clips.reduce((sum, clip) => sum + (evidenceCounts[clip.evidenceId]?.pending ?? 0), 0);
                return (
                  <div key={group.day} className="cctv-day">
                    <div className="cctv-day__head">
                      <button type="button" className="cctv-day__toggle" onClick={() => setExpandedDays((current) => ({ ...current, [group.day]: !expanded }))} aria-expanded={expanded}>
                        <ChevronDown size={14} aria-hidden="true" className={expanded ? '' : 'is-collapsed'} />
                        <strong>{group.day}</strong>
                        <small>{group.clips.length} media item{group.clips.length === 1 ? '' : 's'} · {durationLabel(group.clips.reduce((sum, clip) => sum + (clip.endMs - clip.startMs), 0))}{pendingInDay ? ` · ${pendingInDay} to review` : ''}</small>
                      </button>
                      <button type="button" className="cctv-console__icon-btn" onClick={() => openDayOnWall(group.clips)} title={`Open up to nine recordings from ${group.day} on the wall, each on its own clock`} aria-label={`Open ${group.day} on the wall`}><Grid2x2 size={14} aria-hidden="true" /></button>
                    </div>
                    {expanded ? (
                      <ol className="cctv-clip-list">
                        {group.clips.map((clip) => {
                          const counts = evidenceCounts[clip.evidenceId];
                          const pinnedId = clipItem(clip).id;
                          const onWall = onWallIds.has(pinnedId);
                          const isCurrent = activeClip?.evidenceId === clip.evidenceId;
                          return (
                            <li key={clip.evidenceId} className={`cctv-clip${isCurrent ? ' is-current' : ''}${onWall ? ' is-on-wall' : ''}${clip.lockedAt ? ' is-locked' : ''}`}>
                              <button type="button" className="cctv-clip__main" onClick={() => jumpToRecording(clip)} title="Jump the shared clock to this recording" aria-current={isCurrent ? 'true' : undefined}>
                                <span className="cctv-clip__time"><strong>{formatClock(clip.startMs, timeZone)}</strong><small>{clip.mediaKind === 'photo' ? 'Photo' : durationLabel(clip.endMs - clip.startMs)}</small></span>
                                <span className="cctv-clip__text">
                                  <span className="cctv-clip__name">{clip.fileName}</span>
                                  {clip.sceneSynopsis ? <small className="cctv-clip__synopsis" title="Self-hosted vision-LLM draft, unverified until a reviewer confirms it">AI draft (unreviewed): {clip.sceneSynopsis.text}</small> : null}
                                  <small className="cctv-clip__facts">
                                    <span className={`cctv-clip__status is-${clip.jobStatus}`}>{clipStatusLabel(clip.jobStatus)}</span>
                                    {counts ? <span>{counts.possibleWeapon ? <span className="cctv-clip__weapon-hint" title="Unverified AI hint - a person in this clip may be carrying something weapon-shaped. Review now."><AlertTriangle size={11} aria-hidden="true" /> possible weapon - review now · </span> : null}{counts.total} sighting{counts.total === 1 ? '' : 's'}{counts.pending ? ` · ${counts.pending} to review` : ''}{counts.alerts ? ` · ${counts.alerts} alert${counts.alerts === 1 ? '' : 's'}` : ''}{counts.busy ? <span className="cctv-clip__busy" title="Unusually many distinct people or vehicles for one clip"> · busy scene</span> : null}</span> : <span>No sightings</span>}
                                    <span>{bytesLabel(clip.sizeBytes)}</span>
                                    {(() => { const badge = custodyBadge(clip); return <span className={`cctv-clip__custody is-${badge.tone}`} title={badge.detail}>{badge.tone === 'locked' ? <Lock size={11} aria-hidden="true" /> : badge.tone === 'mismatch' ? <AlertTriangle size={11} aria-hidden="true" /> : null} {badge.label}</span>; })()}
                                  </small>
                                </span>
                              </button>
                              <span className="cctv-clip__actions">
                                <button type="button" className="cctv-console__icon-btn" onClick={() => showRecordingAlone(clip)} title={clip.mediaKind === 'photo' ? 'Open this photo on its own' : 'Play this recording on its own'} aria-label={`${clip.mediaKind === 'photo' ? 'Open' : 'Play'} ${clip.fileName} on its own`}>{clip.mediaKind === 'photo' ? <ImageDown size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}</button>
                                <button type="button" className="cctv-console__icon-btn" onClick={() => (onWall ? removeTile(pinnedId) : addRecordingToWall(clip))} title={onWall ? 'Remove this recording from the wall' : 'Add this recording to the wall on its own clock'} aria-label={onWall ? `Remove ${clip.fileName} from the wall` : `Add ${clip.fileName} to the wall`}>{onWall ? <X size={14} aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}</button>
                              </span>
                            </li>
                          );
                        })}
                      </ol>
                    ) : null}
                  </div>
                );
              })}
            </section>
          ) : null}
        </aside>

        {!popout ? <main className="cctv-console__stage" ref={reviewPaneRef} aria-label="Video review pane">
          <div className="cctv-console__grid-wrap">
            <div className="cctv-console__grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
              {wallTiles.map((item, index) => {
                const row = item ? importById.get(item.importId) ?? null : null;
                if (!item || !row || clockMs === null) {
                  return (
                    <div key={`empty-${index}`} className="cctv-tile is-empty">
                      <span>{item ? 'Loading camera media…' : 'Empty tile — add a camera, photo or video from the list'}</span>
                    </div>
                  );
                }
                const pinnedClip = item.kind === 'clip' ? clipsById.get(item.evidenceId) ?? null : null;
                const drivesClock = item.id === clockDriverId;
                const isActive = item.id === activeTile?.id;
                return (
                  <CCTVPlayerTile key={item.id} ref={(handle) => { tileRefs.current[item.id] = handle; }} label={pinnedClip ? `${row.camera_label} · ${formatClock(pinnedClip.startMs, row.source_timezone)}` : row.camera_label} placeLabel={placeLabelOf(row)}
                    clips={clipsByImport[row.id] ?? []} clockMs={clockMs} seekNonce={seekNonce} playing={playing} rate={rate} muted={muted} isMaster={drivesClock} active={isActive}
                    timeZone={row.source_timezone} pinnedClip={pinnedClip} resolveUrl={resolveUrl} onTick={handleTick} onClipEnded={handleClipEnded} onDurationKnown={handleDurationKnown}
                    onActivate={() => { setActiveTileId(item.id); setSelectedImportId(item.importId); if (item.kind === 'camera') setMasterIndex(Math.max(0, cameraItems.findIndex((camera) => camera.id === item.id))); }}
                    inspection={isActive ? activeInspection : undefined}
                    onInspectionChange={isActive ? updateInspection : undefined}
                    onEnhancementPlan={isActive ? handleEnhancementPlan : undefined}
                    onRemove={wallItems.length > 1 ? () => removeTile(item.id) : undefined} />
                );
              })}
            </div>
          </div>

          <div className="cctv-console__controls" role="toolbar" aria-label="Playback controls">
            <button type="button" className="cctv-console__ctl" onClick={() => jumpClip(-1)} aria-label="Previous recording"><ChevronLeft size={18} aria-hidden="true" /></button>
            <button type="button" className="cctv-console__ctl" onClick={() => clockMs !== null && seek(clockMs - 10_000)} aria-label="Back 10 seconds"><Rewind size={18} aria-hidden="true" /></button>
            <button type="button" className="cctv-console__ctl" onClick={() => stepFrame(-1)} aria-label="Back one frame" title="Back one frame (,)"><StepBack size={16} aria-hidden="true" /></button>
            <button type="button" className="cctv-console__ctl is-primary" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'} disabled={clockMs === null}>{playing ? <Pause size={20} aria-hidden="true" /> : <Play size={20} aria-hidden="true" />}</button>
            <button type="button" className="cctv-console__ctl" onClick={syncOpenClips} disabled={wallItems.length < 2} title="Align open clips to the active clip's relative playback position; recorded times stay independent"><Link2 size={16} aria-hidden="true" /> Sync clips</button>
            <button type="button" className="cctv-console__ctl" onClick={() => stepFrame(1)} aria-label="Forward one frame" title="Forward one frame (.)"><StepForward size={16} aria-hidden="true" /></button>
            <button type="button" className="cctv-console__ctl" onClick={() => clockMs !== null && seek(clockMs + 10_000)} aria-label="Forward 10 seconds"><FastForward size={18} aria-hidden="true" /></button>
            <button type="button" className="cctv-console__ctl" onClick={() => jumpClip(1)} aria-label="Next recording"><ChevronRight size={18} aria-hidden="true" /></button>
            <span className="cctv-console__clock" aria-live="off">{clockMs !== null ? <><strong>{formatClock(clockMs, timeZone)}</strong><small>{formatDate(clockMs, timeZone)} · {timeZone}</small></> : '—'}</span>
            <label className="cctv-console__rate">Speed
              <select value={rate} onChange={(event) => setRate(Number(event.target.value))} aria-label="Playback speed">
                {PLAYBACK_RATES.map((option) => <option key={option} value={option}>{option}×</option>)}
              </select>
            </label>
            <button type="button" className="cctv-console__ctl" onClick={() => setMuted((current) => !current)} aria-label={muted ? 'Unmute' : 'Mute'}>{muted ? <VolumeX size={18} aria-hidden="true" /> : <Volume2 size={18} aria-hidden="true" />}</button>
            <div className="cctv-console__inspection-controls" role="group" aria-label="Active tile image inspection">
              <button type="button" className="cctv-console__ctl" onClick={() => updateInspection({ zoom: nextInspectionZoom(activeInspection.zoom, -1) })} disabled={activeInspection.zoom <= 1 || !activeTile} aria-label="Zoom out" title="Zoom out"><ZoomOut size={16} aria-hidden="true" /></button>
              <output className="cctv-console__inspection-value" aria-label={`Active tile zoom ${activeInspection.zoom} times`}>{activeInspection.zoom}×</output>
              <button type="button" className="cctv-console__ctl" onClick={() => updateInspection({ zoom: nextInspectionZoom(activeInspection.zoom, 1) })} disabled={activeInspection.zoom >= 4 || !activeTile} aria-label="Zoom in" title="Zoom in (or scroll on the picture)"><ZoomIn size={16} aria-hidden="true" /></button>
              <button type="button" className={`cctv-console__ctl${enhancementActive ? ' is-on' : ''}`} onClick={cycleEnhance} disabled={!activeTile} aria-pressed={enhancementActive}
                aria-label={`Enhance: ${activeInspection.enhance === 'auto' ? 'automatic when zoomed' : activeInspection.enhance === 'on' ? 'always on' : 'off'}`}
                title={activeInspection.enhance === 'auto' ? 'Enhance: automatic when zoomed. Click for always on.' : activeInspection.enhance === 'on' ? 'Enhance: always on. Click to turn off.' : 'Enhance: off. Click for automatic when zoomed.'}>
                <Sparkles size={16} aria-hidden="true" /> {activeInspection.enhance === 'auto' ? 'Auto' : activeInspection.enhance === 'on' ? 'On' : 'Off'}
              </button>
              <button type="button" className={`cctv-console__ctl${showInspectionTools ? ' is-on' : ''}`} onClick={() => setShowInspectionTools((current) => !current)} disabled={!activeTile} aria-pressed={showInspectionTools} aria-expanded={showInspectionTools} aria-controls="cctv-image-adjustments" aria-label="Image adjustments" title="Image adjustments"><SlidersHorizontal size={16} aria-hidden="true" /></button>
              <button type="button" className="cctv-console__ctl" onClick={resetInspection} disabled={!inspectionAdjusted || !activeTile} aria-label="Reset image inspection" title="Reset image inspection"><RotateCcw size={16} aria-hidden="true" /></button>
            </div>
            <div className="cctv-console__evidence-controls" role="group" aria-label="Evidence actions">
              <button type="button" className="cctv-console__ctl" onClick={startBookmark} disabled={!activeClip} aria-label="Bookmark this moment" title="Bookmark this moment as an incident (b)"><Bookmark size={16} aria-hidden="true" /> Bookmark</button>
              <button type="button" className="cctv-console__ctl" onClick={() => void captureSnapshot()} disabled={!activeClip} aria-label="Save a still" title="Save a still of the active tile (s)"><ImageDown size={16} aria-hidden="true" /> Still</button>
              {isAdmin ? <button type="button" className={`cctv-console__ctl${activeClip?.lockedAt ? ' is-locked' : ''}`} onClick={() => activeClip && !activeClip.lockedAt && setLockDraft({ evidenceId: activeClip.evidenceId, reason: '' })} disabled={!activeClip || Boolean(activeClip.lockedAt) || !activeClip.sha256} aria-label={activeClip?.lockedAt ? 'Recording is locked' : 'Lock this recording'} title={activeClip?.lockedAt ? `Locked ${formatDate(parseMs(activeClip.lockedAt) ?? 0, timeZone)}` : activeClip && !activeClip.sha256 ? 'Locking needs the integrity hash the analysis records' : 'Evidence lock: retention cannot purge this recording'}><Lock size={16} aria-hidden="true" /> {activeClip?.lockedAt ? 'Locked' : 'Lock'}</button> : null}
              <button type="button" className={`cctv-console__ctl${activeClip?.integrity?.state === 'mismatch' ? ' is-mismatch' : ''}${custody && activeClip && custody.evidenceId === activeClip.evidenceId ? ' is-on' : ''}`} onClick={() => activeClip && (custody?.evidenceId === activeClip.evidenceId ? setCustody(null) : void openCustody(activeClip.evidenceId))} disabled={!activeClip} aria-pressed={Boolean(custody && activeClip && custody.evidenceId === activeClip.evidenceId)} aria-label="Custody record" title={activeClip ? custodyBadge(activeClip).detail : 'Custody record: hash, seal, integrity checks and the audit trail'}><ShieldCheck size={16} aria-hidden="true" /> Custody</button>
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
            <div id="cctv-image-adjustments" className="cctv-console__inspection-panel" aria-label="Active tile image adjustments">
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

          {bookmarkDraft ? (
            <form className="cctv-console__evidence-form" onSubmit={(event) => { event.preventDefault(); void saveBookmark(); }} aria-label="New bookmark">
              <div className="cctv-console__evidence-form-head"><Bookmark size={15} aria-hidden="true" /><strong>Bookmark at {formatClock(bookmarkDraft.atMs, timeZone)}</strong><small>{clipsById.get(bookmarkDraft.evidenceId)?.fileName}{bookmarkDraft.observationId ? ' · linked to the selected sighting' : ''}</small></div>
              <label className="cctv-entity__field">Title <input value={bookmarkDraft.title} onChange={(event) => setBookmarkDraft({ ...bookmarkDraft, title: event.target.value })} placeholder="What happens here, in one line" autoFocus required /></label>
              <label className="cctv-entity__field">Notes <textarea value={bookmarkDraft.notes} onChange={(event) => setBookmarkDraft({ ...bookmarkDraft, notes: event.target.value })} rows={2} placeholder="Optional detail for the incident record" /></label>
              <label className="cctv-entity__field">Severity
                <select value={bookmarkDraft.severity} onChange={(event) => setBookmarkDraft({ ...bookmarkDraft, severity: event.target.value as BookmarkDraft['severity'] })}>
                  <option value="low">Low</option><option value="standard">Standard</option><option value="high">High</option><option value="critical">Critical</option>
                </select>
              </label>
              <div className="cctv-entity__actions">
                <button type="submit" className="page-action is-primary" disabled={evidenceBusy !== null || !bookmarkDraft.title.trim()}><Check size={14} aria-hidden="true" /> Record bookmark</button>
                <button type="button" className="page-action" onClick={() => setBookmarkDraft(null)}>Cancel</button>
              </div>
            </form>
          ) : null}

          {lockDraft ? (
            <form className="cctv-console__evidence-form is-lock" onSubmit={(event) => { event.preventDefault(); void saveLock(); }} aria-label="Evidence lock">
              <div className="cctv-console__evidence-form-head"><Lock size={15} aria-hidden="true" /><strong>Lock {clipsById.get(lockDraft.evidenceId)?.fileName}</strong><small>Sealed with hash {clipsById.get(lockDraft.evidenceId)?.sha256?.slice(0, 16)}… · retention cannot purge it · cannot be undone here</small></div>
              <label className="cctv-entity__field">Reason <input value={lockDraft.reason} onChange={(event) => setLockDraft({ ...lockDraft, reason: event.target.value })} placeholder="e.g. Police request, incident 2026-09-15, case reference" autoFocus required minLength={5} /></label>
              <div className="cctv-entity__actions">
                <button type="submit" className="page-action is-danger" disabled={evidenceBusy !== null || lockDraft.reason.trim().length < 5}><Lock size={14} aria-hidden="true" /> Apply evidence lock</button>
                <button type="button" className="page-action" onClick={() => setLockDraft(null)}>Cancel</button>
              </div>
            </form>
          ) : null}
          {evidenceMessage ? <p className="cctv-console__muted cctv-console__evidence-message" role="status">{evidenceBusy ? <Loader2 size={14} className="spin" aria-hidden="true" /> : null} {evidenceMessage}</p> : null}

          {custody ? (
            <section className={`cctv-console__custody${custody.record?.integrity?.state === 'mismatch' ? ' is-mismatch' : ''}`} aria-label="Custody record" aria-live="polite">
              <div className="cctv-console__evidence-form-head">
                <ShieldCheck size={15} aria-hidden="true" />
                <strong>Custody of {clipsById.get(custody.evidenceId)?.fileName ?? 'recording'}</strong>
                <button type="button" className="cctv-console__icon-btn" onClick={() => setCustody(null)} aria-label="Close custody record"><X size={14} aria-hidden="true" /></button>
              </div>
              {custody.loading ? <p className="cctv-console__muted"><Loader2 size={14} className="spin" aria-hidden="true" /> Reading the custody record…</p> : null}
              {custody.error ? <p className="cctv-console__muted" role="alert">{custody.error}</p> : null}
              {custody.record ? (
                <>
                  <dl className="cctv-console__custody-facts">
                    <div><dt>Integrity hash</dt><dd>{custody.record.sha256_hash ? <code>{custody.record.sha256_hash}</code> : 'Not yet recorded'}{custody.record.source_size_bytes ? ` · ${bytesLabel(custody.record.source_size_bytes)}` : ''}{custody.record.source_hashed_at ? ` · measured ${formatDate(parseMs(custody.record.source_hashed_at) ?? 0, timeZone)}` : ''}</dd></div>
                    <div><dt>Seal</dt><dd>{custody.record.locked_at ? `Locked ${formatDate(parseMs(custody.record.locked_at) ?? 0, timeZone)}${custody.record.lock?.reason ? ` — ${custody.record.lock.reason}` : ''}. Hash, file and capture time are frozen; retention cannot purge it.` : 'Not sealed. Retention rules apply until an administrator locks it.'}</dd></div>
                    <div><dt>Last integrity check</dt><dd>{custody.record.integrity?.state === 'verified' ? `Verified ${custody.record.integrity.checked_at ? formatDate(parseMs(custody.record.integrity.checked_at) ?? 0, timeZone) : ''} by ${custody.record.integrity.checked_by ?? 'the analysis worker'} (${custody.record.integrity.check_count ?? 1} check${(custody.record.integrity.check_count ?? 1) === 1 ? '' : 's'}, ${custody.record.integrity.mismatch_count ?? 0} mismatch${(custody.record.integrity.mismatch_count ?? 0) === 1 ? '' : 'es'})`
                      : custody.record.integrity?.state === 'mismatch' ? `MISMATCH ${custody.record.integrity.checked_at ? formatDate(parseMs(custody.record.integrity.checked_at) ?? 0, timeZone) : ''}: the stored bytes no longer match the recorded hash. Treat this recording as altered until the custodian explains it.`
                        : custody.record.integrity?.state === 'unanchored' ? 'Measured before any hash was recorded; no comparison was possible.'
                          : 'Not yet re-measured. The worker verifies the stored bytes each time it processes this recording.'}</dd></div>
                  </dl>
                  {custody.record.events.length ? (
                    <ol className="cctv-console__custody-trail">
                      {custody.record.events.map((event, index) => (
                        <li key={`${event.kind}-${event.at}-${index}`} className={event.kind === 'cctv_evidence_integrity_mismatch' ? 'is-mismatch' : undefined}>
                          <time dateTime={event.at}>{formatDate(parseMs(event.at) ?? 0, timeZone)}</time>
                          <span>{CUSTODY_EVENT_LABEL[event.kind] ?? event.kind.replace(/_/g, ' ')}{typeof event.detail.reason === 'string' ? ` — ${event.detail.reason}` : ''}{typeof event.detail.batch_id === 'string' ? ` · batch ${event.detail.batch_id}` : ''}</span>
                        </li>
                      ))}
                    </ol>
                  ) : <p className="cctv-console__muted">No custody events yet: nothing has locked, bookmarked, verified or exported this recording.</p>}
                </>
              ) : null}
            </section>
          ) : null}

          {bounds && view && clockMs !== null ? (
            <CCTVTimeline view={view} bounds={bounds} clockMs={clockMs} clips={visibleClips} marks={visibleMarks} observations={visibleObservations}
              selectedObservationId={selectedObservationId} timeZone={timeZone} onSeek={seek} onViewChange={setView}
              onSelectObservation={(id) => { const found = visibleObservations.find((item) => item.id === id); if (found) selectObservation(found); }} />
          ) : (
            <div className="cctv-console__timeline-empty">{detailLoading ? <><Loader2 size={16} className="spin" aria-hidden="true" /> Loading the camera’s timeline…</> : cameraItems.length === 0 && wallItems.length > 0 ? 'Recordings on the wall play on their own clocks; the timeline follows the active recording once it has loaded.' : 'No footage, snapshots or detections yet for this camera.'}</div>
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
        </main> : null}

        <aside className="cctv-console__entities" aria-label="Entities seen">
            <div className="cctv-console__aside-head">
              <strong>Entities</strong>
              <span className="cctv-console__count">{pendingObservations.length} to review</span>
              <button type="button" className={`cctv-console__icon-btn${showGovernance ? ' is-on' : ''}`} onClick={() => setShowGovernance((current) => !current)} aria-pressed={showGovernance} aria-expanded={showGovernance} aria-controls="cctv-biometric-governance" aria-label="Biometric data held by this organisation" title="Biometric data held by this organisation"><ShieldCheck size={14} aria-hidden="true" /></button>
            </div>
            {showGovernance ? (
              <div id="cctv-biometric-governance" className="cctv-console__governance" role="note">
                <strong>Face matching, plainly</strong>
                <p>{governance?.purpose ?? 'Templates are used only to suggest same-or-similar sightings within this organisation; identity is always a reviewer decision.'} Templates are never shown or downloadable. Rejected sightings lose their template at once; undecided sightings after {governance?.default_retention ?? '90 days'}.</p>
                {governance ? (
                  <dl>
                    <div><dt>Live face templates</dt><dd>{governance.live_face_templates}</dd></div>
                    <div><dt>Expired</dt><dd>{governance.expired_templates}</dd></div>
                    <div><dt>Rejected still holding one</dt><dd className={governance.rejected_still_holding_templates ? 'is-warn' : undefined}>{governance.rejected_still_holding_templates}</dd></div>
                    <div><dt>Oldest live</dt><dd>{governance.oldest_live_template_at ? formatDate(parseMs(governance.oldest_live_template_at) ?? 0, timeZone) : '—'}</dd></div>
                    <div><dt>Last expiry run</dt><dd>{governance.last_expiry_run_at ? formatDate(parseMs(governance.last_expiry_run_at) ?? 0, timeZone) : 'Not yet run (daily at 03:41)'}</dd></div>
                  </dl>
                ) : <p className="cctv-console__muted"><Loader2 size={14} className="spin" aria-hidden="true" /> Reading holdings…</p>}
              </div>
            ) : null}
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
                          <>
                            <dl className="cctv-entity__facts">
                              {['colour', 'body_type'].filter((key) => observation.attributes[key]).map((key) => <div key={key}><dt>{key.replace('_', ' ')}</dt><dd>{String(observation.attributes[key])}</dd></div>)}
                              {observation.attributes.make_model_source === 'human_confirmed' && observation.attributes.make ? <div><dt>make</dt><dd>{String(observation.attributes.make)}</dd></div> : null}
                              {observation.attributes.make_model_source === 'human_confirmed' && observation.attributes.model ? <div><dt>model</dt><dd>{String(observation.attributes.model)}</dd></div> : null}
                              {observation.attributes.plate_confidence ? <div><dt>plate read</dt><dd>{Math.round(Number(observation.attributes.plate_confidence) * 100)}%</dd></div> : null}
                            </dl>
                            {(() => {
                              const hint = vehicleAttributeCandidateFrom(observation);
                              if (!hint) return null;
                              const label = [
                                [hint.make, hint.model].filter(Boolean).join(' '),
                                hint.colour,
                                hint.bodyType,
                                hint.year,
                              ].filter(Boolean).join(' · ');
                              const busyPrefix = `${observation.id}:attrs:`;
                              return (
                                <div className="cctv-entity__ai-hint-block">
                                  <p className="cctv-entity__ai-hint" title="Machine-derived vehicle attributes remain provisional until a human confirms or corrects them.">
                                    Vehicle attribute candidate: {label}
                                    {hint.confidence !== null ? ` · ${Math.round(hint.confidence * 100)}% confidence` : ''}
                                    {hint.source ? ` · ${hint.source}` : ' · source not recorded'}
                                  </p>
                                  {!hint.reviewed ? (
                                    correctingVehicleId === observation.id ? (
                                      <div className="cctv-entity__ai-hint-correct">
                                        <label className="cctv-entity__field">Make <input value={correctMake} onChange={(event) => setCorrectMake(event.target.value)} placeholder={hint.make ?? 'e.g. Toyota'} /></label>
                                        <label className="cctv-entity__field">Model <input value={correctModel} onChange={(event) => setCorrectModel(event.target.value)} placeholder={hint.model ?? 'e.g. Hilux'} /></label>
                                        <label className="cctv-entity__field">Colour <input value={correctColour} onChange={(event) => setCorrectColour(event.target.value)} placeholder={hint.colour ?? 'e.g. white'} /></label>
                                        <label className="cctv-entity__field">Body type <input value={correctBodyType} onChange={(event) => setCorrectBodyType(event.target.value)} placeholder={hint.bodyType ?? 'e.g. van'} /></label>
                                        <label className="cctv-entity__field">Year <input type="number" value={correctYear} onChange={(event) => setCorrectYear(event.target.value)} placeholder={hint.year ? String(hint.year) : 'e.g. 2022'} /></label>
                                        <div className="cctv-entity__actions">
                                          <button type="button" className="page-action is-primary" disabled={reviewBusy !== null || (!correctMake.trim() && !correctModel.trim() && !correctColour.trim() && !correctBodyType.trim() && !correctYear.trim())} onClick={() => void runVehicleAttributeReview(observation, 'correct')}><Check size={14} aria-hidden="true" /> Save correction</button>
                                          <button type="button" className="page-action" disabled={reviewBusy !== null} onClick={() => { setCorrectingVehicleId(null); setCorrectMake(''); setCorrectModel(''); setCorrectColour(''); setCorrectBodyType(''); setCorrectYear(''); }}>Cancel</button>
                                        </div>
                                      </div>
                                    ) : (
                                      <div className="cctv-entity__actions">
                                        <button type="button" className="page-action is-primary" disabled={reviewBusy !== null} onClick={() => void runVehicleAttributeReview(observation, 'confirm')}><Check size={14} aria-hidden="true" /> {reviewBusy === `${busyPrefix}confirm` ? 'Saving…' : 'Confirm'}</button>
                                        <button type="button" className="page-action" disabled={reviewBusy !== null} onClick={() => setCorrectingVehicleId(observation.id)}>Correct</button>
                                        <button type="button" className="page-action is-danger" disabled={reviewBusy !== null} onClick={() => void runVehicleAttributeReview(observation, 'reject')}><X size={14} aria-hidden="true" /> Dismiss</button>
                                      </div>
                                    )
                                  ) : (
                                    <small className="cctv-console__muted">Reviewed: {hint.reviewStatus?.replace(/_/g, ' ') || 'complete'}.</small>
                                  )}
                                </div>
                              );
                            })()}
                          </>
                        ) : null}
                        {observation.kind === 'animal' ? (
                          <dl className="cctv-entity__facts">
                            <div><dt>species</dt><dd>{observation.species || 'unidentified'}{observation.speciesConfidence !== null ? ` (${Math.round(observation.speciesConfidence * 100)}%)` : ''}</dd></div>
                            <div><dt>pest</dt><dd>{observation.isPest === null ? 'unknown' : observation.isPest ? 'yes' : 'no'}</dd></div>
                            {observation.attributes.species_status ? <div><dt>model</dt><dd>{String(observation.attributes.species_status).replace(/_/g, ' ')}</dd></div> : null}
                          </dl>
                        ) : null}
                        {observation.kind === 'person' ? (() => {
                          const weapon = weaponHintFrom(observation);
                          if (!weapon?.present) return null;
                          return (
                            <div className="cctv-entity__weapon-alert" role="alert">
                              <p>
                                <AlertTriangle size={14} aria-hidden="true" /> Possible weapon flagged by AI (unverified){weapon.description ? `: ${weapon.description}` : ''}. Review this sighting now.
                              </p>
                              {!weapon.reviewed ? (
                                <div className="cctv-entity__actions">
                                  <button type="button" className="page-action is-primary" disabled={reviewBusy !== null} onClick={() => void runWeaponHintReview(observation, 'confirmed')}><Check size={14} aria-hidden="true" /> Confirm</button>
                                  <button type="button" className="page-action" disabled={reviewBusy !== null} onClick={() => void runWeaponHintReview(observation, 'dismissed')}><X size={14} aria-hidden="true" /> False positive</button>
                                </div>
                              ) : (
                                <small className="cctv-console__muted">Reviewed.</small>
                              )}
                            </div>
                          );
                        })() : null}
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
                                  <div className="cctv-entity__candidate-main">
                                    {candidate.thumbnail ? <img className="cctv-entity__candidate-thumb" src={candidate.thumbnail} alt="" /> : <span className="cctv-entity__candidate-thumb is-blank" title="No preview stored for this kind of match">{KIND_ICON[observation.kind]}</span>}
                                    <span>
                                      <strong>{candidate.display_name || candidate.plate_number || (candidate.match_kind === 'observation' ? 'Earlier sighting' : 'Known record')}</strong>
                                      <small>{candidate.basis?.replace(/_/g, ' ')} · {Math.round((candidate.score ?? 0) * 100)}%{candidate.last_seen_at ? ` · last seen ${formatDate(parseMs(candidate.last_seen_at) ?? 0, timeZone)}` : ''}</small>
                                    </span>
                                  </div>
                                  <div className="cctv-entity__candidate-actions">
                                    {candidate.cctv_import_id ? <a className="page-action" href={`/admin/field-ops?area=cctv-console&import=${candidate.cctv_import_id}`} target="_blank" rel="noopener noreferrer" title="Open this earlier sighting's footage in a new tab to compare before confirming"><ExternalLink size={14} aria-hidden="true" /> View footage</a> : null}
                                    {mapped ? <button type="button" className="page-action" disabled={reviewBusy !== null || isReviewed(observation)} onClick={() => void runReview(observation, mapped.action, mapped.targetId)}><Link2 size={14} aria-hidden="true" /> {mapped.label}</button> : null}
                                  </div>
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
                            <label className="cctv-entity__field">Category <select value={personCategory} onChange={(event) => setPersonCategory(event.target.value)}>
                              <option value="">Not set</option>
                              <option value="Visitor">Visitor</option>
                              <option value="Staff">Staff</option>
                              <option value="Contractor">Contractor</option>
                              <option value="Resident or tenant">Resident or tenant</option>
                              <option value="Known to site">Known to site</option>
                              <option value="Person of interest">Person of interest</option>
                            </select></label>
                            <label className="cctv-entity__field">Profile details <textarea value={personDetails} onChange={(event) => setPersonDetails(event.target.value)} placeholder="Optional details confirmed by the reviewer" rows={2} /></label>
                            <button type="button" className="page-action" disabled={reviewBusy !== null || !newName.trim()} onClick={() => void updatePersonProfile(observation)}><UserRound size={14} aria-hidden="true" /> Save person profile</button>
                          </div>
                        ) : null}
                        {observation.kind === 'vehicle' && (observation.plate || observation.canonicalVehicleId) ? (
                          <div className="cctv-entity__profile-editor">
                            <label className="cctv-entity__field">Vehicle note <textarea value={vehicleNotes} onChange={(event) => setVehicleNotes(event.target.value)} placeholder="e.g. Regular contractor, seen loitering near the fence line" rows={2} /></label>
                            <button type="button" className="page-action" disabled={reviewBusy !== null} onClick={() => void updateVehicleNotes(observation)}><Car size={14} aria-hidden="true" /> Save vehicle note</button>
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
                <Film size={13} aria-hidden="true" /> <button type="button" className="cctv-import-link" onClick={() => navigate(`/admin/field-ops?area=cctv-review`)}>Open this clip in the job queue</button> for exports and report receipts.
              </p>
            ) : null}
        </aside>
      </div>
    </div>
  );
};

export default CCTVConsolePage;