const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isProtectedPath } = require('./builder-path-policy');

const MAX_PATCH_BYTES = 2 * 1024 * 1024;
const MAX_CHANGED_FILES = 100;
const MAX_LOG_BYTES = 512 * 1024;
const VERIFICATION_ENV = Object.freeze({
  VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
  VITE_SUPABASE_ANON_KEY: 'playwright-anon-key',
  PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright'
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
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    maxBuffer: MAX_LOG_BYTES,
    env: { PATH: process.env.PATH, HOME: '/tmp', CI: 'true', NODE_ENV: 'test', ...VERIFICATION_ENV }
  });
  return {
    command: [command, ...args].join(' '),
    status: result.status,
    stdout: redactLog(String(result.stdout || '').slice(-MAX_LOG_BYTES)),
    stderr: redactLog(String(result.stderr || '').slice(-MAX_LOG_BYTES)),
    error: result.error ? redactLog(result.error.message) : null
  };
}

function frontendVerificationCommands() {
  return [
    ['run', 'lint', '--prefix', 'apps/web'],
    ['run', 'build', '--prefix', 'apps/web'],
    ['run', 'test', '--prefix', 'apps/web', '--', '--pool=threads', '--maxWorkers=1', '--reporter=dot'],
    ['run', 'test:e2e', '--prefix', 'apps/web', '--', '--workers=1', '--reporter=line']
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

  if (patchApplied) {
    for (const args of frontendVerificationCommands()) {
      commands.push(run('npm', args, { cwd: workDir }));
      if (commands.at(-1).status !== 0) break;
    }
  }

  const succeeded = commands.every(command => command.status === 0);
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
  fs.writeFileSync(path.join(artifactDir, 'verification.json'), `${JSON.stringify({ succeeded, commands }, null, 2)}\n`, { mode: 0o600 });
  return { succeeded, changed_files: manifest, commands };
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
  MAX_PATCH_BYTES,
  PROTECTED_FRONTEND_PATHS,
  VERIFICATION_ENV,
  redactLog,
  changedFilesFromPatch,
  validatePatchText,
  frontendVerificationCommands,
  executeFrontendPatch
};