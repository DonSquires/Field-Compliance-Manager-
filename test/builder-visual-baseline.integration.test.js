'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createBranchWorkspace, createDetachedWorkspace, commitVerifiedPatch } = require('../builder-branch-workspace');
const { generateVisualBaselines } = require('../builder-visual-baseline-tool');
const { executeWorker } = require('../worker-executor');
const { sha256 } = require('../builder-visual-baseline');

test('real offline generation, independent verification and binary commit preserve exact PNGs', {
  skip: process.env.BOB_TEST_VISUAL_BASELINE !== '1',
  timeout: 15 * 60_000
}, async t => {
  const sourceDir = path.resolve(__dirname, '..');
  const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  const sha = git(sourceDir, ['rev-parse', 'HEAD']).trim();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bob-visual-real-'));
  fs.chmodSync(root, 0o755);
  const author = createBranchWorkspace({ sourceDir, workspaceRoot: root, jobId: 'baselineacceptance', targetSha: sha });
  const base = createDetachedWorkspace({ sourceDir, workspaceRoot: path.join(root, 'base'), targetSha: sha });
  t.after(() => {
    for (const workspacePath of [author.workspacePath, base.workspacePath]) git(sourceDir, ['worktree', 'remove', '--force', workspacePath]);
    git(sourceDir, ['branch', '-D', author.branchName]);
    if (process.env.BOB_VISUAL_KEEP_FAILURE === '1' && !completed) t.diagnostic(`Retained acceptance evidence: ${root}`);
    else fs.rmSync(root, { recursive: true, force: true });
  });
  let completed = false;
  const spec = path.join(author.workspacePath, 'apps/web/e2e/geofence-spine-map.spec.ts');
  const text = fs.readFileSync(spec, 'utf8');
  const marker = "  await expect(page).toHaveScreenshot('geofence-house-runtime.png'";
  assert.ok(text.includes(marker));
  fs.writeFileSync(spec, text.replace(marker, "  await page.addStyleTag({ content: '.house-map-canvas{outline:4px solid rgb(255,0,255)}' });\n" + marker));
  const pngPath = 'apps/web/e2e/geofence-spine-map.spec.ts-snapshots/geofence-house-runtime-desktop-chromium-linux.png';
  const beforeHash = sha256(fs.readFileSync(path.join(author.workspacePath, pngPath)));
  const image = process.env.BOB_VISUAL_TEST_IMAGE || 'bob-visual-baseline-test';
  const generated = await generateVisualBaselines({
    workspacePath: author.workspacePath, paths: [pngPath], image,
    reason: 'Acceptance fixture only: intentionally outline the map in magenta before capture. All functional assertions remain intact; no production UI change.'
  });
  assert.notEqual(generated.receipt.after[0].sha256, beforeHash);
  assert.equal(generated.receipt.before[0].sha256, beforeHash);
  assert.ok(generated.receipt.commands.every(command => command.status === 0));
  assert.ok(generated.receipt.independent_commands.every(command => command.status === 0));
  const patch = git(author.workspacePath, ['diff', 'HEAD', '--binary']);
  const artifactDir = path.join(root, 'verification');
  fs.mkdirSync(artifactDir, { mode: 0o777 });
  fs.chmodSync(artifactDir, 0o777);
  fs.writeFileSync(path.join(artifactDir, 'input.patch'), patch, { mode: 0o644 });
  const result = await executeWorker({ image, sourceDir: base.workspacePath, artifactDir, profile: 'frontend-verify',
    memory: '6g', cpus: '4', pidsLimit: 1024, timeoutMs: 10 * 60_000 });
  assert.equal(result.status, 'succeeded', `${result.stderr}\n${result.stdout}`);
  const verification = JSON.parse(fs.readFileSync(path.join(artifactDir, 'verification.json'), 'utf8'));
  assert.equal(verification.succeeded, true);
  assert.equal(verification.visual_baselines.after[0].sha256, generated.receipt.after[0].sha256);
  const validated = fs.readFileSync(path.join(artifactDir, 'validated.patch'), 'utf8');
  assert.equal(validated, patch);
  const branch = git(base.workspacePath, ['rev-parse', '--short', 'HEAD']).trim();
  const commitBranch = `bob/job-visual${branch}`;
  git(base.workspacePath, ['switch', '-c', commitBranch]);
  t.after(() => git(sourceDir, ['branch', '-D', commitBranch]));
  const commit = commitVerifiedPatch({ workspacePath: base.workspacePath, branchName: commitBranch,
    patch: validated, message: 'Acceptance-only generated visual baseline' });
  assert.equal(sha256(fs.readFileSync(path.join(base.workspacePath, pngPath))), generated.receipt.after[0].sha256);
  assert.ok(commit.changedFiles.includes(pngPath));
  completed = true;
  t.diagnostic(`Fixture generation/comparison and independent lint/build/unit/browser verification passed; PNG ${generated.receipt.after[0].sha256}`);
});
