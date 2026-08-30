const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  changedFilesFromPatch,
  classifyBackendChangeRisk
} = require('./supabase/functions/_shared/builder-backend-engineer');

const MAX_LOG_BYTES = 512 * 1024;

function redactLog(value) {
  return String(value || '')
    .replace(/authorization\s*[:=]\s*Bearer\s+[^\s,;]+/gi, 'authorization=[REDACTED]')
    .replace(/(authorization|token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]');
}

function sha256File(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_LOG_BYTES,
    env: { PATH: process.env.PATH, HOME: '/tmp', CI: 'true', NODE_ENV: 'test' }
  });
  return {
    command: [command, ...args].join(' '),
    status: result.status,
    stdout: redactLog(String(result.stdout || '').slice(-MAX_LOG_BYTES)),
    stderr: redactLog(String(result.stderr || '').slice(-MAX_LOG_BYTES)),
    error: result.error ? redactLog(result.error.message) : null
  };
}

function executeBackendPatch({ sourceDir, patchPath, artifactDir, workDir = '/work/repository' }) {
  const patchText = fs.readFileSync(patchPath, 'utf8');
  const changedFiles = changedFilesFromPatch(patchText);
  const risk = classifyBackendChangeRisk(patchText, changedFiles);

  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.cpSync(sourceDir, workDir, {
    recursive: true,
    filter: source => {
      const name = path.basename(source);
      return !['.git', 'node_modules', 'dist', '.bob', '.temp'].includes(name)
        && !/^\.env(?:\.|$)/.test(name);
    }
  });

  const before = Object.fromEntries(changedFiles.map(file => [file, sha256File(path.join(workDir, file))]));
  const checks = [];
  checks.push(run('git', ['apply', '--check', '--whitespace=error-all', patchPath], workDir));
  let patchApplied = false;
  if (checks.at(-1).status === 0) {
    checks.push(run('git', ['apply', '--whitespace=error-all', patchPath], workDir));
    patchApplied = checks.at(-1).status === 0;
  }
  if (patchApplied) {
    for (const file of changedFiles.filter(file => file.endsWith('.js'))) {
      checks.push(run('node', ['--check', file], workDir));
      if (checks.at(-1).status !== 0) break;
    }
  }

  const succeeded = patchApplied && checks.every(check => check.status === 0);
  const manifest = changedFiles.map(file => ({
    path: file,
    before_sha256: before[file],
    after_sha256: sha256File(path.join(workDir, file))
  }));
  const verification = {
    succeeded,
    verification_scope: 'static_backend_patch',
    risk,
    checks,
    migration_execution: {
      performed: false,
      reason: 'No disposable PostgreSQL or Supabase runtime is included in this worker profile.'
    }
  };

  fs.mkdirSync(artifactDir, { recursive: true });
  for (const entry of fs.readdirSync(artifactDir)) {
    if (entry !== path.basename(patchPath)) fs.rmSync(path.join(artifactDir, entry), { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(artifactDir, 'changed-files.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(artifactDir, 'backend-verification.json'), `${JSON.stringify(verification, null, 2)}\n`, { mode: 0o600 });
  if (patchApplied) fs.writeFileSync(path.join(artifactDir, 'validated.patch'), patchText, { mode: 0o600 });
  return { ...verification, changed_files: manifest };
}

function main() {
  const [sourceDir, patchPath, artifactDir] = process.argv.slice(2);
  if (!sourceDir || !patchPath || !artifactDir) throw new Error('sourceDir, patchPath, and artifactDir are required');
  const result = executeBackendPatch({ sourceDir, patchPath, artifactDir });
  process.stdout.write(`${JSON.stringify({ succeeded: result.succeeded, changed_file_count: result.changed_files.length })}\n`);
  if (!result.succeeded) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${redactLog(error.message)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { redactLog, executeBackendPatch };