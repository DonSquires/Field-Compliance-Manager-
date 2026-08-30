const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(
  path.resolve(__dirname, '../supabase/migrations/20260830090000_builder_frontend_worker_leases.sql'),
  'utf8'
);

test('frontend worker leases are tenant-scoped, commit-pinned, and globally exclusive', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS organization_id uuid/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS lease_token_hash text/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz/);
  assert.match(migration, /CREATE UNIQUE INDEX builder_worker_runs_one_active_global/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.builder_claim_frontend_worker/);
  assert.match(migration, /_expected_target_sha IS DISTINCT FROM _job\.target_sha/);
  assert.match(migration, /encode\(extensions\.digest\(_lease_token, 'sha256'\), 'hex'\)/);
  assert.match(migration, /'frontend-verify'/);
  assert.match(migration, /'text\/x-diff'/);
});

test('frontend worker lease supports heartbeats and evidence-backed completion', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.builder_heartbeat_frontend_worker/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.builder_register_worker_artifact/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.builder_finish_frontend_worker/);
  assert.match(migration, /'changed_file_manifest'/);
  assert.match(migration, /artifact_type = 'code_implementation'/);
  assert.match(migration, /artifact_type = 'build_logs'/);
  assert.match(migration, /artifact_type = 'changed_file_manifest'/);
  assert.match(migration, /_next_status := CASE WHEN _succeeded THEN 'testing'/);
  assert.match(migration, /GRANT EXECUTE[\s\S]*TO service_role/);
});

test('frontend worker retries clear stale evidence before execution', () => {
  const fix = fs.readFileSync(
    path.resolve(__dirname, '../supabase/migrations/20260830100000_builder_frontend_worker_retry_fix.sql'),
    'utf8'
  );
  assert.match(fix, /CREATE OR REPLACE FUNCTION public\.builder_reset_frontend_worker_retry/);
  assert.match(fix, /output_artifact_ids = '\{\}'/);
  assert.match(fix, /WHERE id = _run_id AND status = 'running'/);
  assert.match(fix, /GRANT EXECUTE[\s\S]*TO service_role/);
});