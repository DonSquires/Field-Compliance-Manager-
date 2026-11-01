const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  runFrontendHandoff,
  downloadVerifiedArtifact,
  uploadAndRegisterOutput,
  recordWorkerHandoffFailure
} = require('../builder-frontend-handoff');
const { executeFrontendPatch } = require('../frontend-worker');
const { patchTestPreservationFailures } = require('../builder-test-preservation');

const patch = [
  'diff --git a/apps/web/src/example.ts b/apps/web/src/example.ts',
  '--- a/apps/web/src/example.ts',
  '+++ b/apps/web/src/example.ts',
  '@@ -1 +1 @@',
  '-export const value = 1;',
  '+export const value = 2;',
  ''
].join('\n');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-handoff-'));
  fs.mkdirSync(path.join(root, 'apps/web/src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'apps/web/src/example.ts'), 'export const value = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  return { root, sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() };
}

test('frontend handoff claims, executes, registers evidence, and finishes in order', async () => {
  const repo = fixture();
  const calls = [];
  let workerOptions;
  try {
    const result = await runFrontendHandoff({
      supabase: {},
      job: { id: 'job-1', organization_id: 'org-1', target_sha: repo.sha },
      step: { id: 'step-1', builder_mode: 'frontend_engineer' },
      patchArtifact: { id: 'patch-1' },
      sourceDir: repo.root,
      workerImage: 'worker:test',
      runnerId: 'runner-1',
      loadPatch: async () => ({ bytes: Buffer.from(JSON.stringify({ summary: 'Change', patch, changed_files: ['apps/web/src/example.ts'], tests: [] })) }),
      claim: async () => { calls.push('claim'); return { run_id: 'run-1', lease_token: 'lease', organization_id: 'org-1', job_id: 'job-1' }; },
      resetRetry: async () => { calls.push('reset'); },
      execute: async options => {
        calls.push('execute');
        workerOptions = options;
        fs.writeFileSync(path.join(options.artifactDir, 'verification.json'), JSON.stringify({ succeeded: true }));
        fs.writeFileSync(path.join(options.artifactDir, 'validated.patch'), patch);
        fs.writeFileSync(path.join(options.artifactDir, 'changed-files.json'), '[]');
        return { status: 'succeeded', exitCode: 0 };
      },
      registerOutput: async (_supabase, _lease, file, type) => { calls.push(`register:${type}`); return { id: path.basename(file) }; },
      finish: async (_supabase, _lease, succeeded) => { calls.push(`finish:${succeeded}`); return { status: 'testing' }; }
    });
    assert.equal(result.success, true);
    assert.deepEqual(calls, ['claim', 'reset', 'execute', 'register:build_logs', 'register:code_implementation', 'register:changed_file_manifest', 'finish:true']);
    assert.equal(result.job.status, 'testing');
    assert.equal(workerOptions.memory, '4g', 'tsc on apps/web needs >1 GB of heap plus the node_modules copy on tmpfs');
    assert.equal(workerOptions.cpus, '2');
    assert.equal(workerOptions.pidsLimit, 256);
  } finally {
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test('worker output objects are isolated by lease even when a run is retried', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-output-'));
  const file = path.join(root, 'verification.json');
  const bytes = Buffer.from('{"succeeded":true}');
  fs.writeFileSync(file, bytes);
  const objectPaths = [];
  const bucket = {
    async upload(objectPath) { objectPaths.push(objectPath); return { error: null }; },
    async download() {
      return { data: { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }, error: null };
    },
    async remove() { return { error: null }; }
  };
  const supabase = {
    storage: { from: () => bucket },
    rpc: async () => ({ data: { id: 'artifact' }, error: null })
  };
  try {
    for (const lease_token of ['first-lease-secret', 'second-lease-secret']) {
      await uploadAndRegisterOutput(supabase, {
        organization_id: 'org-1', job_id: 'job-1', run_id: 'reused-run', lease_token
      }, file, 'build_logs', 'application/json');
    }

    assert.equal(objectPaths.length, 2);
    assert.notEqual(objectPaths[0], objectPaths[1]);
    assert.ok(objectPaths.every(objectPath => objectPath.includes('/reused-run/')));
    assert.ok(objectPaths.every(objectPath => !objectPath.includes('lease-secret')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('frontend handoff records its failing stage without replacing the original error', async () => {
  const repo = fixture();
  const summaries = [];
  const registrationError = Object.assign(new Error('private storage detail'), { code: 'E_UPLOAD' });
  try {
    await assert.rejects(runFrontendHandoff({
      supabase: {},
      job: { id: 'job-1', organization_id: 'org-1', target_sha: repo.sha },
      step: { id: 'step-1', builder_mode: 'frontend_engineer' },
      patchArtifact: { id: 'patch-1' },
      sourceDir: repo.root,
      workerImage: 'worker:test',
      runnerId: 'runner-1',
      loadPatch: async () => ({ bytes: Buffer.from(JSON.stringify({ summary: 'Change', patch, changed_files: ['apps/web/src/example.ts'], tests: [] })) }),
      claim: async () => ({ run_id: 'run-1', lease_token: 'lease', organization_id: 'org-1', job_id: 'job-1' }),
      resetRetry: async () => {},
      execute: async options => {
        fs.writeFileSync(path.join(options.artifactDir, 'verification.json'), JSON.stringify({ succeeded: false }));
        return { status: 'failed', exitCode: 1 };
      },
      registerOutput: async () => { throw registrationError; },
      finish: async (_supabase, _lease, _succeeded, _exitCode, summary) => {
        summaries.push(summary);
        return { status: 'failed' };
      }
    }), error => error === registrationError);

    assert.deepEqual(summaries, ['Frontend worker handoff failed during registering build-log evidence (Error code=E_UPLOAD)']);
    assert.doesNotMatch(summaries[0], /private storage detail/);
  } finally {
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test('failure-recording errors are surfaced together with the original handoff error', async () => {
  const original = new Error('registration failed');
  const recording = new Error('receipt failed');
  await assert.rejects(
    recordWorkerHandoffFailure(async () => { throw recording; }, {}, { run_id: 'run-1' }, 'Backend', 'registering build-log evidence', original),
    error => error instanceof AggregateError
      && error.errors[0] === original
      && error.errors[1] === recording
      && /failure state could not be recorded/.test(error.message)
  );
});

test('frontend artifact download rejects checksum mismatch', async () => {
  const content = Buffer.from('{}');
  const query = { select(){return this;}, eq(){return this;}, single:async()=>({data:{id:'a',job_id:'j',artifact_type:'code_implementation',status:'final',storage_location:'supabase_storage://builder-artifacts/path',checksum:crypto.createHash('sha256').update('different').digest('hex')},error:null}) };
  const supabase = { from:()=>query, storage:{from:()=>({download:async()=>({data:{arrayBuffer:async()=>content},error:null})})} };
  await assert.rejects(downloadVerifiedArtifact(supabase, 'a', 'j', 'code_implementation'), /integrity check failed/);
});

test('frontend verifier compares touched tests with the mounted pre-patch source and needs no Git metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-test-preservation-'));
  // Production mounts a worktree whose .git pointer is unusable inside the container; this fixture has none at all.
  const sourceDir = path.join(root, 'source');
  const workDir = path.join(root, 'work');
  const spec = 'apps/web/e2e/example.spec.ts';
  const baseline = "test('saved patch keeps baseline evidence', () => {});\ntest('result remains gated', () => {});\n";
  const dropPatch = [
    `diff --git a/${spec} b/${spec}`,
    `--- a/${spec}`,
    `+++ b/${spec}`,
    '@@ -1,2 +1,1 @@',
    "-test('saved patch keeps baseline evidence', () => {});",
    "-test('result remains gated', () => {});",
    "+test('new example', () => {});",
    ''
  ].join('\n');
  const renamed = 'apps/web/e2e/renamed.spec.ts';
  const renamePatch = [
    `diff --git a/${spec} b/${renamed}`,
    'similarity index 100%',
    `rename from ${spec}`,
    `rename to ${renamed}`,
    ''
  ].join('\n');
  try {
    fs.mkdirSync(path.join(sourceDir, path.dirname(spec)), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, spec), baseline);
    const patchPath = path.join(root, 'input.patch');
    const prepare = text => {
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.cpSync(sourceDir, workDir, { recursive: true });
      fs.writeFileSync(patchPath, text);
      execFileSync('git', ['apply', patchPath], { cwd: workDir });
    };

    prepare(dropPatch);
    assert.deepEqual(patchTestPreservationFailures({ beforeDir: sourceDir, afterDir: workDir, patchPath }), [
      `${spec} would remove existing regression tests ("saved patch keeps baseline evidence", "result remains gated")`
    ]);
    const preserved = "test('saved patch keeps baseline evidence', () => {});\ntest('result remains gated', () => {});\ntest('new example', () => {});\n";
    fs.writeFileSync(path.join(workDir, spec), preserved);
    assert.deepEqual(patchTestPreservationFailures({ beforeDir: sourceDir, afterDir: workDir, patchPath }), []);

    prepare(renamePatch);
    assert.equal(fs.existsSync(path.join(workDir, spec)), false);
    assert.deepEqual(patchTestPreservationFailures({ beforeDir: sourceDir, afterDir: workDir, patchPath }), [
      `${spec} would remove existing regression tests ("saved patch keeps baseline evidence", "result remains gated")`
    ], 'a rename cannot carry pinned tests out of the protected path unnoticed');

    const parameterizedSpec = 'apps/web/src/vehiclePlateSearch.test.ts';
    const parameterizedBaseline = [
      "test.each([[1, 2]])('sum case %#', () => {});",
      "it.each(plates)('finds saved plate %s', () => {});",
      ''
    ].join('\n');
    fs.mkdirSync(path.join(sourceDir, path.dirname(parameterizedSpec)), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, parameterizedSpec), parameterizedBaseline);
    const dropParameterized = [
      `diff --git a/${parameterizedSpec} b/${parameterizedSpec}`,
      `--- a/${parameterizedSpec}`,
      `+++ b/${parameterizedSpec}`,
      '@@ -1,2 +1 @@',
      "-test.each([[1, 2]])('sum case %#', () => {});",
      "-it.each(plates)('finds saved plate %s', () => {});",
      "+describe('vehicle plate search', () => {});",
      ''
    ].join('\n');
    prepare(dropParameterized);
    assert.deepEqual(patchTestPreservationFailures({ beforeDir: sourceDir, afterDir: workDir, patchPath }), [
      `${parameterizedSpec} would remove existing regression tests ("sum case %#", "finds saved plate %s")`
    ], 'parameterized regression declarations are protected like ordinary tests');

    fs.writeFileSync(patchPath, 'diff --git a/broken b/broken\n@@ not a patch\n');
    assert.throws(() => patchTestPreservationFailures({ beforeDir: sourceDir, afterDir: workDir, patchPath }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('frontend worker records a regression-preservation failure and does not run later checks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-worker-preservation-'));
  const sourceDir = path.join(root, 'source');
  const artifactDir = path.join(root, 'artifacts');
  const workDir = path.join(root, 'work');
  const spec = 'apps/web/e2e/example.spec.ts';
  const baseline = "test('existing workflow remains covered', () => {});\n";
  const patch = [
    `diff --git a/${spec} b/${spec}`,
    `--- a/${spec}`,
    `+++ b/${spec}`,
    '@@ -1 +1 @@',
    "-test('existing workflow remains covered', () => {});",
    "+test('new workflow', () => {});",
    ''
  ].join('\n');
  const calls = [];
  try {
    fs.mkdirSync(path.join(sourceDir, path.dirname(spec)), { recursive: true });
    fs.mkdirSync(artifactDir);
    fs.writeFileSync(path.join(sourceDir, spec), baseline);
    const patchPath = path.join(artifactDir, 'input.patch');
    fs.writeFileSync(patchPath, patch);

    const result = executeFrontendPatch({
      sourceDir, patchPath, artifactDir, workDir,
      runCommand: (command, args, options) => {
        calls.push(command);
        if (command === 'git') return spawnSync(command, args, { ...options, encoding: 'utf8' });
        return { status: 0, stdout: '', stderr: '' };
      }
    });

    assert.equal(result.succeeded, false);
    assert.deepEqual(calls, ['git', 'git']);
    const evidence = JSON.parse(fs.readFileSync(path.join(artifactDir, 'verification.json'), 'utf8'));
    assert.equal(evidence.commands.at(-1).command, 'pinned regression test preservation');
    assert.match(evidence.commands.at(-1).stderr, /existing workflow remains covered/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a worker killed at its lease is an infrastructure failure naming the step that was running, with the partial evidence kept', async () => {
  const repo = fixture();
  const summaries = [];
  try {
    const result = await runFrontendHandoff({
      supabase: {},
      job: { id: 'job-1', organization_id: 'org-1', target_sha: repo.sha },
      step: { id: 'step-1', builder_mode: 'frontend_engineer' },
      patchArtifact: { id: 'patch-1' },
      sourceDir: repo.root,
      workerImage: 'worker:test',
      runnerId: 'runner-1',
      timeoutSeconds: 1800,
      loadPatch: async () => ({ bytes: Buffer.from(JSON.stringify({ summary: 'Change', patch, changed_files: ['apps/web/src/example.ts'], tests: [] })) }),
      claim: async () => ({ run_id: 'run-1', lease_token: 'lease', organization_id: 'org-1', job_id: 'job-1' }),
      resetRetry: async () => {},
      execute: async options => {
        // What the worker writes before each step; it was in e2e when the lease expired.
        fs.writeFileSync(path.join(options.artifactDir, 'verification.json'), JSON.stringify({ succeeded: false, in_progress: true, running: 'npm run test:e2e --prefix apps/web -- e2e/admin-hub-dispatch.spec.ts', commands: [{ command: 'npm run lint', status: 0 }, { command: 'npm run build', status: 0 }, { command: 'npm run test', status: 0 }] }));
        return { status: 'timeout', exitCode: null };
      },
      registerOutput: async (_supabase, _lease, file, type) => ({ id: `${type}:${path.basename(file)}` }),
      finish: async (_supabase, _lease, succeeded, _exitCode, summary) => { summaries.push([succeeded, summary]); return { status: 'implementation_pending' }; }
    });
    assert.equal(result.success, false);
    assert.equal(result.infrastructure_failure, true);
    assert.equal(result.infrastructure_reason, 'verifier timed out after 1800 s during npm run test:e2e --prefix apps/web -- e2e/admin-hub-dispatch.spec.ts');
    assert.equal(result.failure_artifact.id, 'build_logs:verification.json', 'the partial evidence is registered, not lost');
    assert.deepEqual(summaries, [[false, 'Frontend verifier infrastructure failure (verifier timed out after 1800 s during npm run test:e2e --prefix apps/web -- e2e/admin-hub-dispatch.spec.ts); the same patch is re-verified']]);
  } finally {
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});
