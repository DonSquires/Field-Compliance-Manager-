const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const migration = read('supabase/migrations/20260926110000_identity_records_workspace.sql');
const api = read('services/fcm-api/server.js');
const dockerfile = read('services/fcm-api/Dockerfile');
const inferenceEdge = read('supabase/functions/bob-inference/index.ts');
const perceptionEdge = read('supabase/functions/bob-perceive-image/index.ts');
const workspace = read('apps/web/src/components/IdentityRecordsWorkspace.tsx');
const identityPage = read('apps/web/src/pages/UserManagementPage.tsx');
const cctvReviewPage = read('apps/web/src/pages/CCTVReviewPage.tsx');
const { extractIdentityFields, isoDate } = require('../services/fcm-api/src/bob/identityDocument');

test('identity OCR proposes editable driver and firearms licence fields', () => {
  assert.deepEqual(extractIdentityFields('DRIVER LICENCE\nName: Jane Citizen\nLicence No: AB123456\nDate of Birth: 04/05/1990\nExpiry Date: 01/02/2030', 'driver_licence'), {
    display_name: 'Jane Citizen', date_of_birth: '1990-05-04', expiry_date: '2030-02-01', driver_licence_number: 'AB123456',
  });
  assert.equal(extractIdentityFields('FIREARMS LICENCE\nName: Jamie Example\nLicence Number: Z1234567', 'firearms_licence').firearms_licence_number, 'Z1234567');
  assert.equal(isoDate('04/05/90'), '1990-05-04');
  assert.equal(isoDate('04/05/26'), '2026-05-04');
  assert.equal(isoDate('31/02/2030'), null);
});

test('identity registry writes are administrator-only, audited, and review-gated', () => {
  for (const fn of ['get_identity_registry', 'manage_identity_person', 'manage_identity_vehicle', 'register_identity_document_proposal', 'review_identity_document']) {
    assert.match(migration, new RegExp(`FUNCTION public\\.${fn}`));
  }
  assert.match(migration, /public\.is_admin_for_org\(p_organization_id\)/);
  assert.match(migration, /p_document_kind,[\s\S]*'manual_review_required', v_actor/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.person_identity_face_proposals[\s\S]*face_vec vector\(128\) NOT NULL/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.person_face_templates[\s\S]*face_vec vector\(128\) NOT NULL/);
  assert.match(migration, /IF p_action = 'reject'[\s\S]*DELETE FROM public\.person_identity_face_proposals/);
  assert.match(migration, /IF v_face_proposal\.identity_document_id IS NOT NULL THEN[\s\S]*INSERT INTO public\.person_face_templates/);
  assert.doesNotMatch(migration, /ADD COLUMN IF NOT EXISTS face_vec/);
  assert.doesNotMatch(migration, /INSERT INTO public\.face_observations[\s\S]*identity_candidate_enrollment/);
  assert.match(migration, /v_can_verify_identity := v_document\.document_kind IN \('driver_licence','firearms_licence','passport','national_id'\)/);
  assert.match(migration, /p_action = 'retire_faces'[\s\S]*DELETE FROM public\.person_face_templates/);
  assert.match(migration, /organization_id IS DISTINCT FROM p_organization_id/);
  assert.match(migration, /Shared canonical vehicle facts require grand master review/);
  assert.match(migration, /REVOKE SELECT ON TABLE public\.face_observations FROM anon, authenticated/);
  assert.match(migration, /metadata - ARRAY\['embedding','face_embedding','candidate_embedding','appearance_embedding'\]/);
  assert.match(migration, /UPDATE public\.person_records[\s\S]*metadata = metadata #- '\{face_reference,embedding\}'/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.refresh_face_observation_candidates/);
  assert.match(migration, /CREATE POLICY bob_full_read ON public\.bob_attachments[\s\S]*purpose <> 'identity_document'/);
  assert.match(migration, /DROP POLICY IF EXISTS bob_full_read ON public\.person_identity_documents/);
  assert.match(migration, /Service identity required for identity extraction registration/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.register_identity_document_proposal[\s\S]*authenticated/);
  assert.match(migration, /INSERT INTO public\.audit_log/);
});

test('private identity evidence runs local OCR and source-face inference', () => {
  assert.match(dockerfile, /tesseract-ocr/);
  assert.match(dockerfile, /poppler-utils/);
  assert.match(api, /\/api\/bob\/media\/identity-document/);
  assert.match(api, /tesseractText/);
  assert.match(api, /pdftoppm/);
  assert.match(api, /recognition\?\.source\?\.faces/);
  assert.match(inferenceEdge, /action === 'identity_document'/);
  assert.match(perceptionEdge, /register_identity_document_proposal/);
  assert.match(perceptionEdge, /admin\.rpc\('register_identity_document_proposal'/);
  assert.match(perceptionEdge, /att\.uploaded_by !== user\.id/);
  assert.match(perceptionEdge, /callerClient\.from\('bob_attachments'\)/);
  assert.match(perceptionEdge, /att\.purpose !== 'identity_document'/);
  assert.match(api, /unsupported_identity_document_type/);
  assert.match(api, /verifiedIdentityContext/);
  assert.match(inferenceEdge, /X-Identity-Context/);
});

test('People and Access exposes manual people, vehicles, and human-reviewed ID intake', () => {
  assert.match(identityPage, /Identity records/);
  assert.match(identityPage, /<IdentityRecordsWorkspace/);
  assert.match(workspace, /manage_identity_person/);
  assert.match(workspace, /manage_identity_vehicle/);
  assert.match(workspace, /mode: ["']identity_document["']/);
  assert.match(workspace, /Approve and update person/);
  assert.match(workspace, /Reject evidence/);
  assert.match(workspace, /One source-image face can become a matching candidate after approval/);
  assert.match(workspace, /Remove face candidate/);
  assert.match(workspace, /purpose: "identity_document"/);
  assert.match(workspace, /from\("identity-evidence"\)/);
  assert.match(workspace, /Driver licence expiry/);
  assert.match(identityPage, /canManageIdentityRecords/);
  assert.match(cctvReviewPage, /get_cctv_review_person_records/);
  assert.match(cctvReviewPage, /observation\.metadata\?\.source_event_id/);
  assert.doesNotMatch(cctvReviewPage, /from\('person_records'\)\.select\('id, display_name, review_state, metadata'\)/);
  assert.doesNotMatch(workspace, /from\('canonical_people'\).*\.(insert|update)/s);
  assert.doesNotMatch(workspace, /from\('canonical_vehicles'\).*\.(insert|update)/s);
});
