const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { executeWorker } = require('./worker-executor');
const { classifyVerificationFailure } = require('./builder-verification-outcome');
const {
  verifyRepositorySnapshot,
  downloadVerifiedArtifact,
  uploadAndRegisterOutput
} = require('./builder-frontend-handoff');
const { parseBackendProposal } = require('./supabase/functions/_shared/builder-backend-engineer');
const { executeBackendDatabaseVerification } = require('./backend-database-verifier');

async function claimBackendWorker(supabase, input) {
  const { data, error } = await supabase.rpc('builder_claim_backend_worker', {
    _job_id: input.jobId,
    _step_id: input.stepId,
    _patch_artifact_id: input.patchArtifactId,
    _runner_id: input.runnerId,
    _expected_target_sha: input.targetSha,
    _timeout_seconds: input.timeoutSeconds
  });
  if (error || !data?.run_id || !data?.lease_token) throw new Error('backend worker lease claim failed');
  return data;
}

async function heartbeatBackendWorker(supabase, lease) {
  const { error } = await supabase.rpc('builder_heartbeat_backend_worker', {
    _run_id: lease.run_id,
    _lease_token: lease.lease_token
  });
  if (error) throw new Error('backend worker heartbeat failed');
}

async function resetBackendWorkerRetry(supabase, lease) {
  const { error } = await supabase.rpc('builder_reset_backend_worker_retry', { _run_id: lease.run_id });
  if (error) throw new Error('backend worker retry reset failed');
}

async function finishBackendWorker(supabase, lease, succeeded, exitCode, summary) {
  const { data, error } = await supabase.rpc('builder_finish_backend_worker', {
    _run_id: lease.run_id,
    _lease_token: lease.lease_token,
    _succeeded: succeeded,
    _exit_code: exitCode,
    _log_summary: summary
  });
  if (error) throw new Error('backend worker completion failed');
  return data;
}

async function runBackendHandoff({
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
  claim = claimBackendWorker,
  heartbeat = heartbeatBackendWorker,
  resetRetry = resetBackendWorkerRetry,
  verifyDatabase = executeBackendDatabaseVerification,
  registerOutput = uploadAndRegisterOutput,
  finish = finishBackendWorker
}) {
  if (!job?.id || !job?.organization_id || !job?.target_sha) throw new Error('commit-pinned job identity is required');
  if (!step?.id || step.builder_mode !== 'backend_engineer') throw new Error('Backend Engineer step is required');
  if (!patchArtifact?.id) throw new Error('generated backend patch artifact is required');
  verifyRepositorySnapshot(sourceDir, job.target_sha);
  const downloaded = await loadPatch(supabase, patchArtifact.id, job.id, 'code_implementation');
  let proposal;
  try {
    proposal = parseBackendProposal(downloaded.bytes.toString('utf8'));
  } catch {
    throw new Error('generated backend patch artifact is invalid');
  }

  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bob-backend-worker-'));
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
      profile: 'backend-verify',
      timeoutMs: timeoutSeconds * 1000,
      memory: '2g',
      cpus: '2',
      pidsLimit: 128
    });
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    if (heartbeatError) throw new Error('backend worker lost its lease heartbeat');

    const verificationPath = path.join(artifactDir, 'backend-verification.json');
    let verification = null;
    if (fs.existsSync(verificationPath)) {
      try {
        verification = JSON.parse(fs.readFileSync(verificationPath, 'utf8'));
      } catch {}
    }
    const staticSucceeded = result.status === 'succeeded'
      && verification?.succeeded === true
      && verification?.verification_scope === 'static_backend_patch'
      && verification?.migration_execution?.performed === false;
    let databaseVerification = null;
    if (staticSucceeded) {
      databaseVerification = verifyDatabase({
        sourceDir,
        patchPath: path.join(artifactDir, 'input.patch'),
        artifactDir
      });
      const expectedMigrations = [...proposal.database_migrations].sort();
      const actualMigrations = [...(databaseVerification.candidate_migrations || [])].sort();
      const databaseEvidenceMatches = JSON.stringify(actualMigrations) === JSON.stringify(expectedMigrations);
      const executionStateMatches = expectedMigrations.length > 0
        ? databaseVerification.performed === true
        : databaseVerification.performed === false;
      if (!databaseVerification.succeeded || !databaseEvidenceMatches || !executionStateMatches) {
        databaseVerification = { ...databaseVerification, succeeded: false };
      }
      verification = {
        ...verification,
        migration_execution: databaseVerification,
        succeeded: verification.succeeded && databaseVerification.succeeded
      };
      fs.writeFileSync(verificationPath, `${JSON.stringify(verification, null, 2)}\n`, { mode: 0o600 });
    }
    const succeeded = staticSucceeded && databaseVerification?.succeeded === true;
    const infrastructure = succeeded
      ? { infrastructure: false, baseline: false, reason: null }
      : result.status === 'timeout'
        ? { infrastructure: true, baseline: false, reason: `verifier timed out after ${timeoutSeconds} s` }
        : classifyVerificationFailure(verification);
    const artifacts = [];
    if (verification) {
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
      succeeded
        ? proposal.database_migrations.length > 0
          ? 'Backend patch passed static verification and disposable migration execution'
          : 'Backend patch passed static verification; no migration execution was required'
        : infrastructure.baseline
          ? `Repository is red at the pinned commit (${infrastructure.reason}); not caused by this patch`
          : infrastructure.infrastructure
          ? `Backend verifier infrastructure failure (${infrastructure.reason}); the same patch is re-verified`
          : 'Backend patch verification failed'
    );
    return {
      success: succeeded,
      job: completedJob,
      worker_run_id: lease.run_id,
      artifacts,
      verification,
      infrastructure_failure: infrastructure.infrastructure,
      infrastructure_reason: infrastructure.reason,
      baseline_failure: infrastructure.baseline === true,
      baseline_reason: infrastructure.baseline ? infrastructure.reason : null,
      failure_artifact: succeeded ? null : artifacts[0] || null
    };
  } catch (error) {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (lease) await finish(supabase, lease, false, 1, 'Backend worker handoff failed').catch(() => {});
    throw error;
  } finally {
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
}

module.exports = {
  claimBackendWorker,
  heartbeatBackendWorker,
  resetBackendWorkerRetry,
  finishBackendWorker,
  runBackendHandoff
};