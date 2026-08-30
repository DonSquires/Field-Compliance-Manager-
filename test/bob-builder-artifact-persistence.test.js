const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migrationPath = path.resolve(
  __dirname,
  '../supabase/migrations/20260829100000_builder_model_artifact_persistence.sql'
);

test('builder model artifacts use private storage and atomic service-only finalization', () => {
  const migration = fs.readFileSync(migrationPath, 'utf8');

  assert.match(migration, /INSERT INTO storage\.buckets/);
  assert.match(migration, /'builder-artifacts'/);
  assert.match(migration, /public\s*,\s*file_size_limit[\s\S]*false/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.builder_finalize_model_artifact/);
  assert.match(migration, /IF auth\.role\(\) <> 'service_role'/);
  assert.match(migration, /INSERT INTO public\.builder_artifacts/);
  assert.match(migration, /INSERT INTO public\.builder_audit_events/);
  assert.match(migration, /UPDATE public\.builder_model_runs/);
  assert.match(migration, /GRANT EXECUTE[\s\S]*TO service_role/);
  assert.match(migration, /REVOKE EXECUTE[\s\S]*FROM PUBLIC/);
});