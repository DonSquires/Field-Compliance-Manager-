const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

function log(event, fields = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
}

const DEFAULT_FACE_SIMILARITY_THRESHOLD = 0.65;
const DEFAULT_MAX_GAP_SECONDS = 15.0;
const DEFAULT_KEYFRAME_COUNT = 6;
// Classified frames are sampled sparsely (a 300-frame cap over a long motion window can mean one frame every
// few seconds), so an entity travels further than its own size between samples. The spatial gate grows
// with the time gap; appearance similarity (256-d re-ID or descriptor) confirms or rescues the match.
const APPEARANCE_CONFIRM_THRESHOLD = 0.6;
const APPEARANCE_RESCUE_THRESHOLD = 0.85;
const GATE_GROWTH_PER_SECOND = 1.5;
const SINGLE_FRAME_REVIEW_CONFIDENCE = 0.85;
const UNUSABLE_QUALITY_STATES = new Set(['glitch', 'ir_switch', 'flare', 'degraded', 'occluded']);

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

// ── Self-hosted vision-LLM hints (Moondream 2, Apache-2.0, via the in-house Ollama container) ─────────────
// Owner ruling 2026-09-21: builds our own vehicle make/model and weapon-presence signal from footage we
// already own, instead of a paid API or a scraped/non-commercial training set. Every result here is an
// UNVERIFIED HINT, never a validated detection - callers must keep it labelled as such all the way to the
// review console. Zero per-call cost (self-hosted, already-owned hardware); any failure (not configured,
// network error, timeout, malformed reply) returns null/absent rather than guessing, so a missing hint is
// never mistaken for a checked-and-clear result.
const OLLAMA_VISION_URL = process.env.OLLAMA_VISION_URL || '';
const OLLAMA_VISION_MODEL = process.env.OLLAMA_VISION_MODEL || 'moondream';
const VISION_HINT_TIMEOUT_MS = Number(process.env.VISION_HINT_TIMEOUT_MS) || 20_000;

async function cropFrameToBase64(filePath, bbox) {
  if (!filePath || !bbox) return null;
  const width = Math.max(1, Math.round(Number(bbox.width) || 0));
  const height = Math.max(1, Math.round(Number(bbox.height) || 0));
  const x = Math.max(0, Math.round(Number(bbox.x) || 0));
  const y = Math.max(0, Math.round(Number(bbox.y) || 0));
  if (width <= 1 || height <= 1) return null;
  const cropPath = path.join(os.tmpdir(), `vision-hint-${crypto.randomUUID()}.jpg`);
  try {
    await execFileAsync('ffmpeg', [
      '-y', '-i', filePath,
      '-vf', `crop=${width}:${height}:${x}:${y}`,
      '-q:v', '4',
      cropPath,
    ], { timeout: 10_000 });
    const buf = await fs.readFile(cropPath);
    return buf.toString('base64');
  } catch (error) {
    log('vision_hint_crop_failed', { file_path: filePath, bbox, error: error.message });
    return null;
  } finally {
    await fs.rm(cropPath, { force: true }).catch(() => {});
  }
}

async function queryVisionHint(base64Image, prompt) {
  if (!OLLAMA_VISION_URL || !base64Image) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISION_HINT_TIMEOUT_MS);
  try {
    const response = await fetch(`${OLLAMA_VISION_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // num_predict bounds a degenerate-repetition loop (observed on a content-free test image) to a few
      // hundred ms instead of running to the model's full context length for no benefit - the response is
      // discarded either way once it fails to parse as the requested JSON shape.
      body: JSON.stringify({ model: OLLAMA_VISION_MODEL, prompt, images: [base64Image], stream: false, format: 'json', options: { num_predict: 200 } }),
      signal: controller.signal,
    });
    if (!response.ok) {
      log('vision_hint_http_error', { status: response.status });
      return null;
    }
    const body = await response.json();
    try {
      return JSON.parse(body.response);
    } catch (parseError) {
      log('vision_hint_unparseable_response', { error: parseError.message });
      return null;
    }
  } catch (error) {
    log('vision_hint_unavailable', { error: error.message });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const VEHICLE_HINT_PROMPT = [
  'You are looking at a cropped CCTV photo of a single vehicle.',
  'Give your best guess for the manufacturer (make) and model, based on visible badges, body shape and style.',
  'If you cannot make a reasonable guess, use null for that field. Do not invent a plate number or any other detail.',
  'Respond with ONLY this JSON shape, no other text: {"make": string or null, "model": string or null}',
].join(' ');

// Runs once per finalized vehicle track (not per raw frame) so cost stays bounded to a handful of calls per
// clip. Nothing else in this stack currently sets vehicle_make/vehicle_model, so this is additive.
async function getVehicleVisionHint(filePath, bbox) {
  const base64Image = await cropFrameToBase64(filePath, bbox);
  const parsed = await queryVisionHint(base64Image, VEHICLE_HINT_PROMPT);
  if (!parsed || typeof parsed !== 'object') {
    return { vehicle_make: null, vehicle_model: null, vehicle_make_model_source: null };
  }
  const make = typeof parsed.make === 'string' && parsed.make.trim() ? parsed.make.trim().slice(0, 60) : null;
  const model = typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model.trim().slice(0, 60) : null;
  return {
    vehicle_make: make,
    vehicle_model: model,
    vehicle_make_model_source: (make || model) ? 'vision_llm_hint_unverified' : null,
  };
}

const WEAPON_HINT_PROMPT = [
  'You are looking at a cropped CCTV photo of a person.',
  'Look carefully at anything they are holding, carrying, or wearing.',
  'Could any object plausibly be a firearm, knife, or other weapon? If you are at all unsure, still flag it so a human can check - false alarms are far cheaper than a missed weapon.',
  'Respond with ONLY this JSON shape, no other text: {"possible_weapon": true or false, "description": "short description of what you see"}',
].join(' ');

// Same bounded-cost, once-per-track pattern as the vehicle hint. On any failure this returns null (the key
// is omitted from the observation entirely) rather than {present: false} - "not checked" must never look
// identical to "checked, nothing found" for something this safety-sensitive.
async function getWeaponHint(filePath, bbox) {
  const base64Image = await cropFrameToBase64(filePath, bbox);
  const parsed = await queryVisionHint(base64Image, WEAPON_HINT_PROMPT);
  if (!parsed || typeof parsed !== 'object' || typeof parsed.possible_weapon !== 'boolean') {
    return null;
  }
  return {
    present: parsed.possible_weapon,
    description: typeof parsed.description === 'string' && parsed.description.trim() ? parsed.description.trim().slice(0, 200) : null,
    source: 'vision_llm_hint_requires_human_review',
    model: OLLAMA_VISION_MODEL,
    generated_at: new Date().toISOString(),
  };
}

const SCENE_SYNOPSIS_PROMPT = [
  'You are looking at one representative frame from a CCTV clip.',
  'In one short plain-English sentence, describe what is happening (for example: "person walking near the gate",',
  '"white ute parked in the yard", "industrial steam or smoke, no people or vehicles visible").',
  'Do not guess at identity, intent, or anything not visible in the frame.',
  'Respond with ONLY this JSON shape, no other text: {"synopsis": "one short sentence"}',
].join(' ');

function stripDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const commaIndex = dataUrl.indexOf(',');
  return dataUrl.startsWith('data:image/') && commaIndex !== -1 ? dataUrl.slice(commaIndex + 1) : null;
}

// Runs once per CLIP (not per track) against a single representative keyframe already extracted for the
// review console - no extra file read. Same unverified-hint contract as the vehicle/weapon hints: a
// failed/malformed reply returns null rather than a guessed placeholder sentence.
async function getSceneSynopsis(keyframeDataUrl) {
  const base64Image = stripDataUrl(keyframeDataUrl);
  if (!base64Image) return null;
  const parsed = await queryVisionHint(base64Image, SCENE_SYNOPSIS_PROMPT);
  const text = typeof parsed?.synopsis === 'string' ? parsed.synopsis.trim() : '';
  if (!text) return null;
  return {
    text: text.slice(0, 300),
    source: 'vision_llm_hint_unverified',
    model: OLLAMA_VISION_MODEL,
    generated_at: new Date().toISOString(),
  };
}

// Does a detection at (center, bbox, timestamp, embedding) continue an existing track?
function continuesTrack(track, { center, bbox, timestamp, embedding }, maxGap) {
  const gap = timestamp - track.lastSeen;
  if (gap < 0 || gap > maxGap) return false;
  const size = Math.max(Number(bbox.width) || 0, Number(bbox.height) || 0, Number(track.bestBbox?.width) || 0, Number(track.bestBbox?.height) || 0);
  const distance = Math.hypot(center.x - track.center.x, center.y - track.center.y);
  const spatial = distance < size * (1 + Math.min(gap, maxGap) * GATE_GROWTH_PER_SECOND);
  const trackEmbedding = track.embedding;
  if (!Array.isArray(embedding) || !Array.isArray(trackEmbedding) || embedding.length !== trackEmbedding.length) return spatial;
  const similarity = cosineSimilarity(embedding, trackEmbedding);
  if (spatial) return similarity >= APPEARANCE_CONFIRM_THRESHOLD;
  return similarity >= APPEARANCE_RESCUE_THRESHOLD;
}

function bestTrackFor(tracks, detection, maxGap) {
  const candidates = tracks.filter((track) => continuesTrack(track, detection, maxGap));
  if (!candidates.length) return null;
  return candidates.sort((a, b) => Math.hypot(detection.center.x - a.center.x, detection.center.y - a.center.y) - Math.hypot(detection.center.x - b.center.x, detection.center.y - b.center.y))[0];
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
    for (const detectedFace of frame.face.faces) {
      const embedding = Array.isArray(detectedFace.embedding) ? detectedFace.embedding : null;
      if (!embedding || embedding.length === 0) continue;

      let bestSubject = null;
      let highestSim = -1;

      for (const subj of subjects) {
        const sim = cosineSimilarity(embedding, subj.avgEmbedding);
        if (sim > highestSim) {
          highestSim = sim;
          bestSubject = subj;
        }
      }

      if (bestSubject && highestSim >= simThreshold) {
        // Matched existing person
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
      event_id: `face-${tr.subjectId}-${i + 1}`,
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

async function consolidatePeople(frames, options = {}) {
  const maxGap = options.maxGapSeconds ?? DEFAULT_MAX_GAP_SECONDS;
  const excludedQualityFrames = frames.filter((frame) => frame && !hasUsableFrame(frame)).length;
  const tracks = [];
  for (const frame of frames) {
    if (!hasUsableFrame(frame)) continue;
    const detections = Array.isArray(frame?.people?.people) ? frame.people.people : [];
    const timestamp = Number(frame.relative_timestamp_seconds) || 0;
    for (const detection of detections) {
      const bbox = detection.bbox;
      if (!bbox) continue;
      const center = { x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2 };
      const embedding = Array.isArray(detection.attributes?.appearance_embedding) ? detection.attributes.appearance_embedding : null;
      let track = bestTrackFor(tracks, { center, bbox, timestamp, embedding }, maxGap);
      if (!track) {
        track = { firstSeen: timestamp, lastSeen: timestamp, frameCount: 0, confidence: 0, bestFrame: frame, bestBbox: bbox, bestAttributes: detection.attributes || null, center, embedding, gaitSamples: [] };
        tracks.push(track);
      }
      track.lastSeen = timestamp;
      track.frameCount += 1;
      track.confidence = Math.max(track.confidence, Number(detection.confidence) || 0);
      track.center = center;
      track.gaitSamples.push({ timestamp, center, width: Number(bbox.width), height: Number(bbox.height) });
      if (representativeFrameScore(frame, bbox, detection.confidence) > representativeFrameScore(track.bestFrame, track.bestBbox, track.confidence)) {
        track.bestBbox = bbox;
        track.bestFrame = frame;
        track.bestAttributes = detection.attributes || track.bestAttributes;
        if (embedding) track.embedding = embedding;
      }
    }
  }
  const events = await Promise.all(tracks.map(async (track, index) => ({
    event_id: `person-${index + 1}`,
    event_type: 'person',
    first_seen_seconds: Number(track.firstSeen.toFixed(2)),
    last_seen_seconds: Number(track.lastSeen.toFixed(2)),
    duration_seconds: Number(Math.max(0, track.lastSeen - track.firstSeen).toFixed(2)),
    frame_count: track.frameCount,
    confidence: Number(track.confidence.toFixed(2)),
    best_frame_hash: track.bestFrame?.sha256_hash || null,
    best_bbox: track.bestBbox,
    attributes: track.bestAttributes,
    appearance_embedding: Array.isArray(track.bestAttributes?.appearance_embedding) ? track.bestAttributes.appearance_embedding : null,
    appearance_embedding_model: track.bestAttributes?.appearance_embedding_model || null,
    quality_state: track.bestFrame?.quality_state || (track.bestFrame?.visual_quality === 'degraded' ? 'degraded' : 'clear'),
    gait_signature: buildGaitSignature(track.gaitSamples),
    thumbnail: await loadBase64Thumbnail(track.bestFrame?.file_path),
    weapon_hint: await getWeaponHint(track.bestFrame?.file_path, track.bestBbox),
    review_required: true,
  })));
  return events.map((event) => ({
    ...event,
    review_required: true,
    visual_quality_gate: excludedQualityFrames > 0 ? 'degraded_frames_excluded_from_person_inference' : 'clear',
    excluded_degraded_frame_count: 0,
    degraded_frame_count: excludedQualityFrames,
  }));
}

// Animal detections (detector triage + species) tracked by position and time; the species is voted across
// the track so one blurry frame cannot rename a possum. Nothing here decides identity or action.
async function consolidateAnimals(frames, options = {}) {
  const maxGap = options.maxGapSeconds ?? DEFAULT_MAX_GAP_SECONDS;
  const tracks = [];
  const statuses = new Set();
  for (const frame of frames) {
    if (!hasUsableFrame(frame)) continue;
    const container = frame.animals;
    const detections = Array.isArray(container) ? container : Array.isArray(container?.animals) ? container.animals : [];
    if (container && !Array.isArray(container) && container.status) statuses.add(container.status);
    const timestamp = Number(frame.relative_timestamp_seconds) || 0;
    for (const detection of detections) {
      const bbox = detection?.bbox;
      if (!bbox || !(Number(bbox.width) > 0) || !(Number(bbox.height) > 0)) continue;
      const center = { x: Number(bbox.x) + Number(bbox.width) / 2, y: Number(bbox.y) + Number(bbox.height) / 2 };
      let track = bestTrackFor(tracks, { center, bbox, timestamp, embedding: null }, maxGap);
      if (!track) {
        track = { firstSeen: timestamp, lastSeen: timestamp, frameCount: 0, confidence: 0, bestFrame: frame, bestBbox: bbox, bestDetection: detection, center, embedding: null, speciesVotes: new Map() };
        tracks.push(track);
      }
      track.lastSeen = timestamp;
      track.frameCount += 1;
      track.confidence = Math.max(track.confidence, Number(detection.confidence) || 0);
      track.center = center;
      const species = detection.species || detection.coarse_label || 'other';
      const vote = track.speciesVotes.get(species) || { weight: 0, count: 0, detection };
      vote.weight += Number(detection.species_confidence) || Number(detection.confidence) * 0.5 || 0.1;
      vote.count += 1;
      if ((Number(detection.species_confidence) || 0) >= (Number(vote.detection.species_confidence) || 0)) vote.detection = detection;
      track.speciesVotes.set(species, vote);
      if (representativeFrameScore(frame, bbox, detection.confidence) > representativeFrameScore(track.bestFrame, track.bestBbox, track.confidence)) {
        track.bestBbox = bbox;
        track.bestFrame = frame;
        track.bestDetection = detection;
      }
    }
  }
  const events = [];
  for (const [index, track] of tracks.entries()) {
    const [species, vote] = [...track.speciesVotes.entries()].sort((a, b) => b[1].weight - a[1].weight)[0] || ['other', { count: 0, detection: track.bestDetection }];
    const winner = vote.detection || track.bestDetection || {};
    events.push({
      event_id: `animal-${index + 1}`,
      event_type: 'animal',
      species,
      common_name: winner.common_name || null,
      is_pest: typeof winner.is_pest === 'boolean' ? winner.is_pest : null,
      species_confidence: Number.isFinite(Number(winner.species_confidence)) ? Number(Number(winner.species_confidence).toFixed(3)) : null,
      species_status: winner.species_status || 'model_not_staged',
      species_provider: winner.species_provider || null,
      species_votes: Object.fromEntries([...track.speciesVotes.entries()].map(([key, value]) => [key, value.count])),
      confidence: Number(track.confidence.toFixed(2)),
      first_seen_seconds: Number(track.firstSeen.toFixed(2)),
      last_seen_seconds: Number(track.lastSeen.toFixed(2)),
      duration_seconds: Number(Math.max(0, track.lastSeen - track.firstSeen).toFixed(2)),
      frame_count: track.frameCount,
      best_frame_hash: track.bestFrame?.sha256_hash || null,
      best_bbox: track.bestBbox,
      quality_state: track.bestFrame?.quality_state || 'clear',
      thumbnail: await loadBase64Thumbnail(track.bestFrame?.file_path),
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

async function consolidateVehicles(frames, options = {}) {
  const maxGap = options.maxGapSeconds ?? DEFAULT_MAX_GAP_SECONDS;
  const metersPerPixel = Number(options.metersPerPixel) > 0 ? Number(options.metersPerPixel) : null;

  const alprFrames = frames.filter((f) => {
    if (!hasUsableFrame(f) || !f.alpr?.success || typeof f.alpr?.plate !== 'string') return false;
    const plate = f.alpr.plate.trim();
    const conf = Number(f.alpr.confidence) || 0;
    return isPlatish(plate, conf);
  });

  const genericVehicleFrames = frames.filter((frame) => {
    if (!hasUsableFrame(frame) || (frame.alpr?.success && isPlatish(frame.alpr?.plate, Number(frame.alpr?.confidence) || 0))) return false;
    const detection = frame.runpod?.vehicle?.detection;
    const confidence = Number(detection?.confidence) || 0;
    const bbox = detection?.bbox;
    if (!bbox || confidence < 0.25) return false;
    // A full-frame low-confidence detection is a camera/model artifact, not a vehicle candidate.
    if (Number(bbox.x) === 0 && Number(bbox.y) === 0 && Number(bbox.width) >= 1000 && Number(bbox.height) >= 700) return false;
    return Number(bbox.width) > 0 && Number(bbox.height) > 0;
  });

  const vehicleTracks = []; // Array of groups: { plate, tracks: [...] }

  for (const frame of alprFrames) {
    const timestamp = Number(frame.relative_timestamp_seconds) || 0;
    const plate = String(frame.alpr.plate).trim().toUpperCase();
    const confidence = Number(frame.alpr.confidence) || 0;
    const box = frame.alpr.box || frame.alpr.results?.[0]?.box || null;
    const center = box && Number.isFinite(Number(box.x)) && Number.isFinite(Number(box.y))
      ? { x: Number(box.x) + Number(box.width || 0) / 2, y: Number(box.y) + Number(box.height || 0) / 2 }
      : null;

    // Find group by exact plate or close fuzzy match (Levenshtein <= 1 for length >= 4)
    let matchingGroup = vehicleTracks.find((g) => {
      if (g.plate === plate) return true;
      if (g.plate.length >= 4 && plate.length >= 4 && levenshteinDistance(g.plate, plate) <= 1) {
        return true;
      }
      return false;
    });

    if (!matchingGroup) {
      matchingGroup = { plate, tracks: [] };
      vehicleTracks.push(matchingGroup);
    }

    const currentTrack = matchingGroup.tracks[matchingGroup.tracks.length - 1];
    if (currentTrack && timestamp - currentTrack.lastSeen <= maxGap) {
      // Extend current observation
      currentTrack.lastSeen = timestamp;
      currentTrack.frameCount++;
      if (center && currentTrack.lastCenter && timestamp > currentTrack.lastTimestamp) {
        const elapsed = timestamp - currentTrack.lastTimestamp;
        const distance = Math.hypot(center.x - currentTrack.lastCenter.x, center.y - currentTrack.lastCenter.y);
        currentTrack.speedSamples.push(distance / elapsed);
      }
      if (center) currentTrack.lastCenter = center;
      currentTrack.lastTimestamp = timestamp;
      if (confidence >= currentTrack.bestConfidence || (plate.length > currentTrack.bestPlate.length && confidence >= 0.6)) {
        currentTrack.bestConfidence = Math.max(currentTrack.bestConfidence, confidence);
        currentTrack.bestPlate = plate.length >= currentTrack.bestPlate.length ? plate : currentTrack.bestPlate;
        currentTrack.bestFrame = frame;
      }
    } else {
      // Start new observation window for this vehicle
      matchingGroup.tracks.push({
        isReturn: matchingGroup.tracks.length > 0,
        firstSeen: timestamp,
        lastSeen: timestamp,
        frameCount: 1,
        bestConfidence: confidence,
        bestPlate: plate,
        bestFrame: frame,
        lastCenter: center,
        lastTimestamp: timestamp,
        speedSamples: [],
      });
    }
  }

  // Return one representative event per plate. Preserve the full observation
  // window and return count instead of emitting a card for every visit.
  const allTracks = vehicleTracks.map((group) => {
    const bestTrack = group.tracks.reduce((best, track) => track.bestConfidence > best.bestConfidence ? track : best, group.tracks[0]);
    return {
      ...bestTrack,
      groupPlate: group.plate,
      firstSeen: Math.min(...group.tracks.map((track) => track.firstSeen)),
      lastSeen: Math.max(...group.tracks.map((track) => track.lastSeen)),
      frameCount: group.tracks.reduce((sum, track) => sum + track.frameCount, 0),
      visitCount: group.tracks.length,
      isReturn: group.tracks.length > 1,
      temporalConsensus: group.tracks.reduce((sum, track) => sum + track.frameCount, 0) >= 2,
    };
  }).sort((a, b) => a.firstSeen - b.firstSeen);

  const events = [];
  for (const tr of allTracks) {
    const duration = Math.max(0, Number((tr.lastSeen - tr.firstSeen).toFixed(2)));
    const thumbnail = await loadBase64Thumbnail(tr.bestFrame?.file_path);
    const speedPxPerSecond = tr.speedSamples.length
      ? Number((tr.speedSamples.reduce((sum, value) => sum + value, 0) / tr.speedSamples.length).toFixed(2))
      : null;
    const vehicleData = tr.bestFrame?.inference?.data || tr.bestFrame?.runpod?.vehicle || {};
    const alprData = tr.bestFrame?.alpr || {};
    const alprBest = Array.isArray(alprData.results) ? alprData.results.find((item) => item?.plate === tr.bestPlate) || alprData.results[0] : null;
    // Never override an already-known make/model (any current or future deterministic source) with an
    // unverified vision-LLM guess - only ask when nothing better is already on the frame.
    const existingMake = vehicleData.vehicle_make ?? null;
    const existingModel = vehicleData.vehicle_model ?? null;
    const visionHint = (existingMake || existingModel)
      ? null
      : await getVehicleVisionHint(tr.bestFrame?.file_path, vehicleData.detection?.bbox ?? tr.bestFrame?.alpr?.plate_bbox ?? null);
    events.push({
      event_id: `vehicle-${tr.bestPlate}-${tr.trackIndex}`,
      event_type: 'vehicle',
      plate: tr.bestPlate,
      confidence: Number(tr.bestConfidence.toFixed(2)),
      alpr_provider: alprData.alpr_provider ?? null,
      alpr_models: alprData.alpr_models ?? null,
      alpr_evidence_quality: alprData.evidence_quality ?? null,
      plate_raw_text: alprBest?.raw_text ?? null,
      plate_corrections: Array.isArray(alprBest?.corrections) && alprBest.corrections.length ? alprBest.corrections : null,
      plate_char_confidence_min: alprBest?.char_confidence_min ?? null,
      plate_width_px: alprBest?.plate_width_px ?? null,
      detector_provider: tr.bestFrame?.runpod?.detector_provider ?? tr.bestFrame?.detect?.detector_provider ?? null,
      is_return: tr.isReturn,
      first_seen_seconds: Number(tr.firstSeen.toFixed(2)),
      last_seen_seconds: Number(tr.lastSeen.toFixed(2)),
      duration_seconds: duration,
      frame_count: tr.frameCount,
      visit_count: tr.visitCount,
      temporal_consensus: tr.temporalConsensus,
      best_frame_hash: tr.bestFrame?.sha256_hash || null,
      best_bbox: vehicleData.detection?.bbox ?? tr.bestFrame?.alpr?.plate_bbox ?? null,
      thumbnail,
      vehicle_make: existingMake ?? visionHint?.vehicle_make ?? null,
      vehicle_model: existingModel ?? visionHint?.vehicle_model ?? null,
      vehicle_make_model_source: (existingMake || existingModel) ? (vehicleData.vehicle_make_model_source ?? null) : (visionHint?.vehicle_make_model_source ?? null),
      vehicle_year: vehicleData.vehicle_year ?? null,
      vehicle_colour: vehicleData.vehicle_colour ?? vehicleData.vehicle_color ?? null,
      vehicle_type: vehicleData.vehicle_type ?? null,
      vehicle_attribute_confidence: vehicleData.vehicle_attribute_confidence ?? null,
      inference_provider: vehicleData.inference_provider ?? null,
      appearance_embedding: Array.isArray(vehicleData.appearance_embedding) ? vehicleData.appearance_embedding : null,
      appearance_embedding_model: vehicleData.appearance_embedding_model ?? null,
      quality_state: tr.bestFrame?.quality_state || 'clear',
      speed_px_per_second: speedPxPerSecond,
      speed_kmh: speedPxPerSecond !== null && metersPerPixel !== null
        ? Number((speedPxPerSecond * metersPerPixel * 3.6).toFixed(2))
        : null,
      speed_calibration: metersPerPixel === null ? 'uncalibrated' : 'camera_scale',
      review_required: !tr.temporalConsensus || tr.bestConfidence < 0.75,
    });
  }

  const genericTracks = [];
  for (const frame of genericVehicleFrames) {
    const detection = frame.runpod.vehicle.detection;
    const timestamp = Number(frame.relative_timestamp_seconds) || 0;
    const bbox = detection.bbox;
    const center = { x: Number(bbox.x) + Number(bbox.width) / 2, y: Number(bbox.y) + Number(bbox.height) / 2 };
    const embedding = Array.isArray(frame.runpod.vehicle.appearance_embedding) ? frame.runpod.vehicle.appearance_embedding : null;
    let track = bestTrackFor(genericTracks, { center, bbox, timestamp, embedding }, maxGap);
    if (!track) {
      track = { firstSeen: timestamp, lastSeen: timestamp, frameCount: 0, confidence: 0, bestFrame: frame, bestBbox: bbox, center, embedding };
      genericTracks.push(track);
    }
    track.lastSeen = timestamp;
    track.frameCount += 1;
    track.confidence = Math.max(track.confidence, Number(detection.confidence) || 0);
    track.center = center;
    if (representativeFrameScore(frame, bbox, detection.confidence) > representativeFrameScore(track.bestFrame, track.bestBbox, track.confidence)) {
      track.bestBbox = bbox;
      track.bestFrame = frame;
      if (embedding) track.embedding = embedding;
    }
  }
  for (const [index, track] of genericTracks.entries()) {
    const thumbnail = await loadBase64Thumbnail(track.bestFrame?.file_path);
    const vehicleData = track.bestFrame?.runpod?.vehicle || {};
    const existingMake = vehicleData.vehicle_make ?? null;
    const existingModel = vehicleData.vehicle_model ?? null;
    const visionHint = (existingMake || existingModel) ? null : await getVehicleVisionHint(track.bestFrame?.file_path, track.bestBbox);
    events.push({
      event_id: `vehicle-unconfirmed-${index + 1}`,
      event_type: 'vehicle',
      plate: 'Unconfirmed vehicle',
      confidence: Number(track.confidence.toFixed(2)),
      is_return: false,
      first_seen_seconds: Number(track.firstSeen.toFixed(2)),
      last_seen_seconds: Number(track.lastSeen.toFixed(2)),
      duration_seconds: Number(Math.max(0, track.lastSeen - track.firstSeen).toFixed(2)),
      frame_count: track.frameCount,
      visit_count: 1,
      best_frame_hash: track.bestFrame?.sha256_hash || null,
      best_bbox: track.bestBbox,
      thumbnail,
      vehicle_make: existingMake ?? visionHint?.vehicle_make ?? null,
      vehicle_model: existingModel ?? visionHint?.vehicle_model ?? null,
      vehicle_make_model_source: (existingMake || existingModel) ? (vehicleData.vehicle_make_model_source ?? null) : (visionHint?.vehicle_make_model_source ?? null),
      vehicle_colour: vehicleData.vehicle_colour ?? null,
      vehicle_type: vehicleData.vehicle_type ?? null,
      vehicle_attribute_confidence: vehicleData.vehicle_attribute_confidence ?? null,
      inference_provider: vehicleData.inference_provider ?? null,
      appearance_embedding: Array.isArray(vehicleData.appearance_embedding) ? vehicleData.appearance_embedding : null,
      appearance_embedding_model: vehicleData.appearance_embedding_model ?? null,
      quality_state: track.bestFrame?.quality_state || 'clear',
      review_required: true,
      temporal_consensus: track.frameCount >= 2,
      candidate_state: 'unconfirmed_vehicle_without_plate',
    });
  }
  return { events, uniqueVehiclesCount: vehicleTracks.length + genericTracks.length };
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

function isReviewableCandidate(event, { hasFaceEvidence = false } = {}) {
  if (!isUsableQuality(event?.quality_state)) return false;
  const frameCount = Number(event?.frame_count) || 0;
  if (frameCount >= 2 || hasFaceEvidence) return true;
  return Number(event?.confidence) >= SINGLE_FRAME_REVIEW_CONFIDENCE;
}

function reviewCandidateBasis(event, hasFaceEvidence = false) {
  if (hasFaceEvidence) return 'face_backed';
  return (Number(event?.frame_count) || 0) >= 2 ? 'temporal_consensus' : 'single_frame_high_confidence';
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
        attribute_confidence: event.vehicle_attribute_confidence, plate_confidence: plated ? event.confidence : null,
        bbox: event.best_bbox, frame_count: event.frame_count, visit_count: event.visit_count, temporal_consensus: event.temporal_consensus,
        speed_kmh: event.speed_kmh, inference_provider: event.inference_provider, appearance_embedding_model: event.appearance_embedding_model,
        alpr_provider: plated ? event.alpr_provider : null, alpr_models: plated ? event.alpr_models : null, alpr_evidence_quality: plated ? event.alpr_evidence_quality : null,
        plate_raw_text: plated ? event.plate_raw_text : null, plate_corrections: plated ? event.plate_corrections : null,
        plate_char_confidence_min: plated ? event.plate_char_confidence_min : null, plate_width_px: plated ? event.plate_width_px : null,
        detector_provider: event.detector_provider,
        candidate_state: event.candidate_state, review_candidate_basis: reviewCandidateBasis(event),
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
      }),
      frame_sha256: face.best_frame_hash || null,
      thumbnail: face.thumbnail || null,
    });
  }
  for (const event of events.animal_events || []) {
    if (!isUsableQuality(event.quality_state)) continue;
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
      attributes: stripNulls({ bbox: event.best_bbox, frame_count: event.frame_count, species_status: event.species_status, species_provider: event.species_provider, species_votes: event.species_votes }),
      frame_sha256: event.best_frame_hash || null,
      thumbnail: event.thumbnail || null,
    });
  }
  return observations.map((observation) => stripNulls(observation));
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
  const entities = detectedEntities.filter((entity) => entity.kind === 'animal' || isReviewableCandidate(entity, {
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
  const sceneSynopsis = await getSceneSynopsis(keyframes.find((frame) => frame.thumbnail)?.thumbnail);

  summary.consolidated_events = {
    vehicle_events: vehicleResult.events,
    person_events: personEvents,
    face_events: faceResult.events,
    animal_events: animalResult.events,
    keyframes,
    scene_synopsis: sceneSynopsis,
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
  getVehicleVisionHint,
  getWeaponHint,
  getSceneSynopsis,
};
