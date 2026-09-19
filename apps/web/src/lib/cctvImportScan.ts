// Client-side classification of a camera folder / SD-card dump before anything is uploaded.
// Pure: no supabase, no DOM beyond File. Pinned by cctvImportScan.test.ts.

export type ScannedKind = 'video' | 'skipped_empty' | 'snapshot' | 'index' | 'other';
export type DeviceKind = 'tapo' | 'dahua' | 'hikvision' | 'reolink' | 'generic_folder' | 'single_file' | 'unknown';

export interface ScanInput {
  file: File;
  /** Path inside the chosen folder, '/'-separated, no leading slash. */
  relativePath: string;
}

export interface ScannedFile {
  file: File;
  name: string;
  relativePath: string;
  sizeBytes: number;
  kind: ScannedKind;
  skipReason?: string;
  /** Recording start/end (ISO, UTC) for videos; camera event window for snapshots. */
  slotStartAt?: string;
  slotEndAt?: string;
  /** Trailing code on TAPO snapshot names (e.g. 02, 06); meaning is device-specific. */
  snapshotCode?: string;
}

export interface ScanSummary {
  videoCount: number;
  skippedCount: number;
  snapshotCount: number;
  otherCount: number;
  videoBytes: number;
  snapshotBytes: number;
  recordedFrom: string | null;
  recordedTo: string | null;
}

export const DEFAULT_SOURCE_TIME_ZONE = 'Pacific/Auckland';
export const COMMON_TIME_ZONES = ['Pacific/Auckland', 'Pacific/Chatham', 'Australia/Sydney', 'Australia/Brisbane', 'Australia/Perth', 'UTC'];

const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'mkv', 'avi', 'm4v', 'ts', 'h264', 'h265', 'hevc', '264', '265', 'dav', 'asf', 'wmv', 'webm']);
const INDEX_EXTENSIONS = new Set(['index', 'idx', 'bin', 'db', 'sqlite', 'log', 'txt', 'json', 'xml', 'ini', 'dat']);
const TAPO_VIDEO = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_tp(\d+)\.mp4$/i;
const TAPO_EMPTY_SLOT = /^x{6,}_0{6}_tp\d+\.mp4$/i;
const TAPO_SNAPSHOT = /^(\d{9,10})_(\d{9,10})_(\d+)\.jpe?g$/i;
/** Recordings whose next slot starts within this window are treated as one continuous run. */
const CONTIGUOUS_SLOT_GAP_MS = 2 * 60 * 60 * 1000;
const EMPTY_HEADER_BYTES = 16;

export type HiddenPartitionVerdict = {
  likely: boolean;
  /** Plain-words reason a reviewer can act on; null when the folder simply holds no video. */
  reason: string | null;
};

/**
 * A browser can only see files the operating system mounts. Dahua (and some other) camera cards keep every
 * recording in a proprietary hidden partition and expose a small system partition to Windows, so a scan of the
 * visible drive finds nothing usable. Name that plainly instead of "no videos found", and point at the desktop
 * reader that reads the card raw.
 */
export function assessHiddenPartitionCard(scanned: Array<Pick<ScannedFile, 'kind' | 'name' | 'relativePath' | 'sizeBytes'>>, folderLabel: string | null): HiddenPartitionVerdict {
  const usable = scanned.some((item) => item.kind === 'video' || item.kind === 'snapshot');
  if (usable) return { likely: false, reason: null };
  const names = scanned.map((item) => item.name.toLowerCase());
  const dahuaMarker = names.some((name) => /^(dhfs|dh_|dahua)/.test(name) || /\.(dav|idx)$/.test(name)) || scanned.some((item) => /(^|\/)(dvr_?(data|root)|dhfs)/i.test(item.relativePath));
  const driveRoot = folderLabel !== null && /^([a-z]:)?[\\/]?$/i.test(folderLabel.trim());
  const smallSystemFiles = scanned.length > 0 && scanned.length <= 40 && scanned.every((item) => item.sizeBytes < 64 * 1024 * 1024);
  if (dahuaMarker) {
    return { likely: true, reason: 'This is the visible part of a Dahua camera card. The recordings are in a hidden DHFS partition that Windows and the browser cannot read.' };
  }
  if (driveRoot && smallSystemFiles) {
    return { likely: true, reason: 'This drive shows only small device files. Camera cards that record to a hidden partition (Dahua and similar) look exactly like this from Windows.' };
  }
  return { likely: false, reason: null };
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function baseName(relativePath: string): string {
  const slash = relativePath.lastIndexOf('/');
  return slash >= 0 ? relativePath.slice(slash + 1) : relativePath;
}

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(utcMs)).map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return asUtc - utcMs;
}

/** A wall-clock time recorded in `timeZone` (camera local time) as an ISO instant. */
export function zonedWallClockToIso(
  year: number, month: number, day: number, hour: number, minute: number, second: number, timeZone: string,
): string {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  let instant = guess - zoneOffsetMs(guess, timeZone);
  const secondPass = zoneOffsetMs(instant, timeZone);
  if (guess - secondPass !== instant) instant = guess - secondPass;
  return new Date(instant).toISOString();
}

export function parseTapoVideoName(name: string, timeZone: string): { startAt: string; slot: number } | null {
  const match = TAPO_VIDEO.exec(name);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, slot] = match;
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31 || Number(h) > 23 || Number(mi) > 59 || Number(s) > 60) return null;
  return { startAt: zonedWallClockToIso(Number(y), month, day, Number(h), Number(mi), Number(s), timeZone), slot: Number(slot) };
}

export function parseTapoSnapshotName(name: string): { startAt: string; endAt: string; code: string } | null {
  const match = TAPO_SNAPSHOT.exec(name);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return { startAt: new Date(start * 1000).toISOString(), endAt: new Date(end * 1000).toISOString(), code: match[3] };
}

/** True when the first bytes carry no container signature (an unused, pre-allocated ring slot). */
export function isEmptyVideoHeader(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true;
  const allZero = bytes.every((value) => value === 0);
  if (allZero) return true;
  const ascii = String.fromCharCode(...bytes.slice(0, 12));
  const hasIsoBmff = ascii.slice(4, 8) === 'ftyp' || ascii.slice(4, 8) === 'moov' || ascii.slice(4, 8) === 'mdat';
  const hasMatroska = bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  const hasAvi = ascii.slice(0, 4) === 'RIFF';
  const hasDahua = ascii.slice(0, 4) === 'DHAV';
  const hasAnnexB = bytes[0] === 0 && bytes[1] === 0 && (bytes[2] === 1 || (bytes[2] === 0 && bytes[3] === 1));
  return !(hasIsoBmff || hasMatroska || hasAvi || hasDahua || hasAnnexB);
}

export function detectDeviceKind(relativePaths: string[]): DeviceKind {
  if (relativePaths.length === 0) return 'unknown';
  const names = relativePaths.map(baseName);
  if (names.some((name) => TAPO_VIDEO.test(name) || TAPO_EMPTY_SLOT.test(name)) || relativePaths.some((path) => /(^|\/)snapshot\//.test(path) && TAPO_SNAPSHOT.test(baseName(path)))) return 'tapo';
  if (names.some((name) => /\.dav$/i.test(name)) || relativePaths.some((path) => /(^|\/)DVR_?(Data|ROOT)/i.test(path))) return 'dahua';
  if (relativePaths.some((path) => /(^|\/)datadir\d*\//i.test(path) || /^hiv\d+\.mp4$/i.test(baseName(path)))) return 'hikvision';
  if (relativePaths.some((path) => /(^|\/)Mp4Record\//i.test(path))) return 'reolink';
  const videoCount = names.filter((name) => VIDEO_EXTENSIONS.has(extensionOf(name))).length;
  if (videoCount === 1 && relativePaths.length === 1) return 'single_file';
  return videoCount > 0 ? 'generic_folder' : 'unknown';
}

async function readHeader(file: File): Promise<Uint8Array> {
  const slice = file.slice(0, EMPTY_HEADER_BYTES);
  if (typeof slice.arrayBuffer === 'function') return new Uint8Array(await slice.arrayBuffer());
  if (typeof FileReader === 'function') {
    return new Promise<Uint8Array>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error('read failed'));
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
      reader.readAsArrayBuffer(slice);
    });
  }
  return new Uint8Array(await new Response(slice).arrayBuffer());
}

/** Classify every file in the folder. Video headers are read (16 bytes each) so unused ring slots are skipped, not failed. */
export async function classifyFolder(inputs: ScanInput[], timeZone: string): Promise<ScannedFile[]> {
  const zone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_SOURCE_TIME_ZONE;
  const scanned: ScannedFile[] = [];
  for (const input of inputs) {
    const name = baseName(input.relativePath);
    const ext = extensionOf(name);
    const base: ScannedFile = { file: input.file, name, relativePath: input.relativePath, sizeBytes: input.file.size, kind: 'other' };
    if (/(^|\/)snapshot\//i.test(input.relativePath) && (ext === 'jpg' || ext === 'jpeg')) {
      const snapshot = parseTapoSnapshotName(name);
      scanned.push(snapshot
        ? { ...base, kind: 'snapshot', slotStartAt: snapshot.startAt, slotEndAt: snapshot.endAt, snapshotCode: snapshot.code }
        : { ...base, kind: 'other', skipReason: 'snapshot name carries no event window' });
      continue;
    }
    if (VIDEO_EXTENSIONS.has(ext)) {
      if (TAPO_EMPTY_SLOT.test(name)) {
        scanned.push({ ...base, kind: 'skipped_empty', skipReason: 'pre-allocated ring slot never recorded' });
        continue;
      }
      if (input.file.size === 0) {
        scanned.push({ ...base, kind: 'skipped_empty', skipReason: 'zero-byte file' });
        continue;
      }
      let header: Uint8Array;
      try {
        header = await readHeader(input.file);
      } catch {
        scanned.push({ ...base, kind: 'other', skipReason: 'file could not be read' });
        continue;
      }
      if (isEmptyVideoHeader(header)) {
        scanned.push({ ...base, kind: 'skipped_empty', skipReason: 'no video container signature in the first bytes' });
        continue;
      }
      const tapo = parseTapoVideoName(name, zone);
      scanned.push({ ...base, kind: 'video', slotStartAt: tapo?.startAt });
      continue;
    }
    if (INDEX_EXTENSIONS.has(ext) || /^(diagnose_log|index_info|md5_check|sys\d+[a-z]?)$/i.test(name.replace(/\.[^.]+$/, ''))) {
      scanned.push({ ...base, kind: 'index', skipReason: 'device index / diagnostics, kept out of evidence' });
      continue;
    }
    scanned.push({ ...base, kind: 'other', skipReason: 'not a video or snapshot' });
  }
  return withSlotEnds(scanned);
}

/** A slot ends where the next contiguous slot starts; the last (or an isolated) slot has no known end until the worker measures it. */
export function withSlotEnds(scanned: ScannedFile[]): ScannedFile[] {
  const videos = scanned.filter((item) => item.kind === 'video' && item.slotStartAt).sort((a, b) => a.slotStartAt!.localeCompare(b.slotStartAt!));
  const ends = new Map<string, string>();
  videos.forEach((item, index) => {
    const next = videos[index + 1];
    if (!next) return;
    const gap = Date.parse(next.slotStartAt!) - Date.parse(item.slotStartAt!);
    if (gap > 0 && gap <= CONTIGUOUS_SLOT_GAP_MS) ends.set(item.relativePath, next.slotStartAt!);
  });
  return scanned.map((item) => (ends.has(item.relativePath) ? { ...item, slotEndAt: ends.get(item.relativePath) } : item));
}

export function summarize(scanned: ScannedFile[]): ScanSummary {
  const videos = scanned.filter((item) => item.kind === 'video');
  const snapshots = scanned.filter((item) => item.kind === 'snapshot');
  const starts = videos.map((item) => item.slotStartAt).filter((value): value is string => Boolean(value)).sort();
  const endsOrStarts = videos.map((item) => item.slotEndAt ?? item.slotStartAt).filter((value): value is string => Boolean(value)).sort();
  return {
    videoCount: videos.length,
    skippedCount: scanned.filter((item) => item.kind === 'skipped_empty').length,
    snapshotCount: snapshots.length,
    otherCount: scanned.filter((item) => item.kind === 'index' || item.kind === 'other').length,
    videoBytes: videos.reduce((sum, item) => sum + item.sizeBytes, 0),
    snapshotBytes: snapshots.reduce((sum, item) => sum + item.sizeBytes, 0),
    recordedFrom: starts[0] ?? null,
    recordedTo: endsOrStarts[endsOrStarts.length - 1] ?? null,
  };
}

/** Manifest rows for set_cctv_import_manifest (files only; never the File objects). */
export function buildManifest(scanned: ScannedFile[]): Array<Record<string, unknown>> {
  return scanned.map((item) => ({
    name: item.name,
    relative_path: item.relativePath,
    size_bytes: item.sizeBytes,
    kind: item.kind,
    ...(item.skipReason ? { skip_reason: item.skipReason } : {}),
    ...(item.slotStartAt ? { slot_start_at: item.slotStartAt } : {}),
    ...(item.slotEndAt ? { slot_end_at: item.slotEndAt } : {}),
  }));
}

/** Device timeline rows for record_cctv_device_events, from snapshot event windows. */
export function buildDeviceEvents(scanned: ScannedFile[], thumbnailPathFor?: (item: ScannedFile) => string | null): Array<Record<string, unknown>> {
  return scanned
    .filter((item) => item.kind === 'snapshot' && item.slotStartAt)
    .map((item) => {
      const thumbnail = thumbnailPathFor?.(item) ?? null;
      return {
        source: 'device_snapshot',
        source_ref: item.relativePath,
        event_start_at: item.slotStartAt,
        event_end_at: item.slotEndAt ?? null,
        severity: 'motion',
        ...(thumbnail ? { thumbnail_path: thumbnail } : {}),
        metadata: { code: item.snapshotCode ?? null, size_bytes: item.sizeBytes },
      };
    });
}

/** Object key inside bob-uploads for one imported file; keeps the folder structure, strips unsafe characters. */
export function storagePathFor(organizationId: string, importId: string, relativePath: string): string {
  const safe = relativePath.split('/')
    .map((segment) => (segment === '.' || segment === '..' ? '_' : segment.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120)))
    .filter(Boolean).join('/');
  return `org/${organizationId}/cctv/${importId}/${safe || 'file'}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const power = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** power;
  return `${value >= 100 || power === 0 ? Math.round(value) : value.toFixed(1)} ${units[power]}`;
}
