const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { executeWorker } = require('./worker-executor');
const { downloadVerifiedArtifact, heartbeatFrontendWorker } = require('./builder-frontend-handoff');

function validateSecurityReport(report, patchBytes, manifestBytes) {
  if (!report || typeof report !== 'object' || typeof report.passed !== 'boolean') throw new Error('security report is malformed');
  for (const severity of ['critical', 'high', 'medium', 'low']) {
    if (!Number.isInteger(report.counts?.[severity]) || report.counts[severity] < 0) throw new Error('security finding counts are invalid');
  }
  const patchSha = crypto.createHash('sha256').update(patchBytes).digest('hex');
  const manifestSha = crypto.createHash('sha256').update(manifestBytes).digest('hex');
  if (report.patch_sha256 !== patchSha || report.manifest_sha256 !== manifestSha) throw new Error('security report input digests do not match');
  const expectedPassed = report.counts.critical === 0 && report.counts.high === 0;
  if (report.passed !== expectedPassed) throw new Error('security report pass state is inconsistent');
  return report;
}

async function claimSecurityReview(supabase, input) {
  const { error: recoveryError } = await supabase.rpc('builder_recover_expired_security_review');
  if (recoveryError) throw new Error('security review lease recovery failed');
  const { data, error } = await supabase.rpc('builder_claim_aggregate_security_review', {
    _job_id: input.jobId,
    _security_step_id: input.securityStepId,
    _implementation_worker_run_ids: input.implementationWorkerRunIds,
    _runner_id: input.runnerId,
    _expected_target_sha: input.targetSha,
    _timeout_seconds: input.timeoutSeconds
  });
  if (error || !data?.run_id || !data?.lease_token) throw new Error('security review lease claim failed');
  return data;
}

async function registerSecurityReview(supabase, lease, reportPath) {
  const bytes = fs.readFileSync(reportPath);
  const checksum = crypto.createHash('sha256').update(bytes).digest('hex');
  const objectPath = `${lease.organization_id}/${lease.job_id}/${lease.run_id}/security-review.json`;
  const bucket = supabase.storage.from('builder-artifacts');
  const { error: uploadError } = await bucket.upload(objectPath, bytes, { contentType: 'application/json', upsert: false });
  if (uploadError) throw new Error('security review upload failed');
  try {
    const { data: stored, error: downloadError } = await bucket.download(objectPath);
    if (downloadError || !stored) throw new Error('security review verification failed');
    const storedBytes = Buffer.from(await stored.arrayBuffer());
    if (storedBytes.length !== bytes.length || crypto.createHash('sha256').update(storedBytes).digest('hex') !== checksum) {
      throw new Error('security review integrity check failed');
    }
    const { data, error } = await supabase.rpc('builder_register_security_review', {
      _run_id: lease.run_id,
      _lease_token: lease.lease_token,
      _object_path: objectPath,
      _sha256: checksum,
      _size_bytes: bytes.length
    });
    if (error || !data?.id) throw new Error('security review registration failed');
    return data;
  } catch (error) {
    await bucket.remove([objectPath]);
    throw error;
  }
}

async function finishSecurityReview(supabase, lease, artifactId, counts) {
  const { data, error } = await supabase.rpc('builder_finish_security_review', {
    _run_id: lease.run_id,
    _lease_token: lease.lease_token,
    _security_artifact_id: artifactId,
    _critical_count: counts.critical,
    _high_count: counts.high,
    _medium_count: counts.medium,
    _low_count: counts.low
  });
  if (error) throw new Error('security review completion failed');
  return data;
}

async function abortSecurityReview(supabase, lease, reason) {
  const { error } = await supabase.rpc('builder_abort_security_review', {
    _run_id: lease.run_id,
    _lease_token: lease.lease_token,
    _reason: reason
  });
  if (error) throw new Error('security review abort failed');
}

async function runSecurityReview({
  supabase,
  job,
  securityStep,
  implementationWorkerRunId,
  implementationWorkerRunIds,
  frontendWorkerRunId,
  sourceDir,
  workerImage,
  runnerId,
  timeoutSeconds = 300,
  claim = claimSecurityReview,
  loadArtifact = downloadVerifiedArtifact,
  execute = executeWorker,
  heartbeat = heartbeatFrontendWorker,
  register = registerSecurityReview,
  finish = finishSecurityReview,
  abort = abortSecurityReview
}) {
  if (!job?.id || !job?.organization_id || !job?.target_sha) throw new Error('commit-pinned job identity is required');
  if (!securityStep?.id || securityStep.step_id !== 'security_review') throw new Error('security review step is required');
  const workerRunIds = implementationWorkerRunIds || [implementationWorkerRunId || frontendWorkerRunId].filter(Boolean);
  if (workerRunIds.length === 0 || workerRunIds.length > 2) throw new Error('one or two implementation worker runs are required');
  let lease;
  let heartbeatTimer;
  let heartbeatError = null;
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bob-security-review-'));
  fs.chmodSync(artifactDir, 0o755);
  try {
    lease = await claim(supabase, {
      jobId: job.id,
      securityStepId: securityStep.id,
      implementationWorkerRunIds: workerRunIds,
      runnerId,
      targetSha: job.target_sha,
      timeoutSeconds
    });
    const patchIds = lease.patch_artifact_ids || [lease.patch_artifact_id].filter(Boolean);
    const manifestIds = lease.manifest_artifact_ids || [lease.manifest_artifact_id].filter(Boolean);
    if (patchIds.length !== workerRunIds.length || manifestIds.length !== workerRunIds.length) {
      throw new Error('aggregate security evidence is incomplete');
    }
    const [patches, manifests] = await Promise.all([
      Promise.all(patchIds.map(id => loadArtifact(supabase, id, job.id, 'code_implementation'))),
      Promise.all(manifestIds.map(id => loadArtifact(supabase, id, job.id, 'changed_file_manifest')))
    ]);
    const patchBytes = patches.length === 1
      ? patches[0].bytes
      : Buffer.from(`${patches.map(item => item.bytes.toString('utf8').trimEnd()).join('\n')}\n`);
    const manifestRows = manifests.flatMap(item => JSON.parse(item.bytes.toString('utf8')));
    const manifestPaths = manifestRows.map(item => item?.path).filter(Boolean);
    if (new Set(manifestPaths).size !== manifestPaths.length) throw new Error('aggregate security evidence changes the same file more than once');
    const manifestBytes = manifests.length === 1
      ? manifests[0].bytes
      : Buffer.from(`${JSON.stringify(manifestRows, null, 2)}\n`);
    fs.writeFileSync(path.join(artifactDir, 'validated.patch'), patchBytes, { mode: 0o644 });
    fs.writeFileSync(path.join(artifactDir, 'changed-files.json'), manifestBytes, { mode: 0o644 });
    heartbeatTimer = setInterval(() => heartbeat(supabase, lease).catch(error => { heartbeatError = error; }), 30000);
    heartbeatTimer.unref?.();
    const execution = await execute({
      image: workerImage, sourceDir, artifactDir, profile: 'security-review',
      timeoutMs: timeoutSeconds * 1000, memory: '512m', cpus: '1', pidsLimit: 64
    });
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    if (heartbeatError) throw new Error('security review lost its lease heartbeat');
    const reportPath = path.join(artifactDir, 'security-review.json');
    if (!fs.existsSync(reportPath)) throw new Error('security worker produced no report');
    const report = validateSecurityReport(JSON.parse(fs.readFileSync(reportPath, 'utf8')), patchBytes, manifestBytes);
    const artifact = await register(supabase, lease, reportPath);
    const completedJob = await finish(supabase, lease, artifact.id, report.counts);
    return { success: report.passed, report, artifact, job: completedJob, worker_run_id: lease.run_id, execution_status: execution.status };
  } catch (error) {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (lease) await abort(supabase, lease, 'Security review infrastructure failure').catch(() => {});
    throw error;
  } finally {
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
}

module.exports = {
  validateSecurityReport,
  claimSecurityReview,
  registerSecurityReview,
  finishSecurityReview,
  abortSecurityReview,
  runSecurityReview
};