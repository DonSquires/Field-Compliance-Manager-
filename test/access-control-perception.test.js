'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const migration = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', '20261011021250_access_control_evidence_adapter.sql'),
  'utf8',
);
const submitFunction = fs.readFileSync(
  path.join(root, 'supabase', 'functions', 'submit-access-control-event', 'index.ts'),
  'utf8',
);
const recognizeFunction = fs.readFileSync(
  path.join(root, 'supabase', 'functions', 'recognize-access-subject', 'index.ts'),
  'utf8',
);
const recognitionCandidates = fs.readFileSync(
  path.join(root, 'supabase', 'functions', '_shared', 'recognitionCandidates.ts'),
  'utf8',
);
const classifier = fs.readFileSync(
  path.join(root, 'supabase', 'functions', 'classify-photo', 'index.ts'),
  'utf8',
);
const webPage = fs.readFileSync(
  path.join(root, 'apps', 'web', 'src', 'pages', 'OfficerAccessControlPage.tsx'),
  'utf8',
);
const mobilePanel = fs.readFileSync(
  path.join(root, 'apps', 'mobile', 'src', 'components', 'OfficerAccessControlPanel.tsx'),
  'utf8',
);
const specialtyModules = fs.readFileSync(
  path.join(root, 'apps', 'web', 'src', 'config', 'specialtyModules.ts'),
  'utf8',
);
const officerShell = fs.readFileSync(
  path.join(root, 'apps', 'web', 'src', 'shells', 'OfficerShell.tsx'),
  'utf8',
);
const moduleProfiles = fs.readFileSync(
  path.join(root, 'supabase', 'functions', '_shared', 'moduleProfiles.ts'),
  'utf8',
);

test('access control has a typed, tenant-scoped operational record and evidence link', () => {
  assert.match(migration, /CREATE TABLE public\.access_control_events/);
  assert.match(migration, /CREATE TABLE public\.access_control_event_evidence/);
  assert.match(migration, /organization_id uuid NOT NULL REFERENCES public\.organizations/);
  assert.match(migration, /officer_user_id uuid NOT NULL REFERENCES public\.user_profiles/);
  assert.match(migration, /location_event_id uuid REFERENCES public\.location_events/);
  assert.match(migration, /UNIQUE \(organization_id, client_request_id\)/);
  assert.match(migration, /CREATE INDEX access_control_events_review_queue_idx/);
  assert.match(migration, /CREATE INDEX access_control_event_evidence_item_idx/);
  assert.match(migration, /ALTER TABLE public\.access_control_events ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /ALTER TABLE public\.access_control_event_evidence ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /officer_user_id = \(SELECT auth\.uid\(\)\)/);
  assert.match(migration, /public\.is_admin_for_org\(organization_id\)/);
  assert.match(migration, /REVOKE ALL ON TABLE public\.access_control_events FROM PUBLIC, anon, authenticated/);
  assert.doesNotMatch(migration, /GRANT (INSERT|UPDATE|DELETE).*access_control_events TO authenticated/);
});

test('governed receipt separates officer action, place resolution, custody, and machine evidence', () => {
  assert.match(migration, /FUNCTION public\.submit_access_control_event_receipt/);
  assert.match(migration, /Service identity required/);
  assert.match(migration, /Access-control standing authority or an active access-control shift is required/);
  assert.match(migration, /Access Control is not enabled for this organization/);
  assert.match(migration, /Officer organization has no active authority at this place/);
  assert.match(migration, /Selected site and zone do not describe the same canonical place/);
  assert.match(migration, /'access_control\.' \|\| p_event_kind/);
  assert.match(migration, /'access_control_event_recorded'/);
  assert.match(migration, /is_court_ready,\s*\n\s+locked_at/);
  assert.match(migration, /authoritative_source_preserved', true/);
  assert.match(migration, /machine_candidate_discovery_permitted', true/);
  assert.match(migration, /machine_identity_confirmation_permitted', false/);
  assert.match(migration, /machine_access_decision_permitted', false/);
});

test('recognition adapter records ranked discovery candidates without confirming identity or access', () => {
  assert.match(migration, /FUNCTION public\.record_access_control_perception_envelope/);
  assert.match(migration, /'access_control_photo'/);
  for (const field of [
    'access.subject_kind',
    'access.person_present',
    'access.face_visible',
    'access.credential_visible',
    'access.vehicle_present',
  ]) {
    assert.match(migration, new RegExp(field.replace('.', '\\.')));
  }
  assert.match(migration, /advisory_access_scene_candidate_human_review_required_v1/);
  assert.match(migration, /access\.person_match_candidate/);
  assert.match(migration, /access\.vehicle_match_candidate/);
  assert.match(migration, /ranked_similarity_candidate_human_confirmation_required_v1/);
  assert.match(migration, /manual_review_required/);
  assert.match(migration, /identity_confirmation_permitted', false/);
  assert.match(migration, /access_decision_permitted', false/);
  assert.doesNotMatch(migration, /recognition.*officer_decision :=/);
});

test('edge submission resolves place, preserves evidence, and reruns deterministic recognition', () => {
  assert.match(submitFunction, /rpc\('resolve_context'/);
  assert.match(submitFunction, /p_module_key: 'access_control'/);
  assert.match(submitFunction, /Selected site does not match the current verified place context/);
  assert.match(submitFunction, /No access-control place could be resolved/);
  assert.match(submitFunction, /-original\.jpg/);
  assert.match(submitFunction, /-watermarked\.jpg/);
  assert.match(submitFunction, /sha256Hex/);
  assert.match(submitFunction, /inferAccessRecognition/);
  assert.match(submitFunction, /probe_image_url/);
  assert.match(submitFunction, /submit_access_control_event_receipt/);
  assert.match(submitFunction, /record_access_control_perception_envelope/);
  assert.match(submitFunction, /recognition = \{\s*\n\s*status: 'unavailable'/);
  assert.doesNotMatch(submitFunction, /recognition = \{[^}]*classification: ['"`](person|vehicle|unknown)/);
});

test('pre-decision recognition ranks face, person, vehicle, and plate candidates', () => {
  assert.match(recognizeFunction, /inferAccessRecognition/);
  assert.match(recognitionCandidates, /\/infer\/enhance/);
  assert.match(recognitionCandidates, /find_cctv_portfolio_matches/);
  assert.match(recognitionCandidates, /face_embedding/);
  assert.match(recognitionCandidates, /appearance_embedding/);
  assert.match(recognitionCandidates, /plate_number/);
  assert.match(recognitionCandidates, /reference_thumbnail/);
  assert.match(recognitionCandidates, /Possible matches are ranked from face, body, vehicle appearance, and plate similarity/);
  assert.match(recognitionCandidates, /withoutEmbedding/);
});

test('generic access scene classifier stays bounded away from invented identity and entry decisions', () => {
  assert.match(classifier, /access_control:/);
  assert.match(classifier, /Do not identify or name any person/);
  assert.match(classifier, /Do not match a face, body, vehicle, credential, or plate/);
  assert.match(classifier, /Do not decide whether entry should be granted or refused/);
  assert.match(classifier, /"credential_visible": true or false/);
  assert.match(classifier, /"vehicle_present": true or false/);
});

test('web and mobile UX show probe/reference comparisons before preserving the officer record', () => {
  for (const source of [webPage, mobilePanel]) {
    assert.match(source, /Officer record/);
    assert.match(source, /Bob recognition discovery/);
    assert.match(source, /recognize-access-subject/);
    assert.match(source, /Possible matches/);
    assert.match(source, /comparison reference/);
    assert.match(source, /only a user can confirm identity/);
    assert.match(source, /submit-access-control-event/);
    assert.match(source, /gps_lat/);
    assert.match(source, /gps_lng/);
    assert.match(source, /recognitionReviewState/);
  }
  assert.match(webPage, /Classification unavailable; no fallback candidate was invented/);
  assert.match(webPage, /Unresolved or mismatched place context is shown explicitly/);
  assert.match(mobilePanel, /Current GPS is required to resolve the access-control place/);
});

test('access control is registered as one field module across web and Bob profiles', () => {
  assert.match(specialtyModules, /key: 'access_control'/);
  assert.match(specialtyModules, /integratedKey: 'access_control'/);
  assert.match(officerShell, /const OfficerAccessControlPage = React\.lazy/);
  assert.match(officerShell, /case 'access_control':\s*\n\s*return <OfficerAccessControlPage \/>/);
  assert.match(moduleProfiles, /key: 'access_control'[\s\S]*kind: 'recognize'[\s\S]*key: 'access_subject'/);
  assert.match(moduleProfiles, /'access_control_events'/);
});
