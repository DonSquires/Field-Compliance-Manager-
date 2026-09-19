import { Fragment, StrictMode, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import { createClient, type Session } from '@supabase/supabase-js';
import { Activity, CheckCircle2, ChevronRight, Clapperboard, Cpu, Database, Download, EyeOff, Film, FolderOpen, HardDrive, LockKeyhole, LogIn, LogOut, MapPin, Play, Search, Send, ShieldCheck, Square, Trash2, Undo2, UploadCloud, Waves } from 'lucide-react';
import './styles.css';

type AcquisitionStage = 'idle' | 'discovery' | 'ready' | 'cloning' | 'verifying' | 'complete' | 'failed';
type DecoderStage = 'not_started' | 'scanning' | 'identified' | 'ambiguous' | 'failed';

type DeviceCandidate = {
  id: string;
  label: string;
  sizeBytes: number;
  removable: boolean;
  readOnly: boolean;
  partitions: number;
  partitionStyle: string;
  busType: string;
  driveLetters: string[];
  offline: boolean;
};

type DeviceProbe = {
  id: string;
  sizeBytes: number;
  sector0Hex: string;
  sector0Ascii: string;
  mbrSignature: boolean;
  mbrPartitions: string[];
  dhfsMagicAtZero: boolean;
  dhfsDptMarkerWithinFirstMib: number | null;
  dhfsLocation: string | null;
  dhfsError: string | null;
};

declare const __APP_VERSION__: string;
const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

type AcquisitionReceipt = {
  sourceId: string;
  imagePath: string;
  bytesCopied: number;
  sourceSha256: string;
  imageSha256: string;
  verified: boolean;
  readErrors: number;
};

type AcquisitionProgress = {
  sourceId: string;
  stage: 'cloning' | 'verifying' | 'complete' | 'mismatch';
  bytesDone: number;
  totalBytes: number;
  elapsedSeconds: number;
  bytesPerSecond: number;
  etaSeconds: number | null;
};

type DhfsTime = { year: number; month: number; day: number; hour: number; minute: number; second: number };

type DhfsPartition = {
  index: number;
  partitionOffset: number;
  superblockOffset: number;
  blockSize: number;
  fragmentBlocks: number;
  descriptorCount: number;
  firstDate: DhfsTime | null;
  lastDate: DhfsTime | null;
  fragmentSize: number;
  capacityBytes: number;
};

type DhfsVolume = {
  location: { baseOffset: number; method: 'device_start' | 'mbr_partition' | 'gpt_partition' | 'scan'; index?: number; typeCode?: number };
  dptMarkerOffset: number;
  partitions: DhfsPartition[];
  tableNote: string;
};

type DhfsRecording = {
  partitionIndex: number;
  descriptor: number;
  channel: number;
  start: DhfsTime;
  end: DhfsTime;
  durationSeconds: number;
  fragmentCount: number;
  bytes: number;
};

type DhfsCatalog = { volume: DhfsVolume; recordings: DhfsRecording[]; skippedDescriptors: number; warnings: string[] };

type ContentKind = 'dhav_video' | 'pictures' | 'raw_stream';

type ExtractionStats = {
  framesKept: number; videoFrames: number; keyFrames: number; audioFrames: number;
  staleFrames: number; staleBytes: number; unstructuredBytes: number; structuralBytesRemoved: number;
  leadingFramesDropped: number; sourceBytesRead: number; pictures: number;
  contentStart: DhfsTime | null; contentEnd: DhfsTime | null; stoppedAtNextRecording: boolean; truncatedFinalFrame: boolean;
};

type ExtractedPicture = { path: string; fileName: string; bytes: number; sha256: string; takenAt: DhfsTime; width: number | null; height: number | null };

type ExtractedClip = {
  path: string;
  fileName: string;
  bytes: number;
  sha256: string;
  contentType: string;
  codec: string;
  streamStartOffset: number;
  channel: number;
  start: DhfsTime;
  end: DhfsTime;
  durationSeconds: number;
  fragments: number;
  descriptor: number;
  partitionIndex: number;
  kind: ContentKind;
  stats: ExtractionStats;
  pictures: ExtractedPicture[];
};

type InspectionResult = {
  imageBytes: number;
  signatures: string[];
  candidateOffsets: number[];
  adapters: Array<{ name: string; state: string; confidence: string; detail: string }>;
  dhfs: DhfsVolume | null;
  dhfsError: string | null;
};

/** Which bytes the DHFS reader walks: the verified image (evidence path) or the card itself (read-only, no clone). */
type DhfsSource = { kind: 'image'; path: string } | { kind: 'device'; id: string; sizeBytes: number };

// The same project and publishable key the web app ships in its bundle and V1 carries; every read and
// write below still runs as the signed-in user under row-level security.
const FCM_SUPABASE_URL = 'https://dotczcyyzgabmtmnglqj.supabase.co';
const FCM_PUBLISHABLE_KEY = 'sb_publishable_5w9B6uzyMnUu_oL52kqjnA_QjuwA2jU';
const supabase = createClient(FCM_SUPABASE_URL, FCM_PUBLISHABLE_KEY, { auth: { autoRefreshToken: true, persistSession: false, detectSessionInUrl: false } });

type OperatingOrganization = { organizationId: string; organizationName: string; isDefault: boolean };
type HouseRow = { id: string; name: string; address: string | null; organization_id: string };
type ImportRow = { id: string; camera_label: string; status: string; location_id: string; organization_id: string };
type FcmProfile = { displayName: string; organizationId: string | null };
type SendStatus = 'extracting' | 'uploading' | 'registering' | 'done' | 'failed';
type SendState = { status: SendStatus; sent: number; total: number; error?: string };
type UploadProgress = { uploadId: string; bytesSent: number; totalBytes: number; elapsedSeconds: number; bytesPerSecond: number };
type UploadOutcome = { status: 'complete' | 'exists' | 'unauthorized'; uploadUrl: string | null; bytesSent: number; totalBytes: number };

// Review here: the pinned decoder and what it renders on this computer. Nothing here is ever sent or registered.
type DecoderStatus = { installed: boolean; version: string; path: string | null; licence: string; licenceUrl: string; downloadBytes: number; rejectedReason: string | null };
type DecoderProgress = { bytesDone: number; totalBytes: number };
type Filmstrip = { frames: Array<{ atSeconds: number; jpegBase64: string }>; keyFramesUsed: number };
type PreviewRendition = { path: string; bytes: number; encoder: 'nvenc' | 'software' | null; seconds: number; cached: boolean };
type ReviewState = { busy: 'filmstrip' | 'preview' | null; filmstrip?: Filmstrip; preview?: PreviewRendition; error?: string };

const isValidTimeZone = (zone: string) => { try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; } };
const zoneOffsetMs = (utcMs: number, timeZone: string) => {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(utcMs)).map((part) => [part.type, part.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second)) - utcMs;
};
/** The camera's wall clock (what DHFS stores) as an instant, mirroring the web import page's conversion. */
const wallClockToIso = (time: DhfsTime, timeZone: string) => {
  const guess = Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
  let instant = guess - zoneOffsetMs(guess, timeZone);
  const secondPass = zoneOffsetMs(instant, timeZone);
  if (guess - secondPass !== instant) instant = guess - secondPass;
  return new Date(instant).toISOString();
};
/** Object key inside bob-uploads, identical to the web app's storagePathFor so register_cctv_import_video accepts it. */
const storagePathFor = (organizationId: string, importId: string, relativePath: string) => {
  const safe = relativePath.split('/').map((segment) => (segment === '.' || segment === '..' ? '_' : segment.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120))).filter(Boolean).join('/');
  return `org/${organizationId}/cctv/${importId}/${safe || 'file'}`;
};
const sendLabel: Record<SendStatus, string> = { extracting: 'Reading from card…', uploading: 'Sending…', registering: 'Registering…', done: 'Sent to FCM', failed: 'Send failed' };
/** What an extraction actually held, in the operator's terms; the descriptor's byte count is not the recording. */
const describeClip = (clip: ExtractedClip) => {
  const s = clip.stats;
  const span = s.contentStart && s.contentEnd ? `${formatClock(s.contentStart)}–${formatClock(s.contentEnd)}` : null;
  const skipped = s.staleBytes + s.unstructuredBytes + s.structuralBytesRemoved;
  const parts: string[] = [];
  if (clip.kind === 'pictures') parts.push(`${s.pictures} event picture${s.pictures === 1 ? '' : 's'}`);
  else if (clip.kind === 'dhav_video') parts.push(`${clip.codec.replace('dhav/', '').toUpperCase()} video · ${s.videoFrames.toLocaleString()} frames`);
  else parts.push(`${clip.codec} stream (frames not validated)`);
  if (span) parts.push(span);
  parts.push(formatBytes(clip.bytes));
  if (skipped > 0) parts.push(`${formatBytes(skipped)} of card leftovers skipped`);
  if (s.truncatedFinalFrame) parts.push('last frame cut by the card');
  return parts.join(' · ');
};

const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
};

const pad = (value: number) => String(value).padStart(2, '0');
const formatTime = (time: DhfsTime | null | undefined) => (time ? `${time.year}-${pad(time.month)}-${pad(time.day)} ${pad(time.hour)}:${pad(time.minute)}:${pad(time.second)}` : '—');
const formatClock = (time: DhfsTime) => `${pad(time.hour)}:${pad(time.minute)}:${pad(time.second)}`;
/** The camera's wall clock `seconds` after `time` — pure wall-clock arithmetic, no time zone involved. */
const clockPlus = (time: DhfsTime, seconds: number) => {
  const at = new Date(Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second) + Math.round(seconds) * 1000);
  return `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}`;
};
const encoderLabel = (preview: PreviewRendition) => (preview.cached ? 'viewing copy from an earlier run' : preview.encoder === 'nvenc' ? 'rendered on the GPU (NVENC)' : 'rendered in software (libx264)');
const formatDay = (time: DhfsTime) => `${time.year}-${pad(time.month)}-${pad(time.day)}`;
const formatDuration = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const h = Math.floor(seconds / 3600); const m = Math.floor((seconds % 3600) / 60); const s = Math.floor(seconds % 60);
  return h > 0 ? `${h}h ${pad(m)}m ${pad(s)}s` : `${m}m ${pad(s)}s`;
};
const formatRate = (bytesPerSecond: number) => (Number.isFinite(bytesPerSecond) && bytesPerSecond > 0 ? `${(bytesPerSecond / 1024 ** 2).toFixed(1)} MB/s` : '—');
/** Rough clone time for a card of `bytes` at a conservative USB reader rate, so the operator can decide before committing. */
const estimateCloneMinutes = (bytes: number) => Math.max(1, Math.round(bytes / (40 * 1024 ** 2) / 60));
const recordingKey = (recording: DhfsRecording) => `${recording.partitionIndex}:${recording.descriptor}`;
const locationLabel = (volume: DhfsVolume) => {
  switch (volume.location.method) {
    case 'device_start': return 'raw device, no partition table';
    case 'mbr_partition': return `MBR partition ${(volume.location.index ?? 0) + 1} (RAW to Windows)`;
    case 'gpt_partition': return `GPT partition ${(volume.location.index ?? 0) + 1}`;
    default: return 'found by sector scan';
  }
};

const stageLabel: Record<AcquisitionStage, string> = {
  idle: 'Waiting for source', discovery: 'Inspecting devices', ready: 'Ready to acquire', cloning: 'Acquiring read-only image', verifying: 'Verifying hashes', complete: 'Acquisition verified', failed: 'Last acquisition failed',
};

function Step({ number, title, detail, active, complete }: { number: string; title: string; detail: string; active?: boolean; complete?: boolean }) {
  return <div className={`step ${active ? 'is-active' : ''} ${complete ? 'is-complete' : ''}`}><span>{complete ? <CheckCircle2 size={16} /> : number}</span><div><strong>{title}</strong><small>{detail}</small></div></div>;
}

export default function App() {
  const [stage, setStage] = useState<AcquisitionStage>('idle');
  const [decoderStage, setDecoderStage] = useState<DecoderStage>('not_started');
  const [devices, setDevices] = useState<DeviceCandidate[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<DeviceCandidate | null>(null);
  const [receipt, setReceipt] = useState<AcquisitionReceipt | null>(null);
  const [inspection, setInspection] = useState<InspectionResult | null>(null);
  const [catalog, setCatalog] = useState<DhfsCatalog | null>(null);
  const [catalogSource, setCatalogSource] = useState<DhfsSource | null>(null);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [destinationDirectory, setDestinationDirectory] = useState<string | null>(null);
  const [extracting, setExtracting] = useState<string | null>(null);
  const [clips, setClips] = useState<Record<string, ExtractedClip>>({});
  const [status, setStatus] = useState('Connect a camera card to begin a read-only acquisition.');
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState<DeviceProbe | null>(null);
  const [probing, setProbing] = useState(false);
  const [progress, setProgress] = useState<AcquisitionProgress | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [fcmSession, setFcmSession] = useState<Session | null>(null);
  const [fcmProfile, setFcmProfile] = useState<FcmProfile | null>(null);
  const [fcmEmail, setFcmEmail] = useState('');
  const [fcmPassword, setFcmPassword] = useState('');
  const [fcmBusy, setFcmBusy] = useState(false);
  const [organizations, setOrganizations] = useState<OperatingOrganization[]>([]);
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [houses, setHouses] = useState<HouseRow[]>([]);
  const [houseQuery, setHouseQuery] = useState('');
  const [houseId, setHouseId] = useState<string | null>(null);
  const [cameraLabel, setCameraLabel] = useState('');
  const [timeZone, setTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Pacific/Auckland');
  const [notes, setNotes] = useState('');
  const [importRow, setImportRow] = useState<ImportRow | null>(null);
  const [sends, setSends] = useState<Record<string, SendState>>({});
  const [sendingKey, setSendingKey] = useState<string | null>(null);
  const [queueRemaining, setQueueRemaining] = useState(0);
  const [decoder, setDecoder] = useState<DecoderStatus | null>(null);
  const [decoderError, setDecoderError] = useState<string | null>(null);
  const [decoderBusy, setDecoderBusy] = useState(false);
  const [decoderProgress, setDecoderProgress] = useState<DecoderProgress | null>(null);
  const [reviews, setReviews] = useState<Record<string, ReviewState>>({});
  const [openReview, setOpenReview] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<Record<string, true>>({});
  const stopQueueRef = useRef(false);
  // Sends finished during a queue, readable after the loop without waiting for a re-render.
  const doneClipsRef = useRef<Record<string, ExtractedClip>>({});

  const describeFailure = (cause: unknown, fallback: string) => (typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : fallback);
  const failWith = (cause: unknown, fallback: string) => setError(describeFailure(cause, fallback));

  useEffect(() => {
    // A rejected promise outside a handler used to vanish: the operator saw a button that "did nothing".
    const onRejection = (event: PromiseRejectionEvent) => { event.preventDefault(); setError(`Unhandled failure: ${describeFailure(event.reason, String(event.reason))}`); };
    const onError = (event: ErrorEvent) => setError(`Interface error: ${event.message}`);
    window.addEventListener('unhandledrejection', onRejection); window.addEventListener('error', onError);
    return () => { window.removeEventListener('unhandledrejection', onRejection); window.removeEventListener('error', onError); };
  }, []);

  useEffect(() => {
    const pending = listen<UploadProgress>('upload-progress', (event) => {
      const { uploadId, bytesSent, totalBytes } = event.payload;
      setSends((current) => (current[uploadId] ? { ...current, [uploadId]: { ...current[uploadId], status: 'uploading', sent: bytesSent, total: totalBytes } } : current));
    });
    return () => { void pending.then((unlisten) => unlisten()); };
  }, []);

  useEffect(() => {
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => setFcmSession(session));
    return () => subscription.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    // Status is read by hash, not by file name, so a tampered or half-downloaded binary shows as rejected.
    invoke<DecoderStatus>('decoder_status').then(setDecoder).catch((cause: unknown) => setDecoderError(describeFailure(cause, 'The decoder status could not be read.')));
    const pending = listen<DecoderProgress>('decoder-progress', (event) => setDecoderProgress(event.payload));
    return () => { void pending.then((unlisten) => unlisten()); };
  }, []);

  const selectedSize = useMemo(() => selectedDevice ? formatBytes(selectedDevice.sizeBytes) : 'No source selected', [selectedDevice]);
  const recordingDays = useMemo(() => {
    const groups = new Map<string, DhfsRecording[]>();
    for (const recording of catalog?.recordings ?? []) {
      const day = formatDay(recording.start);
      groups.set(day, [...(groups.get(day) ?? []), recording]);
    }
    return [...groups.entries()];
  }, [catalog]);
  const totalRecordingBytes = useMemo(() => (catalog?.recordings ?? []).reduce((sum, recording) => sum + recording.bytes, 0), [catalog]);
  const sourceLabel = (source: DhfsSource | null) => (source ? (source.kind === 'image' ? 'verified image' : `card ${source.id}`) : 'no source');
  const visibleHouses = useMemo(() => {
    const scoped = organizationId ? houses.filter((house) => house.organization_id === organizationId) : houses;
    const pool = scoped.length ? scoped : houses;
    const query = houseQuery.trim().toLowerCase();
    return (query ? pool.filter((house) => `${house.name} ${house.address ?? ''}`.toLowerCase().includes(query)) : pool).slice(0, 8);
  }, [houses, houseQuery, organizationId]);
  const selectedHouse = useMemo(() => houses.find((house) => house.id === houseId) ?? null, [houses, houseId]);
  const sentCount = useMemo(() => Object.values(sends).filter((send) => send.status === 'done').length, [sends]);
  const skippedCount = useMemo(() => Object.keys(skipped).length, [skipped]);
  const previewCount = useMemo(() => Object.values(reviews).filter((review) => review.preview).length, [reviews]);
  const unsentRecordings = useMemo(() => (catalog?.recordings ?? []).filter((recording) => { const key = recordingKey(recording); return sends[key]?.status !== 'done' && !skipped[key]; }), [catalog, sends, skipped]);

  const discover = async () => {
    setStage('discovery'); setError(null); setProbe(null); setStatus('Enumerating disks without opening a write handle...');
    try {
      const found = await invoke<DeviceCandidate[]>('discover_read_only_devices');
      setDevices(found); setSelectedDevice(found[0] || null); setStage(found.length ? 'ready' : 'idle');
      setStatus(found.length
        ? `${found.length} disk${found.length === 1 ? '' : 's'} available besides the Windows system disk. Pick the card (its drive letter is shown), then list recordings directly from it.`
        : 'No disk besides the Windows system disk was found. Reseat the card, wait for Windows to notice it (cancel any "format the disk" prompt), then discover again.');
    } catch (cause) { setStage('failed'); failWith(cause, 'Device discovery failed.'); }
  };

  const probeDevice = async (device: DeviceCandidate) => {
    setProbing(true); setProbe(null);
    try {
      setProbe(await invoke<DeviceProbe>('probe_device', { id: device.id, sizeBytes: device.sizeBytes }));
    } catch (cause) {
      setProbe({ id: device.id, sizeBytes: device.sizeBytes, sector0Hex: '', sector0Ascii: '', mbrSignature: false, mbrPartitions: [], dhfsMagicAtZero: false, dhfsDptMarkerWithinFirstMib: null, dhfsLocation: null, dhfsError: typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : 'The card could not be probed.' });
    } finally { setProbing(false); }
  };

  const acquire = async () => {
    if (!selectedDevice) return;
    setError(null);
    let destination: string | null;
    try {
      destination = await save({ title: 'Save immutable source image', defaultPath: 'C:\\Users\\Public\\Documents\\fcm-acquisitions\\source.img', filters: [{ name: 'Disk image', extensions: ['img'] }] });
    } catch (cause) { failWith(cause, 'The save dialog could not be opened.'); return; }
    if (!destination) { setStatus('Acquisition not started: no destination was chosen.'); return; }
    setStage('cloning'); setReceipt(null); setInspection(null); setDecoderStage('not_started'); setProgress(null); setCancelling(false);
    setStatus(`Cloning ${formatBytes(selectedDevice.sizeBytes)} with a read-only handle (roughly ${estimateCloneMinutes(selectedDevice.sizeBytes)} min over USB). The card will not be modified.`);
    const unlisten = await listen<AcquisitionProgress>('acquisition-progress', (event) => {
      if (event.payload.sourceId !== selectedDevice.id) return;
      setProgress(event.payload);
      if (event.payload.stage === 'verifying') setStage('verifying');
    });
    try {
      const result = await invoke<AcquisitionReceipt>('acquire_read_only_device_image', { sourceId: selectedDevice.id, destinationPath: destination, sizeBytes: selectedDevice.sizeBytes });
      setReceipt(result); setStage('complete'); setStatus(result.verified ? 'Acquisition verified: source and image hashes match. The prototype now works from the immutable image.' : 'Image created but the verification hashes do not match. Treat the image as suspect.');
    } catch (cause) { setStage('failed'); failWith(cause, 'Acquisition failed.'); }
    finally { unlisten(); setCancelling(false); }
  };

  const cancelAcquisition = async () => {
    setCancelling(true);
    try { await invoke('cancel_acquisition'); } catch (cause) { failWith(cause, 'Cancel request failed.'); }
  };

  const readCatalog = async (source: DhfsSource) => {
    setCatalogBusy(true); setError(null); setCatalog(null); setCatalogSource(source); setClips({}); setReviews({}); setOpenReview(null); setSkipped({}); setProbe(null);
    setStatus(source.kind === 'image' ? 'Walking the DHFS partition table and fragment descriptors inside the image...' : 'Reading the DHFS partition table directly from the card (read-only, sector-aligned)...');
    try {
      const result = await invoke<DhfsCatalog>('read_dhfs_catalog', { source });
      setCatalog(result);
      const partition = result.volume.partitions[0];
      setStatus(`${result.recordings.length} recording${result.recordings.length === 1 ? '' : 's'} on the hidden DHFS partition (${locationLabel(result.volume)}), ${formatTime(partition?.firstDate)} to ${formatTime(partition?.lastDate)}.${result.skippedDescriptors ? ` ${result.skippedDescriptors} descriptor${result.skippedDescriptors === 1 ? '' : 's'} skipped as untrustworthy.` : ''}`);
    } catch (cause) {
      failWith(cause, 'The DHFS catalog could not be read.');
      // Show what the first sectors actually hold so the failure is describable, not a shrug.
      if (source.kind === 'device') { const device = devices.find((candidate) => candidate.id === source.id); if (device) await probeDevice(device); }
    }
    finally { setCatalogBusy(false); }
  };

  const inspectImage = async () => {
    if (!receipt) return;
    setDecoderStage('scanning'); setError(null); setStatus('Scanning the image for partition signatures, then walking the DHFS volume...');
    try {
      const result = await invoke<InspectionResult>('inspect_acquisition_image', { imagePath: receipt.imagePath });
      setInspection(result); setDecoderStage(result.dhfs ? 'identified' : result.adapters.some((adapter) => adapter.state === 'ambiguous') ? 'ambiguous' : 'identified'); setStatus('Image inspection complete. No source bytes were changed.');
      if (result.dhfs) await readCatalog({ kind: 'image', path: receipt.imagePath });
    } catch (cause) { setDecoderStage('failed'); failWith(cause, 'Image inspection failed.'); }
  };

  const chooseDestination = async () => {
    try {
      const chosen = await open({ title: 'Choose where extracted clips are written', directory: true, multiple: false, defaultPath: 'C:\\Users\\Public\\Documents\\fcm-acquisitions' });
      if (typeof chosen === 'string') setDestinationDirectory(chosen);
      return typeof chosen === 'string' ? chosen : null;
    } catch (cause) { failWith(cause, 'The folder dialog could not be opened.'); return null; }
  };

  const extract = async (recording: DhfsRecording) => {
    if (!catalogSource) return;
    let directory = destinationDirectory;
    if (!directory) {
      try { directory = await invoke<string>('default_clip_directory', { sourceId: catalogSource.kind === 'device' ? catalogSource.id : 'image' }); setDestinationDirectory(directory); }
      catch (cause) { failWith(cause, 'The working folder could not be created.'); return; }
    }
    const key = recordingKey(recording);
    setExtracting(key); setError(null); setStatus(`Extracting channel ${recording.channel}, ${formatTime(recording.start)} (${formatBytes(recording.bytes)}) from the ${sourceLabel(catalogSource)}...`);
    try {
      const clip = await invoke<ExtractedClip>('extract_dhfs_recording', { source: catalogSource, partitionIndex: recording.partitionIndex, descriptor: recording.descriptor, destinationDirectory: directory });
      setClips((current) => ({ ...current, [key]: clip }));
      // A fresh extraction supersedes anything rendered from the previous copy.
      setReviews((current) => { const next = { ...current }; delete next[key]; return next; });
      setStatus(`${clip.kind === 'pictures' ? `Wrote ${clip.pictures.length} pictures into ${clip.fileName}` : `Wrote ${clip.fileName}`} — ${describeClip(clip)}. SHA-256 recorded; the card was not modified.`);
    } catch (cause) { failWith(cause, 'Extraction failed.'); }
    finally { setExtracting(null); }
  };

  /** The recording's `-r2` extraction in the working folder: the copy already made this session, the finished file
   *  from an earlier run (re-hashed, not trusted by name), or a fresh read from the card. */
  const ensureClip = async (recording: DhfsRecording): Promise<ExtractedClip> => {
    if (!catalogSource) throw new Error('No card or image is open.');
    const key = recordingKey(recording);
    const existing = clips[key];
    if (existing) return existing;
    const directory = destinationDirectory ?? await invoke<string>('default_clip_directory', { sourceId: catalogSource.kind === 'device' ? catalogSource.id : 'image' });
    if (!destinationDirectory) setDestinationDirectory(directory);
    setStatus(`Reading channel ${recording.channel}, ${formatTime(recording.start)} from the ${sourceLabel(catalogSource)} — only frames the camera dated inside this recording are kept…`);
    const clip = await invoke<ExtractedClip>('extract_dhfs_recording', { source: catalogSource, partitionIndex: recording.partitionIndex, descriptor: recording.descriptor, destinationDirectory: directory, reuseExisting: true });
    setClips((current) => ({ ...current, [key]: clip }));
    return clip;
  };

  const updateReview = (key: string, patch: Partial<ReviewState>) => setReviews((current) => ({ ...current, [key]: { ...(current[key] ?? { busy: null }), ...patch } }));

  const installDecoder = async () => {
    setDecoderBusy(true); setDecoderError(null); setDecoderProgress({ bytesDone: 0, totalBytes: decoder?.downloadBytes ?? 0 });
    try {
      setDecoder(await invoke<DecoderStatus>('install_decoder'));
      setStatus('Decoder installed and verified against the hash built into this app. Choose “Preview” on a recording to see what it holds before sending.');
    } catch (cause) { setDecoderError(describeFailure(cause, 'The decoder could not be installed.')); }
    finally { setDecoderBusy(false); setDecoderProgress(null); }
  };

  /** Open the review for a recording: extract it if needed, then decode key frames on this computer. */
  const review = async (recording: DhfsRecording) => {
    const key = recordingKey(recording);
    setOpenReview(key); setError(null);
    if (reviews[key]?.filmstrip) return;
    if (!decoder?.installed) { updateReview(key, { busy: null, error: 'Install the decoder under “Review here” first; previews are decoded on this computer.' }); return; }
    updateReview(key, { busy: 'filmstrip', error: undefined });
    try {
      const clip = await ensureClip(recording);
      if (clip.kind === 'pictures') {
        updateReview(key, { busy: null, error: `${clip.pictures.length} dated pictures — a picture stream is sent as timeline events, not as video. The JPEGs are in ${clip.fileName} inside the working folder.` });
        return;
      }
      setStatus(`Decoding key frames of ${clip.fileName} on this computer…`);
      const filmstrip = await invoke<Filmstrip>('render_filmstrip', { clipPath: clip.path, keyFrames: clip.stats.keyFrames, count: 12 });
      updateReview(key, { busy: null, filmstrip });
      setStatus(`${filmstrip.frames.length} key frames from ${clip.fileName}, labelled with the camera clock. Play the preview for the whole recording, then choose Send or Skip.`);
    } catch (cause) { updateReview(key, { busy: null, error: describeFailure(cause, 'The recording could not be reviewed.') }); }
  };

  const playPreview = async (recording: DhfsRecording) => {
    const key = recordingKey(recording);
    const clip = clips[key];
    if (!clip) return;
    updateReview(key, { busy: 'preview', error: undefined });
    setStatus(`Rendering a 480p viewing copy of ${clip.fileName} on this computer (GPU when available). Nothing leaves the machine.`);
    try {
      const preview = await invoke<PreviewRendition>('render_preview', { clipPath: clip.path });
      updateReview(key, { busy: null, preview });
      setStatus(`Preview ready — ${encoderLabel(preview)}, ${formatBytes(preview.bytes)}${preview.cached ? '' : `, ${preview.seconds.toFixed(0)} s`}. A viewing aid only: it is never sent and never becomes evidence.`);
    } catch (cause) { updateReview(key, { busy: null, error: describeFailure(cause, 'The preview could not be rendered.') }); }
  };

  const toggleSkip = (recording: DhfsRecording) => {
    const key = recordingKey(recording);
    setSkipped((current) => { const next = { ...current }; if (next[key]) delete next[key]; else next[key] = true; return next; });
  };

  const clearPreviews = async () => {
    try {
      const freed = await invoke<number>('clear_previews');
      setReviews((current) => Object.fromEntries(Object.entries(current).map(([key, state]) => [key, { ...state, preview: undefined }])));
      setStatus(`${formatBytes(freed)} of viewing copies removed from this computer. Extracted originals and the card are untouched.`);
    } catch (cause) { failWith(cause, 'The viewing copies could not be removed.'); }
  };

  const loadFcmContext = async (userId: string) => {
    const [profileRes, contextsRes, housesRes] = await Promise.all([
      supabase.from('user_profiles').select('id, display_name, email, organization_id').eq('id', userId).maybeSingle(),
      supabase.rpc('get_operating_organization_contexts'),
      supabase.from('locations').select('id, name, address, organization_id').order('name'),
    ]);
    const failure = profileRes.error ?? contextsRes.error ?? housesRes.error;
    if (failure) throw new Error(failure.message);
    const profile = profileRes.data as { display_name: string | null; email: string | null; organization_id: string | null } | null;
    const contexts: OperatingOrganization[] = (Array.isArray(contextsRes.data) ? contextsRes.data : []).map((row: { organization_id: string; organization_name: string; is_default: boolean | null }) => ({ organizationId: row.organization_id, organizationName: row.organization_name, isDefault: Boolean(row.is_default) }));
    setFcmProfile(profile ? { displayName: profile.display_name || profile.email || 'FCM user', organizationId: profile.organization_id } : null);
    setOrganizations(contexts);
    setOrganizationId(contexts.find((context) => context.isDefault)?.organizationId ?? profile?.organization_id ?? contexts[0]?.organizationId ?? null);
    setHouses((housesRes.data as HouseRow[]) ?? []);
  };

  const signIn = async () => {
    if (!fcmEmail.trim() || !fcmPassword) { setError('Enter your FCM email and password.'); return; }
    setFcmBusy(true); setError(null);
    try {
      const { data, error: signInError } = await supabase.auth.signInWithPassword({ email: fcmEmail.trim(), password: fcmPassword });
      if (signInError) throw new Error(signInError.message);
      setFcmPassword('');
      setFcmSession(data.session);
      await loadFcmContext(data.user.id);
      setStatus('Signed in to FCM. Choose the place this camera watches, label the camera, and create the import.');
    } catch (cause) { failWith(cause, 'FCM sign-in failed.'); }
    finally { setFcmBusy(false); }
  };

  const signOut = async () => {
    try { await supabase.auth.signOut(); } catch { /* the in-memory session is dropped regardless */ }
    setFcmSession(null); setFcmProfile(null); setOrganizations([]); setOrganizationId(null); setHouses([]); setHouseId(null); setImportRow(null); setSends({}); doneClipsRef.current = {};
  };

  const createImport = async () => {
    if (!organizationId) { setError('Choose the organisation this footage belongs to.'); return; }
    if (!houseId) { setError('Choose the place this camera watches. Cards carry no GPS, so the place comes from you.'); return; }
    if (!cameraLabel.trim()) { setError('Give the camera a label (for example “Gate cam 1”).'); return; }
    if (!isValidTimeZone(timeZone)) { setError('Enter a valid time zone for the camera clock (for example Pacific/Auckland).'); return; }
    setFcmBusy(true); setError(null);
    try {
      const rootLabel = selectedDevice ? `${selectedDevice.driveLetters.join(' ')} ${selectedDevice.label}`.trim() : catalogSource ? sourceLabel(catalogSource) : null;
      const { data, error: createError } = await supabase.rpc('create_cctv_import', {
        p_organization_id: organizationId, p_location_id: houseId, p_camera_label: cameraLabel.trim(), p_site_id: null, p_zone_id: null,
        p_source_device_kind: 'dahua', p_source_timezone: timeZone, p_source_root_label: rootLabel, p_watermark_location_hint: null, p_notes: notes.trim() || null,
      });
      if (createError) throw new Error(createError.message);
      const row = data as ImportRow;
      const { error: manifestError } = await supabase.rpc('set_cctv_import_manifest', { p_import_id: row.id, p_manifest: [], p_status: 'uploading' });
      if (manifestError) throw new Error(manifestError.message);
      setImportRow(row); setSends({}); doneClipsRef.current = {};
      setStatus(`Import created for ${selectedHouse?.name ?? 'the chosen place'}. Choose “Send to FCM” on a recording, or send them all.`);
    } catch (cause) { failWith(cause, 'The import could not be created.'); }
    finally { setFcmBusy(false); }
  };

  const updateSend = (key: string, patch: Partial<SendState>) => setSends((current) => ({ ...current, [key]: { ...(current[key] ?? { status: 'extracting', sent: 0, total: 0 }), ...patch } }));

  const accessToken = async () => {
    const { data } = await supabase.auth.getSession();
    if (!data.session?.access_token) throw new Error('Your FCM session has ended. Sign in again to keep sending.');
    return data.session.access_token;
  };

  /** One resumable upload with the session refreshed if it lapses mid-way; returns once the object is stored. */
  const uploadFile = async (uploadId: string, filePath: string, objectName: string, contentType: string) => {
    let resumeUrl: string | null = null;
    for (let attempt = 0; ; attempt += 1) {
      const outcome: UploadOutcome = await invoke<UploadOutcome>('upload_clip_resumable', {
        uploadId, clipPath: filePath, resumeUrl,
        target: { supabaseUrl: FCM_SUPABASE_URL, apiKey: FCM_PUBLISHABLE_KEY, accessToken: await accessToken(), bucket: 'bob-uploads', objectName, contentType },
      });
      if (outcome.status !== 'unauthorized') return outcome;
      // The session expired mid-send: refresh once and continue from the same offset.
      if (attempt >= 2) throw new Error('FCM no longer accepts this session. Sign in again and choose Send to resume.');
      const { error: refreshError } = await supabase.auth.refreshSession();
      if (refreshError) throw new Error(`Session refresh failed: ${refreshError.message}`);
      resumeUrl = outcome.uploadUrl;
    }
  };

  /** Read one recording off the card (or reuse the finished copy), send it, and register it against the import:
   *  video becomes evidence queued for analysis; a picture stream becomes dated timeline events with thumbnails. */
  const sendRecording = async (recording: DhfsRecording, importTarget: ImportRow): Promise<boolean> => {
    if (!catalogSource) return false;
    const key = recordingKey(recording);
    setSendingKey(key); setError(null);
    updateSend(key, { status: 'extracting', sent: 0, total: recording.bytes, error: undefined });
    try {
      const clip = await ensureClip(recording);
      if (clip.kind === 'pictures') {
        if (!clip.pictures.length) throw new Error('No pictures dated inside this recording were found on the card.');
        updateSend(key, { status: 'uploading', sent: 0, total: clip.pictures.length });
        const events: Array<Record<string, unknown>> = [];
        for (const [index, picture] of clip.pictures.entries()) {
          setStatus(`Sending picture ${index + 1} of ${clip.pictures.length} (${formatTime(picture.takenAt)})…`);
          const objectName = storagePathFor(importTarget.organization_id, importTarget.id, `${clip.fileName}/${picture.fileName}`);
          await uploadFile(`${key}:${index}`, picture.path, objectName, 'image/jpeg');
          events.push({
            source: 'device_snapshot', source_ref: picture.fileName, event_start_at: wallClockToIso(picture.takenAt, timeZone), event_end_at: null, severity: 'motion', thumbnail_path: objectName,
            metadata: { size_bytes: picture.bytes, sha256: picture.sha256, width: picture.width, height: picture.height, channel: clip.channel, descriptor: clip.descriptor, origin: 'dahua_picture_stream' },
          });
          updateSend(key, { status: 'uploading', sent: index + 1, total: clip.pictures.length });
        }
        updateSend(key, { status: 'registering', sent: clip.pictures.length, total: clip.pictures.length });
        const { error: eventsError } = await supabase.rpc('record_cctv_device_events', { p_import_id: importTarget.id, p_events: events });
        if (eventsError) throw new Error(eventsError.message);
        doneClipsRef.current[key] = clip;
        updateSend(key, { status: 'done' });
        setStatus(`${clip.pictures.length} event pictures from ${formatTime(clip.pictures[0].takenAt)} are on the timeline at ${selectedHouse?.name ?? 'the chosen place'}.`);
        return true;
      }
      if (!clip.contentType.startsWith('video/')) throw new Error(`${clip.fileName} was not recognised as a video stream (${clip.codec}); it stays in the working folder and is not sent.`);
      const objectName = storagePathFor(importTarget.organization_id, importTarget.id, clip.fileName);
      updateSend(key, { status: 'uploading', sent: 0, total: clip.bytes });
      setStatus(`Sending ${clip.fileName} (${formatBytes(clip.bytes)}) to FCM…`);
      await uploadFile(key, clip.path, objectName, clip.contentType);
      updateSend(key, { status: 'registering', sent: clip.bytes, total: clip.bytes });
      const recordedStart = clip.stats.contentStart ?? clip.start;
      const recordedEnd = clip.stats.contentEnd ?? clip.end;
      const { error: registerError } = await supabase.rpc('register_cctv_import_video', {
        p_import_id: importTarget.id, p_storage_path: objectName, p_file_name: clip.fileName, p_file_size_bytes: clip.bytes, p_sha256: clip.sha256,
        p_recorded_start_at: wallClockToIso(recordedStart, timeZone), p_recorded_end_at: wallClockToIso(recordedEnd, timeZone), p_source_ref: clip.fileName, p_content_type: clip.contentType,
      });
      if (registerError) throw new Error(registerError.message);
      doneClipsRef.current[key] = clip;
      updateSend(key, { status: 'done' });
      setStatus(`${clip.fileName} is in FCM (SHA-256 anchored from the card) and queued for analysis at ${selectedHouse?.name ?? 'the chosen place'}.`);
      return true;
    } catch (cause) {
      const message = describeFailure(cause, 'The recording could not be sent.');
      updateSend(key, { status: 'failed', error: message }); setError(message);
      return false;
    } finally { setSendingKey(null); }
  };

  const manifestFor = (target: ImportRow) => Object.values(doneClipsRef.current).flatMap((clip) => {
    if (clip.kind === 'pictures') {
      return clip.pictures.map((picture) => ({ name: picture.fileName, relative_path: `${clip.fileName}/${picture.fileName}`, size_bytes: picture.bytes, kind: 'snapshot', slot_start_at: wallClockToIso(picture.takenAt, timeZone), sha256: picture.sha256, import_id: target.id }));
    }
    const start = clip.stats.contentStart ?? clip.start;
    const end = clip.stats.contentEnd ?? clip.end;
    return [{ name: clip.fileName, relative_path: clip.fileName, size_bytes: clip.bytes, kind: 'video', slot_start_at: wallClockToIso(start, timeZone), slot_end_at: wallClockToIso(end, timeZone), sha256: clip.sha256, import_id: target.id, content_kind: clip.kind, frames: clip.stats.videoFrames, stale_bytes_skipped: clip.stats.staleBytes }];
  });

  const finishImport = async (target: ImportRow) => {
    const anySent = Object.keys(doneClipsRef.current).length > 0;
    const { error: manifestError } = await supabase.rpc('set_cctv_import_manifest', { p_import_id: target.id, p_manifest: manifestFor(target), p_status: anySent ? 'registered' : null });
    if (manifestError) setError(`Sent, but the import summary could not be updated: ${manifestError.message}`);
  };

  const sendOne = async (recording: DhfsRecording) => {
    if (!importRow) return;
    // An explicit Send overrides an earlier Skip.
    setSkipped((current) => { const next = { ...current }; delete next[recordingKey(recording)]; return next; });
    await sendRecording(recording, importRow);
    await finishImport(importRow);
  };

  const sendAll = async () => {
    if (!importRow) return;
    stopQueueRef.current = false;
    const queue = unsentRecordings;
    let sentNow = 0;
    for (let index = 0; index < queue.length; index += 1) {
      if (stopQueueRef.current) break;
      setQueueRemaining(queue.length - index);
      if (await sendRecording(queue[index], importRow)) sentNow += 1;
    }
    setQueueRemaining(0);
    await finishImport(importRow);
    setStatus(stopQueueRef.current ? `Stopped: ${sentNow} recording${sentNow === 1 ? '' : 's'} sent before the stop.` : `${sentNow} of ${queue.length} recording${queue.length === 1 ? '' : 's'} sent to FCM${skippedCount ? ` (${skippedCount} skipped by you)` : ''}. Open FCM → CCTV review to watch the analysis land.`);
  };

  const stopQueue = async () => { stopQueueRef.current = true; try { await invoke('cancel_upload'); } catch (cause) { failWith(cause, 'Stop request failed.'); } };

  const catalogPartition = catalog?.volume.partitions[0];

  return <main className="v2-shell">
    <aside className="rail"><div className="brand"><span><Waves size={19} /></span><div><b>FCM</b><small>Desktop V2 · v{APP_VERSION}</small></div></div><nav><button className="is-active"><HardDrive size={17} /> Camera card</button><button><Database size={17} /> Image explorer</button><button><Search size={17} /> Decoder lab</button></nav><div className="rail-note"><LockKeyhole size={16} /><span>Read-only: the card is opened without a write handle and is never changed.</span></div></aside>
    <section className="workspace">
      <header className="topbar"><div><span className="eyebrow">Evidence workstation</span><h1>Read the card. Send the recordings.</h1><p>FCM reads the hidden Dahua partition straight from the card, stitches only the recordings you choose, and sends them to the place they belong. An exact image of the whole card is optional.</p></div><div className="topbar-badge"><ShieldCheck size={17} /> Read-only source</div></header>
      <section className="steps"><Step number="01" title="Discover" detail="Find the card" complete={stage !== 'idle' && stage !== 'discovery'} active={stage === 'discovery'} /><ChevronRight size={17} /><Step number="02" title="Recordings" detail="List from the card" complete={Boolean(catalog)} active={catalogBusy} /><ChevronRight size={17} /><Step number="03" title="Review here" detail="Optional · on this computer" complete={Object.values(reviews).some((review) => review.filmstrip)} active={Object.values(reviews).some((review) => review.busy !== null)} /><ChevronRight size={17} /><Step number="04" title="Send to FCM" detail="Straight from the card" complete={sentCount > 0} active={sendingKey !== null} /><ChevronRight size={17} /><Step number="05" title="Exact image" detail="Optional forensic copy" complete={stage === 'complete'} active={stage === 'cloning' || stage === 'verifying'} /></section>
      <div className="grid">
        <section className="panel source-panel"><div className="panel-heading"><div><span className="eyebrow">01 / Source</span><h2>Read-only device discovery</h2></div><Activity size={19} /></div><p className="muted">FCM opens the source read-only and never mounts or writes the camera card. A Dahua card usually shows in Explorer as a RAW drive letter that Windows offers to format — cancel that prompt; the letter is the hidden DHFS partition, not a fault. Reading a whole disk needs administrator rights, so FCM Desktop V2 asks for them once when it starts.</p><button className="primary" onClick={() => void discover()} disabled={stage === 'discovery'}><HardDrive size={16} /> {stage === 'discovery' ? 'Scanning...' : 'Discover camera cards and disks'}</button>{devices.length > 0 && <div className="device-list">{devices.map((device) => <button key={device.id} className={`device ${selectedDevice?.id === device.id ? 'is-selected' : ''}`} onClick={() => { setSelectedDevice(device); setProbe(null); }}><span className="device-icon"><HardDrive size={17} /></span><span><strong>{device.driveLetters.length ? `${device.driveLetters.join(' ')} · ` : ''}{device.label}</strong><small>{device.id} · {formatBytes(device.sizeBytes)} · {device.busType}{device.removable ? ' (removable)' : ''} · {device.partitionStyle} · {device.partitions} partition{device.partitions === 1 ? '' : 's'}{device.offline ? ' · offline' : ''} · {device.readOnly ? 'read-only' : 'write protection unknown'}</small></span><CheckCircle2 size={16} /></button>)}</div>}{selectedDevice && <div className="source-facts"><span>Selected source<strong>{selectedDevice.driveLetters.length ? `${selectedDevice.driveLetters.join(' ')} · ` : ''}{selectedDevice.label}</strong></span><span>Capacity<strong>{selectedSize}</strong></span><span>Write mode<strong>Blocked</strong></span></div>}{selectedDevice && <div className="actions"><button className="secondary" onClick={() => void readCatalog({ kind: 'device', id: selectedDevice.id, sizeBytes: selectedDevice.sizeBytes })} disabled={catalogBusy || stage === 'cloning'}><Clapperboard size={16} /> {catalogBusy && catalogSource?.kind === 'device' ? 'Reading card...' : 'List recordings directly from card'}</button><button className="secondary" onClick={() => void probeDevice(selectedDevice)} disabled={probing || catalogBusy}><Search size={16} /> {probing ? 'Probing...' : 'Probe first sectors'}</button><small className="muted">Read-only, no clone. This is the normal path: list what the card holds, then send or extract the recordings you need.</small></div>}{probe && <div className="probe"><strong>Card probe · {probe.id} · {formatBytes(probe.sizeBytes)}</strong><dl><div><dt>DHFS volume</dt><dd>{probe.dhfsLocation ?? probe.dhfsError ?? '—'}</dd></div>{!probe.sector0Hex ? <div><dt>Sectors</dt><dd>not read — the disk could not be opened, so nothing below was checked</dd></div> : <><div><dt>DHFS4.1 at sector 0</dt><dd>{probe.dhfsMagicAtZero ? 'yes' : probe.dhfsLocation ? 'no — expected: this card carries a partition table and the volume was found through it' : 'no'}</dd></div><div><dt>DHFS_DPT marker</dt><dd>{probe.dhfsDptMarkerWithinFirstMib === null ? (probe.dhfsLocation ? 'not in first MiB — not needed, located via the partition table' : 'not in first MiB') : `byte ${probe.dhfsDptMarkerWithinFirstMib.toLocaleString()}`}</dd></div><div><dt>MBR</dt><dd>{probe.mbrSignature ? (probe.mbrPartitions.length ? probe.mbrPartitions.join('; ') : 'signature present, no partition entries') : 'no MBR signature (superfloppy / raw)'}</dd></div><div><dt>Sector 0 (first 64 bytes)</dt><dd className="mono">{probe.sector0Hex}<br />{probe.sector0Ascii}</dd></div></>}</dl><small className="muted">{probe.dhfsLocation ? 'The card is recognised. Use “List recordings directly from card” to see what it holds.' : 'Copy this block into a support message if the card is not recognised.'}</small></div>}</section>
        <section className="panel recordings-panel"><div className="panel-heading"><div><span className="eyebrow">02 / Recordings</span><h2>What the card holds</h2></div><Clapperboard size={19} /></div>
          {!catalog && <p className="muted">{catalogBusy ? 'Reading the partition table, superblock and fragment descriptors...' : 'Pick the card above and choose “List recordings directly from card”. Recordings are listed by day; nothing is copied until you send or extract one.'}</p>}
          {catalog && catalogPartition && <>
            <div className="facts"><span>Source<strong>{sourceLabel(catalogSource)}</strong></span><span>Recordings<strong>{catalog.recordings.length} · {formatBytes(totalRecordingBytes)}</strong></span><span>Layout<strong>{formatBytes(catalogPartition.fragmentSize)} fragments · {catalogPartition.descriptorCount.toLocaleString()} descriptors</strong></span></div>
            <p className="muted small">Volume at byte {catalog.volume.location.baseOffset.toLocaleString()} ({locationLabel(catalog.volume)}). {catalog.volume.tableNote}{catalog.skippedDescriptors ? ` ${catalog.skippedDescriptors} untrustworthy descriptor${catalog.skippedDescriptors === 1 ? '' : 's'} skipped, not silently included.` : ''}</p>
            <div className="actions">{importRow && <button className="primary" onClick={() => void sendAll()} disabled={Boolean(extracting) || sendingKey !== null || unsentRecordings.length === 0}><UploadCloud size={15} /> {unsentRecordings.length === 0 ? (skippedCount ? `Nothing left to send (${skippedCount} skipped)` : 'All recordings sent') : `Send all ${unsentRecordings.length} to FCM${skippedCount ? ` (${skippedCount} skipped)` : ''}`}</button>}{queueRemaining > 0 && <button className="secondary" onClick={() => void stopQueue()}>Stop sending ({queueRemaining} left)</button>}<button className="secondary" onClick={() => void chooseDestination()} disabled={sendingKey !== null}><FolderOpen size={15} /> {destinationDirectory ? 'Change working folder' : 'Choose working folder'}</button><small className="muted mono">{destinationDirectory ?? 'Working folder: Public Documents\\fcm-acquisitions, chosen automatically'}</small></div>
            {!importRow && <p className="muted small">{fcmSession ? 'Create the import under “Send to FCM” to send recordings straight from the card. “Preview” shows what a recording holds on this computer first; “Extract” alone writes a hashed copy to the working folder.' : 'Sign in under “Send to FCM” to send recordings straight from the card. “Preview” shows what a recording holds on this computer first; “Extract” writes a hashed copy to the working folder.'}</p>}
            {sentCount > 0 && <p className="muted small">{sentCount} recording{sentCount === 1 ? '' : 's'} sent to FCM: video with the SHA-256 taken as it left the card (the analysis worker re-hashes on intake), pictures as dated timeline events. Copies stay in {destinationDirectory ?? 'the working folder'}.</p>}
            <p className="muted small">Sizes listed below are what the card reserves for a recording; what is actually sent is only the frames the camera dated inside it — a previous occupant's leftovers and the card's own bookkeeping are left behind.</p>
            {catalog.recordings.length === 0 && <p className="muted">The volume is intact but holds no trustworthy recordings.</p>}
            <div className="recording-days">{recordingDays.map(([day, recordings]) => <div className="recording-day" key={day}><div className="recording-day__head"><strong>{day}</strong><small>{recordings.length} recording{recordings.length === 1 ? '' : 's'} · {formatBytes(recordings.reduce((sum, recording) => sum + recording.bytes, 0))}</small></div>
              {recordings.map((recording) => { const key = recordingKey(recording); const clip = clips[key]; const send = sends[key]; const reviewState = reviews[key]; const isSkipped = Boolean(skipped[key]); const isOpen = openReview === key; const inFlight = send && send.status !== 'done' && send.status !== 'failed'; return <Fragment key={key}><div className={`recording ${clip ? 'is-extracted' : ''} ${send?.status === 'done' ? 'is-sent' : ''} ${isSkipped ? 'is-skipped' : ''}`}><span className="recording__time">{formatClock(recording.start)}</span><span className="recording__meta"><strong>Channel {recording.channel} · {formatDuration(recording.durationSeconds)}</strong><small>to {formatClock(recording.end)} · {formatBytes(recording.bytes)} · {recording.fragmentCount} fragment{recording.fragmentCount === 1 ? '' : 's'} · descriptor {recording.descriptor}</small>{clip && <small className="mono">{clip.kind === 'pictures' ? clip.fileName : clip.fileName} · {describeClip(clip)} · SHA-256 {clip.sha256.slice(0, 16)}…</small>}{isSkipped && send?.status !== 'done' && <small className="send-state send-state--skipped">Skipped by you — left out of “Send all”; still on the card{clip ? ' and in the working folder' : ''}.</small>}{inFlight && <div className={`progress recording__progress ${send.status === 'uploading' ? '' : 'is-indeterminate'}`} role="progressbar" aria-busy={send.status !== 'uploading'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={send.total ? Math.floor((send.sent / send.total) * 100) : 0}><div style={send.status === 'uploading' ? { width: `${send.total ? Math.min(100, (send.sent / send.total) * 100) : 0}%` } : undefined} /></div>}{send && <small className={`send-state send-state--${send.status}`}>{sendLabel[send.status]}{send.status === 'uploading' && send.total ? (clip?.kind === 'pictures' ? ` picture ${send.sent} of ${send.total}` : ` ${formatBytes(send.sent)} of ${formatBytes(send.total)}`) : ''}{send.error ? ` — ${send.error}` : ''}</small>}</span><span className="recording__actions"><button className="secondary" onClick={() => { if (isOpen) setOpenReview(null); else void review(recording); }} disabled={Boolean(extracting) || sendingKey !== null || reviewState?.busy === 'filmstrip'}><Film size={14} /> {reviewState?.busy === 'filmstrip' ? 'Decoding…' : isOpen ? 'Close preview' : reviewState?.filmstrip ? 'Show preview' : 'Preview'}</button>{importRow && <button className="primary" onClick={() => void sendOne(recording)} disabled={Boolean(extracting) || sendingKey !== null || send?.status === 'done'}><Send size={14} /> {send?.status === 'done' ? 'Sent' : sendingKey === key && send ? sendLabel[send.status] : send?.status === 'failed' ? 'Send again' : clip?.kind === 'pictures' ? 'Send pictures to FCM' : 'Send to FCM'}</button>}<button className="secondary" onClick={() => void extract(recording)} disabled={Boolean(extracting) || sendingKey !== null}><Download size={14} /> {extracting === key ? 'Extracting...' : clip ? 'Extract again' : importRow ? 'Extract only' : 'Extract'}</button></span></div>
              {isOpen && <div className="review" role="region" aria-label={`Review of channel ${recording.channel} at ${formatClock(recording.start)}`}>
                <div className="review__head"><strong>{clip ? `${clip.fileName} · ${describeClip(clip)}` : 'Reading from the card…'}</strong><small>{reviewState?.filmstrip ? `${reviewState.filmstrip.frames.length} key frames, every ${reviewState.filmstrip.keyFramesUsed === 1 ? 'one' : `${reviewState.filmstrip.keyFramesUsed}th`} · times are the camera clock` : reviewState?.busy === 'filmstrip' ? 'Decoding key frames on this computer…' : ''}</small></div>
                {reviewState?.busy === 'filmstrip' && <div className="progress is-indeterminate" role="progressbar" aria-busy="true"><div /></div>}
                {reviewState?.filmstrip && clip && <div className="filmstrip">{reviewState.filmstrip.frames.map((frame, index) => <figure key={`${key}:${index}`}><img src={`data:image/jpeg;base64,${frame.jpegBase64}`} alt={`Key frame ${index + 1} at ${clockPlus(clip.stats.contentStart ?? clip.start, frame.atSeconds)}`} /><figcaption>{clockPlus(clip.stats.contentStart ?? clip.start, frame.atSeconds)}</figcaption></figure>)}</div>}
                {reviewState?.preview && <video controls preload="metadata" src={convertFileSrc(reviewState.preview.path)} />}
                {reviewState?.busy === 'preview' && <div className="progress is-indeterminate" role="progressbar" aria-busy="true"><div /></div>}
                {reviewState?.error && <p className="review__error">{reviewState.error}</p>}
                <div className="review__actions">
                  {clip && clip.kind !== 'pictures' && !reviewState?.preview && <button className="secondary" onClick={() => void playPreview(recording)} disabled={reviewState?.busy !== null && reviewState?.busy !== undefined}><Play size={14} /> {reviewState?.busy === 'preview' ? 'Rendering 480p copy…' : 'Play preview (480p, rendered here)'}</button>}
                  {importRow ? <button className="primary" onClick={() => void sendOne(recording)} disabled={Boolean(extracting) || sendingKey !== null || send?.status === 'done'}><Send size={14} /> {send?.status === 'done' ? 'Sent to FCM' : 'Send this recording to FCM'}</button> : <small>{fcmSession ? 'Create the import under “Send to FCM” to send this recording.' : 'Sign in under “Send to FCM” to send this recording.'}</small>}
                  {send?.status !== 'done' && <button className="secondary" onClick={() => toggleSkip(recording)}>{isSkipped ? <><Undo2 size={14} /> Include again</> : <><EyeOff size={14} /> Skip — do not send</>}</button>}
                  {reviewState?.preview && <small>{encoderLabel(reviewState.preview)} · {formatBytes(reviewState.preview.bytes)} · viewing copy only, never sent</small>}
                </div>
              </div>}</Fragment>; })}
            </div>)}</div>
            {catalog.warnings.length > 0 && <details className="warnings"><summary>{catalog.warnings.length} descriptor warning{catalog.warnings.length === 1 ? '' : 's'}</summary><ul>{catalog.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></details>}
          </>}
        </section>
        <section className="panel review-panel"><div className="panel-heading"><div><span className="eyebrow">03 / Review here</span><h2>See it before it leaves this computer</h2></div><Cpu size={19} /></div>
          <p className="muted">“Preview” on a recording decodes its key frames and, on request, a 480p viewing copy — on this computer, using the GPU when there is one. The card is only read; viewing copies live under this app's local data and are never sent or treated as evidence. Sending is unchanged: the extracted original goes to FCM with the SHA-256 taken from the card.</p>
          <div className="facts"><span>Decoder<strong>{decoder ? (decoder.installed ? `FFmpeg ${decoder.version} · hash verified` : decoder.rejectedReason ? 'present but rejected' : 'not installed') : decoderError ? 'status unavailable' : 'checking…'}</strong></span><span>Viewing copies<strong>{previewCount} this session</strong></span><span>Skipped<strong>{skippedCount} recording{skippedCount === 1 ? '' : 's'}</strong></span></div>
          {decoder && !decoder.installed && <>
            <p className="muted small">The decoder is a one-time download ({formatBytes(decoder.downloadBytes)}) of a pinned FFmpeg build. FCM checks its SHA-256 against a value compiled into this app and refuses anything else, including a build that has been swapped on disk later.{decoder.rejectedReason ? ` Currently: ${decoder.rejectedReason}.` : ''}</p>
            <div className="actions"><button className="primary" onClick={() => void installDecoder()} disabled={decoderBusy}><Download size={15} /> {decoderBusy ? 'Downloading and verifying…' : decoder.rejectedReason ? 'Install the decoder again' : 'Install decoder'}</button>{decoderProgress && <small className="muted">{formatBytes(decoderProgress.bytesDone)} of {formatBytes(decoderProgress.totalBytes || decoder.downloadBytes)}</small>}</div>
            {decoderBusy && <div className={`progress decoder-progress ${decoderProgress && decoderProgress.bytesDone > 0 ? '' : 'is-indeterminate'}`} role="progressbar" aria-busy={!decoderProgress || decoderProgress.bytesDone === 0} aria-valuemin={0} aria-valuemax={100} aria-valuenow={decoderProgress && decoderProgress.totalBytes ? Math.floor((decoderProgress.bytesDone / decoderProgress.totalBytes) * 100) : 0}><div style={decoderProgress && decoderProgress.bytesDone > 0 && decoderProgress.totalBytes ? { width: `${Math.min(100, (decoderProgress.bytesDone / decoderProgress.totalBytes) * 100)}%` } : undefined} /></div>}
          </>}
          {decoder?.installed && <div className="actions"><button className="secondary" onClick={() => void clearPreviews()} disabled={Object.values(reviews).some((review) => review.busy !== null)}><Trash2 size={15} /> Remove viewing copies</button><small className="muted">Frees disk under this app's local data. Extracted originals in the working folder and the card are untouched.</small></div>}
          {decoder && <p className="muted small">{decoder.licence}. The licence text ships with the download: <span className="mono">{decoder.licenceUrl}</span></p>}
          {decoderError && <p className="review__error">{decoderError}</p>}
        </section>
        <section className="panel send-panel"><div className="panel-heading"><div><span className="eyebrow">04 / Send to FCM</span><h2>{importRow ? 'Import ready' : fcmSession ? 'Where does this footage belong?' : 'Sign in to FCM'}</h2></div><Send size={19} /></div>
          {!fcmSession && <>
            <p className="muted">Use your FCM login. Recordings are sent under your own account and organisation, exactly as if you had imported them in the web app; nothing about the login is kept on this computer.</p>
            <form className="fcm-form" onSubmit={(event) => { event.preventDefault(); void signIn(); }}>
              <label className="field"><span>Email</span><input type="email" autoComplete="username" value={fcmEmail} onChange={(event) => setFcmEmail(event.target.value)} disabled={fcmBusy} /></label>
              <label className="field"><span>Password</span><input type="password" autoComplete="current-password" value={fcmPassword} onChange={(event) => setFcmPassword(event.target.value)} disabled={fcmBusy} /></label>
              <button className="primary" type="submit" disabled={fcmBusy}><LogIn size={15} /> {fcmBusy ? 'Signing in…' : 'Sign in to FCM'}</button>
            </form>
          </>}
          {fcmSession && <div className="signed-in"><span><strong>{fcmProfile?.displayName ?? fcmSession.user.email}</strong><small>{organizations.find((organization) => organization.organizationId === organizationId)?.organizationName ?? 'organisation not set'}</small></span><button className="secondary" onClick={() => void signOut()} disabled={sendingKey !== null}><LogOut size={14} /> Sign out</button></div>}
          {fcmSession && !importRow && <>
            {organizations.length > 1 && <label className="field"><span>Organisation</span><select value={organizationId ?? ''} onChange={(event) => { setOrganizationId(event.target.value || null); setHouseId(null); }}>{organizations.map((organization) => <option key={organization.organizationId} value={organization.organizationId}>{organization.organizationName}</option>)}</select></label>}
            <label className="field"><span>Place the camera watches</span><input type="search" placeholder="Search by name or address" value={houseQuery} onChange={(event) => setHouseQuery(event.target.value)} /></label>
            <div className="house-list">{visibleHouses.map((house) => <button key={house.id} type="button" className={`device ${houseId === house.id ? 'is-selected' : ''}`} onClick={() => setHouseId(house.id)}><span className="device-icon"><MapPin size={16} /></span><span><strong>{house.name}</strong><small>{house.address ?? 'no address recorded'}</small></span><CheckCircle2 size={16} /></button>)}{visibleHouses.length === 0 && <p className="muted small">{houses.length ? 'No place matches that search.' : 'No places are visible to your account yet. Add the place in FCM first; cameras carry no GPS.'}</p>}</div>
            <div className="field-row"><label className="field"><span>Camera label</span><input type="text" placeholder="e.g. Gate cam 1" value={cameraLabel} onChange={(event) => setCameraLabel(event.target.value)} maxLength={120} /></label><label className="field"><span>Camera clock time zone</span><input type="text" value={timeZone} onChange={(event) => setTimeZone(event.target.value)} className={isValidTimeZone(timeZone) ? '' : 'is-invalid'} /></label></div>
            <label className="field"><span>Notes (optional)</span><input type="text" value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={500} /></label>
            <div className="actions"><button className="primary" onClick={() => void createImport()} disabled={fcmBusy || !houseId || !cameraLabel.trim()}><MapPin size={15} /> {fcmBusy ? 'Creating…' : 'Create import for this card'}</button><small className="muted">Times on the card are the camera's wall clock; the time zone turns them into real instants.</small></div>
          </>}
          {importRow && <>
            <div className="facts"><span>Camera<strong>{importRow.camera_label}</strong></span><span>Place<strong>{selectedHouse?.name ?? 'chosen place'}</strong></span><span>Sent<strong>{sentCount} of {catalog?.recordings.length ?? 0}</strong></span></div>
            <p className="muted small">Import {importRow.id.slice(0, 8)}… Recordings sent here appear in FCM → CCTV review under this camera at {selectedHouse?.name ?? 'the chosen place'}, each carrying the SHA-256 taken as it left the card.</p>
            <div className="actions"><button className="secondary" onClick={() => { setImportRow(null); setSends({}); doneClipsRef.current = {}; }} disabled={sendingKey !== null}>Start another import</button></div>
          </>}
        </section>
        <section className="panel acquire-panel"><div className="panel-heading"><div><span className="eyebrow">05 / Optional</span><h2>Exact image of the whole card</h2></div><LockKeyhole size={19} /></div><p className="muted">Not needed to send recordings. An exact image is a forensic bit-for-bit copy of the <em>entire</em> card, empty space included, for when the card itself must be handed back or overwritten and you still need to prove nothing changed.{selectedDevice ? ` This ${formatBytes(selectedDevice.sizeBytes)} card needs the same free space on the destination drive and roughly ${estimateCloneMinutes(selectedDevice.sizeBytes)} minutes to clone over USB, then as long again to verify.` : ''}</p><div className="actions"><button className="primary" onClick={() => void acquire()} disabled={!selectedDevice || stage === 'cloning' || stage === 'verifying'}><Square size={15} /> {stage === 'cloning' ? 'Cloning...' : stage === 'verifying' ? 'Verifying...' : 'Acquire exact image'}</button>{(stage === 'cloning' || stage === 'verifying') && <button className="secondary" onClick={() => void cancelAcquisition()} disabled={cancelling || stage === 'verifying'}>{cancelling ? 'Cancelling...' : 'Cancel'}</button>}</div><div className={`status-card status-${stage}`}><span>{stageLabel[stage]}</span><strong>{receipt ? `${formatBytes(receipt.bytesCopied)} copied` : progress ? `${formatBytes(progress.bytesDone)} of ${formatBytes(progress.totalBytes)} · ${progress.totalBytes ? Math.floor((progress.bytesDone / progress.totalBytes) * 100) : 0}%` : stage === 'cloning' ? 'Starting: opening the card read-only and writing the first blocks…' : stage === 'failed' ? (error ?? 'The last acquisition did not complete.') : 'No image acquired yet — not needed to work from the card'}</strong>{stage === 'cloning' && !progress && <div className="progress is-indeterminate" role="progressbar" aria-busy="true"><div /></div>}{progress && (stage === 'cloning' || stage === 'verifying') && <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.totalBytes ? Math.floor((progress.bytesDone / progress.totalBytes) * 100) : 0}><div style={{ width: `${progress.totalBytes ? Math.min(100, (progress.bytesDone / progress.totalBytes) * 100) : 0}%` }} /></div>}{progress && (stage === 'cloning' || stage === 'verifying') && <small className="mono">{progress.stage} · {formatRate(progress.bytesPerSecond)} · elapsed {formatDuration(progress.elapsedSeconds)} · remaining {progress.etaSeconds === null ? '—' : formatDuration(progress.etaSeconds)}</small>}<small>{status}</small></div>{receipt && <div className="receipt"><div><CheckCircle2 size={17} /><strong>Hash verification {receipt.verified ? 'passed' : 'needs review'}</strong></div><dl><div><dt>Source SHA-256</dt><dd>{receipt.sourceSha256}</dd></div><div><dt>Image SHA-256</dt><dd>{receipt.imageSha256}</dd></div><div><dt>Read errors</dt><dd>{receipt.readErrors}</dd></div></dl></div>}</section>
        <section className="panel inspect-panel"><div className="panel-heading"><div><span className="eyebrow">06 / Image inspection</span><h2>Virtual image inspection</h2></div><Search size={19} /></div><p className="muted">Only for an acquired image: run several adapters against the clone. Unknown layouts are preserved as investigation candidates instead of rejected.</p><button className="secondary" onClick={() => void inspectImage()} disabled={!receipt || decoderStage === 'scanning'}><Search size={16} /> {decoderStage === 'scanning' ? 'Inspecting...' : 'Inspect image and map partitions'}</button>{inspection && <div className="inspection"><div className="facts"><span>Image<strong>{formatBytes(inspection.imageBytes)}</strong></span><span>Signatures<strong>{inspection.signatures.length}</strong></span><span>DHFS<strong>{inspection.dhfs ? locationLabel(inspection.dhfs) : 'not found'}</strong></span></div><div className="signature-list">{inspection.signatures.map((signature) => <span key={signature}>{signature}</span>)}</div>{inspection.adapters.map((adapter) => <div className="adapter" key={adapter.name}><span className={`dot dot-${adapter.state}`} /><div><strong>{adapter.name}</strong><small>{adapter.detail}</small></div><em>{adapter.confidence}</em></div>)}</div>}</section>
      </div>
      {error && <div className="error"><strong>Action blocked</strong><span>{error}</span></div>}
      <footer><span><ShieldCheck size={14} /> Recordings leave the card hashed; FCM re-hashes them on intake.</span><span>v{APP_VERSION} · {fcmSession ? `signed in as ${fcmProfile?.displayName ?? fcmSession.user.email}` : 'not signed in'} · {stageLabel[stage]}{catalog ? ` · ${catalog.recordings.length} recordings` : ''}{sentCount ? ` · ${sentCount} sent` : ''}</span></footer>
    </section>
  </main>;
}

// The earlier prototype exported App without ever mounting it, so the installed window rendered blank.
const root = document.getElementById('root');
if (root) createRoot(root).render(<StrictMode><App /></StrictMode>);
