const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { mainMonitorSourceFiles, planBuilderAction, advanceBuilderJob, runBuilderUntilPause } = require('../builder-runtime-coordinator');

function snapshot(status, overrides = {}) {
  const steps = [
    ['product_analysis', 'product_analyst'], ['ui_design', 'ux_designer'],
    ['frontend_implementation', 'frontend_engineer'], ['backend_implementation', 'backend_engineer'],
    ['test_suite', 'qa_security_reviewer'], ['security_review', 'qa_security_reviewer'],
    ['code_review', 'code_reviewer'], ['release_prep', 'release_engineer']
  ].map(([step_id, builder_mode], index) => ({ id: `step-${index + 1}`, step_id, builder_mode, status: 'pending' }));
  return { job: { id: 'job-1', status, code_review_mode: 'none', ...overrides.job }, steps: overrides.steps || steps, artifacts: [], workerRuns: [] };
}

test('main-monitor lane skips can rely only on a validated unprotected specification scope', () => {
  assert.deepEqual(mainMonitorSourceFiles([
    { source_scope: ['apps/web/src/pages/Map.tsx'] },
    { source_scope: ['builder-runtime-coordinator.js', 'apps/web/src/pages/Map.tsx'] },
  ]), ['apps/web/src/pages/Map.tsx', 'builder-runtime-coordinator.js']);
  for (const scope of [
    [{ source_scope: ['supabase/schema.sql'] }],
    [{ source_scope: ['apps/web/src/context/AuthContext.tsx'] }],
    [{ source_scope: ['../outside.js'] }],
    [{ source_scope: [] }],
    [],
  ]) assert.throws(() => mainMonitorSourceFiles(scope), /unprotected implementation scope/);
});

test('runtime planner pauses at human and terminal states', () => {
  assert.equal(planBuilderAction(snapshot('specification_ready')).type, 'waiting_for_human');
  assert.equal(planBuilderAction(snapshot('approval_pending')).type, 'waiting_for_human');
  assert.equal(planBuilderAction(snapshot('release_ready')).type, 'terminal');
});

test('a superseded attempt cannot launch another implementation run', async () => {
  const state = snapshot('implementation_pending', { job: { autopilot_report: { resumed_as_job_id: 'new-job' } } });
  let started = false;
  const result = await runBuilderUntilPause({
    supabase: null, jobId: 'job-1', loadSnapshot: async () => state,
    handlers: { frontend: async () => { started = true; return { success: true }; } },
  });
  assert.equal(result.reason, 'superseded');
  assert.match(result.detail, /new-job/);
  assert.equal(started, false);
});

test('runtime planner selects product, UX, and implementation work from durable state', () => {
  assert.equal(planBuilderAction(snapshot('intake')).type, 'run_product_analysis');
  assert.equal(planBuilderAction(snapshot('design_pending')).type, 'run_ux_design');
  assert.equal(planBuilderAction(snapshot('implementation_pending')).type, 'run_frontend');
  const backend = snapshot('implementation_pending');
  backend.steps.find(step => step.step_id === 'frontend_implementation').status = 'skipped';
  assert.equal(planBuilderAction(backend).type, 'run_backend');
  const backendOnly = snapshot('design_pending', { job: { frontend_required: false, backend_required: true } });
  backendOnly.steps.find(step => step.step_id === 'ui_design').status = 'skipped';
  assert.equal(planBuilderAction(backendOnly).type, 'continue_backend_only');
});

test('a confirmed correction reopens a required skipped lane before planning the next author', async () => {
  const original = snapshot('implementation_pending', {
    job: { frontend_required: true, backend_required: true, code_review_revision: { approval_id: 'cancelled-review' } },
  });
  original.steps.find(step => step.step_id === 'frontend_implementation').status = 'skipped';
  const corrected = {
    ...original,
    steps: original.steps.map(step => step.step_id === 'frontend_implementation' ? { ...step, status: 'pending' } : step),
  };
  let reads = 0;
  const calls = [];
  let frontendInput;
  const result = await advanceBuilderJob({
    supabase: { rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === 'builder_recover_expired_worker_runs') return { data: [], error: null };
      if (name === 'builder_account_verifier_recoveries') return { data: 0, error: null };
      return { data: { reopened: ['frontend_implementation'] }, error: null };
    } },
    gateway: {}, jobId: 'job-1', context: {},
    loadSnapshot: async () => (++reads === 1 ? original : corrected),
    handlers: { frontend: async input => { frontendInput = input; return { success: true }; } },
  });
  assert.equal(result.advanced, true);
  assert.equal(result.action.type, 'run_frontend');
  assert.equal(frontendInput.step.step_id, 'frontend_implementation');
  assert.equal(reads, 2, 'planning uses the durable reopened step');
  assert.deepEqual(calls.map(call => call.name), [
    'builder_recover_expired_worker_runs',
    'builder_account_verifier_recoveries',
    'builder_reopen_required_implementation_lanes',
  ]);
  assert.deepEqual(calls.at(-1).args, { _job_id: 'job-1' });
});

test('runtime does not route around a required lane when recovery was not persisted', async () => {
  const state = snapshot('implementation_pending', {
    job: { frontend_required: true, backend_required: true, code_review_revision: { approval_id: 'cancelled-review' } },
  });
  state.steps.find(step => step.step_id === 'frontend_implementation').status = 'skipped';
  await assert.rejects(advanceBuilderJob({
    supabase: { rpc: async name => name === 'builder_account_verifier_recoveries'
      ? { data: 0, error: null } : { data: [], error: null } },
    gateway: {}, jobId: 'job-1', context: {},
    loadSnapshot: async () => state,
    handlers: { backend: async () => { assert.fail('backend must not bypass the required frontend lane'); } },
  }), /Required implementation lane recovery was not persisted: frontend_implementation/);
});

test('runtime planner advances security, optional review, and release in order', () => {
  assert.equal(planBuilderAction(snapshot('testing')).type, 'run_security_review');
  const review = snapshot('security_review');
  review.steps.find(step => step.step_id === 'security_review').status = 'completed';
  assert.equal(planBuilderAction(review).type, 'start_optional_review');
  review.steps.find(step => step.step_id === 'code_review').status = 'skipped';
  assert.equal(planBuilderAction(review).type, 'run_release');
});

test('runtime never retries a failed step unless durable state marks it retryable', () => {
  const state = snapshot('analysis_pending');
  const product = state.steps.find(step => step.step_id === 'product_analysis');
  product.status = 'failed';
  product.retryable = false;
  assert.equal(planBuilderAction(state).type, 'blocked');
  product.retryable = true;
  assert.equal(planBuilderAction(state).type, 'run_product_analysis');
});

test('an immutable evidence conflict is parked even when the generic abort RPC marks it retryable', async () => {
  const state = snapshot('analysis_pending');
  Object.assign(state.steps[0], { status: 'failed', retryable: true, error: 'Evidence conflict: failure receipt is outside immutable scope' });
  assert.equal(planBuilderAction(state).reason, 'evidence_conflict');
  const result = await runBuilderUntilPause({
    supabase: null, jobId: 'job-1', loadSnapshot: async () => state,
    handlers: { product: async () => assert.fail('must not call models again') },
  });
  assert.equal(result.reason, 'evidence_conflict');
});
// Live 2026-10-13 (job e52e7122): an autopilot tick landed while in-process product
// analysis was running. In-process steps register no builder_worker_runs row, so the
// planner fell through to `blocked` — and because listAutopilotJobs only re-selects
// driving/awaiting_human jobs, the job was parked forever even though the step then
// completed normally. Work in flight must read as waiting, never as a dead end.
test('a step still running is work in flight, not a blocked job, even with no worker run row', () => {
  const state = snapshot('analysis_pending');
  state.steps.find(step => step.step_id === 'product_analysis').status = 'running';
  assert.deepEqual(state.workerRuns, []);
  assert.equal(planBuilderAction(state).type, 'waiting_for_worker');
});

test('runtime stops re-launching a retryable step once its persisted attempt count reaches the ceiling', async () => {
  const { MAX_STEP_ATTEMPTS } = require('../builder-runtime-coordinator');
  const state = snapshot('implementation_pending');
  state.steps.find(step => step.step_id === 'frontend_implementation').status = 'skipped';
  const backend = state.steps.find(step => step.step_id === 'backend_implementation');
  backend.status = 'failed';
  backend.retryable = true;
  backend.attempt_count = MAX_STEP_ATTEMPTS - 1;
  assert.equal(planBuilderAction(state).type, 'run_backend', 'below the ceiling the step is still runnable');
  backend.attempt_count = MAX_STEP_ATTEMPTS;
  const blocked = planBuilderAction(state);
  assert.equal(blocked.type, 'blocked');
  assert.equal(blocked.reason, 'attempt_ceiling');
  assert.equal(blocked.step_id, 'backend_implementation');
  assert.match(blocked.detail, /^backend_implementation failed 6 times \(ceiling 6\)/, 'no "a human must fix" wording: Bob does the coding (owner ruling 2026-09-27)');
  // The pause reason reaches the caller (and therefore the control room `detail`) unchanged.
  const paused = await runBuilderUntilPause({ supabase: {}, gateway: {}, jobId: 'job-1', context: {}, loadSnapshot: async () => state, maxActions: 3 });
  assert.equal(paused.paused, true);
  assert.equal(paused.reason, 'attempt_ceiling');
  assert.match(paused.detail, /failed 6 times/);
});

test('one current owner receipt permits exactly one same-patch verifier retry at the persisted attempt ceiling', () => {
  const { MAX_STEP_ATTEMPTS } = require('../builder-runtime-coordinator');
  const state = snapshot('implementation_pending', { job: { target_sha: 'a'.repeat(40) } });
  const frontend = state.steps.find(step => step.step_id === 'frontend_implementation');
  frontend.status = 'failed';
  frontend.retryable = true;
  frontend.attempt_count = MAX_STEP_ATTEMPTS;
  frontend.error = 'Verifier recovery pending: owner-confirmed saved patch verification';
  frontend.input_context = {
    patch_artifact_id: 'saved-patch', target_sha: state.job.target_sha,
    owner_patch_retry_receipt: 'owner-receipt', owner_patch_retry_attempt_count: MAX_STEP_ATTEMPTS,
  };
  state.artifacts.push({ id: 'saved-patch', step_id: frontend.id, artifact_type: 'code_implementation', status: 'final' });
  assert.equal(planBuilderAction(state).type, 'run_frontend');

  frontend.attempt_count += 1;
  const consumed = planBuilderAction(state);
  assert.equal(consumed.reason, 'attempt_ceiling', 'the receipt cannot grant an unbounded verifier retry loop');
  frontend.attempt_count = MAX_STEP_ATTEMPTS;
  frontend.input_context.owner_patch_retry_attempt_count -= 1;
  assert.equal(planBuilderAction(state).reason, 'attempt_ceiling', 'stale receipts cannot bypass the ceiling');
});

test('runtime advances exactly one planned action', async () => {
  const calls = [];
  const state = snapshot('intake');
  const result = await advanceBuilderJob({
    supabase: {}, gateway: {}, jobId: 'job-1', context: { repositoryContext: {} },
    loadSnapshot: async () => state,
    handlers: { product: async input => { calls.push(input.step.step_id); return { ok: true }; } }
  });
  assert.equal(result.advanced, true);
  assert.equal(result.action.type, 'run_product_analysis');
  assert.deepEqual(calls, ['product_analysis']);
});

test('a Product Analyst retry receives its bounded validation failure as a correction constraint', async () => {
  const state = snapshot('analysis_pending');
  const product = state.steps.find(step => step.step_id === 'product_analysis');
  product.status = 'failed';
  product.retryable = true;
  product.error = `data_model_proposal invented bob_job_run ${'x'.repeat(2000)}`;
  let captured;

  const result = await advanceBuilderJob({
    supabase: {}, gateway: {}, jobId: 'job-1',
    context: { repositoryContext: {}, constraints: ['Preserve current contracts'] },
    loadSnapshot: async () => state,
    handlers: { product: async input => { captured = input; return { ok: true }; } }
  });

  assert.equal(result.advanced, true);
  assert.equal(captured.constraints[0], 'Preserve current contracts');
  assert.match(captured.constraints[1], /^Correct the previous Product Analyst validation failure/);
  assert.match(captured.constraints[1], /bob_job_run/);
  assert.ok(captured.constraints[1].length <= 1300, 'prior failure is bounded before entering the model prompt');
});

test('a UX Designer retry receives its bounded validation failure as a correction constraint', async () => {
  const state = snapshot('design_pending');
  const ux = state.steps.find(step => step.step_id === 'ui_design');
  ux.status = 'failed';
  ux.retryable = true;
  ux.error = `route_map contains /invented ${'x'.repeat(2000)}`;
  state.artifacts.push({
    id: 'artifact-spec',
    step_id: 'product_analysis',
    artifact_type: 'product_specification',
    status: 'final'
  });
  let captured;

  const result = await advanceBuilderJob({
    supabase: {}, gateway: {}, jobId: 'job-1',
    context: { designContext: {} },
    loadSnapshot: async () => state,
    handlers: { ux: async input => { captured = input; return { ok: true }; } }
  });

  assert.equal(result.advanced, true);
  assert.match(captured.constraints[0], /^Correct the previous UX Designer validation failure/);
  assert.match(captured.constraints[0], /route_map contains \/invented/);
  assert.ok(captured.constraints[0].length <= 1300, 'prior failure is bounded before entering the model prompt');
});

test('agentic runtime reloads after each action and stops at a human gate', async () => {
  const states = [snapshot('intake'), snapshot('specification_ready')];
  let index = 0;
  const result = await runBuilderUntilPause({
    supabase: {}, gateway: {}, jobId: 'job-1', context: { repositoryContext: {} },
    loadSnapshot: async () => states[Math.min(index++, states.length - 1)],
    handlers: { product: async () => ({ ok: true }) }, maxActions: 8
  });
  assert.equal(result.reason, 'waiting_for_human');
  assert.deepEqual(result.history.map(item => item.action.type), ['run_product_analysis', 'waiting_for_human']);
});

test('agentic runtime stops immediately when a specialist fails', async () => {
  const result = await runBuilderUntilPause({
    supabase: {}, gateway: {}, jobId: 'job-1', context: { repositoryContext: {} },
    loadSnapshot: async () => snapshot('intake'),
    handlers: { product: async () => ({ ok: false, error: 'model unavailable' }) }, maxActions: 8
  });
  assert.equal(result.reason, 'action_failed');
  assert.equal(result.history.length, 1);
});

test('agentic runtime advances the complete post-spec workflow to final human approval', async () => {
  const state = status => snapshot(status);
  const design = state('design_pending');
  const frontend = state('implementation_pending');
  frontend.steps.find(step => step.step_id === 'ui_design').status = 'completed';
  const backend = state('implementation_pending');
  backend.steps.find(step => step.step_id === 'ui_design').status = 'completed';
  backend.steps.find(step => step.step_id === 'frontend_implementation').status = 'completed';
  const testing = state('testing');
  testing.steps.find(step => step.step_id === 'ui_design').status = 'completed';
  testing.steps.find(step => step.step_id === 'frontend_implementation').status = 'completed';
  testing.steps.find(step => step.step_id === 'backend_implementation').status = 'completed';
  const review = state('security_review');
  review.steps.find(step => step.step_id === 'security_review').status = 'completed';
  const release = state('security_review');
  release.steps.find(step => step.step_id === 'security_review').status = 'completed';
  release.steps.find(step => step.step_id === 'code_review').status = 'skipped';
  const states = [design, frontend, backend, testing, review, release, state('approval_pending')];
  let index = 0;
  const calls = [];
  const result = await runBuilderUntilPause({
    supabase: {}, gateway: {}, jobId: 'job-1', context: {}, maxActions: 8,
    loadSnapshot: async () => states[Math.min(index++, states.length - 1)],
    handlers: {
      acceptance: async () => ({ passed: true, blockers: [] }),
      ux: async () => { calls.push('ux'); return { ok: true }; },
      frontend: async () => { calls.push('frontend'); return { success: true }; },
      backend: async () => { calls.push('backend'); return { success: true }; },
      security: async () => { calls.push('security'); return { success: true }; },
      optionalReview: async () => { calls.push('review'); return { success: true }; },
      release: async () => { calls.push('release'); return { ok: true }; }
    }
  });
  assert.deepEqual(calls, ['ux', 'frontend', 'backend', 'security', 'review', 'release']);
  assert.equal(result.reason, 'waiting_for_human');
  assert.equal(result.snapshot.job.status, 'approval_pending');
});

test('independent review and release receive the author patch plus the worker-verified manifest/log, never stray proposal envelopes', async () => {
  const { executeBuilderAction } = require('../builder-runtime-coordinator');
  const state = snapshot('security_review', { job: { code_review_mode: 'independent_ai' } });
  const backendStep = state.steps.find(step => step.step_id === 'backend_implementation');
  backendStep.status = 'completed';
  state.steps.find(step => step.step_id === 'security_review').status = 'completed';
  const securityStep = state.steps.find(step => step.step_id === 'security_review');
  const final = (id, artifact_type, step_id = backendStep.id) => ({ id, artifact_type, step_id, status: 'final' });
  state.artifacts = [
    final('proposal-1', 'code_implementation'), final('transcript-1', 'build_logs'),      // engineer attempt 1 (failed verification)
    final('proposal-2', 'code_implementation'), final('transcript-2', 'build_logs'),      // engineer attempt 2 (verified) = author patch
    final('verification', 'build_logs'), final('validated-patch', 'code_implementation'), final('manifest', 'changed_file_manifest'),
    final('security-report', 'security_review', securityStep.id)
  ];
  state.workerRuns = [
    { id: 'run-fail', step_id: backendStep.id, status: 'failed', profile: 'backend-verify', patch_artifact_id: 'proposal-1', output_artifact_ids: ['old-verification'] },
    { id: 'run-ok', step_id: backendStep.id, status: 'completed', profile: 'backend-verify', patch_artifact_id: 'proposal-2', output_artifact_ids: ['verification', 'validated-patch', 'manifest'] },
    { id: 'sec', step_id: securityStep.id, status: 'completed', profile: 'security-review', output_artifact_ids: ['security-report'] }
  ];
  const action = planBuilderAction(state);
  assert.equal(action.type, 'run_independent_review');
  let received;
  await executeBuilderAction({ snapshot: state, action, supabase: {}, gateway: {}, context: { reviewerModelName: 'gpt-5.4-mini' }, handlers: { acceptance: async () => ({ passed: true, blockers: [] }), independentReview: async (input) => { received = input; return { ok: true }; } } });
  assert.deepEqual(received.artifacts.patch.map(a => a.id), ['proposal-2'], 'the author artifact keeps model-run provenance for the reviewer != author check');
  assert.deepEqual(received.artifacts.manifest.map(a => a.id), ['manifest']);
  assert.deepEqual(received.artifacts.buildLogs.map(a => a.id), ['verification']);
  assert.equal(received.artifacts.security.id, 'security-report');
  assert.equal(received.reviewerModelName, 'gpt-5.4-mini');
});

test('runtime intake migration atomically creates all eight scoped steps', () => {
  const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260830190000_builder_runtime_intake.sql'), 'utf8');
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.builder_create_job/);
  assert.match(migration, /A full lowercase Git target SHA is required/);
  assert.match(migration, /No frontend scope requested/);
  assert.match(migration, /No backend scope requested/);
  assert.match(migration, /'release_prep', 8, 'release_engineer'/);
  assert.match(migration, /GRANT EXECUTE[\s\S]*TO service_role/);
});

test('backend-only transition requires approved specification and an intentionally skipped UX step', () => {
  const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260830191000_builder_backend_only_transition.sql'), 'utf8');
  assert.match(migration, /Job is not an approved backend-only build/);
  assert.match(migration, /UX step was not intentionally skipped/);
  assert.match(migration, /approval_type = 'specification_review' AND status = 'approved'/);
  assert.match(migration, /SET status = 'implementation_pending'/);
  assert.match(migration, /GRANT EXECUTE[\s\S]*TO service_role/);
});
test('backend implementation resumes the provider chain past an in-house author that failed', async () => {
  const { runBackendImplementation } = require('../builder-runtime-coordinator');
  const Module = require('node:module');
  // Swap the agentic engineer and backend handoff for fakes for this test only.
  const engineerPath = require.resolve('../builder-agentic-engineer');
  const handoffPath = require.resolve('../builder-backend-handoff');
  const originalEngineer = require.cache[engineerPath].exports;
  const originalHandoff = require.cache[handoffPath].exports;
  const calls = [];
  const coordinatorPath = require.resolve('../builder-runtime-coordinator');
  delete require.cache[coordinatorPath];
  require.cache[engineerPath].exports = { ...originalEngineer, runAgenticEngineer: async (input) => {
    calls.push({ startAfter: input.startAfterProvider ?? null });
    const local = !input.startAfterProvider;
    return { ok: true, patch_artifact: { id: local ? 'patch-local' : 'patch-openai' }, routing: { provider: local ? 'gpu_workstation' : 'openai' } };
  } };
  require.cache[handoffPath].exports = { ...originalHandoff, runBackendHandoff: async ({ patchArtifact }) => (patchArtifact.id === 'patch-local'
    ? { success: false, failure_artifact: { id: 'fail-1' }, artifacts: [{ id: 'fail-1' }] }
    : { success: true, artifacts: [{ id: 'verified' }] }) };
  try {
    const fresh = require('../builder-runtime-coordinator');
    const patch = Buffer.from('diff --git a/lib/a.js b/lib/a.js\n--- a/lib/a.js\n+++ b/lib/a.js\n@@ -1 +1 @@\n-a\n+b\n');
    const supabase = {
      from() {
        let id;
        const query = { select() { return this; }, eq(key, value) { if (key === 'id') id = value; return this; }, single: async () => ({ data: {
          id, job_id: 'j', artifact_type: id === 'fail-1' ? 'build_logs' : 'code_implementation', status: 'final',
          storage_location: `supabase_storage://builder-artifacts/org/j/${id}`,
          checksum: require('node:crypto').createHash('sha256').update(id === 'fail-1' ? Buffer.from('{}') : patch).digest('hex')
        } }) };
        return query;
      },
      storage: { from: () => ({ download: async file => ({ data: { arrayBuffer: async () => file.endsWith('fail-1') ? Buffer.from('{}') : patch } }) }) },
    };
    const result = await fresh.runBackendImplementation({ supabase, gateway: {}, job: { id: 'j' }, step: { id: 's' }, context: { workspaceRoot: '/ws', gitSourceDir: '/src', repoRoot: '/repo' } });
    assert.equal(result.success, true);
    assert.equal(result.attempts, 2);
    assert.equal(result.routing.provider, 'openai');
    assert.deepEqual(calls, [{ startAfter: null }, { startAfter: 'gpu_workstation' }], 'the repair attempt skips the local provider that just failed verification');
  } finally {
    require.cache[engineerPath].exports = originalEngineer;
    require.cache[handoffPath].exports = originalHandoff;
    delete require.cache[coordinatorPath];
    void Module;
  }
});

test('an author run that ends without a proposal is counted against the step ceiling (builder_record_generation_failure)', async () => {
  const engineerPath = require.resolve('../builder-agentic-engineer');
  const originalEngineer = require.cache[engineerPath].exports;
  const coordinatorPath = require.resolve('../builder-runtime-coordinator');
  delete require.cache[coordinatorPath];
  require.cache[engineerPath].exports = { ...originalEngineer, runAgenticEngineer: async () => ({ ok: false, error: 'turn budget exhausted', routing: { provider: 'openai' } }) };
  const rpcs = [];
  const supabase = { rpc: async (name, args) => { rpcs.push({ name, args }); return { data: { status: 'failed', attempt_count: 1 }, error: null }; } };
  try {
    const fresh = require('../builder-runtime-coordinator');
    const result = await fresh.runBackendImplementation({ supabase, gateway: {}, job: { id: 'job-x' }, step: { id: 'step-x' }, context: { workspaceRoot: '/ws', gitSourceDir: '/src', repoRoot: '/repo' } });
    assert.equal(result.success, false);
    assert.equal(result.phase, 'generation');
    assert.deepEqual(rpcs.map((r) => r.name), ['builder_record_generation_failure']);
    assert.equal(rpcs[0].args._job_id, 'job-x');
    assert.equal(rpcs[0].args._step_id, 'step-x');
    assert.match(rpcs[0].args._reason, /^generation: turn budget exhausted/);
    assert.equal(rpcs[0].args._retryable, true);
  } finally {
    require.cache[engineerPath].exports = originalEngineer;
    delete require.cache[coordinatorPath];
  }
});

test('an author that ran out of turns reading gets one immediate second run seeded with its reading map (live job 118731bd)', async () => {
  const engineerPath = require.resolve('../builder-agentic-engineer');
  const originalEngineer = require.cache[engineerPath].exports;
  const coordinatorPath = require.resolve('../builder-runtime-coordinator');
  delete require.cache[coordinatorPath];
  const calls = [];
  const map = { files_read: [{ path: 'supabase/functions/onspace-ai-chat/index.ts', ranges: ['240-315', '8020-8595'] }], searches: ['laptop_shell in supabase/functions/onspace-ai-chat'], conclusion: 'could not finish within the budget', turns_used: 60 };
  require.cache[engineerPath].exports = { ...originalEngineer, runAgenticEngineer: async (input) => {
    calls.push(input.previousAttempt ?? null);
    if (!input.previousAttempt) return { ok: false, no_change: true, budget_exhausted: true, resume_hints: map, error: 'Could not complete within the remaining budget', turns: 60, routing: { provider: 'openai' } };
    return { ok: true, patch_artifact: { id: 'patch-2' }, routing: { provider: 'openai' } };
  } };
  const handoffPath = require.resolve('../builder-backend-handoff');
  const originalHandoff = require.cache[handoffPath].exports;
  require.cache[handoffPath].exports = { ...originalHandoff, runBackendHandoff: async () => ({ success: true, artifacts: [{ id: 'verified' }] }) };
  const rpcs = [];
  const supabase = { rpc: async (name, args) => { rpcs.push({ name, args }); return { data: null, error: null }; } };
  try {
    const fresh = require('../builder-runtime-coordinator');
    const result = await fresh.runBackendImplementation({ supabase, gateway: {}, job: { id: 'job-z' }, step: { id: 'step-z' }, context: { workspaceRoot: '/ws', gitSourceDir: '/src', repoRoot: '/repo' } });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(calls.length, 2, 'exactly one extra run, in the same tick');
    assert.equal(calls[0], null);
    assert.deepEqual(calls[1], map, 'the second run starts from the first run\'s reading map');
    assert.equal(rpcs.length, 0, 'no failure is recorded when the second run delivers');

    // Both runs out of turns: parked once, with both facts in the reason, not retried six times.
    // (The first ran dry without ever calling finish — job 79b4c08f — which must count the same way.)
    calls.length = 0;
    require.cache[engineerPath].exports = { ...originalEngineer, runAgenticEngineer: async (input) => { calls.push(1); return input.previousAttempt
      ? { ok: false, no_change: true, budget_exhausted: true, resume_hints: map, error: 'still too big', turns: 60, routing: { provider: 'openai' } }
      : { ok: false, budget_exhausted: true, resume_hints: map, error: 'turn budget exhausted', turns: 60, routing: { provider: 'openai' } }; } };
    delete require.cache[coordinatorPath];
    const again = require('../builder-runtime-coordinator');
    const parked = await again.runBackendImplementation({ supabase, gateway: {}, job: { id: 'job-z' }, step: { id: 'step-z' }, context: { workspaceRoot: '/ws', gitSourceDir: '/src', repoRoot: '/repo' } });
    assert.equal(parked.success, false);
    assert.equal(calls.length, 2);
    assert.equal(rpcs.length, 1);
    assert.equal(rpcs[0].args._retryable, false);
    assert.match(rpcs[0].args._reason, /Two author attempts produced no patch; second attempt: still too big/);
  } finally {
    require.cache[engineerPath].exports = originalEngineer;
    require.cache[handoffPath].exports = originalHandoff;
    delete require.cache[coordinatorPath];
  }
});

test('a review re-open\'s seed patch is loaded from the parent job\'s verified artifact and handed to the engineer', async () => {
  const { loadSeedPatch } = require('../builder-runtime-coordinator');
  const crypto = require('node:crypto');
  const patch = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n';
  const parent = '019d2088-47e9-4361-86f9-1b6af2b6dbae';
  const artifactId = '610c4b87-0000-4000-8000-000000000000';
  const seen = [];
  const supabase = {
    from(name) {
      const chain = { select() { return chain; }, eq(col, val) { seen.push([col, val]); return chain; }, single: async () => ({ data: { id: artifactId, job_id: parent, artifact_type: 'code_implementation', status: 'final', storage_location: 'supabase_storage://builder-artifacts/org/p/validated.patch', checksum: crypto.createHash('sha256').update(patch).digest('hex') }, error: null }) };
      assert.equal(name, 'builder_artifacts');
      return chain;
    },
    storage: { from: () => ({ download: async () => ({ data: { arrayBuffer: async () => Buffer.from(patch) }, error: null }) }) },
  };
  assert.equal(await loadSeedPatch(supabase, { description: 'Opened by Bob from conversation x' }), null);
  assert.equal(await loadSeedPatch(supabase, { description: `Opened by Bob's autopilot from job ${parent} after independent review (round 1 of 2)` }), null, 'no marker, no seed');
  const seed = await loadSeedPatch(supabase, { description: `Opened by Bob's autopilot from job ${parent} after independent review (round 1 of 2) [[seed_patch:${artifactId}]]` });
  assert.equal(seed.text, patch);
  assert.equal(seed.from_job, parent);
  assert.deepEqual(seen, [['id', artifactId], ['job_id', parent]], 'the artifact is verified against the PARENT job, not this one');

  const engineerPath = require.resolve('../builder-agentic-engineer');
  const originalEngineer = require.cache[engineerPath].exports;
  const coordinatorPath = require.resolve('../builder-runtime-coordinator');
  delete require.cache[coordinatorPath];
  const inputs = [];
  require.cache[engineerPath].exports = { ...originalEngineer, runAgenticEngineer: async (input) => { inputs.push(input); return { ok: true, patch_artifact: { id: 'p2' }, routing: { provider: 'openai' } }; } };
  try {
    const fresh = require('../builder-runtime-coordinator');
    const generate = fresh.agenticGenerator('backend', { workspaceRoot: '/ws', gitSourceDir: '/src', repoRoot: '/repo' }, { loadSeedPatch: async () => seed });
    await generate({ supabase: {}, gateway: {}, job: { id: 'j2', description: 'x' }, step: { id: 's' } });
    assert.equal(inputs[0].seedPatch.text, patch);
    seen.length = 0;
    await generate({ supabase, gateway: {}, job: { id: parent }, step: { id: 's' }, failedPatchArtifact: { id: artifactId } });
    assert.equal(inputs[1].seedPatch.text, patch, 'ordinary repair restores the failed patch, not just a review re-open');
    assert.equal(inputs[1].seedPatch.artifact_id, artifactId);
    assert.deepEqual(seen, [['id', artifactId], ['job_id', parent]]);
  } finally {
    require.cache[engineerPath].exports = originalEngineer;
    delete require.cache[coordinatorPath];
  }
});

test('an honest no-change answer parks the step (not retryable) and the planner blocks the job with that reason', async () => {
  const engineerPath = require.resolve('../builder-agentic-engineer');
  const originalEngineer = require.cache[engineerPath].exports;
  const coordinatorPath = require.resolve('../builder-runtime-coordinator');
  delete require.cache[coordinatorPath];
  require.cache[engineerPath].exports = { ...originalEngineer, runAgenticEngineer: async () => ({ ok: false, no_change: true, error: 'the named script does not exist at this commit; inventing it would be unsafe', routing: { provider: 'openai' } }) };
  const rpcs = [];
  const supabase = { rpc: async (name, args) => { rpcs.push({ name, args }); return { data: { status: 'failed', attempt_count: 1, retryable: false }, error: null }; } };
  try {
    const fresh = require('../builder-runtime-coordinator');
    const result = await fresh.runBackendImplementation({ supabase, gateway: {}, job: { id: 'job-y' }, step: { id: 'step-y' }, context: { workspaceRoot: '/ws', gitSourceDir: '/src', repoRoot: '/repo' } });
    assert.equal(result.success, false);
    assert.equal(rpcs[0].args._retryable, false, 'job 92f7369a: the same honest answer was re-run six times');
    const action = fresh.planBuilderAction({
      job: { id: 'job-y', status: 'implementation_pending', backend_required: true },
      steps: [
        { id: 's1', step_id: 'product_analysis', builder_mode: 'product_analyst', status: 'completed' },
        { id: 's2', step_id: 'frontend_implementation', builder_mode: 'frontend_engineer', status: 'skipped' },
        { id: 's3', step_id: 'backend_implementation', builder_mode: 'backend_engineer', status: 'failed', retryable: false, attempt_count: 1, error: 'generation: the named script does not exist at this commit; inventing it would be unsafe' },
      ],
      artifacts: [], workerRuns: [], approvals: [],
    });
    assert.equal(action.type, 'blocked');
    assert.equal(action.reason, 'blocked');
    assert.equal(action.step_id, 'backend_implementation');
    assert.equal(action.detail, 'the named script does not exist at this commit; inventing it would be unsafe');
  } finally {
    require.cache[engineerPath].exports = originalEngineer;
    delete require.cache[coordinatorPath];
  }
});

test('expired verifier leases are recovered before every advance, and the recovered step resumes with its recorded patch', async () => {
  const { advanceBuilderJob, planBuilderAction } = require('../builder-runtime-coordinator');
  const rpcs = [];
  const supabase = { rpc: async (name) => { rpcs.push(name); return { data: 1, error: null }; } };
  const patch = { id: 'patch-7606', artifact_type: 'code_implementation', status: 'final' };
  const step = { id: 's-fe', step_id: 'frontend_implementation', builder_mode: 'frontend_engineer', status: 'failed', retryable: true, attempt_count: 4, error: 'Frontend worker lease expired (runner lost); the same patch is verified again', input_context: { patch_artifact_id: 'patch-7606' } };
  const snapshot = {
    job: { id: 'job-e', status: 'implementation_pending', frontend_required: true, backend_required: false },
    steps: [
      { id: 's-pa', step_id: 'product_analysis', builder_mode: 'product_analyst', status: 'completed' },
      { id: 's-ux', step_id: 'ui_design', builder_mode: 'ux_designer', status: 'completed' },
      step,
      { id: 's-be', step_id: 'backend_implementation', builder_mode: 'backend_engineer', status: 'skipped' },
    ],
    artifacts: [patch, { id: 'ux-plan', artifact_type: 'ui_design_plan', status: 'final', step_id: 's-ux' }],
    workerRuns: [{ id: 'run-lost', profile: 'frontend-verify', status: 'timeout' }],
    approvals: [],
  };
  assert.equal(planBuilderAction(snapshot).type, 'run_frontend', 'a timed-out run no longer blocks as waiting_for_worker');
  let received = null;
  const outcome = await advanceBuilderJob({ supabase, gateway: {}, jobId: 'job-e', context: {}, loadSnapshot: async () => snapshot, handlers: { frontend: async (input) => { received = input; return { success: true }; } } });
  assert.deepEqual(rpcs, ['builder_recover_expired_worker_runs', 'builder_account_verifier_recoveries']);
  assert.equal(outcome.advanced, true);
  assert.equal(received.resumePatchArtifact?.id, 'patch-7606');
  // A step that failed for any other reason authors afresh.
  const otherSnapshot = { ...snapshot, steps: snapshot.steps.map((s) => s === step ? { ...step, error: 'Frontend worker verification failed' } : s) };
  await advanceBuilderJob({ supabase, gateway: {}, jobId: 'job-e', context: {}, loadSnapshot: async () => otherSnapshot, handlers: { frontend: async (input) => { received = input; return { success: true }; } } });
  assert.equal(received.resumePatchArtifact, undefined);
});

test('owner-confirmed saved-patch retry bypasses author generation and re-verifies the exact artifact', async () => {
  const { advanceBuilderJob, planBuilderAction } = require('../builder-runtime-coordinator');
  const step = {
    id: 'frontend-step', step_id: 'frontend_implementation', builder_mode: 'frontend_engineer',
    status: 'failed', retryable: true, attempt_count: 1,
    error: 'Verifier recovery pending: owner-confirmed saved patch verification',
    input_context: { patch_artifact_id: 'saved-patch', target_sha: 'a'.repeat(40) },
  };
  const snapshot = {
    job: { id: 'retry-job', status: 'implementation_pending', target_sha: 'a'.repeat(40), frontend_required: true, backend_required: true },
    steps: [
      { id: 'analysis', step_id: 'product_analysis', builder_mode: 'product_analyst', status: 'completed' },
      { id: 'design', step_id: 'ui_design', builder_mode: 'ux_designer', status: 'completed' },
      step,
      { id: 'backend', step_id: 'backend_implementation', builder_mode: 'backend_engineer', status: 'pending' },
      ...['test_suite', 'security_review', 'code_review', 'release_prep'].map(step_id => ({ id: step_id, step_id, status: 'pending' })),
    ],
    artifacts: [{ id: 'saved-patch', step_id: step.id, artifact_type: 'code_implementation', status: 'final' }],
    workerRuns: [], approvals: [],
  };
  assert.equal(planBuilderAction(snapshot).type, 'run_frontend');
  let received;
  const outcome = await advanceBuilderJob({
    supabase: { rpc: async () => ({ data: 0, error: null }) },
    gateway: {}, jobId: snapshot.job.id, context: {}, loadSnapshot: async () => snapshot,
    handlers: { frontend: async input => { received = input; return { success: true }; } },
  });
  assert.equal(outcome.advanced, true);
  assert.equal(received.resumePatchArtifact.id, 'saved-patch');
  assert.equal(received.step.attempt_count, 1, 'the persisted worker claim, not the handoff, increments attempts');
});

test('ordinary failed implementation resumes from its exact patch and worker evidence across scheduler ticks', () => {
  const { failedImplementationEvidence } = require('../builder-runtime-coordinator');
  const step = { id: 'step', status: 'failed', retryable: true, error: 'Frontend worker verification failed', input_context: { patch_artifact_id: 'patch' } };
  const patch = { id: 'patch', artifact_type: 'code_implementation', status: 'final' };
  const failure = { id: 'logs', artifact_type: 'build_logs', status: 'final' };
  const state = { workerRuns: [{ step_id: 'step', status: 'failed', patch_artifact_id: 'patch', output_artifact_ids: ['logs'] }], artifacts: [patch, failure] };
  assert.deepEqual(failedImplementationEvidence(state, step), { failedPatchArtifact: patch, failureArtifact: failure });
  assert.deepEqual(failedImplementationEvidence({ ...state, workerRuns: [...state.workerRuns, { step_id: 'step', status: 'failed', patch_artifact_id: 'stale-patch' }] }, step), { failedPatchArtifact: patch, failureArtifact: failure });
  assert.throws(() => failedImplementationEvidence({ ...state, artifacts: [patch] }, step), /missing its patch or verification evidence/);
});

test('backend respects durable recovery pauses without charging infrastructure or baseline as generation failures', async () => {
  const handoffPath = require.resolve('../builder-backend-handoff');
  const originalHandoff = require.cache[handoffPath].exports;
  const coordinatorPath = require.resolve('../builder-runtime-coordinator');
  let outcomes;
  let verifications;
  require.cache[handoffPath].exports = { ...originalHandoff, runBackendHandoff: async () => {
    verifications += 1;
    if (!outcomes.length) throw new Error('unexpected additional verification');
    return outcomes.shift();
  } };
  delete require.cache[coordinatorPath];
  try {
    const { runBackendImplementation } = require('../builder-runtime-coordinator');
    for (const scenario of [
      { outcomes: [{ success: false, infrastructure_failure: true }, { success: false, infrastructure_failure: true }], retryable: [true, false], phase: 'infrastructure', verifications: 2 },
      { outcomes: [{ success: false, infrastructure_failure: true }], retryable: [false], phase: 'infrastructure', verifications: 1 },
      { outcomes: [{ success: false, baseline_failure: true, baseline_reason: 'matching assertion' }], retryable: [], phase: 'baseline', verifications: 1 },
    ]) {
      outcomes = [...scenario.outcomes];
      verifications = 0;
      const states = [...scenario.retryable];
      const result = await runBackendImplementation({
        supabase: { rpc: async () => { throw new Error('a non-engineering failure must not charge generation budget'); } },
        job: { id: 'job' }, step: { id: 'step' },
        context: { workspaceRoot: '/ws' }, resumePatchArtifact: { id: 'saved-patch' },
        reloadStep: async () => ({ retryable: states.shift() }),
      });
      assert.equal(result.phase, scenario.phase);
      assert.equal(verifications, scenario.verifications);
      assert.equal(outcomes.length, 0);
    }
  } finally {
    require.cache[handoffPath].exports = originalHandoff;
    delete require.cache[coordinatorPath];
  }
});

test('an author with nothing to change in its lane skips the step when the other lane delivered the patch; otherwise it parks', async () => {
  const engineerPath = require.resolve('../builder-agentic-engineer');
  const originalEngineer = require.cache[engineerPath].exports;
  const coordinatorPath = require.resolve('../builder-runtime-coordinator');
  delete require.cache[coordinatorPath];
  require.cache[engineerPath].exports = { ...originalEngineer, runAgenticEngineer: async () => ({ ok: false, no_change: true, no_change_file: 'apps/web/src/pages/CancelAction.tsx', inspected_files: ['apps/web/src/pages/CancelAction.tsx'], error: 'the cancel action already exists in the edge function; the change is web-only', routing: { provider: 'openai' } }) };
  const rpcs = [];
  const supabase = { rpc: async (name, args) => { rpcs.push({ name, args }); return { data: {}, error: null }; } };
  try {
    const fresh = require('../builder-runtime-coordinator');
    const skipped = await fresh.runBackendImplementation({ supabase, gateway: {}, job: { id: 'job-z' }, step: { id: 'step-z', builder_mode: 'backend_engineer' }, siblingCompleted: true, context: { workspaceRoot: '/ws', gitSourceDir: '/src', repoRoot: '/repo' } });
    assert.equal(skipped.success, true);
    assert.equal(skipped.skipped, true);
    assert.deepEqual(rpcs.map((r) => r.name), ['builder_skip_implementation_step']);
    assert.equal(rpcs[0].args._builder_mode, 'backend_engineer');
    assert.match(rpcs[0].args._reason, /^Nothing to change in this lane; the frontend lane delivered the change at apps\/web\/src\/pages\/CancelAction\.tsx\. Author: the cancel action already exists/);
    rpcs.length = 0;
    const parked = await fresh.runBackendImplementation({ supabase, gateway: {}, job: { id: 'job-z' }, step: { id: 'step-z', builder_mode: 'backend_engineer' }, siblingCompleted: false, context: { workspaceRoot: '/ws', gitSourceDir: '/src', repoRoot: '/repo' } });
    assert.equal(parked.success, false);
    assert.deepEqual(rpcs.map((r) => r.name), ['builder_record_generation_failure'], 'no sibling patch: the honest no-change still goes to a human');
  } finally {
    require.cache[engineerPath].exports = originalEngineer;
    delete require.cache[coordinatorPath];
  }
});

test('a cross-lane no-change skips this lane even before the sibling finishes', async () => {
  const engineerPath = require.resolve('../builder-agentic-engineer');
  const originalEngineer = require.cache[engineerPath].exports;
  const coordinatorPath = require.resolve('../builder-runtime-coordinator');
  delete require.cache[coordinatorPath];
  require.cache[engineerPath].exports = {
    ...originalEngineer,
    runAgenticEngineer: async () => ({ ok: false, no_change: true, no_change_file: 'apps/web/src/Preview.tsx', inspected_files: ['apps/web/src/Preview.tsx'], error: 'the crash lives in apps/web/src/Preview.tsx: outside the backend lane', routing: { provider: 'openai' } }),
  };
  const rpcs = [];
  const supabase = { rpc: async (name, args) => { rpcs.push({ name, args }); return { data: {}, error: null }; } };
  try {
    const fresh = require('../builder-runtime-coordinator');
    const result = await fresh.runBackendImplementation({
      supabase,
      gateway: {},
      job: { id: 'job-cross' },
      step: { id: 'step-cross', builder_mode: 'backend_engineer' },
      siblingCompleted: false,
      context: { workspaceRoot: '/ws', gitSourceDir: '/src', repoRoot: '/repo' }
    });
    assert.equal(result.success, true);
    assert.equal(result.skipped, true);
    assert.deepEqual(rpcs.map((r) => r.name), ['builder_skip_implementation_step']);
    assert.match(rpcs[0].args._reason, /belongs to the frontend lane/);
  } finally {
    require.cache[engineerPath].exports = originalEngineer;
    delete require.cache[coordinatorPath];
  }
});

test('two in-house budgets with no edit escalate once to the outsourced tier, seeded with the reading map (live jobs 0c388688, 26ef7a12, e710f032)', async () => {
  const engineerPath = require.resolve('../builder-agentic-engineer');
  const originalEngineer = require.cache[engineerPath].exports;
  const coordinatorPath = require.resolve('../builder-runtime-coordinator');
  const handoffPath = require.resolve('../builder-backend-handoff');
  const originalHandoff = require.cache[handoffPath].exports;
  const map = { files_read: [{ path: 'apps/web/src/pages/OrganizationSetupPage.tsx', ranges: ['960-995'] }], conclusion: 'out of turns', turns_used: 60 };
  const chain = ['gpu_workstation', 'ollama', 'openai'];
  const calls = [];
  const local = (provider) => ({ ok: false, no_change: true, budget_exhausted: true, resume_hints: map, error: 'turn budget exhausted', turns: 60, routing: { provider, chain } });
  require.cache[handoffPath].exports = { ...originalHandoff, runBackendHandoff: async () => ({ success: true, artifacts: [{ id: 'verified' }] }) };
  const rpcs = [];
  const supabase = { rpc: async (name, args) => { rpcs.push({ name, args }); return { data: null, error: null }; } };
  try {
    require.cache[engineerPath].exports = { ...originalEngineer, runAgenticEngineer: async (input) => {
      calls.push({ startAfter: input.startAfterProvider, seeded: Boolean(input.previousAttempt) });
      return input.startAfterProvider === 'ollama' ? { ok: true, patch_artifact: { id: 'patch-openai' }, routing: { provider: 'openai', chain } } : local('gpu_workstation');
    } };
    delete require.cache[coordinatorPath];
    const result = await require('../builder-runtime-coordinator').runBackendImplementation({ supabase, gateway: {}, job: { id: 'job-e' }, step: { id: 'step-e' }, context: { workspaceRoot: '/ws', gitSourceDir: '/src', repoRoot: '/repo' } });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.routing.provider, 'openai');
    assert.deepEqual(calls, [{ startAfter: null, seeded: false }, { startAfter: null, seeded: true }, { startAfter: 'ollama', seeded: true }], 'third run skips every in-house provider and starts from the map');
    assert.equal(rpcs.length, 0);

    // A restricted (local-only) chain never escalates out of the house.
    calls.length = 0;
    require.cache[engineerPath].exports = { ...originalEngineer, runAgenticEngineer: async (input) => { calls.push(input.startAfterProvider); return { ...local('ollama'), routing: { provider: 'ollama', chain: ['ollama', 'gpu_workstation'] } }; } };
    delete require.cache[coordinatorPath];
    const parked = await require('../builder-runtime-coordinator').runBackendImplementation({ supabase, gateway: {}, job: { id: 'job-r' }, step: { id: 'step-r' }, context: { workspaceRoot: '/ws', gitSourceDir: '/src', repoRoot: '/repo' } });
    assert.equal(parked.success, false);
    // Only the existing in-house hop (ollama → gpu_workstation) follows; no outsourced third run is added.
    assert.deepEqual(calls, [null, null, 'ollama', 'ollama']);
  } finally {
    require.cache[engineerPath].exports = originalEngineer;
    require.cache[handoffPath].exports = originalHandoff;
    delete require.cache[coordinatorPath];
  }
});
