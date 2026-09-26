const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseIndependentCodeReview,
  runIndependentCodeReview
} = require('../supabase/functions/_shared/builder-independent-code-review');

function report() {
  return {
    verdict: 'passed',
    summary: 'No blocking correctness findings',
    findings: [],
    test_gaps: ['Visual regression coverage'],
    residual_risks: []
  };
}

test('independent reviewer parser requires structured severity findings', () => {
  assert.deepEqual(parseIndependentCodeReview(JSON.stringify(report())), report());
  assert.throws(() => parseIndependentCodeReview(JSON.stringify({ ...report(), verdict: 'approve' })), /verdict/);
  assert.throws(() => parseIndependentCodeReview(JSON.stringify({ ...report(), findings: [{ severity: 'urgent' }] })), /severity/);
  // Omitted list fields mean "nothing to report" (the first live reviewer left them out); present non-arrays are still refused.
  const { test_gaps, residual_risks, ...minimal } = report();
  assert.deepEqual(parseIndependentCodeReview(JSON.stringify(minimal)), { ...minimal, test_gaps: [], residual_risks: [] });
  assert.throws(() => parseIndependentCodeReview(JSON.stringify({ ...report(), test_gaps: 'none' })), /test_gaps must be an array/);
  assert.throws(() => parseIndependentCodeReview(JSON.stringify({ ...report(), findings: undefined })), /findings must be an array/);
});

test('independent reviewer states the exact output contract and repairs once on a validation failure', async () => {
  const requests = [];
  let aborted = false;
  const result = await runIndependentCodeReview({
    supabase: {}, gateway: {},
    job: { id: 'job-1', organization_id: 'org-1', target_sha: 'sha-1', code_review_mode: 'independent_ai' },
    step: { id: 'review-step', step_id: 'code_review', builder_mode: 'code_reviewer' },
    artifacts: { patch: { id: 'patch-1' }, manifest: { id: 'manifest-1' }, buildLogs: { id: 'logs-1' }, security: { id: 'security-1' } },
    reviewerModelName: 'reviewer-model',
    loadEvidence: async () => ({ patch: 'diff' }),
    startReview: async () => ({ success: true }),
    executeModelRun: async input => {
      requests.push(input.modelRequest);
      if (requests.length === 1) return { ok: false, status: 422, error: 'model output failed validation: test_gaps must be an array' };
      return { ok: true, validated_output: report(), artifact: { id: 'review-1' }, model_run_id: 'run-review' };
    },
    completeReview: async () => ({ success: true, job: { status: 'security_review', code_review_status: 'passed' } }),
    abortReview: async () => { aborted = true; return { success: true }; }
  });
  assert.equal(requests.length, 2);
  assert.match(requests[0].request.system_prompt, /"test_gaps": \[string\]/);
  assert.match(requests[1].request.system_prompt, /previous reply was rejected: model output failed validation: test_gaps must be an array/);
  assert.equal(requests[1].idempotency_key, `${requests[0].idempotency_key}::repair`);
  assert.equal(aborted, false);
  assert.equal(result.job.code_review_status, 'passed');
});

test('independent reviewer uses a distinct configured model and cannot approve release', async () => {
  let captured;
  const result = await runIndependentCodeReview({
    supabase: {}, gateway: {},
    job: { id: 'job-1', organization_id: 'org-1', target_sha: 'sha-1', code_review_mode: 'independent_ai' },
    step: { id: 'review-step', step_id: 'code_review', builder_mode: 'code_reviewer' },
    artifacts: { patch: { id: 'patch-1' }, manifest: { id: 'manifest-1' }, buildLogs: { id: 'logs-1' }, security: { id: 'security-1' } },
    reviewerModelName: 'reviewer-model',
    loadEvidence: async () => ({ patch: 'diff', manifest: [], buildLogs: { succeeded: true }, security: { passed: true } }),
    startReview: async () => ({ success: true }),
    executeModelRun: async input => {
      captured = input;
      return { ok: true, validated_output: report(), artifact: { id: 'review-1' }, model_run_id: 'run-review' };
    },
    completeReview: async () => ({ success: true, job: { status: 'security_review', code_review_status: 'passed' } }),
    abortReview: async () => ({ success: true })
  });
  assert.equal(captured.modelRequest.model_name, 'reviewer-model');
  assert.equal(captured.modelRequest.request.builder_mode, 'code_reviewer');
  assert.doesNotMatch(captured.modelRequest.request.system_prompt, /approve release/i);
  assert.equal(result.job.code_review_status, 'passed');
});

test('independent reviewer snapshots both frontend and backend evidence sets', async () => {
  let capturedIds;
  await runIndependentCodeReview({
    supabase: {}, gateway: {},
    job: { id: 'job-1', organization_id: 'org-1', target_sha: 'sha-1', code_review_mode: 'independent_ai' },
    step: { id: 'review-step', step_id: 'code_review', builder_mode: 'code_reviewer' },
    artifacts: {
      patch: [{ id: 'frontend-patch' }, { id: 'backend-patch' }],
      manifest: [{ id: 'frontend-manifest' }, { id: 'backend-manifest' }],
      buildLogs: [{ id: 'frontend-logs' }, { id: 'backend-logs' }],
      security: { id: 'security-1' }
    },
    reviewerModelName: 'reviewer-model',
    loadEvidence: async () => ({ patches: ['frontend', 'backend'], manifests: [[], []], buildLogs: [{}, {}], security: {} }),
    startReview: async (_client, _job, _step, ids) => { capturedIds = ids; return { success: true }; },
    executeModelRun: async () => ({ ok: true, validated_output: report(), artifact: { id: 'review-1' }, model_run_id: 'review-run' }),
    completeReview: async () => ({ success: true, job: { status: 'security_review' } })
  });
  assert.deepEqual(capturedIds, [
    'frontend-patch', 'backend-patch', 'frontend-manifest', 'backend-manifest',
    'frontend-logs', 'backend-logs', 'security-1'
  ]);
});

test('independent reviewer aborts durable state when model execution fails', async () => {
  let aborted = false;
  const result = await runIndependentCodeReview({
    supabase: {}, gateway: {},
    job: { id: 'job-1', organization_id: 'org-1', target_sha: 'sha-1', code_review_mode: 'independent_ai' },
    step: { id: 'review-step', step_id: 'code_review', builder_mode: 'code_reviewer' },
    artifacts: { patch: { id: 'patch-1' }, manifest: { id: 'manifest-1' }, buildLogs: { id: 'logs-1' }, security: { id: 'security-1' } },
    reviewerModelName: 'reviewer-model',
    startReview: async () => ({ success: true }),
    loadEvidence: async () => ({}),
    executeModelRun: async () => ({ ok: false, error: 'gateway unavailable' }),
    abortReview: async () => { aborted = true; return { success: true }; }
  });
  assert.equal(result.ok, false);
  assert.equal(aborted, true);
});