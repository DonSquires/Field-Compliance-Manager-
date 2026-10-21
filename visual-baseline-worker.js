'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { VERIFICATION_ENV, validatePatchText, redactLog } = require('./frontend-worker');
const { baselinePaths, renderBaselines, sha256 } = require('./builder-visual-baseline');

function executeBaselineGeneration({ sourceDir, artifactDir, workDir = '/work/repository' }) {
  const request = JSON.parse(fs.readFileSync(path.join(artifactDir, 'request.json'), 'utf8'));
  const files = baselinePaths(request.paths);
  const inputPatch = fs.readFileSync(path.join(artifactDir, 'input.patch'), 'utf8');
  if (inputPatch.trim()) validatePatchText(inputPatch, { lane: 'verified' });
  fs.mkdirSync(workDir, { recursive: true });
  fs.cpSync(sourceDir, workDir, {
    recursive: true,
    filter: source => !['.git', 'node_modules', 'dist', '.bob', 'test-results', 'playwright-report'].includes(path.basename(source))
  });
  const run = (command, args, options = {}) => {
    const result = spawnSync(command, args, {
      cwd: options.cwd || workDir, encoding: 'utf8', timeout: 5 * 60_000, maxBuffer: command === 'git' ? 4 * 1024 * 1024 : 512 * 1024,
      env: { PATH: process.env.PATH, HOME: '/tmp', CI: 'true', NODE_ENV: 'test', ...VERIFICATION_ENV,
        PLAYWRIGHT_OUTPUT_DIR: path.join(artifactDir, 'test-results'), PLAYWRIGHT_HTML_OUTPUT_DIR: path.join(artifactDir, 'playwright-report') }
    });
    const receipt = { command: [command, ...args].join(' '), status: result.status, error: result.error?.message || null,
      stdout: redactLog(result.stdout), stderr: redactLog(result.stderr) };
    fs.appendFileSync(path.join(artifactDir, 'commands.jsonl'), `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
    return receipt;
  };
  const git = args => {
    const result = run('git', args);
    if (result.status !== 0 || result.error) throw new Error(`Baseline git operation failed: ${result.error || result.stderr}`);
    return result.stdout;
  };
  git(['init', '-q']);
  git(['config', 'user.name', 'Bob baseline worker']);
  git(['config', 'user.email', 'baseline@invalid']);
  git(['add', '-A']);
  git(['commit', '-qm', 'Pinned input']);
  fs.cpSync('/opt/bob/web-node_modules', path.join(workDir, 'apps/web/node_modules'), { recursive: true, verbatimSymlinks: true });
  const evidence = renderBaselines({ workDir, files, run, artifactDir });
  const independent = renderBaselines({ workDir, files, run, verifyOnly: true, artifactDir: path.join(artifactDir, 'independent') });
  git(['add', '--', ...files]);
  const changed = git(['diff', '--name-only', 'HEAD']).trim().split('\n').filter(Boolean);
  const untracked = git(['ls-files', '--others', '--exclude-standard']).trim().split('\n').filter(Boolean);
  if ([...changed, ...untracked].some(file => !files.includes(file))) throw new Error('Baseline generation changed unrequested files');
  const patch = git(['diff', 'HEAD', '--binary', '--', ...files]);
  if (patch.trim()) validatePatchText(patch);
  fs.writeFileSync(path.join(artifactDir, 'baseline.patch'), patch, { mode: 0o600 });
  const receipt = { ...evidence, independent_commands: independent.commands, independently_rendered: independent.rendered,
    succeeded: true, input_sha: request.source_sha,
    input_patch_sha256: sha256(Buffer.from(inputPatch)), patch_sha256: sha256(Buffer.from(patch)), reason: request.reason };
  fs.writeFileSync(path.join(artifactDir, 'baseline.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  return receipt;
}

if (require.main === module) {
  try {
    const [sourceDir, artifactDir] = process.argv.slice(2);
    executeBaselineGeneration({ sourceDir, artifactDir });
  } catch (error) {
    process.stderr.write(`${redactLog(error.message)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { executeBaselineGeneration };
