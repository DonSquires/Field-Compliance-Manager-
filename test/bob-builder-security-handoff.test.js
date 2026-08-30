const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { validateSecurityReport, runSecurityReview } = require('../builder-security-handoff');

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