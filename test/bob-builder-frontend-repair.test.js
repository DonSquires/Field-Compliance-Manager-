const assert = require('node:assert/strict');
const test = require('node:test');

const {
  sanitizeVerificationFailure,
  loadJsonArtifact,
  runFrontendRepair
} = require('../supabase/functions/_shared/builder-frontend-repair');

const replacementPatch = [
  'diff --git a/apps/web/src/example.ts b/apps/web/src/example.ts',
  '--- a/apps/web/src/example.ts',
  '+++ b/apps/web/src/example.ts',
  '@@ -1 +1 @@',
  '-export const value = 1;',
  '+export const value = 3;',
  ''
].join('\n');

test('frontend repair evidence is bounded and strips command output secrets', () => {
  const evidence = sanitizeVerificationFailure({
    succeeded: false,
    commands: [{
      command: 'npm run lint --prefix apps/web',
      status: 2,
      stdout: 'token=secret TS1000: failure\n'.repeat(10000),
      stderr: 'authorization: Bearer secret.value'
    }]
  });
  assert.equal(evidence.failed_command, 'npm run lint --prefix apps/web');
  assert.ok(evidence.stdout.length <= 12000);
  assert.doesNotMatch(JSON.stringify(evidence), /secret\.value|token=secret/);
});

test('frontend repair authorizes before model dispatch and uses failure provenance', async () => {
  const calls = [];
  const result = await runFrontendRepair({
    supabase: {},
    gateway: {},
    job: { id: 'job-1', organization_id: 'org-1', target_sha: 'sha-1' },
    step: { id: 'step-1', builder_mode: 'frontend_engineer', status: 'failed', retryable: true, attempt_count: 1 },
    uxArtifact: { id: 'ux-1' },
    failedPatchArtifact: { id: 'patch-1' },
    failureArtifact: { id: 'log-1' },
    sourceDir: '/repo',
    requestedFiles: ['apps/web/src/example.ts'],
    liveContext: { atlas: { capability_count: 1 }, live_data: { scope: 'aggregate row counts only' } },
    collectSource: () => ({ target_sha: 'sha-1', repository_context: { target_sha: 'sha-1', tracked_files: ['apps/web/src/example.ts'] }, files: [{ path: 'apps/web/src/example.ts', content: 'export const value = 1;' }] }),
    loadInputs: async () => ({ uxPlan: {}, failedProposal: { patch: 'old' }, failure: { failed_command: 'lint', stdout: 'error', stderr: '' } }),
    authorizeRepair: async () => { calls.push('authorize'); return { success: true, repair_attempt: 2 }; },
    executeModelRun: async input => {
      calls.push('model');
      assert.deepEqual(input.modelRequest.input_artifact_ids, ['ux-1', 'patch-1', 'log-1']);
      assert.equal(JSON.parse(input.modelRequest.request.user_prompt).repository_context.target_sha, 'sha-1');
      assert.equal(JSON.parse(input.modelRequest.request.user_prompt).live_context.atlas.capability_count, 1);
      return { ok: true, validated_output: { summary: 'Repair', patch: replacementPatch, changed_files: ['apps/web/src/example.ts'], tests: [] }, artifact: { id: 'patch-2' } };
    }
  });
  assert.deepEqual(calls, ['authorize', 'model']);
  assert.equal(result.repair_attempt, 2);
  assert.equal(result.patch_artifact.id, 'patch-2');
});

test('frontend repair stops before model dispatch when attempt ceiling is reached', async () => {
  let modelCalled = false;
  const result = await runFrontendRepair({
    supabase: {}, gateway: {},
    job: { id: 'job-1', organization_id: 'org-1', target_sha: 'sha-1' },
    step: { id: 'step-1', builder_mode: 'frontend_engineer', status: 'failed', retryable: true, attempt_count: 3 },
    uxArtifact: { id: 'ux-1' }, failedPatchArtifact: { id: 'patch-1' }, failureArtifact: { id: 'log-1' },
    sourceDir: '/repo', requestedFiles: ['apps/web/src/example.ts'], collectSource: () => ({ target_sha: 'sha-1', files: [] }),
    loadInputs: async () => ({}),
    authorizeRepair: async () => ({ success: false, error: 'frontend repair attempt limit reached' }),
    executeModelRun: async () => { modelCalled = true; }
  });
  assert.equal(result.ok, false);
  assert.equal(modelCalled, false);
});

test('frontend repair loader rejects tampered failure evidence', async () => {
  const query = {
    select(){return this;}, eq(){return this;},
    single: async () => ({ data: {
      id: 'log-1', job_id: 'job-1', artifact_type: 'build_logs', status: 'final',
      storage_location: 'supabase_storage://builder-artifacts/log.json', checksum: 'a'.repeat(64)
    }, error: null })
  };
  const supabase = {
    from: () => query,
    storage: { from: () => ({ download: async () => ({ data: { arrayBuffer: async () => Buffer.from('{}') }, error: null }) }) }
  };
  await assert.rejects(loadJsonArtifact(supabase, 'log-1', 'job-1', 'build_logs'), /integrity check failed/);
});