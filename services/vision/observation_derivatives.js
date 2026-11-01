const path = require('node:path');

const MAX_EVENT_FRAMES = 12;
const MAX_JOB_DERIVATIVES = 20;

function center(bbox) {
  if (!bbox || typeof bbox !== 'object') return null;
  const x = Number(bbox.x); const y = Number(bbox.y); const width = Number(bbox.width); const height = Number(bbox.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { x: x + width / 2, y: y + height / 2, scale: Math.max(width, height) };
}

function closestBbox(candidates, reference) {
  const anchor = center(reference);
  const valid = (candidates || []).map((candidate) => ({ bbox: candidate?.bbox || candidate?.detection?.bbox || candidate?.attributes?.detection?.bbox, candidate })).filter((entry) => center(entry.bbox));
  if (!valid.length) return reference || null;
  if (!anchor) return valid.sort((left, right) => center(right.bbox).scale - center(left.bbox).scale)[0].bbox;
  const selected = valid.map((entry) => {
    const point = center(entry.bbox);
    return { ...entry, distance: Math.hypot(point.x - anchor.x, point.y - anchor.y) / Math.max(anchor.scale, point.scale, 1) };
  }).sort((left, right) => left.distance - right.distance)[0];
  return selected.distance <= 2.5 ? selected.bbox : reference;
}

function bboxForFrame(frame, event, kind) {
  if (kind === 'vehicle') return closestBbox(frame?.triage?.vehicles || frame?.detect?.vehicles || [], event.best_bbox);
  if (kind === 'face') return closestBbox(frame?.face?.faces || frame?.triage?.faces || [], event.best_bbox);
  if (kind === 'person') return closestBbox(frame?.people?.people || frame?.triage?.people || [], event.best_bbox);
  if (kind === 'animal') return closestBbox(frame?.animals?.animals || frame?.triage?.animals || [], event.best_bbox);
  return event.best_bbox || null;
}

function candidateFramesForEvent(summary, event, kind, maximum = MAX_EVENT_FRAMES) {
  const first = Number(event.first_seen_seconds);
  const last = Number(event.last_seen_seconds);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return [];
  const frames = (summary.motion_segments || []).flatMap((segment) => segment.frames || [])
    .filter((frame) => frame?.file_path && frame.visual_quality !== 'degraded' && !['glitch', 'flare', 'ir_switch', 'occluded', 'degraded'].includes(frame.quality_state))
    .filter((frame) => {
      const at = Number(frame.relative_timestamp_seconds);
      return Number.isFinite(at) && at >= first - 2 && at <= last + 2;
    })
    .map((frame) => {
      const bbox = bboxForFrame(frame, event, kind);
      const point = center(bbox);
      const sharpness = Number(frame.sharpness_score) || 0;
      const confidence = Number(frame?.triage?.vehicle?.detection?.confidence || frame?.inference?.data?.detection?.confidence || 0);
      return { frame, bbox, score: sharpness + (point?.scale || 0) * 0.1 + confidence * 100 };
    })
    .filter((entry) => entry.bbox)
    .sort((left, right) => right.score - left.score || Number(left.frame.relative_timestamp_seconds) - Number(right.frame.relative_timestamp_seconds));
  const selected = [];
  const hashes = new Set();
  for (const entry of frames) {
    if (hashes.has(entry.frame.sha256_hash)) continue;
    hashes.add(entry.frame.sha256_hash);
    selected.push({
      path: entry.frame.file_path,
      sha256: entry.frame.sha256_hash,
      frame_index: entry.frame.frame_index,
      timestamp_seconds: entry.frame.relative_timestamp_seconds,
      sharpness_score: entry.frame.sharpness_score,
      bbox: entry.bbox,
    });
    if (selected.length >= Math.max(1, Math.min(MAX_EVENT_FRAMES, maximum))) break;
  }
  return selected;
}

function safeEventKey(eventId) {
  return String(eventId || 'observation').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 120);
}

function derivativeStoragePaths(evidence, eventId) {
  const bucket = evidence?.metadata?.storage_bucket || 'bob-uploads';
  const prefix = `org/${evidence.organization_id}/cctv-derivatives/${evidence.id}/${safeEventKey(eventId)}`;
  return { bucket, original: `${prefix}/original.jpg`, enhanced: `${prefix}/enhanced.jpg` };
}

function enhancementProviderOrder() {
  return ['laptop_gpu', 'worker_deterministic'];
}

function alprCandidate(result) {
  const alpr = result?.alpr;
  if (!alpr || alpr.success === false) return null;
  const first = Array.isArray(alpr.results) ? alpr.results[0] : null;
  const text = String(alpr.plate || first?.plate || first?.text || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
  if (!text) return null;
  return { text, confidence: Number(alpr.confidence ?? first?.confidence ?? 0) || 0 };
}

function recognitionComparison(source, enhanced) {
  const sourcePlate = alprCandidate(source);
  const enhancedPlate = alprCandidate(enhanced);
  return {
    alpr: {
      source: sourcePlate,
      enhanced: enhancedPlate,
      agreement: Boolean(sourcePlate && enhancedPlate && sourcePlate.text === enhancedPlate.text),
      review_required: true,
    },
    source_face_count: Array.isArray(source?.faces) ? source.faces.length : Array.isArray(source?.face?.faces) ? source.face.faces.length : 0,
    enhanced_face_count: Array.isArray(enhanced?.faces) ? enhanced.faces.length : Array.isArray(enhanced?.face?.faces) ? enhanced.face.faces.length : 0,
    source_animal_count: Array.isArray(source?.animals) ? source.animals.length : 0,
    enhanced_animal_count: Array.isArray(enhanced?.animals) ? enhanced.animals.length : 0,
    authority: 'provisional_human_review_required',
  };
}

module.exports = {
  MAX_EVENT_FRAMES,
  MAX_JOB_DERIVATIVES,
  candidateFramesForEvent,
  derivativeStoragePaths,
  enhancementProviderOrder,
  recognitionComparison,
  safeEventKey,
};
