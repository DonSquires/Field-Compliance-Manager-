const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createClient } = require('@supabase/supabase-js');
const { signJobToken } = require('./local_jwt_signer');
const { consolidateMotionSummary, buildEntityObservations, buildInferenceDeviceEvents } = require('./motion_consolidator');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const INGESTION_URL = (process.env.VISION_INGESTION_URL || '').replace(/\/+$/, '');
const WORKLOAD_SIGNING_SECRET = process.env.WORKLOAD_SIGNING_SECRET || '';
const INFERENCE_SERVICE_URL = (process.env.INFERENCE_SERVICE_URL || 'http://fcm-inference:3000').replace(/\/+$/, '');
const INFERENCE_API_KEY = process.env.INFERENCE_API_KEY || '';
const RUNPOD_API_URL = (process.env.RUNPOD_API_URL || 'https://api.runpod.ai/v2/katqqnmds1dphs').replace(/\/+$/, '');
const RUNPOD_API_KEY = process.env.RUNPOD_API || process.env.RUNPOD_API_KEY || '';
const RUNPOD_CAPTURE_API_URL = (process.env.RUNPOD_CAPTURE_API_URL || '').replace(/\/+$/, '');
const RUNPOD_CAPTURE_API_KEY = process.env.RUNPOD_CAPTURE_API_KEY || RUNPOD_API_KEY;
const VIDEO_ROOT = path.resolve(process.env.VISION_VIDEO_ROOT || '/opt/fcm/storage');
const DERIVED_ROOT = path.resolve(process.env.VISION_DERIVED_ROOT || '/opt/fcm/derived');
const VIDEO_CACHE_ROOT = path.resolve(process.env.VISION_VIDEO_CACHE_ROOT || path.join(DERIVED_ROOT, 'source-cache'));
const EXTRACTOR_PATH = path.resolve(
  process.env.VISION_EXTRACTOR_PATH || path.join(__dirname, 'video_motion_extractor.py')
);
const POLL_INTERVAL_MS = Number(process.env.VISION_POLL_INTERVAL_MS || 5000);
const WORKER_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.VISION_WORKER_CONCURRENCY || 1)));
const EXTRACTOR_TIMEOUT_MS = Number(process.env.VISION_EXTRACTOR_TIMEOUT_MS || 30 * 60 * 1000);
const MAX_SUMMARY_BYTES = Number(process.env.VISION_MAX_SUMMARY_BYTES || 2 * 1024 * 1024);
const MAX_CLASSIFICATION_FRAMES = Number(process.env.VISION_MAX_CLASSIFICATION_FRAMES || 120);
const RUNPOD_BATCH_SIZE = Number(process.env.VISION_RUNPOD_BATCH_SIZE || 6);
const configuredRunpodBackoff = Number(process.env.VISION_RUNPOD_BACKOFF_MS);
const RUNPOD_BACKOFF_MS = Number.isFinite(configuredRunpodBackoff) ? Math.max(0, configuredRunpodBackoff) : 5 * 60_000;
const STORAGE_DOWNLOAD_TIMEOUT_MS = Number(process.env.VISION_STORAGE_DOWNLOAD_TIMEOUT_MS || 120_000);
const LOCAL_VEHICLE_INFERENCE = process.env.VISION_LOCAL_VEHICLE_INFERENCE !== 'false';
const LOCAL_PEOPLE_INFERENCE = process.env.VISION_LOCAL_PEOPLE_INFERENCE !== 'false';
// /infer/detect on the VPS (person + vehicle + animal triage in one call) when RunPod returned nothing for a frame.
const LOCAL_DETECT_INFERENCE = process.env.VISION_LOCAL_DETECT_INFERENCE !== 'false';
let runpodUnavailableUntil = 0;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

function log(event, fields = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
}

function safeVideoPath(storagePath) {
  if (typeof storagePath !== 'string' || !storagePath.trim()) throw new Error('evidence storage_path is missing');
  const candidate = path.resolve(VIDEO_ROOT, storagePath.replace(/^\/+/, ''));
  if (candidate !== VIDEO_ROOT && !candidate.startsWith(`${VIDEO_ROOT}${path.sep}`)) {
    throw new Error('evidence storage_path escapes VISION_VIDEO_ROOT');
  }
  return candidate;
}

function safeCacheVideoPath(storagePath) {
  if (typeof storagePath !== 'string' || !storagePath.trim()) throw new Error('evidence storage_path is missing');
  const candidate = path.resolve(VIDEO_CACHE_ROOT, storagePath.replace(/^\/+/, ''));
  if (candidate !== VIDEO_CACHE_ROOT && !candidate.startsWith(`${VIDEO_CACHE_ROOT}${path.sep}`)) {
    throw new Error('evidence storage_path escapes VISION_VIDEO_CACHE_ROOT');
  }
  return candidate;
}

function classificationCheckpointPath(jobId) {
  return path.join(DERIVED_ROOT, jobId, 'classification-progress.json');
}

async function readClassificationCheckpoint(jobId) {
  try {
    const value = JSON.parse(await fs.readFile(classificationCheckpointPath(jobId), 'utf8'));
    return value && typeof value.frames === 'object' ? value.frames : {};
  } catch (error) {
    if (error?.code !== 'ENOENT') log('classification_checkpoint_unreadable', { job_id: jobId, error: error.message });
    return {};
  }
}

async function writeClassificationCheckpoint(jobId, frames) {
  const checkpointPath = classificationCheckpointPath(jobId);
  const temporaryPath = `${checkpointPath}.tmp`;
  await fs.mkdir(path.dirname(checkpointPath), { recursive: true });
  await fs.writeFile(temporaryPath, JSON.stringify({ version: 1, frames }), { mode: 0o600 });
  await fs.rename(temporaryPath, checkpointPath);
}

function cameraKeyFromEvidence(evidence) {
  const metadata = evidence.metadata || {};
  const explicit = metadata.camera_key || metadata.camera_id || metadata.channel;
  if (explicit) return String(explicit);
  const source = String(evidence.storage_path || '').replace(/^[^/]+\//, '').replace(/\/[^/]+$/, '');
  return source || evidence.id;
}

function sceneFingerprint(summary) {
  const frames = summary.motion_segments.flatMap((segment) => segment.frames || []);
  const sample = frames.slice(0, 12).map((frame) => frame.sha256_hash).filter(Boolean);
  return {
    source_filename: summary.source_filename || null,
    codec_fourcc: summary.codec_fourcc || null,
    frame_width: summary.frame_width || null,
    frame_height: summary.frame_height || null,
    duration_seconds: summary.total_duration || null,
    sample_frame_hashes: sample,
  };
}

async function recordSceneMemory(job, evidence, summary) {
  const metadata = evidence.metadata || {};
  const { error } = await supabase.rpc('record_cctv_scene_observation', {
    p_organization_id: job.organization_id,
    p_evidence_id: job.evidence_item_id,
    p_inference_job_id: job.id,
    p_camera_key: cameraKeyFromEvidence(evidence),
    p_scene_fingerprint: sceneFingerprint(summary),
    p_location_id: metadata.location_id || null,
    p_site_id: metadata.site_id || null,
    p_zone_id: metadata.zone_id || null,
  });
  if (error) log('scene_memory_record_failed', { job_id: job.id, error: error.message });
}

async function ensureVideoPath(evidence) {
  const sourcePath = safeVideoPath(evidence.storage_path);
  try {
    await fs.access(sourcePath);
    return sourcePath;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const cachedPath = safeCacheVideoPath(evidence.storage_path);
  try {
    await fs.access(cachedPath);
    return cachedPath;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const bucket = evidence.metadata?.storage_bucket || 'bob-uploads';
  const download = supabase.storage.from(bucket).download(evidence.storage_path);
  const { data, error } = await Promise.race([
    download,
    new Promise((_, reject) => setTimeout(() => reject(new Error('video download timed out')), STORAGE_DOWNLOAD_TIMEOUT_MS)),
  ]);
  if (error) throw new Error(`video download failed from ${bucket}: ${error.message}`);

  await fs.mkdir(path.dirname(cachedPath), { recursive: true });
  const bytes = Buffer.from(await data.arrayBuffer());
  await fs.writeFile(cachedPath, bytes, { flag: 'wx' }).catch(async (error) => {
    if (error?.code !== 'EEXIST') throw error;
    await fs.access(cachedPath);
  });
  log('video_cached', { evidence_item_id: evidence.id, bucket, storage_path: evidence.storage_path, bytes: bytes.length });
  return cachedPath;
}

async function claimJob(job) {
  const { data, error } = await supabase.rpc('claim_cctv_inference_job', {
    p_job_id: job.id,
    p_lease_token: crypto.randomUUID(),
    p_lease_seconds: Math.ceil(EXTRACTOR_TIMEOUT_MS / 1000) + 900,
  });
  if (error) throw new Error(`job claim failed: ${error.message}`);
  return Array.isArray(data) ? data[0] ?? null : data;
}

async function heartbeatJob(job, stage) {
  if (!job?.lease_token) return;
  const { data, error } = await supabase.rpc('heartbeat_cctv_inference_job', {
    p_job_id: job.id,
    p_lease_token: job.lease_token,
    p_stage: stage,
    p_lease_seconds: Math.ceil(EXTRACTOR_TIMEOUT_MS / 1000) + 900,
  });
  if (error) throw new Error(`job heartbeat failed: ${error.message}`);
  if (data !== true) throw new Error('CCTV job lease was lost');
}

async function updateProgress(job, stage, progress = {}) {
  await heartbeatJob(job, stage);
  const { error } = await supabase.from('inference_jobs').update({
    stage,
    progress_percent: Math.max(0, Math.min(100, Math.round(Number(progress.percent) || 0))),
    progress_current: Math.max(0, Math.round(Number(progress.current) || 0)),
    progress_total: Math.max(0, Math.round(Number(progress.total) || 0)),
    progress_label: progress.label || null,
  }).eq('id', job.id).eq('status', 'processing').eq('lease_token', job.lease_token);
  if (error) throw new Error(`job progress update failed: ${error.message}`);
}

function runExtractor(videoPath, outputDir) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [EXTRACTOR_PATH, videoPath, '--output-dir', outputDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' }
    });
    let output = '';
    let errorOutput = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      reject(new Error('motion extractor timed out'));
    }, EXTRACTOR_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (Buffer.byteLength(output) > MAX_SUMMARY_BYTES) child.kill('SIGTERM');
    });
    child.stderr.on('data', (chunk) => { errorOutput += chunk.toString().slice(-4000); });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) return reject(new Error(`motion extractor exited ${code}: ${errorOutput || 'unknown error'}`));
      if (Buffer.byteLength(output) > MAX_SUMMARY_BYTES) return reject(new Error('motion summary exceeds configured limit'));
      try {
        const summary = JSON.parse(output);
        if (!summary || !Array.isArray(summary.motion_segments) || !Number.isInteger(summary.total_frames_parsed)) {
          throw new Error('invalid motion summary schema');
        }
        resolve(summary);
      } catch (error) {
        reject(new Error(`motion extractor returned invalid JSON: ${error.message}`));
      }
    });
  });
}

async function ingest(job, summary) {
  if (!INGESTION_URL || !WORKLOAD_SIGNING_SECRET) throw new Error('VISION_INGESTION_URL and WORKLOAD_SIGNING_SECRET are required');
  const token = signJobToken({
    inference_job_id: job.id,
    evidence_item_id: job.evidence_item_id,
    organization_id: job.organization_id,
    jti: require('node:crypto').randomUUID(),
    exp: Math.floor(Date.now() / 1000) + 15 * 60
  }, WORKLOAD_SIGNING_SECRET);
  const response = await fetch(INGESTION_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      inference_job_id: job.id,
      evidence_item_id: job.evidence_item_id,
      organization_id: job.organization_id,
      motion_summary: summary
    }),
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1000);
    throw new Error(`motion ingestion returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }
}

// Spreads the classification budget fairly across every motion segment (vehicle/person event),
// and samples each segment's frames evenly across its full range instead of only the earliest
// ones. The earliest frames of a padded motion window are frequently just the pre-roll moment a
// vehicle's edge first crosses the motion threshold, before it is fully in frame.
function selectFramesForClassification(segments, maxFrames) {
  const segmentFrameLists = segments.map((segment) => segment.frames || []).filter((frames) => frames.length > 0);
  if (segmentFrameLists.length === 0 || maxFrames <= 0) return [];
  const perSegmentBudget = Math.max(1, Math.floor(maxFrames / segmentFrameLists.length));
  const selected = [];
  for (const frames of segmentFrameLists) {
    const budget = Math.min(perSegmentBudget, frames.length, maxFrames - selected.length);
    if (budget <= 0) break;
    for (let index = 0; index < budget; index += 1) {
      const position = budget === 1 ? Math.floor((frames.length - 1) / 2) : Math.round((index * (frames.length - 1)) / (budget - 1));
      selected.push(frames[position]);
    }
  }
  return selected;
}

function applyTriageResult(frame, result) {
  frame.runpod = result;
  frame.detect = result;
  frame.people = Array.isArray(result?.people)
    ? { success: true, people: result.people, provider: result.people_provider || result.detector_provider || 'runpod' }
    : { success: false, people: [], error: 'person_detector_unavailable' };
  frame.animals = normaliseAnimals(result, null);
  const vehicle = result?.vehicle || null;
  frame.inference = vehicle
    ? { success: true, data: vehicle, provider: 'runpod_triage' }
    : { success: false, error: 'no_vehicle_detected', review_required: false };
}

function representativeFrameHashes(summary) {
  const events = summary.consolidated_events || {};
  const hashes = [
    ...(events.vehicle_events || []),
    ...(events.person_events || []),
    ...(events.animal_events || []),
    ...(events.face_events || []),
  ].map((event) => event.best_frame_hash).filter(Boolean);
  return [...new Set(hashes)];
}

async function classifyFrames(summary, job) {
  if (!INFERENCE_API_KEY) throw new Error('INFERENCE_API_KEY is required for frame classification');
  const totalFrames = summary.motion_segments.reduce((total, segment) => total + (segment.frames?.length || 0), 0);
  const selectedFrames = selectFramesForClassification(summary.motion_segments, MAX_CLASSIFICATION_FRAMES);
  const triageBatches = Math.ceil(selectedFrames.length / RUNPOD_BATCH_SIZE);
  const checkpointFrames = await readClassificationCheckpoint(job.id);
  const frameInputs = await Promise.all(selectedFrames.map(async (frame) => ({
    frame,
    image: await fs.readFile(frame.file_path),
  })));
  for (let batchStart = 0; batchStart < frameInputs.length; batchStart += RUNPOD_BATCH_SIZE) {
    const batch = frameInputs.slice(batchStart, batchStart + RUNPOD_BATCH_SIZE);
    const batchNumber = Math.floor(batchStart / RUNPOD_BATCH_SIZE) + 1;
    const pendingBatch = batch.filter(({ frame }) => !checkpointFrames[frame.sha256_hash]?.triage);
    await updateProgress(job, 'running_inference', {
      current: batchStart,
      total: selectedFrames.length,
      percent: (batchStart / Math.max(1, selectedFrames.length)) * 100,
      label: pendingBatch.length ? `Detecting motion entities, batch ${batchNumber} of ${triageBatches}` : `Resuming detection batch ${batchNumber} of ${triageBatches}`,
    });
    const runpodResults = await classifyWithRunpodBatch(pendingBatch, ['person', 'vehicle', 'animal', 'detect']);
    for (const { frame } of batch) {
      const checkpoint = checkpointFrames[frame.sha256_hash];
      if (checkpoint?.triage) applyTriageResult(frame, checkpoint.triage);
      else {
        const triage = runpodResults.get(frame.sha256_hash);
        if (triage) {
          applyTriageResult(frame, triage);
          checkpointFrames[frame.sha256_hash] = { ...(checkpoint || {}), triage };
        }
      }
    }
    await writeClassificationCheckpoint(job.id, checkpointFrames);
  }

  await consolidateMotionSummary(summary, { metersPerPixel: Number(process.env.VISION_METERS_PER_PIXEL) || null });
  const representativeHashes = new Set(representativeFrameHashes(summary));
  const representatives = frameInputs.filter(({ frame }) => representativeHashes.has(frame.sha256_hash));
  const recognitionBatches = Math.ceil(representatives.length / RUNPOD_BATCH_SIZE);
  for (let batchStart = 0; batchStart < representatives.length; batchStart += RUNPOD_BATCH_SIZE) {
    const batch = representatives.slice(batchStart, batchStart + RUNPOD_BATCH_SIZE);
    const batchNumber = Math.floor(batchStart / RUNPOD_BATCH_SIZE) + 1;
    const pendingBatch = batch.filter(({ frame }) => !checkpointFrames[frame.sha256_hash]?.recognition);
    await updateProgress(job, 'running_inference', {
      current: batchStart,
      total: representatives.length,
      percent: (batchStart / Math.max(1, representatives.length)) * 100,
      label: pendingBatch.length ? `Recognising ${representatives.length} best observation frame${representatives.length === 1 ? '' : 's'}, batch ${batchNumber} of ${recognitionBatches}` : `Resuming recognition batch ${batchNumber} of ${recognitionBatches}`,
    });
    const runpodResults = await classifyWithRunpodBatch(pendingBatch);
    for (const { frame, image } of batch) {
      const checkpoint = checkpointFrames[frame.sha256_hash];
      if (checkpoint?.recognition) {
        Object.assign(frame, checkpoint.recognition);
        continue;
      }
      const runpodResult = runpodResults.get(frame.sha256_hash);
      if (!runpodResult) continue;
      const recognition = await enrichRepresentativeFrame(frame, image, job, runpodResult);
      Object.assign(frame, recognition);
      checkpointFrames[frame.sha256_hash] = { ...(checkpoint || {}), recognition };
    }
    await writeClassificationCheckpoint(job.id, checkpointFrames);
  }
  if (totalFrames > selectedFrames.length) summary.classification_truncated = true;
  summary.classification_plan = {
    sampled_frames: selectedFrames.length,
    representative_frames: representatives.length,
    policy: 'detector_triage_then_one_full_recognition_per_unique_observation',
  };
  return summary;
}

async function enrichRepresentativeFrame(frame, image, job, runpodResult) {
      if (frame.visual_quality === 'degraded') {
        frame.inference_quality = {
          state: 'degraded',
          reason: frame.visual_quality_reason || 'visual_quality_gate',
          human_review_required: true,
        };
      }
      const buildForm = (vehicleBbox = null, extraFields = null) => {
        const form = new FormData();
        form.append('photo', new Blob([image], { type: 'image/jpeg' }), `${frame.sha256_hash}.jpg`);
        if (vehicleBbox) form.append('vehicle_bbox', JSON.stringify(vehicleBbox));
        for (const [key, value] of Object.entries(extraFields || {})) {
          if (value !== null && value !== undefined) form.append(key, typeof value === 'string' ? value : JSON.stringify(value));
        }
        return form;
      };
      const headers = { Authorization: `Bearer ${INFERENCE_API_KEY}` };
      if (runpodResult) frame.runpod = runpodResult;
      // GPU first: infer_batch now carries ALPR (plate detector + OCR anchored on the detected vehicles) and
      // faces alongside the triage. The VPS is asked only for what the GPU answer lacks.
      const runpodAlpr = runpodResult?.alpr?.success ? runpodResult.alpr : null;
      const runpodFace = runpodResult?.face?.success && Array.isArray(runpodResult.face.faces) ? runpodResult.face : null;
      const runpodVehicleBoxes = Array.isArray(runpodResult?.vehicles)
        ? runpodResult.vehicles.map((vehicle) => vehicle?.bbox || vehicle?.attributes?.detection?.bbox).filter(Boolean)
        : [];
      const needLocalDetect = !runpodResult && LOCAL_DETECT_INFERENCE;
      // Detector triage: RunPod first; the VPS /infer/detect route (people + vehicles + animals + ALPR in one
      // call) when the batch had no GPU answer. /infer/people alone is only needed when RunPod answered without people.
      const localRequests = [
        runpodAlpr || needLocalDetect
          ? Promise.resolve(null)
          : fetch(`${INFERENCE_SERVICE_URL}/infer/alpr`, { method: 'POST', headers, body: buildForm(null, { vehicle_bboxes: runpodVehicleBoxes.length ? runpodVehicleBoxes : null }), signal: AbortSignal.timeout(30_000) }),
        runpodFace
          ? Promise.resolve(null)
          : fetch(`${INFERENCE_SERVICE_URL}/infer/face`, { method: 'POST', headers, body: buildForm(), signal: AbortSignal.timeout(30_000) }),
        LOCAL_PEOPLE_INFERENCE && runpodResult && !Array.isArray(runpodResult.people)
          ? fetch(`${INFERENCE_SERVICE_URL}/infer/people`, { method: 'POST', headers, body: buildForm(), signal: AbortSignal.timeout(30_000) })
          : Promise.resolve(null),
        needLocalDetect ? classifyLocally(INFERENCE_SERVICE_URL, '/infer/detect', headers, buildForm) : Promise.resolve(null),
      ];
      const [alprResponse, faceResponse, peopleResponse, localDetect] = await Promise.all(localRequests);
      if (localDetect) frame.detect = localDetect;
      if (runpodAlpr) {
        frame.alpr = { ...runpodAlpr, provider: 'runpod' };
      } else if (frame.detect?.alpr?.success) {
        frame.alpr = { ...frame.detect.alpr, provider: 'local_detect' };
      } else if (alprResponse) {
        frame.alpr = alprResponse.ok ? await alprResponse.json() : { success: false, error: `alpr_http_${alprResponse.status}` };
      } else {
        // /infer/detect ran without a staged ALPR tier: ask the VPS ALPR route with the boxes it found.
        const localVehicleBoxes = Array.isArray(frame.detect?.vehicles) ? frame.detect.vehicles.map((vehicle) => vehicle?.bbox).filter(Boolean) : [];
        frame.alpr = await classifyLocally(INFERENCE_SERVICE_URL, '/infer/alpr', headers, () => buildForm(null, { vehicle_bboxes: localVehicleBoxes.length ? localVehicleBoxes : null }));
      }
      if (runpodFace) {
        frame.face = { ...runpodFace, provider: 'runpod' };
      } else if (faceResponse) {
        frame.face = faceResponse.ok ? await faceResponse.json() : { success: false, error: `face_http_${faceResponse.status}` };
      } else {
        frame.face = { success: false, error: 'face_unavailable' };
      }
      const detectorCoverage = new Set([
        ...(Array.isArray(runpodResult?.detector_coverage) ? runpodResult.detector_coverage : []),
        ...(Array.isArray(frame.detect?.detector_coverage) ? frame.detect.detector_coverage : []),
      ]);
      const vehicleCovered = detectorCoverage.has('vehicle');
      const inferenceResponse = !runpodResult?.vehicle && !vehicleCovered && LOCAL_VEHICLE_INFERENCE
        ? await fetch(`${INFERENCE_SERVICE_URL}/infer`, {
          method: 'POST',
          headers,
          body: buildForm(frame.alpr.plate_bbox),
          signal: AbortSignal.timeout(30_000),
        })
        : null;
      frame.capture_recognition = await runCaptureRecognition(frame, image, job);

      // RunPod is primary for vehicle and people work. The VPS is called only
      // when the batch missed that capability or the GPU request failed.
      if (runpodResult?.people && Array.isArray(runpodResult.people)) {
        frame.people = { success: true, people: runpodResult.people, provider: runpodResult.people_provider || 'runpod' };
      } else if (frame.detect?.success && Array.isArray(frame.detect.people) && (frame.detect.people.length || frame.detect.people_provider || detectorCoverage.has('person'))) {
        // /infer/detect already ran a person detector; an empty list means nobody was seen, not "not checked".
        frame.people = { success: true, people: frame.detect.people, provider: frame.detect.people_provider || frame.detect.detector_provider || 'local_detect' };
      } else if (peopleResponse) {
        frame.people = peopleResponse.ok ? await peopleResponse.json() : { success: false, error: `people_http_${peopleResponse.status}` };
      } else {
        frame.people = await classifyLocally(INFERENCE_SERVICE_URL, '/infer/people', headers, buildForm);
      }
      frame.animals = normaliseAnimals(runpodResult, frame.detect);
      const detectedVehicle = runpodResult?.vehicle || frame.detect?.vehicles?.[0]?.attributes || null;
      if (detectedVehicle) {
        frame.inference = { success: true, data: detectedVehicle, provider: runpodResult?.vehicle ? 'runpod' : 'local_detect' };
        if (!frame.runpod?.vehicle) frame.runpod = { ...(frame.runpod || {}), vehicle: detectedVehicle };
      } else if (inferenceResponse) {
        frame.inference = inferenceResponse.ok ? await inferenceResponse.json() : { success: false, error: `inference_http_${inferenceResponse.status}` };
      } else if (vehicleCovered) {
        frame.inference = { success: false, error: 'no_vehicle_detected', review_required: false };
      } else {
        frame.inference = { success: false, error: 'vehicle_crop_unavailable', review_required: true };
      }
      return {
        alpr: frame.alpr,
        face: frame.face,
        people: frame.people,
        animals: frame.animals,
        detect: frame.detect,
        capture_recognition: frame.capture_recognition,
        inference: frame.inference,
        runpod: frame.runpod,
      };
}

async function classifyLocally(baseUrl, route, headers, buildForm) {
  try {
    const response = await fetch(`${baseUrl}${route}`, { method: 'POST', headers, body: buildForm(), signal: AbortSignal.timeout(30_000) });
    return response.ok ? await response.json() : { success: false, error: `${route}_http_${response.status}` };
  } catch (error) {
    return { success: false, error: `${route}_unavailable`, detail: error.message };
  }
}

// Animal detections arrive as a list (RunPod infer_batch) or under a triage object (/infer/detect). The
// consolidator reads { animals: [...], status }; status says whether an empty list means "none seen" or
// "no model could look".
function normaliseAnimals(runpodResult, localDetect) {
  if (runpodResult) {
    const list = Array.isArray(runpodResult.animals) ? runpodResult.animals : Array.isArray(runpodResult.animals?.detections) ? runpodResult.animals.detections : [];
    return { success: true, animals: list, status: runpodResult.animal_detection_status || 'unknown', provider: runpodResult.detector_provider || 'runpod' };
  }
  if (localDetect?.success) {
    const covered = Array.isArray(localDetect.detector_coverage) && localDetect.detector_coverage.includes('animal');
    return {
      success: true,
      animals: Array.isArray(localDetect.animals) ? localDetect.animals : [],
      status: !covered ? 'model_not_staged' : localDetect.species_status === 'ready' ? 'ready' : 'detector_only_species_not_staged',
      provider: localDetect.detector_provider || 'local_detect',
    };
  }
  return { success: false, animals: [], status: 'animal_inference_unavailable', review_required: true };
}

async function classifyWithRunpodBatch(batch, tasks = ['person', 'vehicle', 'animal', 'plate', 'face']) {
  if (!RUNPOD_API_KEY || batch.length === 0) return new Map();
  if (Date.now() < runpodUnavailableUntil) {
    log('runpod_inference_circuit_open', { retry_after_ms: runpodUnavailableUntil - Date.now(), batch_size: batch.length });
    return new Map();
  }
  try {
    const response = await fetch(`${RUNPOD_API_URL}/runsync`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${RUNPOD_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: {
          action: 'infer_batch',
          frames: batch.map(({ frame, image }) => ({ frame_id: frame.sha256_hash, image_base64: image.toString('base64') })),
          tasks,
        },
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) {
      runpodUnavailableUntil = Date.now() + RUNPOD_BACKOFF_MS;
      log('runpod_inference_degraded', { status: response.status, retry_after_ms: RUNPOD_BACKOFF_MS });
      return new Map();
    }
    const payload = await response.json();
    if (payload.status && payload.status !== 'COMPLETED') {
      runpodUnavailableUntil = Date.now() + RUNPOD_BACKOFF_MS;
      log('runpod_inference_deferred', { status: payload.status, job_id: payload.id, retry_after_ms: RUNPOD_BACKOFF_MS });
      return new Map();
    }
    const results = payload.output?.results || payload.results;
    runpodUnavailableUntil = 0;
    return new Map(Array.isArray(results) ? results.filter((item) => item?.frame_id).map((item) => [item.frame_id, item.result || item]) : []);
  } catch (error) {
    runpodUnavailableUntil = Date.now() + RUNPOD_BACKOFF_MS;
    log('runpod_inference_unavailable', { error: error.message, retry_after_ms: RUNPOD_BACKOFF_MS });
    return new Map();
  }
}

async function runCaptureRecognition(frame, image, job) {
  if (!RUNPOD_CAPTURE_API_URL || !RUNPOD_CAPTURE_API_KEY) {
    return { state: 'unavailable', reason: 'capture_endpoint_not_configured', review_required: true };
  }
  try {
    const response = await fetch(`${RUNPOD_CAPTURE_API_URL}/runsync`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${RUNPOD_CAPTURE_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: {
          action: 'capture_recognition',
          source_frame_hash: frame.sha256_hash,
          relative_timestamp_seconds: frame.relative_timestamp_seconds,
          image_base64: image.toString('base64'),
          crop: frame.alpr?.plate_bbox || frame.runpod?.vehicle?.detection?.bbox || null,
          tasks: ['alpr', 'face_embedding', 'vehicle_attributes', 'animal_detection'],
          enhancement_profile: 'deterministic_capture_v1',
          source_job_id: job.id,
        },
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) return { state: 'unavailable', reason: `capture_endpoint_http_${response.status}`, review_required: true };
    const payload = await response.json();
    return { ...payload.output, state: payload.status === 'COMPLETED' ? 'candidate' : 'unavailable', review_required: true, authority: 'provisional' };
  } catch (error) {
    log('capture_recognition_unavailable', { job_id: job.id, frame_hash: frame.sha256_hash, error: error.message });
    return { state: 'unavailable', reason: 'capture_endpoint_error', detail: error.message, review_required: true };
  }
}

async function failJob(jobId, message) {
  const { error } = await supabase.from('inference_jobs').update({ status: 'failed', stage: 'failed', error_message: String(message).slice(0, 4000), lease_token: null, lease_expires_at: null, heartbeat_at: null }).eq('id', jobId).eq('status', 'processing');
  if (error) log('job_failure_update_failed', { job_id: jobId, error: error.message });
  log('job_failed', { job_id: jobId, error: message });
}

function playbackStoragePath(sourceStoragePath) {
  const withoutExtension = sourceStoragePath.replace(/\.[^./\\]+$/, '');
  return `${withoutExtension}.playback.mp4`;
}

const PLAYBACK_PROFILES = { copy: 'h264-copy-faststart', transcode: 'h264-slow-crf18' };

// ffprobe the first video stream; null when ffprobe is missing or the file cannot be read.
function probeVideo(sourcePath) {
  return new Promise((resolve) => {
    const child = spawn('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-select_streams', 'v:0', sourcePath], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    const timeout = setTimeout(() => { child.kill('SIGKILL'); resolve(null); }, 60_000);
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.once('error', () => { clearTimeout(timeout); resolve(null); });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) return resolve(null);
      try {
        const parsed = JSON.parse(output);
        const stream = Array.isArray(parsed.streams) ? parsed.streams[0] : null;
        resolve(stream ? { codec_name: stream.codec_name, pix_fmt: stream.pix_fmt, profile: stream.profile, format_name: parsed.format?.format_name || '' } : null);
      } catch {
        resolve(null);
      }
    });
  });
}

// Browsers play H.264 in an MP4/MOV container natively; such sources (TAPO, most IP cameras) only need
// the moov atom moved to the front ("faststart") so playback and seeking start before the whole file
// downloads. Re-encoding them costs minutes per file and loses quality for nothing. Anything else
// (H.265, raw elementary streams, DVR containers) is transcoded to browser-safe H.264.
function choosePlaybackStrategy(probe) {
  if (!probe) return 'transcode';
  const codec = String(probe.codec_name || '').toLowerCase();
  const pixelFormat = String(probe.pix_fmt || '').toLowerCase();
  const format = String(probe.format_name || '').toLowerCase();
  const isMp4Family = /\b(mov|mp4|m4a|3gp|3g2|mj2)\b/.test(format);
  const browserSafePixels = !pixelFormat || /^yuv420p$|^yuvj420p$/.test(pixelFormat);
  return codec === 'h264' && isMp4Family && browserSafePixels ? 'copy' : 'transcode';
}

function ffmpegArgsFor(strategy, sourcePath, outputPath) {
  if (strategy === 'copy') {
    return ['-y', '-fflags', '+genpts', '-i', sourcePath, '-map', '0:v:0', '-c:v', 'copy', '-movflags', '+faststart', outputPath];
  }
  return [
    '-y', '-fflags', '+genpts', '-i', sourcePath,
    '-map', '0:v:0', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18',
    '-profile:v', 'high', '-level:v', '4.2', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', outputPath
  ];
}

function runFfmpegRemux(sourcePath, outputPath, strategy = 'transcode') {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ffmpegArgsFor(strategy, sourcePath, outputPath), {
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let errorOutput = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('ffmpeg remux timed out'));
    }, EXTRACTOR_TIMEOUT_MS);
    child.stderr.on('data', (chunk) => { errorOutput += chunk.toString().slice(-4000); });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${errorOutput || 'unknown error'}`));
      resolve();
    });
  });
}

// Evidence is decoded straight from its source (h264 elementary streams, proprietary DVR
// containers, etc.) for motion analysis, but browsers/Windows/phones can't play those directly.
// Create a high-quality browser-compatible playback derivative. The original H.265 bytes remain
// untouched and available for court/chain-of-custody purposes; this H.264 copy exists for broad
// browser support because native HEVC playback is platform-dependent.
async function ensurePlaybackCopy(job, evidence, videoPath) {
  if (evidence.metadata?.playback_storage_path
    && Object.values(PLAYBACK_PROFILES).includes(evidence.metadata?.playback_transcode_profile)) return;
  const outputDir = path.join(DERIVED_ROOT, job.id);
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, 'playback.mp4');
  const probe = await probeVideo(videoPath);
  let strategy = choosePlaybackStrategy(probe);
  try {
    await runFfmpegRemux(videoPath, outputPath, strategy);
  } catch (error) {
    if (strategy !== 'copy') throw error;
    // A stream that probed as H.264 but will not copy cleanly (damaged ring-slot tail) still gets a playable derivative.
    log('playback_copy_fallback_transcode', { job_id: job.id, error: error.message });
    strategy = 'transcode';
    await runFfmpegRemux(videoPath, outputPath, strategy);
  }

  const bucket = evidence.metadata?.storage_bucket || 'bob-uploads';
  const destinationPath = playbackStoragePath(evidence.storage_path);
  const bytes = await fs.readFile(outputPath);
  const { error: uploadError } = await supabase.storage
    .from(bucket)
    .upload(destinationPath, bytes, { contentType: 'video/mp4', upsert: true });
  if (uploadError) throw new Error(`playback upload failed: ${uploadError.message}`);

  const { error: updateError } = await supabase
    .from('evidence_items')
    .update({ metadata: {
      ...(evidence.metadata || {}),
      playback_storage_path: destinationPath,
      playback_content_type: 'video/mp4',
      playback_transcode_profile: PLAYBACK_PROFILES[strategy],
      playback_source_codec: probe?.codec_name || null,
      playback_source_preserved: true,
    } })
    .eq('id', evidence.id);
  if (updateError) throw new Error(`evidence playback metadata update failed: ${updateError.message}`);
  log('playback_copy_ready', { job_id: job.id, evidence_item_id: evidence.id, destination_path: destinationPath, strategy, source_codec: probe?.codec_name || null });
}

// One row per tracked person / vehicle / animal, place inherited from the import behind the evidence.
// The RPC clusters portfolios and stores candidates; identity stays with the reviewer.
async function recordEntityObservations(job, evidence, summary) {
  const context = { recordedStartAt: evidence.metadata?.recorded_start_at || null, capturedAt: evidence.captured_at || null };
  const observations = buildEntityObservations(summary, context);
  if (!observations.length) {
    log('entity_observations_none', { job_id: job.id, has_time_base: Boolean(context.recordedStartAt || context.capturedAt) });
    return 0;
  }
  const { data, error } = await supabase.rpc('record_cctv_entity_observations', {
    p_job_id: job.id,
    p_evidence_id: job.evidence_item_id,
    p_organization_id: job.organization_id,
    p_observations: observations,
  });
  if (error) throw new Error(`entity observation persistence failed: ${error.message}`);
  log('entity_observations_recorded', { job_id: job.id, submitted: observations.length, saved: data, kinds: observations.reduce((counts, item) => ({ ...counts, [item.entity_kind]: (counts[item.entity_kind] || 0) + 1 }), {}) });
  return data;
}

// Timeline marks for the review console; only imports carry a device timeline, so legacy evidence is skipped.
async function recordInferenceDeviceEvents(job, evidence, summary) {
  if (!evidence.cctv_import_id) return 0;
  const marks = buildInferenceDeviceEvents(summary, { recordedStartAt: evidence.metadata?.recorded_start_at || null, capturedAt: evidence.captured_at || null })
    .map((mark) => ({ ...mark, source_ref: `${job.evidence_item_id}:${mark.source_ref}` }));
  if (!marks.length) return 0;
  const { data, error } = await supabase.rpc('record_cctv_device_events', { p_import_id: evidence.cctv_import_id, p_events: marks });
  if (error) {
    log('inference_device_events_failed', { job_id: job.id, error: error.message });
    return 0;
  }
  log('inference_device_events_recorded', { job_id: job.id, submitted: marks.length, saved: data });
  return data;
}

async function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of (await fs.open(filePath)).createReadStream()) { hash.update(chunk); size += chunk.length; }
  return { sha256: hash.digest('hex'), size };
}

// The stored source bytes are hashed once so a reviewer can lock the recording against retention with an
// integrity anchor. Never overwrites a hash the intake already recorded; skipped once the item is locked.
async function recordSourceHash(job, evidence, videoPath) {
  if (evidence.metadata?.source_sha256 || evidence.locked_at) return null;
  try {
    const { sha256, size } = await hashFile(videoPath);
    const { error } = await supabase.rpc('record_cctv_source_hash', { p_evidence_id: evidence.id, p_sha256: sha256, p_size_bytes: size });
    if (error) throw new Error(error.message);
    log('source_hash_recorded', { job_id: job.id, evidence_item_id: evidence.id, bytes: size });
    return sha256;
  } catch (error) {
    log('source_hash_failed', { job_id: job.id, evidence_item_id: evidence.id, error: error.message });
    return null;
  }
}

async function processOne() {
  if (!INGESTION_URL || !WORKLOAD_SIGNING_SECRET) return;
  let currentJobId = null;
  try {
    const { error: recoveryError } = await supabase.rpc('recover_stale_cctv_inference_jobs');
    if (recoveryError) throw new Error(`stale job recovery failed: ${recoveryError.message}`);
    const { data: jobs, error } = await supabase
      .from('inference_jobs')
      .select('id, organization_id, evidence_item_id, domain, status')
      .eq('domain', 'video_motion')
      .eq('status', 'queued')
      .order('created_at', { ascending: true })
      .limit(1);
    if (error) throw new Error(`job poll failed: ${error.message}`);
    if (!jobs?.length) return;
    const job = await claimJob(jobs[0]);
    if (!job) return;
    currentJobId = job.id;
    await updateProgress(job, 'loading_evidence', { label: 'Loading evidence file' });
    const { data: evidence, error: evidenceError } = await supabase
      .from('evidence_items')
      .select('id, organization_id, evidence_kind, storage_path, metadata, captured_at, cctv_import_id, locked_at')
      .eq('id', job.evidence_item_id)
      .eq('organization_id', job.organization_id)
      .maybeSingle();
    if (evidenceError || !evidence) throw new Error(`evidence lookup failed: ${evidenceError?.message || 'not found'}`);
    if (evidence.evidence_kind !== 'video') throw new Error('evidence item is not video');
    await updateProgress(job, 'converting', { label: 'Preparing video for analysis' });
    const videoPath = await ensureVideoPath(evidence);
    await recordSourceHash(job, evidence, videoPath);
    try {
      await ensurePlaybackCopy(job, evidence, videoPath);
    } catch (playbackError) {
      // Keep inference available if remuxing fails, but make conversion failure visible.
      log('playback_copy_failed', { job_id: job.id, evidence_item_id: evidence.id, error: playbackError.message });
    }
    log('job_started', { job_id: job.id, evidence_item_id: job.evidence_item_id });
    log('motion_extraction_started', { job_id: job.id });
    await updateProgress(job, 'extracting_motion', { label: 'Extracting motion segments' });
    const summary = await runExtractor(videoPath, path.join(DERIVED_ROOT, job.id));
    log('motion_extraction_completed', { job_id: job.id, total_frames_parsed: summary.total_frames_parsed });
    await heartbeatJob(job, 'classifying_frames');
    await classifyFrames(summary, job);
    await updateProgress(job, 'consolidating_observations', { label: 'Consolidating observations' });
    await consolidateMotionSummary(summary, {
      metersPerPixel: Number(process.env.VISION_METERS_PER_PIXEL) || null,
    });
    await updateProgress(job, 'persisting_result', { label: 'Saving observations, timeline and evidence links' });
    // Observations first: a failure here fails the job while it is still 'processing', so a re-run can repair it.
    await recordEntityObservations(job, evidence, summary);
    await recordInferenceDeviceEvents(job, evidence, summary);
    await ingest(job, summary);
    await recordSceneMemory(job, evidence, summary);
    await fs.rm(classificationCheckpointPath(job.id), { force: true });
    log('job_completed', {
      job_id: job.id,
      total_frames_parsed: summary.total_frames_parsed,
      face_events: summary.consolidated_events?.summary_counts?.face_events || 0,
      vehicle_events: summary.consolidated_events?.summary_counts?.vehicle_events || 0,
      person_events: summary.consolidated_events?.summary_counts?.person_events || 0,
      animal_events: summary.consolidated_events?.summary_counts?.animal_events || 0,
      quality_events: summary.quality_events?.length || 0,
    });
  } catch (error) {
    log('watcher_error', { error: error.message });
    if (currentJobId) await failJob(currentJobId, error.message);
  } finally {
  }
}

async function main() {
  log('watcher_started', { poll_interval_ms: POLL_INTERVAL_MS, worker_concurrency: WORKER_CONCURRENCY, extractor: EXTRACTOR_PATH });
  const workerLoop = async (workerIndex) => {
    while (true) {
      log('worker_poll', { worker_index: workerIndex });
      await processOne();
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  };
  await Promise.all(Array.from({ length: WORKER_CONCURRENCY }, (_, index) => workerLoop(index + 1)));
}

if (require.main === module) main().catch((error) => { log('watcher_stopped', { error: error.message }); process.exitCode = 1; });

module.exports = { safeVideoPath, safeCacheVideoPath, ensureVideoPath, runExtractor, claimJob, processOne, playbackStoragePath, ensurePlaybackCopy, selectFramesForClassification, representativeFrameHashes, probeVideo, choosePlaybackStrategy, ffmpegArgsFor, PLAYBACK_PROFILES, normaliseAnimals, recordEntityObservations, recordInferenceDeviceEvents, hashFile, recordSourceHash };
