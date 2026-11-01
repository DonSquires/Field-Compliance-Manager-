const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const {
  ENGINE_VERSION,
  TRACKER_DEFAULTS,
  trackDetections,
  bboxIou,
  bboxCenter,
  bboxContainsPoint,
  normaliseBbox,
} = require('./entity_tracker');
const { getVehicleVisionHint, getWeaponHint, getSceneSynopsis, vlmManifest } = require('./vision_hints');

const execFileAsync = promisify(execFile);

function log(event, fields = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
}

const DEFAULT_FACE_SIMILARITY_THRESHOLD = 0.65;
const DEFAULT_MAX_GAP_SECONDS = 15.0;
const DEFAULT_KEYFRAME_COUNT = 6;
const SINGLE_FRAME_REVIEW_CONFIDENCE = TRACKER_DEFAULTS.singleFrameConfidence;
const UNUSABLE_QUALITY_STATES = new Set(['glitch', 'ir_switch', 'flare', 'degraded', 'occluded']);
// Vision-language hints are bounded per clip so a crowded clip cannot queue minutes of VLM work.
const MAX_VEHICLE_HINTS = Math.max(0, Number(process.env.VISION_MAX_VEHICLE_HINTS || 12));
const MAX_WEAPON_HINTS = Math.max(0, Number(process.env.VISION_MAX_WEAPON_HINTS || 8));
const VEHICLE_ARTIFACT_MIN_WIDTH = 1000;
const VEHICLE_ARTIFACT_MIN_HEIGHT = 700;
// Engine v2 event ids carry the engine generation so a re-run never collides with a reviewed or superseded
// v1 row on the (job, source_event_id, entity_kind) key.
const EVENT_PREFIX = 'e2';

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const valA = Number(a[i]) || 0;
    const valB = Number(b[i]) || 0;
    dot += valA * valB;
    normA += valA * valA;
    normB += valB * valB;
  }
  return normA > 0 && normB > 0 ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
}

function averageEmbedding(existingAvg, count, newEmbedding) {
  if (!existingAvg || !existingAvg.length) return [...newEmbedding];
  const updated = new Array(existingAvg.length);
  for (let i = 0; i < existingAvg.length; i++) {
    updated[i] = (existingAvg[i] * (count - 1) + newEmbedding[i]) / count;
  }
  return updated;
}

async function loadBase64Thumbnail(filePath, maxBytes = 40_000) {
  if (!filePath) return null;
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (error) {
    // Distinct from "too large below" so a reviewer's missing photo can be told apart from a resize failure.
    log('thumbnail_source_unreadable', { file_path: filePath, error: error.message });
    return null;
  }
  if (stat.size <= maxBytes) {
    try {
      const buf = await fs.readFile(filePath);
      return `data:image/jpeg;base64,${buf.toString('base64')}`;
    } catch (error) {
      log('thumbnail_source_unreadable', { file_path: filePath, error: error.message });
      return null;
    }
  }
  // Review thumbnails cross the database/API frequently; keep them small while the untouched source frame
  // remains linked as evidence. ffmpeg is already in this image for the extractor itself.
  const scaledPath = path.join(os.tmpdir(), `thumb-${crypto.randomUUID()}.jpg`);
  try {
    await execFileAsync('ffmpeg', [
      '-y', '-i', filePath,
      '-vf', "scale='min(480,iw)':-2",
      '-q:v', '8',
      scaledPath,
    ], { timeout: 15_000 });
    const scaledStat = await fs.stat(scaledPath);
    if (scaledStat.size > maxBytes) {
      log('thumbnail_still_oversized_after_resize', { file_path: filePath, bytes: scaledStat.size, max_bytes: maxBytes });
      return null;
    }
    const buf = await fs.readFile(scaledPath);
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  } catch (error) {
    log('thumbnail_resize_failed', { file_path: filePath, source_bytes: stat.size, error: error.message });
    return null;
  } finally {
    await fs.rm(scaledPath, { force: true }).catch(() => {});
  }
}

function representativeFrameScore(frame, bbox, confidence = 0) {
  if (!hasUsableFrame(frame)) return -Infinity;
  const area = Math.max(0, Number(bbox?.width) || 0) * Math.max(0, Number(bbox?.height) || 0);
  const sharpness = Math.min(1, Math.max(0, Number(frame?.sharpness_score) || 0) / 500);
  return Math.log1p(area) * 0.6 + sharpness * 0.4 + Math.min(1, Math.max(0, Number(confidence) || 0)) * 0.15;
}

async function consolidateFaces(frames, options = {}) {
  const simThreshold = options.faceSimilarityThreshold ?? DEFAULT_FACE_SIMILARITY_THRESHOLD;
  const maxGap = options.maxGapSeconds ?? DEFAULT_MAX_GAP_SECONDS;

  const faceFrames = frames.filter(
    (frame) => hasUsableFrame(frame) && frame.face?.success && Array.isArray(frame.face?.faces) && frame.face.faces.length > 0
  );

  // Subjects registry: subject_id -> { subject_id, subject_label, avgEmbedding, activeTrack: { ... }, completedTracks: [...] }
  const subjects = [];
  let nextSubjectId = 1;

  for (const frame of faceFrames) {
    const timestamp = Number(frame.relative_timestamp_seconds) || 0;
    // Two faces in one frame are two people: a subject can be claimed by at most one face per frame.
    const claimedThisFrame = new Set();
    for (const detectedFace of frame.face.faces) {
      const embedding = Array.isArray(detectedFace.embedding) ? detectedFace.embedding : null;
      if (!embedding || embedding.length === 0) continue;

      let bestSubject = null;
      let highestSim = -1;

      for (const subj of subjects) {
        if (claimedThisFrame.has(subj.subjectId)) continue;
        const sim = cosineSimilarity(embedding, subj.avgEmbedding);
        if (sim > highestSim) {
          highestSim = sim;
          bestSubject = subj;
        }
      }

      if (bestSubject && highestSim >= simThreshold) {
        // Matched existing person
        claimedThisFrame.add(bestSubject.subjectId);
        bestSubject.totalSightings++;
        bestSubject.avgEmbedding = averageEmbedding(bestSubject.avgEmbedding, bestSubject.totalSightings, embedding);

        const track = bestSubject.activeTrack;
        if (track && timestamp - track.lastSeen <= maxGap) {
          // Extend active track
          track.lastSeen = timestamp;
          track.frameCount++;
          const bbox = detectedFace.bbox || null;
          const bboxArea = bbox ? (bbox.width || 0) * (bbox.height || 0) : 0;
          if (representativeFrameScore(frame, bbox) > representativeFrameScore(track.bestFrame, track.bestBbox)) {
            track.bestBboxArea = bboxArea;
            track.bestFrame = frame;
            track.bestBbox = bbox;
            track.bestFace = detectedFace;
          }
        } else {
          // Gap exceeded: this person left and returned!
          if (track) {
            bestSubject.completedTracks.push(track);
          }
          const bbox = detectedFace.bbox || null;
          bestSubject.activeTrack = {
            subjectId: bestSubject.subjectId,
            subjectLabel: bestSubject.subjectLabel,
            isReturn: bestSubject.completedTracks.length > 0,
            firstSeen: timestamp,
            lastSeen: timestamp,
            frameCount: 1,
            bestFrame: frame,
            bestBbox: bbox,
            bestFace: detectedFace,
            bestBboxArea: bbox ? (bbox.width || 0) * (bbox.height || 0) : 0,
            similarityScore: highestSim,
          };
        }
      } else {
        // New unique person
        const subjectId = nextSubjectId++;
        claimedThisFrame.add(subjectId);
        const subjectLabel = `Person #${subjectId}`;
        const bbox = detectedFace.bbox || null;
        const newSubject = {
          subjectId,
          subjectLabel,
          avgEmbedding: [...embedding],
          totalSightings: 1,
          completedTracks: [],
          activeTrack: {
            subjectId,
            subjectLabel,
            isReturn: false,
            firstSeen: timestamp,
            lastSeen: timestamp,
            frameCount: 1,
            bestFrame: frame,
            bestBbox: bbox,
            bestFace: detectedFace,
            bestBboxArea: bbox ? (bbox.width || 0) * (bbox.height || 0) : 0,
            similarityScore: 1.0,
          },
        };
        subjects.push(newSubject);
      }
    }
  }

  // Collect all tracks
  const allTracks = [];
  for (const subj of subjects) {
    if (subj.activeTrack) subj.completedTracks.push(subj.activeTrack);
    allTracks.push(...subj.completedTracks.map((track) => ({ ...track, faceEmbedding: subj.avgEmbedding })));
  }

  // Return one representative event per identity. Visit windows remain in the
  // aggregate fields so repeated sightings are not lost, but the UI receives
  // one review card per person.
  const representativeTracks = subjects.map((subject) => {
    const tracks = subject.completedTracks;
    const bestTrack = tracks.reduce((best, track) => track.bestBboxArea > best.bestBboxArea ? track : best, tracks[0]);
    return {
      ...bestTrack,
      subjectId: subject.subjectId,
      subjectLabel: subject.subjectLabel,
      firstSeen: Math.min(...tracks.map((track) => track.firstSeen)),
      lastSeen: Math.max(...tracks.map((track) => track.lastSeen)),
      frameCount: tracks.reduce((sum, track) => sum + track.frameCount, 0),
      visitCount: tracks.length,
      isReturn: tracks.length > 1,
      faceEmbedding: subject.avgEmbedding,
    };
  }).sort((a, b) => a.firstSeen - b.firstSeen);

  // Format into consolidated face events
  const events = [];
  for (let i = 0; i < representativeTracks.length; i++) {
    const tr = representativeTracks[i];
    const duration = Math.max(0, Number((tr.lastSeen - tr.firstSeen).toFixed(2)));
    const thumbnail = await loadBase64Thumbnail(tr.bestFrame?.file_path);
    events.push({
      event_id: `face-${EVENT_PREFIX}-${tr.subjectId}-${i + 1}`,
      engine_version: ENGINE_VERSION,
      event_type: 'face',
      subject_id: tr.subjectId,
      subject_label: tr.subjectLabel,
      is_return: tr.isReturn,
      first_seen_seconds: Number(tr.firstSeen.toFixed(2)),
      last_seen_seconds: Number(tr.lastSeen.toFixed(2)),
      duration_seconds: duration,
      frame_count: tr.frameCount,
      visit_count: tr.visitCount,
      best_frame_hash: tr.bestFrame?.sha256_hash || null,
      best_bbox: tr.bestBbox,
      thumbnail,
      face_embedding: Array.isArray(tr.faceEmbedding) ? tr.faceEmbedding : null,
      face_provider: tr.bestFrame?.face?.provider || null,
      face_detector_model: tr.bestFace?.face_detector_model || null,
      face_embedding_model: tr.bestFace?.face_embedding_model || null,
      face_detector_confidence: clamp01(tr.bestFace?.detector_confidence),
      face_crop_width_px: Number.isFinite(Number(tr.bestFace?.face_crop_width_px)) ? Number(tr.bestFace.face_crop_width_px) : null,
      face_alignment_basis: tr.bestFace?.alignment_basis || null,
      review_state: 'manual_review_required',
    });
  }

  return { events, uniqueSubjectsCount: subjects.length };
}

// ── Engine v2: tracker-backed consolidation helpers ──────────────────────────────────────────────────────
function round2(value) {
  return Number(Number(value).toFixed(2));
}

// The frame within a track a reviewer should see: large, sharp, clear and confident.
function bestObservation(track) {
  return track.observations.reduce((best, observation) => (
    representativeFrameScore(observation.frame, observation.bbox, observation.confidence)
      > representativeFrameScore(best.frame, best.bbox, best.confidence) ? observation : best
  ), track.observations[0]);
}

function trackEvidence(track) {
  return {
    engine_version: ENGINE_VERSION,
    track_hits: track.hits,
    peak_confidence: track.peakConfidence,
    track_confirmed: track.confirmed,
    confirmation_basis: track.confirmationBasis,
    motion_state: track.motion_state,
    max_displacement_sizes: track.max_displacement_sizes,
  };
}

function detectorModelOf(frame) {
  const source = frame?.runpod || frame?.detect || null;
  return source?.detector_model || null;
}

function frameQualityState(frame) {
  return frame?.quality_state || (frame?.visual_quality === 'degraded' ? 'degraded' : 'clear');
}

// Weighted vote of one attribute over a track: a single dark frame cannot repaint a white car.
function voteAttribute(observations, read) {
  const totals = new Map();
  for (const observation of observations) {
    const answer = read(observation);
    if (!answer || answer.value === null || answer.value === undefined || answer.value === '') continue;
    const weight = Math.max(0.05, Number(answer.confidence) || 0.3) * Math.max(0.05, Number(observation.confidence) || 0.3);
    const entry = totals.get(answer.value) || { weight: 0, count: 0, confidenceSum: 0 };
    entry.weight += weight;
    entry.count += 1;
    entry.confidenceSum += Number(answer.confidence) || 0;
    totals.set(answer.value, entry);
  }
  if (!totals.size) return { value: null, confidence: null, votes: null };
  const [value, winner] = [...totals.entries()].sort((a, b) => b[1].weight - a[1].weight)[0];
  const totalCount = [...totals.values()].reduce((sum, entry) => sum + entry.count, 0);
  return {
    value,
    confidence: winner.confidenceSum > 0 ? Number((winner.confidenceSum / winner.count).toFixed(3)) : null,
    agreement: Number((winner.count / totalCount).toFixed(3)),
    votes: Object.fromEntries([...totals.entries()].map(([key, entry]) => [key, entry.count])),
  };
}

// People start a track at a lower confidence than vehicles: a side-on or partly hidden body is often weak in
// any single frame. A weak single-frame track is kept for the timeline but held out of the review queue.
const PERSON_TRACKER_OPTIONS = { startConfidence: 0.35 };
const ANIMAL_TRACKER_OPTIONS = { minConfidence: 0.2, startConfidence: 0.3 };

async function consolidatePeople(frames, options = {}) {
  const maxGap = options.maxGapSeconds ?? DEFAULT_MAX_GAP_SECONDS;
  const excludedQualityFrames = frames.filter((frame) => frame && !hasUsableFrame(frame)).length;
  const { tracks } = trackDetections(frames.filter(hasUsableFrame), (frame) => (Array.isArray(frame?.people?.people) ? frame.people.people : []).map((detection) => ({
    bbox: detection?.bbox,
    confidence: detection?.confidence,
    embedding: detection?.attributes?.appearance_embedding,
    embeddingModel: detection?.attributes?.appearance_embedding_model,
    payload: detection,
  })), { ...PERSON_TRACKER_OPTIONS, maxGapSeconds: maxGap });
  const weaponBudget = options.hints === false ? 0 : MAX_WEAPON_HINTS;
  const weaponChecked = new Set(tracks
    .filter((track) => track.confirmed)
    .sort((a, b) => b.hits - a.hits || b.peakConfidence - a.peakConfidence)
    .slice(0, weaponBudget)
    .map((track) => track.id));
  const ordered = [...tracks].sort((a, b) => a.firstSeen - b.firstSeen);
  const events = [];
  for (const [index, track] of ordered.entries()) {
    const best = bestObservation(track);
    const attributes = best.payload?.attributes || null;
    events.push({
      event_id: `person-${EVENT_PREFIX}-${index + 1}`,
      event_type: 'person',
      first_seen_seconds: round2(track.firstSeen),
      last_seen_seconds: round2(track.lastSeen),
      duration_seconds: round2(Math.max(0, track.lastSeen - track.firstSeen)),
      frame_count: track.hits,
      confidence: round2(track.confidence),
      ...trackEvidence(track),
      detector_model: detectorModelOf(best.frame),
      best_frame_hash: best.frame?.sha256_hash || null,
      best_bbox: best.bbox,
      attributes,
      appearance_embedding: Array.isArray(attributes?.appearance_embedding) ? attributes.appearance_embedding : null,
      appearance_embedding_model: attributes?.appearance_embedding_model || null,
      quality_state: frameQualityState(best.frame),
      gait_signature: buildGaitSignature(track.observations.map((observation) => ({ timestamp: observation.timestamp, center: bboxCenter(observation.bbox), width: observation.bbox.width, height: observation.bbox.height }))),
      thumbnail: await loadBase64Thumbnail(best.frame?.file_path),
      weapon_hint: weaponChecked.has(track.id) ? await getWeaponHint(best.frame?.file_path, best.bbox) : null,
      review_required: true,
      visual_quality_gate: excludedQualityFrames > 0 ? 'degraded_frames_excluded_from_person_inference' : 'clear',
      excluded_degraded_frame_count: 0,
      degraded_frame_count: excludedQualityFrames,
    });
  }
  return events;
}

// Animal detections (detector triage + species) tracked by position and time; the species is voted across
// the track so one blurry frame cannot rename a possum. Nothing here decides identity or action.
async function consolidateAnimals(frames, options = {}) {
  const maxGap = options.maxGapSeconds ?? DEFAULT_MAX_GAP_SECONDS;
  const statuses = new Set();
  const usable = frames.filter(hasUsableFrame);
  for (const frame of usable) {
    const container = frame.animals;
    if (container && !Array.isArray(container) && container.status) statuses.add(container.status);
  }
  const { tracks } = trackDetections(usable, (frame) => {
    const container = frame.animals;
    const detections = Array.isArray(container) ? container : Array.isArray(container?.animals) ? container.animals : [];
    return detections.map((detection) => ({ bbox: detection?.bbox, confidence: detection?.confidence, payload: detection }));
  }, { ...ANIMAL_TRACKER_OPTIONS, maxGapSeconds: maxGap });
  const events = [];
  for (const [index, track] of [...tracks].sort((a, b) => a.firstSeen - b.firstSeen).entries()) {
    const best = bestObservation(track);
    const speciesVotes = new Map();
    for (const observation of track.observations) {
      const detection = observation.payload || {};
      const species = detection.species || detection.coarse_label || 'other';
      const vote = speciesVotes.get(species) || { weight: 0, count: 0, detection };
      vote.weight += Number(detection.species_confidence) || Number(detection.confidence) * 0.5 || 0.1;
      vote.count += 1;
      if ((Number(detection.species_confidence) || 0) >= (Number(vote.detection.species_confidence) || 0)) vote.detection = detection;
      speciesVotes.set(species, vote);
    }
    const [species, vote] = [...speciesVotes.entries()].sort((a, b) => b[1].weight - a[1].weight)[0] || ['other', { count: 0, detection: best.payload }];
    const winner = vote.detection || best.payload || {};
    events.push({
      event_id: `animal-${EVENT_PREFIX}-${index + 1}`,
      event_type: 'animal',
      species,
      common_name: winner.common_name || null,
      is_pest: typeof winner.is_pest === 'boolean' ? winner.is_pest : null,
      species_confidence: Number.isFinite(Number(winner.species_confidence)) ? Number(Number(winner.species_confidence).toFixed(3)) : null,
      species_status: winner.species_status || 'model_not_staged',
      species_provider: winner.species_provider || null,
      species_votes: Object.fromEntries([...speciesVotes.entries()].map(([key, value]) => [key, value.count])),
      confidence: round2(track.confidence),
      ...trackEvidence(track),
      detector_model: detectorModelOf(best.frame),
      first_seen_seconds: round2(track.firstSeen),
      last_seen_seconds: round2(track.lastSeen),
      duration_seconds: round2(Math.max(0, track.lastSeen - track.firstSeen)),
      frame_count: track.hits,
      best_frame_hash: best.frame?.sha256_hash || null,
      best_bbox: best.bbox,
      quality_state: frameQualityState(best.frame),
      thumbnail: await loadBase64Thumbnail(best.frame?.file_path),
      review_required: true,
    });
  }
  return { events, detectionStatus: statuses.size ? [...statuses].join(',') : 'not_reported' };
}

function buildGaitSignature(samples) {
  if (!Array.isArray(samples) || samples.length < 4) return { state: 'insufficient_track', review_required: true };
  const ordered = [...samples].sort((left, right) => left.timestamp - right.timestamp);
  const duration = ordered[ordered.length - 1].timestamp - ordered[0].timestamp;
  if (duration < 0.8) return { state: 'insufficient_duration', review_required: true };
  const normalizedSpeeds = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const elapsed = ordered[index].timestamp - ordered[index - 1].timestamp;
    if (elapsed <= 0) continue;
    const distance = Math.hypot(ordered[index].center.x - ordered[index - 1].center.x, ordered[index].center.y - ordered[index - 1].center.y);
    normalizedSpeeds.push(distance / Math.max(1, ordered[index].height) / elapsed);
  }
  const aspectRatios = ordered.map((sample) => sample.height / Math.max(1, sample.width));
  const average = (values) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const deviation = (values) => {
    const mean = average(values);
    return Math.sqrt(average(values.map((value) => (value - mean) ** 2)));
  };
  return {
    state: 'provisional_motion_signature',
    sample_count: ordered.length,
    duration_seconds: Number(duration.toFixed(2)),
    normalized_speed_body_lengths_per_second: Number(average(normalizedSpeeds).toFixed(4)),
    speed_variability: Number(deviation(normalizedSpeeds).toFixed(4)),
    silhouette_ratio_mean: Number(average(aspectRatios).toFixed(4)),
    silhouette_oscillation: Number(deviation(aspectRatios).toFixed(4)),
    walking_style_label: null,
    identity_resolution: 'manual_review_required',
    review_required: true,
  };
}

function isPlatish(plate, confidence) {
  if (!plate || typeof plate !== 'string') return false;
  const clean = plate.trim().toUpperCase();
  if (clean.length < 2 || clean.length > 8) return false;
  // If 2 chars, require higher confidence to avoid single-letter OCR noise
  if (clean.length === 2 && confidence < 0.75) return false;
  // If only digits of length <= 2, filter out noise
  if (/^\d{1,2}$/.test(clean)) return false;
  return true;
}

function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

// ── Vehicles: every detected vehicle tracked, plate reads attached to the vehicle that carries them ─────────
const PLATE_ATTACH_IOU = 0.5;
const PLATE_CONFLICT_RATIO = 0.5;

function rawVehicleDetections(frame) {
  const fromList = (list) => list.map((vehicle) => ({
    bbox: vehicle?.bbox || vehicle?.attributes?.detection?.bbox,
    confidence: vehicle?.confidence ?? vehicle?.attributes?.detection?.confidence,
    attributes: vehicle?.attributes || null,
  }));
  if (Array.isArray(frame?.runpod?.vehicles)) return fromList(frame.runpod.vehicles);
  if (Array.isArray(frame?.detect?.vehicles)) return fromList(frame.detect.vehicles);
  const legacy = frame?.runpod?.vehicle;
  if (legacy?.detection?.bbox) return [{ bbox: legacy.detection.bbox, confidence: legacy.detection.confidence, attributes: legacy }];
  return [];
}

function isVehicleArtifact(detection) {
  if (detection.attributes?.vehicle_crop_status === 'full_frame_review_only') return true;
  const bbox = normaliseBbox(detection.bbox);
  if (!bbox) return true;
  // A full-frame box anchored at the origin is a camera/model artifact, not a vehicle candidate.
  return bbox.x === 0 && bbox.y === 0 && bbox.width >= VEHICLE_ARTIFACT_MIN_WIDTH && bbox.height >= VEHICLE_ARTIFACT_MIN_HEIGHT;
}

function vehicleDetectionsFor(frame) {
  return rawVehicleDetections(frame)
    .filter((detection) => !isVehicleArtifact(detection))
    .map((detection) => ({
      bbox: detection.bbox,
      confidence: detection.confidence,
      embedding: detection.attributes?.appearance_embedding,
      embeddingModel: detection.attributes?.appearance_embedding_model,
      payload: detection,
    }));
}

// Every plate reading on one frame, one per plate string (strongest kept).
function plateReadsFor(frame) {
  const alpr = frame?.alpr;
  if (!alpr?.success) return [];
  const timestamp = Number(frame.relative_timestamp_seconds) || 0;
  const byPlate = new Map();
  const add = (rawPlate, rawConfidence, box, vehicleBbox, detail) => {
    if (typeof rawPlate !== 'string') return;
    const plate = rawPlate.trim().toUpperCase();
    const confidence = Number(rawConfidence) || 0;
    if (!isPlatish(plate, confidence)) return;
    if (byPlate.has(plate) && byPlate.get(plate).confidence >= confidence) return;
    byPlate.set(plate, { plate, confidence, box: normaliseBbox(box), vehicleBbox: normaliseBbox(vehicleBbox), detail: detail || null, frame, timestamp });
  };
  for (const result of Array.isArray(alpr.results) ? alpr.results : []) add(result?.plate, result?.score ?? result?.confidence, result?.box, result?.vehicle_bbox, result);
  if (!byPlate.size) add(alpr.plate, alpr.confidence, alpr.box || alpr.plate_bbox, null, null);
  return [...byPlate.values()];
}

// The tracked vehicle a reading belongs to: the reader's own vehicle box first, then the vehicle the plate
// sits inside, then the only vehicle in the frame when the reading carries no geometry at all.
function plateOwner(read, candidates) {
  if (!candidates.length) return null;
  if (read.vehicleBbox) {
    const [best] = candidates.map((candidate) => ({ candidate, iou: bboxIou(candidate.observation.bbox, read.vehicleBbox) })).sort((a, b) => b.iou - a.iou);
    if (best.iou >= PLATE_ATTACH_IOU) return best.candidate;
  }
  if (read.box) {
    const centre = bboxCenter(read.box);
    const containing = candidates
      .filter((candidate) => bboxContainsPoint(candidate.observation.bbox, centre, 0.1))
      .sort((a, b) => a.observation.bbox.width * a.observation.bbox.height - b.observation.bbox.width * b.observation.bbox.height);
    return containing[0] || null;
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function platesCompatible(a, b) {
  return a === b || (a.length >= 4 && b.length >= 4 && levenshteinDistance(a, b) <= 1);
}

// Weighted clustering of plate strings (edit distance <= 1 joins one-character OCR slips). Each cluster's
// plate is the exact string with the most weight behind it.
function clusterPlates(items, canJoin = () => true) {
  const clusters = [];
  for (const item of [...items].sort((a, b) => b.weight - a.weight)) {
    const cluster = clusters.find((candidate) => platesCompatible(candidate.anchor, item.plate) && canJoin(candidate, item));
    if (cluster) {
      cluster.items.push(item);
      cluster.weight += item.weight;
    } else {
      clusters.push({ anchor: item.plate, weight: item.weight, items: [item] });
    }
  }
  for (const cluster of clusters) {
    const totals = new Map();
    for (const item of cluster.items) totals.set(item.plate, (totals.get(item.plate) || 0) + item.weight);
    cluster.plate = [...totals.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0];
  }
  return clusters.sort((a, b) => b.weight - a.weight);
}

function mergeVisits(intervals, maxGap) {
  const merged = [];
  for (const interval of [...intervals].sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last && interval.start - last.end <= maxGap) last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

function meanSpeed(points, maxGap) {
  const ordered = [...points].sort((a, b) => a.timestamp - b.timestamp);
  const samples = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const elapsed = ordered[index].timestamp - ordered[index - 1].timestamp;
    if (!(elapsed > 0) || elapsed > maxGap) continue;
    samples.push(Math.hypot(ordered[index].center.x - ordered[index - 1].center.x, ordered[index].center.y - ordered[index - 1].center.y) / elapsed);
  }
  return samples.length ? Number((samples.reduce((sum, value) => sum + value, 0) / samples.length).toFixed(2)) : null;
}

// Vehicle attribute data for the frame when no tracked detection owns the reading. Frame-level data
// describes the first vehicle only, so it is trusted only when the frame held at most one vehicle.
function frameVehicleData(frame) {
  if (rawVehicleDetections(frame).length > 1) return {};
  return frame?.inference?.data || frame?.runpod?.vehicle || {};
}

function plateMaskBoxes(frame) {
  const alpr = frame?.alpr || {};
  return [
    alpr.box, alpr.plate_bbox,
    ...(Array.isArray(alpr.results) ? alpr.results.map((item) => item?.box) : []),
    ...(Array.isArray(alpr.located_plates) ? alpr.located_plates.map((item) => item?.box) : []),
    ...(Array.isArray(alpr.rejected) ? alpr.rejected.map((item) => item?.box) : []),
  ].map(normaliseBbox).filter(Boolean);
}

function cloudHintContext(frame, options, sourceEventId) {
  const policy = options.cloudVehicleVlm;
  if (!policy?.enabled) return {};
  const alpr = frame?.alpr || {};
  const located = Array.isArray(alpr.located_plates) ? alpr.located_plates.length : 0;
  return {
    cloud: {
      enabled: true,
      model: policy.model || null,
      recordReceipt: policy.recordReceipt,
      sourceEventId,
      plateScanned: alpr.success === true,
      plateBoxesComplete: alpr.success === true && (Number(alpr.plates_detected) || 0) <= Math.max(located, plateMaskBoxes(frame).length),
      plateBoxes: plateMaskBoxes(frame),
      personScanned: frame?.people?.success === true,
      personBoxes: [
        ...(Array.isArray(frame?.people?.people) ? frame.people.people.map((person) => person?.bbox) : []),
        ...(Array.isArray(frame?.face?.faces) ? frame.face.faces.map((face) => face?.bbox) : []),
      ],
    },
  };
}

function plateScanState(track) {
  let scanned = false;
  for (const observation of track.observations) {
    const alpr = observation.frame?.alpr;
    if (!alpr?.success) continue;
    scanned = true;
    const located = Array.isArray(alpr.located_plates) ? alpr.located_plates : [];
    if (located.some((plate) => {
      const box = normaliseBbox(plate?.box);
      return box && bboxContainsPoint(observation.bbox, bboxCenter(box), 0.1);
    })) return 'plate_located_unreadable';
  }
  return scanned ? 'scanned_no_plate_found' : 'plate_not_scanned';
}

function vehicleAttributeFields(observations, fallback = {}) {
  const colour = voteAttribute(observations, (observation) => {
    const attributes = observation.payload?.attributes;
    return attributes ? { value: attributes.vehicle_colour ?? attributes.vehicle_color ?? null, confidence: attributes.vehicle_colour_confidence } : null;
  });
  const type = voteAttribute(observations, (observation) => {
    const attributes = observation.payload?.attributes;
    return attributes ? { value: attributes.vehicle_type ?? null, confidence: attributes.vehicle_type_confidence } : null;
  });
  return {
    vehicle_colour: colour.value ?? fallback.vehicle_colour ?? fallback.vehicle_color ?? null,
    vehicle_colour_confidence: colour.value ? colour.confidence : fallback.vehicle_colour_confidence ?? null,
    vehicle_colour_votes: colour.votes,
    vehicle_type: type.value ?? fallback.vehicle_type ?? null,
    vehicle_type_confidence: type.value ? type.confidence : fallback.vehicle_type_confidence ?? null,
    vehicle_type_votes: type.votes,
  };
}

function vehicleDataFields(vehicleData) {
  return {
    vehicle_year: vehicleData.vehicle_year ?? null,
    vehicle_attribute_confidence: vehicleData.vehicle_attribute_confidence ?? null,
    vehicle_attribute_model: vehicleData.vehicle_model_name ?? null,
    vehicle_attribute_status: vehicleData.vehicle_attribute_status ?? vehicleData.attribute_status ?? null,
    vehicle_crop_status: vehicleData.vehicle_crop_status ?? null,
    inference_provider: vehicleData.inference_provider ?? null,
    appearance_embedding: Array.isArray(vehicleData.appearance_embedding) ? vehicleData.appearance_embedding : null,
    appearance_embedding_model: vehicleData.appearance_embedding_model ?? null,
  };
}

async function consolidateVehicles(frames, options = {}) {
  const maxGap = options.maxGapSeconds ?? DEFAULT_MAX_GAP_SECONDS;
  const metersPerPixel = Number(options.metersPerPixel) > 0 ? Number(options.metersPerPixel) : null;
  const usable = frames.filter(hasUsableFrame);
  const { tracks } = trackDetections(usable, vehicleDetectionsFor, { maxGapSeconds: maxGap });

  const observationsByFrame = new Map();
  for (const track of tracks) {
    for (const observation of track.observations) {
      if (!observationsByFrame.has(observation.frame)) observationsByFrame.set(observation.frame, []);
      observationsByFrame.get(observation.frame).push({ track, observation });
    }
  }
  const readsByTrack = new Map();
  const orphanReads = [];
  for (const frame of usable) {
    for (const read of plateReadsFor(frame)) {
      const owner = plateOwner(read, observationsByFrame.get(frame) || []);
      if (!owner) { orphanReads.push(read); continue; }
      if (!readsByTrack.has(owner.track.id)) readsByTrack.set(owner.track.id, []);
      readsByTrack.get(owner.track.id).push({ ...read, track: owner.track, observation: owner.observation });
    }
  }

  // One plate per tracked vehicle by weighted vote; a strong second plate on the same vehicle is a conflict
  // the reviewer must see (trailer plate, reflection, two cars merged into one box).
  const platedTracks = [];
  const unplatedTracks = [];
  for (const track of tracks) {
    const reads = readsByTrack.get(track.id) || [];
    if (!reads.length) { unplatedTracks.push(track); continue; }
    const clusters = clusterPlates(reads.map((read) => ({ plate: read.plate, weight: Math.max(0.05, read.confidence), read })));
    const [winner, runnerUp] = clusters;
    platedTracks.push({
      track,
      plate: winner.plate,
      weight: winner.weight,
      reads: winner.items.map((item) => item.read),
      conflict: Boolean(runnerUp && runnerUp.weight >= winner.weight * PLATE_CONFLICT_RATIO),
      alternatives: clusters.slice(1).map((cluster) => cluster.plate),
    });
  }
  const plateEntities = clusterPlates([
    ...platedTracks.map((platedTrack) => ({ plate: platedTrack.plate, weight: platedTrack.weight, platedTrack })),
    ...orphanReads.map((read) => ({ plate: read.plate, weight: Math.max(0.05, read.confidence), read })),
  ], (cluster, item) => {
    // Two tracked vehicles on screen at the same time are two vehicles, whatever one OCR slip suggests.
    const track = item.platedTrack?.track;
    if (!track) return true;
    return !cluster.items.some((other) => {
      const otherTrack = other.platedTrack?.track;
      return otherTrack && other.plate !== item.plate && otherTrack.firstSeen <= track.lastSeen && track.firstSeen <= otherTrack.lastSeen;
    });
  });

  const platedEvents = [];
  for (const entity of plateEntities) {
    const entityTracks = entity.items.filter((item) => item.platedTrack).map((item) => item.platedTrack);
    const entityOrphans = entity.items.filter((item) => item.read).map((item) => item.read);
    const reads = [...entityTracks.flatMap((platedTrack) => platedTrack.reads), ...entityOrphans];
    const bestRead = reads.reduce((best, read) => (read.confidence > best.confidence ? read : best), reads[0]);
    const frameSet = new Set([...entityTracks.flatMap((platedTrack) => platedTrack.track.observations.map((observation) => observation.frame)), ...entityOrphans.map((read) => read.frame)]);
    const visits = mergeVisits([
      ...entityTracks.map((platedTrack) => ({ start: platedTrack.track.firstSeen, end: platedTrack.track.lastSeen })),
      ...entityOrphans.map((read) => ({ start: read.timestamp, end: read.timestamp })),
    ], maxGap);
    const firstSeen = visits[0].start;
    const lastSeen = visits[visits.length - 1].end;
    const bestTrack = bestRead.track || entityTracks.map((platedTrack) => platedTrack.track).sort((a, b) => b.hits - a.hits)[0] || null;
    const bestVisit = visits.find((visit) => bestRead.timestamp >= visit.start && bestRead.timestamp <= visit.end) || visits[0];
    const speedPxPerSecond = bestTrack
      ? meanSpeed(bestTrack.observations.map((observation) => ({ timestamp: observation.timestamp, center: bboxCenter(observation.bbox) })), maxGap)
      : meanSpeed(entityOrphans.filter((read) => read.box && read.timestamp >= bestVisit.start && read.timestamp <= bestVisit.end).map((read) => ({ timestamp: read.timestamp, center: bboxCenter(read.box) })), maxGap);
    const trackObservations = entityTracks.flatMap((platedTrack) => platedTrack.track.observations);
    const bestDetection = bestRead.observation?.payload || (bestTrack ? bestObservation(bestTrack).payload : null);
    const vehicleData = bestDetection?.attributes || frameVehicleData(bestRead.frame);
    const alprData = bestRead.frame?.alpr || {};
    const alprBest = bestRead.detail || (Array.isArray(alprData.results) ? alprData.results.find((item) => item?.plate === bestRead.plate) || null : null);
    const votes = {};
    for (const read of reads) votes[read.plate] = (votes[read.plate] || 0) + 1;
    const peakDetector = entityTracks.length ? Math.max(...entityTracks.map((platedTrack) => platedTrack.track.peakConfidence)) : null;
    const frameCount = frameSet.size;
    const conflict = entityTracks.some((platedTrack) => platedTrack.conflict);
    platedEvents.push({
      event_id: `vehicle-${EVENT_PREFIX}-${entity.plate}`,
      event_type: 'vehicle',
      plate: entity.plate,
      confidence: round2(bestRead.confidence),
      plate_votes: votes,
      plate_read_count: reads.length,
      plate_conflict: conflict,
      plate_alternatives: conflict ? [...new Set(entityTracks.flatMap((platedTrack) => platedTrack.alternatives))] : null,
      plate_attachment: entityTracks.length ? (entityOrphans.length ? 'tracked_vehicle_and_unattached_reads' : 'tracked_vehicle') : 'plate_only',
      alpr_provider: alprData.alpr_provider ?? null,
      alpr_models: alprData.alpr_models ?? null,
      alpr_evidence_quality: alprBest?.evidence_quality ?? alprData.evidence_quality ?? null,
      plate_raw_text: alprBest?.raw_text ?? null,
      plate_corrections: Array.isArray(alprBest?.corrections) && alprBest.corrections.length ? alprBest.corrections : null,
      plate_char_confidence_min: alprBest?.char_confidence_min ?? null,
      plate_width_px: alprBest?.plate_width_px ?? null,
      plate_bbox: bestRead.box,
      detector_provider: bestRead.frame?.runpod?.detector_provider ?? bestRead.frame?.detect?.detector_provider ?? null,
      detector_model: detectorModelOf(bestRead.frame),
      engine_version: ENGINE_VERSION,
      track_hits: entityTracks.reduce((sum, platedTrack) => sum + platedTrack.track.hits, 0),
      detector_confidence: entityTracks.length ? round2(Math.max(...entityTracks.map((platedTrack) => platedTrack.track.confidence))) : null,
      peak_confidence: Number(Math.max(bestRead.confidence, peakDetector ?? 0).toFixed(3)),
      track_confirmed: frameCount >= 2 || bestRead.confidence >= SINGLE_FRAME_REVIEW_CONFIDENCE,
      confirmation_basis: frameCount >= 2 ? 'temporal_consensus' : 'single_frame_plate_read',
      motion_state: bestTrack?.motion_state ?? 'unknown',
      max_displacement_sizes: bestTrack?.max_displacement_sizes ?? null,
      is_return: visits.length > 1,
      first_seen_seconds: round2(firstSeen),
      last_seen_seconds: round2(lastSeen),
      duration_seconds: Math.max(0, round2(lastSeen - firstSeen)),
      frame_count: frameCount,
      visit_count: visits.length,
      temporal_consensus: frameCount >= 2,
      best_frame_hash: bestRead.frame?.sha256_hash || null,
      best_bbox: bestRead.observation?.bbox ?? bestRead.vehicleBbox ?? normaliseBbox(vehicleData.detection?.bbox) ?? bestRead.box ?? normaliseBbox(alprData.plate_bbox),
      thumbnail: await loadBase64Thumbnail(bestRead.frame?.file_path),
      vehicle_make: vehicleData.vehicle_make ?? null,
      vehicle_model: vehicleData.vehicle_model ?? null,
      vehicle_make_model_source: vehicleData.vehicle_make || vehicleData.vehicle_model ? (vehicleData.vehicle_make_model_source ?? null) : null,
      ...vehicleAttributeFields(trackObservations, vehicleData),
      ...vehicleDataFields(vehicleData),
      quality_state: frameQualityState(bestRead.frame),
      speed_px_per_second: speedPxPerSecond,
      speed_kmh: speedPxPerSecond !== null && metersPerPixel !== null ? Number((speedPxPerSecond * metersPerPixel * 3.6).toFixed(2)) : null,
      speed_calibration: metersPerPixel === null ? 'uncalibrated' : 'camera_scale',
      review_required: frameCount < 2 || bestRead.confidence < 0.75 || conflict,
      _hint_frame: bestRead.frame,
      _hint_bbox: bestRead.observation?.bbox ?? bestRead.vehicleBbox ?? null,
    });
  }
  platedEvents.sort((a, b) => a.first_seen_seconds - b.first_seen_seconds);

  const unplatedEvents = [];
  for (const [index, track] of [...unplatedTracks].sort((a, b) => a.firstSeen - b.firstSeen).entries()) {
    const best = bestObservation(track);
    const vehicleData = best.payload?.attributes || {};
    unplatedEvents.push({
      event_id: `vehicle-${EVENT_PREFIX}-unconfirmed-${index + 1}`,
      event_type: 'vehicle',
      plate: 'Unconfirmed vehicle',
      plate_scan_state: plateScanState(track),
      confidence: round2(track.confidence),
      ...trackEvidence(track),
      detector_provider: best.frame?.runpod?.detector_provider ?? best.frame?.detect?.detector_provider ?? null,
      detector_model: detectorModelOf(best.frame),
      is_return: false,
      first_seen_seconds: round2(track.firstSeen),
      last_seen_seconds: round2(track.lastSeen),
      duration_seconds: round2(Math.max(0, track.lastSeen - track.firstSeen)),
      frame_count: track.hits,
      visit_count: 1,
      best_frame_hash: best.frame?.sha256_hash || null,
      best_bbox: best.bbox,
      thumbnail: await loadBase64Thumbnail(best.frame?.file_path),
      vehicle_make: vehicleData.vehicle_make ?? null,
      vehicle_model: vehicleData.vehicle_model ?? null,
      vehicle_make_model_source: vehicleData.vehicle_make || vehicleData.vehicle_model ? (vehicleData.vehicle_make_model_source ?? null) : null,
      ...vehicleAttributeFields(track.observations, vehicleData),
      ...vehicleDataFields(vehicleData),
      quality_state: frameQualityState(best.frame),
      review_required: true,
      temporal_consensus: track.hits >= 2,
      candidate_state: 'unconfirmed_vehicle_without_plate',
      _hint_frame: best.frame,
      _hint_bbox: best.bbox,
    });
  }

  const events = [...platedEvents, ...unplatedEvents];
  await applyVehicleHints(events, options);
  for (const event of events) {
    delete event._hint_frame;
    delete event._hint_bbox;
  }
  return { events, uniqueVehiclesCount: plateEntities.length + unplatedTracks.length };
}

// A make/model hint is asked for only where nothing deterministic already named the vehicle, plated and
// confirmed vehicles first, within a per-clip budget so a busy car park cannot stall the queue.
async function applyVehicleHints(events, options) {
  const budget = options.hints === false ? 0 : MAX_VEHICLE_HINTS;
  const wanted = events
    .filter((event) => !event.vehicle_make && !event.vehicle_model)
    .sort((a, b) => Number(b.plate !== 'Unconfirmed vehicle') - Number(a.plate !== 'Unconfirmed vehicle')
      || Number(Boolean(b.track_confirmed)) - Number(Boolean(a.track_confirmed))
      || (b.peak_confidence || 0) - (a.peak_confidence || 0));
  const chosen = new Set(wanted.slice(0, budget));
  for (const event of events) {
    if (event.vehicle_make || event.vehicle_model) {
      event.vehicle_make_model_status = 'detector_attribute';
      continue;
    }
    if (!chosen.has(event)) {
      event.vehicle_make_model_status = options.hints === false ? 'not_requested' : 'hint_budget_exhausted';
      continue;
    }
    const frame = event._hint_frame;
    const bbox = event._hint_bbox;
    if (!frame?.file_path || !bbox) {
      event.vehicle_make_model_status = 'no_crop';
      continue;
    }
    const hint = await getVehicleVisionHint(frame.file_path, bbox, cloudHintContext(frame, options, event.event_id));
    Object.assign(event, {
      vehicle_make: hint.vehicle_make ?? null,
      vehicle_model: hint.vehicle_model ?? null,
      vehicle_make_model_source: hint.vehicle_make_model_source ?? null,
      vehicle_make_model_status: hint.vehicle_make_model_status ?? null,
      vehicle_make_model_confidence: hint.vehicle_make_model_confidence ?? null,
      vehicle_make_model_evidence: hint.vehicle_make_model_evidence ?? null,
      vehicle_make_model_model: hint.vehicle_make_model_model ?? null,
      vehicle_make_model_tier: hint.vehicle_make_model_tier ?? null,
      vehicle_make_model_receipt: hint.vehicle_make_model_receipt ?? null,
      vlm_body_type: hint.vlm_body_type ?? null,
      vlm_colour: hint.vlm_colour ?? null,
    });
  }
}

function isoAt(baseMillis, seconds) {
  if (!Number.isFinite(baseMillis)) return null;
  return new Date(baseMillis + Math.max(0, Number(seconds) || 0) * 1000).toISOString();
}

function overlapSeconds(a, b) {
  return Math.min(a.last_seen_seconds, b.last_seen_seconds) - Math.max(a.first_seen_seconds, b.first_seen_seconds);
}

function isUsableQuality(state) {
  return !UNUSABLE_QUALITY_STATES.has(String(state || 'clear'));
}

function hasUsableFrame(frame) {
  return Boolean(frame) && frame.visual_quality !== 'degraded' && isUsableQuality(frame.quality_state);
}

// A candidate enters the human review queue only on temporal consensus (two or more frames), a face, or one
// very confident frame. The single-frame test uses the peak detection, not the evidence-discounted score.
function isReviewableCandidate(event, { hasFaceEvidence = false } = {}) {
  if (!isUsableQuality(event?.quality_state)) return false;
  const frameCount = Number(event?.frame_count) || 0;
  if (frameCount >= 2 || hasFaceEvidence) return true;
  return Number(event?.peak_confidence ?? event?.confidence) >= SINGLE_FRAME_REVIEW_CONFIDENCE;
}

// Engine provenance carried on every observation so accuracy can be measured per engine and detector.
function engineAttributes(event) {
  return {
    engine_version: event.engine_version || null,
    detector_model: event.detector_model || null,
    track_hits: event.track_hits ?? null,
    peak_confidence: event.peak_confidence ?? null,
    track_confirmed: typeof event.track_confirmed === 'boolean' ? event.track_confirmed : null,
    confirmation_basis: event.confirmation_basis || null,
    motion_state: event.motion_state || null,
    max_displacement_sizes: event.max_displacement_sizes ?? null,
  };
}

// Animals keep the biosecurity recall rule: a missed pest costs more than a reviewer dismissing a false one,
// so every usable animal track is queued. The weak single-frame ones carry their own basis so their precision
// is measured separately (cctv_accuracy_summary) before anyone tightens this.
function isReviewQueued(event, kind, options = {}) {
  if (kind === 'animal') return isUsableQuality(event?.quality_state);
  return isReviewableCandidate(event, options);
}

function reviewCandidateBasis(event, hasFaceEvidence = false) {
  if (hasFaceEvidence) return 'face_backed';
  if ((Number(event?.frame_count) || 0) >= 2) return 'temporal_consensus';
  if (event?.event_type === 'animal' && Number(event?.peak_confidence ?? event?.confidence) < SINGLE_FRAME_REVIEW_CONFIDENCE) return 'biosecurity_recall_single_frame';
  return 'single_frame_high_confidence';
}

// One observation per tracked entity, in the shape record_cctv_entity_observations() accepts. Absolute
// times come from the recording start the intake recorded (TAPO file name) or the evidence capture time.
// Identity fields are never set here: the reviewer decides, and the database clusters portfolios.
function buildEntityObservations(summary, context = {}) {
  const events = summary?.consolidated_events;
  if (!events) return [];
  const base = Date.parse(context.recordedStartAt || context.capturedAt || '');
  if (!Number.isFinite(base)) return [];
  const observations = [];
  for (const event of events.vehicle_events || []) {
    if (!isReviewableCandidate(event)) continue;
    const plated = event.plate && event.plate !== 'Unconfirmed vehicle';
    observations.push({
      source_event_id: event.event_id,
      entity_kind: 'vehicle',
      observed_at: isoAt(base, event.first_seen_seconds),
      observed_to: isoAt(base, event.last_seen_seconds),
      candidate_label: plated ? event.plate : (event.vehicle_colour || event.vehicle_type ? [event.vehicle_colour, event.vehicle_type].filter(Boolean).join(' ') : null),
      candidate_plate: plated ? event.plate : null,
      appearance_embedding: event.appearance_embedding || null,
      model_confidence: clamp01(event.confidence),
      quality_state: event.quality_state || 'clear',
      attributes: stripNulls({
        make: event.vehicle_make, model: event.vehicle_model, make_model_source: event.vehicle_make_model_source,
        colour: event.vehicle_colour, body_type: event.vehicle_type, year: event.vehicle_year,
        attribute_confidence: event.vehicle_attribute_confidence,
        colour_confidence: event.vehicle_colour_confidence, body_type_confidence: event.vehicle_type_confidence,
        vehicle_attribute_model: event.vehicle_attribute_model, vehicle_attribute_status: event.vehicle_attribute_status,
        vehicle_crop_status: event.vehicle_crop_status, vehicle_attribute_source: event.inference_provider,
        plate_confidence: plated ? event.confidence : null,
        bbox: event.best_bbox, frame_count: event.frame_count, visit_count: event.visit_count, temporal_consensus: event.temporal_consensus,
        speed_kmh: event.speed_kmh, inference_provider: event.inference_provider, appearance_embedding_model: event.appearance_embedding_model,
        alpr_provider: plated ? event.alpr_provider : null, alpr_models: plated ? event.alpr_models : null, alpr_evidence_quality: plated ? event.alpr_evidence_quality : null,
        plate_raw_text: plated ? event.plate_raw_text : null, plate_corrections: plated ? event.plate_corrections : null,
        plate_char_confidence_min: plated ? event.plate_char_confidence_min : null, plate_width_px: plated ? event.plate_width_px : null,
        detector_provider: event.detector_provider,
        candidate_state: event.candidate_state, review_candidate_basis: reviewCandidateBasis(event),
        ...engineAttributes(event),
        plate_votes: plated ? event.plate_votes : null, plate_read_count: plated ? event.plate_read_count : null,
        plate_conflict: plated && event.plate_conflict ? true : null, plate_alternatives: plated ? event.plate_alternatives : null,
        plate_attachment: plated ? event.plate_attachment : null, plate_bbox: plated ? event.plate_bbox : null,
        plate_scan_state: plated ? null : event.plate_scan_state, detector_confidence: event.detector_confidence,
        colour_votes: event.vehicle_colour_votes, body_type_votes: event.vehicle_type_votes,
        make_model_status: event.vehicle_make_model_status, make_model_confidence: event.vehicle_make_model_confidence,
        make_model_evidence: event.vehicle_make_model_evidence, make_model_model: event.vehicle_make_model_model, make_model_tier: event.vehicle_make_model_tier,
        make_model_receipt_id: event.vehicle_make_model_receipt?.id, vlm_body_type: event.vlm_body_type, vlm_colour: event.vlm_colour,
      }),
      frame_sha256: event.best_frame_hash || null,
      thumbnail: event.thumbnail || null,
    });
  }
  const faceEvents = (events.face_events || []).filter((event) => Array.isArray(event.face_embedding) && event.face_embedding.length);
  const claimedFaces = new Set();
  for (const event of events.person_events || []) {
    if (!isUsableQuality(event.quality_state)) continue;
    // A body track establishes only that a person was at the place. It becomes an identity-review
    // observation only when a usable face track overlaps it.
    const face = faceEvents
      .filter((candidate) => !claimedFaces.has(candidate.event_id) && overlapSeconds(candidate, event) >= 0)
      .sort((a, b) => overlapSeconds(b, event) - overlapSeconds(a, event))[0] || null;
    if (!face) continue;
    claimedFaces.add(face.event_id);
    observations.push({
      source_event_id: event.event_id,
      entity_kind: 'person',
      observed_at: isoAt(base, event.first_seen_seconds),
      observed_to: isoAt(base, event.last_seen_seconds),
      candidate_label: face?.subject_label || null,
      candidate_embedding: face?.face_embedding || null,
      appearance_embedding: event.appearance_embedding || null,
      model_confidence: clamp01(event.confidence),
      quality_state: event.quality_state || 'clear',
      attributes: stripNulls({
        bbox: event.best_bbox, frame_count: event.frame_count, upper_body_colour: event.attributes?.upper_body_colour, lower_body_colour: event.attributes?.lower_body_colour,
        visible_head_region: event.attributes?.visible_head_region?.colour, gait: event.gait_signature?.state === 'provisional_motion_signature' ? event.gait_signature : null,
        face_event_id: face?.event_id, face_visit_count: face?.visit_count, appearance_embedding_model: event.appearance_embedding_model,
        face_provider: face?.face_provider, face_detector_model: face?.face_detector_model, face_embedding_model: face?.face_embedding_model,
        face_detector_confidence: face?.face_detector_confidence, face_crop_width_px: face?.face_crop_width_px,
        face_alignment_basis: face?.face_alignment_basis,
        weapon_hint: event.weapon_hint,
        review_candidate_basis: reviewCandidateBasis(event, Boolean(face)),
        ...engineAttributes(event),
      }),
      frame_sha256: event.best_frame_hash || null,
      thumbnail: event.thumbnail || face?.thumbnail || null,
    });
  }
  for (const face of faceEvents) {
    if (claimedFaces.has(face.event_id)) continue;
    observations.push({
      source_event_id: face.event_id,
      entity_kind: 'person',
      observed_at: isoAt(base, face.first_seen_seconds),
      observed_to: isoAt(base, face.last_seen_seconds),
      candidate_label: face.subject_label || null,
      candidate_embedding: face.face_embedding,
      model_confidence: null,
      quality_state: 'clear',
      attributes: stripNulls({
        bbox: face.best_bbox, frame_count: face.frame_count, visit_count: face.visit_count, face_only: true,
        face_provider: face.face_provider, face_detector_model: face.face_detector_model, face_embedding_model: face.face_embedding_model,
        face_detector_confidence: face.face_detector_confidence, face_crop_width_px: face.face_crop_width_px,
        face_alignment_basis: face.face_alignment_basis,
        engine_version: face.engine_version,
      }),
      frame_sha256: face.best_frame_hash || null,
      thumbnail: face.thumbnail || null,
    });
  }
  for (const event of events.animal_events || []) {
    if (!isReviewQueued(event, 'animal')) continue;
    observations.push({
      source_event_id: event.event_id,
      entity_kind: 'animal',
      observed_at: isoAt(base, event.first_seen_seconds),
      observed_to: isoAt(base, event.last_seen_seconds),
      candidate_label: event.common_name || event.species || null,
      animal_type: event.species || null,
      species_confidence: clamp01(event.species_confidence),
      is_pest: typeof event.is_pest === 'boolean' ? event.is_pest : undefined,
      model_confidence: clamp01(event.confidence),
      quality_state: event.quality_state || 'clear',
      attributes: stripNulls({ bbox: event.best_bbox, frame_count: event.frame_count, species_status: event.species_status, species_provider: event.species_provider, species_votes: event.species_votes, review_candidate_basis: reviewCandidateBasis(event), ...engineAttributes(event) }),
      frame_sha256: event.best_frame_hash || null,
      thumbnail: event.thumbnail || null,
    });
  }
  // The review thumbnail is the whole sampled frame scaled down; the frame size lets the reviewer see the box
  // the detector actually drew instead of guessing which object in the picture was meant.
  const frameWidth = Number(summary.frame_width);
  const frameHeight = Number(summary.frame_height);
  const frameSize = frameWidth > 0 && frameHeight > 0 ? { frame_width: frameWidth, frame_height: frameHeight } : {};
  return observations.map((observation) => stripNulls({ ...observation, attributes: { ...observation.attributes, ...frameSize } }));
}

// Timeline marks for the review console (cctv_device_events, source 'inference'): one per motion window,
// graded by what was in it, plus the camera disturbances the extractor found.
// alert = a plated vehicle or a pest animal; detection = any other entity; motion = movement only.
function buildInferenceDeviceEvents(summary, context = {}) {
  const base = Date.parse(context.recordedStartAt || context.capturedAt || '');
  if (!Number.isFinite(base) || !summary) return [];
  const events = summary.consolidated_events || {};
  const faceEvents = events.face_events || [];
  const detectedEntities = [
    ...(events.vehicle_events || []).map((event) => ({ ...event, kind: 'vehicle', alert: Boolean(event.plate && event.plate !== 'Unconfirmed vehicle') })),
    ...(events.person_events || []).map((event) => ({ ...event, kind: 'person', alert: false })),
    ...(events.animal_events || []).map((event) => ({ ...event, kind: 'animal', alert: event.is_pest === true })),
  ].filter((entity) => isUsableQuality(entity.quality_state));
  const entities = detectedEntities.filter((entity) => isReviewQueued(entity, entity.kind, {
    hasFaceEvidence: entity.kind === 'person' && faceEvents.some((face) => overlapSeconds(face, entity) >= 0),
  }));
  const heldCandidates = detectedEntities.filter((entity) => !entities.includes(entity));
  const marks = (summary.motion_segments || []).map((segment, index) => {
    const window = { first_seen_seconds: segment.start_time_seconds, last_seen_seconds: segment.end_time_seconds };
    const inside = entities.filter((entity) => overlapSeconds(entity, window) >= 0);
    const heldInside = heldCandidates.filter((entity) => overlapSeconds(entity, window) >= 0);
    const counts = inside.reduce((totals, entity) => ({ ...totals, [entity.kind]: (totals[entity.kind] || 0) + 1 }), {});
    return {
      source: 'inference',
      source_ref: `segment-${index + 1}`,
      event_start_at: isoAt(base, segment.start_time_seconds),
      event_end_at: isoAt(base, segment.end_time_seconds),
      severity: inside.some((entity) => entity.alert) ? 'alert' : inside.length ? 'detection' : 'motion',
      metadata: { kind: 'motion_window', entity_counts: counts, entity_event_ids: inside.map((entity) => entity.event_id), suppressed_review_candidate_count: heldInside.length, frames: segment.frames?.length || 0 },
    };
  });
  for (const quality of summary.quality_events || []) {
    marks.push({
      source: 'inference',
      source_ref: `quality-${quality.kind}-${quality.frame_start}`,
      event_start_at: isoAt(base, quality.start_time_seconds),
      event_end_at: isoAt(base, Math.max(quality.end_time_seconds, quality.start_time_seconds + 0.2)),
      severity: 'motion',
      metadata: { kind: 'quality_event', quality_kind: quality.kind, frame_start: quality.frame_start, frame_end: quality.frame_end },
    });
  }
  return marks;
}

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Number(Math.min(1, Math.max(0, number)).toFixed(3));
}

function stripNulls(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== null && value !== undefined));
}

async function extractKeyframes(frames, count = DEFAULT_KEYFRAME_COUNT) {
  if (!Array.isArray(frames) || frames.length === 0) return [];
  const selected = [];
  const step = Math.max(1, Math.floor(frames.length / count));
  for (let i = 0; i < frames.length && selected.length < count; i += step) {
    const frame = frames[i];
    const thumbnail = await loadBase64Thumbnail(frame.file_path);
    selected.push({
      frame_index: frame.frame_index,
      timestamp_seconds: Number((Number(frame.relative_timestamp_seconds) || 0).toFixed(2)),
      sha256_hash: frame.sha256_hash,
      thumbnail,
    });
  }
  return selected;
}

async function consolidateMotionSummary(summary, options = {}) {
  if (!summary || !Array.isArray(summary.motion_segments)) return summary;
  const allFrames = summary.motion_segments.flatMap((s) => s.frames || []);
  
  const [faceResult, personEvents, vehicleResult, animalResult, keyframes] = await Promise.all([
    consolidateFaces(allFrames, options),
    consolidatePeople(allFrames, options),
    consolidateVehicles(allFrames, options),
    consolidateAnimals(allFrames, options),
    extractKeyframes(allFrames, options.keyframeCount ?? DEFAULT_KEYFRAME_COUNT),
  ]);
  const qualityCounts = allFrames.reduce((counts, frame) => {
    const state = frame.quality_state || (frame.visual_quality === 'degraded' ? 'degraded' : 'clear');
    counts[state] = (counts[state] || 0) + 1;
    return counts;
  }, {});
  // The first consolidation pass only picks representative frames for recognition; hints wait for the final pass.
  const sceneSynopsis = options.hints === false ? null : await getSceneSynopsis(keyframes.find((frame) => frame.thumbnail)?.thumbnail);

  summary.consolidated_events = {
    vehicle_events: vehicleResult.events,
    person_events: personEvents,
    face_events: faceResult.events,
    animal_events: animalResult.events,
    keyframes,
    scene_synopsis: sceneSynopsis,
    engine: {
      engine_version: ENGINE_VERSION,
      tracker: { ...TRACKER_DEFAULTS, person_start_confidence: PERSON_TRACKER_OPTIONS.startConfidence, animal_start_confidence: ANIMAL_TRACKER_OPTIONS.startConfidence },
      vlm: { ...vlmManifest(), hints_requested: options.hints !== false, cloud_vehicle_vlm_enabled: Boolean(options.cloudVehicleVlm?.enabled) },
    },
    summary_counts: {
      vehicle_events: vehicleResult.events.length,
      unique_vehicles: vehicleResult.uniqueVehiclesCount,
      face_events: faceResult.events.length,
      person_events: personEvents.length,
      animal_events: animalResult.events.length,
      pest_animal_events: animalResult.events.filter((event) => event.is_pest === true).length,
      unique_faces: faceResult.uniqueSubjectsCount,
      total_frames_with_motion: allFrames.length,
      total_frames_parsed: summary.total_frames_parsed || allFrames.length,
    },
    quality_summary: {
      review_required_count: [
        ...vehicleResult.events,
        ...personEvents,
        ...faceResult.events,
        ...animalResult.events,
      ].filter((event) => event.review_required !== false).length,
      single_frame_vehicle_count: vehicleResult.events.filter((event) => event.temporal_consensus !== true).length,
      held_from_review_count: [
        ...vehicleResult.events.map((event) => ['vehicle', event]),
        ...personEvents.map((event) => ['person', event]),
        ...animalResult.events.map((event) => ['animal', event]),
      ].filter(([kind, event]) => !isReviewQueued(event, kind)).length,
      plate_conflict_count: vehicleResult.events.filter((event) => event.plate_conflict === true).length,
      provider_counts: vehicleResult.events.reduce((counts, event) => {
        const provider = event.inference_provider || 'unknown';
        counts[provider] = (counts[provider] || 0) + 1;
        return counts;
      }, {}),
      animal_detection_status: animalResult.detectionStatus,
      frame_quality_counts: qualityCounts,
      camera_quality_events: Array.isArray(summary.quality_events) ? summary.quality_events.length : 0,
      policy: 'AI output is advisory and requires human confirmation before enforcement or identity commitment.',
    },
  };

  return summary;
}

module.exports = {
  cosineSimilarity,
  representativeFrameScore,
  consolidateFaces,
  consolidatePeople,
  consolidateAnimals,
  buildGaitSignature,
  consolidateVehicles,
  isReviewableCandidate,
  extractKeyframes,
  consolidateMotionSummary,
  buildEntityObservations,
  buildInferenceDeviceEvents,
  plateReadsFor,
  clusterPlates,
  ENGINE_VERSION,
  getVehicleVisionHint,
  getWeaponHint,
  getSceneSynopsis,
};
