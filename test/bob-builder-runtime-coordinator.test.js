const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { planBuilderAction, advanceBuilderJob, runBuilderUntilPause } = require('../builder-runtime-coordinator');

function snapshot(status, overrides = {}) {
  const steps = [
    ['product_analysis', 'product_analyst'], ['ui_design', 'ux_designer'],
    ['frontend_implementation', 'frontend_engineer'], ['backend_implementation', 'backend_engineer'],
    ['test_suite', 'qa_security_reviewer'], ['security_review', 'qa_security_reviewer'],
    ['code_review', 'code_reviewer'], ['release_prep', 'release_engineer']
  ].map(([step_id, builder_mode], index) => ({ id: `step-${index + 1}`, step_id, builder_mode, status: 'pending' }));
  return { job: { id: 'job-1', status, code_review_mode: 'none', ...overrides.job }, steps: overrides.steps || steps, artifacts: [], workerRuns: [] };
}

test('runtime planner pauses at human and terminal states', () => {
  assert.equal(planBuilderAction(snapshot('specification_ready')).type, 'waiting_for_human');
  assert.equal(planBuilderAction(snapshot('approval_pending')).type, 'waiting_for_human');
  assert.equal(planBuilderAction(snapshot('release_ready')).type, 'terminal');
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
  assert.match(blocked.detail, /human must fix the cause/);
  // The pause reason reaches the caller (and therefore the control room `detail`) unchanged.
  const paused = await runBuilderUntilPause({ supabase: {}, gateway: {}, jobId: 'job-1', context: {}, loadSnapshot: async () => state, maxActions: 3 });
  assert.equal(paused.paused, true);
  assert.equal(paused.reason, 'attempt_ceiling');
  assert.match(paused.detail, /failed 6 times/);
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
  await executeBuilderAction({ snapshot: state, action, supabase: {}, gateway: {}, context: { reviewerModelName: 'gpt-5.4-mini' }, handlers: { independentReview: async (input) => { received = input; return { ok: true }; } } });
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
    const result = await fresh.runBackendImplementation({ supabase: {}, gateway: {}, job: { id: 'j' }, step: { id: 's' }, context: { workspaceRoot: '/ws', gitSourceDir: '/src', repoRoot: '/repo' } });
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
