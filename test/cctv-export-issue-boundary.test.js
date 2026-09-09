const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase/migrations/20260909170000_cctv_export_issue_audit.sql'), 'utf8');

test('CCTV export issuance requires a sealed export and records an audited private artifact', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS artifact_bucket/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS artifact_path/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.issue_cctv_export/);
  assert.match(migration, /Only sealed exports may be issued/);
  assert.match(migration, /approval_state = 'issued'/);
  assert.match(migration, /artifact_bucket = trim\(p_artifact_bucket\)/);
  assert.match(migration, /cctv_export_issued/);
  assert.match(migration, /manifest_sha256/);
});
