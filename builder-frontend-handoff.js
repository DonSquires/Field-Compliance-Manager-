const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { executeWorker } = require('./worker-executor');
const { parseFrontendProposal } = require('./supabase/functions/_shared/builder-frontend-engineer');

function verifyRepositorySnapshot(sourceDir, targetSha) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceDir, encoding: 'utf8' }).trim();
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: sourceDir, encoding: 'utf8' }).trim();
  if (head !== targetSha) throw new Error('worker repository does not match target SHA');
  if (status) throw new Error('worker repository must be a clean checkout');
}

async function downloadVerifiedArtifact(supabase, artifactId, jobId, expectedType) {
  const { data: artifact, error } = await supabase
    .from('builder_artifacts')
    .select('id, job_id, step_id, artifact_type, status, storage_location, checksum')
    .eq('id', artifactId)
    .eq('job_id', jobId)
    .single();
  if (error || !artifact || artifact.artifact_type !== expectedType || artifact.status !== 'final') {
    throw new Error(`final ${expectedType} artifact is unavailable`);
  }
  const prefix = 'supabase_storage://builder-artifacts/';
  if (!artifact.storage_location?.startsWith(prefix) || !/^[a-f0-9]{64}$/.test(artifact.checksum || '')) {
    throw new Error('artifact provenance is invalid');
  }
  const { data: object, error: downloadError } = await supabase.storage
    .from('builder-artifacts')
    .download(artifact.storage_location.slice(prefix.length));
  if (downloadError || !object) throw new Error('artifact could not be downloaded');
  const bytes = Buffer.from(await object.arrayBuffer());
  const checksum = crypto.createHash('sha256').update(bytes).digest('hex');
  if (checksum !== artifact.checksum) throw new Error('artifact integrity check failed');
  return { artifact, bytes };
}

async function claimFrontendWorker(supabase, input) {
  const { data, error } = await supabase.rpc('builder_claim_frontend_worker', {
    _job_id: input.jobId,
    _step_id: input.stepId,
    _patch_artifact_id: input.patchArtifactId,
    _runner_id: input.runnerId,
    _expected_target_sha: input.targetSha,
    _timeout_seconds: input.timeoutSeconds
  });
  if (error || !data?.run_id || !data?.lease_token) throw new Error('frontend worker lease claim failed');
  return data;
}

async function heartbeatFrontendWorker(supabase, lease) {
  const { error } = await supabase.rpc('builder_heartbeat_frontend_worker', {
    _run_id: lease.run_id,
    _lease_token: lease.lease_token
  });
  if (error) throw new Error('frontend worker heartbeat failed');
}

async function resetFrontendWorkerRetry(supabase, lease) {
  const { error } = await supabase.rpc('builder_reset_frontend_worker_retry', {
    _run_id: lease.run_id
  });
  if (error) throw new Error('frontend worker retry reset failed');
}

async function uploadAndRegisterOutput(supabase, lease, filePath, artifactType, contentType) {
  const bytes = fs.readFileSync(filePath);
  const checksum = crypto.createHash('sha256').update(bytes).digest('hex');
  const objectPath = `${lease.organization_id}/${lease.job_id}/${lease.run_id}/${path.basename(filePath)}`;
  const bucket = supabase.storage.from('builder-artifacts');
  const { error: uploadError } = await bucket.upload(objectPath, bytes, { contentType, upsert: false });
  if (uploadError) throw new Error(`worker ${artifactType} upload failed`);
  try {
    const { data: stored, error: downloadError } = await bucket.download(objectPath);
    if (downloadError || !stored) throw new Error(`worker ${artifactType} verification failed`);
    const storedBytes = Buffer.from(await stored.arrayBuffer());
    const storedChecksum = crypto.createHash('sha256').update(storedBytes).digest('hex');
    if (storedBytes.length !== bytes.length || storedChecksum !== checksum) {
      throw new Error(`worker ${artifactType} integrity check failed`);
    }
    const { data: artifact, error: rpcError } = await supabase.rpc('builder_register_worker_artifact', {
      _run_id: lease.run_id,
      _lease_token: lease.lease_token,
      _artifact_type: artifactType,
      _content_type: contentType,
      _object_path: objectPath,
      _sha256: checksum,
      _size_bytes: bytes.length
    });
    if (rpcError || !artifact?.id) throw new Error(`worker ${artifactType} registration failed`);
    return artifact;
  } catch (error) {
    await bucket.remove([objectPath]);
    throw error;
  }
}

async function finishFrontendWorker(supabase, lease, succeeded, exitCode, summary) {
  const { data, error } = await supabase.rpc('builder_finish_frontend_worker', {
    _run_id: lease.run_id,
    _lease_token: lease.lease_token,
    _succeeded: succeeded,
    _exit_code: exitCode,
    _log_summary: summary
  });
  if (error) throw new Error('frontend worker completion failed');
  return data;
}

async function runFrontendHandoff({
  supabase,
  job,
  step,
  patchArtifact,
  sourceDir,
  workerImage,
  runnerId,
  timeoutSeconds = 900,
  execute = executeWorker,
  loadPatch = downloadVerifiedArtifact,
  claim = claimFrontendWorker,
  heartbeat = heartbeatFrontendWorker,
  resetRetry = resetFrontendWorkerRetry,
  registerOutput = uploadAndRegisterOutput,
  finish = finishFrontendWorker
}) {
  if (!job?.id || !job?.organization_id || !job?.target_sha) throw new Error('commit-pinned job identity is required');
  if (!step?.id || step.builder_mode !== 'frontend_engineer') throw new Error('Frontend Engineer step is required');
  if (!patchArtifact?.id) throw new Error('generated patch artifact is required');
  verifyRepositorySnapshot(sourceDir, job.target_sha);
  const downloaded = await loadPatch(supabase, patchArtifact.id, job.id, 'code_implementation');
  let proposal;
  try {
    proposal = parseFrontendProposal(downloaded.bytes.toString('utf8'));
  } catch {
    throw new Error('generated patch artifact is invalid');
  }

  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bob-frontend-worker-'));
  fs.chmodSync(artifactDir, 0o755);
    fs.writeFileSync(path.join(artifactDir, 'input.patch'), proposal.patch.endsWith('\n') ? proposal.patch : `${proposal.patch}\n`, { mode: 0o644 });
  let lease;
  let heartbeatTimer;
  let heartbeatError = null;
  try {
    lease = await claim(supabase, {
      jobId: job.id,
      stepId: step.id,
      patchArtifactId: patchArtifact.id,
      runnerId,
      targetSha: job.target_sha,
      timeoutSeconds
    });
    await resetRetry(supabase, lease);
    heartbeatTimer = setInterval(() => {
      heartbeat(supabase, lease).catch(error => { heartbeatError = error; });
    }, Math.min(60000, Math.max(10000, Math.floor(timeoutSeconds * 500))));
    heartbeatTimer.unref?.();

    const result = await execute({
      image: workerImage,
      sourceDir,
      artifactDir,
      profile: 'frontend-verify',
      timeoutMs: timeoutSeconds * 1000,
      // 460 MB of node_modules copied onto the /work tmpfs is charged to this limit too; 2g left ~1 GB for tsc.
      memory: '4g',
      cpus: '2',
      pidsLimit: 256
    });
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    if (heartbeatError) throw new Error('frontend worker lost its lease heartbeat');

    const verificationPath = path.join(artifactDir, 'verification.json');
    const succeeded = result.status === 'succeeded' && fs.existsSync(verificationPath)
      && JSON.parse(fs.readFileSync(verificationPath, 'utf8')).succeeded === true;
    const artifacts = [];
    if (fs.existsSync(verificationPath)) {
      artifacts.push(await registerOutput(supabase, lease, verificationPath, 'build_logs', 'application/json'));
    }
    if (succeeded) {
      artifacts.push(await registerOutput(supabase, lease, path.join(artifactDir, 'validated.patch'), 'code_implementation', 'text/x-diff'));
      artifacts.push(await registerOutput(supabase, lease, path.join(artifactDir, 'changed-files.json'), 'changed_file_manifest', 'application/json'));
    }
    const completedJob = await finish(
      supabase,
      lease,
      succeeded,
      result.exitCode ?? 1,
      succeeded ? 'Frontend patch passed lint, build, and tests' : 'Frontend patch verification failed'
    );
    return {
      success: succeeded,
      job: completedJob,
      worker_run_id: lease.run_id,
      artifacts,
      failure_artifact: succeeded ? null : artifacts[0] || null
    };
  } catch (error) {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (lease) {
      await finish(supabase, lease, false, 1, 'Frontend worker handoff failed').catch(() => {});
    }
    throw error;
  } finally {
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
}

module.exports = {
  verifyRepositorySnapshot,
  downloadVerifiedArtifact,
  claimFrontendWorker,
  heartbeatFrontendWorker,
  resetFrontendWorkerRetry,
  uploadAndRegisterOutput,
  finishFrontendWorker,
  runFrontendHandoff
};