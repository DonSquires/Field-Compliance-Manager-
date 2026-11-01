const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

process.env.SUPABASE_URL ||= 'https://example.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';

const { choosePlaybackStrategy, ffmpegArgsFor, PLAYBACK_PROFILES, normaliseAnimals, stillEntityObservations, localTriageResult, triageOrderFor, triageCoverage, compactMotionSummaryForIngestion, INFERENCE_POLICY, triageProviderLabel } = require('../services/vision/vision_job_watcher');
const { consolidateAnimals, consolidatePeople, consolidateMotionSummary, buildEntityObservations, buildInferenceDeviceEvents, isReviewableCandidate } = require('../services/vision/motion_consolidator');
const { candidateFramesForEvent, derivativeStoragePaths, enhancementProviderOrder, recognitionComparison } = require('../services/vision/observation_derivatives');

const watcherSource = fs.readFileSync(path.join(__dirname, '..', 'services/vision/vision_job_watcher.js'), 'utf8');

test('an H.264 MP4 source (TAPO) is copy-remuxed with faststart instead of re-encoded', () => {
  assert.equal(choosePlaybackStrategy({ codec_name: 'h264', pix_fmt: 'yuv420p', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' }), 'copy');
  assert.equal(choosePlaybackStrategy({ codec_name: 'h264', pix_fmt: 'yuvj420p', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' }), 'copy');
  const args = ffmpegArgsFor('copy', '/in.mp4', '/out.mp4');
  assert.deepEqual(args.slice(args.indexOf('-c:v'), args.indexOf('-c:v') + 2), ['-c:v', 'copy']);
  assert.ok(args.includes('+faststart'));
  assert.ok(!args.includes('libx264'));
  assert.equal(PLAYBACK_PROFILES.copy, 'h264-copy-faststart');
});

test('anything that is not browser-safe H.264 in an MP4 family container is transcoded', () => {
  assert.equal(choosePlaybackStrategy({ codec_name: 'hevc', pix_fmt: 'yuv420p', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' }), 'transcode');
  assert.equal(choosePlaybackStrategy({ codec_name: 'h264', pix_fmt: 'yuv420p', format_name: 'h264' }), 'transcode', 'raw elementary stream has no container to copy into');
  assert.equal(choosePlaybackStrategy({ codec_name: 'h264', pix_fmt: 'yuv444p', format_name: 'mov,mp4' }), 'transcode', '4:4:4 does not play in browsers');
  assert.equal(choosePlaybackStrategy(null), 'transcode', 'no probe -> safe path');
  const args = ffmpegArgsFor('transcode', '/in.h265', '/out.mp4');
  assert.ok(args.includes('libx264') && args.includes('+faststart'));
  assert.equal(PLAYBACK_PROFILES.transcode, 'h264-slow-crf18');
});

test('watcher probes before remuxing, falls back to transcode on a failed copy, and skips work already done under either profile', () => {
  assert.match(watcherSource, /const probe = await probeVideo\(videoPath\);\s*let strategy = choosePlaybackStrategy\(probe\);/);
  assert.match(watcherSource, /playback_copy_fallback_transcode/);
  assert.match(watcherSource, /Object\.values\(PLAYBACK_PROFILES\)\.includes\(evidence\.metadata\?\.playback_transcode_profile\)/);
  assert.match(watcherSource, /playback_transcode_profile: PLAYBACK_PROFILES\[strategy\]/);
});

test('normaliseAnimals distinguishes "none seen" from "no model could look"', () => {
  assert.deepEqual(normaliseAnimals({ animals: [], animal_detection_status: 'model_not_staged', detector_provider: null }, null), { success: true, animals: [], status: 'model_not_staged', provider: 'unreported' });
  const seen = normaliseAnimals({ animals: [{ kind: 'animal', species: 'possum', bbox: { x: 1, y: 1, width: 10, height: 10 } }], animal_detection_status: 'ready', detector_provider: 'megadetector:md_v5a.0.0.pt' }, null);
  assert.equal(seen.animals.length, 1);
  assert.equal(seen.status, 'ready');
  const local = normaliseAnimals(null, { success: true, detector_coverage: ['vehicle'], animals: [], species_status: 'model_not_staged', detector_provider: 'openvino:vehicle-detection-0200.xml' });
  assert.equal(local.status, 'model_not_staged', 'a vehicle-only tier cannot claim there were no animals');
  const localFull = normaliseAnimals(null, { success: true, detector_coverage: ['person', 'vehicle', 'animal'], animals: [], species_status: 'model_not_staged', detector_provider: 'megadetector:md_v5a.0.0.pt' });
  assert.equal(localFull.status, 'detector_only_species_not_staged');
  assert.equal(normaliseAnimals(null, { success: false }).success, false);
});

test('still recognition produces provisional face and ALPR review candidates without trusting enhanced face identity', () => {
  const sourceFaceEmbedding = Array(128).fill(0.05);
  const observations = stillEntityObservations({
    source: {
      success: true,
      people: [{ confidence: 0.91, bbox: { x: 10, y: 20, width: 30, height: 80 } }],
      faces: [{
        confidence: 0.88, bbox: { x: 14, y: 22, width: 20, height: 20 }, embedding: sourceFaceEmbedding,
        detector_confidence: 0.91, face_crop_width_px: 20, alignment_basis: 'deterministic_upscaled_crop',
        usable_for_matching: true, face_quality_score: 0.91, matching_gate_version: 'face_quality_v1',
        face_detector_model: 'face_detection_yunet_2023mar.onnx', face_embedding_model: 'face_recognition_sface_2021dec.onnx',
      }],
      vehicles: [{ confidence: 0.95, bbox: { x: 100, y: 100, width: 200, height: 120 }, attributes: { vehicle_colour: 'white', vehicle_type: 'ute' } }],
      alpr: { success: true, plate: 'ABC123', confidence: 0.9 },
    },
    enhanced: { success: true, faces: [{ embedding: Array(128).fill(0.2) }], alpr: { success: true, plate: 'ABC128', confidence: 0.7 } },
  }, { capturedAt: '2026-09-26T01:02:03.000Z', frameSha256: 'a'.repeat(64), provider: 'laptop_gpu' });
  const person = observations.find((item) => item.entity_kind === 'person');
  const vehicle = observations.find((item) => item.entity_kind === 'vehicle');
  assert.deepEqual(person.candidate_embedding, sourceFaceEmbedding);
  assert.equal(person.attributes.face_basis, 'authoritative_source');
  assert.equal(person.attributes.face_detector_confidence, 0.91);
  assert.equal(person.attributes.face_alignment_basis, 'deterministic_upscaled_crop');
  assert.equal(person.attributes.face_usable_for_matching, true);
  assert.equal(person.attributes.face_detector_model, 'face_detection_yunet_2023mar.onnx');
  assert.equal(person.attributes.face_embedding_model, 'face_recognition_sface_2021dec.onnx');
  assert.equal(person.attributes.face_provider, 'laptop_gpu');
  assert.equal(vehicle.candidate_plate, 'ABC123');
  assert.equal(vehicle.attributes.plate_basis, 'authoritative_source');
  assert.equal(vehicle.attributes.review_required, true);
  assert.equal(vehicle.observed_at, '2026-09-26T01:02:03.000Z');
});

test('enhanced-only face detection is visible but never emits an identity embedding', () => {
  const observations = stillEntityObservations({
    source: { success: true, people: [], faces: [], vehicles: [], animals: [] },
    enhanced: { success: true, faces: [{ confidence: 0.72, embedding: Array(128).fill(0.1) }] },
  }, { capturedAt: '2026-09-26T01:02:03.000Z' });
  assert.equal(observations.length, 1);
  assert.equal(observations[0].entity_kind, 'person');
  assert.equal(observations[0].candidate_embedding, undefined);
  assert.equal(observations[0].attributes.face_basis, 'enhanced_candidate');
});

test('watcher skips the full-frame vehicle pass when a detector covered vehicles and found none', () => {
  assert.match(watcherSource, /const vehicleCovered = detectorCoverage\.has\('vehicle'\);/);
  assert.match(watcherSource, /!triageAnswer\?\.vehicle && !vehicleCovered && LOCAL_VEHICLE_INFERENCE/);
  assert.match(watcherSource, /error: 'no_vehicle_detected', review_required: false/);
  assert.match(watcherSource, /classifyLocally\(INFERENCE_SERVICE_URL, '\/infer\/detect', headers, buildForm\)/);
});

test('watcher takes ALPR and faces from the triage answer and only asks the VPS for what is missing', () => {
  // The triage answer (GPU or VPS) carries alpr + face; the VPS ALPR route is skipped when either answered.
  assert.match(watcherSource, /const triageAlpr = triageAnswer\?\.alpr\?\.success \? triageAnswer\.alpr : null;/);
  assert.match(watcherSource, /const triageFace = triageAnswer\?\.face\?\.success && Array\.isArray\(triageAnswer\.face\.faces\) \? triageAnswer\.face : null;/);
  assert.match(watcherSource, /triageAlpr \|\| needLocalDetect\s*\?\s*Promise\.resolve\(null\)/);
  // Provenance follows the machine that answered; an answer that does not say which machine is never relabelled.
  assert.match(watcherSource, /const triageProvider = triageProviderLabel\(triageAnswer\?\.triage_provider\);/);
  assert.equal(triageProviderLabel('vps'), 'local_detect');
  assert.equal(triageProviderLabel('local_gpu'), 'laptop_gpu');
  assert.equal(triageProviderLabel('gpu'), 'unreported', 'the retired RunPod tier has no label');
  assert.match(watcherSource, /frame\.alpr = \{ \.\.\.triageAlpr, provider: triageProvider \};/);
  assert.match(watcherSource, /frame\.face = \{ \.\.\.triageFace, provider: triageProvider \};/);
  assert.match(watcherSource, /else if \(frame\.detect\?\.alpr\?\.success\) \{\s*frame\.alpr = \{ \.\.\.frame\.detect\.alpr, provider: 'local_detect' \};/);
  // the VPS ALPR is anchored on the vehicle boxes the detector already found
  assert.match(watcherSource, /vehicle_bboxes: triageVehicleBoxes\.length \? triageVehicleBoxes : null/);
  assert.match(watcherSource, /vehicle_bboxes: localVehicleBoxes\.length \? localVehicleBoxes : null/);
});

test('watcher opens a bounded circuit after an unavailable laptop GPU batch', () => {
  assert.match(watcherSource, /const LOCAL_GPU_BACKOFF_MS = Number\.isFinite\(configuredLocalGpuBackoff\) \? Math\.max\(0, configuredLocalGpuBackoff\) : 60_000;/);
  assert.match(watcherSource, /if \(Date\.now\(\) < localGpuUnavailableUntil\) \{/);
  assert.match(watcherSource, /local_gpu_inference_circuit_open/);
  assert.match(watcherSource, /localGpuUnavailableUntil = Date\.now\(\) \+ LOCAL_GPU_BACKOFF_MS;/);
  assert.match(watcherSource, /localGpuUnavailableUntil = 0;/);
});

test('RunPod is not part of the stack (owner ruling 2026-11-01)', () => {
  assert.doesNotMatch(watcherSource, /RUNPOD_|runpod\.ai|classifyWithRunpodBatch|callRunpodEnhancement|runpod_fallback/);
  assert.doesNotMatch(watcherSource, /frame\.runpod\b/);
});

function animalFrame(seconds, bbox, species, speciesConfidence, extra = {}) {
  return {
    frame_index: Math.round(seconds * 15), relative_timestamp_seconds: seconds, sha256_hash: `a-${seconds}`, quality_state: 'clear',
    animals: { success: true, status: 'ready', animals: [{ kind: 'animal', confidence: 0.8, bbox, species, common_name: species === 'possum' ? 'Brushtail possum' : species, is_pest: species === 'possum', species_confidence: speciesConfidence, species_status: 'candidate', species_provider: 'speciesnet:test', ...extra }] },
  };
}

test('consolidateAnimals tracks one animal through frames and votes the species across the track', async () => {
  const frames = [
    animalFrame(1.0, { x: 100, y: 100, width: 60, height: 40 }, 'possum', 0.9),
    animalFrame(1.5, { x: 110, y: 102, width: 60, height: 40 }, 'possum', 0.85),
    animalFrame(2.0, { x: 120, y: 104, width: 62, height: 40 }, 'cat', 0.4),
    animalFrame(2.5, { x: 130, y: 104, width: 62, height: 42 }, 'possum', 0.88),
    // a second, distant animal 40 s later
    animalFrame(42.0, { x: 900, y: 500, width: 30, height: 20 }, 'rat', 0.7),
    // degraded frame must be ignored
    { ...animalFrame(43.0, { x: 900, y: 500, width: 30, height: 20 }, 'rat', 0.7), visual_quality: 'degraded' },
  ];
  const { events, detectionStatus } = await consolidateAnimals(frames, { maxGapSeconds: 15 });
  assert.equal(events.length, 2);
  assert.equal(events[0].species, 'possum');
  assert.equal(events[0].is_pest, true);
  assert.equal(events[0].frame_count, 4);
  assert.deepEqual(events[0].species_votes, { possum: 3, cat: 1 });
  assert.equal(events[0].first_seen_seconds, 1);
  assert.equal(events[0].last_seen_seconds, 2.5);
  assert.equal(events[1].species, 'rat');
  assert.equal(events[1].frame_count, 1, 'the degraded frame is excluded');
  assert.equal(detectionStatus, 'ready');
});

test('the review gate holds weak single-frame candidates but keeps repeated, face-backed, and high-confidence evidence', () => {
  assert.equal(isReviewableCandidate({ frame_count: 1, confidence: 0.84, quality_state: 'clear' }), false);
  assert.equal(isReviewableCandidate({ frame_count: 1, confidence: 0.85, quality_state: 'clear' }), true);
  assert.equal(isReviewableCandidate({ frame_count: 1, confidence: 0.5, quality_state: 'clear' }, { hasFaceEvidence: true }), true);
  assert.equal(isReviewableCandidate({ frame_count: 2, confidence: 0.5, quality_state: 'clear' }), true);
  assert.equal(isReviewableCandidate({ frame_count: 3, confidence: 0.99, quality_state: 'flare' }), false);
});

test('person consolidation excludes degraded and flare frames before they can create a review candidate', async () => {
  const events = await consolidatePeople([
    { frame_index: 1, relative_timestamp_seconds: 1, visual_quality: 'degraded', quality_state: 'clear', people: { success: true, people: [{ bbox: { x: 10, y: 10, width: 70, height: 180 }, confidence: 0.99 }] } },
    { frame_index: 2, relative_timestamp_seconds: 2, quality_state: 'flare', people: { success: true, people: [{ bbox: { x: 20, y: 10, width: 70, height: 180 }, confidence: 0.99 }] } },
  ]);
  assert.deepEqual(events, []);
});

async function summaryFixture() {
  const frames = [
    { frame_index: 15, relative_timestamp_seconds: 1.0, sha256_hash: 'v1', quality_state: 'clear',
      alpr: { success: true, plate: 'ABC123', confidence: 0.9, plate_bbox: { x: 10, y: 10, width: 40, height: 12 } },
      triage: { vehicle: { detection: { bbox: { x: 100, y: 100, width: 300, height: 180 }, confidence: 0.98 }, vehicle_colour: 'white', vehicle_type: 'truck', appearance_embedding: Array(256).fill(0.0625), appearance_embedding_model: 'deterministic_hsv_layout_v1', inference_provider: 'test' } },
      people: { success: true, people: [{ bbox: { x: 600, y: 150, width: 60, height: 190 }, confidence: 0.95, attributes: {
        appearance_embedding: Array(256).fill(0.0625), appearance_embedding_model: 'person-reidentification-retail-0288.xml',
        appearance_embedding_usable: true, appearance_quality_score: 0.82, upper_body_colour: 'blue',
      } }] },
      face: { success: true, faces: [{ embedding: Array(128).fill(0.088), bbox: { x: 610, y: 150, width: 30, height: 30 },
        usable_for_matching: true, face_quality_score: 0.9 }] } },
    { frame_index: 30, relative_timestamp_seconds: 2.0, sha256_hash: 'v2', quality_state: 'clear',
      alpr: { success: true, plate: 'ABC123', confidence: 0.92 },
      triage: { vehicle: { detection: { bbox: { x: 130, y: 100, width: 300, height: 180 }, confidence: 0.97 }, vehicle_colour: 'white', vehicle_type: 'truck', appearance_embedding: Array(256).fill(0.0625), appearance_embedding_model: 'deterministic_hsv_layout_v1' } },
      people: { success: true, people: [{ bbox: { x: 604, y: 151, width: 60, height: 190 }, confidence: 0.91, attributes: {
        appearance_embedding: Array(256).fill(0.0625), appearance_embedding_model: 'person-reidentification-retail-0288.xml',
        appearance_embedding_usable: true, appearance_quality_score: 0.76, upper_body_colour: 'blue',
      } }] } },
    { frame_index: 45, relative_timestamp_seconds: 3.0, sha256_hash: 'v3', quality_state: 'clear',
      triage: { vehicle: { detection: { bbox: { x: 700, y: 300, width: 200, height: 120 }, confidence: 0.7 }, vehicle_colour: 'red', appearance_embedding: Array(256).fill(0.0625), appearance_embedding_model: 'deterministic_hsv_layout_v1' } } },
    animalFrame(40.0, { x: 100, y: 500, width: 60, height: 40 }, 'possum', 0.9),
    { frame_index: 900, relative_timestamp_seconds: 60.0, sha256_hash: 'g1', quality_state: 'glitch', visual_quality: 'degraded',
      people: { success: true, people: [{ bbox: { x: 1, y: 1, width: 500, height: 500 }, confidence: 0.3 }] } },
  ];
  const summary = {
    total_frames_parsed: 1000,
    motion_segments: [
      { start_time_seconds: 0.5, end_time_seconds: 4.0, frames: frames.slice(0, 3) },
      { start_time_seconds: 38.0, end_time_seconds: 44.0, frames: [frames[3]] },
      { start_time_seconds: 59.0, end_time_seconds: 61.0, frames: [frames[4]] },
    ],
    quality_events: [{ kind: 'ir_switch', start_time_seconds: 20.0, end_time_seconds: 20.2, frame_start: 300, frame_end: 303 }],
  };
  return consolidateMotionSummary(summary, { maxGapSeconds: 15 });
}

test('buildEntityObservations emits one observation per tracked entity with absolute times, embeddings and no identity', async () => {
  const summary = await summaryFixture();
  const observations = buildEntityObservations(summary, { recordedStartAt: '2026-09-10T08:15:00.000Z' });
  const byKind = observations.reduce((counts, item) => ({ ...counts, [item.entity_kind]: (counts[item.entity_kind] || 0) + 1 }), {});
  assert.deepEqual(byKind, { vehicle: 1, person: 1, animal: 1 });

  const plated = observations.find((item) => item.candidate_plate === 'ABC123');
  assert.ok(plated, 'plated vehicle observation');
  assert.equal(plated.observed_at, '2026-09-10T08:15:01.000Z');
  assert.equal(plated.observed_to, '2026-09-10T08:15:02.000Z');
  assert.equal(plated.appearance_embedding, undefined, 'the deterministic fallback descriptor is not a cross-clip vehicle identity template');
  assert.equal(plated.attributes.appearance_embedding_usable, false);
  assert.equal(plated.attributes.colour, 'white');
  assert.equal(plated.attributes.body_type, 'truck');
  assert.equal(plated.attributes.plate_confidence, 0.92);

  assert.equal(observations.some((item) => item.entity_kind === 'vehicle' && item.candidate_label === 'red'), false, 'weak single-frame vehicle stays in the raw inference summary, not the review queue');

  const person = observations.find((item) => item.entity_kind === 'person');
  assert.equal(person.candidate_embedding.length, 128, 'the face seen during the body track rides on the person observation');
  assert.equal(person.appearance_embedding.length, 256);
  assert.equal(person.attributes.appearance_embedding_usable, true);
  assert.equal(person.attributes.appearance_template_frames, 2);
  assert.equal(person.attributes.upper_body_colour, 'blue');
  assert.equal(person.attributes.face_event_id, summary.consolidated_events.face_events[0].event_id);

  const animal = observations.find((item) => item.entity_kind === 'animal');
  assert.equal(animal.animal_type, 'possum');
  assert.equal(animal.is_pest, true);
  assert.equal(animal.species_confidence, 0.9);
  assert.equal(animal.observed_at, '2026-09-10T08:15:40.000Z');

  for (const item of observations) {
    assert.ok(!('canonical_vehicle_id' in item) && !('canonical_person_id' in item) && !('person_record_id' in item), 'the worker never asserts identity');
    assert.ok(['clear', 'glitch', 'flare', 'ir_switch', 'degraded', 'occluded'].includes(item.quality_state));
    assert.equal(item.quality_state, 'clear', 'entities whose best frame is a glitch are not emitted');
  }
});

test('buildEntityObservations returns nothing without a time base and uses captured_at as the fallback', async () => {
  const summary = await summaryFixture();
  assert.deepEqual(buildEntityObservations(summary, {}), []);
  const fallback = buildEntityObservations(summary, { capturedAt: '2026-09-10T09:00:00.000Z' });
  assert.equal(fallback.find((item) => item.candidate_plate === 'ABC123').observed_at, '2026-09-10T09:00:01.000Z');
});

test('body-only detection remains place activity and is not persisted as a person observation', () => {
  const summary = {
    consolidated_events: {
      vehicle_events: [],
      person_events: [{ event_id: 'person-body-only', first_seen_seconds: 1, last_seen_seconds: 4, frame_count: 12, confidence: 0.98, quality_state: 'clear', best_frame_hash: 'body-frame', best_bbox: { x: 1, y: 1, width: 50, height: 170 } }],
      face_events: [],
      animal_events: [],
    },
    motion_segments: [{ start_time_seconds: 0, end_time_seconds: 5, frames: [] }],
  };
  assert.deepEqual(buildEntityObservations(summary, { recordedStartAt: '2026-09-10T08:15:00.000Z' }), []);
  const marks = buildInferenceDeviceEvents(summary, { recordedStartAt: '2026-09-10T08:15:00.000Z' });
  assert.deepEqual(marks.find((mark) => mark.metadata.kind === 'motion_window')?.metadata.entity_counts, { person: 1 });
});

test('buildInferenceDeviceEvents grades each motion window and marks camera disturbances', async () => {
  const summary = await summaryFixture();
  const marks = buildInferenceDeviceEvents(summary, { recordedStartAt: '2026-09-10T08:15:00.000Z' });
  const windows = marks.filter((mark) => mark.metadata.kind === 'motion_window');
  assert.equal(windows.length, 3);
  assert.equal(windows[0].severity, 'alert', 'a plated vehicle is an alert');
  assert.equal(windows[0].event_start_at, '2026-09-10T08:15:00.500Z');
  assert.deepEqual(windows[0].metadata.entity_counts, { vehicle: 1, person: 1 });
  assert.equal(windows[0].metadata.suppressed_review_candidate_count, 1);
  assert.equal(windows[1].severity, 'alert', 'a pest animal is an alert');
  assert.equal(windows[2].severity, 'motion', 'a window with only a glitch frame is motion only');
  const quality = marks.find((mark) => mark.metadata.kind === 'quality_event');
  assert.equal(quality.metadata.quality_kind, 'ir_switch');
  assert.equal(quality.source_ref, 'quality-ir_switch-300');
  assert.ok(marks.every((mark) => mark.source === 'inference' && ['motion', 'detection', 'alert'].includes(mark.severity)));
});

test('watcher records observations and timeline marks through the P2 RPCs before completing the job', () => {
  assert.match(watcherSource, /supabase\.rpc\('record_cctv_entity_observations', \{\s*p_job_id: job\.id,\s*p_evidence_id: job\.evidence_item_id,\s*p_organization_id: job\.organization_id,\s*p_observations: observations,/);
  assert.match(watcherSource, /supabase\.rpc\('record_cctv_device_events', \{ p_import_id: evidence\.cctv_import_id, p_events: marks \}\)/);
  const persistIndex = watcherSource.indexOf('await recordEntityObservations(job, evidence, summary);');
  const ingestIndex = watcherSource.indexOf('await ingest(job, summary);');
  assert.ok(persistIndex > 0 && persistIndex < ingestIndex, 'observations are written while the job is still processing');
  assert.match(watcherSource, /select\('id, organization_id, evidence_kind, storage_path, metadata, captured_at, cctv_import_id, locked_at, sha256_hash'\)/);
  assert.match(watcherSource, /recordedStartAt: evidence\.metadata\?\.recorded_start_at \|\| null, capturedAt: evidence\.captured_at \|\| null/);
  assert.match(watcherSource, /supabase\.rpc\('coalesce_cctv_stationary_vehicle_observations', \{ p_job_id: job\.id \}\)/);
  assert.match(watcherSource, /stationary_vehicle_sources_coalesced: coalesced/);
  const recordIndex = watcherSource.indexOf('await recordEntityObservations(job, evidence, summary);');
  const derivativeIndex = watcherSource.indexOf('await buildObservationDerivatives(job, evidence, summary);');
  assert.ok(recordIndex > 0 && derivativeIndex > recordIndex, 'derivatives are built only after observation rows exist');
  assert.match(watcherSource, /supabase\.rpc\('record_cctv_observation_derivatives'/);
  assert.match(watcherSource, /supabase\.rpc\('record_cctv_alpr_perception_envelopes', \{ p_job_id: job\.id \}\)/);
  assert.match(watcherSource, /supabase\.rpc\('record_cctv_person_perception_envelopes', \{ p_job_id: job\.id \}\)/);
  assert.match(watcherSource, /supabase\.rpc\('record_cctv_vehicle_attribute_perception_envelopes', \{ p_job_id: job\.id \}\)/);
  const sharedEvidenceIndex = watcherSource.indexOf('await recordSharedAlprEvidence(job);', derivativeIndex);
  assert.ok(sharedEvidenceIndex > derivativeIndex, 'the shared ALPR receipt is compiled after derivative evidence is stored');
  const sharedPersonEvidenceIndex = watcherSource.indexOf('await recordSharedPersonEvidence(job);', sharedEvidenceIndex);
  assert.ok(sharedPersonEvidenceIndex > sharedEvidenceIndex, 'the shared person receipt is compiled after derivative and ALPR receipts');
  const sharedVehicleEvidenceIndex = watcherSource.indexOf('await recordSharedVehicleAttributeEvidence(job);', sharedPersonEvidenceIndex);
  assert.ok(sharedVehicleEvidenceIndex > sharedPersonEvidenceIndex, 'the shared vehicle attribute receipt is compiled after derivative, ALPR and person receipts');
  assert.match(watcherSource, /attribute_confidence: confidence\(attributes\.vehicle_attribute_confidence\)/);
  assert.match(watcherSource, /vehicle_attribute_model: attributes\.vehicle_model_name/);
  assert.match(watcherSource, /callLaptopEnhancement\(fusedBytes/);
  assert.match(watcherSource, /select\('source_event_id'\).*?\.neq\('review_state', 'superseded'\)/);
  assert.match(watcherSource, /VISION_MAX_OBSERVATION_DERIVATIVES \|\| 8/);
  assert.match(watcherSource, /gpuDerivatives\.reduce\(\(total, derivative\)/);
});

test('ingestion sends event summaries and window counts, not per-frame worker scratch data', () => {
  const input = {
    total_frames_parsed: 10,
    motion_segments: [{ start_time_seconds: 1, end_time_seconds: 3, frames: [{ sha256_hash: 'a', file_path: '/tmp/a.jpg' }, { sha256_hash: 'b' }] }],
    consolidated_events: { vehicle_events: [{ event_id: 'v1', best_frame_hash: 'a' }] },
  };
  const compact = compactMotionSummaryForIngestion(input);
  assert.deepEqual(compact.motion_segments, [{ start_time_seconds: 1, end_time_seconds: 3, frame_count: 2 }]);
  assert.deepEqual(compact.consolidated_events, input.consolidated_events);
  assert.equal(input.motion_segments[0].frames.length, 2, 'compaction does not mutate the in-memory result used by other worker steps');
  assert.match(watcherSource, /motion_summary: compactMotionSummaryForIngestion\(summary\)/);
});

test('watcher records the source file hash once, before playback conversion, and verifies it on every later pass', () => {
  assert.match(watcherSource, /supabase\.rpc\('record_cctv_source_hash', \{ p_evidence_id: evidence\.id, p_sha256: sha256, p_size_bytes: size \}\)/);
  // First pass only records when nothing is recorded and the row is not sealed; otherwise the bytes are verified.
  assert.match(watcherSource, /if \(!recorded && !evidence\.locked_at\) \{/);
  assert.match(watcherSource, /supabase\.rpc\('record_cctv_integrity_check', \{\s*p_evidence_id: evidence\.id, p_sha256_observed: sha256, p_size_bytes: size, p_checked_by: 'vision_worker',\s*\}\)/);
  assert.match(watcherSource, /log\(state === 'verified' \? 'source_integrity_verified' : 'source_integrity_finding'/);
  const hashIndex = watcherSource.indexOf('await recordSourceHash(job, evidence, videoPath);');
  const playbackIndex = watcherSource.indexOf('await ensurePlaybackCopy(job, evidence, videoPath);');
  assert.ok(hashIndex > 0 && hashIndex < playbackIndex, 'the source is hashed before any derivative is made');
});

test('watcher merges playback metadata through the governed RPC instead of replacing the document from a stale read', () => {
  assert.match(watcherSource, /supabase\.rpc\('set_cctv_playback_copy', \{\s*p_evidence_id: evidence\.id,\s*p_playback: \{/);
  assert.doesNotMatch(watcherSource, /from\('evidence_items'\)\s*\.update\(\{ metadata: \{\s*\.\.\.\(evidence\.metadata/);
  assert.doesNotMatch(watcherSource, /from\('evidence_items'\)\s*\.update\(/, 'the worker never writes evidence_items directly');
});

test('the VPS detector answer takes the shape of a GPU answer, with its own provenance', () => {
  const detect = {
    success: true, review_required: true, detector_status: 'ready', detector_provider: 'CPUExecutionProvider', detector_model: 'rf-detr-small-512-coco',
    detector_coverage: ['person', 'vehicle', 'animal'], species_status: 'ready',
    people: [{ bbox: { x: 10, y: 20, width: 100, height: 300 }, confidence: 0.91 }], people_provider: 'rf-detr-small-512-coco',
    vehicles: [{ bbox: { x: 1, y: 2, width: 50, height: 40 }, confidence: 0.8, attributes: { colour: 'red', detection: { bbox: { x: 1, y: 2, width: 50, height: 40 }, confidence: 0.8 } } }],
    animals: [], alpr: { success: true, plate: 'ABC123', confidence: 0.9 },
  };
  const answer = localTriageResult(detect);
  assert.equal(answer.triage_provider, 'vps');
  assert.equal(answer.people.length, 1);
  assert.equal(answer.people_provider, 'rf-detr-small-512-coco');
  assert.deepEqual(answer.vehicle, detect.vehicles[0].attributes, 'the first vehicle attributes sit under `vehicle`, as the GPU answer does');
  assert.equal(answer.animal_detection_status, 'ready');
  assert.equal(answer.alpr.plate, 'ABC123');
  assert.equal(localTriageResult({ ...detect, detector_coverage: ['person', 'vehicle'], species_status: 'model_not_staged' }).animal_detection_status, 'model_not_staged');
  assert.equal(localTriageResult({ ...detect, species_status: 'model_not_staged' }).animal_detection_status, 'detector_only_species_not_staged');
  assert.equal(localTriageResult({ success: false, error: '/infer/detect_unavailable' }), null, 'no answer is not an answer');
  assert.equal(localTriageResult(null), null);
});

test('inference runs on one GPU detector model by default: the laptop GPU only, never the VPS or RunPod', () => {
  assert.equal(INFERENCE_POLICY, 'gpu_consistent');
  assert.deepEqual(triageOrderFor('gpu_consistent'), ['local_gpu']);
  assert.deepEqual(triageOrderFor('local_gpu_first'), ['local_gpu', 'vps']);
  assert.deepEqual(triageOrderFor('vps_first'), ['vps']);
  assert.deepEqual(triageOrderFor('vps_only'), ['vps']);
  assert.deepEqual(triageOrderFor(undefined), ['vps']);
  for (const policy of ['gpu_consistent', 'local_gpu_first', 'vps_first', 'vps_only']) {
    assert.ok(!triageOrderFor(policy).includes('gpu'), `${policy} never asks the retired RunPod tier`);
  }
  // Recognition follows the same policy and the same model pin.
  assert.match(watcherSource, /const gpuResults = await recognitionAnswers\(pendingBatch, usage, pin\);/);
  assert.match(watcherSource, /const needLocalDetect = !triageAnswer && LOCAL_DETECT_INFERENCE && INFERENCE_POLICY !== 'gpu_consistent';/);
});

test('observation derivative candidates are bounded, quality-ranked and stored under the evidence identity', () => {
  const summary = { motion_segments: [{ frames: Array.from({ length: 20 }, (_, index) => ({ file_path: `/tmp/${index}.jpg`, sha256_hash: `h${index}`, frame_index: index, relative_timestamp_seconds: index / 2, sharpness_score: index, quality_state: 'clear', triage: { vehicles: [{ bbox: { x: 10 + index, y: 10, width: 80, height: 40 } }] } })) }] };
  const candidates = candidateFramesForEvent(summary, { first_seen_seconds: 1, last_seen_seconds: 8, best_bbox: { x: 12, y: 10, width: 80, height: 40 } }, 'vehicle');
  assert.equal(candidates.length, 12);
  assert.ok(candidates[0].sharpness_score > candidates.at(-1).sharpness_score);
  assert.deepEqual(enhancementProviderOrder(), ['laptop_gpu', 'worker_deterministic']);
  assert.deepEqual(derivativeStoragePaths({ id: 'e1', organization_id: 'o1', metadata: { storage_bucket: 'private' } }, 'vehicle/ABC 123'), { bucket: 'private', original: 'org/o1/cctv-derivatives/e1/vehicle-ABC-123/original.jpg', enhanced: 'org/o1/cctv-derivatives/e1/vehicle-ABC-123/enhanced.jpg' });
});

test('source and enhanced recognition stay separate and require human review', () => {
  const comparison = recognitionComparison({ alpr: { success: true, plate: 'ABC123', confidence: .82 }, faces: [{}], animals: [] }, { alpr: { success: true, plate: 'ABC123', confidence: .94 }, faces: [{}, {}], animals: [{}] });
  assert.equal(comparison.alpr.agreement, true);
  assert.equal(comparison.alpr.source.confidence, .82);
  assert.equal(comparison.alpr.enhanced.confidence, .94);
  assert.equal(comparison.source_face_count, 1);
  assert.equal(comparison.enhanced_face_count, 2);
  assert.equal(comparison.authority, 'provisional_human_review_required');
});

test('coverage counts the frames nobody answered, and the watcher defers instead of completing on a gap', () => {
  const answered = { detect: { success: true }, triage: { triage_provider: 'vps' } };
  const gpuAnswered = { detect: { success: true }, triage: { triage_provider: 'local_gpu' } };
  const unlabelled = { detect: { success: true } };
  const coverage = triageCoverage([answered, answered, gpuAnswered, unlabelled, {}, { detect: { success: false } }]);
  assert.deepEqual(coverage, { frames_selected: 6, frames_triaged: 4, frames_untriaged: 2, triage_providers: { vps: 2, local_gpu: 1, unreported: 1 } });
  assert.deepEqual(triageCoverage([]), { frames_selected: 0, frames_triaged: 0, frames_untriaged: 0, triage_providers: {} });
  // The 2026-09-20 incident: the (since retired) RunPod tier timed out once, the circuit breaker skipped 19 batches, and the job completed
  // as "no sightings" for 114 unexamined frames. A coverage gap now defers the job through the governed RPC.
  assert.match(watcherSource, /if \(coverage\?\.frames_untriaged > 0\) \{[\s\S]*?supabase\.rpc\('defer_cctv_inference_job'/);
  assert.match(watcherSource, /const unanswered = frameInputs\.filter\(\(\{ frame \}\) => !frame\.detect\);/, 'unanswered frames get one more pass before the gate');
});
