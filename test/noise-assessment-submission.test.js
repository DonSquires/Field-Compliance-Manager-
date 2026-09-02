const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(
  path.join(root, 'supabase/migrations/20260902004000_govern_noise_assessment_submission.sql'),
  'utf8',
);
const submitFunction = fs.readFileSync(
  path.join(root, 'supabase/functions/submit-noise-assessment/index.ts'),
  'utf8',
);
const canonicalSchema = fs.readFileSync(
  path.join(root, 'supabase/schema.sql'),
  'utf8',
);

test('canonical schema retains the governed Noise submission boundary', () => {
  assert.match(canonicalSchema, /"client_request_id" "uuid"/);
  assert.match(canonicalSchema, /"noise_assessments_org_client_request_uidx"/);
  assert.match(canonicalSchema, /"submit_noise_assessment"\("p_client_request_id" uuid,"p_payload" jsonb\)/);
  assert.match(canonicalSchema, /REVOKE INSERT,UPDATE,DELETE ON TABLE "public"\."noise_assessments" FROM PUBLIC,"anon","authenticated"/);
});

test('noise assessment submission derives authority and ownership from the caller', () => {
  assert.match(migration, /v_actor uuid := auth\.uid\(\)/);
  assert.match(migration, /u\.deactivated_at is null/);
  assert.match(migration, /v_profile\.organization_id, v_actor, v_actor/);
  assert.match(migration, /revoke insert, update, delete on table public\.noise_assessments from public, anon, authenticated/);
  assert.match(submitFunction, /caller\.auth\.getUser\(\)/);
  assert.match(submitFunction, /profile\.deactivated_at/);
  assert.match(submitFunction, /caller\.rpc\('submit_noise_assessment'/);
});

test('noise assessment submission is retry safe and computes its matrix server-side', () => {
  assert.match(migration, /noise_assessments_org_client_request_uidx/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /return query select v_existing\.id, false/);
  assert.match(migration, /v_total := v_volume \+ coalesce\(v_time, 0\) \+ v_tone/);
  assert.match(migration, /public\.generate_noise_job_number\(\)/);
  assert.match(submitFunction, /if \(receipt\.created === false\)/);
  assert.match(submitFunction, /storage\.from\(EVIDENCE_BUCKET\)\.remove\(uploadedPaths\)/);
  assert.match(migration, /Selected action does not match the TDC matrix result/);
  assert.match(migration, /END and seizure actions require the governed enforcement workflow/);
  assert.match(migration, /noise_assessment_submitted/);
});

test('noise evidence is private, case-scoped, verified, bounded, and cleaned on failure', () => {
  assert.match(migration, /coalesce\(photo->>'storage_bucket', ''\) <> 'scans'/);
  assert.match(migration, /left join storage\.objects object/);
  assert.match(migration, /Noise evidence object does not exist/);
  assert.match(migration, /photo_urls/);
  assert.match(migration, /GPS coordinates are outside the accepted range/);
  assert.match(migration, /Complaint, arrival, and departure times are out of sequence/);
  assert.match(submitFunction, /MAX_IMAGE_BYTES = 8 \* 1024 \* 1024/);
  assert.match(submitFunction, /Noise evidence photos must be JPEG images/);
  assert.match(submitFunction, /org\/\$\{profile\.organization_id\}\/noise\/\$\{clientRequestId\}/);
  assert.match(submitFunction, /evidence\.photo_assessment_point\.length === 0/);
  assert.match(submitFunction, /storage\.from\(EVIDENCE_BUCKET\)\.remove\(uploadedPaths\)/);
});

const submissionFunctionPath = path.join(
  root,
  'supabase/functions/submit-noise-assessment/index.ts',
);
const officerPage = fs.readFileSync(
  path.join(root, 'apps/web/src/pages/OfficerNoiseControlPage.tsx'),
  'utf8',
);

test('officer Noise capture uses the governed submission boundary', () => {
  assert.match(officerPage, /functions\.invoke\('submit-noise-assessment'/);
  assert.doesNotMatch(officerPage, /\.from\('noise_assessments'\)\s*\.insert/);
});

test('Noise submission derives identity and validates enterprise evidence', () => {
  const source = fs.readFileSync(submissionFunctionPath, 'utf8');
  assert.match(source, /caller\.auth\.getUser\(\)/);
  assert.match(source, /ALLOWED_ROLES\.has\(String\(profile\.role\)\)/);
  assert.match(source, /caller\.rpc\('submit_noise_assessment'/);
  assert.match(migration, /v_profile\.organization_id, v_actor, v_actor/);
  assert.match(migration, /hs_checklist_completed, hs_checklist_items/);
  assert.match(migration, /v_volume, v_time, v_tone, v_total/);
  assert.match(migration, /complaint_address, noise_source_address/);
  assert.match(migration, /assessment_location, arrival_gps_lat/);
  assert.match(migration, /assessment_gps_lat, assessment_gps_lng/);
  assert.match(migration, /photo_assessment_point/);
  assert.match(migration, /incident_report_text/);
  assert.match(migration, /END and seizure actions require the governed enforcement workflow/);
});

test('Noise submission makes photo persistence and row creation atomic', () => {
  const source = fs.readFileSync(submissionFunctionPath, 'utf8');
  const upload = source.indexOf('storage.from(EVIDENCE_BUCKET).upload');
  const finalization = source.indexOf("caller.rpc('submit_noise_assessment'");
  assert.ok(upload >= 0 && upload < finalization);
  assert.match(source, /if \(uploadedPaths\.length > 0\)/);
  assert.match(source, /storage\.from\(EVIDENCE_BUCKET\)\.remove\(uploadedPaths\)/);
});