/**
 * ESM/Edge-runtime version of task-persistence.js.
 * All I/O is failure-open: errors are logged but do not halt the Bob turn.
 */

import { sanitizeEvidenceRefs } from './evidence-sanitizer.ts';

async function persistStepUpdate(supabase: any, taskRunId: string, stepId: string, updateData: Record<string, unknown>) {
  if (!supabase || !taskRunId || !stepId) {
    console.error('[task-persistence] Cannot persist step update: missing required params');
    return false;
  }

  try {
    const { error } = await supabase.from('bob_task_steps').update(updateData).eq('task_run_id', taskRunId).eq('step_id', stepId);
    if (error) {
      console.error('[task-persistence] Failed to update step:', error);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[task-persistence] Step update threw:', err instanceof Error ? err.message : String(err));
    return false;
  }
}

async function persistTaskRunUpdate(supabase: any, taskRunId: string, updateData: Record<string, unknown>) {
  if (!supabase || !taskRunId) {
    console.error('[task-persistence] Cannot persist task run update: missing required params');
    return false;
  }

  try {
    const { error } = await supabase.from('bob_task_runs').update(updateData).eq('id', taskRunId);
    if (error) {
      console.error('[task-persistence] Failed to update task run:', error);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[task-persistence] Task run update threw:', err instanceof Error ? err.message : String(err));
    return false;
  }
}

async function claimStepForExecution(supabase: any, taskRunId: string, step: any) {
  if (!step) return { success: false, step: null };

  const now = new Date().toISOString();
  const updated = {
    status: 'running',
    started_at: now,
    attempt_count: (Number.isInteger(step.attempt_count) ? step.attempt_count : 0) + 1
  };

  const persisted = await persistStepUpdate(supabase, taskRunId, step.step_id, updated);
  return persisted ? { success: true, step: { ...step, ...updated } } : { success: false, step };
}

async function completeStep(supabase: any, taskRunId: string, step: any, resultSummaryOrToolResult: any, evidenceRefsOrToolName: any = []) {
  if (!step) return { success: false, step: null };

  const now = new Date().toISOString();
  let resultSummary = resultSummaryOrToolResult;
  let evidenceRefs = evidenceRefsOrToolName;

  if (resultSummaryOrToolResult && typeof resultSummaryOrToolResult === 'object' && resultSummaryOrToolResult.meta) {
    const toolResult = resultSummaryOrToolResult;
    const toolName = typeof evidenceRefsOrToolName === 'string' ? evidenceRefsOrToolName : 'unknown_tool';
    resultSummary = toolResult.reply ? String(toolResult.reply).slice(0, 1000) : 'Tool completed successfully';
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
  return persisted ? { success: true, step: { ...step, ...updated } } : { success: false, step };
}

async function failStep(supabase: any, taskRunId: string, step: any, errorMessage: string, retryable = false) {
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
  return persisted ? { success: true, step: { ...step, ...updated } } : { success: false, step };
}

async function blockStep(supabase: any, taskRunId: string, step: any, blockedReason: string) {
  if (!step) return { success: false, step: null };

  const updated = { status: 'blocked', error: blockedReason || 'Blocked' };
  const persisted = await persistStepUpdate(supabase, taskRunId, step.step_id, updated);
  return persisted ? { success: true, step: { ...step, ...updated } } : { success: false, step };
}

async function updateTaskRunCheckpoint(supabase: any, taskRunId: string, checkpointData: any) {
  if (!checkpointData) return { success: false };

  const update = {
    current_step_index: checkpointData.current_step_index ?? 0,
    last_verified_at: new Date().toISOString()
  };

  const persisted = await persistTaskRunUpdate(supabase, taskRunId, update);
  return { success: persisted };
}

export { persistStepUpdate, persistTaskRunUpdate, claimStepForExecution, completeStep, failStep, blockStep, updateTaskRunCheckpoint };
