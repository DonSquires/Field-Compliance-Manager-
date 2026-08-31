import { sanitizeEvidenceRefs } from './evidence-sanitizer.ts';

async function updateStep(supabase: any, taskRunId: string, stepId: string, values: Record<string, unknown>) {
  const { error } = await supabase.from('bob_task_steps').update(values).eq('task_run_id', taskRunId).eq('step_id', stepId);
  return !error;
}
export async function claimStepForExecution(supabase: any, taskRunId: string, step: any) {
  if (!step) return { success: false, step: null };
  const values = { status: 'running', started_at: new Date().toISOString(), attempt_count: (Number.isInteger(step.attempt_count) ? step.attempt_count : 0) + 1 };
  return (await updateStep(supabase, taskRunId, step.step_id, values)) ? { success: true, step: { ...step, ...values } } : { success: false, step };
}
export async function completeStep(supabase: any, taskRunId: string, step: any, summary: string, evidence: unknown[] = []) {
  if (!step) return { success: false, step: null };
  const values = { status: 'completed', completed_at: new Date().toISOString(), result_summary: summary || null, error: null, evidence_refs: Array.isArray(evidence) ? evidence : [] };
  return (await updateStep(supabase, taskRunId, step.step_id, values)) ? { success: true, step: { ...step, ...values } } : { success: false, step };
}
export async function failStep(supabase: any, taskRunId: string, step: any, error: string, retryable = false) {
  if (!step) return { success: false, step: null };
  const values = { status: 'failed', error: error || 'Failed', retryable: Boolean(retryable), completed_at: new Date().toISOString(), attempt_count: (Number.isInteger(step.attempt_count) ? step.attempt_count : 0) + 1 };
  return (await updateStep(supabase, taskRunId, step.step_id, values)) ? { success: true, step: { ...step, ...values } } : { success: false, step };
}
export async function blockStep(supabase: any, taskRunId: string, step: any, error: string) {
  if (!step) return { success: false, step: null };
  const values = { status: 'blocked', error: error || 'Blocked' };
  return (await updateStep(supabase, taskRunId, step.step_id, values)) ? { success: true, step: { ...step, ...values } } : { success: false, step };
}
export { sanitizeEvidenceRefs };