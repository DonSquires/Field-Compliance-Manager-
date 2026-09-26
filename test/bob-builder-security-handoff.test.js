const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { validateSecurityReport, runSecurityReview } = require('../builder-security-handoff');
const { executeSecurityReview } = require('../security-worker');

test('security report validation binds the report to exact patch and manifest bytes', () => {
  const patch = Buffer.from('patch');
  const manifest = Buffer.from('[]');
  const report = {
    passed: true,
    counts: { critical: 0, high: 0, medium: 0, low: 0 },
    patch_sha256: crypto.createHash('sha256').update(patch).digest('hex'),
    manifest_sha256: crypto.createHash('sha256').update(manifest).digest('hex')
  };
  assert.equal(validateSecurityReport(report, patch, manifest), report);
  assert.throws(() => validateSecurityReport({ ...report, patch_sha256: 'a'.repeat(64) }, patch, manifest), /digests do not match/);
});

test('security handoff treats policy findings as a completed review, not infrastructure failure', async () => {
  const calls = [];
  const patch = Buffer.from('patch');
  const manifest = Buffer.from('[]');
  const result = await runSecurityReview({
    supabase: {},
    job: { id: 'job-1', organization_id: 'org-1', target_sha: 'sha-1' },
    securityStep: { id: 'step-security', step_id: 'security_review' },
    frontendWorkerRunId: 'frontend-run', sourceDir: '/repo', workerImage: 'worker:test', runnerId: 'runner-1',
    claim: async () => ({ run_id: 'run-security', lease_token: 'lease', organization_id: 'org-1', job_id: 'job-1', patch_artifact_id: 'patch-id', manifest_artifact_id: 'manifest-id' }),
    loadArtifact: async (_s, id) => ({ bytes: id === 'patch-id' ? patch : manifest }),
    execute: async options => {
      calls.push('execute');
      fs.writeFileSync(path.join(options.artifactDir, 'security-review.json'), JSON.stringify({
        passed: false, counts: { critical: 0, high: 1, medium: 0, low: 0 },
        patch_sha256: crypto.createHash('sha256').update(patch).digest('hex'),
        manifest_sha256: crypto.createHash('sha256').update(manifest).digest('hex')
      }));
      return { status: 'failed', exitCode: 1 };
    },
    register: async () => { calls.push('register'); return { id: 'security-artifact' }; },
    finish: async (_s, _l, _id, counts) => { calls.push(`finish:${counts.high}`); return { status: 'failed' }; },
    abort: async () => { calls.push('abort'); }
  });
  assert.equal(result.success, false);
  assert.deepEqual(calls, ['execute', 'register', 'finish:1']);
});

test('security handoff unwraps an agentic proposal envelope so the worker receives the diff (job 3a4a2d06)', async () => {
  const diff = 'diff --git a/lib/a.js b/lib/a.js\n--- a/lib/a.js\n+++ b/lib/a.js\n@@ -1 +1 @@\n-a\n+b\n';
  const envelope = Buffer.from(JSON.stringify({ summary: 'change a to b', patch: diff.trimEnd(), changed_files: ['lib/a.js'], lane: 'backend' }));
  const manifest = Buffer.from('[{"path":"lib/a.js"}]');
  let written;
  const result = await runSecurityReview({
    supabase: {},
    job: { id: 'job-1', organization_id: 'org-1', target_sha: 'sha-1' },
    securityStep: { id: 'step-security', step_id: 'security_review' },
    frontendWorkerRunId: 'backend-run', sourceDir: '/repo', workerImage: 'worker:test', runnerId: 'runner-1',
    claim: async () => ({ run_id: 'run-security', lease_token: 'lease', organization_id: 'org-1', job_id: 'job-1', patch_artifact_id: 'proposal-id', manifest_artifact_id: 'manifest-id' }),
    loadArtifact: async (_s, id) => ({ bytes: id === 'proposal-id' ? envelope : manifest }),
    execute: async options => {
      written = fs.readFileSync(path.join(options.artifactDir, 'validated.patch'), 'utf8');
      fs.writeFileSync(path.join(options.artifactDir, 'security-review.json'), JSON.stringify({
        passed: true, counts: { critical: 0, high: 0, medium: 0, low: 0 },
        patch_sha256: crypto.createHash('sha256').update(Buffer.from(diff)).digest('hex'),
        manifest_sha256: crypto.createHash('sha256').update(manifest).digest('hex')
      }));
      return { status: 'succeeded', exitCode: 0 };
    },
    register: async () => ({ id: 'security-artifact' }),
    finish: async () => ({ status: 'security_review' }),
    abort: async () => { throw new Error('must not abort'); }
  });
  assert.equal(written, diff, 'the worker sees the unified diff with its terminating newline, not the JSON envelope');
  assert.equal(result.success, true);
});

test('security handoff aggregates frontend and backend worker evidence into one digest-bound review', async () => {
  const frontendPatch = Buffer.from([
    'diff --git a/apps/web/src/example.ts b/apps/web/src/example.ts',
    '--- a/apps/web/src/example.ts', '+++ b/apps/web/src/example.ts', '@@ -1 +1 @@',
    '-export const value = 1;', '+export const value = 2;', ''
  ].join('\n'));
  const backendPatch = Buffer.from([
    'diff --git a/supabase/migrations/20260830190000_example.sql b/supabase/migrations/20260830190000_example.sql',
    'new file mode 100644', '--- /dev/null', '+++ b/supabase/migrations/20260830190000_example.sql',
    '@@ -0,0 +1 @@', '+CREATE TABLE public.example (id uuid PRIMARY KEY);', ''
  ].join('\n'));
  const bodies = {
    'frontend-patch': frontendPatch,
    'backend-patch': backendPatch,
    'frontend-manifest': Buffer.from(JSON.stringify([{ path: 'apps/web/src/example.ts' }])),
    'backend-manifest': Buffer.from(JSON.stringify([{ path: 'supabase/migrations/20260830190000_example.sql' }]))
  };
  const result = await runSecurityReview({
    supabase: {},
    job: { id: 'job-1', organization_id: 'org-1', target_sha: 'sha-1' },
    securityStep: { id: 'security-step', step_id: 'security_review' },
    implementationWorkerRunIds: ['frontend-run', 'backend-run'],
    sourceDir: '/repo', workerImage: 'worker:test', runnerId: 'runner-1',
    claim: async () => ({
      run_id: 'security-run', lease_token: 'lease', organization_id: 'org-1', job_id: 'job-1',
      patch_artifact_ids: ['frontend-patch', 'backend-patch'],
      manifest_artifact_ids: ['frontend-manifest', 'backend-manifest']
    }),
    loadArtifact: async (_client, id) => ({ bytes: bodies[id] }),
    execute: async options => {
      const report = executeSecurityReview({
        patchPath: path.join(options.artifactDir, 'validated.patch'),
        manifestPath: path.join(options.artifactDir, 'changed-files.json'),
        outputPath: path.join(options.artifactDir, 'security-review.json')
      });
      return { status: report.passed ? 'succeeded' : 'failed', exitCode: report.passed ? 0 : 1 };
    },
    register: async () => ({ id: 'security-artifact' }),
    finish: async () => ({ status: 'security_review' })
  });
  assert.equal(result.success, true);
  assert.equal(result.report.review_scope, 'frontend_and_backend');
  assert.deepEqual(result.report.reviewed_files, [
    'apps/web/src/example.ts', 'supabase/migrations/20260830190000_example.sql'
  ]);
});