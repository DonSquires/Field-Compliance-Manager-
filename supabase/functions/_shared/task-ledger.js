function normalizeTask(task) {
  if (!task || typeof task !== 'object') return null;
  return {
    task_id: task.task_id || task.id || null,
    conversation_id: task.conversation_id || null,
    organization_id: task.organization_id || null,
    goal: task.goal || '',
    status: task.status || 'active',
    current_step_index: Number.isInteger(task.current_step_index) ? task.current_step_index : 0,
    total_steps: Number.isInteger(task.total_steps) ? task.total_steps : 0,
    last_verified_at: task.last_verified_at || null,
    last_error: task.last_error || null
  };
}

function normalizeStep(step, index) {
  if (!step || typeof step !== 'object') return null;
  const status = step.status || 'pending';
  return {
    step_id: step.step_id || step.id || `step-${index + 1}`,
    ordinal_position: Number.isInteger(step.ordinal_position) ? step.ordinal_position : index + 1,
    requested_operation: step.requested_operation || step.action || `Step ${index + 1}`,
    normalized_tool: step.normalized_tool || null,
    normalized_args: step.normalized_args || {},
    status,
    attempt_count: Number.isInteger(step.attempt_count) ? step.attempt_count : 0,
    started_at: step.started_at || null,
    completed_at: step.completed_at || null,
    result_summary: step.result_summary || null,
    evidence_refs: Array.isArray(step.evidence_refs) ? step.evidence_refs : [],
    error: step.error || null,
    retryable: Boolean(step.retryable),
    created_at: step.created_at || null,
    updated_at: step.updated_at || null
  };
}

function createTaskRun({ taskId, conversationId, organizationId, goal, steps = [] }) {
  const task = normalizeTask({
    task_id: taskId,
    conversation_id: conversationId,
    organization_id: organizationId,
    goal,
    status: 'active',
    current_step_index: 0,
    total_steps: steps.length
  });

  if (!task) {
    throw new Error('task is required');
  }

  const normalizedSteps = steps.map((step, index) => normalizeStep(step, index));
  return {
    task,
    steps: normalizedSteps
  };
}

function getNextResumeStep(task, steps) {
  const normalizedTask = normalizeTask(task);
  if (!normalizedTask || !Array.isArray(steps) || steps.length === 0) {
    return null;
  }

  const candidates = steps.map((step, index) => ({
    ...normalizeStep(step, index),
    index
  }));

  const retryable = candidates.find(step => step.status === 'failed' && step.retryable);
  if (retryable) return retryable;

  const pending = candidates.find(step => step.status === 'pending');
  if (pending) return pending;

  return candidates.find(step => step.status === 'blocked') || null;
}

function buildTaskCheckpoint(task, steps) {
  const normalizedTask = normalizeTask(task);
  if (!normalizedTask) {
    return {
      completed_step_ids: [],
      next_step_id: null,
      blocked_reason: null,
      progress_unverified: true,
      last_error: null,
      current_step_index: 0,
      total_steps: 0
    };
  }

  const completed = (steps || [])
    .filter(step => step && step.status === 'completed')
    .map(step => step.step_id || step.id || null)
    .filter(Boolean);

  const nextStep = getNextResumeStep(normalizedTask, steps || []);
  const blockedStep = (steps || []).find(step => step && step.status === 'blocked');
  return {
    completed_step_ids: completed,
    next_step_id: nextStep ? nextStep.step_id : null,
    blocked_reason: blockedStep && blockedStep.error ? blockedStep.error : null,
    progress_unverified: false,
    last_error: normalizedTask.last_error || null,
    current_step_index: normalizedTask.current_step_index,
    total_steps: normalizedTask.total_steps
  };
}

function resumeTaskRun(task, steps) {
  const normalizedTask = normalizeTask(task);
  if (!normalizedTask || !Array.isArray(steps)) {
    return {
      progress_unverified: true,
      next_step_id: null,
      reason: 'task ledger unavailable or unreadable'
    };
  }

  const nextStep = getNextResumeStep(normalizedTask, steps);
  return {
    progress_unverified: false,
    next_step_id: nextStep ? nextStep.step_id : null,
    reason: nextStep ? 'resume from next pending/retryable step' : 'task complete'
  };
}

module.exports = {
  normalizeTask,
  normalizeStep,
  createTaskRun,
  getNextResumeStep,
  buildTaskCheckpoint,
  resumeTaskRun
};
