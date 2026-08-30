const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(
  path.resolve(__dirname, '../supabase/migrations/20260830180000_builder_backend_worker_leases.sql'),
  'utf8'
);
const skipMigration = fs.readFileSync(
  path.resolve(__dirname, '../supabase/migrations/20260830181000_builder_implementation_skip.sql'),
  'utf8'
);
const databaseEvidenceMigration = fs.readFileSync(
  path.resolve(__dirname, '../supabase/migrations/20260830182000_builder_backend_database_evidence.sql'),
  'utf8'
);

test('backend worker lease is tenant-scoped, commit-pinned, and provenance-bound', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.builder_claim_backend_worker/);
  assert.match(migration, /_expected_target_sha IS DISTINCT FROM _job\.target_sha/);
  assert.match(migration, /builder_mode = 'product_analyst'/);
  assert.match(migration, /product_artifact\.id = ANY\(model_run\.input_artifact_ids\)/);
  assert.match(migration, /'backend-verify'/);
  assert.match(migration, /Another Builder worker already holds the active lease/);
});

test('backend worker completion requires evidence and records static-only scope', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.builder_finish_backend_worker/);
  assert.match(migration, /artifact_type = 'code_implementation'/);
  assert.match(migration, /artifact_type = 'changed_file_manifest'/);
  assert.match(migration, /artifact_type = 'build_logs'/);
  assert.match(migration, /'verification_scope', 'static_backend_patch'/);
  assert.match(migration, /'migration_execution', false/);
  assert.match(migration, /database execution was not performed/);
});

test('implementation phase reaches testing only after the sibling step is satisfied', () => {
  assert.match(migration, /builder_mode = 'frontend_engineer' AND status IN \('completed', 'skipped'\)/);
  assert.match(migration, /builder_mode = 'backend_engineer' AND status IN \('completed', 'skipped'\)/);
  assert.match(migration, /ELSE 'implementation_pending'/);
});

test('backend worker RPCs are service-only and use hashed leases', () => {
  assert.match(migration, /encode\(extensions\.digest\(_lease_token, 'sha256'\), 'hex'\)/);
  assert.match(migration, /REVOKE EXECUTE ON FUNCTION public\.builder_claim_backend_worker[\s\S]*FROM PUBLIC,anon,authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.builder_finish_backend_worker[\s\S]*TO service_role/);
});

test('either implementation branch can be explicitly skipped without bypassing its sibling', () => {
  assert.match(skipMigration, /CREATE OR REPLACE FUNCTION public\.builder_skip_implementation_step/);
  assert.match(skipMigration, /_builder_mode NOT IN \('frontend_engineer', 'backend_engineer'\)/);
  assert.match(skipMigration, /A skip reason is required/);
  assert.match(skipMigration, /builder_mode = _sibling_mode AND status IN \('completed', 'skipped'\)/);
  assert.match(skipMigration, /GRANT EXECUTE ON FUNCTION public\.builder_skip_implementation_step[\s\S]*TO service_role/);
});

test('backend completion records disposable evidence without claiming production execution', () => {
  assert.match(databaseEvidenceMigration, /disposable migration evidence registered when required/i);
  assert.match(databaseEvidenceMigration, /'production_execution', false/);
  assert.match(databaseEvidenceMigration, /production execution was not performed/i);
  assert.match(databaseEvidenceMigration, /GRANT EXECUTE ON FUNCTION public\.builder_finish_backend_worker[\s\S]*TO service_role/);
});