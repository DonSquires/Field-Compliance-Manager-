const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_FACE_SIMILARITY_THRESHOLD = 0.65;
const DEFAULT_MAX_GAP_SECONDS = 15.0;
const DEFAULT_KEYFRAME_COUNT = 6;

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

async function loadBase64Thumbnail(filePath, maxBytes = 250_000) {
  if (!filePath) return null;
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > maxBytes) return null;
    const buf = await fs.readFile(filePath);
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

async function consolidateFaces(frames, options = {}) {
  const simThreshold = options.faceSimilarityThreshold ?? DEFAULT_FACE_SIMILARITY_THRESHOLD;
  const maxGap = options.maxGapSeconds ?? DEFAULT_MAX_GAP_SECONDS;

  const faceFrames = frames.filter(
    (f) => f && f.face?.success && Array.isArray(f.face?.faces) && f.face.faces.length > 0
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
          if (bboxArea > track.bestBboxArea) {
            track.bestBboxArea = bboxArea;
            track.bestFrame = frame;
            track.bestBbox = bbox;
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
    allTracks.push(...subj.completedTracks);
  }

  // Sort by firstSeen
  allTracks.sort((a, b) => a.firstSeen - b.firstSeen);

  // Format into consolidated face events
  const events = [];
  for (let i = 0; i < allTracks.length; i++) {
    const tr = allTracks[i];
    const duration = Math.max(0, Number((tr.lastSeen - tr.firstSeen).toFixed(2)));
    const thumbnail = await loadBase64Thumbnail(tr.bestFrame?.file_path);
    events.push({
      event_id: `face-${tr.subjectId}-${i + 1}`,
      event_type: 'face',
      subject_id: tr.subjectId,
      subject_label: tr.isReturn ? `${tr.subjectLabel} (Return)` : tr.subjectLabel,
      is_return: tr.isReturn,
      first_seen_seconds: Number(tr.firstSeen.toFixed(2)),
      last_seen_seconds: Number(tr.lastSeen.toFixed(2)),
      duration_seconds: duration,
      frame_count: tr.frameCount,
      best_frame_hash: tr.bestFrame?.sha256_hash || null,
      best_bbox: tr.bestBbox,
      thumbnail,
      review_state: 'manual_review_required',
    });
  }

  return { events, uniqueSubjectsCount: subjects.length };
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

  const alprFrames = frames.filter((f) => {
    if (!f || !f.alpr?.success || typeof f.alpr?.plate !== 'string') return false;
    const plate = f.alpr.plate.trim();
    const conf = Number(f.alpr.confidence) || 0;
    return isPlatish(plate, conf);
  });

  const vehicleTracks = []; // Array of groups: { plate, tracks: [...] }

  for (const frame of alprFrames) {
    const timestamp = Number(frame.relative_timestamp_seconds) || 0;
    const plate = String(frame.alpr.plate).trim().toUpperCase();
    const confidence = Number(frame.alpr.confidence) || 0;

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
      });
    }
  }

  // Flatten and sort by firstSeen
  const allTracks = [];
  for (const group of vehicleTracks) {
    for (let i = 0; i < group.tracks.length; i++) {
      allTracks.push({ ...group.tracks[i], groupPlate: group.plate, trackIndex: i + 1 });
    }
  }
  allTracks.sort((a, b) => a.firstSeen - b.firstSeen);

  const events = [];
  for (const tr of allTracks) {
    const duration = Math.max(0, Number((tr.lastSeen - tr.firstSeen).toFixed(2)));
    const thumbnail = await loadBase64Thumbnail(tr.bestFrame?.file_path);
    events.push({
      event_id: `vehicle-${tr.bestPlate}-${tr.trackIndex}`,
      event_type: 'vehicle',
      plate: tr.bestPlate,
      confidence: Number(tr.bestConfidence.toFixed(2)),
      is_return: tr.isReturn,
      first_seen_seconds: Number(tr.firstSeen.toFixed(2)),
      last_seen_seconds: Number(tr.lastSeen.toFixed(2)),
      duration_seconds: duration,
      frame_count: tr.frameCount,
      best_frame_hash: tr.bestFrame?.sha256_hash || null,
      thumbnail,
      review_required: true,
    });
  }

  return { events, uniqueVehiclesCount: vehicleTracks.length };
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
  
  const [faceResult, vehicleResult, keyframes] = await Promise.all([
    consolidateFaces(allFrames, options),
    consolidateVehicles(allFrames, options),
    extractKeyframes(allFrames, options.keyframeCount ?? DEFAULT_KEYFRAME_COUNT),
  ]);

  summary.consolidated_events = {
    vehicle_events: vehicleResult.events,
    face_events: faceResult.events,
    keyframes,
    summary_counts: {
      vehicle_events: vehicleResult.events.length,
      unique_vehicles: vehicleResult.uniqueVehiclesCount,
      face_events: faceResult.events.length,
      unique_faces: faceResult.uniqueSubjectsCount,
      total_frames_with_motion: allFrames.length,
      total_frames_parsed: summary.total_frames_parsed || allFrames.length,
    },
  };

  return summary;
}

module.exports = {
  cosineSimilarity,
  consolidateFaces,
  consolidateVehicles,
  extractKeyframes,
  consolidateMotionSummary,
};
