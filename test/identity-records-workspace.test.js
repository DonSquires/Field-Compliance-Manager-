const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const migration = read('supabase/migrations/20260926110000_identity_records_workspace.sql');
const securityLicenceMigration = read('supabase/migrations/20260926140000_security_licence_identity_intake.sql');
const deterministicTypesMigration = read('supabase/migrations/20260927020000_deterministic_identity_document_types.sql');
const canonicalIncidentMigration = read('supabase/migrations/20260927030000_canonical_staff_and_incident_people.sql');
const incidentEvidenceMigration = read('supabase/migrations/20260927040000_incident_identity_evidence_workflow.sql');
const identityResolutionMigration = read('supabase/migrations/20260927051000_resolve_identity_to_existing_person.sql');
const nztaIdentityMigration = read('supabase/migrations/20261010204538_govern_nzta_mvr_identity_checks.sql');
const vehicleJsonMigration = read('supabase/migrations/20261010205741_fix_identity_vehicle_jsonb_object_length.sql');
const nztaComplianceSourceMigration = read('supabase/migrations/20261010205847_allow_nzta_mvr_vehicle_compliance_source.sql');
const api = read('services/fcm-api/server.js');
const dockerfile = read('services/fcm-api/Dockerfile');
const inferenceEdge = read('supabase/functions/bob-inference/index.ts');
const perceptionEdge = read('supabase/functions/bob-perceive-image/index.ts');
const workspace = read('apps/web/src/components/IdentityRecordsWorkspace.tsx');
const identityPage = read('apps/web/src/pages/UserManagementPage.tsx');
const cctvReviewPage = read('apps/web/src/pages/CCTVReviewPage.tsx');
const officerFieldReportPage = read('apps/web/src/pages/OfficerFieldReportPage.tsx');
const { extractIdentityFields, isoDate } = require('../services/fcm-api/src/bob/identityDocument');

test('identity OCR proposes editable driver, firearms, and security licence fields', () => {
  assert.deepEqual(extractIdentityFields('DRIVER LICENCE\nName: Jane Citizen\nLicence No: AB123456\nDate of Birth: 04/05/1990\nExpiry Date: 01/02/2030', 'driver_licence'), {
    display_name: 'Jane Citizen', date_of_birth: '1990-05-04', expiry_date: '2030-02-01', driver_licence_number: 'AB123456',
  });

  assert.equal(extractIdentityFields('FIREARMS LICENCE\nName: Jamie Example\nLicence Number: Z1234567', 'firearms_licence').firearms_licence_number, 'Z1234567');
  assert.deepEqual(extractIdentityFields('PRIVATE SECURITY PERSONNEL BADGE\nName: Jamie Example\nCertificate of Approval Number: TEST-1234\nExpiry 24-07-2030\nPSG CC SC ST RPA', 'security_licence'), {
    display_name: 'Jamie Example', expiry_date: '2030-07-24', security_licence_number: 'TEST-1234',
    security_licence_authority: 'Private Security Personnel Licensing Authority',
    security_endorsements: 'Personal guard, Crowd controller, Security consultant, Security technician, Repossession agent',
  });
  const noisyCoa = extractIdentityFields('PRIVATE SECURITY PERSONNEL BADGE\nCertificate of Approval Number:\ne e 17-041302\n24-07-2036\nPSG CC', 'security_licence');
  assert.equal(noisyCoa.security_licence_number, '17-041302');
  assert.equal(noisyCoa.expiry_date, '2036-07-24');
  assert.equal(isoDate('04/05/90'), '1990-05-04');
  assert.equal(isoDate('04/05/26'), '2026-05-04');
  assert.equal(isoDate('31/02/2030'), null);
});

test('NZTA MVR screenshots produce source-time person and vehicle review candidates', () => {
  const fields = extractIdentityFields(
    [
      'Current details query results',
      '06/10/2026 09:18:08',
      '2009 Mazda Demio Hatchback',
      'Plate: ABC123',
      'VIN: TESTVIN123456789',
      'Current registered person: Example Holdings Limited',
      'Vehicle type: Passenger Car/Van',
      'Chassis number: TEST-CHASSIS',
      'Colour: Silver',
      'Engine no: TEST-ENGINE',
      'Fuel type: Petrol',
      'Expiry date of last WOF: 23/12/2026',
      'Registration status: Active',
      'Licence expiry date: 28/09/2027',
    ].join('\n'),
    'nzta_mvr_record',
  );
  assert.deepEqual(fields, {
    display_name: 'Example Holdings Limited',
    plate_number: 'ABC123',
    vin: 'TESTVIN123456789',
    query_completed_at: '2026-10-06T09:18:08',
    vehicle_year: '2009',
    vehicle_make: 'Mazda',
    vehicle_model: 'Demio',
    vehicle_body_type: 'Hatchback',
    vehicle_colour: 'Silver',
    chassis_number: 'TEST-CHASSIS',
    engine_number: 'TEST-ENGINE',
    fuel_type: 'Petrol',
    registration_status: 'Active',
    rego_expiry: '2027-09-28',
    wof_expiry: '2026-12-23',
  });
  assert.match(nztaIdentityMigration, /CREATE TABLE public\.vehicle_identity_checks/);
  assert.match(nztaIdentityMigration, /review_nzta_mvr_identity_evidence/);
  assert.match(nztaIdentityMigration, /person_vehicle_match_confirmed/);
  assert.match(nztaIdentityMigration, /compliance_source = 'nzta_mvr'/);
  assert.match(nztaIdentityMigration, /get_vehicle_identity_checks/);
  assert.match(nztaIdentityMigration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(nztaIdentityMigration, /REVOKE ALL ON TABLE public\.vehicle_identity_checks FROM PUBLIC, anon, authenticated/);
  assert.match(vehicleJsonMigration, /CREATE OR REPLACE FUNCTION public\.jsonb_object_length/);
  assert.match(vehicleJsonMigration, /FROM jsonb_object_keys/);
  assert.match(vehicleJsonMigration, /REVOKE ALL ON FUNCTION public\.jsonb_object_length/);
  assert.match(nztaComplianceSourceMigration, /canonical_vehicles_compliance_source_check/);
  assert.match(nztaComplianceSourceMigration, /'nzta_mvr'::text/);
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
  assert.match(api, /\/infer\/face/);
  assert.match(api, /Array\.isArray\(payload\?\.faces\)/);
  assert.match(inferenceEdge, /action === 'identity_document'/);
  assert.match(perceptionEdge, /register_deterministic_identity_document_proposal/);
  assert.match(perceptionEdge, /admin\.rpc\('register_deterministic_identity_document_proposal'/);
  assert.match(perceptionEdge, /att\.uploaded_by !== user\.id/);
  assert.match(perceptionEdge, /const attachmentClient = incidentMode \? admin : callerClient/);
  assert.match(perceptionEdge, /incident_identity_document/);
  assert.match(perceptionEdge, /can_record_incident_person/);
  assert.match(perceptionEdge, /attach_incident_identity_proposal/);
  assert.match(perceptionEdge, /att\.purpose !== 'identity_document'/);
  assert.match(api, /unsupported_identity_document_type/);
  assert.match(api, /verifiedIdentityContext/);
  assert.match(inferenceEdge, /X-Identity-Context/);
});

test('security licences and historical versions use governed current-value rules', () => {
  assert.match(securityLicenceMigration, /'security_licence'/);
  assert.match(securityLicenceMigration, /FUNCTION public\.manage_identity_person_record/);
  assert.match(securityLicenceMigration, /FUNCTION public\.review_identity_evidence/);
  assert.match(securityLicenceMigration, /v_incoming_expiry >= current_date/);
  assert.match(securityLicenceMigration, /v_incoming_expiry >= v_existing_expiry/);
  assert.match(securityLicenceMigration, /promoted_to_current_profile/);
  assert.match(securityLicenceMigration, /REVOKE EXECUTE ON FUNCTION public\.review_identity_document[\s\S]*FROM authenticated/);
});

test('identity and warrant intake is driven by deterministic document definitions', () => {
  for (const kind of ['warrant_of_appointment', 'noise_control_warrant', 'parking_warrant', 'freedom_camping_warrant', 'biosecurity_warrant']) {
    assert.match(deterministicTypesMigration, new RegExp(`'${kind}'`));
  }
  assert.match(deterministicTypesMigration, /CREATE TABLE IF NOT EXISTS public\.identity_document_type_definitions/);
  assert.match(deterministicTypesMigration, /'parking_warrant'[\s\S]*'warrant_of_authority'[\s\S]*ARRAY\['Parking warden'\]/);
  assert.match(deterministicTypesMigration, /'freedom_camping_warrant'[\s\S]*'warrant_of_authority'[\s\S]*ARRAY\['Freedom camping officer'\]/);
  assert.match(deterministicTypesMigration, /FUNCTION public\.register_deterministic_identity_document_proposal/);
  assert.match(deterministicTypesMigration, /FUNCTION public\.review_deterministic_identity_evidence/);
  const noise = extractIdentityFields('NOISE CONTROL OFFICER WARRANT\nWarrant Number: NCO-1234\nIssued by: Example Council\nValid to: 01-09-2031', 'noise_control_warrant');
  assert.equal(noise.document_number, 'NCO-1234');
  assert.equal(noise.expiry_date, '2031-09-01');
  assert.equal(noise.issuing_authority, 'Example Council');
  assert.equal(noise.authorized_activities, 'Noise control officer');
});

test('staff and incident identities converge on canonical people', () => {
  assert.match(canonicalIncidentMigration, /FUNCTION public\.ensure_canonical_person_for_staff/);
  assert.match(canonicalIncidentMigration, /source_table\s*=\s*'staff_profiles'|source_table,source_id[\s\S]*'staff_profiles'/);
  assert.match(canonicalIncidentMigration, /CREATE TABLE IF NOT EXISTS public\.incident_person_links/);
  assert.match(canonicalIncidentMigration, /FUNCTION public\.record_incident_person_identity/);
  assert.match(canonicalIncidentMigration, /incident\.officer_user_id=p_actor/);
  assert.match(canonicalIncidentMigration, /review_state,metadata\)[\s\S]*'manual_review_required'/);
  assert.match(canonicalIncidentMigration, /Approved identity evidence for this person is required/);
  assert.match(canonicalIncidentMigration, /incident_person_identity_recorded/);
});

test('assigned officers capture incident ID evidence and admins hand staff credentials to HR', () => {
  assert.match(incidentEvidenceMigration, /FUNCTION public\.register_incident_identity_attachment/);
  assert.match(incidentEvidenceMigration, /incident-.*can_record_incident_person/s);
  assert.match(incidentEvidenceMigration, /FUNCTION public\.attach_incident_identity_proposal/);
  assert.match(incidentEvidenceMigration, /FUNCTION public\.review_canonical_identity_evidence/);
  assert.match(incidentEvidenceMigration, /record_staff_credential/);
  assert.match(incidentEvidenceMigration, /false,'Created from approved identity evidence; People & HR verification still required'/);
  assert.match(officerFieldReportPage, /Record a person and ID source/);
  assert.match(officerFieldReportPage, /register_incident_identity_attachment/);
  assert.match(officerFieldReportPage, /mode: 'incident_identity_document'/);
  assert.match(officerFieldReportPage, /remains unverified until approval/);
});

test('admins resolve temporary incident identities to an existing canonical person', () => {
  assert.match(identityResolutionMigration, /FUNCTION public\.get_identity_resolution_candidates/);
  assert.match(identityResolutionMigration, /FUNCTION public\.resolve_identity_document_person/);
  assert.match(identityResolutionMigration, /UPDATE public\.person_identity_face_proposals SET person_record_id=v_target\.id/);
  assert.match(identityResolutionMigration, /UPDATE public\.cctv_entity_observations SET person_record_id=v_target\.id,canonical_person_id=v_target_canonical/);
  assert.match(identityResolutionMigration, /UPDATE public\.face_observations SET person_record_id=v_target\.id/);
  assert.match(identityResolutionMigration, /UPDATE public\.observations SET person_record_id=v_target\.id,canonical_person_id=v_target_canonical/);
  assert.match(identityResolutionMigration, /identity_document_person_resolved/);
});

test('People and Access exposes manual people, vehicles, and human-reviewed ID intake', () => {
  assert.match(identityPage, /Identity records/);
  assert.match(identityPage, /<IdentityRecordsWorkspace/);
  assert.match(workspace, /manage_identity_person_record/);
  assert.match(workspace, /manage_identity_vehicle/);
  assert.match(workspace, /mode: ["']identity_document["']/);
  assert.match(workspace, /Approve and update person/);
  assert.match(workspace, /Reject evidence/);
  assert.match(workspace, /contain one source face that can become a candidate after approval/);
  assert.match(workspace, /Security licence \/ CoA/);
  assert.match(workspace, /People &amp;\s*HR → Credentials/);
  assert.match(workspace, /multiple/);
  assert.match(workspace, /Upload and extract \$\{documentFiles\.length\} files/);
  assert.match(workspace, /review_canonical_identity_evidence/);
  assert.match(workspace, /unverified credential handoff is ready in People & HR → Credentials/);
  assert.match(workspace, /Reject it, then upload it under the matching evidence type/);
  assert.match(workspace, /Historical licence retained without replacing current details/);
  assert.match(workspace, /Historical evidence · Current details unchanged/);
  assert.match(workspace, /Remove face candidate/);
  assert.match(workspace, /Evidence review complete/);
  assert.match(workspace, /No people match this search\. Add a person to begin\./);
  assert.match(workspace, /const savedRecord = nextRegistry\?\.people\.find/);
  assert.match(workspace, /<span>Address<\/span>/);
  assert.match(workspace, /review required/);
  assert.match(workspace, /1\. \{selectedPersonId \? "Person details" : "Add person"\}/);
  assert.match(workspace, /2\. Identity evidence/);
  assert.match(workspace, /3\. Incident involvement/);
  assert.match(workspace, /record_incident_person_identity/);
  assert.match(workspace, /Link person to incident/);
  assert.match(workspace, /Resolve to an existing person/);
  assert.match(workspace, /resolve_identity_document_person/);
  assert.match(workspace, /Use existing person/);
  assert.match(workspace, /System suggestion:/);
  assert.match(workspace, /prior CCTV sighting/);
  assert.match(workspace, /approved identity source/);
  assert.match(workspace, /I compared the source and confirm this is the same person/);
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
