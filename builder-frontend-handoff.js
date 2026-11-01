const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { executeWorker } = require('./worker-executor');
const { classifyMissingEvidence, classifyVerificationFailure } = require('./builder-verification-outcome');
const { parseFrontendProposal } = require('./supabase/functions/_shared/builder-frontend-engineer');
const { accountVerifierRecoveries } = require('./builder-verifier-recovery');
const { downloadVerifiedArtifact } = require('./builder-artifact-read');

function verifyRepositorySnapshot(sourceDir, targetSha) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceDir, encoding: 'utf8' }).trim();
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: sourceDir, encoding: 'utf8' }).trim();
  if (head !== targetSha) throw new Error('worker repository does not match target SHA');
  if (status) throw new Error('worker repository must be a clean checkout');
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
  const leaseAttempt = crypto.createHash('sha256').update(lease.lease_token).digest('hex');
  const objectPath = `${lease.organization_id}/${lease.job_id}/${lease.run_id}/${leaseAttempt}/${path.basename(filePath)}`;
  const bucket = supabase.storage.from('builder-artifacts');
  const { error: uploadError } = await bucket.upload(objectPath, bytes, { contentType, upsert: false });
  if (uploadError) throw new Error(`worker ${artifactType} upload failed`, { cause: uploadError });
  try {
    const { data: stored, error: downloadError } = await bucket.download(objectPath);
    if (downloadError || !stored) throw new Error(`worker ${artifactType} verification failed`, { cause: downloadError });
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
    if (rpcError || !artifact?.id) throw new Error(`worker ${artifactType} registration failed`, { cause: rpcError });
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
  if (error) throw new Error('frontend worker completion failed', { cause: error });
  return data;
}

function workerHandoffFailureSummary(profile, stage, error) {
  const name = typeof error?.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(error.name)
    ? error.name
    : 'Error';
  const errorCode = [error?.code, error?.cause?.code]
    .find(value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(value));
  const code = errorCode ? ` code=${errorCode}` : '';
  return `${profile} worker handoff failed during ${stage} (${name}${code})`;
}

async function recordWorkerHandoffFailure(finish, supabase, lease, profile, stage, cause) {
  const summary = workerHandoffFailureSummary(profile, stage, cause);
  try {
    await finish(supabase, lease, false, 1, summary);
  } catch (recordingError) {
    throw new AggregateError([cause, recordingError], `${summary}; failure state could not be recorded`);
  }
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
  let failureStage = 'claiming verifier lease';
  try {
    lease = await claim(supabase, {
      jobId: job.id,
      stepId: step.id,
      patchArtifactId: patchArtifact.id,
      runnerId,
      targetSha: job.target_sha,
      timeoutSeconds
    });
    failureStage = 'resetting verifier retry state';
    await resetRetry(supabase, lease);
    heartbeatTimer = setInterval(() => {
      heartbeat(supabase, lease).catch(error => { heartbeatError = error; });
    }, Math.min(60000, Math.max(10000, Math.floor(timeoutSeconds * 500))));
    heartbeatTimer.unref?.();

    failureStage = 'running frontend verification';
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

    failureStage = 'reading frontend verification evidence';
    const verificationPath = path.join(artifactDir, 'verification.json');
    let verification = null;
    if (fs.existsSync(verificationPath)) {
      try { verification = JSON.parse(fs.readFileSync(verificationPath, 'utf8')); } catch { /* unreadable evidence is a failure below */ }
    }
    const succeeded = result.status === 'succeeded' && verification?.succeeded === true;
    // A lease timeout leaves the progressive evidence the worker wrote before it was killed.
    const infrastructure = succeeded
      ? { infrastructure: false, baseline: false, reason: null }
      : result.status === 'timeout'
        ? { infrastructure: true, baseline: false, reason: `verifier timed out after ${timeoutSeconds} s during ${String(verification?.running || 'verification').slice(0, 120)}` }
        : verification
          ? classifyVerificationFailure(verification)
          : classifyMissingEvidence(result);
    const artifacts = [];
    if (fs.existsSync(verificationPath)) {
      failureStage = 'registering build-log evidence';
      artifacts.push(await registerOutput(supabase, lease, verificationPath, 'build_logs', 'application/json'));
    }
    if (succeeded) {
      failureStage = 'registering validated-patch evidence';
      artifacts.push(await registerOutput(supabase, lease, path.join(artifactDir, 'validated.patch'), 'code_implementation', 'text/x-diff'));
      failureStage = 'registering changed-file evidence';
      artifacts.push(await registerOutput(supabase, lease, path.join(artifactDir, 'changed-files.json'), 'changed_file_manifest', 'application/json'));
    }
    failureStage = 'completing verifier run';
    const completedJob = await finish(
      supabase,
      lease,
      succeeded,
      result.exitCode ?? 1,
      succeeded ? 'Frontend patch passed lint, build, and tests' : infrastructure.baseline ? `Repository is red at the pinned commit (${infrastructure.reason}); not caused by this patch` : infrastructure.infrastructure ? `Frontend verifier infrastructure failure (${infrastructure.reason}); the same patch is re-verified` : infrastructure.unresolved ? `Frontend verification attribution unresolved (${infrastructure.reason}); candidate patch preserved` : 'Frontend patch verification failed'
    );
    if (infrastructure.infrastructure || infrastructure.unresolved || infrastructure.baseline) {
      failureStage = 'recording verifier recovery';
      await accountVerifierRecoveries(supabase, job.id);
    }
    return {
      success: succeeded,
      job: completedJob,
      worker_run_id: lease.run_id,
      artifacts,
      infrastructure_failure: infrastructure.infrastructure || infrastructure.unresolved === true,
      infrastructure_reason: infrastructure.reason,
      baseline_failure: infrastructure.baseline === true,
      baseline_reason: infrastructure.baseline ? infrastructure.reason : null,
      failure_artifact: succeeded ? null : artifacts[0] || null
    };
  } catch (error) {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (lease) await recordWorkerHandoffFailure(finish, supabase, lease, 'Frontend', failureStage, error);
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
  recordWorkerHandoffFailure,
  runFrontendHandoff
};