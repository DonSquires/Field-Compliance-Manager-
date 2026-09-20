import { Fragment, StrictMode, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ask, open, save } from '@tauri-apps/plugin-dialog';
import { createClient, type Session } from '@supabase/supabase-js';
import { Activity, CheckCircle2, ChevronRight, Clapperboard, Cpu, Download, ExternalLink, EyeOff, Film, FolderOpen, HardDrive, LockKeyhole, LogIn, LogOut, MapPin, Play, Search, Send, ShieldCheck, Square, Trash2, Undo2, UploadCloud, Waves } from 'lucide-react';
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

type ContentKind = 'dhav_video' | 'pictures' | 'raw_stream' | 'local_video';

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
type ReviewState = { busy: 'filmstrip' | 'preview' | null; filmstrip?: Filmstrip; preview?: PreviewRendition; error?: string; note?: string };
type Mp4Mode = 'stream_copy' | { h264: 'nvenc' | 'software' };
type Mp4Export = { path: string; bytes: number; mode: Mp4Mode | null; seconds: number; existing: boolean };
/** Where the operator chose to save a recording this session; shown on the row so it is not saved twice by accident. */
type SavedCopy = { directory: string; fileName: string; mp4: Mp4Export | null };

// Video files already on this computer (or in a synced cloud folder): the second source besides the card.
type LocalVideoFile = { path: string; fileName: string; extension: string; bytes: number; modifiedEpochMs: number };
type VideoFolder = { directory: string; files: LocalVideoFile[]; subfolders: number; otherFiles: number; picked: boolean };
type MediaProbe = { durationSeconds: number | null; creationTime: string | null; codec: string | null; width: number | null; height: number | null };
/** Where a file's recorded start came from; every option is shown to the operator, who can overrule it. */
type ClockSource = 'file_name' | 'file_metadata' | 'modified_time' | 'operator';
type FileClock = { start: DhfsTime; source: ClockSource };
type FileFacts = { sha256: string; bytes: number; probe: MediaProbe | null };
type SourceMode = 'card' | 'files';
/** One thing the operator can preview, send or skip: a recording on the card or a video file in a folder. */
type SourceItem = { kind: 'card'; key: string; recording: DhfsRecording } | { kind: 'file'; key: string; file: LocalVideoFile };

// The operator's verdict on a recording, colour-coded so the list reads at a glance. Marks are the operator's
// working notes, kept on this computer per card/folder; they travel to FCM only as manifest provenance.
type ReviewMark = 'keep' | 'review_further' | 'reviewed' | 'nothing_here';
const MARKS: Array<{ id: ReviewMark; label: string; hint: string }> = [
  { id: 'keep', label: 'Keep', hint: 'Worth sending: send it, or leave it marked so it is not missed.' },
  { id: 'review_further', label: 'Review further', hint: 'Not decided yet: come back to this one.' },
  { id: 'reviewed', label: 'Reviewed', hint: 'Looked at, no further action needed here.' },
  { id: 'nothing_here', label: 'Nothing here', hint: 'Seen, nothing of interest; left out of “Send all”.' },
];
const markLabel = (mark: ReviewMark) => MARKS.find((candidate) => candidate.id === mark)?.label ?? mark;
/** Which recordings “Send all” takes: not sent yet, not skipped, and not marked as nothing / already reviewed. */
const excludedFromSendAll = (mark: ReviewMark | undefined) => mark === 'nothing_here' || mark === 'reviewed';

/** Where one recording was made. A portable covert camera moves between places; the client organisation does not. */
type PlaceChoice = { houseId: string; cameraLabel: string };
/** A send that completed: FCM holds the bytes under this path with the hash taken here. Kept so a restart still knows. */
type SentRecord = { importId: string; storagePath: string; fileName: string; sentAt: string; bytes: number };
type ReviewFile = { version: 1; marks: Record<string, ReviewMark>; places: Record<string, PlaceChoice>; sent: Record<string, SentRecord>; savedAt: string };
const placeKeyOf = (place: PlaceChoice) => `${place.houseId}::${place.cameraLabel.trim().toLowerCase()}`;
/** Six-digit descriptor and the camera's file stamp, exactly as the extractor names files: `-p0-d000722-2026-08-11_14-14-53-`. */
const fileStamp = (time: DhfsTime) => `${time.year}-${pad(time.month)}-${pad(time.day)}_${pad(time.hour)}-${pad(time.minute)}-${pad(time.second)}`;
const recordingStemMarker = (recording: DhfsRecording) => `-p${recording.partitionIndex}-d${String(recording.descriptor).padStart(6, '0')}-${fileStamp(recording.start)}-`;

// Disk on this computer: what the app wrote and what may be removed.
type DiskEntry = { path: string; name: string; bytes: number; kind: 'video' | 'pictures' | 'partial' | 'mp4' | 'image' | 'other'; modifiedEpochMs: number };
type DiskReport = { directory: string; entries: DiskEntry[]; totalBytes: number; previewsDirectory: string; previewsBytes: number; previewsCount: number; toolsBytes: number; acquisitionsRoot: string; otherCardsBytes: number; otherCardsFolders: number };
type RemovalReport = { removed: number; freedBytes: number; failures: Array<{ path: string; error: string }> };
type FcmVerification = 'verified' | 'pending' | 'mismatch' | 'unknown';

// The pop-out preview is this same bundle in a second window (`?popout=1`). The workstation window owns every
// decision; the pop-out shows what it is told and sends the operator's choice back as an event.
const POPOUT_LABEL = 'preview';
const POPOUT_STATE_EVENT = 'preview-popout-state';
const POPOUT_ACTION_EVENT = 'preview-popout-action';
const POPOUT_READY_EVENT = 'preview-popout-ready';
type PopoutState = {
  title: string; subtitle: string; itemKey: string; sourceKind: 'card' | 'file';
  filmstrip: Filmstrip | null; clockBase: DhfsTime | null; clipKind: ContentKind | null;
  preview: PreviewRendition | null; busy: 'filmstrip' | 'preview' | null; note: string | null; error: string | null;
  canSend: boolean; sendStatus: SendStatus | null; skipped: boolean; sendHint: string | null;
  mark: ReviewMark | null; placeName: string | null;
};
type PopoutAction = { itemKey: string; action: 'play' | 'send' | 'skip' | 'include' | 'close' } | { itemKey: string; action: 'mark'; mark: ReviewMark | null };
const IS_POPOUT = new URLSearchParams(window.location.search).get('popout') === '1';

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
const sendLabel: Record<SendStatus, string> = { extracting: 'Preparing…', uploading: 'Sending…', registering: 'Registering…', done: 'Sent to FCM', failed: 'Send failed' };
/** What an extraction actually held, in the operator's terms; the descriptor's byte count is not the recording. */
const describeClip = (clip: ExtractedClip) => {
  const s = clip.stats;
  const span = s.contentStart && s.contentEnd ? `${formatClock(s.contentStart)}–${formatClock(s.contentEnd)}` : null;
  const skipped = s.staleBytes + s.unstructuredBytes + s.structuralBytesRemoved;
  const codec = clip.codec.replace('dhav/', '');
  const codecLabel = codec === 'unknown' ? 'video (codec not declared)' : `${codec.toUpperCase()} video`;
  const parts: string[] = [];
  if (clip.kind === 'pictures') parts.push(`${s.pictures} event picture${s.pictures === 1 ? '' : 's'}`);
  else if (clip.kind === 'local_video') parts.push(`${codecLabel} · ${formatDuration(clip.durationSeconds)}`);
  else if (clip.kind === 'dhav_video') parts.push(`${codecLabel} · ${s.videoFrames.toLocaleString()} frames`);
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
const mp4Label = (mp4: Mp4Export) => (mp4.existing ? 'MP4 already in that folder, kept' : mp4.mode === 'stream_copy' ? 'MP4 with the original frames (no re-encoding)' : mp4.mode && typeof mp4.mode === 'object' ? `H.264 MP4 re-encoded ${mp4.mode.h264 === 'nvenc' ? 'on the GPU' : 'in software'} so it plays anywhere` : 'MP4');
/** The camera's wall clock `seconds` after `time`, as a clock value. */
const clockAdd = (time: DhfsTime, seconds: number): DhfsTime => {
  const at = new Date(Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second) + Math.round(seconds) * 1000);
  return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate(), hour: at.getUTCHours(), minute: at.getUTCMinutes(), second: at.getUTCSeconds() };
};
const clockSeconds = (time: DhfsTime) => Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second) / 1000;
const VIDEO_FILE_EXTENSIONS = ['mp4', 'mov', 'mkv', 'avi', 'm4v', 'ts', 'h264', 'h265', 'hevc', '264', '265', 'dav', 'asf', 'wmv', 'webm'];
/** An instant (ISO 8601 or epoch ms) as the camera's wall clock in `timeZone`. */
const instantToWallClock = (instant: string | number, timeZone: string): DhfsTime | null => {
  const ms = typeof instant === 'number' ? instant : Date.parse(instant);
  if (!Number.isFinite(ms) || !isValidTimeZone(timeZone)) return null;
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second) };
};
/** A recorder's own clock written into the file name (TAPO `20260911_143156_tp…`, Dahua/FCM `2026-07-24_09-30-00`, Reolink, Hikvision…). */
const parseFileNameClock = (name: string): DhfsTime | null => {
  const match = /(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})[_\-T ]?(\d{2})[-_:.]?(\d{2})[-_:.]?(\d{2})/.exec(name);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  return { year, month, day, hour, minute, second };
};
const clockToInputValue = (time: DhfsTime) => `${time.year}-${pad(time.month)}-${pad(time.day)}T${pad(time.hour)}:${pad(time.minute)}:${pad(time.second)}`;
const inputValueToClock = (value: string): DhfsTime | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), hour: Number(match[4]), minute: Number(match[5]), second: Number(match[6] ?? 0) };
};
const clockSourceLabel: Record<ClockSource, string> = { file_name: 'from the file name', file_metadata: 'from the file’s own metadata', modified_time: 'estimated from when the file was last written', operator: 'set by you' };
const CONTENT_TYPES: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm', avi: 'video/x-msvideo', ts: 'video/mp2t', asf: 'video/x-ms-asf', wmv: 'video/x-ms-asf', dav: 'video/x-dahua-dav', h264: 'video/h264', '264': 'video/h264', h265: 'video/h265', '265': 'video/h265', hevc: 'video/h265' };
const contentTypeFor = (extension: string) => CONTENT_TYPES[extension.toLowerCase()] ?? 'application/octet-stream';
const fileKey = (file: LocalVideoFile) => `file:${file.path}`;
const formatWhen = (epochMs: number) => (epochMs ? new Date(epochMs).toLocaleString() : '—');
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

/** The mark picker: one row of colour-coded choices; clicking the active one clears it. */
function MarkPicker({ value, onChange, compact }: { value: ReviewMark | null; onChange: (mark: ReviewMark | null) => void; compact?: boolean }) {
  return <div className={`marks ${compact ? 'marks--compact' : ''}`} role="group" aria-label="Review mark">{MARKS.map((mark) => <button key={mark.id} type="button" className={`mark mark--${mark.id} ${value === mark.id ? 'is-active' : ''}`} title={mark.hint} aria-pressed={value === mark.id} onClick={() => onChange(value === mark.id ? null : mark.id)}><span className="mark__dot" />{compact ? '' : mark.label}</button>)}</div>;
}

/** The pop-out window: a viewer for whatever the workstation is reviewing, sized for a second screen. */
function PopoutViewer() {
  const [state, setState] = useState<PopoutState | null>(null);
  useEffect(() => {
    const pending = listen<PopoutState>(POPOUT_STATE_EVENT, (event) => setState(event.payload));
    // Ask the workstation for the current review once the listener is in place; it re-sends on every change.
    void emitTo('main', POPOUT_READY_EVENT, {});
    return () => { void pending.then((unlisten) => unlisten()); };
  }, []);
  const act = (action: Exclude<PopoutAction, { action: 'mark' }>['action']) => { if (state) void emitTo('main', POPOUT_ACTION_EVENT, { itemKey: state.itemKey, action } satisfies PopoutAction); };
  const mark = (value: ReviewMark | null) => { if (state) void emitTo('main', POPOUT_ACTION_EVENT, { itemKey: state.itemKey, action: 'mark', mark: value } satisfies PopoutAction); };
  const frames = state?.filmstrip?.frames ?? [];
  const clockBase = state?.clockBase ?? null;
  return <main className="popout">
    <header className="popout__head"><div><span className="eyebrow">Preview · FCM Desktop V2 v{APP_VERSION}</span><h1>{state?.title ?? 'Waiting for the workstation…'}</h1><p>{state?.subtitle ?? 'Choose “Preview” on a recording in the main window; it appears here.'}</p>{state?.placeName && <p className="popout__place"><MapPin size={12} /> {state.placeName}</p>}</div><button className="secondary" onClick={() => void getCurrentWindow().close()}>Close</button></header>
    {state && <>
      {state.preview
        ? <video key={state.preview.path} className="popout__video" controls autoPlay preload="metadata" src={convertFileSrc(state.preview.path)} />
        : <div className="popout__stage">{state.busy === 'preview' ? <><div className="progress is-indeterminate" role="progressbar" aria-busy="true"><div /></div><p className="muted">Rendering the 480p viewing copy on this computer…</p></> : state.busy === 'filmstrip' ? <><div className="progress is-indeterminate" role="progressbar" aria-busy="true"><div /></div><p className="muted">{state.clipKind === 'pictures' ? 'Reading the pictures…' : 'Decoding key frames…'}</p></> : state.clipKind === 'pictures' ? <p className="muted">A picture stream: the pictures below are the recording.</p> : frames.length ? <button className="primary popout__play" onClick={() => act('play')}><Play size={18} /> Play preview (480p, rendered here)</button> : <p className="muted">{state.error ?? 'Nothing decoded yet.'}</p>}</div>}
      {frames.length > 0 && clockBase && <div className="filmstrip popout__filmstrip">{frames.map((frame, index) => <figure key={`${state.itemKey}:${index}`}><img src={`data:image/jpeg;base64,${frame.jpegBase64}`} alt={`Key frame ${index + 1} at ${clockPlus(clockBase, frame.atSeconds)}`} /><figcaption>{clockPlus(clockBase, frame.atSeconds)}</figcaption></figure>)}</div>}
      {state.note && <p className="review__note">{state.note}</p>}
      {state.error && <p className="review__error">{state.error}</p>}
      <footer className="popout__actions">
        <MarkPicker value={state.mark} onChange={mark} />
        {state.canSend ? <button className="primary" onClick={() => act('send')} disabled={state.sendStatus === 'done' || (state.sendStatus !== null && state.sendStatus !== 'failed')}><Send size={15} /> {state.sendStatus === 'done' ? 'Sent to FCM' : state.sendStatus && state.sendStatus !== 'failed' ? sendLabel[state.sendStatus] : 'Send this recording to FCM'}</button> : <small className="muted">{state.sendHint}</small>}
        {state.sendStatus !== 'done' && <button className="secondary" onClick={() => act(state.skipped ? 'include' : 'skip')}>{state.skipped ? <><Undo2 size={15} /> Include again</> : <><EyeOff size={15} /> Skip — do not send</>}</button>}
        {state.preview && <small className="muted">{encoderLabel(state.preview)} · {formatBytes(state.preview.bytes)} · viewing copy only, never sent</small>}
      </footer>
    </>}
  </main>;
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
  const [mode, setMode] = useState<SourceMode>('card');
  const [videoFolder, setVideoFolder] = useState<VideoFolder | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const [fileClocks, setFileClocks] = useState<Record<string, FileClock>>({});
  const [fileFacts, setFileFacts] = useState<Record<string, FileFacts>>({});
  const [saves, setSaves] = useState<Record<string, SavedCopy>>({});
  // The operator's marks and per-recording places, kept on this computer per card/folder (see reviewScope).
  const [marks, setMarks] = useState<Record<string, ReviewMark>>({});
  const [places, setPlaces] = useState<Record<string, PlaceChoice>>({});
  const [placeEditor, setPlaceEditor] = useState<string | null>(null);
  const [placeQuery, setPlaceQuery] = useState('');
  // One import per (client organisation, place, camera label) in this session; a moved camera gets one per place.
  const [imports, setImports] = useState<Record<string, ImportRow>>({});
  const [markFilter, setMarkFilter] = useState<ReviewMark | 'unmarked' | 'all'>('all');
  // Sends that completed, this session or earlier ones (persisted with the marks): the basis for "Sent" and for cleanup.
  const [sentRecords, setSentRecords] = useState<Record<string, SentRecord>>({});
  const [disk, setDisk] = useState<DiskReport | null>(null);
  const [diskBusy, setDiskBusy] = useState(false);
  const [fcmVerified, setFcmVerified] = useState<Record<string, FcmVerification>>({});
  const [reviewScope, setReviewScope] = useState<string | null>(null);
  const reviewLoadedRef = useRef<string | null>(null);
  const stopQueueRef = useRef(false);
  // Sends finished during a queue, readable after the loop without waiting for a re-render.
  const doneClipsRef = useRef<Record<string, { clip: ExtractedClip; importId: string }>>({});

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
  /** Everything the active source offers, in the shape the review/send flow works on. */
  const items = useMemo<SourceItem[]>(() => (mode === 'card'
    ? (catalog?.recordings ?? []).map((recording) => ({ kind: 'card' as const, key: recordingKey(recording), recording }))
    : (videoFolder?.files ?? []).map((file) => ({ kind: 'file' as const, key: fileKey(file), file }))), [mode, catalog, videoFolder]);
  const sentCount = useMemo(() => items.filter((item) => sends[item.key]?.status === 'done' || sentRecords[item.key]).length, [items, sends, sentRecords]);
  const isSent = (key: string) => sends[key]?.status === 'done' || Boolean(sentRecords[key]);
  const skippedCount = useMemo(() => Object.keys(skipped).length, [skipped]);
  const previewCount = useMemo(() => Object.values(reviews).filter((review) => review.preview).length, [reviews]);
  const unsentItems = useMemo(() => items.filter((item) => sends[item.key]?.status !== 'done' && !sentRecords[item.key] && !skipped[item.key] && !excludedFromSendAll(marks[item.key])), [items, sends, sentRecords, skipped, marks]);
  const markCounts = useMemo(() => {
    const counts: Record<ReviewMark | 'unmarked', number> = { keep: 0, review_further: 0, reviewed: 0, nothing_here: 0, unmarked: 0 };
    for (const item of items) { const mark = marks[item.key]; if (mark) counts[mark] += 1; else counts.unmarked += 1; }
    return counts;
  }, [items, marks]);
  const passesFilter = (key: string) => markFilter === 'all' || (markFilter === 'unmarked' ? !marks[key] : marks[key] === markFilter);
  const placeFor = (key: string): PlaceChoice | null => places[key] ?? (houseId && cameraLabel.trim() ? { houseId, cameraLabel: cameraLabel.trim() } : null);
  const houseName = (id: string | null | undefined) => houses.find((house) => house.id === id)?.name ?? null;
  const placesInUse = useMemo(() => { const seen = new Map<string, number>(); for (const item of items) { const place = placeFor(item.key); if (place) seen.set(place.houseId, (seen.get(place.houseId) ?? 0) + 1); } return seen; }, [items, places, houseId, cameraLabel]);

  // ---- Review state kept on this computer, per card or folder ------------------------------------------
  // A card recording is persisted under its key plus its start time, so a descriptor reused after the card
  // wraps does not inherit an old mark.
  const persistKey = (item: SourceItem) => (item.kind === 'card' ? `${item.key}|${fileStamp(item.recording.start)}` : item.key);
  useEffect(() => {
    if (mode === 'card') {
      if (!catalog?.recordings.length) { setReviewScope(null); return; }
      const first = catalog.recordings[0];
      setReviewScope(`card:${catalog.volume.partitions[0]?.capacityBytes ?? 0}:${first.descriptor}:${fileStamp(first.start)}`);
    } else setReviewScope(videoFolder ? `folder:${videoFolder.directory}` : null);
  }, [mode, catalog, videoFolder]);
  useEffect(() => {
    if (!reviewScope || reviewLoadedRef.current === reviewScope) return;
    let cancelled = false;
    (async () => {
      try {
        const saved = await invoke<ReviewFile | null>('load_review_state', { scope: reviewScope });
        if (cancelled) return;
        const byPersist = new Map(items.map((item) => [persistKey(item), item.key]));
        const remap = <T,>(record: Record<string, T> | undefined) => Object.fromEntries(Object.entries(record ?? {}).flatMap(([persisted, value]) => { const key = byPersist.get(persisted); return key ? [[key, value]] : []; })) as Record<string, T>;
        if (saved?.version === 1) {
          setMarks(remap(saved.marks)); setPlaces(remap(saved.places)); setSentRecords(remap(saved.sent));
          const restored = Object.keys(remap(saved.sent)).length;
          if (restored) setStatus(`${restored} recording${restored === 1 ? '' : 's'} already sent to FCM in an earlier session; marks and places restored.`);
        } else { setMarks({}); setPlaces({}); setSentRecords({}); }
        reviewLoadedRef.current = reviewScope;
      } catch (cause) { failWith(cause, 'The saved review state could not be read.'); reviewLoadedRef.current = reviewScope; }
    })();
    return () => { cancelled = true; };
  }, [reviewScope, items]);
  useEffect(() => {
    if (!reviewScope || reviewLoadedRef.current !== reviewScope) return;
    const byKey = new Map(items.map((item) => [item.key, persistKey(item)]));
    const persist = <T,>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).flatMap(([key, value]) => { const persisted = byKey.get(key); return persisted ? [[persisted, value]] : []; }));
    const file: ReviewFile = { version: 1, marks: persist(marks), places: persist(places), sent: persist(sentRecords), savedAt: new Date().toISOString() };
    const timer = window.setTimeout(() => { invoke('save_review_state', { scope: reviewScope, state: file }).catch((cause: unknown) => failWith(cause, 'The review state could not be saved.')); }, 400);
    return () => window.clearTimeout(timer);
  }, [reviewScope, items, marks, places, sentRecords]);

  const setMark = (item: SourceItem, mark: ReviewMark | null) => setMarks((current) => { const next = { ...current }; if (mark) next[item.key] = mark; else delete next[item.key]; return next; });
  const setPlaceOverride = (keys: string[], place: PlaceChoice | null) => setPlaces((current) => { const next = { ...current }; for (const key of keys) { if (place) next[key] = place; else delete next[key]; } return next; });
  const fileDays = useMemo(() => {
    const groups = new Map<string, LocalVideoFile[]>();
    for (const file of videoFolder?.files ?? []) {
      const clock = fileClocks[fileKey(file)]?.start;
      const day = clock ? formatDay(clock) : 'Date not known';
      groups.set(day, [...(groups.get(day) ?? []), file]);
    }
    return [...groups.entries()];
  }, [videoFolder, fileClocks]);

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
      const chosen = await open({ title: 'Choose where extracted clips are written', directory: true, multiple: false, defaultPath: destinationDirectory ?? 'C:\\Users\\Public\\Documents\\fcm-acquisitions' });
      if (typeof chosen === 'string') setDestinationDirectory(chosen);
      return typeof chosen === 'string' ? chosen : null;
    } catch (cause) { failWith(cause, 'The folder dialog could not be opened.'); return null; }
  };

  /** Save one recording where the operator says: the hashed original, plus a playable MP4 when the decoder is here.
   *  A recording already saved this session is not saved again without the operator saying so. */
  const extract = async (recording: DhfsRecording) => {
    if (!catalogSource) return;
    const key = recordingKey(recording);
    setError(null);
    const already = saves[key];
    if (already) {
      let again = false;
      try {
        again = await ask(`This recording is already saved in\n${already.directory}\nas ${already.fileName}${already.mp4 ? ' with its MP4' : ''}.\n\nSave another copy in a different folder?`, { title: 'Already saved', kind: 'warning', okLabel: 'Choose another folder', cancelLabel: 'Keep the saved copy' });
      } catch (cause) { failWith(cause, 'The confirmation dialog could not be opened.'); return; }
      if (!again) { setStatus(`Kept the copy already saved in ${already.directory}.`); return; }
    }
    let chosen: string | null;
    try {
      const picked = await open({ title: `Choose where to save the ${formatClock(recording.start)} recording`, directory: true, multiple: false, defaultPath: destinationDirectory ?? 'C:\\Users\\Public\\Documents\\fcm-acquisitions' });
      chosen = typeof picked === 'string' ? picked : null;
    } catch (cause) { failWith(cause, 'The folder dialog could not be opened.'); return; }
    if (!chosen) { setStatus('Nothing saved: no folder was chosen.'); return; }
    if (already && chosen === already.directory) { setStatus(`That is the folder it is already saved in (${chosen}); nothing was written again.`); return; }
    setDestinationDirectory(chosen);
    setExtracting(key); setStatus(`Reading channel ${recording.channel}, ${formatTime(recording.start)} (${formatBytes(recording.bytes)}) from the ${sourceLabel(catalogSource)} into ${chosen}…`);
    try {
      const clip = await invoke<ExtractedClip>('extract_dhfs_recording', { source: catalogSource, partitionIndex: recording.partitionIndex, descriptor: recording.descriptor, destinationDirectory: chosen, reuseExisting: true });
      setClips((current) => ({ ...current, [key]: clip }));
      setReviews((current) => { const next = { ...current }; delete next[key]; return next; });
      if (clip.kind === 'pictures') { setSaves((current) => ({ ...current, [key]: { directory: chosen as string, fileName: clip.fileName, mp4: null } })); setStatus(`Saved ${clip.pictures.length} pictures into ${clip.fileName} in ${chosen}.`); return; }
      if (!decoder?.installed) { setSaves((current) => ({ ...current, [key]: { directory: chosen as string, fileName: clip.fileName, mp4: null } })); setStatus(`Saved ${clip.fileName} (${describeClip(clip)}, SHA-256 recorded) in ${chosen}. Install the decoder under “Review here” to also get a playable MP4 next to it.`); return; }
      setStatus(`Saved ${clip.fileName}. Writing a playable MP4 next to it (video only; the .dav stays the hashed original)…`);
      const mp4 = await invoke<Mp4Export>('export_mp4', { clipPath: clip.path, outputDirectory: chosen, codec: clip.codec });
      setSaves((current) => ({ ...current, [key]: { directory: chosen as string, fileName: clip.fileName, mp4 } }));
      setStatus(`Saved in ${chosen}: ${clip.fileName} (original, SHA-256 recorded) and ${mp4.path.split(/[\\/]/).pop()} — ${mp4Label(mp4)}${mp4.existing ? '' : `, ${formatBytes(mp4.bytes)} in ${mp4.seconds.toFixed(0)} s`}.`);
    } catch (cause) { failWith(cause, 'Saving the recording failed.'); }
    finally { setExtracting(null); }
  };

  const modifiedClock = (file: LocalVideoFile): DhfsTime => {
    const zoned = instantToWallClock(file.modifiedEpochMs, timeZone);
    if (zoned) return zoned;
    const at = new Date(file.modifiedEpochMs);
    return { year: at.getFullYear(), month: at.getMonth() + 1, day: at.getDate(), hour: at.getHours(), minute: at.getMinutes(), second: at.getSeconds() };
  };

  /** Replace the file listing (and everything derived from it) with what the operator just chose. */
  const adoptVideoFolder = (folder: VideoFolder, how: string) => {
    const dropFiles = <T,>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).filter(([key]) => !key.startsWith('file:'))) as Record<string, T>;
    setOpenReview(null); setReviews(dropFiles); setSkipped(dropFiles); setClips(dropFiles); setFileFacts({});
    setVideoFolder(folder);
    // First guess at each file's recorded start: the recorder's clock in the name, else when the file was last written.
    setFileClocks(Object.fromEntries(folder.files.map((file) => {
      const named = parseFileNameClock(file.fileName);
      const clock: FileClock = named ? { start: named, source: 'file_name' } : { start: modifiedClock(file), source: 'modified_time' };
      return [fileKey(file), clock];
    })));
    const n = folder.files.length;
    setStatus(`${n} video file${n === 1 ? '' : 's'} ${how}${folder.subfolders ? ` (${folder.subfolders} subfolder${folder.subfolders === 1 ? '' : 's'} not included)` : ''}${folder.otherFiles ? `; ${folder.otherFiles} ${folder.picked ? 'pick' : 'other file'}${folder.otherFiles === 1 ? '' : 's'} ${folder.picked ? 'set aside (not a video file, or empty)' : 'ignored'}` : ''}. Check each file's start time, then preview or send.`);
  };

  /** The way in that shows the files: Windows' folder picker lists folders only, which reads as "no files here". */
  const chooseVideoFiles = async () => {
    setError(null);
    let picked: string[];
    try {
      const result = await open({ title: 'Choose video files', multiple: true, directory: false, defaultPath: videoFolder?.directory, filters: [{ name: 'Video files', extensions: VIDEO_FILE_EXTENSIONS }, { name: 'All files', extensions: ['*'] }] });
      picked = Array.isArray(result) ? result : typeof result === 'string' ? [result] : [];
    } catch (cause) { failWith(cause, 'The file dialog could not be opened.'); return; }
    if (!picked.length) return;
    setFolderBusy(true);
    try {
      const folder = await invoke<Omit<VideoFolder, 'picked'>>('describe_video_files', { paths: picked });
      adoptVideoFolder({ ...folder, picked: true }, `chosen from ${folder.directory}`);
    } catch (cause) { failWith(cause, 'The chosen files could not be read.'); }
    finally { setFolderBusy(false); }
  };

  const chooseVideoFolder = async () => {
    setError(null);
    let chosen: string | null;
    try {
      const picked = await open({ title: 'Choose a folder of video files (the folder picker shows folders only; the files inside are listed after you choose)', directory: true, multiple: false, defaultPath: videoFolder?.directory });
      chosen = typeof picked === 'string' ? picked : null;
    } catch (cause) { failWith(cause, 'The folder dialog could not be opened.'); return; }
    if (!chosen) return;
    setFolderBusy(true);
    try {
      const folder = await invoke<Omit<VideoFolder, 'picked'>>('list_video_files', { directory: chosen });
      adoptVideoFolder({ ...folder, picked: false }, `in ${chosen}`);
    } catch (cause) { failWith(cause, 'The folder could not be listed.'); }
    finally { setFolderBusy(false); }
  };

  const setFileStart = (file: LocalVideoFile, value: string) => {
    const start = inputValueToClock(value);
    if (!start) return;
    const key = fileKey(file);
    setFileClocks((current) => ({ ...current, [key]: { start, source: 'operator' } }));
    setClips((current) => (current[key] ? { ...current, [key]: { ...current[key], start, end: clockAdd(start, current[key].durationSeconds), stats: { ...current[key].stats, contentStart: start, contentEnd: clockAdd(start, current[key].durationSeconds) } } } : current));
  };

  /** The bytes that will be sent, described the same way for both sources: for a card recording its `-r2`
   *  extraction (this session's, an earlier run's re-hashed, or a fresh read); for a file, the file itself
   *  hashed and probed, with the recorded start the operator has agreed to. */
  const ensureClip = async (item: SourceItem): Promise<ExtractedClip> => {
    const existing = clips[item.key];
    if (existing) return existing;
    if (item.kind === 'card') {
      if (!catalogSource) throw new Error('No card or image is open.');
      const { recording } = item;
      const directory = destinationDirectory ?? await invoke<string>('default_clip_directory', { sourceId: catalogSource.kind === 'device' ? catalogSource.id : 'image' });
      if (!destinationDirectory) setDestinationDirectory(directory);
      setStatus(`Reading channel ${recording.channel}, ${formatTime(recording.start)} from the ${sourceLabel(catalogSource)} — only frames the camera dated inside this recording are kept…`);
      const clip = await invoke<ExtractedClip>('extract_dhfs_recording', { source: catalogSource, partitionIndex: recording.partitionIndex, descriptor: recording.descriptor, destinationDirectory: directory, reuseExisting: true });
      setClips((current) => ({ ...current, [item.key]: clip }));
      return clip;
    }
    const { file } = item;
    let facts = fileFacts[item.key];
    if (!facts) {
      setStatus(`Hashing ${file.fileName} (${formatBytes(file.bytes)})…`);
      const digest = await invoke<{ sha256: string; bytes: number }>('hash_local_file', { path: file.path });
      let probe: MediaProbe | null = null;
      if (decoder?.installed) { try { probe = await invoke<MediaProbe>('probe_video_file', { path: file.path }); } catch { probe = null; } }
      facts = { sha256: digest.sha256, bytes: digest.bytes, probe };
      setFileFacts((current) => ({ ...current, [item.key]: facts as FileFacts }));
    }
    let clock = fileClocks[item.key];
    // The container's own creation time beats a guess from the modified time, but never the operator's word.
    if (clock?.source === 'modified_time' && facts.probe?.creationTime) {
      const fromMetadata = instantToWallClock(facts.probe.creationTime, timeZone);
      if (fromMetadata) { clock = { start: fromMetadata, source: 'file_metadata' }; setFileClocks((current) => ({ ...current, [item.key]: clock as FileClock })); }
    } else if (clock?.source === 'modified_time' && facts.probe?.durationSeconds) {
      // A file is usually written as the recording ends, so its modified time is closer to the end than the start.
      const fromEnd = instantToWallClock(file.modifiedEpochMs - facts.probe.durationSeconds * 1000, timeZone);
      if (fromEnd) { clock = { start: fromEnd, source: 'modified_time' }; setFileClocks((current) => ({ ...current, [item.key]: clock as FileClock })); }
    }
    if (!clock) throw new Error(`No start time is known for ${file.fileName}; set one in the list first.`);
    const durationSeconds = facts.probe?.durationSeconds ?? 0;
    const end = clockAdd(clock.start, durationSeconds);
    const clip: ExtractedClip = {
      path: file.path, fileName: file.fileName, bytes: facts.bytes, sha256: facts.sha256, contentType: contentTypeFor(file.extension), codec: facts.probe?.codec ?? 'unknown',
      streamStartOffset: 0, channel: 0, start: clock.start, end, durationSeconds, fragments: 0, descriptor: 0, partitionIndex: -1, kind: 'local_video',
      stats: { framesKept: 0, videoFrames: 0, keyFrames: 0, audioFrames: 0, staleFrames: 0, staleBytes: 0, unstructuredBytes: 0, structuralBytesRemoved: 0, leadingFramesDropped: 0, sourceBytesRead: facts.bytes, pictures: 0, contentStart: clock.start, contentEnd: end, stoppedAtNextRecording: false, truncatedFinalFrame: false },
      pictures: [],
    };
    setClips((current) => ({ ...current, [item.key]: clip }));
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

  /** Open the review for an item: extract or hash it if needed, then decode key frames on this computer. */
  const review = async (item: SourceItem) => {
    const { key } = item;
    setOpenReview(key); setError(null);
    if (reviews[key]?.filmstrip) return;
    if (!decoder?.installed) { updateReview(key, { busy: null, error: 'Install the decoder under “Review here” first; previews are decoded on this computer.' }); return; }
    updateReview(key, { busy: 'filmstrip', error: undefined, note: undefined });
    try {
      const clip = await ensureClip(item);
      if (clip.kind === 'pictures') {
        // The pictures are the review: show them, dated by the camera, in place of a decoded filmstrip.
        const shown = clip.pictures.slice(0, 24);
        const jpegs = await invoke<string[]>('read_pictures', { paths: shown.map((picture) => picture.path) });
        const base = clip.stats.contentStart ?? clip.start;
        const filmstrip: Filmstrip = { frames: shown.map((picture, index) => ({ atSeconds: clockSeconds(picture.takenAt) - clockSeconds(base), jpegBase64: jpegs[index] ?? '' })), keyFramesUsed: 0 };
        updateReview(key, { busy: null, filmstrip, note: `${clip.pictures.length} dated picture${clip.pictures.length === 1 ? '' : 's'}${clip.pictures.length > shown.length ? ` (first ${shown.length} shown)` : ''} — a picture stream is sent to FCM as dated timeline events with these as thumbnails, not as video.` });
        setStatus(`${shown.length} event pictures from ${clip.fileName}, dated by the camera. Choose Send or Skip.`);
        return;
      }
      setStatus(`Decoding key frames of ${clip.fileName} on this computer…`);
      const filmstrip = await invoke<Filmstrip>('render_filmstrip', { clipPath: clip.path, keyFrames: clip.stats.keyFrames, count: 12, durationSeconds: clip.kind === 'local_video' && clip.durationSeconds > 0 ? clip.durationSeconds : null });
      updateReview(key, { busy: null, filmstrip });
      setStatus(`${filmstrip.frames.length} key frames from ${clip.fileName}, labelled with the ${clip.kind === 'local_video' ? 'recorded' : 'camera'} clock. Play the preview for the whole recording, then choose Send or Skip.`);
    } catch (cause) { updateReview(key, { busy: null, error: describeFailure(cause, 'The recording could not be reviewed.') }); }
  };

  const playPreview = async (item: SourceItem) => {
    const clip = clips[item.key];
    if (!clip) return;
    updateReview(item.key, { busy: 'preview', error: undefined });
    setStatus(`Rendering a 480p viewing copy of ${clip.fileName} on this computer (GPU when available). Nothing leaves the machine.`);
    try {
      const preview = await invoke<PreviewRendition>('render_preview', { clipPath: clip.path });
      updateReview(item.key, { busy: null, preview });
      setStatus(`Preview ready — ${encoderLabel(preview)}, ${formatBytes(preview.bytes)}${preview.cached ? '' : `, ${preview.seconds.toFixed(0)} s`}. A viewing aid only: it is never sent and never becomes evidence.`);
    } catch (cause) { updateReview(item.key, { busy: null, error: describeFailure(cause, 'The preview could not be rendered.') }); }
  };

  const toggleSkip = (item: SourceItem) => {
    setSkipped((current) => { const next = { ...current }; if (next[item.key]) delete next[item.key]; else next[item.key] = true; return next; });
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
    setFcmSession(null); setFcmProfile(null); setOrganizations([]); setOrganizationId(null); setHouses([]); setHouseId(null); setImportRow(null); setImports({}); setSends({}); doneClipsRef.current = {};
  };

  /** One `cctv_imports` row for a client organisation, place and camera label; the RPCs the web import page uses. */
  const createImportRow = async (place: PlaceChoice): Promise<ImportRow> => {
    if (!organizationId) throw new Error('Choose the organisation this footage belongs to.');
    if (!isValidTimeZone(timeZone)) throw new Error('Enter a valid time zone for the camera clock (for example Pacific/Auckland).');
    const rootLabel = mode === 'files' ? (videoFolder?.directory ?? null) : selectedDevice ? `${selectedDevice.driveLetters.join(' ')} ${selectedDevice.label}`.trim() : catalogSource ? sourceLabel(catalogSource) : null;
    const { data, error: createError } = await supabase.rpc('create_cctv_import', {
      p_organization_id: organizationId, p_location_id: place.houseId, p_camera_label: place.cameraLabel.trim(), p_site_id: null, p_zone_id: null,
      p_source_device_kind: mode === 'files' ? 'generic_folder' : 'dahua', p_source_timezone: timeZone, p_source_root_label: rootLabel, p_watermark_location_hint: null, p_notes: notes.trim() || null,
    });
    if (createError) throw new Error(createError.message);
    const row = data as ImportRow;
    const { error: manifestError } = await supabase.rpc('set_cctv_import_manifest', { p_import_id: row.id, p_manifest: [], p_status: 'uploading' });
    if (manifestError) throw new Error(manifestError.message);
    return row;
  };

  const createImport = async () => {
    if (!organizationId) { setError('Choose the organisation this footage belongs to.'); return; }
    if (!houseId) { setError('Choose the place this camera watches. Cards carry no GPS, so the place comes from you.'); return; }
    if (!cameraLabel.trim()) { setError('Give the camera a label (for example “Gate cam 1”).'); return; }
    if (!isValidTimeZone(timeZone)) { setError('Enter a valid time zone for the camera clock (for example Pacific/Auckland).'); return; }
    setFcmBusy(true); setError(null);
    try {
      const place = { houseId, cameraLabel: cameraLabel.trim() };
      const row = await createImportRow(place);
      setImportRow(row); setImports({ [placeKeyOf(place)]: row }); setSends({}); doneClipsRef.current = {};
      setStatus(`Ready to send to ${selectedHouse?.name ?? 'the chosen place'}. Recordings made somewhere else can be given their own place on the row (or for a whole day) before sending.`);
    } catch (cause) { failWith(cause, 'The import could not be created.'); }
    finally { setFcmBusy(false); }
  };

  /** The import a recording belongs to: the default place's, or one created on first use for the place set on the row. */
  const importFor = async (item: SourceItem): Promise<ImportRow> => {
    if (!importRow) throw new Error('Create the import under “Send to FCM” first.');
    const place = places[item.key];
    if (!place) return importRow;
    const placeKey = placeKeyOf(place);
    const existing = imports[placeKey] ?? (placeKey === placeKeyOf({ houseId: importRow.location_id, cameraLabel: importRow.camera_label }) ? importRow : null);
    if (existing) return existing;
    setStatus(`Creating an import for ${houseName(place.houseId) ?? 'the chosen place'} (${place.cameraLabel})…`);
    const row = await createImportRow(place);
    setImports((current) => ({ ...current, [placeKey]: row }));
    return row;
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

  /** Send one item and register it against the import: a card recording is read off the card (or its finished copy
   *  reused); a file is hashed as it lies. Video becomes evidence queued for analysis; a picture stream becomes dated
   *  timeline events with thumbnails. */
  const sendItem = async (item: SourceItem, importTarget: ImportRow): Promise<boolean> => {
    if (item.kind === 'card' && !catalogSource) return false;
    const { key } = item;
    setSendingKey(key); setError(null);
    updateSend(key, { status: 'extracting', sent: 0, total: item.kind === 'card' ? item.recording.bytes : item.file.bytes, error: undefined });
    try {
      const clip = await ensureClip(item);
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
        doneClipsRef.current[key] = { clip, importId: importTarget.id };
        setSentRecords((current) => ({ ...current, [key]: { importId: importTarget.id, storagePath: storagePathFor(importTarget.organization_id, importTarget.id, clip.fileName), fileName: clip.fileName, sentAt: new Date().toISOString(), bytes: clip.bytes } }));
        updateSend(key, { status: 'done' });
        setStatus(`${clip.pictures.length} event pictures from ${formatTime(clip.pictures[0].takenAt)} are on the timeline at ${houseName(importTarget.location_id) ?? 'the chosen place'}.`);
        return true;
      }
      if (!clip.contentType.startsWith('video/')) throw new Error(`${clip.fileName} was not recognised as a video stream (${clip.codec}); it stays ${item.kind === 'card' ? 'in the working folder' : 'where it is'} and is not sent.`);
      if (clip.kind === 'local_video' && fileClocks[key]?.source === 'modified_time') setStatus(`Note: ${clip.fileName} carries no recorded time of its own; the start sent is estimated from when the file was written. Set it in the list if you know better.`);
      const objectName = storagePathFor(importTarget.organization_id, importTarget.id, clip.fileName);
      updateSend(key, { status: 'uploading', sent: 0, total: clip.bytes });
      setStatus(`Sending ${clip.fileName} (${formatBytes(clip.bytes)}) to FCM…`);
      await uploadFile(key, clip.path, objectName, clip.contentType);
      updateSend(key, { status: 'registering', sent: clip.bytes, total: clip.bytes });
      const recordedStart = clip.stats.contentStart ?? clip.start;
      const recordedEnd = clip.stats.contentEnd ?? clip.end;
      const { error: registerError } = await supabase.rpc('register_cctv_import_video', {
        p_import_id: importTarget.id, p_storage_path: objectName, p_file_name: clip.fileName, p_file_size_bytes: clip.bytes, p_sha256: clip.sha256,
        p_recorded_start_at: wallClockToIso(recordedStart, timeZone), p_recorded_end_at: clip.kind === 'local_video' && clip.durationSeconds <= 0 ? null : wallClockToIso(recordedEnd, timeZone), p_source_ref: clip.fileName, p_content_type: clip.contentType,
      });
      if (registerError) throw new Error(registerError.message);
      doneClipsRef.current[key] = { clip, importId: importTarget.id };
      setSentRecords((current) => ({ ...current, [key]: { importId: importTarget.id, storagePath: objectName, fileName: clip.fileName, sentAt: new Date().toISOString(), bytes: clip.bytes } }));
      updateSend(key, { status: 'done' });
      setStatus(`${clip.fileName} is in FCM (SHA-256 anchored ${item.kind === 'card' ? 'from the card' : 'before it left this computer'}) and queued for analysis at ${houseName(importTarget.location_id) ?? 'the chosen place'}.`);
      return true;
    } catch (cause) {
      const message = describeFailure(cause, 'The recording could not be sent.');
      updateSend(key, { status: 'failed', error: message }); setError(message);
      return false;
    } finally { setSendingKey(null); }
  };

  const manifestFor = (target: ImportRow) => Object.entries(doneClipsRef.current).filter(([, done]) => done.importId === target.id).flatMap(([key, { clip }]) => {
    const review_mark = marks[key] ?? null;
    if (clip.kind === 'pictures') {
      return clip.pictures.map((picture) => ({ name: picture.fileName, relative_path: `${clip.fileName}/${picture.fileName}`, size_bytes: picture.bytes, kind: 'snapshot', slot_start_at: wallClockToIso(picture.takenAt, timeZone), sha256: picture.sha256, import_id: target.id, review_mark }));
    }
    const start = clip.stats.contentStart ?? clip.start;
    const end = clip.stats.contentEnd ?? clip.end;
    const timing = clip.kind === 'local_video' ? { start_time_source: fileClocks[key]?.source ?? 'unknown', source_path: clip.path } : { frames: clip.stats.videoFrames, stale_bytes_skipped: clip.stats.staleBytes };
    return [{ name: clip.fileName, relative_path: clip.fileName, size_bytes: clip.bytes, kind: 'video', slot_start_at: wallClockToIso(start, timeZone), slot_end_at: wallClockToIso(end, timeZone), sha256: clip.sha256, import_id: target.id, content_kind: clip.kind, review_mark, ...timing }];
  });

  const finishImport = async (target: ImportRow) => {
    const anySent = Object.values(doneClipsRef.current).some((done) => done.importId === target.id);
    const { error: manifestError } = await supabase.rpc('set_cctv_import_manifest', { p_import_id: target.id, p_manifest: manifestFor(target), p_status: anySent ? 'registered' : null });
    if (manifestError) setError(`Sent, but the import summary could not be updated: ${manifestError.message}`);
  };

  const sendOne = async (item: SourceItem) => {
    if (!importRow) return;
    // An explicit Send overrides an earlier Skip.
    setSkipped((current) => { const next = { ...current }; delete next[item.key]; return next; });
    let target: ImportRow;
    try { target = await importFor(item); } catch (cause) { failWith(cause, 'The import for this recording could not be created.'); return; }
    await sendItem(item, target);
    await finishImport(target);
  };

  const sendAll = async () => {
    if (!importRow) return;
    stopQueueRef.current = false;
    const queue = unsentItems;
    const touched = new Map<string, ImportRow>();
    let sentNow = 0;
    for (let index = 0; index < queue.length; index += 1) {
      if (stopQueueRef.current) break;
      setQueueRemaining(queue.length - index);
      let target: ImportRow;
      try { target = await importFor(queue[index]); } catch (cause) { failWith(cause, 'The import for a recording could not be created; sending stopped.'); break; }
      touched.set(target.id, target);
      if (await sendItem(queue[index], target)) sentNow += 1;
    }
    setQueueRemaining(0);
    for (const target of touched.values()) await finishImport(target);
    const placeCount = touched.size;
    setStatus(stopQueueRef.current ? `Stopped: ${sentNow} recording${sentNow === 1 ? '' : 's'} sent before the stop.` : `${sentNow} of ${queue.length} recording${queue.length === 1 ? '' : 's'} sent to FCM${placeCount > 1 ? ` across ${placeCount} places` : ''}${skippedCount ? ` (${skippedCount} skipped by you)` : ''}. Open FCM → CCTV review to watch the analysis land.`);
  };

  const stopQueue = async () => { stopQueueRef.current = true; try { await invoke('cancel_upload'); } catch (cause) { failWith(cause, 'Stop request failed.'); } };

  // ---- Disk on this computer ------------------------------------------------------------------------------
  // Removal never reaches past the working folder and the previews folder (enforced again in Rust), and never
  // touches a recording that is undecided, marked Keep / Review further, saved on purpose, or not yet verified by FCM.
  const refreshDisk = async () => {
    setDiskBusy(true); setError(null);
    try {
      const directory = destinationDirectory ?? (catalogSource ? await invoke<string>('default_clip_directory', { sourceId: catalogSource.kind === 'device' ? catalogSource.id : 'image' }) : null);
      if (!directory) { setDisk(null); return; }
      if (!destinationDirectory) setDestinationDirectory(directory);
      const report = await invoke<DiskReport>('disk_report', { directory });
      setDisk(report);
      // FCM's own verdict on what was sent: the worker re-hashes on intake and records the outcome on the evidence row.
      const sentPaths = items.map((item) => sentRecords[item.key]?.storagePath).filter((path): path is string => Boolean(path));
      if (sentPaths.length && fcmSession) {
        const verdicts: Record<string, FcmVerification> = {};
        for (let start = 0; start < sentPaths.length; start += 50) {
          const { data, error: readError } = await supabase.from('evidence_items').select('storage_path, metadata').in('storage_path', sentPaths.slice(start, start + 50));
          if (readError) throw new Error(`FCM's verification state could not be read: ${readError.message}`);
          for (const row of (data ?? []) as Array<{ storage_path: string; metadata: { integrity?: { state?: string } } | null }>) {
            const state = row.metadata?.integrity?.state;
            verdicts[row.storage_path] = state === 'verified' ? 'verified' : state === 'mismatch' ? 'mismatch' : 'pending';
          }
        }
        setFcmVerified(Object.fromEntries(items.flatMap((item) => { const record = sentRecords[item.key]; return record ? [[item.key, verdicts[record.storagePath] ?? 'unknown']] : []; })));
      } else setFcmVerified({});
    } catch (cause) { failWith(cause, 'The disk report could not be built.'); }
    finally { setDiskBusy(false); }
  };

  type DiskGroups = { verifiedSent: DiskEntry[]; awaitingFcm: DiskEntry[]; decidedNo: DiskEntry[]; partial: DiskEntry[]; kept: DiskEntry[]; saved: DiskEntry[]; unknown: DiskEntry[] };
  const diskGroups = useMemo<DiskGroups | null>(() => {
    if (!disk) return null;
    const groups: DiskGroups = { verifiedSent: [], awaitingFcm: [], decidedNo: [], partial: [], kept: [], saved: [], unknown: [] };
    const savedNames = new Set(Object.values(saves).filter((copy) => copy.directory === disk.directory).flatMap((copy) => [copy.fileName, copy.mp4 ? copy.mp4.path.split(/[\\/]/).pop() ?? '' : '']));
    for (const entry of disk.entries) {
      if (entry.kind === 'partial') { groups.partial.push(entry); continue; }
      if (entry.kind === 'mp4' || entry.kind === 'image' || savedNames.has(entry.name)) { groups.saved.push(entry); continue; }
      const item = items.find((candidate) => candidate.kind === 'card' && entry.name.includes(recordingStemMarker(candidate.recording)));
      if (!item) { groups.unknown.push(entry); continue; }
      const mark = marks[item.key];
      if (isSent(item.key)) { (fcmVerified[item.key] === 'verified' ? groups.verifiedSent : groups.awaitingFcm).push(entry); continue; }
      if (mark === 'nothing_here' || mark === 'reviewed') { groups.decidedNo.push(entry); continue; }
      groups.kept.push(entry);
    }
    return groups;
  }, [disk, items, marks, saves, sentRecords, sends, fcmVerified]);
  const sumBytes = (entries: DiskEntry[]) => entries.reduce((total, entry) => total + entry.bytes, 0);

  const removeEntries = async (entries: DiskEntry[], what: string, why: string) => {
    if (!disk || !entries.length) return;
    let confirmed = false;
    try { confirmed = await ask(`Remove ${entries.length} ${what} (${formatBytes(sumBytes(entries))}) from this computer?\n\n${why}`, { title: 'Free disk space', kind: 'warning', okLabel: 'Remove', cancelLabel: 'Keep' }); }
    catch (cause) { failWith(cause, 'The confirmation dialog could not be opened.'); return; }
    if (!confirmed) return;
    setDiskBusy(true);
    try {
      const report = await invoke<RemovalReport>('remove_local_files', { paths: entries.map((entry) => entry.path), roots: [disk.directory] });
      const removedPaths = new Set(entries.map((entry) => entry.path));
      for (const failure of report.failures) removedPaths.delete(failure.path);
      // A removed working copy is no longer "extracted" here; the send record stays because FCM still holds it.
      setClips((current) => Object.fromEntries(Object.entries(current).filter(([, clip]) => !removedPaths.has(clip.path))));
      setReviews((current) => Object.fromEntries(Object.entries(current).filter(([key]) => { const clip = clips[key]; return !clip || !removedPaths.has(clip.path); })));
      setStatus(`${report.removed} ${what} removed, ${formatBytes(report.freedBytes)} freed.${report.failures.length ? ` ${report.failures.length} left alone: ${report.failures.map((failure) => `${failure.path.split(/[\\/]/).pop()} (${failure.error})`).join('; ')}` : ''}`);
      await refreshDisk();
    } catch (cause) { failWith(cause, 'Removal failed.'); setDiskBusy(false); }
  };

  const jumpTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const switchMode = (next: SourceMode) => { setMode(next); setOpenReview(null); setError(null); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const busyAnywhere = Boolean(extracting) || sendingKey !== null;

  // ---- Pop-out preview (second screen) -------------------------------------------------------------------
  const [popoutOpen, setPopoutOpen] = useState(false);
  const openItem = useMemo(() => items.find((item) => item.key === openReview) ?? null, [items, openReview]);
  const popoutState = useMemo<PopoutState | null>(() => {
    if (!openItem) return null;
    const clip = clips[openItem.key];
    const reviewState = reviews[openItem.key];
    const send = sends[openItem.key];
    const title = openItem.kind === 'card' ? `Channel ${openItem.recording.channel} · ${formatTime(openItem.recording.start)}` : openItem.file.fileName;
    return {
      title, subtitle: clip ? `${clip.fileName} · ${describeClip(clip)}` : openItem.kind === 'card' ? 'Reading from the card…' : 'Hashing the file…', itemKey: openItem.key, sourceKind: openItem.kind,
      filmstrip: reviewState?.filmstrip ?? null, clockBase: clip ? (clip.stats.contentStart ?? clip.start) : null, clipKind: clip?.kind ?? null,
      preview: reviewState?.preview ?? null, busy: reviewState?.busy ?? null, note: reviewState?.note ?? null, error: reviewState?.error ?? null,
      canSend: Boolean(importRow), sendStatus: send?.status ?? (sentRecords[openItem.key] ? 'done' : null), skipped: Boolean(skipped[openItem.key]),
      sendHint: importRow ? null : fcmSession ? 'Create the import under “Send to FCM” in the main window to send this recording.' : 'Sign in under “Send to FCM” in the main window to send this recording.',
      mark: marks[openItem.key] ?? null, placeName: (() => { const place = placeFor(openItem.key); return place ? `${houseName(place.houseId) ?? 'place'} · ${place.cameraLabel}` : null; })(),
    };
  }, [openItem, clips, reviews, sends, sentRecords, skipped, importRow, fcmSession, marks, places, houseId, cameraLabel, houses]);
  const popoutStateRef = useRef(popoutState);
  popoutStateRef.current = popoutState;
  useEffect(() => { if (popoutOpen) void emitTo(POPOUT_LABEL, POPOUT_STATE_EVENT, popoutState); }, [popoutOpen, popoutState]);
  useEffect(() => {
    const ready = listen(POPOUT_READY_EVENT, () => { setPopoutOpen(true); void emitTo(POPOUT_LABEL, POPOUT_STATE_EVENT, popoutStateRef.current); });
    return () => { void ready.then((unlisten) => unlisten()); };
  }, []);
  const openPopout = async (item: SourceItem) => {
    setError(null);
    if (openReview !== item.key) await review(item);
    try {
      const existing = await WebviewWindow.getByLabel(POPOUT_LABEL);
      if (existing) { await existing.unminimize(); await existing.setFocus(); setPopoutOpen(true); void emitTo(POPOUT_LABEL, POPOUT_STATE_EVENT, popoutStateRef.current); return; }
      const popout = new WebviewWindow(POPOUT_LABEL, { url: 'index.html?popout=1', title: 'FCM Desktop V2 — Preview', width: 1280, height: 860, minWidth: 720, minHeight: 480 });
      void popout.once('tauri://destroyed', () => setPopoutOpen(false));
      void popout.once('tauri://error', (event) => setError(`The preview window could not be opened: ${JSON.stringify(event.payload)}`));
      setStatus('Preview opened in its own window — drag it to a second screen. Send and Skip work from either window.');
    } catch (cause) { failWith(cause, 'The preview window could not be opened.'); }
  };
  // Decisions taken in the pop-out land here, on the same handlers the workstation buttons use.
  const actionHandlersRef = useRef({ playPreview, sendOne, toggleSkip, setMark });
  actionHandlersRef.current = { playPreview, sendOne, toggleSkip, setMark };
  const itemsRef = useRef(items);
  itemsRef.current = items;
  useEffect(() => {
    const pending = listen<PopoutAction>(POPOUT_ACTION_EVENT, (event) => {
      const item = itemsRef.current.find((candidate) => candidate.key === event.payload.itemKey);
      if (!item) return;
      const handlers = actionHandlersRef.current;
      if (event.payload.action === 'mark') handlers.setMark(item, event.payload.mark);
      else if (event.payload.action === 'play') void handlers.playPreview(item);
      else if (event.payload.action === 'send') void handlers.sendOne(item);
      else if (event.payload.action === 'skip' || event.payload.action === 'include') handlers.toggleSkip(item);
    });
    return () => { void pending.then((unlisten) => unlisten()); };
  }, []);

  /** Review card shared by both sources: filmstrip, optional 480p playback, then Send or Skip. */
  const renderReview = (item: SourceItem, clip: ExtractedClip | undefined, reviewState: ReviewState | undefined, send: SendState | undefined, isSkipped: boolean, title: string) => <div className="review" role="region" aria-label={`Review of ${title}`}>
    <div className="review__head"><strong>{clip ? `${clip.fileName} · ${describeClip(clip)}` : item.kind === 'card' ? 'Reading from the card…' : 'Hashing the file…'}</strong><small>{reviewState?.filmstrip ? (clip?.kind === 'pictures' ? `${reviewState.filmstrip.frames.length} pictures · times are the camera clock` : `${reviewState.filmstrip.frames.length} key frames${reviewState.filmstrip.keyFramesUsed > 1 ? `, every ${reviewState.filmstrip.keyFramesUsed}th` : reviewState.filmstrip.keyFramesUsed === 1 ? ', every one' : ', spread over the duration'} · times are the ${item.kind === 'card' ? 'camera' : 'recorded'} clock`) : reviewState?.busy === 'filmstrip' ? (clip?.kind === 'pictures' ? 'Reading the pictures…' : 'Decoding key frames on this computer…') : ''}</small><button className="secondary review__popout" onClick={() => void openPopout(item)} title="Open this preview in its own window, for a second screen"><ExternalLink size={14} /> {popoutOpen ? 'Show in preview window' : 'Pop out'}</button></div>
    {reviewState?.busy === 'filmstrip' && <div className="progress is-indeterminate" role="progressbar" aria-busy="true"><div /></div>}
    {reviewState?.filmstrip && clip && <div className="filmstrip">{reviewState.filmstrip.frames.map((frame, index) => <figure key={`${item.key}:${index}`}><img src={`data:image/jpeg;base64,${frame.jpegBase64}`} alt={`Key frame ${index + 1} at ${clockPlus(clip.stats.contentStart ?? clip.start, frame.atSeconds)}`} /><figcaption>{clockPlus(clip.stats.contentStart ?? clip.start, frame.atSeconds)}</figcaption></figure>)}</div>}
    {reviewState?.preview && <video controls preload="metadata" src={convertFileSrc(reviewState.preview.path)} />}
    {reviewState?.busy === 'preview' && <div className="progress is-indeterminate" role="progressbar" aria-busy="true"><div /></div>}
    {reviewState?.note && <p className="review__note">{reviewState.note}</p>}
    {reviewState?.error && <p className="review__error">{reviewState.error}</p>}
    <div className="review__actions">
      <MarkPicker value={marks[item.key] ?? null} onChange={(next) => setMark(item, next)} />
      {clip && clip.kind !== 'pictures' && !reviewState?.preview && <button className="secondary" onClick={() => void playPreview(item)} disabled={reviewState?.busy !== null && reviewState?.busy !== undefined}><Play size={14} /> {reviewState?.busy === 'preview' ? 'Rendering 480p copy…' : 'Play preview (480p, rendered here)'}</button>}
      {importRow ? <button className="primary" onClick={() => void sendOne(item)} disabled={busyAnywhere || send?.status === 'done'}><Send size={14} /> {send?.status === 'done' ? 'Sent to FCM' : 'Send this recording to FCM'}</button> : <small>{fcmSession ? 'Create the import under “Send to FCM” to send this recording.' : 'Sign in under “Send to FCM” to send this recording.'}</small>}
      {send?.status !== 'done' && <button className="secondary" onClick={() => toggleSkip(item)}>{isSkipped ? <><Undo2 size={14} /> Include again</> : <><EyeOff size={14} /> Skip — do not send</>}</button>}
      {reviewState?.preview && <small>{encoderLabel(reviewState.preview)} · {formatBytes(reviewState.preview.bytes)} · viewing copy only, never sent</small>}
    </div>
  </div>;

  const catalogPartition = catalog?.volume.partitions[0];
  const reviewing = Object.values(reviews).some((review) => review.busy !== null);
  const reviewed = Object.values(reviews).some((review) => review.filmstrip);

  /** Choose the place (and camera label) for one recording or a whole day; scoped to the client organisation of the import. */
  const renderPlaceEditor = (keys: string[], close: () => void) => {
    const current = keys.length === 1 ? places[keys[0]] ?? null : null;
    const pool = houses.filter((house) => !organizationId || house.organization_id === organizationId);
    const query = placeQuery.trim().toLowerCase();
    const shown = (query ? pool.filter((house) => `${house.name} ${house.address ?? ''}`.toLowerCase().includes(query)) : pool).slice(0, 8);
    const label = current?.cameraLabel ?? (cameraLabel.trim() || 'Covert cam');
    return <div className="place-editor" role="group" aria-label="Place for this recording">
      <div className="place-editor__head"><strong>{keys.length === 1 ? 'Where was this recording made?' : `Where were these ${keys.length} recordings made?`}</strong><small>Same client organisation ({organizations.find((organization) => organization.organizationId === organizationId)?.organizationName ?? 'chosen'}); a different place gets its own import when it is sent. Camera label stays “{label}” unless you change it below.</small></div>
      <input type="search" placeholder="Search places by name or address" value={placeQuery} onChange={(event) => setPlaceQuery(event.target.value)} autoFocus />
      <div className="house-list">{shown.map((house) => <button key={house.id} type="button" className={`device ${current?.houseId === house.id || (!current && importRow?.location_id === house.id) ? 'is-selected' : ''}`} onClick={() => { setPlaceOverride(keys, importRow && house.id === importRow.location_id && label === importRow.camera_label ? null : { houseId: house.id, cameraLabel: label }); close(); }}><span className="device-icon"><MapPin size={16} /></span><span><strong>{house.name}</strong><small>{house.address ?? 'no address recorded'}{house.id === importRow?.location_id ? ' · the import’s place' : ''}</small></span><CheckCircle2 size={16} /></button>)}{shown.length === 0 && <p className="muted small">{pool.length ? 'No place matches that search.' : 'No places are visible for this organisation yet. Add the place in FCM first.'}</p>}</div>
      <div className="actions"><label className="field"><span>Camera label for this place</span><input type="text" value={label} maxLength={120} onChange={(event) => { const next = event.target.value; setPlaceOverride(keys, current ? { ...current, cameraLabel: next } : { houseId: importRow?.location_id ?? '', cameraLabel: next }); }} /></label>{current && <button type="button" className="secondary" onClick={() => { setPlaceOverride(keys, null); close(); }}><Undo2 size={14} /> Use the import’s place</button>}<button type="button" className="secondary" onClick={close}>Close</button></div>
    </div>;
  };

  /** Mark counts for a day, as coloured dots, so a day reads at a glance. */
  const renderDaySummary = (keys: string[]) => {
    const counts = MARKS.map((mark) => ({ mark, n: keys.filter((key) => marks[key] === mark.id).length })).filter((entry) => entry.n > 0);
    const sent = keys.filter((key) => isSent(key)).length;
    if (!counts.length && !sent) return null;
    return <span className="day-summary">{sent > 0 && <span className="day-summary__sent">{sent} sent</span>}{counts.map(({ mark, n }) => <span key={mark.id} className={`day-summary__mark mark__dot--${mark.id}`} title={`${n} ${mark.label}`}><span className="mark__dot" />{n}</span>)}</span>;
  };

  return <main className="v2-shell">
    <aside className="rail"><div className="brand"><span><Waves size={19} /></span><div><b>FCM</b><small>Desktop V2 · v{APP_VERSION}</small></div></div>
      <nav>
        <button className={mode === 'card' ? 'is-active' : ''} onClick={() => switchMode('card')} aria-pressed={mode === 'card'}><HardDrive size={17} /> Camera card</button>
        <button className={mode === 'files' ? 'is-active' : ''} onClick={() => switchMode('files')} aria-pressed={mode === 'files'}><FolderOpen size={17} /> Video files</button>
        <button onClick={() => jumpTo('panel-review')}><Cpu size={17} /> Review here</button>
        <button onClick={() => jumpTo('panel-send')}><Send size={17} /> Send to FCM</button>
      </nav>
      <div className="rail-note"><LockKeyhole size={16} /><span>{mode === 'card' ? 'Read-only: the card is opened without a write handle and is never changed.' : 'Files are read and hashed where they are; nothing in the folder is changed.'}</span></div></aside>
    <section className="workspace">
      {mode === 'card'
        ? <header className="topbar"><div><span className="eyebrow">Evidence workstation</span><h1>Read the card. Send the recordings.</h1><p>FCM reads the hidden Dahua partition straight from the card, stitches only the recordings you choose, and sends them to the place they belong. An exact image of the whole card is optional.</p></div><div className="topbar-badge"><ShieldCheck size={17} /> Read-only source</div></header>
        : <header className="topbar"><div><span className="eyebrow">Evidence workstation</span><h1>Video files on this computer.</h1><p>Point FCM at a folder — a download, a camera export, a synced cloud folder — and send the files you choose to the place they belong, hashed before they leave. Preview any of them here first.</p></div><div className="topbar-badge"><ShieldCheck size={17} /> Files hashed before sending</div></header>}
      {mode === 'card'
        ? <section className="steps"><Step number="01" title="Discover" detail="Find the card" complete={stage !== 'idle' && stage !== 'discovery'} active={stage === 'discovery'} /><ChevronRight size={17} /><Step number="02" title="Recordings" detail="List from the card" complete={Boolean(catalog)} active={catalogBusy} /><ChevronRight size={17} /><Step number="03" title="Review here" detail="Optional · on this computer" complete={reviewed} active={reviewing} /><ChevronRight size={17} /><Step number="04" title="Send to FCM" detail="Straight from the card" complete={sentCount > 0} active={sendingKey !== null} /><ChevronRight size={17} /><Step number="05" title="Exact image" detail="Optional forensic copy" complete={stage === 'complete'} active={stage === 'cloning' || stage === 'verifying'} /></section>
        : <section className="steps"><Step number="01" title="Choose files" detail="On this computer or synced" complete={Boolean(videoFolder)} active={folderBusy} /><ChevronRight size={17} /><Step number="02" title="Files" detail="Check each start time" complete={Boolean(videoFolder?.files.length)} /><ChevronRight size={17} /><Step number="03" title="Review here" detail="Optional · on this computer" complete={reviewed} active={reviewing} /><ChevronRight size={17} /><Step number="04" title="Send to FCM" detail="Hashed before sending" complete={sentCount > 0} active={sendingKey !== null} /></section>}
      <div className="grid">
        {mode === 'card' && <section className="panel source-panel"><div className="panel-heading"><div><span className="eyebrow">01 / Source</span><h2>Read-only device discovery</h2></div><Activity size={19} /></div><p className="muted">FCM opens the source read-only and never mounts or writes the camera card. A Dahua card usually shows in Explorer as a RAW drive letter that Windows offers to format — cancel that prompt; the letter is the hidden DHFS partition, not a fault. Reading a whole disk needs administrator rights, so FCM Desktop V2 asks for them once when it starts.</p><button className="primary" onClick={() => void discover()} disabled={stage === 'discovery'}><HardDrive size={16} /> {stage === 'discovery' ? 'Scanning...' : 'Discover camera cards and disks'}</button>{devices.length > 0 && <div className="device-list">{devices.map((device) => <button key={device.id} className={`device ${selectedDevice?.id === device.id ? 'is-selected' : ''}`} onClick={() => { setSelectedDevice(device); setProbe(null); }}><span className="device-icon"><HardDrive size={17} /></span><span><strong>{device.driveLetters.length ? `${device.driveLetters.join(' ')} · ` : ''}{device.label}</strong><small>{device.id} · {formatBytes(device.sizeBytes)} · {device.busType}{device.removable ? ' (removable)' : ''} · {device.partitionStyle} · {device.partitions} partition{device.partitions === 1 ? '' : 's'}{device.offline ? ' · offline' : ''} · {device.readOnly ? 'read-only' : 'write protection unknown'}</small></span><CheckCircle2 size={16} /></button>)}</div>}{selectedDevice && <div className="source-facts"><span>Selected source<strong>{selectedDevice.driveLetters.length ? `${selectedDevice.driveLetters.join(' ')} · ` : ''}{selectedDevice.label}</strong></span><span>Capacity<strong>{selectedSize}</strong></span><span>Write mode<strong>Blocked</strong></span></div>}{selectedDevice && <div className="actions"><button className="secondary" onClick={() => void readCatalog({ kind: 'device', id: selectedDevice.id, sizeBytes: selectedDevice.sizeBytes })} disabled={catalogBusy || stage === 'cloning'}><Clapperboard size={16} /> {catalogBusy && catalogSource?.kind === 'device' ? 'Reading card...' : 'List recordings directly from card'}</button><button className="secondary" onClick={() => void probeDevice(selectedDevice)} disabled={probing || catalogBusy}><Search size={16} /> {probing ? 'Probing...' : 'Probe first sectors'}</button><small className="muted">Read-only, no clone. This is the normal path: list what the card holds, then send or extract the recordings you need.</small></div>}{probe && <div className="probe"><strong>Card probe · {probe.id} · {formatBytes(probe.sizeBytes)}</strong><dl><div><dt>DHFS volume</dt><dd>{probe.dhfsLocation ?? probe.dhfsError ?? '—'}</dd></div>{!probe.sector0Hex ? <div><dt>Sectors</dt><dd>not read — the disk could not be opened, so nothing below was checked</dd></div> : <><div><dt>DHFS4.1 at sector 0</dt><dd>{probe.dhfsMagicAtZero ? 'yes' : probe.dhfsLocation ? 'no — expected: this card carries a partition table and the volume was found through it' : 'no'}</dd></div><div><dt>DHFS_DPT marker</dt><dd>{probe.dhfsDptMarkerWithinFirstMib === null ? (probe.dhfsLocation ? 'not in first MiB — not needed, located via the partition table' : 'not in first MiB') : `byte ${probe.dhfsDptMarkerWithinFirstMib.toLocaleString()}`}</dd></div><div><dt>MBR</dt><dd>{probe.mbrSignature ? (probe.mbrPartitions.length ? probe.mbrPartitions.join('; ') : 'signature present, no partition entries') : 'no MBR signature (superfloppy / raw)'}</dd></div><div><dt>Sector 0 (first 64 bytes)</dt><dd className="mono">{probe.sector0Hex}<br />{probe.sector0Ascii}</dd></div></>}</dl><small className="muted">{probe.dhfsLocation ? 'The card is recognised. Use “List recordings directly from card” to see what it holds.' : 'Copy this block into a support message if the card is not recognised.'}</small></div>}</section>}
        {mode === 'files' && <section className="panel source-panel"><div className="panel-heading"><div><span className="eyebrow">01 / Source</span><h2>A folder of video files</h2></div><FolderOpen size={19} /></div><p className="muted">Any folder this computer can see: a camera or NVR export, a download, a phone backup, or a folder synced from OneDrive, Google Drive or Dropbox (files that are only in the cloud are fetched by the sync client when FCM reads them). MP4, MOV, MKV, AVI, TS, WebM and raw Dahua .dav / H.264 / H.265 files are listed; other files are ignored, and subfolders are not searched.</p><div className="actions"><button className="primary" onClick={() => void chooseVideoFiles()} disabled={folderBusy || busyAnywhere}><Film size={16} /> {folderBusy ? 'Reading…' : videoFolder ? 'Choose other video files' : 'Choose video files'}</button><button className="secondary" onClick={() => void chooseVideoFolder()} disabled={folderBusy || busyAnywhere}><FolderOpen size={16} /> Choose a whole folder</button>{videoFolder && <small className="muted mono">{videoFolder.picked ? `${videoFolder.files.length} chosen from ` : ''}{videoFolder.directory}</small>}</div><p className="muted small">“Choose video files” shows the files and lets you pick one or many. Windows’ folder picker shows folders only — it looks empty even in a folder full of videos — so use “Choose a whole folder” only when you want everything in it.</p><p className="muted small">Files are read where they are and never changed. Each one is hashed (SHA-256) before it is sent, so FCM can verify what arrived; the file stays in your folder afterwards.</p></section>}
        <section className="panel recordings-panel"><div className="panel-heading"><div><span className="eyebrow">02 / {mode === 'card' ? 'Recordings' : 'Files'}</span><h2>{mode === 'card' ? 'What the card holds' : videoFolder ? (videoFolder.picked ? 'The files you chose' : 'What the folder holds') : 'Choose files first'}</h2></div><Clapperboard size={19} /></div>
          {mode === 'card' && !catalog && <p className="muted">{catalogBusy ? 'Reading the partition table, superblock and fragment descriptors...' : 'Pick the card above and choose “List recordings directly from card”. Recordings are listed by day; nothing is copied until you send or save one.'}</p>}
          {mode === 'files' && !videoFolder && <p className="muted">{folderBusy ? 'Reading the chosen files…' : 'Choose video files (or a whole folder) above. Files are listed by their recorded day; nothing is read until you preview or send one.'}</p>}
          {((mode === 'card' && catalog && catalogPartition) || (mode === 'files' && videoFolder)) && <>
            {mode === 'card' && catalog && catalogPartition && <>
              <div className="facts"><span>Source<strong>{sourceLabel(catalogSource)}</strong></span><span>Recordings<strong>{catalog.recordings.length} · {formatBytes(totalRecordingBytes)}</strong></span><span>Layout<strong>{formatBytes(catalogPartition.fragmentSize)} fragments · {catalogPartition.descriptorCount.toLocaleString()} descriptors</strong></span></div>
              <p className="muted small">Volume at byte {catalog.volume.location.baseOffset.toLocaleString()} ({locationLabel(catalog.volume)}). {catalog.volume.tableNote}{catalog.skippedDescriptors ? ` ${catalog.skippedDescriptors} untrustworthy descriptor${catalog.skippedDescriptors === 1 ? '' : 's'} skipped, not silently included.` : ''}</p>
            </>}
            {mode === 'files' && videoFolder && <div className="facts"><span>{videoFolder.picked ? 'Chosen from' : 'Folder'}<strong className="mono">{videoFolder.directory}</strong></span><span>Video files<strong>{videoFolder.files.length} · {formatBytes(videoFolder.files.reduce((sum, file) => sum + file.bytes, 0))}</strong></span><span>{videoFolder.picked ? 'Set aside' : 'Not included'}<strong>{videoFolder.picked ? `${videoFolder.otherFiles} pick${videoFolder.otherFiles === 1 ? '' : 's'} (not video, or empty)` : `${videoFolder.subfolders} subfolder${videoFolder.subfolders === 1 ? '' : 's'} · ${videoFolder.otherFiles} other file${videoFolder.otherFiles === 1 ? '' : 's'}`}</strong></span></div>}
            <div className="actions">{importRow && <button className="primary" onClick={() => void sendAll()} disabled={busyAnywhere || unsentItems.length === 0}><UploadCloud size={15} /> {unsentItems.length === 0 ? (skippedCount ? `Nothing left to send (${skippedCount} skipped)` : mode === 'card' ? 'All recordings sent' : 'All files sent') : `Send all ${unsentItems.length} to FCM${skippedCount ? ` (${skippedCount} skipped)` : ''}`}</button>}{queueRemaining > 0 && <button className="secondary" onClick={() => void stopQueue()}>Stop sending ({queueRemaining} left)</button>}{mode === 'card' && <button className="secondary" onClick={() => void chooseDestination()} disabled={sendingKey !== null}><FolderOpen size={15} /> {destinationDirectory ? 'Change working folder' : 'Choose working folder'}</button>}{mode === 'card' && <small className="muted mono">{destinationDirectory ?? 'Working folder: Public Documents\\fcm-acquisitions, chosen automatically'}</small>}</div>
            {!importRow && <p className="muted small">{fcmSession ? `Create the import under “Send to FCM” to send ${mode === 'card' ? 'recordings straight from the card' : 'files from this folder'}. “Preview” shows what a recording holds on this computer first${mode === 'card' ? '; “Save to folder” writes the hashed original and a playable MP4 wherever you choose' : ''}.` : `Sign in under “Send to FCM” to send ${mode === 'card' ? 'recordings straight from the card' : 'files from this folder'}. “Preview” shows what a recording holds on this computer first${mode === 'card' ? '; “Save to folder” writes the hashed original and a playable MP4 wherever you choose' : ''}.`}</p>}
            {sentCount > 0 && <p className="muted small">{sentCount} recording{sentCount === 1 ? '' : 's'} sent to FCM{mode === 'card' ? `: video with the SHA-256 taken as it left the card (the analysis worker re-hashes on intake), pictures as dated timeline events. Copies stay in ${destinationDirectory ?? 'the working folder'}.` : ', each with the SHA-256 taken before it left this computer; the files themselves are untouched.'}</p>}
            {items.length > 0 && <div className="mark-bar" role="toolbar" aria-label="Filter by mark"><button type="button" className={`mark-filter ${markFilter === 'all' ? 'is-active' : ''}`} onClick={() => setMarkFilter('all')}>All {items.length}</button><button type="button" className={`mark-filter ${markFilter === 'unmarked' ? 'is-active' : ''}`} onClick={() => setMarkFilter('unmarked')}>Unmarked {markCounts.unmarked}</button>{MARKS.map((mark) => <button key={mark.id} type="button" className={`mark-filter mark__dot--${mark.id} ${markFilter === mark.id ? 'is-active' : ''}`} onClick={() => setMarkFilter(mark.id)} title={mark.hint}><span className="mark__dot" />{mark.label} {markCounts[mark.id]}</button>)}<small className="muted">Marks are your working notes, kept on this computer for this {mode === 'card' ? 'card' : 'folder'}. “Reviewed” and “Nothing here” are left out of “Send all”; the mark travels with a sent recording as provenance only.</small></div>}
            {mode === 'card' && <p className="muted small">Sizes listed below are what the card reserves for a recording; what is actually sent is only the frames the camera dated inside it — a previous occupant's leftovers and the card's own bookkeeping are left behind.</p>}
            {mode === 'files' && <p className="muted small">Recorded start times come from the file name when the recorder wrote one there, otherwise from the file's own metadata, otherwise estimated from when the file was last written. Check them — type a correction if you know better — before sending; the camera clock time zone under “Send to FCM” turns them into real instants.</p>}
            {mode === 'card' && catalog?.recordings.length === 0 && <p className="muted">The volume is intact but holds no trustworthy recordings.</p>}
            {mode === 'files' && videoFolder?.files.length === 0 && <p className="muted">No video files directly in this folder{videoFolder.subfolders ? ' — its subfolders were not searched; choose one of them' : ''}.</p>}
            {mode === 'card' && <div className="recording-days">{recordingDays.map(([day, recordings]) => <div className="recording-day" key={day}><div className="recording-day__head"><strong>{day}</strong><small>{recordings.length} recording{recordings.length === 1 ? '' : 's'} · {formatBytes(recordings.reduce((sum, recording) => sum + recording.bytes, 0))}{renderDaySummary(recordings.map(recordingKey))}</small>{importRow && <button type="button" className="secondary day-place" onClick={() => { setPlaceEditor(placeEditor === `day:${day}` ? null : `day:${day}`); setPlaceQuery(''); }}><MapPin size={12} /> Place for this day</button>}</div>{placeEditor === `day:${day}` && renderPlaceEditor(recordings.map(recordingKey).filter((key) => !isSent(key)), () => setPlaceEditor(null))}
              {recordings.map((recording) => { const item: SourceItem = { kind: 'card', key: recordingKey(recording), recording }; const { key } = item; const clip = clips[key]; const send = sends[key]; const reviewState = reviews[key]; const isSkipped = Boolean(skipped[key]); const isOpen = openReview === key; const inFlight = send && send.status !== 'done' && send.status !== 'failed'; const saved = saves[key]; if (!passesFilter(key)) return null; const mark = marks[key]; const sentRecord = sentRecords[key]; const rowSent = send?.status === 'done' || Boolean(sentRecord); const place = placeFor(key); const overridden = Boolean(places[key]); return <Fragment key={key}><div className={`recording ${clip ? 'is-extracted' : ''} ${rowSent ? 'is-sent' : ''} ${isSkipped ? 'is-skipped' : ''} ${mark ? `is-mark-${mark}` : ''}`}><span className="recording__time">{formatClock(recording.start)}</span><span className="recording__meta"><strong>{mark && <span className={`mark__dot mark__dot--${mark}`} title={markLabel(mark)} aria-label={markLabel(mark)} />}Channel {recording.channel} · {formatDuration(recording.durationSeconds)}{importRow && place && <button type="button" className={`place-chip ${overridden ? 'is-overridden' : ''}`} onClick={() => { setPlaceEditor(placeEditor === key ? null : key); setPlaceQuery(''); }} disabled={rowSent} title={overridden ? 'This recording goes to a different place than the import default. Click to change.' : 'Goes to the import\u2019s place. Click to send this recording to a different place.'}><MapPin size={11} /> {houseName(place.houseId) ?? 'place'}{overridden ? ' · ' + place.cameraLabel : ''}</button>}</strong><small>to {formatClock(recording.end)} · {formatBytes(recording.bytes)} · {recording.fragmentCount} fragment{recording.fragmentCount === 1 ? '' : 's'} · descriptor {recording.descriptor}</small>{clip && <small className="mono">{clip.fileName} · {describeClip(clip)} · SHA-256 {clip.sha256.slice(0, 16)}…</small>}{saved && <small className="send-state send-state--saved"><CheckCircle2 size={11} /> Saved to {saved.directory} — {saved.fileName}{saved.mp4 ? ` + ${saved.mp4.path.split(/[\\/]/).pop()} (${mp4Label(saved.mp4)})` : ''}</small>}{isSkipped && send?.status !== 'done' && <small className="send-state send-state--skipped">Skipped by you — left out of “Send all”; still on the card{clip ? ' and in the working folder' : ''}.</small>}{inFlight && <div className={`progress recording__progress ${send.status === 'uploading' ? '' : 'is-indeterminate'}`} role="progressbar" aria-busy={send.status !== 'uploading'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={send.total ? Math.floor((send.sent / send.total) * 100) : 0}><div style={send.status === 'uploading' ? { width: `${send.total ? Math.min(100, (send.sent / send.total) * 100) : 0}%` } : undefined} /></div>}{send && <small className={`send-state send-state--${send.status}`}>{send.status === 'extracting' ? 'Reading from card…' : sendLabel[send.status]}{send.status === 'uploading' && send.total ? (clip?.kind === 'pictures' ? ` picture ${send.sent} of ${send.total}` : ` ${formatBytes(send.sent)} of ${formatBytes(send.total)}`) : ''}{send.error ? ` — ${send.error}` : ''}</small>}{sentRecord && !send && <small className="send-state send-state--done">Sent to FCM {new Date(sentRecord.sentAt).toLocaleString()}{fcmVerified[key] === 'verified' ? ' · FCM verified the hash' : fcmVerified[key] === 'mismatch' ? ' · FCM reports a HASH MISMATCH — keep the local copy' : ''}</small>}{placeEditor === key && renderPlaceEditor([key], () => setPlaceEditor(null))}</span><span className="recording__actions"><MarkPicker compact value={mark ?? null} onChange={(next) => setMark(item, next)} /><button className="secondary" onClick={() => { if (isOpen) setOpenReview(null); else void review(item); }} disabled={busyAnywhere || reviewState?.busy === 'filmstrip'}><Film size={14} /> {reviewState?.busy === 'filmstrip' ? 'Decoding…' : isOpen ? 'Close preview' : reviewState?.filmstrip ? 'Show preview' : 'Preview'}</button>{importRow && <button className="primary" onClick={() => void sendOne(item)} disabled={busyAnywhere || rowSent}><Send size={14} /> {rowSent ? 'Sent' : sendingKey === key && send ? (send.status === 'extracting' ? 'Reading from card…' : sendLabel[send.status]) : send?.status === 'failed' ? 'Send again' : clip?.kind === 'pictures' ? 'Send pictures to FCM' : 'Send to FCM'}</button>}<button className="secondary" onClick={() => void extract(recording)} disabled={busyAnywhere} title={saved ? `Already saved to ${saved.directory}. Click to save another copy elsewhere (you will be asked first).` : 'Choose a folder; the hashed original and a playable MP4 are written there.'}>{saved ? <CheckCircle2 size={14} /> : <Download size={14} />} {extracting === key ? 'Saving…' : saved ? 'Saved' : 'Save to folder…'}</button></span></div>
              {isOpen && renderReview(item, clip, reviewState, send, isSkipped, `channel ${recording.channel} at ${formatClock(recording.start)}`)}</Fragment>; })}
            </div>)}</div>}
            {mode === 'files' && <div className="recording-days">{fileDays.map(([day, files]) => <div className="recording-day" key={day}><div className="recording-day__head"><strong>{day}</strong><small>{files.length} file{files.length === 1 ? '' : 's'} · {formatBytes(files.reduce((sum, file) => sum + file.bytes, 0))}{renderDaySummary(files.map(fileKey))}</small>{importRow && <button type="button" className="secondary day-place" onClick={() => { setPlaceEditor(placeEditor === `day:${day}` ? null : `day:${day}`); setPlaceQuery(''); }}><MapPin size={12} /> Place for this day</button>}</div>{placeEditor === `day:${day}` && renderPlaceEditor(files.map(fileKey).filter((key) => !isSent(key)), () => setPlaceEditor(null))}
              {files.map((file) => { const item: SourceItem = { kind: 'file', key: fileKey(file), file }; const { key } = item; const clip = clips[key]; const send = sends[key]; const reviewState = reviews[key]; const isSkipped = Boolean(skipped[key]); const isOpen = openReview === key; const inFlight = send && send.status !== 'done' && send.status !== 'failed'; const clock = fileClocks[key]; if (!passesFilter(key)) return null; const mark = marks[key]; const sentRecord = sentRecords[key]; const rowSent = send?.status === 'done' || Boolean(sentRecord); const place = placeFor(key); const overridden = Boolean(places[key]); return <Fragment key={key}><div className={`recording ${clip ? 'is-extracted' : ''} ${rowSent ? 'is-sent' : ''} ${isSkipped ? 'is-skipped' : ''} ${mark ? `is-mark-${mark}` : ''}`}><span className="recording__time">{clock ? formatClock(clock.start) : '—'}</span><span className="recording__meta"><strong>{mark && <span className={`mark__dot mark__dot--${mark}`} title={markLabel(mark)} aria-label={markLabel(mark)} />}{file.fileName}{importRow && place && <button type="button" className={`place-chip ${overridden ? 'is-overridden' : ''}`} onClick={() => { setPlaceEditor(placeEditor === key ? null : key); setPlaceQuery(''); }} disabled={rowSent} title={overridden ? 'This recording goes to a different place than the import default. Click to change.' : 'Goes to the import\u2019s place. Click to send this recording to a different place.'}><MapPin size={11} /> {houseName(place.houseId) ?? 'place'}{overridden ? ' · ' + place.cameraLabel : ''}</button>}</strong><small>{formatBytes(file.bytes)} · {file.extension.toUpperCase()} · last written {formatWhen(file.modifiedEpochMs)}{clip && clip.durationSeconds > 0 ? ` · ${formatDuration(clip.durationSeconds)}` : ''}</small><label className="clock-edit"><span>Recorded start · {clock ? clockSourceLabel[clock.source] : 'not known'}</span><input type="datetime-local" step={1} value={clock ? clockToInputValue(clock.start) : ''} onChange={(event) => setFileStart(file, event.target.value)} disabled={send?.status === 'done' || sendingKey === key} aria-label={`Recorded start of ${file.fileName}`} /></label>{clip && <small className="mono">{describeClip(clip)} · SHA-256 {clip.sha256.slice(0, 16)}…</small>}{isSkipped && send?.status !== 'done' && <small className="send-state send-state--skipped">Skipped by you — left out of “Send all”.</small>}{inFlight && <div className={`progress recording__progress ${send.status === 'uploading' ? '' : 'is-indeterminate'}`} role="progressbar" aria-busy={send.status !== 'uploading'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={send.total ? Math.floor((send.sent / send.total) * 100) : 0}><div style={send.status === 'uploading' ? { width: `${send.total ? Math.min(100, (send.sent / send.total) * 100) : 0}%` } : undefined} /></div>}{send && <small className={`send-state send-state--${send.status}`}>{send.status === 'extracting' ? 'Hashing file…' : sendLabel[send.status]}{send.status === 'uploading' && send.total ? ` ${formatBytes(send.sent)} of ${formatBytes(send.total)}` : ''}{send.error ? ` — ${send.error}` : ''}</small>}{sentRecord && !send && <small className="send-state send-state--done">Sent to FCM {new Date(sentRecord.sentAt).toLocaleString()}{fcmVerified[key] === 'verified' ? ' · FCM verified the hash' : fcmVerified[key] === 'mismatch' ? ' · FCM reports a HASH MISMATCH — keep the local copy' : ''}</small>}{placeEditor === key && renderPlaceEditor([key], () => setPlaceEditor(null))}</span><span className="recording__actions"><MarkPicker compact value={mark ?? null} onChange={(next) => setMark(item, next)} /><button className="secondary" onClick={() => { if (isOpen) setOpenReview(null); else void review(item); }} disabled={busyAnywhere || reviewState?.busy === 'filmstrip'}><Film size={14} /> {reviewState?.busy === 'filmstrip' ? 'Decoding…' : isOpen ? 'Close preview' : reviewState?.filmstrip ? 'Show preview' : 'Preview'}</button>{importRow && <button className="primary" onClick={() => void sendOne(item)} disabled={busyAnywhere || rowSent}><Send size={14} /> {rowSent ? 'Sent' : sendingKey === key && send ? (send.status === 'extracting' ? 'Hashing file…' : sendLabel[send.status]) : send?.status === 'failed' ? 'Send again' : 'Send to FCM'}</button>}</span></div>
              {isOpen && renderReview(item, clip, reviewState, send, isSkipped, file.fileName)}</Fragment>; })}
            </div>)}</div>}
            {mode === 'card' && catalog && catalog.warnings.length > 0 && <details className="warnings"><summary>{catalog.warnings.length} descriptor warning{catalog.warnings.length === 1 ? '' : 's'}</summary><ul>{catalog.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></details>}
          </>}
        </section>
        <section className="panel review-panel" id="panel-review"><div className="panel-heading"><div><span className="eyebrow">03 / Review here</span><h2>See it before it leaves this computer</h2></div><Cpu size={19} /></div>
          <p className="muted">“Preview” on a recording decodes its key frames and, on request, a 480p viewing copy — on this computer, using the GPU when there is one. The card is only read; viewing copies live under this app's local data and are never sent or treated as evidence. Sending is unchanged: the extracted original goes to FCM with the SHA-256 taken from the card.</p>
          <div className="facts"><span>Decoder<strong>{decoder ? (decoder.installed ? `FFmpeg ${decoder.version} · hash verified` : decoder.rejectedReason ? 'present but rejected' : 'not installed') : decoderError ? 'status unavailable' : 'checking…'}</strong></span><span>Viewing copies<strong>{previewCount} this session</strong></span><span>Skipped<strong>{skippedCount} recording{skippedCount === 1 ? '' : 's'}</strong></span></div>
          {decoder && !decoder.installed && <>
            <p className="muted small">The decoder is a one-time download ({formatBytes(decoder.downloadBytes)}) of a pinned FFmpeg build. FCM checks its SHA-256 against a value compiled into this app and refuses anything else, including a build that has been swapped on disk later.{decoder.rejectedReason ? ` Currently: ${decoder.rejectedReason}.` : ''}</p>
            <div className="actions"><button className="primary" onClick={() => void installDecoder()} disabled={decoderBusy}><Download size={15} /> {decoderBusy ? 'Downloading and verifying…' : decoder.rejectedReason ? 'Install the decoder again' : 'Install decoder'}</button>{decoderProgress && <small className="muted">{formatBytes(decoderProgress.bytesDone)} of {formatBytes(decoderProgress.totalBytes || decoder.downloadBytes)}</small>}</div>
            {decoderBusy && <div className={`progress decoder-progress ${decoderProgress && decoderProgress.bytesDone > 0 ? '' : 'is-indeterminate'}`} role="progressbar" aria-busy={!decoderProgress || decoderProgress.bytesDone === 0} aria-valuemin={0} aria-valuemax={100} aria-valuenow={decoderProgress && decoderProgress.totalBytes ? Math.floor((decoderProgress.bytesDone / decoderProgress.totalBytes) * 100) : 0}><div style={decoderProgress && decoderProgress.bytesDone > 0 && decoderProgress.totalBytes ? { width: `${Math.min(100, (decoderProgress.bytesDone / decoderProgress.totalBytes) * 100)}%` } : undefined} /></div>}
          </>}
          {decoder?.installed && <div className="actions"><button className="secondary" onClick={() => void clearPreviews()} disabled={Object.values(reviews).some((review) => review.busy !== null)}><Trash2 size={15} /> Remove viewing copies</button><small className="muted">Frees disk under this app's local data. Extracted originals in the working folder and the card are untouched.</small></div>}
          <div className="disk" id="panel-disk">
            <div className="disk__head"><div><span className="eyebrow">Disk on this computer</span><strong>{disk ? `${formatBytes(disk.totalBytes)} in the working folder · ${formatBytes(disk.previewsBytes)} of viewing copies · ${formatBytes(disk.toolsBytes)} decoder` : 'Working copies, viewing copies and the decoder live on this computer.'}</strong></div><button className="secondary" onClick={() => void refreshDisk()} disabled={diskBusy || busyAnywhere || (!destinationDirectory && !catalogSource)}><HardDrive size={15} /> {diskBusy ? 'Checking…' : disk ? 'Check again' : 'Check disk use'}</button></div>
            {disk && diskGroups && <>
              <p className="muted small mono">{disk.directory}{disk.otherCardsFolders ? ` · ${disk.otherCardsFolders} other card folder${disk.otherCardsFolders === 1 ? '' : 's'} beside it hold ${formatBytes(disk.otherCardsBytes)} (open that card to tidy them)` : ''}</p>
              <div className="disk__groups">
                <div className="disk__group is-safe"><div><strong>Sent and verified by FCM</strong><small>{diskGroups.verifiedSent.length} file{diskGroups.verifiedSent.length === 1 ? '' : 's'} · {formatBytes(sumBytes(diskGroups.verifiedSent))} · FCM re-hashed each on intake and the hashes matched; the card still holds the original.</small></div><button className="secondary" disabled={diskBusy || !diskGroups.verifiedSent.length} onClick={() => void removeEntries(diskGroups.verifiedSent, 'verified working copies', 'FCM holds each of these and has verified its hash against the copy taken here. The recordings stay on the card.')}><Trash2 size={14} /> Remove</button></div>
                <div className="disk__group"><div><strong>Sent, awaiting FCM’s check</strong><small>{diskGroups.awaitingFcm.length} file{diskGroups.awaitingFcm.length === 1 ? '' : 's'} · {formatBytes(sumBytes(diskGroups.awaitingFcm))} · uploaded, but the analysis worker has not yet confirmed the hash{fcmSession ? '' : ' (sign in to check)'}. Kept until it does.</small></div><span className="disk__hold">Kept</span></div>
                <div className="disk__group is-safe"><div><strong>Marked “Nothing here” or “Reviewed”, not sent</strong><small>{diskGroups.decidedNo.length} file{diskGroups.decidedNo.length === 1 ? '' : 's'} · {formatBytes(sumBytes(diskGroups.decidedNo))} · you decided these need no further action; the originals stay on the card.</small></div><button className="secondary" disabled={diskBusy || !diskGroups.decidedNo.length} onClick={() => void removeEntries(diskGroups.decidedNo, 'working copies you marked as done', 'These were not sent to FCM. Their originals remain on the card and can be extracted again at any time.')}><Trash2 size={14} /> Remove</button></div>
                <div className="disk__group is-safe"><div><strong>Half-written files</strong><small>{diskGroups.partial.length} · {formatBytes(sumBytes(diskGroups.partial))} · left by an interrupted extraction; never valid evidence.</small></div><button className="secondary" disabled={diskBusy || !diskGroups.partial.length || Boolean(extracting)} onClick={() => void removeEntries(diskGroups.partial, 'half-written files', 'A .part file is an extraction that did not finish. Nothing reads it.')}><Trash2 size={14} /> Remove</button></div>
                <div className="disk__group"><div><strong>Undecided, or marked Keep / Review further</strong><small>{diskGroups.kept.length} file{diskGroups.kept.length === 1 ? '' : 's'} · {formatBytes(sumBytes(diskGroups.kept))} · not sent and not decided: kept until you mark or send them.</small></div><span className="disk__hold">Kept</span></div>
                <div className="disk__group"><div><strong>Saved on purpose</strong><small>{diskGroups.saved.length} · {formatBytes(sumBytes(diskGroups.saved))} · MP4s, exact images and copies you chose “Save to folder” for. Yours to manage; this app does not remove them.</small></div><span className="disk__hold">Yours</span></div>
                {diskGroups.unknown.length > 0 && <div className="disk__group"><div><strong>Not from this card</strong><small>{diskGroups.unknown.length} · {formatBytes(sumBytes(diskGroups.unknown))} · files this listing does not recognise (another card’s recordings, or renamed). Left alone.</small></div><span className="disk__hold">Left alone</span></div>}
              </div>
              <p className="muted small">Removal never reaches outside this working folder, never follows links, and never touches the card. Removed copies can be extracted again from the card while it is available.</p>
            </>}
          </div>
          {decoder && <p className="muted small">{decoder.licence}. The licence text ships with the download: <span className="mono">{decoder.licenceUrl}</span></p>}
          {decoderError && <p className="review__error">{decoderError}</p>}
        </section>
        <section className="panel send-panel" id="panel-send"><div className="panel-heading"><div><span className="eyebrow">04 / Send to FCM</span><h2>{importRow ? 'Import ready' : fcmSession ? 'Where does this footage belong?' : 'Sign in to FCM'}</h2></div><Send size={19} /></div>
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
            <div className="facts"><span>Client<strong>{organizations.find((organization) => organization.organizationId === importRow.organization_id)?.organizationName ?? 'organisation'}</strong></span><span>Camera<strong>{importRow.camera_label}</strong></span><span>Sent<strong>{sentCount} of {items.length}</strong></span></div>
            <div className="place-list"><span className="eyebrow">Places on this {mode === 'card' ? 'card' : 'folder'}</span>{[...placesInUse.entries()].map(([id, n]) => <span key={id} className={`place-chip ${id === importRow.location_id ? '' : 'is-overridden'}`}><MapPin size={11} /> {houseName(id) ?? 'place'} · {n} recording{n === 1 ? '' : 's'}{id === importRow.location_id ? ' (import default)' : ''}</span>)}<small className="muted">A portable camera moves: set a different place on a recording or a whole day and it is sent under its own import for that place, same client, same camera label unless you change it.</small></div>
            <p className="muted small">Import {importRow.id.slice(0, 8)}… Recordings sent here appear in FCM → CCTV review under this camera at {selectedHouse?.name ?? 'the chosen place'}, each carrying the SHA-256 taken as it left the card.</p>
            <div className="actions"><button className="secondary" onClick={() => { setImportRow(null); setSends({}); doneClipsRef.current = {}; }} disabled={sendingKey !== null}>Start another import</button></div>
          </>}
        </section>
        {mode === 'card' && <section className="panel acquire-panel"><div className="panel-heading"><div><span className="eyebrow">05 / Optional</span><h2>Exact image of the whole card</h2></div><LockKeyhole size={19} /></div><p className="muted">Not needed to send recordings. An exact image is a forensic bit-for-bit copy of the <em>entire</em> card, empty space included, for when the card itself must be handed back or overwritten and you still need to prove nothing changed.{selectedDevice ? ` This ${formatBytes(selectedDevice.sizeBytes)} card needs the same free space on the destination drive and roughly ${estimateCloneMinutes(selectedDevice.sizeBytes)} minutes to clone over USB, then as long again to verify.` : ''}</p><div className="actions"><button className="primary" onClick={() => void acquire()} disabled={!selectedDevice || stage === 'cloning' || stage === 'verifying'}><Square size={15} /> {stage === 'cloning' ? 'Cloning...' : stage === 'verifying' ? 'Verifying...' : 'Acquire exact image'}</button>{(stage === 'cloning' || stage === 'verifying') && <button className="secondary" onClick={() => void cancelAcquisition()} disabled={cancelling || stage === 'verifying'}>{cancelling ? 'Cancelling...' : 'Cancel'}</button>}</div><div className={`status-card status-${stage}`}><span>{stageLabel[stage]}</span><strong>{receipt ? `${formatBytes(receipt.bytesCopied)} copied` : progress ? `${formatBytes(progress.bytesDone)} of ${formatBytes(progress.totalBytes)} · ${progress.totalBytes ? Math.floor((progress.bytesDone / progress.totalBytes) * 100) : 0}%` : stage === 'cloning' ? 'Starting: opening the card read-only and writing the first blocks…' : stage === 'failed' ? (error ?? 'The last acquisition did not complete.') : 'No image acquired yet — not needed to work from the card'}</strong>{stage === 'cloning' && !progress && <div className="progress is-indeterminate" role="progressbar" aria-busy="true"><div /></div>}{progress && (stage === 'cloning' || stage === 'verifying') && <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.totalBytes ? Math.floor((progress.bytesDone / progress.totalBytes) * 100) : 0}><div style={{ width: `${progress.totalBytes ? Math.min(100, (progress.bytesDone / progress.totalBytes) * 100) : 0}%` }} /></div>}{progress && (stage === 'cloning' || stage === 'verifying') && <small className="mono">{progress.stage} · {formatRate(progress.bytesPerSecond)} · elapsed {formatDuration(progress.elapsedSeconds)} · remaining {progress.etaSeconds === null ? '—' : formatDuration(progress.etaSeconds)}</small>}<small>{status}</small></div>{receipt && <div className="receipt"><div><CheckCircle2 size={17} /><strong>Hash verification {receipt.verified ? 'passed' : 'needs review'}</strong></div><dl><div><dt>Source SHA-256</dt><dd>{receipt.sourceSha256}</dd></div><div><dt>Image SHA-256</dt><dd>{receipt.imageSha256}</dd></div><div><dt>Read errors</dt><dd>{receipt.readErrors}</dd></div></dl></div>}</section>}
        {mode === 'card' && <section className="panel inspect-panel"><div className="panel-heading"><div><span className="eyebrow">06 / Image inspection</span><h2>Virtual image inspection</h2></div><Search size={19} /></div><p className="muted">Only for an acquired image: run several adapters against the clone. Unknown layouts are preserved as investigation candidates instead of rejected.</p><button className="secondary" onClick={() => void inspectImage()} disabled={!receipt || decoderStage === 'scanning'}><Search size={16} /> {decoderStage === 'scanning' ? 'Inspecting...' : 'Inspect image and map partitions'}</button>{inspection && <div className="inspection"><div className="facts"><span>Image<strong>{formatBytes(inspection.imageBytes)}</strong></span><span>Signatures<strong>{inspection.signatures.length}</strong></span><span>DHFS<strong>{inspection.dhfs ? locationLabel(inspection.dhfs) : 'not found'}</strong></span></div><div className="signature-list">{inspection.signatures.map((signature) => <span key={signature}>{signature}</span>)}</div>{inspection.adapters.map((adapter) => <div className="adapter" key={adapter.name}><span className={`dot dot-${adapter.state}`} /><div><strong>{adapter.name}</strong><small>{adapter.detail}</small></div><em>{adapter.confidence}</em></div>)}</div>}</section>}
      </div>
      {error && <div className="error"><strong>Action blocked</strong><span>{error}</span></div>}
      <footer><span><ShieldCheck size={14} /> Recordings leave the card hashed; FCM re-hashes them on intake.</span><span>v{APP_VERSION} · {fcmSession ? `signed in as ${fcmProfile?.displayName ?? fcmSession.user.email}` : 'not signed in'} · {stageLabel[stage]}{catalog ? ` · ${catalog.recordings.length} recordings` : ''}{sentCount ? ` · ${sentCount} sent` : ''}</span></footer>
    </section>
  </main>;
}

// The earlier prototype exported App without ever mounting it, so the installed window rendered blank.
const root = document.getElementById('root');
if (root) createRoot(root).render(<StrictMode>{IS_POPOUT ? <PopoutViewer /> : <App />}</StrictMode>);
