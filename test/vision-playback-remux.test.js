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

test('selectFramesForClassification gives budget a short segment cannot use to the long segments', () => {
  // Measured live 2026-11-01: 21 of 319 capped jobs sampled as few as 80 of 120 frames because short segments
  // kept an equal share they could not fill while a long walk-through stayed undersampled.
  const segments = [{ frames: framesRange(2) }, { frames: framesRange(3) }, { frames: framesRange(900) }];
  const selected = selectFramesForClassification(segments, 120);
  assert.equal(selected.length, 120);
  assert.equal(selected.filter((frame) => segments[0].frames.includes(frame)).length, 2);
  assert.equal(selected.filter((frame) => segments[1].frames.includes(frame)).length, 3);
  assert.equal(new Set(selected).size, 120, 'a frame is never examined twice');
});

test('selectFramesForClassification covers the whole clip when there are more segments than budget', () => {
  const segments = Array.from({ length: 300 }, () => ({ frames: framesRange(5) }));
  const selected = selectFramesForClassification(segments, 120);
  assert.equal(selected.length, 120);
  const touched = segments.map((segment, index) => (selected.some((frame) => segment.frames.includes(frame)) ? index : -1)).filter((index) => index >= 0);
  assert.equal(touched[0], 0);
  assert.equal(touched[touched.length - 1], 299, 'the last motion segment must still be examined');
});

test('selectFramesForClassification keeps chronological order and never exceeds the frames available', () => {
  const segments = [{ frames: framesRange(4) }, { frames: framesRange(6) }];
  const selected = selectFramesForClassification(segments, 120);
  assert.equal(selected.length, 10);
  assert.deepEqual(selected, [...segments[0].frames, ...segments[1].frames]);
  assert.deepEqual(selectFramesForClassification([], 120), []);
  assert.deepEqual(selectFramesForClassification(segments, 0), []);
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

test('vision watcher meters GPU use per job and defers (never fails) when the daily budget is spent', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'services/vision/vision_job_watcher.js'), 'utf8');
  // Every RunPod call is counted, including failed ones, so the meter reflects what was actually asked of the GPU.
  assert.match(source, /const meter = \(\) => \{ if \(usage\) \{ usage\.gpu_calls \+= 1; usage\.frames_sent \+= batch\.length; usage\.gpu_ms \+= Date\.now\(\) - startedAt; \} \};/);
  // Triage asks RunPod only for frames an earlier machine left unanswered; recognition re-reads on a GPU only
  // under gpu_first and gpu_consistent, and those reads are metered through the same usage object.
  assert.match(source, /await classifyWithRunpodBatch\(remaining, \['person', 'vehicle', 'animal', 'detect'\], usage\)/);
  assert.match(source, /if \(policy === 'gpu_first'\) \{\s*for \(const \[hash, answer\] of await classifyWithRunpodBatch\(batch, undefined, usage\)\)/);
  assert.match(source, /await classifyWithRunpodBatch\(remaining, RECOGNITION_TASKS, usage\)/);
  // VPS work is metered too, so the two machines' shares are visible per job.
  assert.match(source, /usage\.vps_calls \+= 1; usage\.vps_ms \+= Date\.now\(\) - startedAt;/);
  assert.match(source, /supabase\.rpc\('record_cctv_inference_usage', \{ p_job_id: job\.id, p_usage: usage \}\)/);
  // The gate sits after the free work and before extraction/inference; a spent budget returns the job to the queue.
  const gate = source.indexOf('if (await deferIfBudgetExhausted(job)) { currentJobId = null; return; }');
  const extraction = source.indexOf("log('motion_extraction_started'");
  const hashing = source.indexOf('await recordSourceHash(job, evidence, videoPath);');
  assert.ok(gate > hashing && gate < extraction, 'budget gate runs after hashing and before motion extraction');
  assert.match(source, /supabase\.rpc\('cctv_inference_budget_check', \{ p_organization_id: job\.organization_id \}\)/);
  assert.match(source, /supabase\.rpc\('defer_cctv_inference_job', \{ p_job_id: job\.id, p_lease_token: job\.lease_token, p_reason: reason, p_not_before_seconds: waitSeconds \}\)/);
  assert.doesNotMatch(source, /failJob\([^)]*budget/i, 'a spent budget must never fail a job');
  // The poll respects a deferred job's not-before time.
  assert.match(source, /\.or\(`lease_expires_at\.is\.null,lease_expires_at\.lt\.\$\{new Date\(\)\.toISOString\(\)\}`\)/);
});

test('an extractor timeout under hypervisor CPU steal defers the job instead of failing the evidence', () => {
  const { stealRatioSince, extractorStarved, STARVED_STEAL_RATIO } = require('../services/vision/vision_job_watcher');
  // /proc/stat deltas: 900 of 1000 jiffies withheld by the host.
  assert.equal(stealRatioSince({ total: 5000, steal: 100 }, { total: 6000, steal: 1000 }), 0.9);
  assert.equal(stealRatioSince({ total: 5000, steal: 100 }, { total: 6000, steal: 100 }), 0);
  assert.equal(stealRatioSince(null, { total: 6000, steal: 100 }), null, 'no sample means no claim');
  assert.equal(stealRatioSince({ total: 6000, steal: 100 }, { total: 6000, steal: 100 }), null, 'a zero-length window means no claim');
  assert.equal(STARVED_STEAL_RATIO, 0.5);
  const starved = Object.assign(new Error('motion extractor timed out'), { code: 'EXTRACTOR_TIMEOUT', cpu_steal_ratio: 0.93 });
  const genuine = Object.assign(new Error('motion extractor timed out'), { code: 'EXTRACTOR_TIMEOUT', cpu_steal_ratio: 0.02 });
  const unknown = Object.assign(new Error('motion extractor timed out'), { code: 'EXTRACTOR_TIMEOUT', cpu_steal_ratio: null });
  assert.equal(extractorStarved(starved), true);
  assert.equal(extractorStarved(genuine), false, 'a timeout with the CPU available is still a failure');
  assert.equal(extractorStarved(unknown), false, 'without a steal reading the timeout is not excused');
  assert.equal(extractorStarved(new Error('motion extractor exited 1: boom')), false);
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'services/vision/vision_job_watcher.js'), 'utf8');
  assert.match(source, /if \(extractorStarved\(error\)\) \{[\s\S]*?supabase\.rpc\('defer_cctv_inference_job', \{ p_job_id: currentJobId, p_lease_token: currentLeaseToken, p_reason: reason, p_not_before_seconds: STARVED_DEFER_SECONDS \}\)/);
  assert.match(source, /log\('extractor_starved_deferred'/);
  // The fallback when the deferral itself is refused is still the honest failure, never a silent completion.
  assert.match(source, /log\('extractor_starved_defer_failed'[\s\S]*?await failJob\(currentJobId, error\.message\)/);
});
