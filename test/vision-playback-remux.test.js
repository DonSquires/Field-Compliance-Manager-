const assert = require('node:assert/strict');
const test = require('node:test');

process.env.SUPABASE_URL ||= 'https://example.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';

const { playbackStoragePath, selectFramesForClassification, representativeFrameHashes } = require('../services/vision/vision_job_watcher');

test('playbackStoragePath replaces the source extension with .playback.mp4', () => {
  assert.equal(
    playbackStoragePath('desktop/user-1/attachment-1-FCM-card-p0-d000072.h264'),
    'desktop/user-1/attachment-1-FCM-card-p0-d000072.playback.mp4'
  );
});

test('playbackStoragePath handles sources that already carry a playable container extension', () => {
  assert.equal(playbackStoragePath('desktop/user-1/export.mp4'), 'desktop/user-1/export.playback.mp4');
});

test('playbackStoragePath handles paths without an extension', () => {
  assert.equal(playbackStoragePath('desktop/user-1/attachment-1-clip'), 'desktop/user-1/attachment-1-clip.playback.mp4');
});

function framesRange(count) {
  return Array.from({ length: count }, (_, index) => ({ frame_index: index }));
}

test('selectFramesForClassification spreads the budget across every segment instead of only the first', () => {
  const segments = [{ frames: framesRange(300) }, { frames: framesRange(300) }, { frames: framesRange(300) }];
  const selected = selectFramesForClassification(segments, 30);
  // Every segment must contribute frames; a naive flatten+slice(0,30) would only ever pick from segment 1.
  const perSegmentCounts = segments.map((segment) => selected.filter((frame) => segment.frames.includes(frame)).length);
  assert.ok(perSegmentCounts.every((count) => count > 0), 'every motion segment must contribute at least one classified frame');
});

test('selectFramesForClassification samples across a segment instead of only its earliest frames', () => {
  const segments = [{ frames: framesRange(300) }];
  const selected = selectFramesForClassification(segments, 10);
  const indices = selected.map((frame) => frame.frame_index);
  // A vehicle just entering the padded pre-roll window is only visible in the earliest frames;
  // the picks must reach well past that to actually capture it mid-window, not just the edge.
  assert.ok(Math.max(...indices) > 200, `expected samples spread past frame 200, got ${indices}`);
});

test('representativeFrameHashes deduplicates a twelve-frame tracked observation before recognition', () => {
  const summary = {
    consolidated_events: {
      person_events: [{ event_id: 'person-1', frame_count: 12, best_frame_hash: 'clearest-person-frame' }],
      vehicle_events: [{ event_id: 'vehicle-1', frame_count: 12, best_frame_hash: 'clearest-vehicle-frame' }],
      animal_events: [],
      face_events: [{ event_id: 'face-1', frame_count: 12, best_frame_hash: 'clearest-person-frame' }],
    },
  };
  assert.deepEqual(representativeFrameHashes(summary).sort(), ['clearest-person-frame', 'clearest-vehicle-frame']);
});

test('vision watcher source contains a degraded-frame inference gate', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'services/vision/vision_job_watcher.js'), 'utf8');
  assert.match(source, /frame\.visual_quality === 'degraded'/);
  assert.match(source, /visual_quality_gate/);
  assert.match(source, /human_review_required: true/);
  assert.match(source, /RUNPOD_CAPTURE_API_URL/);
  assert.match(source, /capture_recognition/);
  assert.match(source, /detector_triage_then_one_full_recognition_per_unique_observation/);
  assert.match(source, /deterministic_capture_v1/);
  assert.match(source, /capture_endpoint_not_configured/);
  assert.match(source, /RUNPOD_CAPTURE_API_KEY/);
  assert.match(source, /RUNPOD_CAPTURE_API_URL/);
  assert.match(source, /WORKER_CONCURRENCY/);
  assert.match(source, /worker_concurrency/);
});
