const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { runBackendHandoff } = require('../builder-backend-handoff');

const patch = [
  'diff --git a/supabase/functions/_shared/example.js b/supabase/functions/_shared/example.js',
  '--- a/supabase/functions/_shared/example.js',
  '+++ b/supabase/functions/_shared/example.js',
  '@@ -1 +1 @@',
  '-module.exports = 1;',
  '+module.exports = 2;',
  ''
].join('\n');

const proposal = JSON.stringify({
  summary: 'Update backend helper', patch,
  changed_files: ['supabase/functions/_shared/example.js'],
  database_migrations: [], edge_functions: [], tests: ['npm test'],
  rollback_notes: ['Restore the previous helper implementation.']
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-handoff-'));
  fs.mkdirSync(path.join(root, 'supabase/functions/_shared'), { recursive: true });
  fs.writeFileSync(path.join(root, 'supabase/functions/_shared/example.js'), 'module.exports = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  return { root, sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() };
}

test('backend handoff claims, verifies, registers evidence, and finishes in order', async () => {
  const repo = fixture();
  const calls = [];
  try {
    const result = await runBackendHandoff({
      supabase: {},
      job: { id: 'job-1', organization_id: 'org-1', target_sha: repo.sha },
      step: { id: 'step-4', builder_mode: 'backend_engineer' },
      patchArtifact: { id: 'patch-1' }, sourceDir: repo.root,
      workerImage: 'worker:test', runnerId: 'runner-1',
      loadPatch: async () => ({ bytes: Buffer.from(proposal) }),
      claim: async () => { calls.push('claim'); return { run_id: 'run-1', lease_token: 'lease', organization_id: 'org-1', job_id: 'job-1' }; },
      resetRetry: async () => { calls.push('reset'); },
      execute: async options => {
        calls.push(`execute:${options.profile}`);
        fs.writeFileSync(path.join(options.artifactDir, 'backend-verification.json'), JSON.stringify({
          succeeded: true, verification_scope: 'static_backend_patch', migration_execution: { performed: false }
        }));
        fs.writeFileSync(path.join(options.artifactDir, 'validated.patch'), patch);
        fs.writeFileSync(path.join(options.artifactDir, 'changed-files.json'), '[]');
        return { status: 'succeeded', exitCode: 0 };
      },
      verifyDatabase: () => ({ succeeded: true, performed: false, candidate_migrations: [] }),
      registerOutput: async (_client, _lease, file, type) => { calls.push(`register:${type}`); return { id: path.basename(file) }; },
      finish: async (_client, _lease, succeeded) => { calls.push(`finish:${succeeded}`); return { status: 'testing' }; }
    });
    assert.equal(result.success, true);
    assert.deepEqual(calls, [
      'claim', 'reset', 'execute:backend-verify', 'register:build_logs',
      'register:code_implementation', 'register:changed_file_manifest', 'finish:true'
    ]);
  } finally {
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test('backend handoff records its failing stage without replacing the original error', async () => {
  const repo = fixture();
  const summaries = [];
  const registrationError = Object.assign(new Error('private storage detail'), { code: 'E_UPLOAD' });
  try {
    await assert.rejects(runBackendHandoff({
      supabase: {},
      job: { id: 'job-1', organization_id: 'org-1', target_sha: repo.sha },
      step: { id: 'step-4', builder_mode: 'backend_engineer' },
      patchArtifact: { id: 'patch-1' }, sourceDir: repo.root,
      workerImage: 'worker:test', runnerId: 'runner-1',
      loadPatch: async () => ({ bytes: Buffer.from(proposal) }),
      claim: async () => ({ run_id: 'run-1', lease_token: 'lease', organization_id: 'org-1', job_id: 'job-1' }),
      resetRetry: async () => {},
      execute: async options => {
        fs.writeFileSync(path.join(options.artifactDir, 'backend-verification.json'), JSON.stringify({ succeeded: false }));
        return { status: 'failed', exitCode: 1 };
      },
      registerOutput: async () => { throw registrationError; },
      finish: async (_client, _lease, _succeeded, _exitCode, summary) => {
        summaries.push(summary);
        return { status: 'failed' };
      }
    }), error => error === registrationError);

    assert.deepEqual(summaries, ['Backend worker handoff failed during registering build-log evidence (Error code=E_UPLOAD)']);
    assert.doesNotMatch(summaries[0], /private storage detail/);
  } finally {
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test('a verifier container that never ran (docker exit 125, no evidence) is an infrastructure failure, not the patch\'s (live job a0379a3d: image pruned)', async () => {
  const repo = fixture();
  const finishes = [];
  try {
    const result = await runBackendHandoff({
      supabase: {},
      job: { id: 'job-125', organization_id: 'org-1', target_sha: repo.sha },
      step: { id: 'step-125', builder_mode: 'backend_engineer' },
      patchArtifact: { id: 'patch-1' }, sourceDir: repo.root,
      workerImage: 'fcm/bob-worker:current', runnerId: 'runner-1',
      loadPatch: async () => ({ bytes: Buffer.from(proposal) }),
      claim: async () => ({ run_id: 'run-125', lease_token: 'lease', organization_id: 'org-1', job_id: 'job-125' }),
      resetRetry: async () => {},
      execute: async () => ({ status: 'failed', exitCode: 125, stdout: '', stderr: "Unable to find image 'fcm/bob-worker:current' locally\ndocker: Error response from daemon: pull access denied for fcm/bob-worker" }),
      verifyDatabase: () => ({ succeeded: true, performed: false, candidate_migrations: [] }),
      registerOutput: async (_client, _lease, file, type) => ({ id: `${type}:${path.basename(file)}` }),
      finish: async (_client, _lease, succeeded, exitCode, summary) => { finishes.push({ succeeded, exitCode, summary }); return { status: 'implementation_pending' }; }
    });
    assert.equal(result.success, false);
    assert.equal(result.infrastructure_failure, true, 'the same patch is re-verified; the author is not asked to repair');
    assert.match(result.infrastructure_reason, /verifier container could not start \(docker exit 125: docker: Error response from daemon: pull access denied/);
    assert.match(result.infrastructure_reason, /fcm\/bob-worker:current exists on the host/);
    assert.equal(result.failure_artifact, null, 'no evidence was written, so none is registered');
    assert.equal(finishes[0].exitCode, 125);
    assert.match(finishes[0].summary, /^Backend verifier infrastructure failure \(the verifier container could not start/);
  } finally {
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test('backend handoff fails closed when evidence overstates migration execution', async () => {
  const repo = fixture();
  const calls = [];
  try {
    const result = await runBackendHandoff({
      supabase: {},
      job: { id: 'job-1', organization_id: 'org-1', target_sha: repo.sha },
      step: { id: 'step-4', builder_mode: 'backend_engineer' },
      patchArtifact: { id: 'patch-1' }, sourceDir: repo.root,
      workerImage: 'worker:test', runnerId: 'runner-1',
      loadPatch: async () => ({ bytes: Buffer.from(proposal) }),
      claim: async () => ({ run_id: 'run-1', lease_token: 'lease', organization_id: 'org-1', job_id: 'job-1' }),
      resetRetry: async () => {},
      execute: async options => {
        fs.writeFileSync(path.join(options.artifactDir, 'backend-verification.json'), JSON.stringify({
          succeeded: true, verification_scope: 'static_backend_patch', migration_execution: { performed: true }
        }));
        return { status: 'succeeded', exitCode: 0 };
      },
      verifyDatabase: () => ({ succeeded: true, performed: false, candidate_migrations: [] }),
      registerOutput: async () => ({ id: 'failure-log' }),
      finish: async (_client, _lease, succeeded) => { calls.push(succeeded); return { status: 'implementation_pending' }; }
    });
    assert.equal(result.success, false);
    assert.deepEqual(calls, [false]);
  } finally {
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test('backend handoff requires matching disposable execution for migration patches', async () => {
  const repo = fixture();
  const migration = 'supabase/migrations/20260830190000_example.sql';
  const migrationPatch = [
    `diff --git a/${migration} b/${migration}`, 'new file mode 100644', '--- /dev/null',
    `+++ b/${migration}`, '@@ -0,0 +1 @@', '+CREATE TABLE public.example (id uuid PRIMARY KEY);', ''
  ].join('\n');
  const migrationProposal = JSON.stringify({
    summary: 'Add backend table', patch: migrationPatch, changed_files: [migration],
    database_migrations: [migration], edge_functions: [], tests: ['npm test'], rollback_notes: ['Apply a forward fix.']
  });
  const finishes = [];
  try {
    const result = await runBackendHandoff({
      supabase: {}, job: { id: 'job-1', organization_id: 'org-1', target_sha: repo.sha },
      step: { id: 'step-4', builder_mode: 'backend_engineer' }, patchArtifact: { id: 'patch-1' },
      sourceDir: repo.root, workerImage: 'worker:test', runnerId: 'runner-1',
      loadPatch: async () => ({ bytes: Buffer.from(migrationProposal) }),
      claim: async () => ({ run_id: 'run-1', lease_token: 'lease', organization_id: 'org-1', job_id: 'job-1' }),
      resetRetry: async () => {},
      execute: async options => {
        fs.writeFileSync(path.join(options.artifactDir, 'backend-verification.json'), JSON.stringify({
          succeeded: true, verification_scope: 'static_backend_patch', migration_execution: { performed: false }
        }));
        fs.writeFileSync(path.join(options.artifactDir, 'validated.patch'), migrationPatch);
        fs.writeFileSync(path.join(options.artifactDir, 'changed-files.json'), '[]');
        return { status: 'succeeded', exitCode: 0 };
      },
      verifyDatabase: () => ({ succeeded: true, performed: true, candidate_migrations: [migration] }),
      registerOutput: async () => ({ id: 'artifact' }),
      finish: async (_client, _lease, succeeded) => { finishes.push(succeeded); return { status: 'testing' }; }
    });
    assert.equal(result.success, true);
    assert.equal(result.verification.migration_execution.performed, true);
    assert.deepEqual(finishes, [true]);
  } finally {
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});