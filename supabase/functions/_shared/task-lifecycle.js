/**
 * _shared/task-lifecycle.js -- Task step lifecycle integration for Bob conductor.
 *
 * Manages marking steps as they progress from pending → running → completed/failed/blocked.
 * These are deterministic helpers that orchestrate persistence + state machine transitions.
 */

const { claimStepForExecution, completeStep, failStep, blockStep, updateTaskRunCheckpoint } = require('./task-persistence.js');
const { getTaskCheckpoint } = require('./task-state-machine.js');

/**
 * Get the first pending/retryable step from the task ledger.
 * Returns the step object or null.
 */
function getCurrentPendingStep(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return null;

  // Priority: retryable-failed > pending > blocked
  const retryable = steps.find(s => s && s.status === 'failed' && s.retryable);
  if (retryable) return retryable;

  const pending = steps.find(s => s && s.status === 'pending');
  if (pending) return pending;

  const blocked = steps.find(s => s && s.status === 'blocked');
  return blocked || null;
}

/**
 * Before dispatching a tool, claim the current pending step for execution.
 * Marks it as running and persists the state.
 * Returns { success: bool, step: updated step or original }
 */
async function startToolExecution(supabase, taskLedger, chosenTool) {
  if (!taskLedger || !taskLedger.task || !Array.isArray(taskLedger.steps)) {
    return { success: false, step: null };
  }

  const currentStep = getCurrentPendingStep(taskLedger.steps);
  if (!currentStep) {
    console.log('[task-lifecycle] No pending step to claim for tool:', chosenTool);
    return { success: false, step: null };
  }

  const result = await claimStepForExecution(supabase, taskLedger.task.id, currentStep);

  if (result.success) {
    console.log(`[task-lifecycle] Claimed step ${currentStep.step_id} for tool ${chosenTool}`);
  } else {
    console.warn(`[task-lifecycle] Failed to claim step ${currentStep.step_id} (persistence failed, non-fatal)`);
  }

  return result;
}

/**
 * After dispatching a tool, update the step status based on the result.
 * Determines success/failure/blocked from result.meta.outcome.
 * Returns { success: bool, updatedStep: object, checkpoint: object, updatedSteps: array }
 */
async function finishToolExecution(supabase, taskLedger, chosenTool, result) {
  if (!taskLedger || !taskLedger.task || !Array.isArray(taskLedger.steps) || !result || !result.meta) {
    return { success: false, updatedStep: null, checkpoint: null, updatedSteps: [] };
  }

  const currentStep = getCurrentPendingStep(taskLedger.steps);
  if (!currentStep) {
    return { success: false, updatedStep: null, checkpoint: null, updatedSteps: taskLedger.steps };
  }

  const outcome = String(result.meta.outcome ?? 'ok');
  let updateResult;

  if (outcome === 'ok' || outcome === 'completed') {
    // Tool succeeded - pass full result for automatic evidence sanitization
    updateResult = await completeStep(supabase, taskLedger.task.id, currentStep, result, chosenTool);
  } else if (outcome === 'error' || outcome === 'failed') {
    // Tool failed
    const error = result.meta.tool_call_error || result.meta.error || 'Tool failed';
    const retryable = result.meta.retryable || false;
    updateResult = await failStep(supabase, taskLedger.task.id, currentStep, error, retryable);
  } else if (outcome === 'blocked' || outcome === 'preflight_blocked') {
    // Tool encountered a blocker (e.g., missing data, permission denied)
    const reason = result.meta.preflight_reason || result.meta.error || 'Blocked';
    updateResult = await blockStep(supabase, taskLedger.task.id, currentStep, reason);
  } else if (outcome === 'proposed') {
    // Governed write staged for human approval; the step's work is done.
    updateResult = await completeStep(supabase, taskLedger.task.id, currentStep, 'Proposal staged for human approval');
  } else {
    // Unknown outcome — treat as success but log
    console.warn(`[task-lifecycle] Unknown outcome for ${chosenTool}: ${outcome}`);
    updateResult = await completeStep(supabase, taskLedger.task.id, currentStep, `Completed with outcome: ${outcome}`);
  }

  if (updateResult.success) {
    console.log(`[task-lifecycle] Marked step ${currentStep.step_id} as ${updateResult.step.status}`);

    // Regenerate checkpoint with the updated step
    const updatedSteps = taskLedger.steps.map(s =>
      s.id === currentStep.id ? updateResult.step : s
    );
    const checkpoint = getTaskCheckpoint(updatedSteps);

    return {
      success: true,
      updatedStep: updateResult.step,
      checkpoint,
      updatedSteps
    };
  } else {
    console.warn(`[task-lifecycle] Failed to update step ${currentStep.step_id} (persistence failed, non-fatal)`);
    return { success: false, updatedStep: currentStep, checkpoint: null, updatedSteps: taskLedger.steps };
  }
}

/**
 * Reload the task ledger from the database after a step completes.
 * This gets the fresh state for the next loop iteration.
 * Returns the fresh ledger or the stale one if load fails.
 */
async function reloadTaskLedger(supabase, taskLedger) {
  if (!taskLedger || !taskLedger.task) return taskLedger;

  try {
    const { data: task, error: taskErr } = await supabase
      .from('bob_task_runs')
      .select('id, task_id, conversation_id, organization_id, goal, status, current_step_index, total_steps, updated_at, last_verified_at, last_error')
      .eq('id', taskLedger.task.id)
      .single();

    if (taskErr || !task) {
      console.warn('[task-lifecycle] Failed to reload task run (non-fatal):', taskErr?.message ?? 'unknown');
      return taskLedger;
    }

    const { data: steps, error: stepErr } = await supabase
      .from('bob_task_steps')
      .select('id, task_id, task_run_id, step_id, ordinal_position, requested_operation, normalized_tool, normalized_args, status, attempt_count, started_at, completed_at, result_summary, evidence_refs, error, retryable')
      .eq('task_run_id', task.id)
      .order('ordinal_position', { ascending: true });

    if (stepErr) {
      console.warn('[task-lifecycle] Failed to reload task steps (non-fatal):', stepErr.message);
    }

    const safeSteps = Array.isArray(steps) ? steps : [];
    const checkpoint = getTaskCheckpoint(safeSteps);

    return {
      task,
      steps: safeSteps,
      checkpoint
    };
  } catch (e) {
    console.warn('[task-lifecycle] Reload threw (non-fatal):', e.message);
    return taskLedger;
  }
}

module.exports = {
  getCurrentPendingStep,
  startToolExecution,
  finishToolExecution,
  reloadTaskLedger
};
