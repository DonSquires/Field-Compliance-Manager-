BEGIN;
SET LOCAL ROLE postgres;
SET LOCAL search_path TO public, extensions, pg_catalog;

CREATE OR REPLACE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  SET LOCAL ROLE authenticated;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.as_admin() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  SET LOCAL ROLE postgres;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.check(p_label text, p_ok boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT coalesce(p_ok, false) THEN RAISE EXCEPTION 'FAIL [%]', p_label; END IF;
  RAISE NOTICE 'ok [%]', p_label;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.make_nzta_document(
  p_admin uuid, p_org uuid, p_conversation uuid, p_person uuid,
  p_document_suffix text, p_plate text
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_attachment uuid := gen_random_uuid();
  v_result jsonb;
BEGIN
  INSERT INTO public.bob_attachments(
    id, organization_id, conversation_id, uploaded_by, file_name, file_type,
    file_size_bytes, storage_bucket, storage_path, purpose, processing_state
  ) VALUES (
    v_attachment, p_org, p_conversation, p_admin,
    'nzta-' || p_document_suffix || '.png', 'image/png', 10,
    'identity-evidence', 'org/' || p_org || '/identity/' || p_admin || '/' || p_document_suffix || '.png',
    'identity_document', 'processing'
  );
  v_result := public.register_deterministic_identity_document_proposal(
    p_admin, p_org, p_person, v_attachment, 'nzta_mvr_record',
    md5(p_document_suffix) || md5(p_document_suffix || '-source'),
    jsonb_build_object('display_name', p_document_suffix, 'plate_number', p_plate)
  );
  RETURN (v_result->>'identity_document_id')::uuid;
END $$;

DO $$
DECLARE
  v_provider uuid := gen_random_uuid();
  v_client uuid := gen_random_uuid();
  v_outside_org uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid();
  v_officer uuid := gen_random_uuid();
  v_conversation uuid := gen_random_uuid();
  v_person_a uuid := gen_random_uuid();
  v_person_b uuid := gen_random_uuid();
  v_person_outside uuid := gen_random_uuid();
  v_doc_a uuid;
  v_doc_b uuid;
  v_plate text;
  v_canonical_a uuid;
  v_canonical_b uuid;
  v_canonical_outside uuid;
  v_result jsonb;
  v_search jsonb;
  v_notice_a uuid;
  v_error text;
BEGIN
  v_plate := 'T' || upper(substr(replace(v_provider::text, '-', ''), 1, 6));
  INSERT INTO public.organizations(id, name, organization_type, parent_organization_id)
  VALUES (v_provider, 'Notice test provider', 'service_provider', NULL),
    (v_client, 'Notice test client', 'private_enterprise', v_provider),
    (v_outside_org, 'Notice test unrelated org', 'private_enterprise', NULL);
  INSERT INTO public.user_profiles(id, organization_id, role, display_name)
  VALUES (v_admin, v_provider, 'admin', 'Notice test reviewer'),
    (v_officer, v_provider, 'officer', 'Notice test officer');
  INSERT INTO public.service_agreements(
    id, provider_organization_id, client_organization_id, name, starts_on,
    agreement_type, invitation_status
  ) VALUES (
    gen_random_uuid(), v_provider, v_client, 'Historical notice test',
    current_date - 30, 'operational', 'accepted'
  );
  INSERT INTO public.person_records(id, organization_id, display_name, review_state, metadata)
  VALUES (v_person_a, v_provider, 'Mira Alder', 'manual_review_required', '{}'::jsonb),
    (v_person_b, v_provider, 'Beau Birch', 'manual_review_required', '{}'::jsonb),
    (v_person_outside, v_outside_org, 'Alex Stranger', 'verified', '{}'::jsonb);
  INSERT INTO public.bob_conversations(id, organization_id, user_id, module_key, title)
  VALUES (v_conversation, v_provider, v_admin, 'operations', 'Notice import test');
  v_canonical_outside := public.ensure_canonical_person_for_record(v_person_outside);

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin::text, 'role', 'authenticated')::text, true);
  v_doc_a := pg_temp.make_nzta_document(v_admin, v_provider, v_conversation, v_person_a, 'notice-owner-a', v_plate);
  v_doc_b := pg_temp.make_nzta_document(v_admin, v_provider, v_conversation, v_person_b, 'notice-owner-b', v_plate);
  PERFORM pg_temp.as_user(v_admin);
  PERFORM public.review_nzta_mvr_owner_evidence(
    v_doc_a,
    jsonb_build_object('display_name', 'Mira Alder', 'plate_number', v_plate,
      'query_completed_at', '2024-01-01T10:00:00+13:00', 'person_vehicle_match_confirmed', true),
    'Source image reviewed for historical notice matching'
  );
  PERFORM public.review_nzta_mvr_owner_evidence(
    v_doc_b,
    jsonb_build_object('display_name', 'Beau Birch', 'plate_number', v_plate,
      'query_completed_at', '2026-01-01T10:00:00+13:00', 'person_vehicle_match_confirmed', true),
    'Source image reviewed for historical notice matching'
  );
  PERFORM pg_temp.as_admin();
  SELECT canonical_person_id INTO v_canonical_a
  FROM public.vehicle_identity_checks WHERE identity_document_id = v_doc_a;
  SELECT canonical_person_id INTO v_canonical_b
  FROM public.vehicle_identity_checks WHERE identity_document_id = v_doc_b;
  PERFORM pg_temp.check(
    'owner reviews resolved two distinct canonical people',
    v_canonical_a IS NOT NULL AND v_canonical_b IS NOT NULL AND v_canonical_a <> v_canonical_b
  );
  PERFORM pg_temp.as_user(v_admin);

  v_result := public.import_person_notice(
    p_organization_id => v_client,
    p_notice_type => 'warning',
    p_status => 'issued',
    p_issued_at => '2025-01-01T09:00:00+13:00',
    p_subject_display_name => 'Mira Alder',
    p_source_document_name => 'Alder warning register entry',
    p_source_reference => 'local://fixture/alder-warning',
    p_source_sha256 => repeat('a', 64),
    p_import_key => 'notice-test:alder-warning',
    p_plate_number => v_plate,
    p_issued_date_basis => 'register'
  );
  v_notice_a := (v_result->>'notice_id')::uuid;
  PERFORM pg_temp.check(
    'notice resolves registered person as of its issue date, not the later current owner',
    (v_result->>'match_basis' = 'vehicle_registered_owner_at_notice')
      AND (v_result->>'canonical_person_id')::uuid = v_canonical_a
  );
  PERFORM pg_temp.check(
    'warning without explicit register expiry defaults to two years after issue',
    (SELECT expires_at = issued_at + interval '2 years'
     FROM public.notices WHERE id = v_notice_a)
  );

  v_result := public.import_person_notice(
    p_organization_id => v_client,
    p_notice_type => 'warning',
    p_status => 'issued',
    p_issued_at => '2026-03-01T09:00:00+13:00',
    p_subject_display_name => 'Beau Birch',
    p_source_document_name => 'Birch warning register entry',
    p_source_reference => 'local://fixture/birch-warning',
    p_source_sha256 => repeat('b', 64),
    p_import_key => 'notice-test:birch-warning',
    p_expires_at => '2027-04-01T00:00:00+13:00',
    p_plate_number => v_plate,
    p_issued_date_basis => 'register'
  );
  PERFORM pg_temp.check(
    'newer notice resolves the newer registered person and preserves explicit register expiry',
    (v_result->>'canonical_person_id')::uuid = v_canonical_b
      AND (SELECT expires_at = '2027-04-01T00:00:00+13:00'::timestamptz
           FROM public.notices WHERE id = (v_result->>'notice_id')::uuid)
  );

  v_result := public.import_person_notice(
    p_organization_id => v_client,
    p_notice_type => 'warning',
    p_status => 'issued',
    p_issued_at => '2025-01-01T09:00:00+13:00',
    p_subject_display_name => 'Mira Alder',
    p_source_document_name => 'Alder warning register entry',
    p_source_reference => 'local://fixture/alder-warning',
    p_source_sha256 => repeat('a', 64),
    p_import_key => 'notice-test:alder-warning',
    p_plate_number => v_plate,
    p_issued_date_basis => 'register'
  );
  PERFORM pg_temp.check(
    'identical source replay returns the existing notice',
    (v_result->>'inserted')::boolean = false
      AND (v_result->>'notice_id')::uuid = v_notice_a
  );

  v_error := NULL;
  BEGIN
    PERFORM public.import_person_notice(
      p_organization_id => v_client,
      p_notice_type => 'warning',
      p_status => 'issued',
      p_issued_at => '2025-01-01T09:00:00+13:00',
      p_subject_display_name => 'Mira Alder',
      p_source_document_name => 'Alder warning register entry',
      p_source_reference => 'local://fixture/alder-warning',
      p_source_sha256 => repeat('c', 64),
      p_import_key => 'notice-test:alder-warning',
      p_plate_number => v_plate,
      p_issued_date_basis => 'register'
    );
  EXCEPTION WHEN OTHERS THEN
    v_error := SQLERRM;
  END;
  PERFORM pg_temp.check(
    'reused import key with a different source hash is rejected',
    v_error = 'Import key already exists with a different source hash'
  );

  v_error := NULL;
  BEGIN
    PERFORM public.import_person_notice(
      p_organization_id => v_client,
      p_notice_type => 'warning',
      p_status => 'issued',
      p_issued_at => '2026-05-01T09:00:00+13:00',
      p_subject_display_name => 'Alex Stranger',
      p_source_document_name => 'Unrelated record',
      p_source_reference => 'local://fixture/unrelated',
      p_source_sha256 => repeat('d', 64),
      p_import_key => 'notice-test:unrelated-person',
      p_canonical_person_id => v_canonical_outside
    );
  EXCEPTION WHEN OTHERS THEN
    v_error := SQLERRM;
  END;
  PERFORM pg_temp.check(
    'provider cannot attach an unrelated tenant person to a client notice',
    v_error = 'Canonical person not found in provider/client scope'
  );

  PERFORM public.import_person_notice(
    p_organization_id => v_client,
    p_notice_type => 'permit_refusal',
    p_status => 'issued',
    p_issued_at => '2026-05-01T09:00:00+13:00',
    p_subject_display_name => 'Alex Letter',
    p_source_document_name => 'Permit refusal letter',
    p_source_reference => 'local://fixture/permit-refusal',
    p_source_sha256 => repeat('e', 64),
    p_import_key => 'notice-test:permit-refusal',
    p_title => 'Permit refusal',
    p_issued_date_basis => 'document'
  );
  v_search := public.search_people('Alex Letter', 25);
  PERFORM pg_temp.check(
    'permit refusal is searchable but does not create an entry ban or expiry',
    jsonb_array_length(v_search) = 1
      AND (v_search->0->>'has_notice_in_force')::boolean = false
      AND (SELECT expires_at IS NULL AND notice_type = 'permit_refusal'
           FROM public.notices WHERE import_key = 'notice-test:permit-refusal')
  );

  v_error := NULL;
  BEGIN
    PERFORM public.import_person_notice(
      p_organization_id => v_client,
      p_notice_type => 'contact_request',
      p_status => 'issued',
      p_issued_at => '2026-05-02T09:00:00+13:00',
      p_subject_display_name => 'Alex Letter',
      p_source_document_name => 'Contact request letter',
      p_source_reference => 'local://fixture/contact-request',
      p_source_sha256 => repeat('f', 64),
      p_import_key => 'notice-test:contact-request-expiry',
      p_expires_at => '2027-05-02T09:00:00+13:00',
      p_title => 'Contact request',
      p_issued_date_basis => 'document'
    );
  EXCEPTION WHEN OTHERS THEN
    v_error := SQLERRM;
  END;
  PERFORM pg_temp.check(
    'a letter cannot be given an expiry date',
    v_error = 'Letters do not expire'
      AND NOT EXISTS (SELECT 1 FROM public.notices WHERE import_key = 'notice-test:contact-request-expiry')
  );

  PERFORM pg_temp.as_user(v_officer);
  v_error := NULL;
  BEGIN
    PERFORM public.import_person_notice(
      p_organization_id => v_client,
      p_notice_type => 'warning',
      p_status => 'issued',
      p_issued_at => '2026-06-01T09:00:00+13:00',
      p_subject_display_name => 'Officer Test',
      p_source_document_name => 'Unauthorized notice',
      p_source_reference => 'local://fixture/unauthorized',
      p_source_sha256 => repeat('f', 64),
      p_import_key => 'notice-test:unauthorized'
    );
  EXCEPTION WHEN OTHERS THEN
    v_error := SQLERRM;
  END;
  PERFORM pg_temp.check(
    'non-administrator cannot import a client notice',
    v_error = 'Provider administrator access to this client organisation is required'
  );
END $$;

SELECT true AS person_notice_import_passed;
ROLLBACK;
