const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('workflow lease migration defines durable exclusive leases and heartbeat renewal', () => {
  const migrationPath = path.resolve(__dirname, '../supabase/migrations/20260828000000_workflow_run_leases.sql');
  const migration = fs.readFileSync(migrationPath, 'utf8');

  assert.match(migration, /lease_token/);
  assert.match(migration, /lease_expires_at/);
  assert.match(migration, /wf_runs_one_active_lease_per_job/);
  assert.match(migration, /FOR UPDATE/);
  assert.match(migration, /wf_heartbeat_run/);
  assert.match(migration, /Run lease is missing, expired, or does not belong to job/);
  assert.match(migration, /wf_return_artifact/);
  assert.match(migration, /lease_token IS NOT NULL/);
  assert.match(migration, /auth\.role\(\) <> 'service_role'/);
  assert.match(migration, /wf_service_pickup_run/);
  assert.match(migration, /wf_service_return_artifact/);
  assert.match(migration, /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.wf_jobs, public\.wf_runs, public\.wf_artifacts FROM anon, authenticated/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.wf_pickup_run/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.wf_heartbeat_run\(uuid, text\) FROM anon/);
});

test('service artifact function verifies storage integrity before RPC submission', () => {
  const functionPath = path.resolve(__dirname, '../supabase/functions/wf-service-return-artifact/index.ts');
  const source = fs.readFileSync(functionPath, 'utf8');

  assert.match(source, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(source, /storage\.storage\.from/);
  assert.match(source, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(source, /artifact integrity check failed/);
});

test('DOCX extraction reads OOXML from the ZIP container', () => {
  const functionPath = path.resolve(__dirname, '../supabase/functions/bob-extract-document/index.ts');
  const source = fs.readFileSync(functionPath, 'utf8');

  assert.match(source, /jszip@3\.10\.1/);
  assert.match(source, /JSZip\.loadAsync\(bytes\)/);
  assert.match(source, /word\/document\.xml/);
    assert.match(source, /xml\.matchAll\(\/<w:t/);
});