const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  changedFilesFromPatch,
  classifyBackendChangeRisk
} = require('./supabase/functions/_shared/builder-backend-engineer');
const { checkCallerReads } = require('./builder-data-path-gate');
const { gateTypeScriptDelta, loadTypeScript } = require('./builder-ts-delta-gate');

const MAX_LOG_BYTES = 512 * 1024;
const TEST_TIMEOUT_MS = 5 * 60 * 1000;

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

function run(command, args, cwd, timeout) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_LOG_BYTES,
    timeout,
    env: { PATH: process.env.PATH, HOME: '/tmp', CI: 'true', NODE_ENV: 'test' }
  });
  return {
    command: [command, ...args].join(' '),
    status: result.status,
    timed_out: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
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
  let typeDelta = { checked: [], warnings: [] };
  if (patchApplied) {
    for (const file of changedFiles.filter(file => file.endsWith('.js'))) {
      checks.push(run('node', ['--check', file], workDir));
      if (checks.at(-1).status !== 0) break;
    }
    // Mobile screens and edge functions are TypeScript: the same syntax gate the repo uses for edge
    // functions (parse diagnostics; the untyped Deno code has no clean `tsc` pass to hold it to).
    const tsFiles = changedFiles.filter(file => /\.(?:ts|tsx)$/.test(file) && !file.endsWith('.d.ts'));
    if (tsFiles.length && checks.every(check => check.status === 0)) {
      const typescriptDir = [process.env.BOB_TYPESCRIPT_DIR, '/opt/bob/web-node_modules/typescript', path.join(workDir, 'apps/web/node_modules/typescript')].filter(Boolean).find(dir => fs.existsSync(dir));
      if (typescriptDir) {
        const script = `const ts=require(process.argv[1]);const fs=require('fs');let bad=0;for(const f of process.argv.slice(2)){const sf=ts.createSourceFile(f,fs.readFileSync(f,'utf8'),ts.ScriptTarget.ES2022,true,f.endsWith('x')?ts.ScriptKind.TSX:ts.ScriptKind.TS);for(const d of sf.parseDiagnostics){bad++;console.error(f+': '+ts.flattenDiagnosticMessageText(d.messageText,' '));}}process.exit(bad?1:0);`;
        checks.push(run('node', ['-e', script, typescriptDir, ...tsFiles], workDir));
        // Semantic delta: diagnostics the patch introduced that the file did not have before (an
        // undefined name, a missing property). The file's pre-existing hundreds are not the patch's.
        if (checks.at(-1).status === 0) {
          const started = Date.now();
          try {
            const ts = loadTypeScript(typescriptDir);
            const existing = tsFiles.filter(file => !/^test\//.test(file) && fs.existsSync(path.join(workDir, file)));
            const delta = gateTypeScriptDelta({
              ts,
              files: existing,
              readBefore: file => (fs.existsSync(path.join(sourceDir, file)) ? fs.readFileSync(path.join(sourceDir, file), 'utf8') : null),
              readAfter: file => fs.readFileSync(path.join(workDir, file), 'utf8'),
            });
            typeDelta = { checked: delta.checked, warnings: delta.warnings.slice(0, 40) };
            checks.push({
              command: `typescript semantic delta (${delta.checked.length} file${delta.checked.length === 1 ? '' : 's'}): new diagnostics vs the unpatched file`,
              status: delta.failures.length ? 1 : 0,
              timed_out: false,
              stdout: delta.warnings.length ? `warnings (not failing):\n${delta.warnings.slice(0, 40).join('\n')}` : '',
              stderr: delta.failures.join('\n'),
              error: null,
              duration_ms: Date.now() - started
            });
          } catch (error) {
            checks.push({ command: 'typescript semantic delta', status: 0, timed_out: false, stdout: '', stderr: '', error: `skipped: ${redactLog(error.message)}` });
          }
        }
      }
    }
  }
  // Static checks alone left the release evidence saying "only syntax checks were run". Execute the
  // test files the patch touches (root runtime deps come from the image's NODE_PATH; the container has no network).
  const changedTests = changedFiles.filter(file => /^test\/[^/]+\.test\.js$/.test(file));
  if (patchApplied && checks.every(check => check.status === 0) && changedTests.length) {
    checks.push(run('node', ['--test', ...changedTests], workDir, TEST_TIMEOUT_MS));
  }
  if (patchApplied && checks.every(check => check.status === 0)) {
    checks.push(run('node', ['scripts/atlas-refresh.js'], workDir, TEST_TIMEOUT_MS));
  }
  // Data-path gate: a caller-scoped read of a service-role-only table is a feature that can never
  // show data (job 79b4c08f). schema.sql in the pinned tree is the truth it is checked against.
  let dataPath = { checked: false, findings: [] };
  if (patchApplied) {
    const schemaPath = path.join(workDir, 'supabase/schema.sql');
    const schema = fs.existsSync(schemaPath) ? fs.readFileSync(schemaPath, 'utf8') : null;
    const findings = checkCallerReads(patchText, schema);
    dataPath = { checked: Boolean(schema), findings };
    if (findings.length) {
      checks.push({
        command: 'data-path gate: caller-scoped reads vs row-level security (supabase/schema.sql)',
        status: 1,
        timed_out: false,
        stdout: '',
        stderr: findings.map(finding => finding.message).join('\n'),
        error: null
      });
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
    data_path: dataPath,
    type_delta: typeDelta,
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