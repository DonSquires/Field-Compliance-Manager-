const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260905004700_operational_only_location_access.sql'), 'utf8');

test('only accepted operational agreements grant cross-organization place access', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.has_location_access/);
  const agreementChecks = migration.match(/agreement\.agreement_type = 'operational' and agreement\.invitation_status = 'accepted'/g) ?? [];
  assert.equal(agreementChecks.length, 3);
  assert.doesNotMatch(migration, /agreement_type = 'financial'/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.has_location_access/);
});