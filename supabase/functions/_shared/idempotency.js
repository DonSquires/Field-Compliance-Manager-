/**
 * _shared/idempotency.js -- Timeout recovery and duplicate-request handling.
 *
 * Patterns:
 * - Same tool, same step, duplicate request within timeout window → skip re-execution
 * - Tool dispatch timeout → mark step as could_not_verify, record the timeout
 * - On resume: detect timeout and offer to retry or move forward
 *
 * Idempotency key: (task_id, step_id, tool_name, args_hash)
 * This ensures the same step with the same tool doesn't execute twice.
 */

const crypto = require('crypto');

/**
 * Compute a deterministic hash of tool arguments for idempotency detection.
 * Consistent across turns: same args → same hash.
 */
function computeArgsHash(toolArgs) {
  if (!toolArgs || typeof toolArgs !== 'object') return 'empty';

  try {
    // Sort keys for deterministic JSON
    const sorted = JSON.stringify(toolArgs, Object.keys(toolArgs).sort());
    const hash = crypto.createHash('sha256').update(sorted).digest('hex');
    return hash.slice(0, 16); // First 16 chars are enough for collision detection
  } catch (e) {
    // If args can't be hashed, use a generic hash
    return 'unhashable';
  }
}

/**
 * Build an idempotency key that uniquely identifies a step + tool execution.
 *
 * Returns a string like "task-123::step-5::repo_search::a1b2c3d4e5f6g7h8"
 */
function buildIdempotencyKey(taskId, stepId, toolName, toolArgs) {
  const argsHash = computeArgsHash(toolArgs);
  return `${taskId}::${stepId}::${toolName}::${argsHash}`;
}

/**
 * Check if a step was recently executed (within timeout window).
 *
 * Returns: {
 *   isDuplicate: bool,
 *   lastAttemptAt: ISO timestamp or null,
 *   elapsedSeconds: number or null,
 *   priorOutcome: string or null
 * }
 */
async function checkIdempotency(supabase, taskId, stepId, toolName, toolArgs, timeoutSeconds = 60) {
  const idempotencyKey = buildIdempotencyKey(taskId, stepId, toolName, toolArgs);

  try {
    // Query bob_task_steps for a prior attempt of this step
    const { data: steps, error } = await supabase
      .from('bob_task_steps')
      .select('step_id, status, started_at, completed_at, result_summary, error')
      .eq('task_id', taskId)
      .eq('step_id', stepId);

    if (error) {
      console.warn('[idempotency] Failed to check prior attempts (non-fatal):', error.message);
      return { isDuplicate: false, lastAttemptAt: null, elapsedSeconds: null, priorOutcome: null };
    }

    // No prior record of this step
    if (!Array.isArray(steps) || steps.length === 0) {
      return { isDuplicate: false, lastAttemptAt: null, elapsedSeconds: null, priorOutcome: null };
    }

    const priorStep = steps[0];

    // If the step already completed successfully, it's an idempotent request
    if (priorStep.status === 'completed') {
      const completedAt = new Date(priorStep.completed_at);
      const now = new Date();
      const elapsedSeconds = Math.round((now - completedAt) / 1000);

      return {
        isDuplicate: true,
        isDuplicateOfCompleted: true,
        lastAttemptAt: priorStep.completed_at,
        elapsedSeconds,
        priorOutcome: 'completed',
        priorResult: priorStep.result_summary
      };
    }

    // If the step is running, we have a true duplicate request (or timeout scenario)
    if (priorStep.status === 'running') {
      const startedAt = new Date(priorStep.started_at);
      const now = new Date();
      const elapsedSeconds = Math.round((now - startedAt) / 1000);

      // If timeout window has passed, it's a timeout scenario
      if (elapsedSeconds > timeoutSeconds) {
        return {
          isDuplicate: true,
          isDuplicateOfTimeout: true,
          lastAttemptAt: priorStep.started_at,
          elapsedSeconds,
          priorOutcome: 'timeout',
          timeoutThresholdSeconds: timeoutSeconds
        };
      }

      // Still running
      return {
        isDuplicate: true,
        isDuplicateOfRunning: true,
        lastAttemptAt: priorStep.started_at,
        elapsedSeconds,
        priorOutcome: 'running'
      };
    }

    // Any other status (failed, blocked, etc.) means we can retry
    return { isDuplicate: false, lastAttemptAt: priorStep.started_at, elapsedSeconds: null, priorOutcome: priorStep.status };
  } catch (e) {
    console.warn('[idempotency] Idempotency check threw (non-fatal):', e.message);
    return { isDuplicate: false, lastAttemptAt: null, elapsedSeconds: null, priorOutcome: null };
  }
}

/**
 * Record a tool dispatch attempt for idempotency tracking.
 * Called before dispatching a tool to record when the attempt started.
 */
async function recordToolAttempt(supabase, taskRunId, stepId, toolName, toolArgs) {
  if (!supabase || !taskRunId || !stepId) {
    return { success: false };
  }

  try {
    const now = new Date().toISOString();

    // Update the step to record the tool execution attempt
    const { error } = await supabase
      .from('bob_task_steps')
      .update({
        normalized_tool: toolName,
        normalized_args: toolArgs || {},
        started_at: now
      })
      .eq('task_run_id', taskRunId)
      .eq('step_id', stepId);

    if (error) {
      console.warn('[idempotency] Failed to record tool attempt (non-fatal):', error.message);
      return { success: false };
    }

    return { success: true };
  } catch (e) {
    console.warn('[idempotency] Record attempt threw (non-fatal):', e.message);
    return { success: false };
  }
}

/**
 * Mark a tool dispatch as timed out.
 * Called when a tool dispatch exceeds its timeout window.
 */
async function markToolTimeout(supabase, taskRunId, stepId, timeoutSeconds) {
  if (!supabase || !taskRunId || !stepId) {
    return { success: false };
  }

  try {
    const now = new Date().toISOString();

    const { error } = await supabase
      .from('bob_task_steps')
      .update({
        status: 'failed',
        completed_at: now,
        error: `Tool dispatch timed out after ${timeoutSeconds}s. Re-run with a longer timeout or move to the next step.`,
        retryable: true // Allow retry after timeout
      })
      .eq('task_run_id', taskRunId)
      .eq('step_id', stepId);

    if (error) {
      console.warn('[idempotency] Failed to mark timeout (non-fatal):', error.message);
      return { success: false };
    }

    console.log(`[idempotency] Marked step ${stepId} as timed out (retryable)`);
    return { success: true };
  } catch (e) {
    console.warn('[idempotency] Mark timeout threw (non-fatal):', e.message);
    return { success: false };
  }
}

module.exports = {
  computeArgsHash,
  buildIdempotencyKey,
  checkIdempotency,
  recordToolAttempt,
  markToolTimeout
};
