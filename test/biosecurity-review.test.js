const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(
  path.join(root, 'supabase/migrations/20260902003000_govern_biosecurity_review.sql'),
  'utf8',
);
const evidenceFunction = fs.readFileSync(
  path.join(root, 'supabase/functions/get-biosecurity-evidence-url/index.ts'),
  'utf8',
);
const oversightPage = fs.readFileSync(
  path.join(root, 'apps/web/src/pages/BiosecurityOversightPage.tsx'),
  'utf8',
);
const officerPage = fs.readFileSync(
  path.join(root, 'apps/web/src/pages/OfficerBiosecurityPage.tsx'),
  'utf8',
);
const notificationNavigation = fs.readFileSync(
  path.join(root, 'apps/web/src/lib/notificationNavigation.ts'),
  'utf8',
);

test('biosecurity review defines a constrained versioned case lifecycle', () => {
  assert.match(migration, /review_status IN \('awaiting_review', 'triaged', 'follow_up', 'closed'\)/);
  assert.match(migration, /review_priority IN \('urgent', 'high', 'routine', 'monitor'\)/);
  assert.match(migration, /species_review_decision IN \('pending', 'confirmed', 'rejected', 'insufficient_evidence'\)/);
  assert.match(migration, /v_item\.review_version <> p_expected_review_version/);
  assert.match(migration, /review_version = assessment\.review_version \+ 1/);
});

test('biosecurity review enforces tenant reviewer assignment and rationale', () => {
  assert.match(migration, /reviewer\.organization_id = v_item\.organization_id/);
  assert.match(migration, /reviewer\.deactivated_at IS NULL/);
  assert.match(migration, /public\.is_admin_for_org\(v_item\.organization_id\)/);
  assert.match(migration, /char_length\(v_notes\) < 10/);
  assert.match(migration, /REVOKE UPDATE, DELETE ON TABLE public\.biosecurity_assessments FROM PUBLIC, anon, authenticated/);
});

test('biosecurity review keeps AI advisory and human decisions separate', () => {
  assert.match(migration, /p_species_decision NOT IN \('confirmed', 'rejected'\)/);
  assert.match(migration, /species_confirmed = p_species_decision = 'confirmed'/);
  assert.match(migration, /confirmed_species_name = CASE WHEN p_species_decision = 'confirmed'/);
  assert.doesNotMatch(migration, /bob_species_confirmed\s*=/);
  assert.doesNotMatch(migration, /bob_checklist\s*=/);
});

test('biosecurity review audits and personally returns each outcome', () => {
  assert.match(migration, /'biosecurity_assessment_reviewed'/);
  assert.match(migration, /p_category => 'biosecurity_review'/);
  assert.match(migration, /p_recipient_user_id => v_officer/);
  assert.match(migration, /p_link_page => 'biosecurity-review'/);
  assert.match(migration, /v_item\.review_version::text/);
});

test('biosecurity evidence preview is private, tenant-scoped, and short lived', () => {
  assert.match(evidenceFunction, /caller\.auth\.getUser\(\)/);
  assert.match(evidenceFunction, /ADMIN_ROLES\.has/);
  assert.match(evidenceFunction, /\.eq\('organization_id', profile\.organization_id\)/);
  assert.match(evidenceFunction, /expectedPrefix/);
  assert.match(evidenceFunction, /photo\?\.storage_bucket !== 'scans'/);
  assert.match(evidenceFunction, /createSignedUrl\(storagePath, 300\)/);
});

test('oversight UX provides queue triage, private evidence, and explicit human decisions', () => {
  assert.match(oversightPage, /useDeferredValue\(query\)/);
  assert.match(oversightPage, /get-biosecurity-evidence-url/);
  assert.match(oversightPage, /manage_biosecurity_assessment_review/);
  assert.match(oversightPage, /Awaiting review/);
  assert.match(oversightPage, /Assigned reviewer/);
  assert.match(oversightPage, /Confirm species/);
  assert.match(oversightPage, /Reject identification/);
  assert.match(oversightPage, /Advisory only\. A named human reviewer owns the species decision/);
});

test('officer UX receives and focuses governed review outcomes', () => {
  assert.match(notificationNavigation, /biosecurity_review/);
  assert.match(notificationNavigation, /officer_biosecurity/);
  assert.match(officerPage, /requestedAssessmentId/);
  assert.match(officerPage, /Human decision:/);
  assert.match(officerPage, /Additional field evidence is required/);
});