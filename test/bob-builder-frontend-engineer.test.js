const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const {
  FRONTEND_ENGINEER_PROMPT_VERSION,
  collectFrontendSourceContext,
  parseFrontendProposal,
  runFrontendEngineer
} = require('../supabase/functions/_shared/builder-frontend-engineer');

const patch = [
  'diff --git a/apps/web/src/example.ts b/apps/web/src/example.ts',
  '--- a/apps/web/src/example.ts',
  '+++ b/apps/web/src/example.ts',
  '@@ -1 +1 @@',
  '-export const value = 1;',
  '+export const value = 2;',
  ''
].join('\n');

function repositoryFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-source-'));
  fs.mkdirSync(path.join(root, 'apps/web/src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'supabase'), { recursive: true });
  fs.writeFileSync(path.join(root, 'apps/web/src/example.ts'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(root, 'supabase/schema.sql'), 'CREATE TABLE "public"."example" (id uuid);\nCREATE OR REPLACE FUNCTION "public"."example_function"() RETURNS void LANGUAGE sql AS $$ SELECT; $$;\n');
  fs.writeFileSync(path.join(root, '.env'), 'SHOULD_NOT_APPEAR=true\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  return { root, sha };
}

test('Frontend Engineer source context requires a clean commit-pinned repository', () => {
  const fixture = repositoryFixture();
  try {
    const context = collectFrontendSourceContext({
      sourceDir: fixture.root,
      targetSha: fixture.sha,
      requestedFiles: ['apps/web/src/example.ts']
    });
    assert.equal(context.target_sha, fixture.sha);
    assert.equal(context.files[0].path, 'apps/web/src/example.ts');
    assert.equal(context.repository_context.target_sha, fixture.sha);
    assert.deepEqual(context.repository_context.tracked_files, ['apps/web/src/example.ts', 'supabase/schema.sql']);
    assert.deepEqual(context.repository_context.schema.tables, ['example']);
    assert.deepEqual(context.repository_context.schema.functions, ['example_function']);
    assert.equal(context.repository_context.secret_files_excluded, true);
    fs.writeFileSync(path.join(fixture.root, 'apps/web/src/example.ts'), 'dirty');
    assert.throws(() => collectFrontendSourceContext({
      sourceDir: fixture.root, targetSha: fixture.sha, requestedFiles: ['apps/web/src/example.ts']
    }), /clean checkout/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('Frontend Engineer source context rejects non-frontend and symlink files', () => {
  const fixture = repositoryFixture();
  try {
    assert.throws(() => collectFrontendSourceContext({
      sourceDir: fixture.root, targetSha: fixture.sha, requestedFiles: ['package.json']
    }), /outside apps\/web\/src/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('Frontend Engineer proposal parser validates unified diff and declared files', () => {
  const proposal = parseFrontendProposal(JSON.stringify({
    summary: 'Update example', patch, changed_files: ['apps/web/src/example.ts'], tests: ['npm run lint --prefix apps/web']
  }));
  assert.equal(proposal.patch, patch);
  assert.throws(() => parseFrontendProposal(JSON.stringify({
    summary: 'Mismatch', patch, changed_files: ['apps/web/src/other.ts'], tests: []
  })), /changed_files do not match/);
});

test('Frontend Engineer routes approved UX and bounded source through governed model runner', async () => {
  const fixture = repositoryFixture();
  let captured;
  try {
    const result = await runFrontendEngineer({
      supabase: {},
      gateway: {},
      job: { id: 'job-1', organization_id: 'org-1', target_sha: fixture.sha },
      step: { id: 'step-3', builder_mode: 'frontend_engineer' },
      uxArtifact: { id: 'ux-1', artifact_type: 'ui_design_plan', status: 'final' },
      sourceDir: fixture.root,
      requestedFiles: ['apps/web/src/example.ts'],
      liveContext: { atlas: { capability_count: 1 }, live_data: { scope: 'aggregate row counts only' } },
      loadUxPlan: async () => ({ designPlan: { route_map: [], component_inventory: [] } }),
      executeModelRun: async input => {
        captured = input;
        return { ok: true, validated_output: { summary: 'Update example', patch, changed_files: ['apps/web/src/example.ts'], tests: [] }, artifact: { id: 'patch-1' } };
      }
    });
    assert.deepEqual(captured.modelRequest.chain, ['gpu_workstation', 'ollama_cloud', 'openai']);
    assert.equal(captured.modelRequest.provider, 'gpu_workstation');
    assert.equal(captured.modelRequest.prompt_version, FRONTEND_ENGINEER_PROMPT_VERSION);
    assert.deepEqual(captured.modelRequest.input_artifact_ids, ['ux-1']);
    assert.equal(JSON.parse(captured.modelRequest.request.user_prompt).repository_context.target_sha, fixture.sha);
    assert.equal(JSON.parse(captured.modelRequest.request.user_prompt).live_context.atlas.capability_count, 1);
    assert.equal(result.patch_artifact.id, 'patch-1');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});