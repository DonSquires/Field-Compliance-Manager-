export function getTaskCheckpoint(steps: any[]) {
  const safeSteps = Array.isArray(steps) ? steps : [];
  const completed = safeSteps.filter(step => step?.status === 'completed').map(step => step.step_id || step.id).filter(Boolean);
  const running = safeSteps.find(step => step?.status === 'running');
  const blocked = safeSteps.find(step => step?.status === 'blocked');
  const retryable = safeSteps.find(step => step?.status === 'failed' && step.retryable);
  const pending = safeSteps.find(step => step?.status === 'pending');
  const next = running || blocked || retryable || pending || null;
  return { completed_step_ids: completed, next_step_id: next?.step_id ?? null, blocked_reason: blocked?.error ?? null, progress_percent: safeSteps.length ? Math.round((completed.length / safeSteps.length) * 100) : 0, total_steps: safeSteps.length, running_step_id: running?.step_id ?? null };
}