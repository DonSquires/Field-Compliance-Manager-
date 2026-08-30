const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { reviewPatch, executeSecurityReview } = require('../security-worker');

function patch(addedLine, file = 'apps/web/src/example.ts') {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1 +1 @@',
    '-export const value = 1;',
    `+${addedLine}`,
    ''
  ].join('\n');
}

test('security reviewer blocks credential material and dangerous browser execution', () => {
  const report = reviewPatch({
    patchText: patch('const key = "SUPABASE_SERVICE_ROLE_KEY=secret"; eval(input);'),
    manifest: [{ path: 'apps/web/src/example.ts' }]
  });
  assert.equal(report.passed, false);
  assert.ok(report.counts.critical >= 1);
  assert.ok(report.counts.high >= 1);
  assert.doesNotMatch(JSON.stringify(report), /secret/);
});

test('security reviewer blocks protected frontend surfaces independently', () => {
  const report = reviewPatch({
    patchText: patch('export const auth = true;', 'apps/web/src/context/AuthContext.tsx'),
    manifest: [{ path: 'apps/web/src/context/AuthContext.tsx' }]
  });
  assert.equal(report.passed, false);
  assert.ok(report.findings.some(finding => finding.rule_id === 'protected-surface-change'));
});

test('security reviewer passes an ordinary typed UI change', () => {
  const report = reviewPatch({
    patchText: patch('export const value = 2;'),
    manifest: [{ path: 'apps/web/src/example.ts' }]
  });
  assert.equal(report.passed, true);
  assert.deepEqual(report.counts, { critical: 0, high: 0, medium: 0, low: 0 });
});

test('security reviewer rejects a manifest that does not match the patch', () => {
  assert.throws(() => reviewPatch({
    patchText: patch('export const value = 2;'),
    manifest: [{ path: 'apps/web/src/other.ts' }]
  }), /manifest does not match patch/);
});

test('security review execution emits a bounded report with input digests', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'security-worker-'));
  try {
    const patchPath = path.join(root, 'validated.patch');
    const manifestPath = path.join(root, 'changed-files.json');
    const outputPath = path.join(root, 'security-review.json');
    fs.writeFileSync(patchPath, patch('export const value = 2;'));
    fs.writeFileSync(manifestPath, JSON.stringify([{ path: 'apps/web/src/example.ts' }]));
    const report = executeSecurityReview({ patchPath, manifestPath, outputPath });
    assert.equal(report.passed, true);
    assert.match(report.patch_sha256, /^[a-f0-9]{64}$/);
    assert.match(report.manifest_sha256, /^[a-f0-9]{64}$/);
    assert.equal(fs.existsSync(outputPath), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});