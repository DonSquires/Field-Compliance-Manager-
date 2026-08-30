const assert = require('node:assert/strict');
const test = require('node:test');

const {
  RELEASE_ENGINEER_PROMPT_VERSION,
  deriveReleaseImpact,
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
  assert.throws(() => deriveReleaseImpact(['supabase/migrations/change.sql']), /outside approved frontend scope/);
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
  assert.equal(captured.modelRequest.provider, 'openai');
  assert.equal(captured.modelRequest.prompt_version, RELEASE_ENGINEER_PROMPT_VERSION);
  assert.deepEqual(captured.modelRequest.input_artifact_ids, ['patch-1', 'manifest-1', 'logs-1', 'security-1', 'review-1']);
  assert.equal(result.approval.id, 'approval-1');
});