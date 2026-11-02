'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { acceptanceIdentity, reconcileAcceptance, checkImplementationAcceptance, testCommandCovers } = require('../builder-implementation-acceptance');
const { executeBuilderAction, runBuilderUntilPause } = require('../builder-runtime-coordinator');
const { runFrontendImplementation } = require('../builder-frontend-orchestrator');
const { agenticGenerator } = require('../builder-runtime-coordinator');
const crypto = require('node:crypto');

function requirement(id = 'DR-1', scope = 'builder-chat-session.js') {
  return { id, outcome: 'A saved diary followed by final-answer failure preserves a truthful user-visible receipt.',
    evidence: 'Regression tests exercise the actual diary-save and final-answer failure path.', source_scope: [scope] };
}

function bundle(id = 'DR-1', source = 'builder-chat-session.js', patchId = 'patch-backend') {
  return { patchId, manifest: [{ path: source }, { path: 'test/workflow.test.js' }],
    envelope: { acceptance_evidence: [{ requirement_id: id, status: 'completed',
      evidence: `${source} implements the outcome; test/workflow.test.js exercises the actual workflow and error controls.` }] },
    verification: { succeeded: true, checks: [{ command: 'node --test test/workflow.test.js', status: 0 }] } };
}

function fixture() {
  const snapshot = {
    job: { id: 'job', organization_id: 'org', status: 'security_review', target_sha: 'a'.repeat(40), code_review_mode: 'human' },
    steps: [{ id: 'front', step_id: 'frontend_implementation', status: 'skipped' },
      { id: 'back', step_id: 'backend_implementation', status: 'completed' },
      { id: 'review', step_id: 'code_review', status: 'pending' },
      { id: 'security', step_id: 'security_review', status: 'completed' }],
    artifacts: [
      { id: 'spec', step_id: 'product', artifact_type: 'product_specification', status: 'final', checksum: 's' },
      { id: 'patch-backend', step_id: 'back', artifact_type: 'code_implementation', status: 'final', checksum: 'p' },
      { id: 'manifest', step_id: 'back', artifact_type: 'changed_file_manifest', status: 'final', checksum: 'm' },
      { id: 'logs', step_id: 'back', artifact_type: 'build_logs', status: 'final', checksum: 'l' }
    ],
    workerRuns: [{ id: 'worker', step_id: 'back', status: 'completed', profile: 'backend-verify',
      organization_id: 'org', target_sha: 'a'.repeat(40),
      patch_artifact_id: 'patch-backend', output_artifact_ids: ['manifest', 'logs'] }]
  };
  const current = bundle();
  const content = {
    spec: { delivery_requirements: [requirement()] },
    'patch-backend': { ...current.envelope, patch: 'diff --git a/builder-chat-session.js b/builder-chat-session.js\n' },
    manifest: current.manifest, logs: current.verification
  };
  const receipts = [];
  return { snapshot, content, receipts,
    supabase: { rpc: async (name, args) => { assert.equal(name, 'builder_record_implementation_acceptance'); receipts.push(args); return { error: null }; } },
    loadArtifact: async (_supabase, id) => ({ bytes: Buffer.from(JSON.stringify(content[id])) }) };
}

test('frontend initial and repair authoring retain the original product acceptance artifact', async () => {
  const spec = { id: 'original-spec', artifact_type: 'product_specification', status: 'final' };
  const received = [];
  let calls = 0;
  const result = await runFrontendImplementation({
    supabase: {}, job: { id: 'job' }, step: { id: 'front' }, productArtifact: spec,
    generate: async input => { received.push(input.productArtifact); return { ok: true, patch_artifact: { id: 'initial' } }; },
    handoff: async () => ++calls === 1 ? { success: false, worker_run_id: 'worker', failure_artifact: { id: 'failure' } } : { success: true },
    reloadStep: async () => ({ id: 'front', status: 'failed', retryable: true }),
    repair: async input => { received.push(input.productArtifact); return { ok: true, patch_artifact: { id: 'repaired' } }; }
  });
  assert.equal(result.success, true);
  assert.deepEqual(received, [spec, spec]);
});

test('agentic frontend receives integrity-checked product requirements rather than only a UX plan', async () => {
  const specification = { delivery_requirements: [requirement()] };
  const bytes = Buffer.from(JSON.stringify(specification));
  let captured;
  let checksum = crypto.createHash('sha256').update(bytes).digest('hex');
  const supabase = {
    from: () => ({ select() { return this; }, eq() { return this; }, single: async () => ({ data: {
      id: 'spec', job_id: 'job', artifact_type: 'product_specification', status: 'final',
      storage_location: 'supabase_storage://builder-artifacts/spec', checksum
    } }) }),
    storage: { from: () => ({ download: async () => ({ data: { arrayBuffer: async () => bytes } }) }) }
  };
  const generate = agenticGenerator('frontend', {}, { runEngineer: async input => { captured = input; return { ok: true }; } });
  await generate({ supabase, job: { id: 'job' }, step: { id: 'front' }, productArtifact: { id: 'spec' } });
  assert.deepEqual(captured.specification, specification);
  assert.deepEqual(captured.inputArtifactIds, ['spec']);
  checksum = '0'.repeat(64);
  captured = null;
  await assert.rejects(generate({ supabase, job: { id: 'job' }, step: { id: 'front' }, productArtifact: { id: 'spec' } }), /integrity/);
  assert.equal(captured, null, 'no author is invoked with an unreadable acceptance contract');
});

test('every mandatory outcome is reconciled regardless of lane; reader-only DR-6 cannot complete the job', () => {
  const spec = { delivery_requirements: Array.from({ length: 6 }, (_, i) => requirement(`DR-${i + 1}`, 'apps/web/src/components/BuilderChatPanel.tsx')) };
  const reader = bundle('DR-6');
  const result = reconcileAcceptance(spec, [reader]);
  assert.equal(result.passed, false);
  assert.equal(result.requirements.length, 6);
  assert.ok(result.requirements.slice(0, 5).every(row => row.status === 'blocked' && /skipped lane/.test(row.gaps[0])));
  assert.match(result.requirements[5].gaps.join(' '), /approved scope/);
  assert.ok(result.blockers.some(item => item.startsWith('DR-1:')));
});

test('frontend/backend coverage is merged, preserving full outcomes and workflow acceptance for review', () => {
  const spec = { delivery_requirements: [requirement(), requirement('DR-2', 'apps/web/src/Receipt.tsx')],
    workflow_verification: { before: 'Owner permitted', during: 'Diary saved, final answer fails', after: 'Receipt survives reload' } };
  const result = reconcileAcceptance(spec, [bundle(), bundle('DR-2', 'apps/web/src/Receipt.tsx', 'patch-front')]);
  assert.equal(result.passed, true);
  assert.deepEqual(result.requirements.map(row => row.status), ['covered', 'covered']);
  assert.deepEqual(result.workflow_verification, spec.workflow_verification);
  assert.match(result.limitation, /not semantic or human acceptance/);
});

test('an author-recorded root-cause scope amendment covers its own requirement only, for a verified changed file named in evidence', () => {
  const spec = { delivery_requirements: [requirement('DR-1', 'apps/web/src/pages/HubPage.tsx')] };
  const shared = 'apps/web/src/components/FieldPointMap.tsx';
  const reason = 'The _leaflet_pos error is thrown by the shared map component after unmount, not by the page.';
  const amendedBundle = (amendments) => {
    const value = bundle('DR-1', shared);
    value.envelope.scope_amendments = amendments;
    return value;
  };
  assert.equal(reconcileAcceptance(spec, [amendedBundle([])]).passed, false, 'without an amendment the out-of-scope fix stays blocked');
  const covered = reconcileAcceptance(spec, [amendedBundle([{ requirement_id: 'DR-1', file: shared, reason }])]);
  assert.equal(covered.passed, true, covered.blockers.join('; '));
  assert.deepEqual(covered.requirements[0].scope_amendments, [{ file: shared, reason, patch_artifact_id: 'patch-backend' }]);
  for (const amendment of [
    { requirement_id: 'DR-2', file: shared, reason },
    { requirement_id: 'DR-1', file: 'apps/web/src/components/Unchanged.tsx', reason },
    { requirement_id: 'DR-1', file: shared, reason: 'shared map' },
  ]) {
    assert.equal(reconcileAcceptance(spec, [amendedBundle([amendment])]).passed, false, JSON.stringify(amendment));
  }
});

test('invented/duplicate ids, absent claims, test omissions and syntax-only workers are blockers', () => {
  for (const mutate of [
    value => { value.envelope.acceptance_evidence[0].requirement_id = 'invented'; },
    value => { value.envelope.acceptance_evidence.push(value.envelope.acceptance_evidence[0]); },
    value => { value.envelope.acceptance_evidence = []; },
    value => { value.envelope.acceptance_evidence[0].evidence = 'builder-chat-session.js implements it'; },
    value => { value.verification.checks = [{ command: 'node --check builder-chat-session.js', status: 0 }]; },
    value => { value.verification.checks[0].status = 1; },
    value => { value.verification.checks[0].command = 'node --test test/unrelated.test.js'; },
    value => { value.envelope = null; }
  ]) {
    const value = bundle();
    mutate(value);
    assert.equal(reconcileAcceptance({ delivery_requirements: [requirement()] }, [value]).passed, false);
  }
  assert.equal(reconcileAcceptance({}, [bundle()]).passed, false);
  assert.equal(reconcileAcceptance({ delivery_requirements: [requirement(), requirement()] }, [bundle()]).passed, false);
});

test('test execution must cover the cited test, not an unrelated passed suite or browser smoke test', () => {
  const run = command => ({ command, status: 0 });
  assert.equal(testCommandCovers('test/workflow.test.js', run('node --test test/workflow.test.js')), true);
  assert.equal(testCommandCovers('test/workflow.test.js', run('node --test test/unrelated.test.js')), false);
  assert.equal(testCommandCovers('apps/web/src/Receipt.test.tsx', run('npm run test --prefix apps/web -- --run')), true);
  assert.equal(testCommandCovers('apps/web/src/Receipt.test.tsx', run('npm run test --prefix apps/web -- src/Other.test.tsx')), false);
  assert.equal(testCommandCovers('apps/web/e2e/receipt.spec.ts', run('npm run test --prefix apps/web -- --run')), false);
  assert.equal(testCommandCovers('apps/web/e2e/receipt.spec.ts', run('npm run test:e2e --prefix apps/web -- e2e/receipt.spec.ts --project=desktop-chromium')), true);
  assert.equal(testCommandCovers('apps/web/e2e/receipt.spec.ts', run('npm run test:e2e:ci-smoke --prefix apps/web')), false);
});

test('documentation outcomes are not forced to invent executable regression tests', () => {
  const value = bundle('DR-doc', 'docs/guide.md');
  value.envelope.acceptance_evidence[0].evidence = 'docs/guide.md records the instructions.';
  value.manifest = [{ path: 'docs/guide.md' }];
  value.verification = { succeeded: true, checks: [] };
  const spec = { delivery_requirements: [{ id: 'DR-doc', outcome: 'Document the instructions',
    evidence: 'The guide explains the supported steps.', source_scope: ['docs/guide.md'] }] };
  assert.equal(reconcileAcceptance(spec, [value]).passed, true);
});

test('actual acceptance loader reads current verified artifacts and records identity-bound durable coverage', async () => {
  const input = fixture();
  const result = await checkImplementationAcceptance(input);
  assert.equal(result.passed, true);
  assert.equal(input.receipts.length, 1);
  assert.deepEqual(input.receipts[0]._expected_identity, acceptanceIdentity(input.snapshot));
  assert.deepEqual(input.receipts[0]._report, result);
});

test('superseded frontend seed claims never satisfy outcomes in a replacement backend-only patch', async () => {
  const input = fixture();
  input.snapshot.artifacts.push({ id: 'old-front', step_id: 'front', artifact_type: 'code_implementation', status: 'superseded' });
  input.content['old-front'] = { ...bundle().envelope };
  input.content['patch-backend'].acceptance_evidence = [];
  const result = await checkImplementationAcceptance(input);
  assert.equal(result.passed, false);
  assert.equal(input.receipts.length, 1, 'incomplete evidence is durably reported, not silently accepted');
  assert.match(result.blockers.join(' '), /skipped lane/);
  assert.ok(!input.receipts[0]._expected_identity.artifacts.some(item => item.id === 'old-front'));
});

test('correction identity, artifacts, worker outputs and skipped-lane state invalidate prior receipts', () => {
  for (const mutate of [
    value => { value.job.code_review_revision = { approval_id: 'new-review' }; },
    value => { value.job.target_sha = 'b'.repeat(40); },
    value => { value.artifacts[1].checksum = 'new-checksum'; },
    value => { value.artifacts[1].status = 'superseded'; },
    value => { value.workerRuns[0].output_artifact_ids.push('new-log'); },
    value => { value.steps[0].status = 'completed'; }
  ]) {
    const { snapshot } = fixture();
    const before = acceptanceIdentity(snapshot);
    mutate(snapshot);
    assert.notDeepEqual(acceptanceIdentity(snapshot), before);
  }
});

test('missing/ambiguous worker evidence and unsuccessful verification produce explicit blockers', async () => {
  for (const mutate of [
    value => { value.snapshot.workerRuns = []; },
    value => { value.snapshot.workerRuns[0].target_sha = 'other-target'; },
    value => { value.snapshot.workerRuns[0].organization_id = 'other-org'; },
    value => { value.snapshot.artifacts[1].step_id = 'front'; },
    value => { value.snapshot.workerRuns.push({ ...value.snapshot.workerRuns[0], id: 'second' }); },
    value => { value.snapshot.artifacts = value.snapshot.artifacts.filter(item => item.id !== 'logs'); },
    value => { value.content.logs.succeeded = false; }
  ]) {
    const input = fixture();
    mutate(input);
    assert.equal((await checkImplementationAcceptance(input)).passed, false);
    assert.equal(input.receipts.length, 1);
  }
});

test('unreadable or stale acceptance evidence fails explicitly without success-shaped fallback', async () => {
  const input = fixture();
  await assert.rejects(checkImplementationAcceptance({ ...input, loadArtifact: async () => { throw new Error('artifact integrity check failed'); } }), /integrity/);
  assert.equal(input.receipts.length, 0);
  input.supabase.rpc = async () => ({ error: { message: 'Acceptance evidence changed' } });
  await assert.rejects(checkImplementationAcceptance(input), /could not be recorded: Acceptance evidence changed/);
});

test('all review policies and release are blocked before executing their protected action', async () => {
  for (const type of ['start_optional_review', 'run_independent_review', 'run_release']) {
    const { snapshot } = fixture();
    snapshot.job.code_review_mode = 'none';
    const result = await executeBuilderAction({ snapshot, action: { type }, supabase: {}, context: {},
      handlers: { acceptance: async () => ({ passed: false, blockers: ['DR-1 missing actual workflow'] }),
        optionalReview: async () => assert.fail('must not start review'), independentReview: async () => assert.fail('must not start review'),
        release: async () => assert.fail('must not start release') } });
    assert.equal(result.success, false);
    assert.equal(result.phase, 'acceptance');
  }
});

test('incomplete acceptance parks autopilot without another author attempt or approval request', async () => {
  const { snapshot } = fixture();
  snapshot.job.code_review_mode = 'none';
  const result = await runBuilderUntilPause({ supabase: {}, jobId: 'job', context: {}, loadSnapshot: async () => snapshot,
    handlers: { acceptance: async () => ({ passed: false, blockers: ['DR-1 missing actual workflow'] }),
      optionalReview: async () => assert.fail('must not request approval') } });
  assert.equal(result.reason, 'acceptance_incomplete');
  assert.match(result.detail, /DR-1/);
  snapshot.steps.find(step => step.step_id === 'code_review').status = 'blocked';
  const existing = await runBuilderUntilPause({ supabase: {}, jobId: 'job', context: {}, loadSnapshot: async () => snapshot,
    handlers: { acceptance: async () => ({ passed: false, blockers: ['DR-1 missing actual workflow'] }) } });
  assert.equal(existing.reason, 'acceptance_incomplete', 'pre-existing pending human reviews are reconciled too');
});

test('human mode preserves an explicitly incomplete correction gate, not a completed acceptance claim', async () => {
  const { snapshot } = fixture();
  let called = false;
  const report = { passed: false, blockers: ['DR-1 missing actual workflow'] };
  const result = await executeBuilderAction({ snapshot, action: { type: 'start_optional_review', step: snapshot.steps.find(step => step.step_id === 'code_review') }, supabase: {}, context: {},
    handlers: { acceptance: async () => report, optionalReview: async () => { called = true; return { success: true }; } } });
  assert.equal(called, true, 'owner-confirmed same-job code changes still have a pending review to bind');
  assert.equal(result.success, true);
});
