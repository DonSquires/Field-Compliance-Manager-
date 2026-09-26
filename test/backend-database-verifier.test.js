const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  DATABASE_IMAGE,
  collectMigrationPlan,
  prepareCanonicalSchema,
  executeBackendDatabaseVerification
} = require('../backend-database-verifier');

function fixture(candidateTimestamp = '20260830190000') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'database-verifier-'));
  const sourceDir = path.join(root, 'source');
  const artifactDir = path.join(root, 'artifacts');
  fs.mkdirSync(path.join(sourceDir, 'supabase/migrations'), { recursive: true });
  fs.mkdirSync(artifactDir);
  fs.writeFileSync(path.join(sourceDir, 'supabase/schema.sql'), 'CREATE TABLE public.base (id integer);\n');
  fs.writeFileSync(path.join(sourceDir, 'supabase/migrations/20260830181000_builder_existing.sql'), 'SELECT 1;\n');
  const candidate = `supabase/migrations/${candidateTimestamp}_candidate.sql`;
  const patch = [
    `diff --git a/${candidate} b/${candidate}`,
    'new file mode 100644', '--- /dev/null', `+++ b/${candidate}`, '@@ -0,0 +1 @@',
    '+CREATE TABLE public.candidate (id integer);', ''
  ].join('\n');
  const patchPath = path.join(artifactDir, 'input.patch');
  fs.writeFileSync(patchPath, patch);
  return { root, sourceDir, artifactDir, patchPath, candidate };
}

function fakeRuntime({ failStage = null } = {}) {
  const calls = [];
  return {
    calls,
    start(name, image) { calls.push(['start', name, image]); return { ok: true }; },
    ready() { return true; },
    applySql(_name, sql) {
      const stage = sql.includes('candidate') ? 'candidate' : sql.includes('base') ? 'schema' : 'other';
      calls.push(['sql', stage]);
      return failStage === stage ? { ok: false, output: 'synthetic SQL error' } : { ok: true, output: '' };
    },
    remove(name) { calls.push(['remove', name]); }
  };
}

test('migration plan requires candidates newer than the baseline', () => {
  const setup = fixture('20260830170000');
  try {
    const patch = fs.readFileSync(setup.patchPath, 'utf8');
    assert.throws(() => collectMigrationPlan(setup.sourceDir, patch), /newer than the repository baseline/);
  } finally {
    fs.rmSync(setup.root, { recursive: true, force: true });
  }
});

test('canonical schema preparation hoists row types before dependent functions', () => {
  const schema = [
    'CREATE SCHEMA IF NOT EXISTS "public";',
    'CREATE OR REPLACE FUNCTION "public"."claim_shift_coverage"() RETURNS "public"."shift_coverage_requests" LANGUAGE sql AS $$ SELECT NULL; $$;',
    'CREATE OR REPLACE FUNCTION "public"."read_shift"() RETURNS void LANGUAGE plpgsql AS $$ DECLARE value public.shifts%rowtype; BEGIN END; $$;',
    'CREATE TABLE IF NOT EXISTS "public"."shift_coverage_requests" (',
    '    "id" "uuid" NOT NULL',
    ');',
    '',
    '',
    'ALTER TABLE "public"."shift_coverage_requests" OWNER TO "postgres";',
    'CREATE TABLE IF NOT EXISTS "public"."shifts" (',
    '    "id" "uuid" NOT NULL',
    ');',
    '',
    '',
    'ALTER TABLE "public"."shifts" OWNER TO "postgres";'
  ].join('\n');
  const prepared = prepareCanonicalSchema(schema);
  assert.deepEqual(prepared.normalizedTables, ['shift_coverage_requests', 'shifts']);
  assert.ok(prepared.sql.lastIndexOf('CREATE TABLE', prepared.sql.indexOf('CREATE OR REPLACE FUNCTION')) >= 0);
});

test('canonical schema preparation defers inline foreign keys until primary keys exist', () => {
  const schema = [
    'CREATE TABLE IF NOT EXISTS "public"."child" (',
    '  "id" "uuid" NOT NULL PRIMARY KEY,',
    '  "organization_id" "uuid" NOT NULL REFERENCES "public"."organizations"("id") ON DELETE RESTRICT',
    ');',
    'CREATE TABLE IF NOT EXISTS "public"."organizations" (',
    '  "id" "uuid" NOT NULL',
    ');',
    'ALTER TABLE "public"."organizations" OWNER TO "postgres";',
    'ALTER TABLE ONLY "public"."organizations" ADD CONSTRAINT "organizations_pkey" PRIMARY KEY ("id");'
  ].join('\n');
  const prepared = prepareCanonicalSchema(schema);
  assert.equal(prepared.deferredForeignKeyCount, 1);
  assert.doesNotMatch(prepared.sql.split(');')[0], /REFERENCES/);
  assert.match(prepared.sql, /ALTER TABLE ONLY "public"\."child" ADD CONSTRAINT "verify_[a-f0-9]+_fkey" FOREIGN KEY/);
});

test('canonical schema preparation normalizes quoted SQL trim syntax', () => {
  const prepared = prepareCanonicalSchema('CHECK (char_length("trim"("summary")) > 0);');
  assert.equal(prepared.normalizedQuotedTrimCount, 1);
  assert.match(prepared.sql, /pg_catalog\.btrim\("summary"\)/);
});

test('database verifier loads baseline and candidate SQL with guaranteed cleanup', () => {
  const setup = fixture();
  const runtime = fakeRuntime();
  try {
    const result = executeBackendDatabaseVerification({
      sourceDir: setup.sourceDir, patchPath: setup.patchPath, artifactDir: setup.artifactDir,
      image: DATABASE_IMAGE, runtime
    });
    assert.equal(result.succeeded, true);
    assert.equal(result.performed, true);
    assert.deepEqual(result.candidate_migrations, [setup.candidate]);
    assert.equal(runtime.calls.at(-1)[0], 'remove');
    assert.equal(fs.existsSync(path.join(setup.artifactDir, 'migration-verification.json')), true);
  } finally {
    fs.rmSync(setup.root, { recursive: true, force: true });
  }
});

test('database verifier records SQL failures and still removes the container', () => {
  const setup = fixture();
  const runtime = fakeRuntime({ failStage: 'candidate' });
  try {
    const result = executeBackendDatabaseVerification({
      sourceDir: setup.sourceDir, patchPath: setup.patchPath, artifactDir: setup.artifactDir,
      runtime
    });
    assert.equal(result.succeeded, false);
    assert.match(result.error, /candidate:/);
    assert.equal(runtime.calls.at(-1)[0], 'remove');
  } finally {
    fs.rmSync(setup.root, { recursive: true, force: true });
  }
});

test('database verifier skips execution for patches without migrations', () => {
  const setup = fixture();
  const runtime = fakeRuntime();
  try {
    const helper = 'supabase/functions/_shared/example.js';
    fs.mkdirSync(path.join(setup.sourceDir, path.dirname(helper)), { recursive: true });
    fs.writeFileSync(path.join(setup.sourceDir, helper), 'module.exports = 1;\n');
    fs.writeFileSync(setup.patchPath, [
      `diff --git a/${helper} b/${helper}`, `--- a/${helper}`, `+++ b/${helper}`,
      '@@ -1 +1 @@', '-module.exports = 1;', '+module.exports = 2;', ''
    ].join('\n'));
    const result = executeBackendDatabaseVerification({
      sourceDir: setup.sourceDir, patchPath: setup.patchPath, artifactDir: setup.artifactDir,
      runtime
    });
    assert.equal(result.succeeded, true);
    assert.equal(result.performed, false);
    assert.equal(runtime.calls.length, 0);
  } finally {
    fs.rmSync(setup.root, { recursive: true, force: true });
  }
});
// Job 1021dbaa (2026-09-26): the name heuristic replayed 41 Builder migrations that the live
// snapshot already contained, and the replay died on `policy ... already exists`.
test('the baseline is the set of repository migrations the snapshot ledger does not contain', () => {
  const { appliedMigrationsFromSchema } = require('../backend-database-verifier');
  const setup = fixture('20260901000000');
  try {
    fs.writeFileSync(path.join(setup.sourceDir, 'supabase/migrations/20260830182000_builder_applied_too.sql'), 'SELECT 1;\n');
    fs.writeFileSync(path.join(setup.sourceDir, 'supabase/migrations/20260830183000_other_unapplied.sql'), 'SELECT 1;\n');
    // No ledger header: the old heuristic replays every builder_* file.
    let plan = collectMigrationPlan(setup.sourceDir, fs.readFileSync(setup.patchPath, 'utf8'));
    assert.equal(plan.baseline_source, 'name_heuristic');
    assert.deepEqual(plan.baseline.map((f) => path.basename(f)), ['20260830181000_builder_existing.sql', '20260830182000_builder_applied_too.sql']);
    // With the ledger: only migrations the snapshot lacks are replayed, whatever their names.
    fs.writeFileSync(path.join(setup.sourceDir, 'supabase/schema.sql'), [
      '-- Generated by scripts/schema-snapshot-live.mjs from the LIVE database catalog',
      '-- applied_migrations: 20260830181000,20260830182000',
      'CREATE TABLE public.base (id integer);', ''
    ].join('\n'));
    plan = collectMigrationPlan(setup.sourceDir, fs.readFileSync(setup.patchPath, 'utf8'));
    assert.equal(plan.baseline_source, 'snapshot_ledger');
    assert.deepEqual(plan.baseline.map((f) => path.basename(f)), ['20260830183000_other_unapplied.sql']);
    assert.equal(plan.canonicalMigrationCount, 2);
    assert.deepEqual([...appliedMigrationsFromSchema('-- applied_migrations: 20260101000000, 20260102000000\nSELECT 1;')].sort(), ['20260101000000', '20260102000000']);
    assert.equal(appliedMigrationsFromSchema('-- applied_migrations: unavailable (timeout)'), null);
    assert.equal(appliedMigrationsFromSchema('no header'), null);
  } finally {
    fs.rmSync(setup.root, { recursive: true, force: true });
  }
});
