/**
 * _shared/task-persistence.js -- Persist task state changes to Supabase.
 *
 * These functions take a Supabase client and a state mutation and
 * persist it to the bob_task_steps and bob_task_runs tables.
 * All I/O is failure-open: errors are logged but don't halt the turn.
 */

const { sanitizeEvidenceRefs, classifyEvidenceStatus } = require('./evidence-sanitizer.js');

async function persistStepUpdate(supabase, taskRunId, stepId, updateData) {
  if (!supabase || !taskRunId || !stepId) {
    console.error('[task-persistence] Cannot persist step update: missing required params');
    return false;
  }

  try {
    const { error } = await supabase
      .from('bob_task_steps')
      .update(updateData)
      .eq('task_run_id', taskRunId)
      .eq('step_id', stepId);

    if (error) {
      console.error('[task-persistence] Failed to update step:', error);
      return false;
    }

    return true;
  } catch (err) {
    console.error('[task-persistence] Step update threw:', err.message);
    return false;
  }
}

async function persistTaskRunUpdate(supabase, taskRunId, updateData) {
  if (!supabase || !taskRunId) {
    console.error('[task-persistence] Cannot persist task run update: missing required params');
    return false;
  }

  try {
    const { error } = await supabase
      .from('bob_task_runs')
      .update(updateData)
      .eq('id', taskRunId);

    if (error) {
      console.error('[task-persistence] Failed to update task run:', error);
      return false;
    }

    return true;
  } catch (err) {
    console.error('[task-persistence] Task run update threw:', err.message);
    return false;
  }
}

/**
 * Claim a pending step for execution: mark as running and persist.
 * Returns { success: bool, step: updated step object }
 */
async function claimStepForExecution(supabase, taskRunId, step) {
  if (!step) return { success: false, step: null };

  const now = new Date().toISOString();
  const updated = {
    status: 'running',
    started_at: now,
    attempt_count: (Number.isInteger(step.attempt_count) ? step.attempt_count : 0) + 1
  };

  const persisted = await persistStepUpdate(supabase, taskRunId, step.step_id, updated);

  if (persisted) {
    return { success: true, step: { ...step, ...updated } };
  }
  return { success: false, step };
}

/**
 * Mark a step completed and persist.
 * Can accept either:
 * - resultSummary + evidenceRefs (legacy format)
 * - toolResult object (new format: auto-sanitizes evidence)
 *
 * Returns { success: bool, step: updated step object }
 */
async function completeStep(supabase, taskRunId, step, resultSummaryOrToolResult, evidenceRefsOrToolName = []) {
  if (!step) return { success: false, step: null };

  const now = new Date().toISOString();

  // Detect format: if resultSummaryOrToolResult looks like a tool result, auto-sanitize
  let resultSummary = resultSummaryOrToolResult;
  let evidenceRefs = evidenceRefsOrToolName;

  if (resultSummaryOrToolResult && typeof resultSummaryOrToolResult === 'object' && resultSummaryOrToolResult.meta) {
    // New format: tool result object
    const toolResult = resultSummaryOrToolResult;
    const toolName = typeof evidenceRefsOrToolName === 'string' ? evidenceRefsOrToolName : 'unknown_tool';

    // Extract summary from reply
    resultSummary = toolResult.reply ? toolResult.reply.slice(0, 1000) : 'Tool completed successfully';

    // Auto-sanitize evidence to remove secrets
    evidenceRefs = sanitizeEvidenceRefs(toolResult, toolName);

    console.log(`[task-persistence] Auto-sanitized evidence from ${toolName}: ${evidenceRefs.length} refs`);
  }

  const updated = {
    status: 'completed',
    completed_at: now,
    result_summary: resultSummary || null,
    error: null,
    evidence_refs: Array.isArray(evidenceRefs) ? evidenceRefs : []
  };

  const persisted = await persistStepUpdate(supabase, taskRunId, step.step_id, updated);

  if (persisted) {
    return { success: true, step: { ...step, ...updated } };
  }
  return { success: false, step };
}

/**
 * Mark a step failed and persist.
 * Returns { success: bool, step: updated step object }
 */
async function failStep(supabase, taskRunId, step, errorMessage, retryable = false) {
  if (!step) return { success: false, step: null };

  const now = new Date().toISOString();
  const updated = {
    status: 'failed',
    error: errorMessage || 'Failed',
    retryable: Boolean(retryable),
    completed_at: now,
    attempt_count: (Number.isInteger(step.attempt_count) ? step.attempt_count : 0) + 1
  };

  const persisted = await persistStepUpdate(supabase, taskRunId, step.step_id, updated);

  if (persisted) {
    return { success: true, step: { ...step, ...updated } };
  }
  return { success: false, step };
}

/**
 * Mark a step blocked and persist.
 * Returns { success: bool, step: updated step object }
 */
async function blockStep(supabase, taskRunId, step, blockedReason) {
  if (!step) return { success: false, step: null };

  const updated = {
    status: 'blocked',
    error: blockedReason || 'Blocked'
  };

  const persisted = await persistStepUpdate(supabase, taskRunId, step.step_id, updated);

  if (persisted) {
    return { success: true, step: { ...step, ...updated } };
  }
  return { success: false, step };
}

/**
 * Update task run checkpoint and metadata after steps change.
 * Typically called after a step completes/fails to refresh next_step_id and indices.
 * Returns { success: bool }
 */
async function updateTaskRunCheckpoint(supabase, taskRunId, checkpointData) {
  if (!checkpointData) return { success: false };

  const update = {
    current_step_index: checkpointData.current_step_index ?? 0,
    last_verified_at: new Date().toISOString()
  };

  const persisted = await persistTaskRunUpdate(supabase, taskRunId, update);
  return { success: persisted };
}

module.exports = {
  persistStepUpdate,
  persistTaskRunUpdate,
  claimStepForExecution,
  completeStep,
  failStep,
  blockStep,
  updateTaskRunCheckpoint
};
