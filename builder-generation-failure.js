'use strict';

const { laneAllows } = require('./builder-path-policy');

/**
 * Count an author run that ended without a proposal as a step attempt. The worker claim RPCs
 * increment attempt_count only when a patch reaches a worker, so before this an author that
 * exhausted its turns left the step 'pending' at attempt 0 and the autopilot retried it every
 * tick (job 1021dbaa, 2026-09-26: five full engineer runs). Best-effort: never throws.
 */
async function recordGenerationFailure({ supabase, job, step, logger = console }, generation, phase) {
  if (!supabase || typeof supabase.rpc !== 'function' || !job?.id || !step?.id) return null;
  const reason = `${phase}: ${String(generation?.error || generation?.result?.error || 'author produced no proposal').slice(0, 300)}`;
  // An honest "no change" (the file does not exist, the task is unsafe) is an answer for the requester,
  // not a failure to run again: job 92f7369a repeated one six times before the ceiling stopped it.
  const retryable = !generation?.no_change;
  try {
    const { data, error } = await supabase.rpc('builder_record_generation_failure', { _job_id: job.id, _step_id: step.id, _reason: reason, _retryable: retryable });
    if (error) { logger?.warn?.(`[builder] generation failure not recorded: ${error.message}`); return null; }
    return data ?? null;
  } catch (error) {
    logger?.warn?.(`[builder] generation failure not recorded: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

function crossLaneNoChange(generation, mode) {
  const ownLane = mode === 'frontend_engineer' ? 'frontend' : mode === 'backend_engineer' ? 'backend' : null;
  if (generation?.no_change_lane) return Boolean(ownLane && ['frontend', 'backend'].includes(generation.no_change_lane)
    && generation.no_change_lane !== ownLane && laneAllows(generation.no_change_lane, generation.no_change_file));
  const reason = String(generation?.error || generation?.summary || '');
  const detail = reason.toLowerCase();
  if (!ownLane) return false;
  const sibling = ownLane === 'frontend' ? 'backend' : 'frontend';
  const files = reason.match(/(?:[a-z0-9_.-]+\/)*[a-z0-9_.-]+\.(?:[cm]?[jt]sx?|sql|css|html)\b/gi) || [];
  if (!files.some(file => laneAllows(sibling, file))) return false;
  if (ownLane && detail.includes('protected lane boundary:')) {
    return detail.includes(`(${sibling} lane)`) && detail.includes(`restricted to`)
      && detail.includes(`${ownLane} files`);
  }
  return detail.includes(`outside the ${ownLane} lane`)
    || detail.includes(`outside the allowed ${ownLane} lane`);
}

/**
 * A no-change answer can be actionable in two ways:
 * 1) the sibling implementation already delivered the patch, or
 * 2) this lane can prove the fix belongs to the sibling lane.
 * In either case, skip this lane with the recorded reason so the job can continue.
 */
async function skipLaneWithNothingToDo({ supabase, job, step, siblingCompleted, logger = console }, generation) {
  const reroute = crossLaneNoChange(generation, step?.builder_mode);
  if (!generation?.no_change || (!siblingCompleted && !reroute) || !supabase || typeof supabase.rpc !== 'function' || !job?.id || !step?.id) return false;
  const sibling = step.builder_mode === 'frontend_engineer' ? 'backend' : 'frontend';
  const reason = reroute
    ? `Nothing to change in this lane; author evidence says this fix belongs to the ${sibling} lane. Author: ${String(generation.error || '').slice(0, 600)}`
    : `Nothing to change in this lane; the ${sibling} lane delivered the change. Author: ${String(generation.error || '').slice(0, 600)}`;
  try {
    const { error } = await supabase.rpc('builder_skip_implementation_step', { _job_id: job.id, _step_id: step.id, _builder_mode: step.builder_mode, _reason: reason });
    if (error) { logger?.warn?.(`[builder] lane skip not recorded: ${error.message}`); return false; }
    return true;
  } catch (error) {
    logger?.warn?.(`[builder] lane skip not recorded: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

module.exports = { crossLaneNoChange, recordGenerationFailure, skipLaneWithNothingToDo };
