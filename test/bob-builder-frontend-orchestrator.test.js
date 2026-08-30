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
  assert.equal(repairs, 3);
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