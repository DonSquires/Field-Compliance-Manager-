const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'supabase/functions/classify-smoke-assessment/index.ts'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20260902007000_finalize_smoke_photo_inference.sql'), 'utf8');
const schema = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8');
const page = fs.readFileSync(path.join(root, 'apps/web/src/pages/modules/SmokeControlPage.tsx'), 'utf8');

test('Smoke inference authenticates and enforces tenant and officer ownership', () => {
  assert.match(source, /caller\.auth\.getUser\(\)/);
  assert.match(source, /assessment\.organization_id !== profile\.organization_id/);
  assert.match(source, /assessment\.officer_user_id !== user\.id/);
});

test('Smoke inference analyzes existing private evidence without accepting external URLs', () => {
  assert.match(source, /admin\.storage\.from\(EVIDENCE_BUCKET\)\.download/);
  assert.match(source, /org\/.*\/smoke\//);
  assert.doesNotMatch(source, /body\.photo_url/);
  assert.doesNotMatch(source, /\/api\/bob\/vision/);
});

test('Smoke inference is observational and forces review for consequential uncertainty', () => {
  assert.match(source, /type: 'json_schema'/);
  assert.match(source, /legal breach/);
  assert.match(source, /dark.*dense|dense.*dark/s);
  assert.match(source, /manual_review_required/);
  assert.match(source, /source_to_plume_link_confidence/);
  assert.match(source, /confidence_by_field/);
});

test('Smoke finalization is service-only, row-locked, tenant-scoped, and audited', () => {
  assert.match(migration, /auth\.role\(\) <> 'service_role'/i);
  assert.match(migration, /FOR UPDATE/i);
  assert.match(migration, /organization_id IS DISTINCT FROM v_actor\.organization_id/i);
  assert.match(migration, /smoke\.photo_classified/i);
  assert.match(migration, /REVOKE ALL ON FUNCTION[\s\S]*FROM[\s\S]*authenticated/i);
  assert.match(schema, /smoke_ai_analysis/);
});

test('Smoke workflow requests and presents advisory classification without deciding action', () => {
  assert.match(page, /'classify-smoke-assessment'/);
  assert.match(page, /Observational AI advisory/);
  assert.match(page, /Manual review required/);
  assert.match(page, /Retry AI analysis/);
  assert.doesNotMatch(page, /setDecision\([^)]*bob_/s);
});