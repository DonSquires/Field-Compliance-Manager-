const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(
  path.join(root, 'supabase/functions/classify-biosecurity-photo/index.ts'),
  'utf8',
);
const migration = fs.readFileSync(
  path.join(root, 'supabase/migrations/20260902002000_finalize_biosecurity_photo_inference.sql'),
  'utf8',
);
const officerPage = fs.readFileSync(
  path.join(root, 'apps/web/src/pages/OfficerBiosecurityPage.tsx'),
  'utf8',
);

test('biosecurity inference authenticates and enforces tenant and officer ownership', () => {
  assert.match(source, /caller\.auth\.getUser\(\)/);
  assert.match(source, /assessment\.organization_id !== profile\.organization_id/);
  assert.match(source, /assessment\.officer_user_id !== user\.id/);
});

test('biosecurity inference supports plants, insects, and explicit uncertainty', () => {
  assert.match(source, /\['plant', 'insect', 'other', 'unknown'\]/);
  assert.match(source, /\['identified', 'uncertain', 'not_identifiable'\]/);
  assert.match(source, /confidence < 0\.8/);
  assert.match(source, /manual_review_required/);
});

test('biosecurity inference stores private evidence and never confirms species', () => {
  assert.match(source, /const EVIDENCE_BUCKET = 'scans'/);
  assert.match(source, /finalize_biosecurity_photo_inference/);
  assert.doesNotMatch(source, /species_confirmed:\s*true/);
  assert.match(migration, /bob_species_confirmed = false/);
  assert.match(migration, /'biosecurity\.photo_classified'/);
});

test('biosecurity finalization is service-only, row-locked, tenant-scoped, and atomic with audit', () => {
  assert.match(migration, /auth\.role\(\) <> 'service_role'/);
  assert.match(migration, /FOR UPDATE/);
  assert.match(migration, /v_assessment\.organization_id IS DISTINCT FROM v_actor\.organization_id/);
  assert.match(migration, /photo_urls = COALESCE\(photo_urls, '\[\]'::jsonb\) \|\| jsonb_build_array\(p_photo\)/);
  assert.match(migration, /INSERT INTO public\.audit_log/);
  assert.match(migration, /REVOKE ALL ON FUNCTION[\s\S]*FROM authenticated/);
});

test('biosecurity inference uses the live OpenAI vision contract rather than retired Bob route', () => {
  assert.match(source, /\/chat\/completions/);
  assert.match(source, /type: 'image_url'/);
  assert.match(source, /type: 'json_schema'/);
  assert.doesNotMatch(source, /\/api\/bob\/vision/);
});

test('officer workflow uploads evidence and displays uncertain advisories for manual review', () => {
  assert.match(officerPage, /imageFileToBase64\(photo\)/);
  assert.match(officerPage, /'classify-biosecurity-photo'/);
  assert.match(officerPage, /a\.bob_checklist &&/);
  assert.match(officerPage, /Identification uncertain/);
  assert.match(officerPage, /Manual specialist review required/);
});