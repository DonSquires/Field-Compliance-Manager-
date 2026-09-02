/** ESM/Edge-runtime version of task-state-machine.js. */

function markStepRunning(step: any) {
  if (!step || typeof step !== 'object') return step;
  return {
    ...step,
    status: 'running',
    started_at: new Date().toISOString(),
    attempt_count: (Number.isInteger(step.attempt_count) ? step.attempt_count : 0) + 1
  };
}

function markStepCompleted(step: any, resultSummary: string) {
  if (!step || typeof step !== 'object') return step;
  return { ...step, status: 'completed', completed_at: new Date().toISOString(), result_summary: resultSummary || null, error: null };
}

function markStepFailed(step: any, errorMessage: string, retryable = false) {
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

function markStepBlocked(step: any, blockedReason: string) {
  if (!step || typeof step !== 'object') return step;
  return { ...step, status: 'blocked', error: blockedReason || 'Blocked' };
}

function claimNextPendingStep(steps: any[]) {
  if (!Array.isArray(steps)) return null;
  const candidates = steps.map((step, index) => ({ ...step, index }));
  return candidates.find((step) => step.status === 'failed' && step.retryable)
    || candidates.find((step) => step.status === 'pending')
    || candidates.find((step) => step.status === 'blocked')
    || null;
}

function getTaskCheckpoint(steps: any[]) {
  if (!Array.isArray(steps)) {
    return { completed_step_ids: [], next_step_id: null, blocked_reason: null, progress_percent: 0, total_steps: 0, running_step_id: null };
  }

  const completed = steps.filter((step) => step && step.status === 'completed').map((step) => step.step_id || step.id || null).filter(Boolean);
  const running = steps.find((step) => step && step.status === 'running');
  const blocked = steps.find((step) => step && step.status === 'blocked');
  const nextStepId = running ? running.step_id : blocked ? blocked.step_id : claimNextPendingStep(steps)?.step_id ?? null;
  const totalSteps = steps.length;

  return {
    completed_step_ids: completed,
    next_step_id: nextStepId,
    blocked_reason: blocked && blocked.error ? blocked.error : null,
    progress_percent: totalSteps > 0 ? Math.round((completed.length / totalSteps) * 100) : 0,
    total_steps: totalSteps,
    running_step_id: running ? running.step_id : null
  };
}

function computeTaskStatus(steps: any[]) {
  if (!Array.isArray(steps) || steps.length === 0) return 'active';
  if (steps.every((step) => step.status === 'completed')) return 'completed';
  if (steps.some((step) => step.status === 'blocked')) return 'paused';
  if (steps.some((step) => step.status === 'running')) return 'running';
  return 'active';
}

export { markStepRunning, markStepCompleted, markStepFailed, markStepBlocked, claimNextPendingStep, getTaskCheckpoint, computeTaskStatus };
