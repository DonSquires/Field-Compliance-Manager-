const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_REVIEW_EVIDENCE_CHARS,
  parseIndependentCodeReview,
  runIndependentCodeReview,
  summarizeBuildLog
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

test('independent reviewer replaces verbose verification output with bounded digest-bound receipts', () => {
  const bytes = Buffer.from(JSON.stringify({
    succeeded: true,
    commands: [{
      command: 'npm run test --prefix apps/web',
      status: 0,
      stdout: `start\n${'x'.repeat(20_000)}\n42 tests passed`,
      stderr: `warning\n${'y'.repeat(20_000)}\nnon-failing diagnostic`,
      error: null
    }],
    baseline_failure: false,
    e2e_selection: { targeted: ['e2e/builder-control-room.spec.ts'], project: 'desktop-chromium' }
  }));

  const summary = summarizeBuildLog(bytes);
  assert.equal(summary.succeeded, true);
  assert.equal(summary.artifact_bytes, bytes.length);
  assert.match(summary.artifact_sha256, /^[a-f0-9]{64}$/);
  assert.equal(summary.commands[0].exit_code, 0);
  assert.ok(summary.commands[0].stdout_tail.length <= 603);
  assert.match(summary.commands[0].stdout_tail, /42 tests passed$/);
  assert.ok(summary.commands[0].stderr_tail.length <= 603);
  assert.match(summary.commands[0].stderr_tail, /non-failing diagnostic$/);
  assert.ok(JSON.stringify(summary).length < 3_000);
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

test('a review re-open hands the reviewer the previous round\'s review and asks for a revision check, so rounds converge', async () => {
  const { loadPreviousReview } = require('../supabase/functions/_shared/builder-independent-code-review');
  const previous = { verdict: 'blocked', summary: 'Rejection is not persisted.', findings: [{ severity: 'high', file: 'index.ts', message: 'A negative response does not consume the pending cancellation.' }], test_gaps: ['no behavioural two-turn test'], residual_risks: ['list-to-RPC race'] };
  const supabase = {
    from(name) {
      assert.equal(name, 'builder_artifacts');
      const chain = { select() { return chain; }, eq() { return chain; }, order() { return chain; }, limit: async () => ({ data: [{ id: 'rev-parent', created_at: '2026-09-27T03:40:00Z' }], error: null }), single: async () => ({ data: { id: 'rev-parent', job_id: 'a0379a3d-15c5-49ee-94a5-34cd9ef5961a', artifact_type: 'code_review', status: 'final', storage_location: 'supabase_storage://builder-artifacts/org/a0379a3d/review.json', checksum: 'a'.repeat(64) }, error: null }) };
      return chain;
    },
    storage: { from: () => ({ download: async () => ({ data: { arrayBuffer: async () => Buffer.from(JSON.stringify(previous)) }, error: null }) }) },
  };
  const crypto = require('node:crypto');
  // downloadVerifiedArtifact checks the checksum; make the fake consistent.
  supabase.from = ((original) => (name) => { const chain = original(name); const single = chain.single; chain.single = async () => { const r = await single(); r.data.checksum = crypto.createHash('sha256').update(Buffer.from(JSON.stringify(previous))).digest('hex'); return r; }; return chain; })(supabase.from);

  assert.equal(await loadPreviousReview(supabase, { description: 'Opened by Bob from conversation x' }), null, 'a first attempt has no previous review');
  const loaded = await loadPreviousReview(supabase, { description: "Opened by Bob's autopilot from job a0379a3d-15c5-49ee-94a5-34cd9ef5961a after independent review (round 2 of 2)" });
  assert.equal(loaded.parent_job_id, 'a0379a3d-15c5-49ee-94a5-34cd9ef5961a');
  assert.equal(loaded.round, 2);
  assert.equal(loaded.report.verdict, 'blocked');
  assert.equal(loaded.report.findings[0].message, 'A negative response does not consume the pending cancellation.');

  const requests = [];
  await runIndependentCodeReview({
    supabase: {}, gateway: {},
    job: { id: 'job-3', organization_id: 'org-1', target_sha: 'sha-1', code_review_mode: 'independent_ai', description: "Opened by Bob's autopilot from job a0379a3d-15c5-49ee-94a5-34cd9ef5961a after independent review (round 2 of 2)" },
    step: { id: 'review-step', step_id: 'code_review', builder_mode: 'code_reviewer' },
    artifacts: { patch: { id: 'patch-1' }, manifest: { id: 'manifest-1' }, buildLogs: { id: 'logs-1' }, security: { id: 'security-1' } },
    reviewerModelName: 'reviewer-model',
    loadEvidence: async () => ({ patches: ['+x'], author_summaries: ['s'], previous_review: loaded }),
    startReview: async () => ({ success: true }),
    executeModelRun: async input => { requests.push(input.modelRequest); return { ok: true, validated_output: report(), artifact: { id: 'review-3' }, model_run_id: 'run-review' }; },
    completeReview: async () => ({ success: true, job: { status: 'security_review', code_review_status: 'passed' } }),
    abortReview: async () => ({ success: true })
  });
  assert.match(requests[0].request.system_prompt, /This is a REVISION \(round 2 of 2\)/);
  assert.match(requests[0].request.system_prompt, /Block only for a previous finding that is still unresolved or for a NEW critical\/high defect/);
  assert.match(requests[0].request.user_prompt, /"previous_review":\{"parent_job_id":"a0379a3d/);
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

test('independent reviewer aborts before dispatch when evidence still exceeds its hard prompt budget', async () => {
  let dispatched = false;
  let abortReason = null;
  const result = await runIndependentCodeReview({
    supabase: {}, gateway: {},
    job: { id: 'job-oversize', organization_id: 'org-1', target_sha: 'sha-1', code_review_mode: 'independent_ai' },
    step: { id: 'review-step', step_id: 'code_review', builder_mode: 'code_reviewer' },
    artifacts: { patch: { id: 'patch-1' }, manifest: { id: 'manifest-1' }, buildLogs: { id: 'logs-1' }, security: { id: 'security-1' } },
    reviewerModelName: 'reviewer-model',
    loadEvidence: async () => ({ patches: ['x'.repeat(MAX_REVIEW_EVIDENCE_CHARS + 1)], author_summaries: [] }),
    startReview: async () => ({ success: true }),
    executeModelRun: async () => { dispatched = true; return {}; },
    abortReview: async (_client, _job, _step, reason) => { abortReason = reason; return { success: true }; }
  });
  assert.equal(result.status, 413);
  assert.equal(dispatched, false);
  assert.match(abortReason, /bounded prompt budget/);
});

test('independent reviewer uses a distinct configured model and cannot approve release', async () => {
  let captured;
  const acceptance = { version: 1, passed: true, requirements: [{ requirement_id: 'DR-1',
    outcome: 'Diary-save followed by final-answer failure gives a persisted, truthful receipt' }] };
  const result = await runIndependentCodeReview({
    supabase: {}, gateway: {},
    job: { id: 'job-1', organization_id: 'org-1', target_sha: 'sha-1', code_review_mode: 'independent_ai',
      task_description: 'Handle the entire partial-success workflow', code_review_revision: { feedback: 'Retain the actual failure-path handling, not only the reader' } },
    acceptance,
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
  const packet = JSON.parse(captured.modelRequest.request.user_prompt);
  assert.deepEqual(packet.acceptance, acceptance);
  assert.match(packet.original_task, /entire partial-success/);
  assert.match(packet.correction_feedback, /not only the reader/);
  assert.match(captured.modelRequest.request.system_prompt, /Coverage is not proof of behavior/);
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
test('review methodology comes from active platform knowledge cards and a failed read never blocks the review', async () => {
  const { loadReviewMethodology, reviewMethodologyPrompt } = require('../supabase/functions/_shared/builder-independent-code-review');
  const calls = [];
  const builder = {
    select(columns) { calls.push(['select', columns]); return builder; },
    is(column, value) { calls.push(['is', column, value]); return builder; },
    eq(column, value) { calls.push(['eq', column, value]); return builder; },
    contains(column, value) { calls.push(['contains', column, value]); return builder; },
    order(column) { calls.push(['order', column]); return builder; },
    limit(count) { calls.push(['limit', count]); return Promise.resolve({ data: [{ key: 'security_review_method', title: 'Security review', content: 'Trace untrusted input  to a sink.' }, { key: 'blank', title: 'x', content: '  ' }], error: null }); },
  };
  const cards = await loadReviewMethodology({ from(table) { calls.push(['from', table]); return builder; } });
  assert.deepEqual(cards.map(card => card.key), ['security_review_method']);
  assert.deepEqual(calls.find(call => call[0] === 'from'), ['from', 'bob_knowledge_cards']);
  assert.deepEqual(calls.find(call => call[0] === 'is'), ['is', 'organization_id', null]);
  assert.deepEqual(calls.find(call => call[0] === 'contains'), ['contains', 'tags', ['independent_code_review']]);
  assert.match(reviewMethodologyPrompt(cards), /\[security_review_method\] Security review: Trace untrusted input to a sink\./);
  assert.equal(reviewMethodologyPrompt([]), null);
  assert.deepEqual(await loadReviewMethodology({}), []);
  assert.deepEqual(await loadReviewMethodology({ from() { throw new Error('offline'); } }), []);
  const denied = { select: () => denied, is: () => denied, eq: () => denied, contains: () => denied, order: () => denied, limit: async () => ({ data: null, error: { message: 'denied' } }) };
  assert.deepEqual(await loadReviewMethodology({ from: () => denied }), []);
});

test('Superpowers and Claude security-review methods are seeded as attributed, retrievable platform cards', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261110120000_builder_superpowers_security_review_cards.sql'), 'utf8');
  assert.match(sql, /WHERE NOT EXISTS/);
  assert.match(sql, /existing\.organization_id IS NULL AND existing\.key = card\.key AND existing\.is_active/);
  const cards = [...sql.matchAll(/\('discipline', '([a-z_]+)',[\s\S]*?\$\$([\s\S]*?)\$\$,\s*ARRAY\[([^\]]*)\]\)/g)]
    .map(([, key, content, tags]) => ({ key, content, tags: tags.split(',').map(tag => tag.trim().replace(/'/g, '')) }));
  assert.deepEqual(cards.map(card => card.key), [
    'superpowers_test_driven_development', 'superpowers_systematic_debugging', 'superpowers_brainstorm_plan_execute',
    'superpowers_verification_before_completion', 'claude_security_review_method', 'claude_security_review_false_positive_filter'
  ]);
  for (const card of cards) {
    assert.ok(card.content.length <= 2500, `${card.key} fits the per-card retrieval cap`);
    assert.match(card.content, /\((obra\/superpowers|anthropics\/claude-code-security-review), MIT\)/, `${card.key} carries its attribution`);
  }
  const reviewCards = cards.filter(card => card.tags.includes('independent_code_review'));
  assert.deepEqual(reviewCards.map(card => card.key), ['superpowers_verification_before_completion', 'claude_security_review_method', 'claude_security_review_false_positive_filter']);
  assert.ok(reviewCards.length <= 4, 'every review-method card fits the reviewer prompt limit');
});
