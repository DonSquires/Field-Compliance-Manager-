const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const migrationPath = path.join(
  process.cwd(),
  'supabase',
  'migrations',
  '20261010092045_organization_compliance_register.sql'
);
const migration = fs.readFileSync(migrationPath, 'utf8');

test('organization compliance records are tenant-scoped and RLS protected', () => {
  assert.match(migration, /organization_id uuid NOT NULL REFERENCES public\.organizations\(id\) ON DELETE CASCADE/);
  assert.match(migration, /ALTER TABLE public\.organization_compliance_records ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /public\.org_access_allowed\(organization_id\)/);
  assert.match(migration, /actor\.role IN \('grand_master', 'master'\)/);
  assert.match(migration, /GRANT SELECT ON TABLE public\.organization_compliance_records TO authenticated/);
  assert.doesNotMatch(migration, /GRANT (INSERT|UPDATE|DELETE|ALL) ON TABLE public\.organization_compliance_records TO authenticated/);
});

test('organization compliance writes are governed, replay-safe, and audited', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.save_organization_compliance_record/);
  assert.match(migration, /CREATE UNIQUE INDEX organization_compliance_records_request_idx/);
  assert.match(migration, /client_request_id = p_client_request_id/);
  assert.match(migration, /Compliance record changed since it was opened/);
  assert.match(migration, /organization_compliance_record_created/);
  assert.match(migration, /organization_compliance_record_reviewed/);
});

test('corporate identity changes reset verification and require a source', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.update_organization_corporate_profile/);
  assert.match(migration, /corporate_profile_verification_status = 'unverified'/);
  assert.match(migration, /Corporate profile source is required/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.review_organization_corporate_profile/);
});
