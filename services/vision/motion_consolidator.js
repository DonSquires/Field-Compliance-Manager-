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
      review_state: 'manual_review_required',
    });
  }

  return { events, uniqueSubjectsCount: subjects.length };
}

async function consolidatePeople(frames, options = {}) {
  const maxGap = options.maxGapSeconds ?? DEFAULT_MAX_GAP_SECONDS;
  const excludedQualityFrames = frames.filter((frame) => frame?.visual_quality === 'degraded').length;
  const tracks = [];
  for (const frame of frames) {
    const detections = Array.isArray(frame?.people?.people) ? frame.people.people : [];
    const timestamp = Number(frame.relative_timestamp_seconds) || 0;
    for (const detection of detections) {
      const bbox = detection.bbox;
      if (!bbox) continue;
      const center = { x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2 };
      let track = tracks.find((candidate) => timestamp - candidate.lastSeen <= maxGap && Math.hypot(center.x - candidate.center.x, center.y - candidate.center.y) < Math.max(bbox.width, bbox.height));
      if (!track) {
        track = { firstSeen: timestamp, lastSeen: timestamp, frameCount: 0, confidence: 0, bestFrame: frame, bestBbox: bbox, bestAttributes: detection.attributes || null, center };
        tracks.push(track);
      }
      track.lastSeen = timestamp;
      track.frameCount += 1;
      track.confidence = Math.max(track.confidence, Number(detection.confidence) || 0);
      track.center = center;
      if ((bbox.width * bbox.height) > (track.bestBbox.width * track.bestBbox.height)) {
        track.bestBbox = bbox;
        track.bestFrame = frame;
        track.bestAttributes = detection.attributes || track.bestAttributes;
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
    thumbnail: await loadBase64Thumbnail(track.bestFrame?.file_path),
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
    if (!f || !f.alpr?.success || typeof f.alpr?.plate !== 'string') return false;
    const plate = f.alpr.plate.trim();
    const conf = Number(f.alpr.confidence) || 0;
    return isPlatish(plate, conf);
  });

  const genericVehicleFrames = frames.filter((frame) => {
    if (!frame || (frame.alpr?.success && isPlatish(frame.alpr?.plate, Number(frame.alpr?.confidence) || 0))) return false;
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
      visit_count: tr.visitCount,
      temporal_consensus: tr.temporalConsensus,
      best_frame_hash: tr.bestFrame?.sha256_hash || null,
      thumbnail,
      vehicle_make: tr.bestFrame?.inference?.data?.vehicle_make ?? null,
      vehicle_model: tr.bestFrame?.inference?.data?.vehicle_model ?? null,
      vehicle_year: tr.bestFrame?.inference?.data?.vehicle_year ?? null,
      vehicle_colour: tr.bestFrame?.inference?.data?.vehicle_colour ?? tr.bestFrame?.inference?.data?.vehicle_color ?? null,
      vehicle_type: tr.bestFrame?.inference?.data?.vehicle_type ?? null,
      vehicle_attribute_confidence: tr.bestFrame?.inference?.data?.vehicle_attribute_confidence ?? null,
      inference_provider: tr.bestFrame?.inference?.data?.inference_provider ?? null,
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
    let track = genericTracks.find((candidate) => timestamp - candidate.lastSeen <= maxGap && Math.hypot(center.x - candidate.center.x, center.y - candidate.center.y) < Math.max(Number(bbox.width), Number(bbox.height)));
    if (!track) {
      track = { firstSeen: timestamp, lastSeen: timestamp, frameCount: 0, confidence: 0, bestFrame: frame, bestBbox: bbox, center };
      genericTracks.push(track);
    }
    track.lastSeen = timestamp;
    track.frameCount += 1;
    track.confidence = Math.max(track.confidence, Number(detection.confidence) || 0);
    track.center = center;
    if ((Number(bbox.width) * Number(bbox.height)) > (Number(track.bestBbox.width) * Number(track.bestBbox.height))) {
      track.bestBbox = bbox;
      track.bestFrame = frame;
    }
  }
  for (const [index, track] of genericTracks.entries()) {
    const thumbnail = await loadBase64Thumbnail(track.bestFrame?.file_path);
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
      thumbnail,
      review_required: true,
      temporal_consensus: track.frameCount >= 2,
      candidate_state: 'unconfirmed_vehicle_without_plate',
    });
  }
  return { events, uniqueVehiclesCount: vehicleTracks.length + genericTracks.length };
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
  
  const [faceResult, personEvents, vehicleResult, keyframes] = await Promise.all([
    consolidateFaces(allFrames, options),
    consolidatePeople(allFrames, options),
    consolidateVehicles(allFrames, options),
    extractKeyframes(allFrames, options.keyframeCount ?? DEFAULT_KEYFRAME_COUNT),
  ]);

  summary.consolidated_events = {
    vehicle_events: vehicleResult.events,
    person_events: personEvents,
    face_events: faceResult.events,
    keyframes,
    summary_counts: {
      vehicle_events: vehicleResult.events.length,
      unique_vehicles: vehicleResult.uniqueVehiclesCount,
      face_events: faceResult.events.length,
      person_events: personEvents.length,
      unique_faces: faceResult.uniqueSubjectsCount,
      total_frames_with_motion: allFrames.length,
      total_frames_parsed: summary.total_frames_parsed || allFrames.length,
    },
    quality_summary: {
      review_required_count: [
        ...vehicleResult.events,
        ...personEvents,
        ...faceResult.events,
      ].filter((event) => event.review_required !== false).length,
      single_frame_vehicle_count: vehicleResult.events.filter((event) => event.temporal_consensus !== true).length,
      provider_counts: vehicleResult.events.reduce((counts, event) => {
        const provider = event.inference_provider || 'unknown';
        counts[provider] = (counts[provider] || 0) + 1;
        return counts;
      }, {}),
      animal_detection_status: 'model_not_staged',
      policy: 'AI output is advisory and requires human confirmation before enforcement or identity commitment.',
    },
  };

  return summary;
}

module.exports = {
  cosineSimilarity,
  consolidateFaces,
  consolidatePeople,
  consolidateVehicles,
  extractKeyframes,
  consolidateMotionSummary,
};
