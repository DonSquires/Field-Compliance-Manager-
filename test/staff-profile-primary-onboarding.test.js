const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (file) => fs.readFileSync(path.resolve(__dirname, file), 'utf8').replace(/\r\n/g, '\n');
const employeeMigration = read('../supabase/migrations/20261107100000_staff_profile_employee_numbers.sql');
const documentMigration = read('../supabase/migrations/20261107110000_private_staff_document_uploads.sql');
const documentHardeningMigration = read('../supabase/migrations/20261107130000_staff_document_legacy_path_hardening.sql');
const documentAuthorizationMigration = read('../supabase/migrations/20261107140000_staff_document_admin_only_reads.sql');
const profilePage = read('../apps/web/src/pages/StaffProfilePage.tsx');
const rosterPage = read('../apps/web/src/pages/RosterHRPage.tsx');
const adminShell = read('../apps/web/src/shells/AdminShell.tsx');
const workforceSections = read('../apps/web/src/lib/workforceSections.ts');
const productDesign = read('../docs/canon/PRODUCT_DESIGN.md');
const branchPanel = read('../apps/web/src/components/StaffBranchAccessPanel.tsx');

test('employee numbers are unique, organisation-scoped, and assigned for blank profiles', () => {
  assert.match(employeeMigration, /staff_employee_number_counters/);
  assert.match(employeeMigration, /ON CONFLICT \(organization_id\) DO UPDATE\s+SET last_number = public\.staff_employee_number_counters\.last_number \+ 1/);
  assert.match(employeeMigration, /WHERE nullif\(btrim\(staff\.employee_number\), ''\) IS NULL/);
  assert.match(employeeMigration, /staff_profiles_organization_employee_number_uidx[\s\S]*?ON public\.staff_profiles \(organization_id, employee_number\)/);
  assert.match(employeeMigration, /BEFORE INSERT OR UPDATE OF employee_number, organization_id/);
  assert.match(employeeMigration, /RETURN 'EMP-' \|\| lpad/);
  assert.match(employeeMigration, /existing identifiers are preserved/i);
});

test('new hires land in the staff profile with onboarding as the next action', () => {
  assert.match(rosterPage, /navigate\(\{ pathname: staffProfileHref, search: params\.toString\(\) \}, \{\s*state: \{ notice:/);
  assert.match(rosterPage, /profileTab: 'onboarding'/);
  assert.match(rosterPage, /const openStaffProfile = \(person: StaffRow, profileTab = 'overview'\)/);
  assert.match(rosterPage, /const params = new URLSearchParams\(\{ profile: person\.staff_id, profileTab \}\)/);
  assert.match(workforceSections, /if \(new URLSearchParams\(search\)\.has\('profile'\)\) return 'people-hr'/);
  assert.doesNotMatch(adminShell, /isStaffProfilePopout/);
  assert.match(productDesign, /Staff Profile is the workforce record of action/);
});

test('staff profile owns governed employment, onboarding, location, and people-evidence actions', () => {
  for (const rpc of [
    'manage_user_identity_access',
    'set_staff_employment_setup',
    'start_staff_onboarding',
    'manage_staff_onboarding',
    'record_staff_credential',
    'renew_staff_credential',
    'record_staff_training',
    'assign_roster_skill_to_staff',
    'record_staff_site_induction',
    'manage_staff_onboarding_evidence',
    'record_staff_document_upload',
  ]) {
    assert.ok(profilePage.includes(`supabase.rpc('${rpc}'`), `profile should call ${rpc}`);
  }
  assert.match(profilePage, /supabase\.functions\.invoke\('update-user-email'/);
  assert.match(profilePage, /p_expected_updated_at: userProfile\.updated_at/);
  assert.match(profilePage, /<StaffBranchAccessPanel userId=\{staffProfile\.user_id\}/);
  assert.match(profilePage, /const PROFILE_TABS: Array<\{ id: ProfileTab; label: string \}\> = \[/);
  assert.match(profilePage, /\{ id: 'employment', label: 'Employment & pay' \}/);
  assert.match(rosterPage, /const TAB_GROUPS:[\s\S]*?workforce', label: 'Staff', tabs: \['staff'\]/);
  assert.doesNotMatch(rosterPage, /\{ id: 'onboarding', label: 'Onboarding' \}/);
  assert.doesNotMatch(rosterPage, /\{ id: 'credentials', label: 'Credentials' \}/);
});

test('staff uploads are private, tenant-scoped, bounded, and registered through an audited RPC', () => {
  assert.match(documentMigration, /'staff-documents',\s*'staff-documents',\s*false,\s*10485760/);
  assert.match(documentMigration, /REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(documentMigration, /CREATE POLICY staff_documents_private_select/);
  assert.match(documentMigration, /CREATE POLICY staff_documents_private_insert/);
  assert.match(documentMigration, /public\.is_admin_for_org\(staff\.organization_id\)/);
  assert.match(documentMigration, /Client request ID is required/);
  assert.match(documentMigration, /pg_advisory_xact_lock\(hashtextextended\(p_client_request_id::text, 0\)\)/);
  assert.match(documentMigration, /v_size > 10485760/);
  assert.match(documentMigration, /Unsupported staff document media type/);
  assert.match(documentMigration, /'staff_document_uploaded'/);
  assert.match(documentMigration, /GRANT EXECUTE ON FUNCTION public\.record_staff_document_upload/);
  assert.match(documentHardeningMigration, /\(storage\.foldername\(storage\.objects\.name\)\)\[1\] = document\.organization_id::text/);
  assert.match(documentHardeningMigration, /\(storage\.foldername\(storage\.objects\.name\)\)\[3\] = document\.staff_id::text/);
  assert.match(documentHardeningMigration, /Staff documents must be uploaded through record_staff_document_upload/);
  assert.match(rosterPage, /ledger\.next_action === 'Upload evidence'\) openStaffProfile\(person, 'onboarding'\)/);
  assert.match(profilePage, /storage\.from\(STAFF_DOCUMENT_BUCKET\)\.upload/);
  assert.match(profilePage, /createSignedUrl\(storagePath, 60/);
  assert.match(profilePage, /Object\.entries\(selectedRecord\)\.filter\(\(\[key\]\) => !\['id', 'storage_path'\]\.includes\(key\)\)/);
});

test('staff document metadata and policies are limited to authenticated HR administrators', () => {
  assert.match(documentAuthorizationMigration, /REVOKE SELECT ON TABLE public\.staff_documents\s+FROM PUBLIC, anon/);
  for (const action of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
    assert.match(documentAuthorizationMigration, new RegExp(`FOR ${action}[\\s\\S]*?TO authenticated`));
  }
  assert.match(documentAuthorizationMigration, /USING \(public\.is_admin_for_org\(organization_id\)\)/);
  assert.match(documentAuthorizationMigration, /WITH CHECK \(public\.is_admin_for_org\(organization_id\)\)/);
});

test('branch access only offers active delivery branches, not the home organisation', () => {
  assert.match(branchPanel, /\.from\('organizations'\)\.select\('id,name'\)\.in\('id', branchIds\)\.eq\('organization_type', 'branch'\)\.eq\('active', true\)/);
  assert.match(branchPanel, /deliveryBranches\.map\(\(branch\) => <option key=\{branch\.id\} value=\{branch\.id\}>/);
  assert.doesNotMatch(branchPanel, /branches\.map\(\(branch\) => <option/);
});
