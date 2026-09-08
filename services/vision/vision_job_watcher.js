const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createClient } = require('@supabase/supabase-js');
const { signJobToken } = require('./local_jwt_signer');
const { consolidateMotionSummary } = require('./motion_consolidator');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const INGESTION_URL = (process.env.VISION_INGESTION_URL || '').replace(/\/+$/, '');
const WORKLOAD_SIGNING_SECRET = process.env.WORKLOAD_SIGNING_SECRET || '';
const INFERENCE_SERVICE_URL = (process.env.INFERENCE_SERVICE_URL || 'http://fcm-inference:3000').replace(/\/+$/, '');
const INFERENCE_API_KEY = process.env.INFERENCE_API_KEY || '';
const RUNPOD_API_URL = (process.env.RUNPOD_API_URL || 'https://api.runpod.ai/v2/katqqnmds1dphs').replace(/\/+$/, '');
const RUNPOD_API_KEY = process.env.RUNPOD_API || '';
const VIDEO_ROOT = path.resolve(process.env.VISION_VIDEO_ROOT || '/opt/fcm/storage');
const DERIVED_ROOT = path.resolve(process.env.VISION_DERIVED_ROOT || '/opt/fcm/derived');
const VIDEO_CACHE_ROOT = path.resolve(process.env.VISION_VIDEO_CACHE_ROOT || path.join(DERIVED_ROOT, 'source-cache'));
const EXTRACTOR_PATH = path.resolve(
  process.env.VISION_EXTRACTOR_PATH || path.join(__dirname, 'video_motion_extractor.py')
);
const POLL_INTERVAL_MS = Number(process.env.VISION_POLL_INTERVAL_MS || 5000);
const EXTRACTOR_TIMEOUT_MS = Number(process.env.VISION_EXTRACTOR_TIMEOUT_MS || 30 * 60 * 1000);
const MAX_SUMMARY_BYTES = Number(process.env.VISION_MAX_SUMMARY_BYTES || 2 * 1024 * 1024);
const MAX_CLASSIFICATION_FRAMES = Number(process.env.VISION_MAX_CLASSIFICATION_FRAMES || 120);
const RUNPOD_BATCH_SIZE = Number(process.env.VISION_RUNPOD_BATCH_SIZE || 6);
const STORAGE_DOWNLOAD_TIMEOUT_MS = Number(process.env.VISION_STORAGE_DOWNLOAD_TIMEOUT_MS || 120_000);
const LOCAL_VEHICLE_INFERENCE = process.env.VISION_LOCAL_VEHICLE_INFERENCE !== 'false';
const LOCAL_PEOPLE_INFERENCE = process.env.VISION_LOCAL_PEOPLE_INFERENCE !== 'false';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});
let processing = false;

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
  const { data, error } = await supabase
    .from('inference_jobs')
    .update({ status: 'processing' })
    .eq('id', job.id)
    .eq('domain', 'video_motion')
    .eq('status', 'queued')
    .select('id, organization_id, evidence_item_id, domain, status')
    .maybeSingle();
  if (error) throw new Error(`job claim failed: ${error.message}`);
  return data;
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

async function classifyFrames(summary) {
  if (!INFERENCE_API_KEY) throw new Error('INFERENCE_API_KEY is required for frame classification');
  const totalFrames = summary.motion_segments.reduce((total, segment) => total + (segment.frames?.length || 0), 0);
  const selectedFrames = selectFramesForClassification(summary.motion_segments, MAX_CLASSIFICATION_FRAMES);
  const frameInputs = await Promise.all(selectedFrames.map(async (frame) => ({
    frame,
    image: await fs.readFile(frame.file_path),
  })));
  for (let batchStart = 0; batchStart < frameInputs.length; batchStart += RUNPOD_BATCH_SIZE) {
    const batch = frameInputs.slice(batchStart, batchStart + RUNPOD_BATCH_SIZE);
    const runpodResults = await classifyWithRunpodBatch(batch);
    for (const { frame, image } of batch) {
      const buildForm = () => {
        const form = new FormData();
        form.append('photo', new Blob([image], { type: 'image/jpeg' }), `${frame.sha256_hash}.jpg`);
        return form;
      };
      const headers = { Authorization: `Bearer ${INFERENCE_API_KEY}` };
      const localRequests = [
        fetch(`${INFERENCE_SERVICE_URL}/infer/alpr`, { method: 'POST', headers, body: buildForm(), signal: AbortSignal.timeout(30_000) }),
        fetch(`${INFERENCE_SERVICE_URL}/infer/face`, { method: 'POST', headers, body: buildForm(), signal: AbortSignal.timeout(30_000) }),
        LOCAL_PEOPLE_INFERENCE ? fetch(`${INFERENCE_SERVICE_URL}/infer/people`, { method: 'POST', headers, body: buildForm(), signal: AbortSignal.timeout(30_000) }) : Promise.resolve(null),
        LOCAL_VEHICLE_INFERENCE ? fetch(`${INFERENCE_SERVICE_URL}/infer`, { method: 'POST', headers, body: buildForm(), signal: AbortSignal.timeout(30_000) }) : Promise.resolve(null),
      ];
      const [alprResponse, faceResponse, peopleResponse, inferenceResponse] = await Promise.all(localRequests);
      frame.alpr = alprResponse.ok ? await alprResponse.json() : { success: false, error: `alpr_http_${alprResponse.status}` };
      frame.face = faceResponse.ok ? await faceResponse.json() : { success: false, error: `face_http_${faceResponse.status}` };
      frame.people = peopleResponse ? (peopleResponse.ok ? await peopleResponse.json() : { success: false, error: `people_http_${peopleResponse.status}` }) : { success: false, error: 'people_runpod_primary' };
      frame.inference = inferenceResponse ? (inferenceResponse.ok ? await inferenceResponse.json() : { success: false, error: `inference_http_${inferenceResponse.status}` }) : { success: false, error: 'vehicle_runpod_primary' };
      const runpodResult = runpodResults.get(frame.sha256_hash);
      if (runpodResult) frame.runpod = runpodResult;
    }
  }
  if (totalFrames > selectedFrames.length) summary.classification_truncated = true;
  return summary;
}

async function classifyWithRunpodBatch(batch) {
  if (!RUNPOD_API_KEY) return new Map();
  try {
    const response = await fetch(`${RUNPOD_API_URL}/runsync`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${RUNPOD_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: {
          action: 'infer_batch',
          frames: batch.map(({ frame, image }) => ({ frame_id: frame.sha256_hash, image_base64: image.toString('base64') })),
          tasks: ['person', 'vehicle', 'plate', 'face'],
        },
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) {
      log('runpod_inference_degraded', { status: response.status });
      return new Map();
    }
    const payload = await response.json();
    if (payload.status && payload.status !== 'COMPLETED') {
      log('runpod_inference_deferred', { status: payload.status, job_id: payload.id });
      return new Map();
    }
    const results = payload.output?.results || payload.results;
    return new Map(Array.isArray(results) ? results.filter((item) => item?.frame_id).map((item) => [item.frame_id, item.result || item]) : []);
  } catch (error) {
    log('runpod_inference_unavailable', { error: error.message });
    return new Map();
  }
}

async function failJob(jobId, message) {
  const { error } = await supabase.from('inference_jobs').update({ status: 'failed' }).eq('id', jobId).eq('status', 'processing');
  if (error) log('job_failure_update_failed', { job_id: jobId, error: error.message });
  log('job_failed', { job_id: jobId, error: message });
}

function playbackStoragePath(sourceStoragePath) {
  const withoutExtension = sourceStoragePath.replace(/\.[^./\\]+$/, '');
  return `${withoutExtension}.playback.mp4`;
}

function runFfmpegRemux(sourcePath, outputPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-y', '-fflags', '+genpts', '-i', sourcePath,
      '-map', '0:v:0', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outputPath
    ], {
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
// Remux (stream-copy, no re-encode) into a real MP4 so the evidence is playable everywhere,
// while the original bytes remain untouched and available for court/chain-of-custody purposes.
async function ensurePlaybackCopy(job, evidence, videoPath) {
  if (evidence.metadata?.playback_storage_path) return;
  const outputDir = path.join(DERIVED_ROOT, job.id);
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, 'playback.mp4');
  await runFfmpegRemux(videoPath, outputPath);

  const bucket = evidence.metadata?.storage_bucket || 'bob-uploads';
  const destinationPath = playbackStoragePath(evidence.storage_path);
  const bytes = await fs.readFile(outputPath);
  const { error: uploadError } = await supabase.storage
    .from(bucket)
    .upload(destinationPath, bytes, { contentType: 'video/mp4', upsert: true });
  if (uploadError) throw new Error(`playback upload failed: ${uploadError.message}`);

  const { error: updateError } = await supabase
    .from('evidence_items')
    .update({ metadata: { ...(evidence.metadata || {}), playback_storage_path: destinationPath, playback_content_type: 'video/mp4' } })
    .eq('id', evidence.id);
  if (updateError) throw new Error(`evidence playback metadata update failed: ${updateError.message}`);
  log('playback_copy_ready', { job_id: job.id, evidence_item_id: evidence.id, destination_path: destinationPath });
}

async function processOne() {
  if (processing) return;
  if (!INGESTION_URL || !WORKLOAD_SIGNING_SECRET) return;
  let currentJobId = null;
  processing = true;
  try {
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
    const { data: evidence, error: evidenceError } = await supabase
      .from('evidence_items')
      .select('id, organization_id, evidence_kind, storage_path, metadata')
      .eq('id', job.evidence_item_id)
      .eq('organization_id', job.organization_id)
      .maybeSingle();
    if (evidenceError || !evidence) throw new Error(`evidence lookup failed: ${evidenceError?.message || 'not found'}`);
    if (evidence.evidence_kind !== 'video') throw new Error('evidence item is not video');
    const videoPath = await ensureVideoPath(evidence);
    log('job_started', { job_id: job.id, evidence_item_id: job.evidence_item_id });
    log('motion_extraction_started', { job_id: job.id });
    const summary = await runExtractor(videoPath, path.join(DERIVED_ROOT, job.id));
    log('motion_extraction_completed', { job_id: job.id, total_frames_parsed: summary.total_frames_parsed });
    await classifyFrames(summary);
    await consolidateMotionSummary(summary, {
      metersPerPixel: Number(process.env.VISION_METERS_PER_PIXEL) || null,
    });
    await ingest(job, summary);
    try {
      await ensurePlaybackCopy(job, evidence, videoPath);
    } catch (playbackError) {
      // Motion analysis is the compliance-critical result; a playback-copy failure must not fail the job.
      log('playback_copy_failed', { job_id: job.id, evidence_item_id: job.evidence_item_id, error: playbackError.message });
    }
    log('job_completed', {
      job_id: job.id,
      total_frames_parsed: summary.total_frames_parsed,
      face_events: summary.consolidated_events?.summary_counts?.face_events || 0,
      vehicle_events: summary.consolidated_events?.summary_counts?.vehicle_events || 0
    });
  } catch (error) {
    log('watcher_error', { error: error.message });
    if (currentJobId) await failJob(currentJobId, error.message);
  } finally {
    processing = false;
  }
}

async function main() {
  log('watcher_started', { poll_interval_ms: POLL_INTERVAL_MS, extractor: EXTRACTOR_PATH });
  while (true) {
    await processOne();
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

if (require.main === module) main().catch((error) => { log('watcher_stopped', { error: error.message }); process.exitCode = 1; });

module.exports = { safeVideoPath, safeCacheVideoPath, ensureVideoPath, runExtractor, claimJob, processOne, playbackStoragePath, ensurePlaybackCopy, selectFramesForClassification };
