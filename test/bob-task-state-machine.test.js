const assert = require('node:assert/strict');
const test = require('node:test');
const {
  markStepRunning,
  markStepCompleted,
  markStepFailed,
  markStepBlocked,
  claimNextPendingStep,
  getTaskCheckpoint
} = require('../supabase/functions/_shared/task-state-machine.js');

test('task state machine marks steps through their lifecycle', () => {
  const step = {
    step_id: 'read-shell',
    status: 'pending',
    attempt_count: 0,
    error: null,
    retryable: true
  };

  const running = markStepRunning(step);
  assert.equal(running.status, 'running');
  assert.ok(running.started_at);

  const completed = markStepCompleted(running, 'Successfully read AdminShell.tsx');
  assert.equal(completed.status, 'completed');
  assert.ok(completed.completed_at);
  assert.equal(completed.result_summary, 'Successfully read AdminShell.tsx');
});

test('markStepFailed increments attempt count and can mark retryable', () => {
  const step = {
    step_id: 'resolve-geofence',
    status: 'running',
    attempt_count: 1,
    error: null,
    retryable: true
  };

  const failed = markStepFailed(step, 'Timeout calling geofence API', true);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.attempt_count, 2);
  assert.equal(failed.error, 'Timeout calling geofence API');
  assert.equal(failed.retryable, true);
});

test('markStepBlocked stops progress and records why', () => {
  const step = {
    step_id: 'read-auth-gates',
    status: 'pending',
    error: null
  };

  const blocked = markStepBlocked(step, 'Waiting for shell evidence from step 1');
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.error, 'Waiting for shell evidence from step 1');
});

test('claimNextPendingStep finds first unstarted step in order', () => {
  const steps = [
    { step_id: 's1', status: 'completed', ordinal_position: 1 },
    { step_id: 's2', status: 'failed', ordinal_position: 2 },
    { step_id: 's3', status: 'pending', ordinal_position: 3 },
    { step_id: 's4', status: 'pending', ordinal_position: 4 }
  ];

  const claimed = claimNextPendingStep(steps);
  assert.equal(claimed.step_id, 's3');
});

test('getTaskCheckpoint computes progress from step array', () => {
  const steps = [
    { step_id: 's1', status: 'completed', ordinal_position: 1, evidence_refs: ['file:X'] },
    { step_id: 's2', status: 'completed', ordinal_position: 2, evidence_refs: [] },
    { step_id: 's3', status: 'running', ordinal_position: 3, error: null },
    { step_id: 's4', status: 'pending', ordinal_position: 4, error: null }
  ];

  const checkpoint = getTaskCheckpoint(steps);
  assert.deepEqual(checkpoint.completed_step_ids, ['s1', 's2']);
  assert.equal(checkpoint.next_step_id, 's3');
  assert.equal(checkpoint.progress_percent, 50);
});
