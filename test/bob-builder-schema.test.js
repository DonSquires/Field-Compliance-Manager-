const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(
  path.resolve(__dirname, '../supabase/migrations/20260829060000_builder_job_system.sql'),
  'utf8'
);

test('builder schema uses the lifecycle defined by the Build Plan', () => {
  assert.match(migration, /'design_pending'/);
  assert.match(migration, /'implementation_pending'/);
  assert.doesNotMatch(migration, /'design_ready'/);
});

test('builder schema records model runs with provenance and usage metadata', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.builder_model_runs/);
  assert.match(migration, /prompt_version TEXT NOT NULL/);
  assert.match(migration, /input_artifact_ids UUID\[\]/);
  assert.match(migration, /output_artifact_ids UUID\[\]/);
  assert.match(migration, /usage_metadata JSONB/);
});

test('builder service identities retain rows when a user is deleted', () => {
  assert.doesNotMatch(
    migration,
    /created_by UUID NOT NULL REFERENCES auth\.users\(id\) ON DELETE SET NULL/
  );
});