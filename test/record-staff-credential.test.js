const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260919040000_record_staff_credential.sql'), 'utf8');
const hrPage = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/pages/RosterHRPage.tsx'), 'utf8');

test('only an administrator of the staff member organisation can record a credential', () => {
  assert.match(migration, /select s\.\* into v_staff from public\.staff_profiles s where s\.id = p_staff_id;/);
  assert.match(migration, /if not public\.is_admin_for_org\(v_staff\.organization_id\) then raise exception 'Active provider administrator required'/);
  assert.match(migration, /revoke all on function public\.record_staff_credential\([^)]*\) from public, anon, authenticated, service_role;/);
  assert.match(migration, /grant execute on function public\.record_staff_credential\([^)]*\) to postgres, authenticated, service_role;/);
});

test('credential types match the proposal path and verification demands evidence', () => {
  assert.match(migration, /p_credential_type not in \('certificate_of_authority', 'warrant_of_authority', 'drivers_licence', 'first_aid', 'security_licence', 'firearms_licence', 'noise_control_warrant', 'biosecurity_warrant', 'other'\)/);
  assert.match(migration, /if p_verified and \(v_number is null or v_authority is null or v_notes is null or length\(v_notes\) < 10\) then raise exception/);
  assert.match(migration, /case when p_verified then v_actor end, case when p_verified then clock_timestamp\(\) end/);
  assert.match(migration, /p_issued_date > p_expiry_date then raise exception 'Credential expiry cannot precede its issue date'/);
});

test('replay-safe on client_request_id and audited as staff_credential_recorded', () => {
  assert.match(migration, /perform pg_advisory_xact_lock\(hashtextextended\(p_client_request_id::text, 0\)\);/);
  assert.match(migration, /where c\.organization_id = v_staff\.organization_id and c\.client_request_id = p_client_request_id;/);
  assert.match(migration, /return query select v_row\.id, v_row\.staff_id, v_row\.verified, v_row\.verified_at, false;/);
  assert.match(migration, /'staff_credential_recorded', 'staff_credentials', v_row\.id/);
});

test('the HR page offers Record credential wherever the readiness gate bites and submits through the RPC', () => {
  assert.match(hrPage, /supabase\.rpc\('record_staff_credential', \{/);
  assert.match(hrPage, /p_verified: evidenceAction\.credentialVerified/);
  assert.equal((hrPage.match(/'record_credential'\)\}>Record credential<\/button>/g) ?? []).length, 2, 'Onboarding card and Staff readiness block');
  assert.match(hrPage, /aria-label="Staff member for new credential"/);
  assert.match(hrPage, /A verified, current credential is what makes an officer work ready\./);
  assert.match(hrPage, /evidenceAction\.credentialVerified && \(!evidenceAction\.credentialNumber\.trim\(\) \|\| !evidenceAction\.issuingAuthority\.trim\(\) \|\| evidenceAction\.note\.trim\(\)\.length < 10\)/);
  assert.doesNotMatch(hrPage, /from\('staff_credentials'\)\.(insert|upsert|update)/);
});
