// CCTV engine v2 multi-object tracker (owner ruling 2026-11-01, docs/CCTV_INFERENCE_TIER.md).
//
// Turns per-frame detections into tracks without the v1 failure modes measured in production:
//   - one-to-one assignment per frame (two people walking together stay two tracks);
//   - every detection in a frame is tracked, not only the first vehicle;
//   - the spatial gate is bounded (v1 grew without limit to ~23 object sizes at a 15 s gap);
//   - a constant-velocity prediction lets sparse samples follow a moving vehicle without a loose gate;
//   - low-confidence detections may extend a track but never start one;
//   - weak (deterministic colour-layout) embeddings can veto a match but never rescue one;
//   - track confidence is evidence-weighted, with the single best frame kept separately as the peak.
// Nothing here decides identity: tracks are review candidates only.

const ENGINE_VERSION = 'cctv-engine-v2';

const TRACKER_DEFAULTS = Object.freeze({
  maxGapSeconds: 15,
  gateBase: 0.75,
  gateGrowthPerSecond: 1.0,
  gateMax: 4.0,
  predictedGateBase: 0.6,
  predictedGateGrowthPerSecond: 0.35,
  predictedGateMax: 2.0,
  minAreaRatio: 0.25,
  maxAreaRatio: 4.0,
  minConfidence: 0.25,
  startConfidence: 0.4,
  nmsIou: 0.7,
  appearanceConfirm: 0.6,
  appearanceRescue: 0.85,
  weakAppearanceVeto: 0.35,
  minHits: 2,
  singleFrameConfidence: 0.85,
  stationaryDisplacement: 0.3,
  stationaryMinSeconds: 2,
});

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normaliseBbox(bbox) {
  if (!bbox || typeof bbox !== 'object') return null;
  const x = finite(bbox.x, NaN);
  const y = finite(bbox.y, NaN);
  const width = finite(bbox.width, NaN);
  const height = finite(bbox.height, NaN);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function bboxCenter(bbox) {
  return { x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2 };
}

function bboxIou(a, b) {
  if (!a || !b) return 0;
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 ? intersection / union : 0;
}

function bboxContainsPoint(bbox, point, padding = 0) {
  if (!bbox || !point) return false;
  const padX = bbox.width * padding;
  const padY = bbox.height * padding;
  return point.x >= bbox.x - padX && point.x <= bbox.x + bbox.width + padX
    && point.y >= bbox.y - padY && point.y <= bbox.y + bbox.height + padY;
}

function bboxesIntersect(a, b) {
  if (!a || !b) return false;
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = Number(a[index]) || 0;
    const right = Number(b[index]) || 0;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  return normA > 0 && normB > 0 ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
}

// Deterministic descriptors (colour histograms / layouts) shift with lighting and IR switches, so they are
// never strong enough to re-join a track across a spatial jump.
function isWeakEmbeddingModel(model) {
  return typeof model === 'string' && /deterministic|hsv|histogram|layout/i.test(model);
}

// Greedy non-maximum suppression inside one frame: overlapping duplicate boxes (tiled detector passes,
// detector double-fires) collapse to the most confident one.
function suppressDuplicates(detections, iouThreshold) {
  const ordered = [...detections].sort((a, b) => b.confidence - a.confidence);
  const kept = [];
  for (const detection of ordered) {
    if (kept.some((existing) => bboxIou(existing.bbox, detection.bbox) >= iouThreshold)) continue;
    kept.push(detection);
  }
  return kept;
}

// Mean of the strongest few frames, discounted when the track rests on very little evidence. A single
// 0.90 frame scores 0.72; three consistent 0.90 frames score 0.90. The peak stays available separately.
function evidenceWeightedConfidence(confidences) {
  const values = confidences.map((value) => finite(value)).filter((value) => value > 0).sort((a, b) => b - a);
  if (!values.length) return 0;
  const top = values.slice(0, 3);
  const mean = top.reduce((sum, value) => sum + value, 0) / top.length;
  const support = values.length >= 3 ? 1 : values.length === 2 ? 0.92 : 0.8;
  return Number(Math.min(1, mean * support).toFixed(3));
}

function median(values) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function motionStateFor(track, options) {
  if (track.hits < 2) return { motion_state: 'unknown', max_displacement_sizes: null };
  const centers = track.observations.map((observation) => bboxCenter(observation.bbox));
  const sizes = track.observations.map((observation) => Math.max(observation.bbox.width, observation.bbox.height));
  const anchor = { x: median(centers.map((center) => center.x)), y: median(centers.map((center) => center.y)) };
  const scale = Math.max(1, median(sizes));
  const maxDisplacement = Math.max(...centers.map((center) => Math.hypot(center.x - anchor.x, center.y - anchor.y))) / scale;
  const duration = track.lastSeen - track.firstSeen;
  const stationary = maxDisplacement <= options.stationaryDisplacement && duration >= options.stationaryMinSeconds;
  return {
    motion_state: stationary ? 'stationary' : 'moving',
    max_displacement_sizes: Number(maxDisplacement.toFixed(3)),
  };
}

function predictedCenter(track, timestamp) {
  if (!track.velocity) return track.center;
  const gap = Math.max(0, timestamp - track.lastSeen);
  return { x: track.center.x + track.velocity.x * gap, y: track.center.y + track.velocity.y * gap };
}

// Cost of continuing `track` with `detection`, or null when the pair is not allowed at all.
function associationCost(track, detection, timestamp, options) {
  const gap = timestamp - track.lastSeen;
  if (!(gap > 0) || gap > options.maxGapSeconds) return null;
  const areaRatio = (detection.bbox.width * detection.bbox.height) / Math.max(1, track.bbox.width * track.bbox.height);
  if (areaRatio < options.minAreaRatio || areaRatio > options.maxAreaRatio) return null;
  const size = Math.max(detection.bbox.width, detection.bbox.height, track.bbox.width, track.bbox.height, 1);
  const center = bboxCenter(detection.bbox);
  const expected = predictedCenter(track, timestamp);
  const distance = Math.hypot(center.x - expected.x, center.y - expected.y) / size;
  const gate = track.velocity
    ? Math.min(options.predictedGateMax, options.predictedGateBase + options.predictedGateGrowthPerSecond * gap)
    : Math.min(options.gateMax, options.gateBase + options.gateGrowthPerSecond * gap);
  const iou = bboxIou(track.bbox, detection.bbox);
  const spatial = distance <= gate || iou >= 0.3;

  const comparable = Array.isArray(detection.embedding) && Array.isArray(track.embedding) && detection.embedding.length === track.embedding.length;
  const weak = detection.weakEmbedding || track.weakEmbedding;
  const similarity = comparable ? cosineSimilarity(detection.embedding, track.embedding) : null;
  if (spatial) {
    if (similarity !== null) {
      if (weak && similarity < options.weakAppearanceVeto) return null;
      if (!weak && similarity < options.appearanceConfirm) return null;
    }
  } else {
    // Off the spatial gate only a strong re-identification embedding may re-join, and only within a bounded
    // distance, never a colour layout.
    if (similarity === null || weak || similarity < options.appearanceRescue) return null;
    if (distance > options.gateMax * 2) return null;
  }
  const appearanceTerm = similarity === null ? 0.35 : (1 - similarity);
  return distance / Math.max(gate, 0.001) + (1 - iou) * 0.5 + appearanceTerm;
}

// Minimum-cost assignment (Hungarian, rows <= columns); returns the column chosen for each row.
function hungarian(cost) {
  const rows = cost.length;
  const columns = cost[0].length;
  const u = new Array(rows + 1).fill(0);
  const v = new Array(columns + 1).fill(0);
  const owner = new Array(columns + 1).fill(0);
  const way = new Array(columns + 1).fill(0);
  for (let row = 1; row <= rows; row += 1) {
    owner[0] = row;
    let column = 0;
    const minimum = new Array(columns + 1).fill(Infinity);
    const used = new Array(columns + 1).fill(false);
    do {
      used[column] = true;
      const current = owner[column];
      let delta = Infinity;
      let next = 0;
      for (let candidate = 1; candidate <= columns; candidate += 1) {
        if (used[candidate]) continue;
        const reduced = cost[current - 1][candidate - 1] - u[current] - v[candidate];
        if (reduced < minimum[candidate]) { minimum[candidate] = reduced; way[candidate] = column; }
        if (minimum[candidate] < delta) { delta = minimum[candidate]; next = candidate; }
      }
      for (let candidate = 0; candidate <= columns; candidate += 1) {
        if (used[candidate]) { u[owner[candidate]] += delta; v[candidate] -= delta; } else minimum[candidate] -= delta;
      }
      column = next;
    } while (owner[column] !== 0);
    do { const previous = way[column]; owner[column] = owner[previous]; column = previous; } while (column);
  }
  const chosen = new Array(rows).fill(-1);
  for (let column = 1; column <= columns; column += 1) if (owner[column]) chosen[owner[column] - 1] = column - 1;
  return chosen;
}

// One-to-one association over the gated pairs that continues as many tracks as possible and, among those,
// has the lowest total cost. Greedy cheapest-first can let one short step strand a neighbouring track.
function assignPairs(pairs) {
  if (!pairs.length) return [];
  const trackIds = [...new Set(pairs.map((pair) => pair.trackIndex))];
  const detectionIds = [...new Set(pairs.map((pair) => pair.detectionIndex))];
  const transpose = trackIds.length > detectionIds.length;
  const rowIds = transpose ? detectionIds : trackIds;
  const columnIds = transpose ? trackIds : detectionIds;
  // A forbidden pair costs more than every allowed pair together, so one more continued track always wins.
  const forbidden = pairs.reduce((sum, pair) => sum + pair.cost, 0) + 1;
  const matrix = rowIds.map(() => new Array(columnIds.length).fill(forbidden));
  const allowed = new Map();
  for (const pair of pairs) {
    const row = rowIds.indexOf(transpose ? pair.detectionIndex : pair.trackIndex);
    const column = columnIds.indexOf(transpose ? pair.trackIndex : pair.detectionIndex);
    matrix[row][column] = pair.cost;
    allowed.set(`${row}:${column}`, pair);
  }
  return hungarian(matrix)
    .map((column, row) => allowed.get(`${row}:${column}`))
    .filter(Boolean)
    .sort((a, b) => a.trackIndex - b.trackIndex);
}

// detectionsForFrame(frame) -> [{ bbox, confidence, embedding?, embeddingModel?, payload? }]
function trackDetections(frames, detectionsForFrame, overrides = {}) {
  const options = { ...TRACKER_DEFAULTS, ...overrides };
  const ordered = [...frames]
    .filter(Boolean)
    .map((frame, index) => ({ frame, index, timestamp: finite(frame.relative_timestamp_seconds) }))
    .sort((a, b) => a.timestamp - b.timestamp || a.index - b.index);
  const tracks = [];
  let lowConfidenceDropped = 0;
  let duplicatesSuppressed = 0;

  for (const { frame, timestamp } of ordered) {
    const raw = (detectionsForFrame(frame) || [])
      .map((detection) => {
        const bbox = normaliseBbox(detection?.bbox);
        if (!bbox) return null;
        const embedding = Array.isArray(detection.embedding) && detection.embedding.length ? detection.embedding : null;
        return {
          bbox,
          confidence: finite(detection.confidence),
          embedding,
          embeddingModel: detection.embeddingModel || null,
          weakEmbedding: embedding ? isWeakEmbeddingModel(detection.embeddingModel) : false,
          payload: detection.payload ?? detection,
        };
      })
      .filter(Boolean);
    const eligible = raw.filter((detection) => detection.confidence >= options.minConfidence);
    lowConfidenceDropped += raw.length - eligible.length;
    const detections = suppressDuplicates(eligible, options.nmsIou);
    duplicatesSuppressed += eligible.length - detections.length;

    const pairs = [];
    for (let trackIndex = 0; trackIndex < tracks.length; trackIndex += 1) {
      for (let detectionIndex = 0; detectionIndex < detections.length; detectionIndex += 1) {
        const cost = associationCost(tracks[trackIndex], detections[detectionIndex], timestamp, options);
        if (cost !== null) pairs.push({ trackIndex, detectionIndex, cost });
      }
    }
    const usedDetections = new Set();
    for (const pair of assignPairs(pairs)) {
      usedDetections.add(pair.detectionIndex);
      updateTrack(tracks[pair.trackIndex], detections[pair.detectionIndex], frame, timestamp);
    }
    detections.forEach((detection, detectionIndex) => {
      if (usedDetections.has(detectionIndex)) return;
      if (detection.confidence < options.startConfidence) { lowConfidenceDropped += 1; return; }
      const track = {
        id: tracks.length + 1,
        firstSeen: timestamp,
        lastSeen: timestamp,
        hits: 0,
        confidences: [],
        observations: [],
        bbox: detection.bbox,
        center: bboxCenter(detection.bbox),
        velocity: null,
        embedding: null,
        embeddingCount: 0,
        weakEmbedding: detection.weakEmbedding,
      };
      tracks.push(track);
      updateTrack(track, detection, frame, timestamp);
    });
  }

  const results = tracks.map((track) => {
    const peak = Math.max(0, ...track.confidences);
    const confirmed = track.hits >= options.minHits || peak >= options.singleFrameConfidence;
    return {
      id: track.id,
      firstSeen: track.firstSeen,
      lastSeen: track.lastSeen,
      hits: track.hits,
      observations: track.observations,
      embedding: track.embedding,
      peakConfidence: Number(peak.toFixed(3)),
      confidence: evidenceWeightedConfidence(track.confidences),
      confirmed,
      confirmationBasis: track.hits >= options.minHits ? 'temporal_consensus' : (confirmed ? 'single_frame_high_confidence' : 'unconfirmed_single_frame'),
      ...motionStateFor(track, options),
    };
  });
  return { tracks: results, stats: { low_confidence_dropped: lowConfidenceDropped, duplicates_suppressed: duplicatesSuppressed } };
}

function updateTrack(track, detection, frame, timestamp) {
  const center = bboxCenter(detection.bbox);
  if (track.hits > 0) {
    const gap = timestamp - track.lastSeen;
    if (gap > 0) {
      const instant = { x: (center.x - track.center.x) / gap, y: (center.y - track.center.y) / gap };
      track.velocity = track.velocity
        ? { x: track.velocity.x * 0.4 + instant.x * 0.6, y: track.velocity.y * 0.4 + instant.y * 0.6 }
        : instant;
    }
  }
  track.hits += 1;
  track.lastSeen = timestamp;
  track.center = center;
  track.bbox = detection.bbox;
  track.confidences.push(detection.confidence);
  if (detection.embedding) {
    if (!track.embedding || track.embedding.length !== detection.embedding.length) {
      track.embedding = [...detection.embedding];
      track.embeddingCount = 1;
    } else {
      track.embeddingCount += 1;
      const weight = 1 / track.embeddingCount;
      track.embedding = track.embedding.map((value, index) => value * (1 - weight) + (Number(detection.embedding[index]) || 0) * weight);
    }
    track.weakEmbedding = track.weakEmbedding || detection.weakEmbedding;
  }
  track.observations.push({ frame, timestamp, bbox: detection.bbox, confidence: detection.confidence, payload: detection.payload });
}

// Two-sided Wilson score lower bound (95%) used by the review console and the accuracy summary.
function wilsonLowerBound(successes, trials, z = 1.96) {
  if (!trials) return null;
  const phat = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const centre = phat + (z * z) / (2 * trials);
  const margin = z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * trials)) / trials);
  return Number(((centre - margin) / denominator).toFixed(4));
}

module.exports = {
  ENGINE_VERSION,
  TRACKER_DEFAULTS,
  trackDetections,
  assignPairs,
  evidenceWeightedConfidence,
  bboxIou,
  bboxCenter,
  bboxContainsPoint,
  bboxesIntersect,
  normaliseBbox,
  cosineSimilarity,
  isWeakEmbeddingModel,
  wilsonLowerBound,
};
