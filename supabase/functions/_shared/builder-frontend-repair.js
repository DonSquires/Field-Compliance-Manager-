const {
  buildModelRunRequest,
  executeBuilderModelRun,
  contentMetadata
} = require('./builder-model-adapter');
const {
  parseFrontendProposal,
  collectFrontendSourceContext,
  loadVerifiedUxPlan
} = require('./builder-frontend-engineer');
const { redactLog } = require('../../../frontend-worker');

const FRONTEND_REPAIR_PROMPT_VERSION = 'frontend-repair-v2';

function sanitizeVerificationFailure(verification) {
  const commands = Array.isArray(verification?.commands) ? verification.commands : [];
  const failed = commands.find(command => command?.status !== 0) || commands.at(-1) || {};
  return {
    failed_command: String(failed.command || 'unknown').slice(0, 500),
    exit_status: Number.isInteger(failed.status) ? failed.status : null,
    stdout: redactLog(String(failed.stdout || '')).slice(-12000),
    stderr: redactLog(String(failed.stderr || '')).slice(-12000),
    error: redactLog(String(failed.error || '')).slice(-1000)
  };
}

async function authorizeFrontendRepair(supabase, input) {
  const { data, error } = await supabase.rpc('builder_authorize_frontend_repair', {
    _job_id: input.jobId,
    _step_id: input.stepId,
    _failed_worker_run_id: input.failedWorkerRunId,
    _failed_patch_artifact_id: input.failedPatchArtifactId,
    _failure_artifact_id: input.failureArtifactId
  });
  if (error) return { success: false, error: 'frontend repair authorization failed' };
  if (data?.authorized !== true) return { success: false, error: data?.reason || 'frontend repair was not authorized' };
  return { success: true, ...data };
}

async function loadJsonArtifact(supabase, artifactId, jobId, expectedType) {
  const { data: artifact, error } = await supabase
    .from('builder_artifacts')
    .select('id, job_id, artifact_type, status, storage_location, checksum')
    .eq('id', artifactId)
    .eq('job_id', jobId)
    .single();
  if (error || !artifact || artifact.artifact_type !== expectedType || artifact.status !== 'final') {
    throw new Error(`final ${expectedType} artifact is unavailable`);
  }
  const prefix = 'supabase_storage://builder-artifacts/';
  if (!artifact.storage_location?.startsWith(prefix) || !/^[a-f0-9]{64}$/.test(artifact.checksum || '')) {
    throw new Error(`${expectedType} artifact provenance is invalid`);
  }
  const { data: object, error: downloadError } = await supabase.storage
    .from('builder-artifacts')
    .download(artifact.storage_location.slice(prefix.length));
  if (downloadError || !object) throw new Error(`${expectedType} artifact could not be read`);
  const content = Buffer.from(await object.arrayBuffer()).toString('utf8');
  if (contentMetadata(content).checksum !== artifact.checksum) throw new Error(`${expectedType} artifact integrity check failed`);
  try {
    return JSON.parse(content);
  } catch {
    throw new Error(`${expectedType} artifact is not valid JSON`);
  }
}

async function loadRepairInputs({ supabase, job, uxArtifact, failedPatchArtifact, failureArtifact }) {
  const [ux, failedProposal, failure] = await Promise.all([
    loadVerifiedUxPlan(supabase, uxArtifact.id, job.id),
    loadJsonArtifact(supabase, failedPatchArtifact.id, job.id, 'code_implementation'),
    loadJsonArtifact(supabase, failureArtifact.id, job.id, 'build_logs')
  ]);
  return { uxPlan: ux.designPlan, failedProposal, failure };
}

function buildRepairPrompt({ uxPlan, failedProposal, failure, sourceContext, liveContext = null }) {
  return {
    systemPrompt: [
      'You are repairing a failed frontend patch for Field Compliance Manager.',
      'Return a complete replacement patch, not an incremental patch against the failed attempt.',
      'Use only the approved UX plan, commit-pinned source, prior proposal, and sanitized failure evidence.',
      'Do not change dependencies, environment, authentication, routing, access control, safety gates, or backend files.',
      'Return one JSON object with summary, patch, changed_files, and tests. Do not use markdown fences.'
    ].join(' '),
    userPrompt: JSON.stringify({
      approved_ux_plan: uxPlan,
      failed_proposal: failedProposal,
      verification_failure: failure,
      target_sha: sourceContext.target_sha,
      repository_context: sourceContext.repository_context,
      live_context: liveContext,
      source_files: sourceContext.files
    })
  };
}

async function runFrontendRepair({
  supabase,
  gateway,
  job,
  step,
  uxArtifact,
  failedPatchArtifact,
  failureArtifact,
  failedWorkerRunId,
  sourceDir,
  requestedFiles,
  liveContext = null,
  loadInputs = loadRepairInputs,
  collectSource = collectFrontendSourceContext,
  authorizeRepair = authorizeFrontendRepair,
  executeModelRun = executeBuilderModelRun
}) {
  if (!job?.id || !job?.organization_id || !job?.target_sha) throw new Error('commit-pinned job identity is required');
  if (!step?.id || step.builder_mode !== 'frontend_engineer') throw new Error('Frontend Engineer step is required');
  if (!step.retryable || step.status !== 'failed') return { ok: false, status: 409, error: 'frontend step is not retryable' };
  const sourceContext = collectSource({ sourceDir, targetSha: job.target_sha, requestedFiles });
  const authorization = await authorizeRepair(supabase, {
    jobId: job.id,
    stepId: step.id,
    failedWorkerRunId,
    failedPatchArtifactId: failedPatchArtifact.id,
    failureArtifactId: failureArtifact.id
  });
  if (!authorization.success) return { ok: false, status: 409, error: authorization.error };

  const inputs = await loadInputs({ supabase, job, uxArtifact, failedPatchArtifact, failureArtifact });
  const sanitizedFailure = sanitizeVerificationFailure(inputs.failure);
  const prompt = buildRepairPrompt({
    uxPlan: inputs.uxPlan,
    failedProposal: inputs.failedProposal,
    failure: sanitizedFailure,
    sourceContext,
    liveContext
  });
  const modelRequest = buildModelRunRequest({
    organizationId: job.organization_id,
    jobId: job.id,
    stepId: step.id,
    builderMode: 'frontend_engineer',
    workloadKind: 'frontend_repair',
    promptVersion: FRONTEND_REPAIR_PROMPT_VERSION,
    systemPrompt: prompt.systemPrompt,
    userPrompt: prompt.userPrompt,
    inputArtifactIds: [uxArtifact.id, failedPatchArtifact.id, failureArtifact.id],
    outputSchema: { type: 'object', required: ['summary', 'patch', 'changed_files', 'tests'] }
  });
  const result = await executeModelRun({ supabase, gateway, modelRequest, validateOutput: parseFrontendProposal });
  return {
    ...result,
    repair_attempt: authorization.repair_attempt,
    proposal: result.validated_output || null,
    patch_artifact: result.artifact || null,
    routing: { provider: modelRequest.provider, reason: modelRequest.routing_reason, prompt_version: FRONTEND_REPAIR_PROMPT_VERSION }
  };
}

module.exports = {
  FRONTEND_REPAIR_PROMPT_VERSION,
  sanitizeVerificationFailure,
  authorizeFrontendRepair,
  loadJsonArtifact,
  loadRepairInputs,
  buildRepairPrompt,
  runFrontendRepair
};