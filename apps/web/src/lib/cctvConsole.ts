/**
 * cctvConsole.ts — pure helpers for the CCTV review console.
 *
 * The console follows the review-console pattern proven in NVR software (one shared clock across every
 * player, a severity-graded timeline with reviewed items dimmed, keyboard scrubbing) but is driven by this
 * app's own spine: cctv_imports (a camera at a place), evidence clips, cctv_device_events (timeline marks)
 * and cctv_entity_observations (what was seen, reviewed by a human through review_cctv_entity_observation).
 */

export type ClipJobStatus = 'queued' | 'processing' | 'complete' | 'failed' | 'inconclusive' | 'manual_review_required' | 'cancelled' | 'archived' | 'none';

export type ConsoleClip = {
  evidenceId: string;
  importId: string;
  jobId: string | null;
  jobStatus: ClipJobStatus;
  fileName: string;
  startMs: number;
  /** End from the intake slot or the decoded duration; the player refines it once metadata loads. */
  endMs: number;
  bucket: string;
  playbackPath: string | null;
  sourcePath: string;
  fileType: string;
  sizeBytes: number | null;
  /** Integrity hash of the stored source, recorded by the analysis worker; required for an evidence lock. */
  sha256: string | null;
  courtReady: boolean;
  lockedAt: string | null;
  retentionHold: boolean;
  /** Latest re-measurement of the stored bytes against the recorded hash (record_cctv_integrity_check). */
  integrity: ClipIntegrity | null;
  /** Self-hosted vision-LLM draft of the whole clip, unverified until a reviewer approves it. */
  sceneSynopsis: SceneSynopsis | null;
};

// From evidence_summary_approvals (generated_mode = 'cctv_vision_llm_scene_synopsis'). approvalStatus stays
// 'pending' until a reviewer acts - there is no auto-approve path anywhere in this pipeline.
export type SceneSynopsis = { text: string; approvalStatus: string; generatedAt: string | null };

export type ClipIntegrityState = 'verified' | 'mismatch' | 'unanchored';
export type ClipIntegrity = { state: ClipIntegrityState; checkedAt: string | null; checkCount: number; mismatchCount: number };

export function parseClipIntegrity(value: unknown): ClipIntegrity | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const state = record.state;
  if (state !== 'verified' && state !== 'mismatch' && state !== 'unanchored') return null;
  return {
    state,
    checkedAt: typeof record.checked_at === 'string' ? record.checked_at : null,
    checkCount: typeof record.check_count === 'number' ? record.check_count : Number(record.check_count) || 0,
    mismatchCount: typeof record.mismatch_count === 'number' ? record.mismatch_count : Number(record.mismatch_count) || 0,
  };
}

export type CustodyBadge = { label: string; tone: 'locked' | 'hashed' | 'none' | 'mismatch'; detail: string };

/** What a reviewer needs to know about a recording's custody at a glance; a mismatch always wins. */
export function custodyBadge(clip: Pick<ConsoleClip, 'sha256' | 'lockedAt' | 'integrity'>): CustodyBadge {
  if (clip.integrity?.state === 'mismatch') {
    return { label: 'Integrity mismatch', tone: 'mismatch', detail: `The stored bytes no longer match the recorded hash (${clip.integrity.mismatchCount} of ${clip.integrity.checkCount} checks). Treat this recording as altered until the custodian explains it.` };
  }
  const verified = clip.integrity?.state === 'verified' ? ` · verified ${clip.integrity.checkCount === 1 ? 'once' : `${clip.integrity.checkCount} times`}` : '';
  if (clip.lockedAt) return { label: 'Locked', tone: 'locked', detail: `Sealed with hash ${clip.sha256 ?? 'unknown'}${verified}. Retention cannot purge it; the hash, file and capture time are frozen.` };
  if (clip.sha256) return { label: 'Hashed', tone: 'hashed', detail: `Integrity hash ${clip.sha256}${verified}. Not yet sealed; an administrator can lock it.` };
  return { label: 'No hash yet', tone: 'none', detail: 'The analysis worker records the integrity hash when it first processes this recording. Until then it cannot be locked.' };
}

export type MarkSeverity = 'motion' | 'detection' | 'alert' | 'quality';

export type ConsoleMark = {
  id: string;
  startMs: number;
  endMs: number;
  severity: MarkSeverity;
  source: string;
  kind: string;
  thumbnailPath: string | null;
  label: string;
};

export type EntityKind = 'person' | 'vehicle' | 'animal';

export type PortfolioCandidate = {
  match_kind: 'observation' | 'person_record' | 'canonical_vehicle' | string;
  match_id: string;
  observation_id?: string | null;
  portfolio_key?: string | null;
  display_name?: string | null;
  score?: number | null;
  basis?: string | null;
  last_seen_at?: string | null;
  plate_number?: string | null;
  person_record_id?: string | null;
  canonical_vehicle_id?: string | null;
};

export type ConsoleObservation = {
  id: string;
  evidenceId: string;
  importId: string | null;
  sourceEventId: string;
  kind: EntityKind;
  observedAtMs: number;
  observedToMs: number | null;
  label: string | null;
  plate: string | null;
  species: string | null;
  speciesConfidence: number | null;
  isPest: boolean | null;
  confidence: number | null;
  qualityState: string;
  attributes: Record<string, unknown>;
  thumbnail: string | null;
  reviewState: string;
  portfolioKey: string | null;
  portfolioState: string;
  candidates: PortfolioCandidate[];
  personRecordId: string | null;
  canonicalPersonId: string | null;
  profileName: string | null;
  profileDetails: Record<string, unknown>;
  canonicalVehicleId: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
};

export function isWeakInferenceCandidate(observation: ConsoleObservation): boolean {
  const frameCount = Number(observation.attributes.frame_count) || 1;
  return frameCount <= 1 && (observation.confidence ?? 0) < 0.85 && !observation.attributes.face_event_id;
}

// Self-hosted vision-LLM hint (Moondream, via the in-house Ollama container) - never a validated
// detection. `present: false` means the model looked and didn't flag anything; a missing/malformed hint
// (Ollama unreachable, timed out, failed to parse) returns null here so "not checked" is never rendered
// the same as "checked, nothing found".
export type WeaponHint = { present: boolean; description: string | null };

export function weaponHintFrom(observation: ConsoleObservation): WeaponHint | null {
  const raw = observation.attributes.weapon_hint;
  if (!raw || typeof raw !== 'object') return null;
  const hint = raw as Record<string, unknown>;
  if (typeof hint.present !== 'boolean') return null;
  return { present: hint.present, description: typeof hint.description === 'string' ? hint.description : null };
}

// Same unverified-hint contract for vehicle make/model: only populated by the vision-LLM guess (marked by
// make_model_source), never by a real registry lookup, so the console must label it as a suggestion.
export type VehicleVisionHint = { make: string | null; model: string | null };

export function vehicleVisionHintFrom(observation: ConsoleObservation): VehicleVisionHint | null {
  if (observation.attributes.make_model_source !== 'vision_llm_hint_unverified') return null;
  const make = typeof observation.attributes.make === 'string' ? observation.attributes.make : null;
  const model = typeof observation.attributes.model === 'string' ? observation.attributes.model : null;
  return make || model ? { make, model } : null;
}

export function inferenceReviewLabel(observation: ConsoleObservation): string {
  const frameCount = Math.max(1, Number(observation.attributes.frame_count) || 1);
  const confidence = observation.confidence === null ? 'confidence not reported' : `${Math.round(observation.confidence * 100)}%`;
  if (isWeakInferenceCandidate(observation)) return `Weak AI candidate · ${confidence} · one sampled frame`;
  if (observation.attributes.face_event_id) return `AI candidate · ${confidence} · face-backed`;
  return `AI candidate · ${confidence} · ${frameCount} sampled frame${frameCount === 1 ? '' : 's'}`;
}

export type TimeView = { startMs: number; endMs: number };

export const PLAYBACK_RATES = [0.5, 1, 2, 4, 8, 16] as const;
export type GridLayout = 1 | 2 | 4 | 9;
export const GRID_LAYOUTS: GridLayout[] = [1, 2, 4, 9];

/** What a grid tile shows: a camera following the shared clock, or one recording playing on its own clock. */
export type ViewItem =
  | { id: string; kind: 'camera'; importId: string }
  | { id: string; kind: 'clip'; importId: string; evidenceId: string };

export function cameraItem(importId: string): ViewItem {
  return { id: `camera:${importId}`, kind: 'camera', importId };
}

export function clipItem(clip: Pick<ConsoleClip, 'importId' | 'evidenceId'>): ViewItem {
  return { id: `clip:${clip.evidenceId}`, kind: 'clip', importId: clip.importId, evidenceId: clip.evidenceId };
}

export function layoutForCount(count: number): GridLayout {
  if (count <= 1) return 1;
  if (count === 2) return 2;
  return count <= 4 ? 4 : 9;
}

export function importIdsOf(items: Array<ViewItem | null>): string[] {
  const seen: string[] = [];
  for (const item of items) if (item && !seen.includes(item.importId)) seen.push(item.importId);
  return seen;
}

/** Place items into a grid of `layout` slots, keeping order and dropping overflow. */
export function fitTiles(items: Array<ViewItem | null>, layout: GridLayout): Array<ViewItem | null> {
  const tiles: Array<ViewItem | null> = items.slice(0, layout);
  while (tiles.length < layout) tiles.push(null);
  return tiles;
}

export function durationLabel(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 && minutes < 10 ? `${minutes} min ${seconds % 60} s` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}

export function bytesLabel(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export type ClipDayGroup = { day: string; dayMs: number; clips: ConsoleClip[] };

/** Recordings in start order, grouped by calendar day in the camera's zone. */
export function groupClipsByDay(clips: ConsoleClip[], timeZone: string): ClipDayGroup[] {
  const groups: ClipDayGroup[] = [];
  for (const clip of [...clips].sort((a, b) => a.startMs - b.startMs)) {
    const day = formatDate(clip.startMs, timeZone);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.clips.push(clip);
    else groups.push({ day, dayMs: clip.startMs, clips: [clip] });
  }
  return groups;
}

export type EvidenceCounts = { total: number; pending: number; alerts: number; busy: boolean; possibleWeapon: boolean };

// A clip with unusually many distinct people or vehicles is worth a reviewer's attention even when no
// single sighting is individually alert-worthy (a readable plate, a pest). Starting thresholds only -
// what counts as "busy" varies a lot by site (a farm gate vs. a supermarket carpark), so tune these once
// there is enough real footage from a camera to know its normal range. Kept separate from `alerts`
// (rather than folded into that count) because no single observation carries the reason a busy clip was
// flagged, unlike a readable plate or a pest sighting.
const BUSY_PERSON_THRESHOLD = 5;
const BUSY_VEHICLE_THRESHOLD = 4;

export function observationCountsByEvidence(observations: ConsoleObservation[]): Record<string, EvidenceCounts> {
  const counts: Record<string, EvidenceCounts> = {};
  const personCounts: Record<string, number> = {};
  const vehicleCounts: Record<string, number> = {};
  for (const observation of observations) {
    const entry = counts[observation.evidenceId] ?? (counts[observation.evidenceId] = { total: 0, pending: 0, alerts: 0, busy: false, possibleWeapon: false });
    entry.total += 1;
    if (!isReviewed(observation)) entry.pending += 1;
    if ((observation.kind === 'vehicle' && observation.plate) || (observation.kind === 'animal' && observation.isPest)) entry.alerts += 1;
    // Kept out of `alerts` on purpose: an unverified vision-LLM guess about a possible weapon is a
    // different order of severity to a readable plate, and must never blend into a routine alert count a
    // reviewer might scan past. See weaponHintFrom() for the never-treat-as-fact contract.
    if (weaponHintFrom(observation)?.present) entry.possibleWeapon = true;
    if (observation.kind === 'person') personCounts[observation.evidenceId] = (personCounts[observation.evidenceId] ?? 0) + 1;
    if (observation.kind === 'vehicle') vehicleCounts[observation.evidenceId] = (vehicleCounts[observation.evidenceId] ?? 0) + 1;
  }
  for (const evidenceId of Object.keys(counts)) {
    counts[evidenceId].busy = (personCounts[evidenceId] ?? 0) >= BUSY_PERSON_THRESHOLD || (vehicleCounts[evidenceId] ?? 0) >= BUSY_VEHICLE_THRESHOLD;
  }
  return counts;
}

export function clipStatusLabel(status: ClipJobStatus): string {
  switch (status) {
    case 'queued': return 'Queued for analysis';
    case 'processing': return 'Analysing';
    case 'complete': return 'Analysed';
    case 'failed': return 'Analysis failed';
    case 'inconclusive': return 'Inconclusive';
    case 'manual_review_required': return 'Needs review';
    case 'cancelled': return 'Cancelled';
    case 'archived': return 'Archived';
    default: return 'Not analysed';
  }
}

export type EnhanceMode = 'auto' | 'on' | 'off';

export type CCTVInspection = {
  zoom: number;
  brightness: number;
  contrast: number;
  saturation: number;
  /** Sharpening override applied on top of the auto plan, percent. */
  detail: number;
  focusX: number;
  focusY: number;
  /** auto: enhance whenever zoomed in; on: always; off: raw picture with manual adjustments only. */
  enhance: EnhanceMode;
};

export const DEFAULT_CCTV_INSPECTION: CCTVInspection = {
  zoom: 1,
  brightness: 100,
  contrast: 100,
  saturation: 100,
  detail: 100,
  focusX: 50,
  focusY: 50,
  enhance: 'auto',
};

const INSPECTION_ZOOM_STEPS = [1, 1.25, 1.5, 2, 3, 4] as const;

function clampInspectionValue(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function normalizeCCTVInspection(value: Partial<CCTVInspection>): CCTVInspection {
  const zoom = Number(value.zoom ?? DEFAULT_CCTV_INSPECTION.zoom);
  return {
    zoom: clampInspectionValue(Number.isFinite(zoom) ? Math.round(zoom * 100) / 100 : 1, 1, 4),
    brightness: clampInspectionValue(Number(value.brightness ?? DEFAULT_CCTV_INSPECTION.brightness), 60, 160),
    contrast: clampInspectionValue(Number(value.contrast ?? DEFAULT_CCTV_INSPECTION.contrast), 60, 180),
    saturation: clampInspectionValue(Number(value.saturation ?? DEFAULT_CCTV_INSPECTION.saturation), 0, 200),
    detail: clampInspectionValue(Number(value.detail ?? DEFAULT_CCTV_INSPECTION.detail), 0, 200),
    focusX: clampInspectionValue(Number(value.focusX ?? DEFAULT_CCTV_INSPECTION.focusX), 0, 100),
    focusY: clampInspectionValue(Number(value.focusY ?? DEFAULT_CCTV_INSPECTION.focusY), 0, 100),
    enhance: value.enhance === 'on' || value.enhance === 'off' ? value.enhance : 'auto',
  };
}

export function nextInspectionZoom(current: number, direction: 1 | -1): number {
  const index = INSPECTION_ZOOM_STEPS.findIndex((zoom) => zoom === current);
  if (index === -1) {
    // Wheel zoom can land between steps: snap to the next step in the requested direction.
    const next = direction === 1 ? INSPECTION_ZOOM_STEPS.find((zoom) => zoom > current) : [...INSPECTION_ZOOM_STEPS].reverse().find((zoom) => zoom < current);
    return next ?? (direction === 1 ? INSPECTION_ZOOM_STEPS[INSPECTION_ZOOM_STEPS.length - 1] : INSPECTION_ZOOM_STEPS[0]);
  }
  return INSPECTION_ZOOM_STEPS[Math.min(INSPECTION_ZOOM_STEPS.length - 1, Math.max(0, index + direction))];
}

export function isDefaultCCTVInspection(value: CCTVInspection): boolean {
  return Object.entries(DEFAULT_CCTV_INSPECTION).every(([key, defaultValue]) => value[key as keyof CCTVInspection] === defaultValue);
}

export function isEnhancementActive(value: CCTVInspection): boolean {
  return value.enhance === 'on' || (value.enhance === 'auto' && value.zoom > 1);
}

export const SEVERITY_COLOURS: Record<MarkSeverity, string> = {
  alert: '#d64545',
  detection: '#e0a526',
  motion: '#5b7fa6',
  quality: '#8a8f98',
};

export const SEVERITY_RANK: Record<MarkSeverity, number> = { quality: 0, motion: 1, detection: 2, alert: 3 };

export function parseMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function gridColumns(layout: GridLayout): number {
  return layout === 1 ? 1 : layout === 9 ? 3 : 2;
}

export function nextRate(current: number, direction: 1 | -1): number {
  const index = PLAYBACK_RATES.findIndex((rate) => rate === current);
  const base = index === -1 ? PLAYBACK_RATES.indexOf(1) : index;
  const next = Math.min(PLAYBACK_RATES.length - 1, Math.max(0, base + direction));
  return PLAYBACK_RATES[next];
}

export function clampMs(value: number, bounds: TimeView): number {
  return Math.min(bounds.endMs, Math.max(bounds.startMs, value));
}

/** The clip covering an instant. Slot ends can overlap the next slot by a frame; the earliest start wins. */
export function clipAtTime(clips: ConsoleClip[], clockMs: number): ConsoleClip | null {
  const covering = clips.filter((clip) => clockMs >= clip.startMs && clockMs < clip.endMs);
  if (!covering.length) return null;
  return covering.sort((a, b) => a.startMs - b.startMs)[0];
}

export function nextClipAfter(clips: ConsoleClip[], clockMs: number): ConsoleClip | null {
  return clips.filter((clip) => clip.startMs > clockMs).sort((a, b) => a.startMs - b.startMs)[0] ?? null;
}

export function previousClipBefore(clips: ConsoleClip[], clockMs: number): ConsoleClip | null {
  return clips.filter((clip) => clip.endMs <= clockMs).sort((a, b) => b.endMs - a.endMs)[0] ?? null;
}

/** Bounds of everything the console knows about a set of cameras (clips first, marks as a fallback). */
export function timelineBounds(clips: ConsoleClip[], marks: ConsoleMark[], observations: ConsoleObservation[]): TimeView | null {
  const starts: number[] = [];
  const ends: number[] = [];
  for (const clip of clips) { starts.push(clip.startMs); ends.push(clip.endMs); }
  for (const mark of marks) { starts.push(mark.startMs); ends.push(mark.endMs); }
  for (const observation of observations) { starts.push(observation.observedAtMs); ends.push(observation.observedToMs ?? observation.observedAtMs); }
  if (!starts.length) return null;
  const startMs = Math.min(...starts);
  const endMs = Math.max(...ends, startMs + 60_000);
  return { startMs, endMs };
}

export function timeToX(ms: number, view: TimeView, width: number): number {
  const span = Math.max(1, view.endMs - view.startMs);
  return ((ms - view.startMs) / span) * width;
}

export function xToTime(x: number, view: TimeView, width: number): number {
  const span = Math.max(1, view.endMs - view.startMs);
  return view.startMs + (Math.min(Math.max(x, 0), width) / Math.max(1, width)) * span;
}

/** Zoom the view around an anchor instant; factor < 1 zooms in. Never narrower than 10 s or wider than bounds. */
export function zoomView(view: TimeView, anchorMs: number, factor: number, bounds: TimeView): TimeView {
  const span = view.endMs - view.startMs;
  const targetSpan = Math.min(bounds.endMs - bounds.startMs, Math.max(10_000, span * factor));
  const anchorRatio = span > 0 ? (anchorMs - view.startMs) / span : 0.5;
  let startMs = anchorMs - targetSpan * anchorRatio;
  let endMs = startMs + targetSpan;
  if (startMs < bounds.startMs) { startMs = bounds.startMs; endMs = startMs + targetSpan; }
  if (endMs > bounds.endMs) { endMs = bounds.endMs; startMs = Math.max(bounds.startMs, endMs - targetSpan); }
  return { startMs, endMs };
}

export function panView(view: TimeView, deltaMs: number, bounds: TimeView): TimeView {
  const span = view.endMs - view.startMs;
  let startMs = view.startMs + deltaMs;
  if (startMs < bounds.startMs) startMs = bounds.startMs;
  if (startMs + span > bounds.endMs) startMs = Math.max(bounds.startMs, bounds.endMs - span);
  return { startMs, endMs: startMs + span };
}

/** Keep the playhead visible: when it leaves the view while playing, page the view forward. */
export function followClock(view: TimeView, clockMs: number, bounds: TimeView): TimeView {
  if (clockMs >= view.startMs && clockMs <= view.endMs) return view;
  const span = view.endMs - view.startMs;
  return panView(view, clockMs - view.startMs - span * 0.1, bounds);
}

export type MarkCluster = {
  id: string;
  x0: number;
  x1: number;
  severity: MarkSeverity;
  count: number;
  startMs: number;
  endMs: number;
  marks: ConsoleMark[];
};

/**
 * Thousands of snapshot ticks would each become a DOM node; marks that land within `minPx` of each other on
 * screen are merged into one cluster carrying the highest severity. Quality marks cluster separately.
 */
export function clusterMarks(marks: ConsoleMark[], view: TimeView, width: number, minPx = 3): MarkCluster[] {
  const visible = marks
    .filter((mark) => mark.endMs >= view.startMs && mark.startMs <= view.endMs)
    .sort((a, b) => a.startMs - b.startMs);
  const clusters: MarkCluster[] = [];
  for (const mark of visible) {
    const x0 = timeToX(mark.startMs, view, width);
    const x1 = Math.max(x0 + 1, timeToX(mark.endMs, view, width));
    const last = clusters[clusters.length - 1];
    const sameLane = last && (last.severity === 'quality') === (mark.severity === 'quality');
    if (last && sameLane && x0 - last.x1 <= minPx) {
      last.x1 = Math.max(last.x1, x1);
      last.endMs = Math.max(last.endMs, mark.endMs);
      last.count += 1;
      last.marks.push(mark);
      if (SEVERITY_RANK[mark.severity] > SEVERITY_RANK[last.severity]) last.severity = mark.severity;
    } else {
      clusters.push({ id: mark.id, x0, x1, severity: mark.severity, count: 1, startMs: mark.startMs, endMs: mark.endMs, marks: [mark] });
    }
  }
  return clusters;
}

export type ConsoleKeyAction =
  | { type: 'toggle_play' }
  | { type: 'seek'; deltaMs: number }
  | { type: 'rate'; direction: 1 | -1 }
  | { type: 'layout'; layout: GridLayout }
  | { type: 'fullscreen' }
  | { type: 'mute' }
  | { type: 'escape' }
  | { type: 'frame'; direction: 1 | -1 }
  | { type: 'bookmark' }
  | { type: 'snapshot' };

/** Keyboard map: Space play/pause, ←/→ ±10 s, ↑/↓ ±1 s, , . one frame, [ ] speed, 1/2/4/9 grid, f fullscreen, m mute, b bookmark, s snapshot. */
export function keyboardAction(event: { key: string; targetTag?: string | null; isEditable?: boolean; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }): ConsoleKeyAction | null {
  const tag = (event.targetTag || '').toLowerCase();
  if (event.isEditable || tag === 'input' || tag === 'textarea' || tag === 'select' || event.metaKey || event.ctrlKey || event.altKey) return null;
  switch (event.key) {
    case ' ': case 'k': return { type: 'toggle_play' };
    case 'ArrowLeft': return { type: 'seek', deltaMs: -10_000 };
    case 'ArrowRight': return { type: 'seek', deltaMs: 10_000 };
    case 'ArrowUp': return { type: 'seek', deltaMs: 1_000 };
    case 'ArrowDown': return { type: 'seek', deltaMs: -1_000 };
    case 'j': return { type: 'seek', deltaMs: -10_000 };
    case 'l': return { type: 'seek', deltaMs: 10_000 };
    case ',': return { type: 'frame', direction: -1 };
    case '.': return { type: 'frame', direction: 1 };
    case ']': case '>': return { type: 'rate', direction: 1 };
    case '[': case '<': return { type: 'rate', direction: -1 };
    case '1': return { type: 'layout', layout: 1 };
    case '2': return { type: 'layout', layout: 2 };
    case '4': return { type: 'layout', layout: 4 };
    case '9': return { type: 'layout', layout: 9 };
    case 'f': return { type: 'fullscreen' };
    case 'm': return { type: 'mute' };
    case 'b': return { type: 'bookmark' };
    case 's': return { type: 'snapshot' };
    case 'Escape': return { type: 'escape' };
    default: return null;
  }
}

export function formatClock(ms: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-NZ', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(11, 19);
  }
}

export function formatDate(ms: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-NZ', { timeZone, weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

/** Tick spacing that keeps labels readable: about one label per 90 px. */
export function tickIntervalMs(view: TimeView, width: number): number {
  const targetTicks = Math.max(2, Math.floor(width / 90));
  const rough = (view.endMs - view.startMs) / targetTicks;
  const steps = [1_000, 5_000, 10_000, 30_000, 60_000, 300_000, 600_000, 1_800_000, 3_600_000, 7_200_000, 21_600_000, 86_400_000];
  return steps.find((step) => step >= rough) ?? steps[steps.length - 1];
}

export function ticksFor(view: TimeView, width: number): number[] {
  const interval = tickIntervalMs(view, width);
  const first = Math.ceil(view.startMs / interval) * interval;
  const ticks: number[] = [];
  for (let ms = first; ms <= view.endMs && ticks.length < 200; ms += interval) ticks.push(ms);
  return ticks;
}

export function entityTitle(observation: ConsoleObservation): string {
  if (observation.kind === 'vehicle') return observation.plate ? `Vehicle ${observation.plate}` : `Vehicle${observation.label ? ` · ${observation.label}` : ' · no plate read'}`;
  if (observation.kind === 'animal') {
    const species = observation.species && observation.species !== 'other' ? observation.species : 'unidentified animal';
    return `${observation.isPest ? 'Pest · ' : ''}${species.charAt(0).toUpperCase()}${species.slice(1)}`;
  }
  return observation.label ? `Person · ${observation.label}` : 'Person';
}

export type ReviewAction = 'accept' | 'reject' | 'link_person' | 'new_person' | 'link_vehicle' | 'new_vehicle' | 'merge_portfolio' | 'accept_portfolio';

export type CandidateAction = { action: ReviewAction; targetId: string; label: string };

/** What linking a reviewer's chosen candidate means for review_cctv_entity_observation. */
export function candidateAction(observation: ConsoleObservation, candidate: PortfolioCandidate): CandidateAction | null {
  if (observation.kind === 'person') {
    if (candidate.person_record_id) return { action: 'link_person', targetId: candidate.person_record_id, label: `Same person as ${candidate.display_name || 'known person'}` };
    if (candidate.match_kind === 'observation' && candidate.observation_id) return { action: 'merge_portfolio', targetId: candidate.observation_id, label: 'Same person as this earlier sighting' };
    return null;
  }
  if (observation.kind === 'vehicle') {
    if (candidate.canonical_vehicle_id) return { action: 'link_vehicle', targetId: candidate.canonical_vehicle_id, label: `Same vehicle as ${candidate.plate_number || candidate.display_name || 'known vehicle'}` };
    if (candidate.match_kind === 'observation' && candidate.observation_id) return { action: 'merge_portfolio', targetId: candidate.observation_id, label: 'Same vehicle as this earlier sighting' };
    return null;
  }
  if (candidate.match_kind === 'observation' && candidate.observation_id) return { action: 'merge_portfolio', targetId: candidate.observation_id, label: 'Same animal as this earlier sighting' };
  return null;
}

export function isReviewed(observation: ConsoleObservation): boolean {
  return observation.reviewState !== 'unreviewed';
}

export function observationsToPins(observations: ConsoleObservation[]): ConsoleMark[] {
  return observations.map((observation) => ({
    id: `obs-${observation.id}`,
    startMs: observation.observedAtMs,
    endMs: Math.max(observation.observedAtMs + 1000, observation.observedToMs ?? observation.observedAtMs),
    severity: observation.kind === 'vehicle' && observation.plate ? 'alert' : observation.kind === 'animal' && observation.isPest ? 'alert' : 'detection',
    source: 'observation',
    kind: observation.kind,
    thumbnailPath: null,
    label: entityTitle(observation),
  }));
}

/** Default view when a camera is opened: the whole recorded window, capped so a multi-day card still reads. */
export function initialView(bounds: TimeView, clockMs: number, footage?: TimeView | null): TimeView {
  const total = bounds.endMs - bounds.startMs;
  const maxSpan = 6 * 3_600_000;
  // Device snapshots can stretch the day well past the clips; open on the footage (padded, ≥ 10 min) instead.
  const focus = footage ? Math.max(10 * 60_000, (footage.endMs - footage.startMs) * 1.25) : maxSpan;
  const span = Math.min(total, Math.min(maxSpan, focus));
  if (span >= total) return bounds;
  return zoomView(bounds, clockMs, span / total, bounds);
}

export type ConsoleFailureKind = 'offline' | 'transport' | 'timeout' | 'permission' | 'other';
export type ConsoleFailure = { kind: ConsoleFailureKind; text: string; retryable: boolean };

/**
 * Turns a raw data-service error into something a reviewer can act on. supabase-js reports a dropped
 * connection as the literal string "TypeError: Failed to fetch", which says nothing about which request
 * failed or whether anything was changed — so the scope is always named and the safe next step stated.
 */
export function describeConsoleFailure(rawMessage: string | null | undefined, scope: string, online = true): ConsoleFailure {
  const message = (rawMessage ?? '').trim();
  const lower = message.toLowerCase();
  if (!online) {
    return { kind: 'offline', text: `You are offline, so the ${scope} could not be loaded. Nothing was changed; the console retries when the connection returns.`, retryable: true };
  }
  if (/failed to fetch|networkerror|network request failed|load failed|err_network|err_connection|econnreset|fetch failed|the operation was aborted|abort/.test(lower)) {
    return { kind: 'transport', text: `The ${scope} could not be loaded because the connection to the FCM data service was interrupted. Nothing was changed. Retry, or check the network if this keeps happening.`, retryable: true };
  }
  if (/statement timeout|canceling statement|\b57014\b|timed out|timeout/.test(lower)) {
    return { kind: 'timeout', text: `Loading the ${scope} took too long and was stopped. Retry; if it keeps happening, review one camera or one day at a time.`, retryable: true };
  }
  if (/permission denied|row-level security|\b42501\b|\bjwt\b|not authorized|unauthorized|forbidden|\b401\b|\b403\b/.test(lower)) {
    return { kind: 'permission', text: `Your account is not permitted to load the ${scope}. Sign in again, or ask an administrator to check your role.`, retryable: false };
  }
  return { kind: 'other', text: `The ${scope} could not be loaded: ${message || 'unknown error'}.`, retryable: true };
}

export type RefreshCoalescer = { request: (id: string) => void; dispose: () => void };

/**
 * Collapses bursts of refresh requests for the same key into one run. Realtime change events, the
 * active-job poll, and reviewer actions can all ask for the same import to reload within the same
 * second; each reload is several large queries, and a burst starves the video streams of connections
 * (surfacing as "Failed to fetch"). Requests arriving while a run is in flight mark it dirty and cause
 * exactly one follow-up run after it completes.
 */
export function createRefreshCoalescer(run: (id: string) => Promise<void>, delayMs = 1500): RefreshCoalescer {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const inFlight = new Set<string>();
  const dirty = new Set<string>();
  let disposed = false;

  const schedule = (id: string) => {
    if (disposed || timers.has(id)) return;
    timers.set(id, setTimeout(() => {
      timers.delete(id);
      void execute(id);
    }, delayMs));
  };

  const execute = async (id: string) => {
    if (disposed) return;
    if (inFlight.has(id)) { dirty.add(id); return; }
    inFlight.add(id);
    try {
      await run(id);
    } finally {
      inFlight.delete(id);
      if (dirty.delete(id)) schedule(id);
    }
  };

  return {
    request: schedule,
    dispose: () => {
      disposed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      dirty.clear();
    },
  };
}
