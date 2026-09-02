const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const evidenceFunction = fs.readFileSync(
  path.join(root, 'supabase/functions/generate-noise-evidence-package/index.ts'),
  'utf8',
);

test('noise evidence generation is restricted to active same-tenant administrators', () => {
  assert.match(evidenceFunction, /caller\.auth\.getUser\(\)/);
  assert.match(evidenceFunction, /ADMIN_ROLES\.has\(String\(profile\.role\)\)/);
  assert.match(evidenceFunction, /profile\.deactivated_at/);
  assert.match(evidenceFunction, /\.eq\("organization_id", profile\.organization_id\)/);
  assert.match(evidenceFunction, /client_sites!noise_assessments_site_id_fkey/);

  const profileGate = evidenceFunction.indexOf('ADMIN_ROLES.has(String(profile.role))');
  const assessmentRead = evidenceFunction.indexOf('.from("noise_assessments")');
  assert.ok(profileGate >= 0 && profileGate < assessmentRead);
});

test('noise evidence generation fails closed before creating or storing a PDF', () => {
  assert.match(evidenceFunction, /validateEvidenceReadiness\(assessment\)/);
  assert.match(evidenceFunction, /Evidence package is not ready/);
  assert.match(evidenceFunction, /hs_checklist_completed/);
  assert.match(evidenceFunction, /photo_assessment_point/);
  assert.match(evidenceFunction, /photo_source_address/);
  assert.match(evidenceFunction, /matrix_total/);
  assert.match(evidenceFunction, /incident_report_text/);
  assert.match(evidenceFunction, /action === "end"/);
  assert.match(evidenceFunction, /action === "seizure"/);
  assert.match(evidenceFunction, /validateSeizureReadiness\(seizure\)/);

  const readinessGate = evidenceFunction.indexOf('validateEvidenceReadiness(assessment)');
  const pdfCreation = evidenceFunction.indexOf('PDFDocument.create()');
  const storageUpload = evidenceFunction.indexOf('.from("notice-artifacts").upload');
  assert.ok(readinessGate >= 0 && readinessGate < pdfCreation);
  assert.ok(readinessGate < storageUpload);
});

test('noise evidence generation reads only governed private photo objects', () => {
  assert.match(evidenceFunction, /photoEntry\.storage_bucket !== "scans"/);
  assert.match(evidenceFunction, /storage\.from\(photoEntry\.storage_bucket\)\.createSignedUrl/);
  assert.doesNotMatch(evidenceFunction, /storage\.from\("evidence-photos"\)\.createSignedUrl/);
});