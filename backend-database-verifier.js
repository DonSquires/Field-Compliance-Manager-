const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { changedFilesFromPatch } = require('./supabase/functions/_shared/builder-backend-engineer');

const DATABASE_IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.164';
const MAX_OUTPUT_BYTES = 128 * 1024;
const BOOTSTRAP_SQL = [
  'CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;',
  'CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public;',
  'CREATE TABLE IF NOT EXISTS storage.buckets (',
  'id text PRIMARY KEY, name text NOT NULL, public boolean DEFAULT false,',
  'file_size_limit bigint, allowed_mime_types text[]);'
].join(' ');

function migrationTimestamp(file) {
  return Number(path.basename(file).match(/^(\d{14})_[a-z0-9_]+\.sql$/)?.[1] || 0);
}

function collectMigrationPlan(sourceDir, patchText) {
  const candidates = changedFilesFromPatch(patchText).filter(file => file.startsWith('supabase/migrations/'));
  const baseline = fs.readdirSync(path.join(sourceDir, 'supabase/migrations'))
    .filter(file => /^\d{14}_[a-z0-9_]+\.sql$/.test(file))
    .map(file => `supabase/migrations/${file}`)
    .sort();
  const latestBaseline = Math.max(0, ...baseline.map(migrationTimestamp));
  for (const candidate of candidates) {
    if (!migrationTimestamp(candidate) || migrationTimestamp(candidate) <= latestBaseline) {
      throw new Error(`candidate migration must be newer than the repository baseline: ${candidate}`);
    }
  }
  return { baseline, candidates: [...new Set(candidates)].sort(), latest_baseline_timestamp: latestBaseline };
}

function commandResult(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: options.input ? undefined : 'utf8',
    input: options.input,
    maxBuffer: MAX_OUTPUT_BYTES,
    cwd: options.cwd
  });
  return {
    ok: result.status === 0,
    status: result.status,
    output: `${result.stdout || ''}${result.stderr || ''}`.slice(-4000)
  };
}

const dockerRuntime = {
  start(name, image) {
    return commandResult('docker', [
      'run', '-d', '--name', name, '--network=none', '--memory=2g', '--cpus=2', '--pids-limit=256',
      '--security-opt=no-new-privileges:true', '-e', 'POSTGRES_PASSWORD=disposable-only', image
    ]);
  },
  ready(name) {
    return commandResult('docker', ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'supabase_admin', '-d', 'postgres']).ok;
  },
  applySql(name, sql) {
    return commandResult('docker', [
      'exec', '-i', name, 'psql', '-h', '127.0.0.1', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'
    ], { input: Buffer.from(sql) });
  },
  remove(name) {
    commandResult('docker', ['rm', '-f', name]);
  }
};

function waitForDatabase(runtime, name, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    if (runtime.ready(name)) return true;
    Atomics.wait(signal, 0, 0, 100);
  }
  return false;
}

function writeEvidence(artifactDir, evidence) {
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, 'migration-verification.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
}

function executeBackendDatabaseVerification({
  sourceDir,
  patchPath,
  artifactDir,
  image = DATABASE_IMAGE,
  runtime = dockerRuntime
}) {
  if (image !== DATABASE_IMAGE) throw new Error('unapproved disposable database image');
  const patchText = fs.readFileSync(patchPath, 'utf8');
  const plan = collectMigrationPlan(sourceDir, patchText);
  if (plan.candidates.length === 0) {
    const evidence = {
      succeeded: true,
      performed: false,
      reason: 'Patch contains no database migrations.',
      image,
      baseline_migration_count: plan.baseline.length,
      candidate_migrations: []
    };
    writeEvidence(artifactDir, evidence);
    return evidence;
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bob-database-verify-'));
  const containerName = `bob-db-verify-${crypto.randomUUID()}`;
  const stages = [];
  let evidence;
  try {
    fs.cpSync(sourceDir, workDir, {
      recursive: true,
      filter: source => !['.git', 'node_modules', 'dist', '.bob', '.temp'].includes(path.basename(source))
        && !/^\.env(?:\.|$)/.test(path.basename(source))
    });
    const apply = commandResult('git', ['apply', '--whitespace=error-all', patchPath], { cwd: workDir });
    if (!apply.ok) throw new Error('candidate migration patch could not be applied');

    const start = runtime.start(containerName, image);
    if (!start.ok || !waitForDatabase(runtime, containerName)) throw new Error('disposable database failed to start');

    const runStage = (name, sql) => {
      const result = runtime.applySql(containerName, sql);
      stages.push({ name, succeeded: result.ok, error: result.ok ? null : result.output.slice(-1000) });
      if (!result.ok) throw new Error(`${name} failed`);
    };
    runStage('platform_bootstrap', BOOTSTRAP_SQL);
    runStage('canonical_schema', fs.readFileSync(path.join(sourceDir, 'supabase/schema.sql'), 'utf8'));
    for (const migration of plan.baseline) {
      runStage(`baseline:${path.basename(migration)}`, fs.readFileSync(path.join(sourceDir, migration), 'utf8'));
    }
    for (const migration of plan.candidates) {
      runStage(`candidate:${path.basename(migration)}`, fs.readFileSync(path.join(workDir, migration), 'utf8'));
    }
    evidence = {
      succeeded: true,
      performed: true,
      image,
      baseline_schema_sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(sourceDir, 'supabase/schema.sql'))).digest('hex'),
      baseline_migration_count: plan.baseline.length,
      candidate_migrations: plan.candidates,
      stages
    };
  } catch (error) {
    evidence = {
      succeeded: false,
      performed: true,
      image,
      baseline_migration_count: plan.baseline.length,
      candidate_migrations: plan.candidates,
      stages,
      error: error.message
    };
  } finally {
    runtime.remove(containerName);
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  writeEvidence(artifactDir, evidence);
  return evidence;
}

function main() {
  const [sourceDir, patchPath, artifactDir] = process.argv.slice(2);
  if (!sourceDir || !patchPath || !artifactDir) throw new Error('sourceDir, patchPath, and artifactDir are required');
  const result = executeBackendDatabaseVerification({ sourceDir, patchPath, artifactDir });
  process.stdout.write(`${JSON.stringify({ succeeded: result.succeeded, performed: result.performed, candidate_count: result.candidate_migrations.length })}\n`);
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
  DATABASE_IMAGE,
  BOOTSTRAP_SQL,
  collectMigrationPlan,
  executeBackendDatabaseVerification,
  waitForDatabase
};