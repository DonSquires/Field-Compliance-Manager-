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