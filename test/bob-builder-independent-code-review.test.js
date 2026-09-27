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

test('a review that restates the author or reports nothing on a substantive patch is rejected (live job 79b4c08f: 7B reviewer passed a dead data path)', async () => {
  const author = 'Added a chat cancel_builder_job tool with caller-scoped ID or exact-title lookup, an exact-target-and-reason preview, and a second-turn confirmation gate. Confirmed cancellations call builder_cancel_job through the requester’s Supabase client; missing, ambiguous, declined, repeat/finished, and unverifiable outcomes receive distinct responses. Added caddie metadata and contract tests.';
  const parroted = { verdict: 'passed', summary: `The patch adds a new 'cancel_builder_job' tool with caller-scoped ID or exact-title lookup, an exact-target-and-reason preview, and a second-turn confirmation gate. Confirmed cancellations call builder_cancel_job through the requester’s Supabase client; missing, ambiguous, declined, repeat/finished, and unverifiable outcomes receive distinct responses. Added caddie metadata and contract tests.`, findings: [], test_gaps: [], residual_risks: [] };
  const context = { authorSummaries: [author], addedLines: 62 };
  assert.throws(() => parseIndependentCodeReview(JSON.stringify(parroted), context), /restates the author/);

  const hollow = { ...parroted, summary: 'I read the diff: the new switch case, the allowlist entries and the regex tests all look consistent with the laptop_shell precedent.' };
  assert.throws(() => parseIndependentCodeReview(JSON.stringify(hollow), context), /reports nothing at all on a 62-line patch/);
  // Small patches may honestly have nothing to report; a real observation makes a big one acceptable.
  assert.equal(parseIndependentCodeReview(JSON.stringify(hollow), { ...context, addedLines: 12 }).verdict, 'passed');
  const engaged = { ...hollow, residual_risks: ['builder_jobs is read with the caller client; RLS on that table admits only the service role, so the lookup may return no rows for a real user'] };
  assert.equal(parseIndependentCodeReview(JSON.stringify(engaged), context).verdict, 'passed');
  assert.equal(parseIndependentCodeReview(JSON.stringify(engaged)).verdict, 'passed', 'no context = the shape checks only');

  // The run wires the evidence into the validator, and the prompt asks for data-path checks in the reviewer's own words.
  let validator = null;
  const requests = [];
  await runIndependentCodeReview({
    supabase: {}, gateway: {},
    job: { id: 'job-2', organization_id: 'org-1', target_sha: 'sha-1', code_review_mode: 'independent_ai' },
    step: { id: 'review-step', step_id: 'code_review', builder_mode: 'code_reviewer' },
    artifacts: { patch: { id: 'patch-1' }, manifest: { id: 'manifest-1' }, buildLogs: { id: 'logs-1' }, security: { id: 'security-1' } },
    reviewerModelName: 'reviewer-model',
    loadEvidence: async () => ({ patches: [Array.from({ length: 50 }, (_, i) => `+line ${i}`).join('\n')], author_summaries: [author] }),
    startReview: async () => ({ success: true }),
    executeModelRun: async input => { requests.push(input.modelRequest); validator = input.validateOutput; return { ok: true, validated_output: report(), artifact: { id: 'review-2' }, model_run_id: 'run-review' }; },
    completeReview: async () => ({ success: true, job: { status: 'security_review', code_review_status: 'passed' } }),
    abortReview: async () => ({ success: true })
  });
  assert.match(requests[0].request.system_prompt, /row-level security in supabase\/schema.sql is the truth/);
  assert.match(requests[0].request.system_prompt, /do not restate the author/);
  assert.throws(() => validator(JSON.stringify(parroted)), /restates the author/);
  assert.throws(() => validator(JSON.stringify(hollow)), /50-line patch/);
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