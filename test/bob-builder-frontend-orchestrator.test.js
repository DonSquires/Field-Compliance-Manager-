const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_FRONTEND_ATTEMPTS,
  runFrontendImplementation
} = require('../builder-frontend-orchestrator');

const base = {
  supabase: {}, gateway: {},
  job: { id: 'job-1', organization_id: 'org-1', target_sha: 'sha-1' },
  step: { id: 'step-1', builder_mode: 'frontend_engineer', status: 'pending', attempt_count: 0 },
  uxArtifact: { id: 'ux-1' }, sourceDir: '/repo', requestedFiles: ['apps/web/src/App.tsx'],
  workerImage: 'worker:test', runnerId: 'runner-1'
};

test('frontend verifier gets a 45-minute default and bounded explicit overrides', async () => {
  const previous = process.env.BOB_BUILDER_FRONTEND_TIMEOUT_SECONDS;
  try {
    for (const [configured, expected] of [[undefined, 2700], ['120', 300], ['9999', 3600], ['2100', 2100]]) {
      if (configured === undefined) delete process.env.BOB_BUILDER_FRONTEND_TIMEOUT_SECONDS;
      else process.env.BOB_BUILDER_FRONTEND_TIMEOUT_SECONDS = configured;
      const result = await runFrontendImplementation({
        ...base,
        generate: async () => ({ ok: true, patch_artifact: { id: 'patch' } }),
        handoff: async input => {
          assert.equal(input.timeoutSeconds, expected);
          return { success: true, artifacts: [], job: { status: 'testing' } };
        },
      });
      assert.equal(result.success, true);
    }
  } finally {
    if (previous === undefined) delete process.env.BOB_BUILDER_FRONTEND_TIMEOUT_SECONDS;
    else process.env.BOB_BUILDER_FRONTEND_TIMEOUT_SECONDS = previous;
  }
});

test('frontend orchestration repairs a failed patch from durable evidence and succeeds', async () => {
  const calls = [];
  const result = await runFrontendImplementation({
    ...base,
    generate: async () => { calls.push('generate'); return { ok: true, patch_artifact: { id: 'patch-1' } }; },
    handoff: async ({ patchArtifact }) => {
      calls.push(`verify:${patchArtifact.id}`);
      if (patchArtifact.id === 'patch-1') return {
        success: false, worker_run_id: 'run-1', artifacts: [{ id: 'log-1', artifact_type: 'build_logs' }], job: { status: 'implementation_pending' }
      };
      return { success: true, artifacts: [{ id: 'log-2' }], job: { status: 'testing' } };
    },
    reloadStep: async () => ({ ...base.step, status: 'failed', retryable: true, attempt_count: 1 }),
    repair: async input => {
      calls.push(`repair:${input.failureArtifact.id}`);
      return { ok: true, patch_artifact: { id: 'patch-2' } };
    }
  });
  assert.equal(result.success, true);
  assert.equal(result.attempts, 2);
  assert.deepEqual(calls, ['generate', 'verify:patch-1', 'repair:log-1', 'verify:patch-2']);
});

test('frontend orchestration never exceeds the worker attempt ceiling', async () => {
  let verifications = 0;
  let repairs = 0;
  const result = await runFrontendImplementation({
    ...base,
    generate: async () => ({ ok: true, patch_artifact: { id: 'patch-0' } }),
    handoff: async () => {
      verifications += 1;
      return { success: false, worker_run_id: `run-${verifications}`, artifacts: [{ id: `log-${verifications}` }], job: { status: 'implementation_pending' } };
    },
    reloadStep: async () => ({ ...base.step, status: 'failed', retryable: true, attempt_count: verifications }),
    repair: async () => {
      repairs += 1;
      return repairs === 3
        ? { ok: false, status: 409, error: 'frontend repair attempt limit reached' }
        : { ok: true, patch_artifact: { id: `patch-${repairs}` } };
    }
  });
  assert.equal(result.success, false);
  assert.equal(result.attempts, MAX_FRONTEND_ATTEMPTS);
  assert.equal(verifications, 3);
  assert.equal(repairs, 2, 'do not author a final patch that will never be verified');
  assert.equal(result.phase, 'repair_limit');
});

test('frontend orchestration stops if durable state marks the step non-retryable', async () => {
  let repairCalled = false;
  const result = await runFrontendImplementation({
    ...base,
    generate: async () => ({ ok: true, patch_artifact: { id: 'patch-1' } }),
    handoff: async () => ({ success: false, worker_run_id: 'run-1', artifacts: [{ id: 'log-1' }], job: { status: 'failed' } }),
    reloadStep: async () => ({ ...base.step, status: 'failed', retryable: false, attempt_count: 1 }),
    repair: async () => { repairCalled = true; }
  });
  assert.equal(result.success, false);
  assert.equal(repairCalled, false);
});
test('a verifier infrastructure failure re-runs the same patch once instead of asking the author to repair', async () => {
  const { classifyVerificationFailure } = require('../builder-verification-outcome');
  // The evidence job ecfb4dc4 produced: lint died of heap exhaustion (exit 134).
  const oom = { succeeded: false, commands: [
    { command: 'git apply --check', status: 0 },
    { command: 'npm run lint --prefix apps/web', status: 134, stderr: 'FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory' },
  ] };
  assert.deepEqual(classifyVerificationFailure(oom), { infrastructure: true, baseline: false, reason: 'npm run lint --prefix apps/web: heap out of memory' });
  assert.deepEqual(classifyVerificationFailure({ succeeded: false, commands: [{ command: 'npm run test', status: 1, stdout: '3 failed' }] }), { infrastructure: false, baseline: false, reason: null });
  assert.deepEqual(classifyVerificationFailure({ succeeded: false, checks: [{ command: 'node --test test/x.test.js', status: 137, stderr: '' }] }).infrastructure, true, 'SIGKILL (cgroup OOM) is never a test result');
  assert.equal(classifyVerificationFailure({ succeeded: true }).infrastructure, false);

  const calls = [];
  let verifications = 0;
  const result = await runFrontendImplementation({
    ...base,
    generate: async () => { calls.push('generate'); return { ok: true, patch_artifact: { id: 'patch-1' } }; },
    handoff: async ({ patchArtifact }) => {
      verifications += 1;
      calls.push(`verify:${patchArtifact.id}`);
      if (verifications === 1) return { success: false, infrastructure_failure: true, infrastructure_reason: 'npm run lint: heap out of memory', worker_run_id: 'run-1', artifacts: [{ id: 'log-1' }], job: { status: 'implementation_pending' } };
      return { success: true, artifacts: [{ id: 'log-2' }], job: { status: 'testing' } };
    },
    reloadStep: async () => ({ ...base.step, status: 'failed', retryable: true, attempt_count: verifications }),
    repair: async () => { calls.push('repair'); throw new Error('the author must not be asked to repair an infrastructure failure'); }
  });
  assert.equal(result.success, true);
  assert.deepEqual(calls, ['generate', 'verify:patch-1', 'verify:patch-1']);

  // Repeated infrastructure failure parks the saved patch; it never becomes a code repair.
  const calls2 = [];
  await runFrontendImplementation({
    ...base,
    generate: async () => ({ ok: true, patch_artifact: { id: 'patch-1' } }),
    handoff: async ({ patchArtifact }) => { calls2.push(`verify:${patchArtifact.id}`); return { success: false, infrastructure_failure: true, worker_run_id: 'run', artifacts: [{ id: 'log' }], job: {} }; },
    reloadStep: async () => ({ ...base.step, status: 'failed', retryable: true }),
    repair: async () => { calls2.push('repair'); return { ok: true, patch_artifact: { id: 'patch-2' } }; }
  });
  assert.deepEqual(calls2, ['verify:patch-1', 'verify:patch-1']);
});

test('a resumed step verifies the patch the lost verifier was checking instead of authoring again', async () => {
  const calls = [];
  const result = await runFrontendImplementation({
    ...base,
    resumePatchArtifact: { id: 'patch-lost', artifact_type: 'code_implementation', status: 'final' },
    generate: async () => { calls.push('generate'); return { ok: true, patch_artifact: { id: 'patch-new' } }; },
    handoff: async ({ patchArtifact }) => { calls.push(`verify:${patchArtifact.id}`); return { success: true, artifacts: [], job: { status: 'testing' } }; },
    reloadStep: async () => base.step,
    repair: async () => { throw new Error('no repair expected'); }
  });
  assert.equal(result.success, true);
  assert.deepEqual(calls, ['verify:patch-lost'], 'job ecfb4dc4: the author is not re-run for a patch nobody rejected');
});

test('a red baseline parks the step with the reason instead of sending the author a repair', async () => {
  const calls = [];
  const rpcs = [];
  const result = await runFrontendImplementation({
    ...base,
    supabase: { rpc: async (name, args) => { rpcs.push({ name, args }); return { data: {}, error: null }; } },
    generate: async () => ({ ok: true, patch_artifact: { id: 'patch-1' } }),
    handoff: async () => ({ success: false, worker_run_id: 'run-1', artifacts: [{ id: 'log-1' }], job: { status: 'implementation_pending' }, baseline_failure: true, baseline_reason: 'npm run test also fails on the pinned commit without this patch: src/pages/FinanceBureauPage.guard.test.ts; not caused by this change' }),
    reloadStep: async () => ({ ...base.step, status: 'failed', retryable: true, attempt_count: 1 }),
    repair: async () => { calls.push('repair'); return { ok: true, patch_artifact: { id: 'patch-2' } }; }
  });
  assert.equal(result.success, false);
  assert.equal(result.phase, 'baseline');
  assert.deepEqual(calls, [], 'no author repair for someone else\'s red main');
  assert.equal(rpcs[0].name, 'builder_record_generation_failure');
  assert.equal(rpcs[0].args._retryable, false);
  assert.match(rpcs[0].args._reason, /^baseline: repository red at the pinned commit: npm run test also fails/);
});
