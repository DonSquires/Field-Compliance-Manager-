'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { executeWorker } = require('./worker-executor');
const { validatePatchText } = require('./frontend-worker');
const { baselinePaths, baselineInfo, safeFile, pngEvidence, sha256 } = require('./builder-visual-baseline');

async function generateVisualBaselines({ workspacePath, paths, reason, image = process.env.BOB_WORKER_IMAGE,
  execute = executeWorker }) {
  const files = baselinePaths(paths);
  if (typeof reason !== 'string' || reason.trim().length < 30 || reason.length > 2000) {
    throw new Error('Explain the intentional before/after UI change and why this is not a regression (30-2000 characters)');
  }
  if (!image) throw new Error('Visual baseline worker image is not configured');
  for (const file of files) {
    safeFile(workspacePath, `apps/web/${baselineInfo(file).spec}`);
    pngEvidence(workspacePath, file, { optional: true });
  }
  const git = args => execFileSync('git', args, { cwd: workspacePath, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  if (untracked.length) git(['add', '-N', '--', ...untracked]);
  const sourceSha = git(['rev-parse', 'HEAD']).trim();
  const inputPatch = git(['diff', 'HEAD', '--binary']);
  if (inputPatch.trim()) validatePatchText(inputPatch, { lane: 'verified' });
  const root = path.join(path.dirname(workspacePath), '.visual-baseline-runs');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const artifactDir = fs.mkdtempSync(path.join(root, 'run-'));
  fs.writeFileSync(path.join(artifactDir, 'input.patch'), inputPatch, { mode: 0o600 });
  fs.writeFileSync(path.join(artifactDir, 'request.json'), JSON.stringify({ paths: files, reason, source_sha: sourceSha }), { mode: 0o600 });
  const result = await execute({ image, sourceDir: workspacePath, artifactDir, profile: 'visual-baseline',
    timeoutMs: 15 * 60_000, memory: '6g', cpus: '2', pidsLimit: 1024 });
  if (result.status !== 'succeeded') throw new Error(`Visual baseline worker failed (evidence: ${artifactDir}): ${result.stderr || result.stdout || result.status}`.slice(0, 3000));
  const patch = fs.readFileSync(path.join(artifactDir, 'baseline.patch'), 'utf8');
  const receipt = JSON.parse(fs.readFileSync(path.join(artifactDir, 'baseline.json'), 'utf8'));
  const changedFiles = patch.trim() ? validatePatchText(patch) : [];
  if (receipt.succeeded !== true || receipt.input_sha !== sourceSha || receipt.input_patch_sha256 !== sha256(Buffer.from(inputPatch))
    || receipt.patch_sha256 !== sha256(Buffer.from(patch)) || changedFiles.some(file => !files.includes(file))) {
    throw new Error('Visual baseline output provenance does not match this request');
  }
  for (const file of files) {
    const output = pngEvidence(path.join(artifactDir, 'after'), file);
    if (!receipt.after?.some(item => item.path === file && item.sha256 === output.sha256)) throw new Error('Baseline image receipt mismatch');
  }
  if (git(['rev-parse', 'HEAD']).trim() !== sourceSha || git(['diff', 'HEAD', '--binary']) !== inputPatch) {
    throw new Error('Workspace changed while rendering baselines; refusing stale output');
  }
  if (patch.trim()) {
    git(['apply', '--check', '--whitespace=error-all', path.join(artifactDir, 'baseline.patch')]);
    git(['apply', '--whitespace=error-all', path.join(artifactDir, 'baseline.patch')]);
  }
  const summary = { ...receipt, commands: receipt.commands.map(({ command, status }) => ({ command, status })),
    independent_commands: receipt.independent_commands.map(({ command, status }) => ({ command, status })) };
  return { changed_files: changedFiles, receipt: summary, evidence_directory: artifactDir,
    note: 'Fixture-only candidate, not a live UI approval. Independent verification and human merge approval are still required.' };
}

module.exports = { generateVisualBaselines };
