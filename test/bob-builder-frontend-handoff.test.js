const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const { runFrontendHandoff, downloadVerifiedArtifact } = require('../builder-frontend-handoff');

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

test('frontend artifact download rejects checksum mismatch', async () => {
  const content = Buffer.from('{}');
  const query = { select(){return this;}, eq(){return this;}, single:async()=>({data:{id:'a',job_id:'j',artifact_type:'code_implementation',status:'final',storage_location:'supabase_storage://builder-artifacts/path',checksum:crypto.createHash('sha256').update('different').digest('hex')},error:null}) };
  const supabase = { from:()=>query, storage:{from:()=>({download:async()=>({data:{arrayBuffer:async()=>content},error:null})})} };
  await assert.rejects(downloadVerifiedArtifact(supabase, 'a', 'j', 'code_implementation'), /integrity check failed/);
});