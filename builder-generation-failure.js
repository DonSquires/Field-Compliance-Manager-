'use strict';

/**
 * Count an author run that ended without a proposal as a step attempt. The worker claim RPCs
 * increment attempt_count only when a patch reaches a worker, so before this an author that
 * exhausted its turns left the step 'pending' at attempt 0 and the autopilot retried it every
 * tick (job 1021dbaa, 2026-09-26: five full engineer runs). Best-effort: never throws.
 */
async function recordGenerationFailure({ supabase, job, step, logger = console }, generation, phase) {
  if (!supabase || typeof supabase.rpc !== 'function' || !job?.id || !step?.id) return null;
  const reason = `${phase}: ${String(generation?.error || generation?.result?.error || 'author produced no proposal').slice(0, 300)}`;
  try {
    const { data, error } = await supabase.rpc('builder_record_generation_failure', { _job_id: job.id, _step_id: step.id, _reason: reason });
    if (error) { logger?.warn?.(`[builder] generation failure not recorded: ${error.message}`); return null; }
    return data ?? null;
  } catch (error) {
    logger?.warn?.(`[builder] generation failure not recorded: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

module.exports = { recordGenerationFailure };
