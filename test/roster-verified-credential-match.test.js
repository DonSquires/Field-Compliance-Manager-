const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20261104200648_roster_verified_credential_match.sql'), 'utf8');
const rosterPage = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/pages/RosterOperationsPage.tsx'), 'utf8');

test('only an active verified match for the same staff and credential suppresses an unverified duplicate', () => {
  const helper = migration.slice(
    migration.indexOf('CREATE OR REPLACE FUNCTION public.staff_credential_has_verified_match'),
    migration.indexOf('REVOKE ALL ON FUNCTION public.staff_credential_has_verified_match')
  );

  assert.match(helper, /source\.id = p_credential_id/);
  assert.match(helper, /source\.verified IS FALSE/);
  assert.match(helper, /verified\.staff_id = source\.staff_id/);
  assert.match(helper, /verified\.verified IS TRUE/);
  assert.match(helper, /source\.credential_number/);
  assert.match(helper, /verified\.expiry_date IS NOT DISTINCT FROM source\.expiry_date/);
  assert.match(helper, /source\.issued_date IS NULL OR verified\.issued_date = source\.issued_date/);
  assert.match(helper, /source\.credential_type = verified\.credential_type/);
  assert.match(helper, /'certificate_of_authority', 'security_licence'/);
  assert.match(helper, /replacement\.replaces_credential_id = verified\.id/);
  assert.doesNotMatch(helper, /SECURITY DEFINER/i);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.staff_credential_has_verified_match\(uuid\) FROM PUBLIC, anon, authenticated, service_role/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.staff_credential_has_verified_match\(uuid\) TO postgres/);
});

test('both roster eligibility surfaces use the same verified-match rule', () => {
  assert.equal((migration.match(/NOT public\.staff_credential_has_verified_match\(credential\.id\)/g) ?? []).length, 2);
  assert.match(migration, /AND NOT public\.staff_credential_has_verified_match\(c\.id\)/);
  assert.equal((migration.match(/replacement\.replaces_credential_id=credential\.id/g) ?? []).length, 2);
  assert.doesNotMatch(migration, /AND c\.replaces_credential_id IS NULL/);
});

test('assignment feedback distinguishes unverified credentials from actual expiry and includes the year', () => {
  assert.match(rosterPage, /if \(!warning\.verified\)/);
  assert.match(rosterPage, /else if \(warning\.expiry_date\)/);
  assert.match(rosterPage, /year: 'numeric'/);
});
