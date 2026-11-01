// Reviewer-facing view of how a CCTV sighting was produced and how accurate the engine has proven to be.
// Every number shown here comes from the sighting's recorded attributes or from human review decisions
// (cctv_accuracy_summary); nothing is estimated in the browser beyond combining those decisions.
import { asRecord, isReviewed, type ConsoleObservation, type EntityKind } from './cctvConsole';

export const CURRENT_ENGINE_VERSION = 'cctv-engine-v2';

export type ObservationProvenance = {
  engineVersion: string | null;
  detectorModel: string | null;
  trackHits: number | null;
  trackConfirmed: boolean | null;
  basis: string | null;
  basisLabel: string;
  motionState: string | null;
  residentObjectId: string | null;
  residentSightings: number | null;
  residentFirstSeenAt: string | null;
  carriedDecision: string | null;
};

const BASIS_LABELS: Record<string, string> = {
  temporal_consensus: 'seen in several frames',
  face_backed: 'face captured',
  single_frame_high_confidence: 'one very confident frame',
  biosecurity_recall_single_frame: 'one frame, kept for biosecurity recall',
};

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);
const count = (value: unknown): number | null => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

export function basisLabel(basis: string | null): string {
  if (!basis) return 'basis not recorded';
  return BASIS_LABELS[basis] ?? basis.replace(/_/g, ' ');
}

export function observationProvenance(observation: ConsoleObservation): ObservationProvenance {
  const attributes = observation.attributes;
  const basis = text(attributes.review_candidate_basis);
  return {
    engineVersion: text(attributes.engine_version),
    detectorModel: text(attributes.detector_model),
    trackHits: count(attributes.track_hits) ?? count(attributes.frame_count),
    trackConfirmed: typeof attributes.track_confirmed === 'boolean' ? attributes.track_confirmed : null,
    basis,
    basisLabel: basisLabel(basis),
    motionState: text(attributes.motion_state),
    residentObjectId: text(attributes.resident_object_id),
    residentSightings: count(attributes.resident_sighting_count),
    residentFirstSeenAt: text(attributes.resident_first_seen_at),
    carriedDecision: text(attributes.carried_review_state),
  };
}

export type DetectionBox = { left: number; top: number; width: number; height: number };

// Position of the detector's box over the review still, in percent of a container with `containerRatio`
// (width / height) that shows the whole frame with object-fit: contain. Null when the sighting does not
// carry its frame size (engine v1) or the box is unusable, so a guessed box is never drawn.
export function detectionBox(observation: ConsoleObservation, containerRatio = 4 / 3): DetectionBox | null {
  const attributes = observation.attributes;
  const frameWidth = count(attributes.frame_width);
  const frameHeight = count(attributes.frame_height);
  const bbox = asRecord(attributes.bbox);
  const x = count(bbox.x);
  const y = count(bbox.y);
  const w = count(bbox.width);
  const h = count(bbox.height);
  if (!frameWidth || !frameHeight || frameWidth <= 0 || frameHeight <= 0 || x === null || y === null || !w || !h || w <= 0 || h <= 0) return null;
  const left = Math.max(0, Math.min(frameWidth, x));
  const top = Math.max(0, Math.min(frameHeight, y));
  const right = Math.max(left, Math.min(frameWidth, x + w));
  const bottom = Math.max(top, Math.min(frameHeight, y + h));
  if (right - left < 1 || bottom - top < 1) return null;
  const frameRatio = frameWidth / frameHeight;
  // The picture fills the container's width when it is wider than the container, its height otherwise.
  const pictureWidth = frameRatio >= containerRatio ? 100 : (frameRatio / containerRatio) * 100;
  const pictureHeight = frameRatio >= containerRatio ? (containerRatio / frameRatio) * 100 : 100;
  const offsetLeft = (100 - pictureWidth) / 2;
  const offsetTop = (100 - pictureHeight) / 2;
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    left: round(offsetLeft + (left / frameWidth) * pictureWidth),
    top: round(offsetTop + (top / frameHeight) * pictureHeight),
    width: round(((right - left) / frameWidth) * pictureWidth),
    height: round(((bottom - top) / frameHeight) * pictureHeight),
  };
}

export type TriageKeyAction = 'next' | 'previous' | 'accept' | 'reject';

// Single-character shortcuts (J/K/A/R) can be switched off (WCAG 2.1.4) so speech-input and other character-key
// users never decide a sighting by accident; the arrow keys keep moving through the queue either way. A held key
// repeats navigation but never decides: one keystroke is one human decision.
export function triageKeyAction(event: { key: string; targetTag?: string | null; isEditable?: boolean; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; repeat?: boolean; characterShortcuts?: boolean }): TriageKeyAction | null {
  if (event.metaKey || event.ctrlKey || event.altKey || event.isEditable) return null;
  const tag = (event.targetTag ?? '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return null;
  if (event.key === 'ArrowDown') return 'next';
  if (event.key === 'ArrowUp') return 'previous';
  if (event.characterShortcuts === false) return null;
  switch (event.key) {
    case 'j': case 'J': return 'next';
    case 'k': case 'K': return 'previous';
    case 'a': case 'A': return event.repeat ? null : 'accept';
    case 'r': case 'R': return event.repeat ? null : 'reject';
    default: return null;
  }
}

// After a decision the reviewer moves to the next undecided sighting below the current one, wrapping to the
// top of the list, so the queue is worked in order without hunting for the next row.
export function nextPendingId(list: ConsoleObservation[], currentId: string | null): string | null {
  const start = currentId ? list.findIndex((item) => item.id === currentId) : -1;
  for (let step = 1; step <= list.length; step += 1) {
    const candidate = list[(start + step + list.length) % list.length];
    if (candidate && candidate.id !== currentId && !isReviewed(candidate)) return candidate.id;
  }
  return null;
}

export function adjacentId(list: ConsoleObservation[], currentId: string | null, direction: 1 | -1): string | null {
  if (!list.length) return null;
  const index = currentId ? list.findIndex((item) => item.id === currentId) : -1;
  if (index < 0) return list[0].id;
  const next = Math.max(0, Math.min(list.length - 1, index + direction));
  return list[next].id;
}

// --- Accuracy (cctv_accuracy_summary) -------------------------------------------------------------------

export type AccuracyGroup = {
  entityKind: EntityKind;
  engineVersion: string;
  detectorModel: string;
  reviewBasis: string;
  confidenceBand: string;
  total: number;
  accepted: number;
  rejected: number;
  inconclusive: number;
  pending: number;
  decided: number;
  precision: number | null;
  precisionLowerBound: number | null;
  calibrated: boolean;
};

export type MissedDetectionGroup = { entityKind: EntityKind; engineVersion: string; open: number; confirmedMissed: number; notMissed: number };

export type AccuracySummary = {
  since: string | null;
  calibrationMinimum: number;
  groups: AccuracyGroup[];
  missed: MissedDetectionGroup[];
};

const isKind = (value: unknown): value is EntityKind => value === 'person' || value === 'vehicle' || value === 'animal';
const whole = (value: unknown): number => Math.max(0, Math.round(count(value) ?? 0));

export function parseAccuracySummary(value: unknown): AccuracySummary {
  const record = asRecord(value);
  const groups = Array.isArray(record.groups) ? record.groups : [];
  const missed = Array.isArray(record.missed_detections) ? record.missed_detections : [];
  const calibrationMinimum = whole(record.calibration_minimum_decisions) || 30;
  return {
    since: text(record.since),
    calibrationMinimum,
    groups: groups.map(asRecord).filter((row) => isKind(row.entity_kind)).map((row) => {
      const accepted = whole(row.accepted);
      const rejected = whole(row.rejected);
      return {
        entityKind: row.entity_kind as EntityKind,
        engineVersion: text(row.engine_version) ?? 'legacy',
        detectorModel: text(row.detector_model) ?? 'unreported',
        reviewBasis: text(row.review_basis) ?? 'unrecorded',
        confidenceBand: text(row.confidence_band) ?? 'unknown',
        total: whole(row.total),
        accepted,
        rejected,
        inconclusive: whole(row.inconclusive),
        pending: whole(row.pending),
        decided: accepted + rejected,
        precision: count(row.precision),
        precisionLowerBound: count(row.precision_lower_bound),
        calibrated: accepted + rejected >= calibrationMinimum,
      };
    }),
    missed: missed.map(asRecord).filter((row) => isKind(row.entity_kind)).map((row) => ({
      entityKind: row.entity_kind as EntityKind,
      engineVersion: text(row.engine_version) ?? 'legacy',
      open: whole(row.open),
      confirmedMissed: whole(row.confirmed_missed),
      notMissed: whole(row.not_missed),
    })),
  };
}

// Wilson score interval lower bound at 95%: the precision the engine has demonstrated, not the precision it
// happened to show on a small sample. Matches cctv_accuracy_summary so totals and groups agree.
export function wilsonLowerBound(successes: number, trials: number): number | null {
  if (!Number.isFinite(trials) || trials <= 0) return null;
  const z = 1.96;
  const p = successes / trials;
  const z2 = z * z;
  const centre = p + z2 / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials);
  return Math.max(0, (centre - margin) / (1 + z2 / trials));
}

export type KindAccuracy = {
  entityKind: EntityKind;
  engineVersion: string;
  total: number;
  decided: number;
  accepted: number;
  pending: number;
  precision: number | null;
  precisionLowerBound: number | null;
  calibrated: boolean;
  confirmedMissed: number;
  openMissed: number;
};

export function accuracyByKind(summary: AccuracySummary, engineVersion: string): KindAccuracy[] {
  const kinds: EntityKind[] = ['person', 'vehicle', 'animal'];
  return kinds.map((entityKind) => {
    const groups = summary.groups.filter((group) => group.entityKind === entityKind && group.engineVersion === engineVersion);
    const accepted = groups.reduce((sum, group) => sum + group.accepted, 0);
    const decided = groups.reduce((sum, group) => sum + group.decided, 0);
    const missed = summary.missed.filter((row) => row.entityKind === entityKind && row.engineVersion === engineVersion);
    return {
      entityKind,
      engineVersion,
      total: groups.reduce((sum, group) => sum + group.total, 0),
      decided,
      accepted,
      pending: groups.reduce((sum, group) => sum + group.pending, 0),
      precision: decided > 0 ? accepted / decided : null,
      precisionLowerBound: wilsonLowerBound(accepted, decided),
      calibrated: decided >= summary.calibrationMinimum,
      confirmedMissed: missed.reduce((sum, row) => sum + row.confirmedMissed, 0),
      openMissed: missed.reduce((sum, row) => sum + row.open, 0),
    };
  });
}

export function percent(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

export function calibrationLabel(decided: number, minimum: number): string {
  if (decided >= minimum) return 'Calibrated';
  if (decided === 0) return 'No decisions yet';
  return `${minimum - decided} more decision${minimum - decided === 1 ? '' : 's'} to calibrate`;
}

export function engineLabel(engineVersion: string | null): string {
  if (!engineVersion || engineVersion === 'legacy') return 'Engine v1 (legacy)';
  if (engineVersion === CURRENT_ENGINE_VERSION) return 'Engine v2';
  return engineVersion;
}

// RunPod was retired from the stack on 2026-11-01; its names stay only so older results still read correctly.
const TRIAGE_PROVIDER_NAMES: Record<string, string> = {
  local_gpu: 'Laptop GPU',
  gpu: 'RunPod GPU (legacy)',
  runpod: 'RunPod GPU (legacy)',
  vps: 'VPS CPU',
  unreported: 'Unreported machine',
};

export type InferenceCoverage = {
  // Every source frame position the extractor parsed, static and warm-up frames included.
  framesParsed: number | null;
  // Motion-frame artifacts the sampler chose from; null for results recorded before the worker counted them.
  motionFrames: number | null;
  framesSampled: number;
  framesExamined: number;
  framesUnanswered: number;
  capped: boolean;
  providers: Array<{ provider: string; label: string; frames: number }>;
  // Different detector models read frames of one job (the v1 failure engine v2 forbids). Two GPU machines running
  // the same pinned model is not mixed.
  mixedDetectors: boolean;
  engineVersion: string | null;
  pinnedModel: string | null;
  detectorModels: Array<{ model: string; frames: number }>;
};

const frameCounts = (value: unknown): Array<[string, number]> => Object.entries(asRecord(value))
  .map(([key, frames]) => [key, count(frames) ?? 0] as [string, number])
  .filter(([, frames]) => frames > 0)
  .sort((left, right) => right[1] - left[1]);

// What the detector actually looked at for one job, from the worker's own classification plan. Null for a
// result that predates the plan or never counted the examined frames, so the page says "not recorded" instead of
// implying full coverage.
export function inferenceCoverage(result: unknown): InferenceCoverage | null {
  const record = asRecord(result);
  const plan = asRecord(record.classification_plan);
  const coverage = asRecord(plan.coverage);
  const sampled = count(coverage.frames_selected) ?? count(plan.sampled_frames);
  const examined = count(coverage.frames_triaged);
  // A legacy plan can list sampled frames whose detector batches were skipped; without an examined count it
  // proves nothing about coverage.
  if (sampled === null || examined === null) return null;
  const providers = frameCounts(coverage.triage_providers).map(([provider, frames]) => ({
    provider,
    label: TRIAGE_PROVIDER_NAMES[provider] ?? provider.replace(/_/g, ' '),
    frames,
  }));
  const manifest = asRecord(plan.model_manifest);
  const detectorModels = frameCounts(manifest.detector_models).map(([model, frames]) => ({ model, frames }));
  const providerNames = new Set(providers.map((entry) => entry.provider));
  const vpsWithGpu = providerNames.has('vps') && [...providerNames].some((provider) => provider !== 'vps');
  return {
    framesParsed: count(record.total_frames_parsed),
    motionFrames: count(plan.motion_frames),
    framesSampled: sampled,
    framesExamined: examined,
    framesUnanswered: count(coverage.frames_untriaged) ?? Math.max(0, sampled - examined),
    capped: record.classification_truncated === true,
    providers,
    mixedDetectors: detectorModels.length > 0 ? detectorModels.length > 1 : vpsWithGpu,
    engineVersion: text(manifest.engine_version),
    pinnedModel: text(manifest.pinned_detector_model),
    detectorModels,
  };
}
