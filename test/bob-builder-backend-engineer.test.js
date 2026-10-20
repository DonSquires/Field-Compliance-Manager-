const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const {
  BACKEND_ENGINEER_PROMPT_VERSION,
  collectBackendSourceContext,
  parseBackendProposal,
  runBackendEngineer
} = require('../supabase/functions/_shared/builder-backend-engineer');

function repositoryFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-source-'));
  fs.mkdirSync(path.join(root, 'supabase/functions/example'), { recursive: true });
  fs.mkdirSync(path.join(root, 'supabase/migrations'), { recursive: true });
  fs.writeFileSync(path.join(root, 'supabase/functions/example/index.ts'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(root, 'supabase/migrations/20260830000000_example.sql'), 'SELECT 1;\n');
  fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  return { root, sha };
}

function migrationPatch(sql = 'CREATE TABLE public.example (id uuid PRIMARY KEY);') {
  return [
    'diff --git a/supabase/migrations/20260830000000_example.sql b/supabase/migrations/20260830000000_example.sql',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/supabase/migrations/20260830000000_example.sql',
    '@@ -0,0 +1 @@',
    `+${sql}`,
    ''
  ].join('\n');
}

function proposal(patch = migrationPatch()) {
  return JSON.stringify({
    summary: 'Add example schema',
    patch,
    changed_files: ['supabase/migrations/20260830000000_example.sql'],
    database_migrations: ['supabase/migrations/20260830000000_example.sql'],
    edge_functions: [],
    tests: ['npm test'],
    rollback_notes: ['Disable callers and apply an additive forward fix.']
  });
}

test('Backend Engineer source context requires a clean commit-pinned repository', () => {
  const fixture = repositoryFixture();
  try {
    const context = collectBackendSourceContext({
      sourceDir: fixture.root,
      targetSha: fixture.sha,
      requestedFiles: ['supabase/functions/example/index.ts', 'supabase/migrations/20260830000000_example.sql']
    });
    assert.equal(context.target_sha, fixture.sha);
    assert.deepEqual(context.files.map(file => file.path), [
      'supabase/functions/example/index.ts',
      'supabase/migrations/20260830000000_example.sql'
    ]);
    assert.equal(context.repository_context.target_sha, fixture.sha);
    assert.equal(context.repository_context.file_count, 3);
    fs.writeFileSync(path.join(fixture.root, 'supabase/functions/example/index.ts'), 'dirty');
    assert.throws(() => collectBackendSourceContext({
      sourceDir: fixture.root,
      targetSha: fixture.sha,
      requestedFiles: ['supabase/functions/example/index.ts']
    }), /clean checkout/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('Backend Engineer source context rejects files outside governed backend paths', () => {
  const fixture = repositoryFixture();
  try {
    assert.throws(() => collectBackendSourceContext({
      sourceDir: fixture.root,
      targetSha: fixture.sha,
      requestedFiles: ['package.json']
    }), /outside approved backend paths/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('Backend Engineer proposal requires exact manifests and rollback notes', () => {
  const parsed = parseBackendProposal(proposal());
  assert.equal(parsed.risk.schema_change, true);
  assert.equal(parsed.risk.requires_human_approval, true);
  assert.deepEqual(parsed.risk.approval_reasons, ['schema_change']);
  const mismatch = JSON.parse(proposal());
  mismatch.database_migrations = [];
  assert.throws(() => parseBackendProposal(JSON.stringify(mismatch)), /database_migrations do not match/);
  const noRollback = JSON.parse(proposal());
  noRollback.rollback_notes = [];
  assert.throws(() => parseBackendProposal(JSON.stringify(noRollback)), /rollback_notes must not be empty/);
  const historicalEdit = JSON.parse(proposal(migrationPatch().replace('new file mode 100644\n--- /dev/null', '--- a/supabase/migrations/20260830000000_example.sql')));
  assert.throws(() => parseBackendProposal(JSON.stringify(historicalEdit)), /new additive file/);
});

test('Backend Engineer rejects destructive SQL and non-backend patch paths', () => {
  assert.throws(() => parseBackendProposal(proposal(migrationPatch('DROP TABLE public.example;'))), /destructive SQL/);
  assert.throws(() => parseBackendProposal(proposal(migrationPatch('DELETE FROM public.example;'))), /destructive SQL/);
  const unsafePatch = migrationPatch().replaceAll('supabase/migrations/20260830000000_example.sql', 'apps/web/src/example.ts');
  const unsafe = JSON.parse(proposal(unsafePatch));
  unsafe.changed_files = ['apps/web/src/example.ts'];
  unsafe.database_migrations = [];
  assert.throws(() => parseBackendProposal(JSON.stringify(unsafe)), /backend patch cannot modify/);
});

test('Backend Engineer flags authorization changes for human approval', () => {
  const parsed = parseBackendProposal(proposal(migrationPatch('GRANT SELECT ON public.example TO authenticated;')));
  assert.equal(parsed.risk.authorization_change, true);
  assert.deepEqual(parsed.risk.approval_reasons, ['schema_change', 'authorization_change']);
});

test('Backend Engineer routes approved specification and source through governed model runner', async () => {
  const fixture = repositoryFixture();
  let captured;
  try {
    const validated = parseBackendProposal(proposal());
    const result = await runBackendEngineer({
      supabase: {},
      gateway: {},
      job: { id: 'job-1', organization_id: 'org-1', target_sha: fixture.sha },
      step: { id: 'step-4', builder_mode: 'backend_engineer' },
      productArtifact: { id: 'spec-1', artifact_type: 'product_specification', status: 'final' },
      sourceDir: fixture.root,
      requestedFiles: ['supabase/migrations/20260830000000_example.sql'],
      liveContext: { atlas: { capability_count: 1 }, live_data: { scope: 'aggregate row counts only' } },
      loadProductSpecification: async () => ({ specification: { acceptance_criteria: [{ id: 'AC-1' }] } }),
      executeModelRun: async input => {
        captured = input;
        return { ok: true, validated_output: validated, artifact: { id: 'patch-1' } };
      }
    });
    assert.deepEqual(captured.modelRequest.chain, ['gpu_workstation', 'ollama_cloud', 'openai']);
    assert.equal(captured.modelRequest.provider, 'gpu_workstation');
    assert.equal(captured.modelRequest.prompt_version, BACKEND_ENGINEER_PROMPT_VERSION);
    assert.deepEqual(captured.modelRequest.input_artifact_ids, ['spec-1']);
    assert.equal(JSON.parse(captured.modelRequest.request.user_prompt).repository_context.target_sha, fixture.sha);
    assert.equal(JSON.parse(captured.modelRequest.request.user_prompt).live_context.atlas.capability_count, 1);
    assert.equal(result.patch_artifact.id, 'patch-1');
    assert.equal(result.proposal.risk.requires_human_approval, true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});