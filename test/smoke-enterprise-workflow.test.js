const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const schema = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8');
const page = fs.readFileSync(path.join(root, 'apps/web/src/pages/modules/SmokeControlPage.tsx'), 'utf8');

test('Smoke capture uses schema-valid classifications and governed submission', () => {
  for (const value of ['neighbour', 'council_hotline', 'self_report', 'other']) assert.match(page, new RegExp(`value="${value}"`));
  for (const value of ['domestic_solid_fuel', 'industrial', 'vehicle_exhaust', 'agricultural', 'nuisance_burning', 'unknown']) assert.match(page, new RegExp(`value="${value}"`));
  assert.match(page, /submit-smoke-assessment/);
  assert.match(page, /imageFileToBase64/);
  assert.match(page, /getCurrentPosition/);
  assert.doesNotMatch(page, /\.from\(['"]smoke_assessments['"]\)\s*\.(insert|update|delete)/);
});

test('Smoke submission derives authority, validates evidence, and is retry safe', () => {
  const tableDefinition = schema.match(/CREATE TABLE IF NOT EXISTS "public"\."smoke_assessments"[\s\S]*?\n\);/)?.[0] ?? '';
  for (const column of ['client_request_id', 'gps_lat', 'gps_lng', 'gps_accuracy', 'reviewed_by', 'reviewed_at', 'review_notes']) {
    assert.match(tableDefinition, new RegExp(`"${column}"`));
  }
  assert.match(schema, /submit_smoke_assessment/);
  assert.match(schema, /auth\.uid\(\)/);
  assert.match(schema, /client_request_id/);
  assert.match(schema, /pg_advisory_xact_lock/);
  assert.match(schema, /storage\.objects/);
  assert.match(schema, /complaint_address/);
  assert.match(schema, /source_confirmed/);
  assert.match(schema, /smoke_assessment_submitted/);
});

test('Smoke legal outcomes are supervisor-owned and evidence-backed', () => {
  assert.match(schema, /manage_smoke_assessment/);
  assert.match(schema, /Active Smoke Control administrator required/);
  assert.match(schema, /legal_basis/);
  assert.match(schema, /follow_up_required/);
  assert.match(schema, /smoke_assessment_reviewed/);
  assert.match(schema, /smoke_assessments_reviewed_by_fkey/);
  assert.match(page, /manage_smoke_assessment/);
});

test('authenticated users cannot mutate Smoke assessments directly', () => {
  assert.match(schema, /REVOKE INSERT,UPDATE,DELETE ON TABLE "public"\."smoke_assessments" FROM PUBLIC,"anon","authenticated"/);
});