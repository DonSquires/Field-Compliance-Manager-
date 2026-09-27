const { runFrontendEngineer } = require('./supabase/functions/_shared/builder-frontend-engineer');
const { runFrontendRepair } = require('./supabase/functions/_shared/builder-frontend-repair');
const { runFrontendHandoff } = require('./builder-frontend-handoff');
const { recordGenerationFailure, skipLaneWithNothingToDo } = require('./builder-generation-failure');

const MAX_FRONTEND_ATTEMPTS = 3;

async function reloadFrontendStep(supabase, stepId, jobId) {
  const { data, error } = await supabase
    .from('builder_job_steps')
    .select('id, job_id, builder_mode, status, retryable, attempt_count')
    .eq('id', stepId)
    .eq('job_id', jobId)
    .single();
  if (error || !data) throw new Error('frontend step state could not be reloaded');
  return data;
}

async function runFrontendImplementation({
  supabase,
  gateway,
  job,
  step,
  uxArtifact,
  sourceDir,
  requestedFiles,
  workerImage,
  runnerId,
  liveContext,
  timeoutSeconds = Math.min(3600, Math.max(300, Number(process.env.BOB_BUILDER_FRONTEND_TIMEOUT_SECONDS) || 1800)),
  generate = runFrontendEngineer,
  repair = runFrontendRepair,
  handoff = runFrontendHandoff,
  reloadStep = reloadFrontendStep,
  resumePatchArtifact = null,
  siblingCompleted = false
}) {
  let currentStep = step;
  // A lost verifier (lease expired, runner gone) left a patch nobody rejected: verify it again first.
  let generation = resumePatchArtifact
    ? { ok: true, patch_artifact: resumePatchArtifact }
    : await generate({
      supabase, gateway, job, step: currentStep, uxArtifact, sourceDir, requestedFiles, liveContext
    });
  if (!generation.ok || !generation.patch_artifact?.id) {
    if (await skipLaneWithNothingToDo({ supabase, job, step: currentStep, siblingCompleted }, generation)) return { success: true, skipped: true, phase: 'generation', result: generation, attempts: 0 };
    await recordGenerationFailure({ supabase, job, step: currentStep }, generation, 'generation');
    return { success: false, phase: 'generation', result: generation, attempts: 0 };
  }

  let patchArtifact = generation.patch_artifact;
  let infrastructureRetries = 0;
  for (let attempt = 1; attempt <= MAX_FRONTEND_ATTEMPTS; attempt += 1) {
    const verification = await handoff({
      supabase, job, step: currentStep, patchArtifact, sourceDir, workerImage, runnerId, timeoutSeconds
    });
    if (verification.success) {
      return {
        success: true,
        attempts: attempt,
        job: verification.job,
        patch_artifact: patchArtifact,
        verification_artifacts: verification.artifacts
      };
    }

    currentStep = await reloadStep(supabase, step.id, job.id);
    if (!currentStep.retryable) {
      return { success: false, phase: 'verification', attempts: attempt, job: verification.job };
    }
    // The repository itself is red at the pinned commit: no repair can pass, so the step is parked
    // with the real reason for a human instead of burning author runs on someone else's break.
    if (verification.baseline_failure) {
      await recordGenerationFailure({ supabase, job, step: currentStep }, { no_change: true, error: `repository red at the pinned commit: ${verification.baseline_reason}` }, 'baseline');
      return { success: false, phase: 'baseline', attempts: attempt, job: verification.job, error: verification.baseline_reason };
    }
    // The verifier failed, not the patch (OOM, killed, timed out): run the same patch again once
    // rather than sending the author a failure it did not cause.
    if (verification.infrastructure_failure && infrastructureRetries < 1) {
      infrastructureRetries += 1;
      continue;
    }
    const failureArtifact = verification.failure_artifact || verification.artifacts?.[0];
    if (!failureArtifact?.id) {
      return { success: false, phase: 'evidence', attempts: attempt, error: 'verification failure artifact is missing' };
    }
    generation = await repair({
      supabase,
      gateway,
      job,
      step: currentStep,
      uxArtifact,
      failedPatchArtifact: patchArtifact,
      failureArtifact,
      failedWorkerRunId: verification.worker_run_id,
      sourceDir,
      requestedFiles,
      liveContext
    });
    if (attempt >= MAX_FRONTEND_ATTEMPTS) {
      return { success: false, phase: 'repair_limit', attempts: attempt, result: generation };
    }
    if (!generation.ok || !generation.patch_artifact?.id) {
      await recordGenerationFailure({ supabase, job, step: currentStep }, generation, 'repair');
      return { success: false, phase: 'repair', attempts: attempt, result: generation };
    }
    patchArtifact = generation.patch_artifact;
  }
  return { success: false, phase: 'verification', attempts: MAX_FRONTEND_ATTEMPTS };
}

module.exports = {
  MAX_FRONTEND_ATTEMPTS,
  reloadFrontendStep,
  runFrontendImplementation
};