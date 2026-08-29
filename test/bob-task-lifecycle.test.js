const assert = require('node:assert/strict');
const test = require('node:test');
const {
  getCurrentPendingStep
} = require('../supabase/functions/_shared/task-lifecycle.js');

test('getCurrentPendingStep finds pending steps in priority order', () => {
  const steps = [
    { id: 's1', step_id: 'step-1', status: 'completed' },
    { id: 's2', step_id: 'step-2', status: 'failed', retryable: true },
    { id: 's3', step_id: 'step-3', status: 'pending' }
  ];

  const claimed = getCurrentPendingStep(steps);
  assert.equal(claimed.step_id, 'step-2', 'should prioritize retryable-failed over pending');
});

test('getCurrentPendingStep falls back to pending if no retryable steps', () => {
  const steps = [
    { id: 's1', step_id: 'step-1', status: 'completed' },
    { id: 's2', step_id: 'step-2', status: 'failed', retryable: false },
    { id: 's3', step_id: 'step-3', status: 'pending' }
  ];

  const claimed = getCurrentPendingStep(steps);
  assert.equal(claimed.step_id, 'step-3');
});

test('getCurrentPendingStep returns null when no work remains', () => {
  const steps = [
    { id: 's1', step_id: 'step-1', status: 'completed' },
    { id: 's2', step_id: 'step-2', status: 'completed' }
  ];

  const claimed = getCurrentPendingStep(steps);
  assert.equal(claimed, null);
});
