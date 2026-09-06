const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createClient } = require('@supabase/supabase-js');
const { signJobToken } = require('./local_jwt_signer');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const INGESTION_URL = (process.env.VISION_INGESTION_URL || '').replace(/\/+$/, '');
const WORKLOAD_SIGNING_SECRET = process.env.WORKLOAD_SIGNING_SECRET || '';
const VIDEO_ROOT = path.resolve(process.env.VISION_VIDEO_ROOT || '/opt/fcm/storage');
const DERIVED_ROOT = path.resolve(process.env.VISION_DERIVED_ROOT || '/opt/fcm/derived');
const EXTRACTOR_PATH = path.resolve(
  process.env.VISION_EXTRACTOR_PATH || path.join(__dirname, 'video_motion_extractor.py')
);
const POLL_INTERVAL_MS = Number(process.env.VISION_POLL_INTERVAL_MS || 5000);
const EXTRACTOR_TIMEOUT_MS = Number(process.env.VISION_EXTRACTOR_TIMEOUT_MS || 30 * 60 * 1000);
const MAX_SUMMARY_BYTES = Number(process.env.VISION_MAX_SUMMARY_BYTES || 2 * 1024 * 1024);

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
  if (!response.ok) throw new Error(`motion ingestion returned HTTP ${response.status}`);
}

async function failJob(jobId, message) {
  const { error } = await supabase.from('inference_jobs').update({ status: 'failed' }).eq('id', jobId).eq('status', 'processing');
  if (error) log('job_failure_update_failed', { job_id: jobId, error: error.message });
  log('job_failed', { job_id: jobId, error: message });
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
      .select('id, organization_id, evidence_kind, storage_path')
      .eq('id', job.evidence_item_id)
      .eq('organization_id', job.organization_id)
      .maybeSingle();
    if (evidenceError || !evidence) throw new Error(`evidence lookup failed: ${evidenceError?.message || 'not found'}`);
    if (evidence.evidence_kind !== 'video') throw new Error('evidence item is not video');
    const videoPath = safeVideoPath(evidence.storage_path);
    await fs.access(videoPath);
    log('job_started', { job_id: job.id, evidence_item_id: job.evidence_item_id });
    const summary = await runExtractor(videoPath, path.join(DERIVED_ROOT, job.id));
    await ingest(job, summary);
    log('job_completed', { job_id: job.id, total_frames_parsed: summary.total_frames_parsed });
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

module.exports = { safeVideoPath, runExtractor, claimJob, processOne };