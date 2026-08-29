/**
 * _shared/task-state-machine.js -- Pure state transitions for task step lifecycle.
 *
 * These functions are DETERMINISTIC and I/O-free. They take a step object and
 * return the updated step with new status, timestamps, and metadata. They do NOT
 * persist to the database — that is the conductor's responsibility.
 *
 * Step lifecycle:
 *   pending → running → completed/failed
 *   pending → blocked (stuck waiting for evidence)
 *   failed → pending (if retryable, after a retry)
 */

function markStepRunning(step) {
  if (!step || typeof step !== 'object') return step;
  return {
    ...step,
    status: 'running',
    started_at: new Date().toISOString(),
    attempt_count: (Number.isInteger(step.attempt_count) ? step.attempt_count : 0) + 1
  };
}

function markStepCompleted(step, resultSummary) {
  if (!step || typeof step !== 'object') return step;
  return {
    ...step,
    status: 'completed',
    completed_at: new Date().toISOString(),
    result_summary: resultSummary || null,
    error: null
  };
}

function markStepFailed(step, errorMessage, retryable = false) {
  if (!step || typeof step !== 'object') return step;
  return {
    ...step,
    status: 'failed',
    error: errorMessage || 'Failed',
    retryable: Boolean(retryable),
    completed_at: new Date().toISOString(),
    attempt_count: (Number.isInteger(step.attempt_count) ? step.attempt_count : 0) + 1
  };
}

function markStepBlocked(step, blockedReason) {
  if (!step || typeof step !== 'object') return step;
  return {
    ...step,
    status: 'blocked',
    error: blockedReason || 'Blocked'
  };
}

function claimNextPendingStep(steps) {
  if (!Array.isArray(steps)) return null;
  const candidates = steps.map((s, idx) => ({ ...s, index: idx }));

  // Priority order: retryable failed > pending > blocked
  const retryableStep = candidates.find(s => s.status === 'failed' && s.retryable);
  if (retryableStep) return retryableStep;

  const pendingStep = candidates.find(s => s.status === 'pending');
  if (pendingStep) return pendingStep;

  const blockedStep = candidates.find(s => s.status === 'blocked');
  return blockedStep || null;
}

function getTaskCheckpoint(steps) {
  if (!Array.isArray(steps)) {
    return {
      completed_step_ids: [],
      next_step_id: null,
      blocked_reason: null,
      progress_percent: 0,
      total_steps: 0,
      running_step_id: null
    };
  }

  const completed = steps
    .filter(s => s && s.status === 'completed')
    .map(s => s.step_id || s.id || null)
    .filter(Boolean);

  const running = steps.find(s => s && s.status === 'running');
  const blocked = steps.find(s => s && s.status === 'blocked');

  // next_step_id is the currently active step (running if any, else pending)
  const nextStepId = running
    ? running.step_id
    : blocked
      ? blocked.step_id
      : claimNextPendingStep(steps)?.step_id ?? null;

  const totalSteps = steps.length;
  const progressPercent = totalSteps > 0 ? Math.round((completed.length / totalSteps) * 100) : 0;

  return {
    completed_step_ids: completed,
    next_step_id: nextStepId,
    blocked_reason: blocked && blocked.error ? blocked.error : null,
    progress_percent: progressPercent,
    total_steps: totalSteps,
    running_step_id: running ? running.step_id : null
  };
}

function computeTaskStatus(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return 'active';
  }

  const allCompleted = steps.every(s => s.status === 'completed');
  if (allCompleted) return 'completed';

  const hasBlocked = steps.some(s => s.status === 'blocked');
  if (hasBlocked) return 'paused';

  const hasRunning = steps.some(s => s.status === 'running');
  if (hasRunning) return 'running';

  return 'active';
}

module.exports = {
  markStepRunning,
  markStepCompleted,
  markStepFailed,
  markStepBlocked,
  claimNextPendingStep,
  getTaskCheckpoint,
  computeTaskStatus
};
