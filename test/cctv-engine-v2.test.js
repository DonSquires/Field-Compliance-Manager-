// CCTV engine v2 contract (owner ruling 2026-11-01, docs/CCTV_INFERENCE_TIER.md): tracker behaviour, vehicle and
// plate attachment, and the privacy gates around vision-language hints. The VLM endpoints are configured for
// this file only (each node:test file runs in its own process) and every network call goes through a stub.
process.env.OLLAMA_VISION_URL = 'http://local-vlm.test:11434';
process.env.OLLAMA_API_TOKEN = 'test-cloud-token';
delete process.env.OLLAMA_VISION_MODEL;
process.env.LOCAL_GPU_INFERENCE_URL = 'http://laptop-gpu.test:3000';
process.env.RUNPOD_API = 'test-runpod-key';
process.env.VISION_LOCAL_GPU_BACKOFF_MS = '0';
process.env.VISION_RUNPOD_BACKOFF_MS = '0';
delete process.env.VISION_INFERENCE_POLICY;
delete process.env.VISION_PINNED_DETECTOR_MODEL;
process.env.SUPABASE_URL = 'https://example.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  ENGINE_VERSION,
  trackDetections,
  evidenceWeightedConfidence,
  wilsonLowerBound,
  isWeakEmbeddingModel,
} = require('../services/vision/entity_tracker');
const {
  consolidatePeople,
  consolidateVehicles,
  consolidateMotionSummary,
  buildEntityObservations,
  isReviewableCandidate,
} = require('../services/vision/motion_consolidator');
const hints = require('../services/vision/vision_hints');

const box = (x, y, width = 100, height = 100) => ({ x, y, width, height });
const frameAt = (seconds, detections) => ({ relative_timestamp_seconds: seconds, sha256_hash: `f-${seconds}`, quality_state: 'clear', detections });
const fromFrame = (frame) => frame.detections;

test('engine version is stamped as v2', () => {
  assert.equal(ENGINE_VERSION, 'cctv-engine-v2');
});

test('two people walking side by side stay two tracks: one detection per track per frame', () => {
  const frames = [0, 1, 2, 3].map((t) => frameAt(t, [
    { bbox: box(100 + t * 30, 200, 60, 180), confidence: 0.9 },
    { bbox: box(170 + t * 30, 200, 60, 180), confidence: 0.88 },
  ]));
  const { tracks } = trackDetections(frames, fromFrame);
  assert.equal(tracks.length, 2);
  assert.deepEqual(tracks.map((track) => track.hits), [4, 4]);
  for (const track of tracks) {
    const xs = track.observations.map((observation) => observation.bbox.x);
    assert.ok(xs.every((x, index) => index === 0 || x > xs[index - 1]), 'each track follows one walker');
  }
});

test('the spatial gate is bounded: a far detection after a long gap starts a new track', () => {
  const { tracks } = trackDetections([
    frameAt(0, [{ bbox: box(0, 0), confidence: 0.9 }]),
    frameAt(12, [{ bbox: box(1500, 0), confidence: 0.9 }]),
  ], fromFrame);
  assert.equal(tracks.length, 2, 'v1 grew the gate to ~13 sizes at 12 s and would have joined these');
});

test('a colour-layout embedding can veto a match but never rescue one off the spatial gate', () => {
  const same = Array(16).fill(0.25);
  const weak = trackDetections([
    frameAt(0, [{ bbox: box(0, 0), confidence: 0.9, embedding: same, embeddingModel: 'deterministic_hsv_layout_v1' }]),
    frameAt(10, [{ bbox: box(600, 0), confidence: 0.9, embedding: same, embeddingModel: 'deterministic_hsv_layout_v1' }]),
  ], fromFrame);
  assert.equal(weak.tracks.length, 2);
  const strong = trackDetections([
    frameAt(0, [{ bbox: box(0, 0), confidence: 0.9, embedding: same, embeddingModel: 'osnet_x1_0_reid' }]),
    frameAt(10, [{ bbox: box(600, 0), confidence: 0.9, embedding: same, embeddingModel: 'osnet_x1_0_reid' }]),
  ], fromFrame);
  assert.equal(strong.tracks.length, 1, 'a strong re-identification embedding may re-join within a bounded distance');
  const opposite = Array(16).fill(0).map((_, index) => (index % 2 ? 1 : 0));
  const vetoed = trackDetections([
    frameAt(0, [{ bbox: box(0, 0), confidence: 0.9, embedding: Array(16).fill(0).map((_, index) => (index % 2 ? 0 : 1)), embeddingModel: 'deterministic_hsv_layout_v1' }]),
    frameAt(1, [{ bbox: box(10, 0), confidence: 0.9, embedding: opposite, embeddingModel: 'deterministic_hsv_layout_v1' }]),
  ], fromFrame);
  assert.equal(vetoed.tracks.length, 2, 'a completely different colour layout vetoes the spatial match');
  assert.equal(isWeakEmbeddingModel('deterministic_hsv_layout_v1'), true);
  assert.equal(isWeakEmbeddingModel('person-reidentification-retail-0288.xml'), false);
});

test('low-confidence detections may extend a track but never start one; duplicate boxes are suppressed', () => {
  const { tracks, stats } = trackDetections([
    frameAt(0, [{ bbox: box(0, 0), confidence: 0.9 }, { bbox: box(2, 2), confidence: 0.6 }]),
    frameAt(1, [{ bbox: box(20, 0), confidence: 0.3 }]),
    frameAt(2, [{ bbox: box(900, 900), confidence: 0.3 }]),
  ], fromFrame);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].hits, 2);
  assert.equal(stats.duplicates_suppressed, 1);
  assert.ok(stats.low_confidence_dropped >= 1);
});

test('track confidence is evidence weighted and the peak is kept separately', () => {
  assert.equal(evidenceWeightedConfidence([0.9]), 0.72);
  assert.equal(evidenceWeightedConfidence([0.9, 0.9, 0.9]), 0.9);
  const { tracks } = trackDetections([frameAt(0, [{ bbox: box(0, 0), confidence: 0.6 }])], fromFrame);
  assert.equal(tracks[0].confirmed, false);
  assert.equal(tracks[0].confirmationBasis, 'unconfirmed_single_frame');
  assert.equal(tracks[0].peakConfidence, 0.6);
});

test('a parked vehicle is stationary and a crossing vehicle is moving', () => {
  const parked = trackDetections([0, 2, 4].map((t) => frameAt(t, [{ bbox: box(400 + t, 300, 200, 120), confidence: 0.9 }])), fromFrame);
  assert.equal(parked.tracks[0].motion_state, 'stationary');
  const moving = trackDetections([0, 1, 2].map((t) => frameAt(t, [{ bbox: box(100 + t * 120, 300, 200, 120), confidence: 0.9 }])), fromFrame);
  assert.equal(moving.tracks.length, 1);
  assert.equal(moving.tracks[0].motion_state, 'moving');
});

test('a single weak person detection stays on the timeline but is held out of the review queue', async () => {
  const events = await consolidatePeople([
    { relative_timestamp_seconds: 1, quality_state: 'clear', people: { success: true, people: [{ bbox: box(10, 10, 60, 180), confidence: 0.5 }] } },
  ], { hints: false });
  assert.equal(events.length, 1);
  assert.equal(events[0].event_id, 'person-e2-1');
  assert.equal(events[0].track_confirmed, false);
  assert.equal(isReviewableCandidate(events[0]), false);
});

function vehicleFrame(seconds, vehicles, alpr) {
  return {
    relative_timestamp_seconds: seconds,
    sha256_hash: `v-${seconds}`,
    quality_state: 'clear',
    runpod: { detector_model: 'rf-detr-large-704-coco', detector_provider: 'local_gpu', vehicles },
    ...(alpr ? { alpr } : {}),
  };
}

test('every vehicle in a frame is tracked and each plate attaches to the vehicle that carries it', async () => {
  const white = (t) => ({ bbox: box(100 + t * 10, 300, 300, 180), confidence: 0.95, attributes: { vehicle_colour: 'white', vehicle_colour_confidence: 0.9, vehicle_type: 'ute' } });
  const red = (t) => ({ bbox: box(900 + t * 10, 320, 280, 170), confidence: 0.93, attributes: { vehicle_colour: 'red', vehicle_colour_confidence: 0.9, vehicle_type: 'sedan' } });
  const frames = [0, 1, 2].map((t) => vehicleFrame(t, [white(t), red(t)], {
    success: true,
    plate: 'ABC123',
    confidence: 0.9,
    results: [
      { plate: 'ABC123', score: 0.9, box: box(200 + t * 10, 420, 60, 18), vehicle_bbox: white(t).bbox },
      { plate: t === 1 ? 'XYZ78Q' : 'XYZ789', score: t === 1 ? 0.6 : 0.88, box: box(1000 + t * 10, 440, 60, 18) },
    ],
  }));
  const { events, uniqueVehiclesCount } = await consolidateVehicles(frames, { hints: false });
  assert.equal(uniqueVehiclesCount, 2);
  const abc = events.find((event) => event.plate === 'ABC123');
  const xyz = events.find((event) => event.plate === 'XYZ789');
  assert.ok(abc && xyz, 'one OCR slip (XYZ78Q) joins its own vehicle, not a third entity');
  assert.equal(abc.vehicle_colour, 'white');
  assert.equal(xyz.vehicle_colour, 'red');
  assert.equal(abc.plate_attachment, 'tracked_vehicle');
  assert.deepEqual(xyz.plate_votes, { XYZ789: 2, XYZ78Q: 1 });
  assert.equal(abc.event_id, 'vehicle-e2-ABC123');
  assert.equal(abc.detector_model, 'rf-detr-large-704-coco');
  assert.equal(abc.engine_version, 'cctv-engine-v2');
  assert.equal(abc.vehicle_make_model_status, 'not_requested');
});

test('two vehicles on screen together stay separate even when their plates differ by one character', async () => {
  const frames = [0, 1].map((t) => vehicleFrame(t, [
    { bbox: box(100, 300, 300, 180), confidence: 0.95 },
    { bbox: box(900, 300, 300, 180), confidence: 0.95 },
  ], {
    success: true,
    results: [
      { plate: 'ABC123', score: 0.9, box: box(200, 420, 60, 18) },
      { plate: 'ABC128', score: 0.9, box: box(1000, 420, 60, 18) },
    ],
  }));
  const { events } = await consolidateVehicles(frames, { hints: false });
  assert.deepEqual(events.map((event) => event.plate).sort(), ['ABC123', 'ABC128']);
});

test('a strong second plate on one vehicle is surfaced as a conflict for the reviewer', async () => {
  const frames = [0, 1, 2, 3].map((t) => vehicleFrame(t, [{ bbox: box(100, 300, 300, 180), confidence: 0.95 }], {
    success: true,
    results: [{ plate: t < 2 ? 'KLM456' : 'TRL900', score: 0.9, box: box(200, 420, 60, 18) }],
  }));
  const { events } = await consolidateVehicles(frames, { hints: false });
  const vehicle = events.find((event) => event.plate === 'KLM456' || event.plate === 'TRL900');
  assert.equal(vehicle.plate_conflict, true);
  assert.equal(vehicle.review_required, true);
});

test('observations carry engine provenance for accuracy measurement', async () => {
  const frames = [0, 1, 2].map((t) => vehicleFrame(t, [{ bbox: box(100, 300, 300, 180), confidence: 0.95 }], {
    success: true, results: [{ plate: 'ABC123', score: 0.9, box: box(200, 420, 60, 18) }],
  }));
  const summary = await consolidateMotionSummary({ frame_width: 1920, frame_height: 1080, motion_segments: [{ start_time_seconds: 0, end_time_seconds: 3, frames }] }, { hints: false });
  assert.equal(summary.consolidated_events.engine.engine_version, 'cctv-engine-v2');
  assert.equal(summary.consolidated_events.engine.vlm.hints_requested, false);
  const [observation] = buildEntityObservations(summary, { recordedStartAt: '2026-11-01T00:00:00.000Z' });
  assert.equal(observation.attributes.engine_version, 'cctv-engine-v2');
  assert.equal(observation.attributes.detector_model, 'rf-detr-large-704-coco');
  assert.equal(observation.attributes.track_confirmed, true);
  assert.equal(observation.attributes.review_candidate_basis, 'temporal_consensus');
  assert.deepEqual(observation.attributes.plate_votes, { ABC123: 3 });
  assert.equal(observation.attributes.frame_width, 1920);
  assert.equal(observation.attributes.frame_height, 1080);
  assert.ok(observation.attributes.bbox, 'the detector box travels with the frame size so the reviewer sees it');
});

test('a VLM make/model guess keeps the one label that stops plate acceptance seeding the canonical vehicle', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const frames = [0, 1, 2].map((t) => vehicleFrame(t, [{ bbox: box(100, 300, 300, 180), confidence: 0.95 }], {
    success: true, results: [{ plate: 'ABC123', score: 0.9, box: box(200, 420, 60, 18) }],
  }));
  const summary = await consolidateMotionSummary({ frame_width: 1920, frame_height: 1080, motion_segments: [{ start_time_seconds: 0, end_time_seconds: 3, frames }] }, { hints: false });
  Object.assign(summary.consolidated_events.vehicle_events[0], {
    vehicle_make: 'Toyota', vehicle_model: 'Hilux', vehicle_make_model_source: 'vision_llm_hint_unverified',
    vehicle_make_model_tier: 'ollama_cloud', vehicle_make_model_model: 'gemma4:31b', vehicle_make_model_receipt: { id: 'receipt-1' },
  });
  const [observation] = buildEntityObservations(summary, { recordedStartAt: '2026-11-01T00:00:00.000Z' });
  assert.equal(observation.attributes.make_model_source, 'vision_llm_hint_unverified');
  assert.equal(observation.attributes.make_model_tier, 'ollama_cloud');
  assert.equal(observation.attributes.make_model_receipt_id, 'receipt-1');
  // review_cctv_entity_observation withholds make/model from the canonical vehicle only for this exact label, and
  // the console offers the hint for attribute review only for it; a new label would promote a machine guess.
  const root = path.join(__dirname, '..');
  const schema = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8');
  assert.match(schema, /attributes->>'make_model_source' = 'vision_llm_hint_unverified' THEN NULL ELSE v_obs\.attributes->>'make'/);
  const consoleLib = fs.readFileSync(path.join(root, 'apps/web/src/lib/cctvConsole.ts'), 'utf8');
  assert.ok(consoleLib.includes("make_model_source !== 'vision_llm_hint_unverified'"));
  const hintSource = fs.readFileSync(path.join(root, 'services/vision/vision_hints.js'), 'utf8');
  assert.deepEqual([...new Set(hintSource.match(/'[a-z_]+_hint_unverified'/g))], ["'vision_llm_hint_unverified'"]);
});

test('Wilson lower bound is conservative for small samples', () => {
  assert.equal(wilsonLowerBound(0, 0), null);
  assert.ok(wilsonLowerBound(3, 3) < 0.5, 'three of three is not proof of high precision');
  assert.ok(wilsonLowerBound(95, 100) > 0.88);
});

// ── Vision-language hints ────────────────────────────────────────────────────────────────────────────────
const deps = hints.__testing.deps;
const originalDeps = { ...deps };
const CROP_BYTES = Buffer.from('masked-crop-bytes');

function stubVlm({ local, cloud, crops = [] }) {
  const calls = [];
  deps.cropFrame = async (filePath, bbox, options = {}) => {
    crops.push({ filePath, bbox, options });
    return { bytes: CROP_BYTES, crop: bbox };
  };
  deps.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    const answer = url.startsWith('http://local-vlm.test') ? local : cloud;
    if (!answer) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ message: { content: JSON.stringify(answer) } }) };
  };
  return calls;
}

test.afterEach(() => Object.assign(deps, originalDeps));

test('the local Qwen3-VL hint uses a JSON schema at temperature 0 and is labelled an unverified hint', async () => {
  const calls = stubVlm({ local: { make: 'Toyota', model: 'Hilux', body_type: 'ute', colour: 'white', confidence: 'high', evidence: 'Toyota badge on grille' } });
  const hint = await hints.getVehicleVisionHint('/tmp/frame.jpg', box(10, 10, 200, 120));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://local-vlm.test:11434/api/chat');
  assert.equal(calls[0].body.model, 'qwen3-vl:4b');
  assert.equal(calls[0].body.options.temperature, 0);
  // Without a bounded context Ollama sizes the KV cache for Qwen3-VL's full window and the laptop fails to load
  // it (36.5 GB allocation, measured 2026-11-01); the model still reasons before answering, so the output budget
  // must leave room for the JSON after the reasoning.
  assert.equal(calls[0].body.options.num_ctx, 8192);
  assert.ok(calls[0].body.options.num_predict >= 768);
  assert.deepEqual(calls[0].body.format, hints.VEHICLE_HINT_SCHEMA);
  // "ute" is a NZ/AU word: without a definition the model filed a Toyota Hilux pickup as a campervan (2026-11-01).
  assert.match(calls[0].body.messages[0].content, /"ute" is a pickup/);
  assert.equal(calls[0].headers.Authorization, undefined, 'the local tier never carries the cloud token');
  assert.equal(hint.vehicle_make, 'Toyota');
  assert.equal(hint.vehicle_model, 'Hilux');
  assert.equal(hint.vehicle_make_model_source, 'vision_llm_hint_unverified');
  assert.equal(hint.vehicle_make_model_tier, 'local_vlm');
  assert.equal(hint.vehicle_make_model_status, 'hint');
  assert.equal(hint.vlm_body_type, 'ute');
});

test('a low-confidence make/model guess is withheld instead of shown as an answer', async () => {
  stubVlm({ local: { make: 'Mazda', model: 'Demio', body_type: 'hatchback', colour: 'red', confidence: 'low', evidence: 'shape only' } });
  const hint = await hints.getVehicleVisionHint('/tmp/frame.jpg', box(10, 10, 200, 120));
  assert.equal(hint.vehicle_make, null);
  assert.equal(hint.vehicle_model, null);
  assert.equal(hint.vehicle_make_model_status, 'no_confident_guess');
});

test('without an organisation opt-in nothing leaves the local tier', async () => {
  const calls = stubVlm({ local: null, cloud: { make: 'Ford', model: 'Ranger', body_type: 'ute', colour: 'blue', confidence: 'high', evidence: 'badge' } });
  const hint = await hints.getVehicleVisionHint('/tmp/frame.jpg', box(10, 10, 200, 120));
  assert.equal(hint.vehicle_make_model_status, 'vlm_unavailable');
  assert.ok(calls.every((call) => call.url.startsWith('http://local-vlm.test')));
});

function cloudContext(overrides = {}) {
  const receipts = [];
  return {
    receipts,
    context: {
      cloud: {
        enabled: true,
        model: 'gemma4:31b',
        plateScanned: true,
        plateBoxesComplete: true,
        plateBoxes: [box(60, 90, 50, 16)],
        personScanned: true,
        personBoxes: [],
        sourceEventId: 'vehicle-e2-unconfirmed-1',
        recordReceipt: async (receipt) => { receipts.push(receipt); return { id: 'receipt-1' }; },
        ...overrides,
      },
    },
  };
}

test('the cloud hint is sent only after a receipt for the exact plate-masked bytes is recorded', async () => {
  const crops = [];
  const order = [];
  const calls = stubVlm({ local: null, cloud: { make: 'Ford', model: 'Ranger', body_type: 'ute', colour: 'blue', confidence: 'medium', evidence: 'grille shape' }, crops });
  const { receipts, context } = cloudContext();
  const recordReceipt = context.cloud.recordReceipt;
  context.cloud.recordReceipt = async (receipt) => { order.push('receipt'); return recordReceipt(receipt); };
  const realFetch = deps.fetch;
  deps.fetch = async (url, init) => { if (!url.startsWith('http://local-vlm.test')) order.push('cloud'); return realFetch(url, init); };

  const hint = await hints.getVehicleVisionHint('/tmp/frame.jpg', box(10, 10, 200, 120), context);
  assert.deepEqual(order, ['receipt', 'cloud']);
  const cloudCall = calls.find((call) => call.url === 'https://ollama.com/api/chat');
  assert.ok(cloudCall);
  assert.equal(cloudCall.headers.Authorization, 'Bearer test-cloud-token');
  const sentSha = crypto.createHash('sha256').update(Buffer.from(cloudCall.body.messages[0].images[0], 'base64')).digest('hex');
  assert.equal(receipts[0].crop_sha256, sentSha, 'the receipt names the exact bytes that left');
  assert.equal(receipts[0].plate_masked, true);
  assert.equal(receipts[0].persons_excluded, true);
  assert.equal(receipts[0].plate_boxes_masked, 1);
  const maskedCrop = crops.find((crop) => crop.options.maskBoxes?.length);
  assert.ok(maskedCrop, 'the plate is blacked out before the crop is taken');
  assert.ok(maskedCrop.options.maskBoxes[0].width > 50, 'the mask is padded beyond the located plate');
  assert.equal(hint.vehicle_make_model_source, 'vision_llm_hint_unverified');
  assert.equal(hint.vehicle_make_model_tier, 'ollama_cloud');
  assert.equal(hint.vehicle_make_model_receipt.id, 'receipt-1');
});

test('the cloud hint is skipped when a person is in the crop, the plate scan is missing or the receipt fails', async () => {
  for (const [overrides, status] of [
    [{ personBoxes: [box(50, 50, 40, 100)] }, 'cloud_skipped_person_in_crop'],
    [{ plateScanned: false }, 'cloud_skipped_plate_scan_missing'],
    [{ plateBoxesComplete: false }, 'cloud_skipped_unmasked_plates'],
    [{ personScanned: false }, 'cloud_skipped_person_scan_missing'],
    [{ recordReceipt: async () => { throw new Error('rpc down'); } }, 'cloud_skipped_receipt_failed'],
    [{ recordReceipt: async () => null }, 'cloud_skipped_receipt_failed'],
  ]) {
    const calls = stubVlm({ local: null, cloud: { make: 'Ford', model: 'Ranger', body_type: 'ute', colour: 'blue', confidence: 'high', evidence: 'badge' } });
    const { context } = cloudContext(overrides);
    const hint = await hints.getVehicleVisionHint('/tmp/frame.jpg', box(10, 10, 200, 120), context);
    assert.equal(hint.vehicle_make_model_status, status);
    assert.equal(calls.filter((call) => call.url.startsWith('https://ollama.com')).length, 0, `${status}: no egress`);
  }
});

test('weapon and scene prompts never leave the local tier', async () => {
  const calls = stubVlm({ local: { possible_weapon: true, description: 'long object in right hand' } });
  const weapon = await hints.getWeaponHint('/tmp/frame.jpg', box(10, 10, 60, 180));
  assert.equal(weapon.present, true);
  assert.equal(weapon.source, 'vision_llm_hint_requires_human_review');
  stubVlm({ local: null });
  assert.equal(await hints.getWeaponHint('/tmp/frame.jpg', box(10, 10, 60, 180)), null, 'not checked is never reported as clear');
  assert.ok(calls.every((call) => call.url.startsWith('http://local-vlm.test')));
});

// ---------------------------------------------------------------- one detector model per job (gpu_consistent)
const watcher = require('../services/vision/vision_job_watcher');

const LARGE = 'rf-detr-large-704-coco';
const SMALL = 'rf-detr-small-512-coco';
const gpuItem = (hash) => ({ frame: { sha256_hash: hash }, image: Buffer.from(hash) });

test('gpu_consistent is the default policy and pins the GPU large detector', () => {
  assert.equal(watcher.INFERENCE_POLICY, 'gpu_consistent');
  assert.equal(watcher.PINNED_DETECTOR_MODEL, LARGE);
  assert.deepEqual(watcher.triageOrderFor('gpu_consistent'), ['local_gpu', 'gpu'], 'the VPS CPU detector is never asked');
});

test('an answer from a different detector model is rejected and counted, never mixed into the job', () => {
  const pin = watcher.detectorPin();
  assert.equal(watcher.acceptTriageAnswer({ success: true, detector_model: LARGE }, pin), true);
  assert.equal(watcher.acceptTriageAnswer({ success: true, detector_model: SMALL }, pin), false);
  assert.equal(watcher.acceptTriageAnswer({ success: true }, pin), false, 'an answer that does not say which model looked is not trusted');
  assert.deepEqual(pin.rejected, { [SMALL]: 1, unreported: 1 });
  // An empty pin takes the job's first accepted model and holds every later answer to it.
  const open = watcher.detectorPin('');
  assert.equal(watcher.acceptTriageAnswer({ success: true, detector_model: SMALL }, open), true);
  assert.equal(open.model, SMALL);
  assert.equal(watcher.acceptTriageAnswer({ success: true, detector_model: LARGE }, open), false);
  // Other policies keep their historical behaviour.
  assert.equal(watcher.acceptTriageAnswer({ success: true, detector_model: SMALL }, pin, 'local_gpu_first'), true);
});

test('recognition asks the laptop GPU first, RunPod for the rest, and drops a mismatched model', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).startsWith('http://laptop-gpu.test:3000/infer/batch')) {
      calls.push({ machine: 'laptop', frames: body.frames.map((f) => f.frame_id), tasks: body.tasks });
      // The laptop answers frame a with the pinned model and frame b with the wrong one; c gets no answer.
      return new Response(JSON.stringify({ results: [
        { frame_id: 'a', result: { success: true, detector_model: LARGE, people: [], vehicles: [] } },
        { frame_id: 'b', result: { success: true, detector_model: SMALL, people: [], vehicles: [] } },
      ] }), { status: 200 });
    }
    calls.push({ machine: 'runpod', frames: body.input.frames.map((f) => f.frame_id), tasks: body.input.tasks });
    return new Response(JSON.stringify({ status: 'COMPLETED', output: { results: [
      { frame_id: 'b', result: { success: true, detector_model: LARGE, people: [] } },
      { frame_id: 'c', result: { success: true, detector_model: SMALL, people: [] } },
    ] } }), { status: 200 });
  });
  const pin = watcher.detectorPin();
  const usage = { gpu_calls: 0, frames_sent: 0, gpu_ms: 0, vps_calls: 0, vps_ms: 0 };
  const answers = await watcher.recognitionAnswers([gpuItem('a'), gpuItem('b'), gpuItem('c')], usage, pin, 'gpu_consistent');
  assert.deepEqual(calls.map((call) => [call.machine, call.frames]), [['laptop', ['a', 'b', 'c']], ['runpod', ['b', 'c']]]);
  assert.deepEqual(calls[0].tasks, ['person', 'vehicle', 'animal', 'plate', 'face'], 'recognition asks for every task');
  assert.equal(answers.get('a').triage_provider, 'local_gpu');
  assert.equal(answers.get('b').triage_provider, 'gpu');
  assert.equal(answers.has('c'), false, 'a RunPod answer from another model is not used; c keeps its pinned triage answer');
  assert.deepEqual(pin.rejected, { [SMALL]: 2 });
  assert.equal(usage.gpu_calls, 2);
  // Policies without a GPU recognition pass do not call anything.
  calls.length = 0;
  assert.equal((await watcher.recognitionAnswers([gpuItem('a')], usage, pin, 'vps_first')).size, 0);
  assert.equal(calls.length, 0);
});

test('the model manifest records the pinned model, the models that answered and what was rejected', () => {
  const pin = watcher.detectorPin();
  pin.rejected[SMALL] = 3;
  const frames = [
    { detect: { success: true }, runpod: { detector_model: LARGE } },
    { detect: { success: true }, runpod: { detector_model: LARGE } },
    {},
  ];
  assert.deepEqual(watcher.modelManifest(frames, pin, 'gpu_consistent'), {
    engine_version: ENGINE_VERSION,
    inference_policy: 'gpu_consistent',
    pinned_detector_model: LARGE,
    detector_models: { [LARGE]: 2 },
    rejected_answers_by_model: { [SMALL]: 3 },
  });
  assert.equal(watcher.modelManifest(frames, pin, 'vps_first').pinned_detector_model, null);
});

test('the watcher wires engine v2 into the job: hint-free first pass, cloud opt-in, reconcile, coalesce, resident link', () => {
  const source = require('node:fs').readFileSync(require.resolve('../services/vision/vision_job_watcher'), 'utf8');
  assert.match(source, /if \(triageComplete\) await consolidateMotionSummary\(summary, \{[^}]*hints: false \}\);/);
  assert.match(source, /cloudVehicleVlm: await loadCloudVehicleVlmPolicy\(job\),/);
  assert.match(source, /if \(data\?\.cloud_vehicle_vlm_enabled !== true\) return null;/, 'anything but an explicit opt-in keeps crops local');
  assert.match(source, /supabase\.rpc\('record_cctv_cloud_inference_receipt', \{ p_job_id: job\.id, p_receipt: receipt \}\)/);
  const reconcile = source.indexOf("rpc('reconcile_cctv_reviewed_observations'");
  const coalesce = source.indexOf("rpc('coalesce_cctv_stationary_vehicle_observations', { p_job_id: job.id });\n  if (coalesceError) throw new Error(`stationary");
  const resident = source.indexOf("rpc('link_cctv_resident_vehicle_observations'");
  assert.ok(reconcile > 0 && coalesce > reconcile && resident > coalesce, 'reconcile, then coalesce, then resident linking');
});
