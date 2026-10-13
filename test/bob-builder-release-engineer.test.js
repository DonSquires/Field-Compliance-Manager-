const assert = require('node:assert/strict');
const test = require('node:test');

const {
  RELEASE_ENGINEER_PROMPT_VERSION,
  deriveReleaseImpact,
  mergeImplementationEvidence,
  parseReleasePackage,
  runReleaseEngineer
} = require('../supabase/functions/_shared/builder-release-engineer');

function releasePackage() {
  return {
    summary: 'Adds a governed approval view',
    changed_files: ['apps/web/src/pages/ApprovalsActivityPage.tsx'],
    impact: { schema: false, authentication: false, authorization: false, dependencies: false, environment: false, infrastructure: false },
    deployment_checklist: ['Confirm target commit', 'Review verified artifacts'],
    rollback_steps: ['Revert the exact patch commit', 'Run frontend verification'],
    release_notes: ['Added governed approval activity'],
    known_risks: [],
    unresolved_questions: []
  };
}

test('release impact is derived from changed files and blocks undeclared sensitive surfaces', () => {
  assert.deepEqual(deriveReleaseImpact(['apps/web/src/pages/ExamplePage.tsx']), {
    schema: false, authentication: false, authorization: false,
    dependencies: false, environment: false, infrastructure: false
  });
  assert.deepEqual(deriveReleaseImpact(['supabase/migrations/20260830000000_add_policy.sql']), {
    schema: true, authentication: false, authorization: true,
    dependencies: false, environment: false, infrastructure: false
  });
  assert.throws(() => deriveReleaseImpact(['package.json']), /outside approved implementation scope/);
});

test('release package parser enforces evidence-derived files and impact', () => {
  const parsed = parseReleasePackage(JSON.stringify(releasePackage()), {
    changedFiles: ['apps/web/src/pages/ApprovalsActivityPage.tsx'],
    impact: deriveReleaseImpact(['apps/web/src/pages/ApprovalsActivityPage.tsx'])
  });
  assert.equal(parsed.summary, 'Adds a governed approval view');
  assert.throws(() => parseReleasePackage(JSON.stringify({ ...releasePackage(), changed_files: ['apps/web/src/other.ts'] }), {
    changedFiles: ['apps/web/src/pages/ApprovalsActivityPage.tsx'],
    impact: deriveReleaseImpact(['apps/web/src/pages/ApprovalsActivityPage.tsx'])
  }), /changed files do not match/);
  // A structured summary object (job 42b542a5's release engineer) is flattened to prose rather than refused.
  const structured = parseReleasePackage(JSON.stringify({ ...releasePackage(), summary: { release_status: 'evidence_prepared', production_deployment: 'disabled' } }), {
    changedFiles: ['apps/web/src/pages/ApprovalsActivityPage.tsx'],
    impact: deriveReleaseImpact(['apps/web/src/pages/ApprovalsActivityPage.tsx'])
  });
  assert.equal(structured.summary, 'release_status: evidence_prepared; production_deployment: disabled');
  assert.throws(() => parseReleasePackage(JSON.stringify({ ...releasePackage(), summary: '' }), {
    changedFiles: ['apps/web/src/pages/ApprovalsActivityPage.tsx'],
    impact: deriveReleaseImpact(['apps/web/src/pages/ApprovalsActivityPage.tsx'])
  }), /summary is required/);
});

test('release evidence merges frontend and backend manifests without losing verification provenance', () => {
  const merged = mergeImplementationEvidence([
    [{ path: 'apps/web/src/example.ts' }],
    [{ path: 'supabase/migrations/20260830190000_example.sql' }]
  ], [
    { succeeded: true, verification_scope: 'frontend' },
    { succeeded: true, verification_scope: 'static_backend_patch', migration_execution: { succeeded: true, performed: true } }
  ]);
  assert.deepEqual(merged.changedFiles, [
    'apps/web/src/example.ts', 'supabase/migrations/20260830190000_example.sql'
  ]);
  assert.equal(merged.verification.length, 2);
  assert.throws(() => mergeImplementationEvidence([
    [{ path: 'apps/web/src/example.ts' }], [{ path: 'apps/web/src/example.ts' }]
  ], [{ succeeded: true }, { succeeded: true }]), /same file more than once/);
});

test('release engineer uses verified implementation and security artifact provenance', async () => {
  let captured;
  const result = await runReleaseEngineer({
    supabase: {}, gateway: {},
    job: { id: 'job-1', organization_id: 'org-1', target_sha: 'sha-1' },
    step: { id: 'release-step', step_id: 'release_prep', builder_mode: 'release_engineer' },
    artifacts: {
      patch: { id: 'patch-1' }, manifest: { id: 'manifest-1' },
      buildLogs: { id: 'logs-1' }, securityReview: { id: 'security-1' },
      codeReview: { id: 'review-1' }
    },
    securityWorkerRunId: 'security-run-1',
    loadEvidence: async () => ({
      changedFiles: ['apps/web/src/pages/ApprovalsActivityPage.tsx'],
      verification: { succeeded: true },
      security: { passed: true, counts: { critical: 0, high: 0, medium: 0, low: 0 } },
      impact: deriveReleaseImpact(['apps/web/src/pages/ApprovalsActivityPage.tsx'])
    }),
    startRelease: async () => ({ success: true }),
    executeModelRun: async input => {
      captured = input;
      return { ok: true, validated_output: releasePackage(), artifact: { id: 'release-notes-1' } };
    },
    persistPackage: async () => ({
      success: true,
      artifacts: { releaseNotes: { id: 'release-notes-1' }, rollbackPlan: { id: 'rollback-1' }, deploymentManifest: { id: 'manifest-release-1' } }
    }),
    completeRelease: async () => ({ success: true, approval: { id: 'approval-1' } }),
    abortRelease: async () => ({ success: true })
  });
  assert.deepEqual(captured.modelRequest.chain, ['openai', 'gpu_workstation']);
  assert.equal(captured.modelRequest.provider, 'openai');
  assert.equal(captured.modelRequest.prompt_version, RELEASE_ENGINEER_PROMPT_VERSION);
  assert.deepEqual(captured.modelRequest.input_artifact_ids, ['patch-1', 'manifest-1', 'logs-1', 'security-1', 'review-1']);
  assert.equal(result.approval.id, 'approval-1');
});

test('release evidence rejects a missing independent AI review artifact', async () => {
  const { loadReleaseEvidence } = require('../supabase/functions/_shared/builder-release-engineer');
  const content = {
    patch: 'diff',
    manifest: JSON.stringify([{ path: 'apps/web/src/example.ts' }]),
    logs: JSON.stringify({ succeeded: true }),
    security: JSON.stringify({ passed: true, counts: { critical: 0, high: 0 } })
  };
  const crypto = require('node:crypto');
  const rows = {
    patch: { id: 'patch', artifact_type: 'code_implementation', body: content.patch },
    manifest: { id: 'manifest', artifact_type: 'changed_file_manifest', body: content.manifest },
    logs: { id: 'logs', artifact_type: 'build_logs', body: content.logs },
    security: { id: 'security', artifact_type: 'security_review', body: content.security }
  };
  let active;
  const query = { select(){return this;}, eq(_field, value){ if (_field === 'id') active = rows[value]; return this; }, single:async()=>({ data: {
    id: active.id, job_id: 'job-1', artifact_type: active.artifact_type, status: 'final',
    storage_location: `supabase_storage://builder-artifacts/${active.id}`, checksum: crypto.createHash('sha256').update(active.body).digest('hex')
  }, error: null }) };
  const supabase = { from:()=>query, storage:{from:()=>({download:async objectPath=>({data:{arrayBuffer:async()=>Buffer.from(rows[objectPath].body)},error:null})})} };
  await assert.rejects(loadReleaseEvidence({
    supabase,
    job: { id: 'job-1', code_review_mode: 'independent_ai' },
    artifacts: { patch: rows.patch, manifest: rows.manifest, buildLogs: rows.logs, securityReview: rows.security }
  }), /passed independent code review evidence is required/);
});