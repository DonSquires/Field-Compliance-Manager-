const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createTaskRun,
  getNextResumeStep,
  buildTaskCheckpoint,
  resumeTaskRun
} = require('../supabase/functions/_shared/task-ledger.js');

test('createTaskRun builds a resumable ledger with ordered step records', () => {
  const result = createTaskRun({
    taskId: 'repo-audit-001',
    conversationId: '11111111-1111-4111-8111-111111111111',
    organizationId: '22222222-2222-4222-8222-222222222222',
    goal: 'Audit the repo for the new shell and access gates',
    steps: [
      { stepId: 'scan-entry-points', requestedOperation: 'Identify entry points', status: 'completed' },
      { stepId: 'read-shell', requestedOperation: 'Read app shell', status: 'pending' },
      { stepId: 'read-auth-gates', requestedOperation: 'Read auth gates', status: 'blocked', error: 'waiting for shell evidence' }
    ]
  });

  assert.equal(result.task.task_id, 'repo-audit-001');
  assert.equal(result.task.total_steps, 3);
  assert.equal(result.steps[0].ordinal_position, 1);
  assert.equal(result.steps[1].status, 'pending');
  assert.equal(result.steps[2].status, 'blocked');
});

test('getNextResumeStep resumes at the first pending or retryable failed step, not the end of the task', () => {
  const task = {
    status: 'paused',
    current_step_index: 1,
    total_steps: 4
  };

  const step = getNextResumeStep(task, [
    { step_id: 's1', status: 'completed' },
    { step_id: 's2', status: 'completed' },
    { step_id: 's3', status: 'failed', retryable: true },
    { step_id: 's4', status: 'pending' }
  ]);

  assert.equal(step.step_id, 's3');
});

test('buildTaskCheckpoint returns a compact checkpoint with completed IDs and next step', () => {
  const checkpoint = buildTaskCheckpoint({
    status: 'paused',
    current_step_index: 2,
    total_steps: 3,
    last_error: 'timeout while reading shell'
  }, [
    { step_id: 's1', status: 'completed', evidence_refs: ['file:src/app.ts'] },
    { step_id: 's2', status: 'completed', evidence_refs: ['file:src/router.ts'] },
    { step_id: 's3', status: 'blocked', error: 'waiting for auth evidence', evidence_refs: [] }
  ]);

  assert.deepEqual(checkpoint.completed_step_ids, ['s1', 's2']);
  assert.equal(checkpoint.next_step_id, 's3');
  assert.equal(checkpoint.blocked_reason, 'waiting for auth evidence');
  assert.equal(checkpoint.progress_unverified, false);
});

test('resumeTaskRun fails closed when the task ledger cannot be trusted', () => {
  const result = resumeTaskRun(null, null);
  assert.equal(result.progress_unverified, true);
  assert.equal(result.next_step_id, null);
});
