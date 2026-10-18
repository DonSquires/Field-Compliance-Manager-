const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isProtectedPath } = require('./builder-path-policy');
const { INFRASTRUCTURE_PATTERNS } = require('./builder-verification-outcome');

const MAX_PATCH_BYTES = 2 * 1024 * 1024;
const MAX_CHANGED_FILES = 100;
const MAX_LOG_BYTES = 512 * 1024;
const VERIFICATION_ENV = Object.freeze({
  VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
  VITE_SUPABASE_ANON_KEY: 'playwright-anon-key',
  PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
  // `tsc --noEmit` on apps/web needs >1 GB of heap; V8's default inside the container was ~1 GB (job ecfb4dc4 OOMed in lint).
  NODE_OPTIONS: '--max-old-space-size=2048',
  // The container has no network: e2e fixtures answer external requests with an empty 204 (job ecfb4dc4: ERR_INTERNET_DISCONNECTED).
  E2E_OFFLINE: '1'
});
const BLOCKED_FILES = new Set([
  'apps/web/package.json',
  'apps/web/package-lock.json',
  'apps/web/pnpm-lock.yaml',
  'apps/web/yarn.lock'
]);
const PROTECTED_FRONTEND_PATHS = [
  /^apps\/web\/src\/context\/AuthContext\.tsx$/,
  /^apps\/web\/src\/lib\/supabase\.ts$/,
  /^apps\/web\/src\/routing\//,
  /^apps\/web\/src\/components\/SafetyGate\.tsx$/,
  /^apps\/web\/src\/components\/access\//
];

function redactLog(value) {
  return String(value || '')
    .replace(/authorization\s*[:=]\s*Bearer\s+[^\s,;]+/gi, 'authorization=[REDACTED]')
    .replace(/(authorization|token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]');
}

function changedFilesFromPatch(patchText) {
  const files = new Set();
  for (const match of patchText.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    files.add(match[2].trim());
  }
  return [...files].sort();
}

function validatePatchText(patchText, { lane = 'frontend' } = {}) {
  if (typeof patchText !== 'string' || !patchText.trim()) throw new Error('patch is empty');
  if (Buffer.byteLength(patchText) > MAX_PATCH_BYTES) throw new Error('patch exceeds size limit');
  if (/GIT binary patch|Binary files .* differ/m.test(patchText)) throw new Error('binary patches are not allowed');
  if (/^(?:new|old) mode (?:120000|160000)$/m.test(patchText)) throw new Error('symlink and submodule patches are not allowed');
  const files = changedFilesFromPatch(patchText);
  if (files.length === 0) throw new Error('patch has no changed files');
  if (files.length > MAX_CHANGED_FILES) throw new Error('patch changes too many files');
  for (const file of files) {
    const normalized = path.posix.normalize(file);
    if (normalized !== file || file.startsWith('/') || file.includes('\0') || normalized.startsWith('../')) {
      throw new Error(`unsafe path in patch: ${file}`);
    }
    // The frontend lane is fenced to apps/web; a verified patch from any lane only has to respect the protected paths.
    if (lane === 'frontend' && !file.startsWith('apps/web/')) throw new Error(`frontend patch cannot modify ${file}`);
    if (BLOCKED_FILES.has(file)) throw new Error(`dependency manifest changes require separate approval: ${file}`);
    if (/(?:^|\/)\.env(?:\.|$)/.test(file)) throw new Error(`environment files are not allowed: ${file}`);
    if (PROTECTED_FRONTEND_PATHS.some(pattern => pattern.test(file)) || isProtectedPath(file)) {
      throw new Error(`protected ${lane === 'frontend' ? 'frontend ' : ''}changes require separate approval: ${file}`);
    }
  }
  return files;
}

function sha256File(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function run(command, args, options) {
  const browserReport = args.includes('test:e2e') ? path.join(options.cwd, '.bob-playwright-result.json') : null;
  if (browserReport) fs.rmSync(browserReport, { force: true });
  const windowsNpm = process.platform === 'win32' && command === 'npm';
  const executable = windowsNpm ? (process.env.ComSpec || 'cmd.exe') : command;
  const executableArgs = windowsNpm
    ? ['/d', '/s', '/c', `npm ${args.join(' ')}`]
    : args;
  const result = spawnSync(executable, executableArgs, {
    cwd: options.cwd,
    encoding: 'utf8',
    maxBuffer: MAX_LOG_BYTES,
    env: { PATH: process.env.PATH, HOME: '/tmp', CI: 'true', NODE_ENV: 'test', ...VERIFICATION_ENV,
      ...(browserReport ? { PLAYWRIGHT_JSON_OUTPUT_NAME: browserReport } : {}) }
  });
  let testFailures = null;
  if (browserReport && fs.existsSync(browserReport)) {
    try { testFailures = browserFailureSignatures(JSON.parse(fs.readFileSync(browserReport, 'utf8'))); }
    catch (error) { testFailures = { complete: false, failures: [], error: `Browser report unreadable: ${redactLog(error.message)}` }; }
    fs.rmSync(browserReport);
  }
  return {
    command: [command, ...args].join(' '),
    status: result.status,
    stdout: redactLog(String(result.stdout || '').slice(-MAX_LOG_BYTES)),
    stderr: redactLog(String(result.stderr || '').slice(-MAX_LOG_BYTES)),
    error: result.error ? redactLog(result.error.message) : null,
    ...(browserReport ? { test_failures: testFailures } : {})
  };
}

function browserFailureSignatures(report) {
  const failures = [];
  let count = 0;
  let complete = Array.isArray(report?.suites) && Array.isArray(report?.errors) && !report.errors.length;
  const visit = (suite, parents = []) => {
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        count += 1;
        if (test.status !== 'unexpected') continue;
        const result = test.results?.at(-1);
        const errors = result?.errors?.length ? result.errors : result?.error ? [result.error] : [];
        if (!spec.file || !errors.length) { complete = false; continue; }
        const signature = errors.map(error => String(error.message || '')
          .replace(/\u001b\[[0-9;]*m/g, '').replace(/\b\d+(?:\.\d+)?(?:ms|s)\b/g, '<duration>').trim()).join('\n');
        if (!signature) complete = false;
        failures.push({
          test: `${spec.file}::${test.projectName}::${[...parents, spec.title].join(' > ')}`,
          signature: crypto.createHash('sha256').update(signature).digest('hex'),
          infrastructure: INFRASTRUCTURE_PATTERNS.some(pattern => pattern.test(errors.map(error => error.message).join('\n')))
        });
      }
    }
    for (const child of suite.suites || []) visit(child, [...parents, suite.title || '']);
  };
  for (const suite of report?.suites || []) visit(suite);
  return { complete: complete && count > 0, failures };
}

function sameBrowserFailures(patched, baseline) {
  if (!patched?.complete || !baseline?.complete || !patched.failures.length) return false;
  if ([...patched.failures, ...baseline.failures].some(failure => failure.infrastructure)) return false;
  const keys = new Set(baseline.failures.map(failure => `${failure.test}::${failure.signature}`));
  return patched.failures.every(failure => keys.has(`${failure.test}::${failure.signature}`));
}

// The repository's own CI runs this smoke subset (apps/web package.json test:e2e:ci-smoke); the full
// 75-spec suite across two browser projects does not fit any verifier budget (job ecfb4dc4 was
// killed at the 15-minute lease with lint+build+unit done and e2e still running).
const E2E_SMOKE_SPECS = Object.freeze([
  'e2e/admin-hub-dispatch.spec.ts',
  'e2e/dr-bob-automation-geofence-module.spec.ts',
  'e2e/geofence-spine-map.spec.ts',
  'e2e/officer-module-entitlements.spec.ts'
]);
const E2E_TARGETED_MAX = 6;
// Visual baselines embed live LINZ tiles and the baseline machine's fonts; a network-less sandbox
// cannot reproduce them (geofence-spine-map failed on the screenshot alone), so snapshots are not
// compared here. Functional assertions still run; CI (with network) keeps comparing snapshots.
const E2E_SNAPSHOT_NOTE = 'ignored: visual baselines need live LINZ tiles and the baseline machine; compared in CI, not in the offline verifier';

function kebab(name) {
  return String(name).replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();
}

/** Spec files whose name or text refers to a changed web page/component (e.g. BuilderControlRoomPage.tsx -> *builder-control-room*.spec.ts). */
function targetedE2eSpecs(changedFiles, webDir) {
  const e2eDir = path.join(webDir, 'e2e');
  if (!fs.existsSync(e2eDir)) return [];
  const stems = new Set();
  for (const file of changedFiles) {
    const match = String(file).match(/^apps\/web\/src\/.*\/([A-Za-z0-9_]+)\.(?:tsx?|css)$/);
    if (!match) continue;
    const stem = match[1].replace(/(Page|Panel|View|Screen|Component|Modal|Card)$/, '');
    if (stem.length >= 5) stems.add(stem);
  }
  if (!stems.size) return [];
  const specs = fs.readdirSync(e2eDir).filter((entry) => entry.endsWith('.spec.ts')).sort();
  const selected = [];
  for (const spec of specs) {
    const specKebab = kebab(spec);
    let text = null;
    for (const stem of stems) {
      if (specKebab.includes(kebab(stem))) { selected.push(`e2e/${spec}`); break; }
      if (text === null) { try { text = fs.readFileSync(path.join(e2eDir, spec), 'utf8'); } catch { text = ''; } }
      if (text.includes(stem)) { selected.push(`e2e/${spec}`); break; }
    }
    if (selected.length >= E2E_TARGETED_MAX) break;
  }
  return selected;
}

function frontendVerificationCommands({ changedFiles = [], webDir = null } = {}) {
  const targeted = webDir ? targetedE2eSpecs(changedFiles, webDir).filter((spec) => !E2E_SMOKE_SPECS.includes(spec)) : [];
  return [
    ['run', 'lint', '--prefix', 'apps/web'],
    ['run', 'build', '--prefix', 'apps/web'],
    ['run', 'test', '--prefix', 'apps/web', '--', '--pool=threads', '--maxWorkers=1', '--reporter=dot'],
    ['run', 'test:e2e', '--prefix', 'apps/web', '--', ...E2E_SMOKE_SPECS, ...targeted, '--project=desktop-chromium', '--workers=1', '--reporter=line,json', '--ignore-snapshots']
  ];
}

function executeFrontendPatch({ sourceDir, patchPath, artifactDir, workDir = '/work/repository' }) {
  const patchText = fs.readFileSync(patchPath, 'utf8');
  const changedFiles = validatePatchText(patchText);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.cpSync(sourceDir, workDir, {
    recursive: true,
    filter: source => !['.git', 'node_modules', 'dist', '.bob'].includes(path.basename(source))
  });
  const dependencyPath = '/opt/bob/web-node_modules';
  const workspaceDependencies = path.join(workDir, 'apps/web/node_modules');
  if (fs.existsSync(dependencyPath) && !fs.existsSync(workspaceDependencies)) {
    fs.cpSync(dependencyPath, workspaceDependencies, { recursive: true, verbatimSymlinks: true });
  }

  const before = Object.fromEntries(changedFiles.map(file => [file, sha256File(path.join(workDir, file))]));
  const commands = [];
  commands.push(run('git', ['apply', '--check', '--whitespace=error-all', patchPath], { cwd: workDir }));
  let patchApplied = false;
  if (commands.at(-1).status === 0) {
    commands.push(run('git', ['apply', '--whitespace=error-all', patchPath], { cwd: workDir }));
    patchApplied = commands.at(-1).status === 0;
  }

  let baseline = null;
  if (patchApplied) {
    const e2eTargeted = targetedE2eSpecs(changedFiles, path.join(workDir, 'apps/web'));
    const progressPath = path.join(artifactDir, 'verification.json');
    for (const args of frontendVerificationCommands({ changedFiles, webDir: path.join(workDir, 'apps/web') })) {
      // Evidence before each step: a worker killed at its lease still tells the handoff what was running.
      fs.mkdirSync(artifactDir, { recursive: true });
      fs.writeFileSync(progressPath, `${JSON.stringify({ succeeded: false, in_progress: true, running: ['npm', ...args].join(' '), started_at: new Date().toISOString(), commands, e2e_selection: { smoke: E2E_SMOKE_SPECS, targeted: e2eTargeted, project: 'desktop-chromium', offline: true, snapshots: E2E_SNAPSHOT_NOTE } }, null, 2)}\n`, { mode: 0o600 });
      commands.push(run('npm', args, { cwd: workDir }));
      if (commands.at(-1).status !== 0) {
        baseline = baselineCheck({ workDir, patchPath, args, progressPath, commands, patched: commands.at(-1) });
        if (tolerateBaselineFailures(commands.at(-1), baseline, args)) continue;
        break;
      }
    }
    if (commands.every(commandPassed)) {
      commands.push(run('node', ['scripts/atlas-refresh.js'], { cwd: workDir }));
    }
  }

  const succeeded = commands.every(commandPassed);
  const manifest = changedFiles.map(file => ({
    path: file,
    before_sha256: before[file],
    after_sha256: sha256File(path.join(workDir, file))
  }));
  fs.mkdirSync(artifactDir, { recursive: true });
  for (const entry of fs.readdirSync(artifactDir)) {
    if (entry !== path.basename(patchPath)) {
      fs.rmSync(path.join(artifactDir, entry), { recursive: true, force: true });
    }
  }
  fs.writeFileSync(path.join(artifactDir, 'changed-files.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  if (patchApplied) fs.writeFileSync(path.join(artifactDir, 'validated.patch'), patchText, { mode: 0o600 });
  const baselineBlocks = Boolean(baseline?.proven_same_failure && !baseline.tolerated && !baseline.new_failures?.length);
  fs.writeFileSync(path.join(artifactDir, 'verification.json'), `${JSON.stringify({ succeeded, commands, baseline, baseline_failure: baselineBlocks, baseline_reason: baselineBlocks ? baseline.reason : null, preexisting_failures: baseline?.tolerated ? baseline.failing_files : [], e2e_selection: patchApplied ? { smoke: E2E_SMOKE_SPECS, targeted: targetedE2eSpecs(changedFiles, path.join(workDir, 'apps/web')), project: 'desktop-chromium', offline: true, snapshots: E2E_SNAPSHOT_NOTE } : null }, null, 2)}\n`, { mode: 0o600 });
  return { succeeded, changed_files: manifest, commands, baseline_failure: baselineBlocks, preexisting_failures: baseline?.tolerated ? baseline.failing_files : [] };
}

const commandPassed = (command) => command.status === 0 || command.tolerated === true;

function failingTestFiles(text) {
  return (String(text || '').match(/(?:FAIL|\u00d7|\u2716)\s+([\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?)/g) || [])
    .map((m) => m.replace(/^(?:FAIL|\u00d7|\u2716)\s+/, ''))
    .filter((v, i, a) => a.indexOf(v) === i);
}

/**
 * Main is often red for an unrelated guard test (dispatchCreationSchema.guard, 2026-10); parking every
 * frontend job on it was the most common late failure. A unit-test run whose failing files are all
 * failing without the patch too is accepted with the pre-existing failures recorded. Only the unit-test
 * step qualifies: its output names failing files reliably; lint and build failures stay blocking.
 */
function tolerateBaselineFailures(command, baseline, args) {
  if (!baseline?.also_fails || args[1] !== 'test') return false;
  const patched = failingTestFiles(`${command.stdout}\n${command.stderr}`);
  const before = baseline.all_failing_files || [];
  if (!patched.length || !before.length) return false;
  const introduced = patched.filter((file) => !before.includes(file));
  if (introduced.length) {
    // Red main does not excuse a new failure: the author is sent these files as their own to repair.
    baseline.new_failures = introduced;
    return false;
  }
  command.tolerated = true;
  command.preexisting_failures = patched;
  baseline.tolerated = true;
  return true;
}

/**
 * A failing step is re-run once on the unpatched tree. If it fails there too the repository is red
 * at the pinned commit (job 72edc782: three guard tests broken by unrelated commits on main) and
 * the author must not be sent that failure as their own.
 */
function baselineCheck({ workDir, patchPath, args, progressPath, commands, patched }) {
  const label = ['npm', ...args].join(' ');
  fs.writeFileSync(progressPath, `${JSON.stringify({ succeeded: false, in_progress: true, running: `baseline check: ${label}`, started_at: new Date().toISOString(), commands }, null, 2)}\n`, { mode: 0o600 });
  const revert = run('git', ['apply', '-R', '--whitespace=nowarn', patchPath], { cwd: workDir });
  if (revert.status !== 0) return { command: label, checked: false, reason: 'patch could not be reverted for a baseline check' };
  let result;
  try {
    result = run('npm', args, { cwd: workDir });
  } finally {
    const restored = run('git', ['apply', '--whitespace=nowarn', patchPath], { cwd: workDir });
    if (restored.status !== 0) throw new Error('Could not restore candidate patch after baseline verification');
  }
  const alsoFails = result.status !== 0;
  const allFailing = alsoFails ? failingTestFiles(`${result.stdout}\n${result.stderr}`) : [];
  const failing = allFailing.slice(0, 8);
  const provenSameFailure = alsoFails && (args[1] === 'test:e2e'
    ? sameBrowserFailures(patched.test_failures, result.test_failures)
    : args[1] === 'test'
      ? failingTestFiles(`${patched.stdout}\n${patched.stderr}`).length > 0
        && failingTestFiles(`${patched.stdout}\n${patched.stderr}`).every(file => allFailing.includes(file))
      : Boolean(`${patched.stdout || ''}${patched.stderr || ''}`.trim())
        && patched.status === result.status
        && `${patched.stdout || ''}\n${patched.stderr || ''}`.trim() === `${result.stdout || ''}\n${result.stderr || ''}`.trim()
        && !INFRASTRUCTURE_PATTERNS.some(pattern => pattern.test(`${result.stdout || ''}\n${result.stderr || ''}`)));
  return {
    command: label,
    checked: true,
    also_fails: alsoFails,
    status: result.status,
    failing_files: failing,
    all_failing_files: allFailing,
    proven_same_failure: provenSameFailure,
    test_failures: result.test_failures ?? null,
    reason: provenSameFailure ? `${label} has matching failures on the pinned commit without this patch${failing.length ? `: ${failing.join(', ')}` : ''}` : alsoFails ? 'Baseline also failed, but matching failure evidence is absent; patch attribution remains unresolved' : null,
    stdout: redactLog(String(result.stdout || '').slice(-8000)),
    stderr: redactLog(String(result.stderr || '').slice(-8000))
  };
}

function main() {
  const [sourceDir, patchPath, artifactDir] = process.argv.slice(2);
  if (!sourceDir || !patchPath || !artifactDir) throw new Error('sourceDir, patchPath, and artifactDir are required');
  const result = executeFrontendPatch({ sourceDir, patchPath, artifactDir });
  process.stdout.write(`${JSON.stringify({ succeeded: result.succeeded, changed_file_count: result.changed_files.length })}\n`);
  if (!result.succeeded) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  E2E_SMOKE_SPECS,
  MAX_PATCH_BYTES,
  PROTECTED_FRONTEND_PATHS,
  VERIFICATION_ENV,
  redactLog,
  changedFilesFromPatch,
  validatePatchText,
  frontendVerificationCommands,
  targetedE2eSpecs,
  executeFrontendPatch,
  failingTestFiles,
  tolerateBaselineFailures,
  browserFailureSignatures,
  sameBrowserFailures
};