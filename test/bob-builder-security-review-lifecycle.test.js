const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(
  path.resolve(__dirname, '../supabase/migrations/20260830130000_builder_security_review_lifecycle.sql'),
  'utf8'
);

test('security review lease is tenant-scoped and consumes completed frontend evidence', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.builder_claim_security_review/);
  assert.match(migration, /_frontend_run\.status <> 'completed'/);
  assert.match(migration, /artifact_type = 'code_implementation'/);
  assert.match(migration, /artifact_type = 'changed_file_manifest'/);
  assert.match(migration, /artifact_type = 'build_logs'/);
  assert.match(migration, /builder_worker_runs_one_active_global/);
  assert.match(migration, /encode\(extensions\.digest\(_lease_token, 'sha256'\), 'hex'\)/);
  assert.match(migration, /'security-review'/);
});

test('security review completion blocks high risk and permits only clean reports', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.builder_register_security_review/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.builder_finish_security_review/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.builder_abort_security_review/);
  assert.match(migration, /_critical_count > 0 OR _high_count > 0/);
  assert.match(migration, /_next_job_status := CASE WHEN _passed THEN 'security_review' ELSE 'failed' END/);
  assert.match(migration, /Security review worker lease expired/);
  assert.match(migration, /ON CONFLICT \(idempotency_key\)/);
  assert.match(migration, /artifact_type = 'security_review'/);
  assert.match(migration, /status = 'testing'/);
  assert.match(migration, /retryable = true/);
  assert.match(migration, /GRANT EXECUTE[\s\S]*TO service_role/);
});