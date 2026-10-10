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

DO $$
DECLARE
  v_org uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid();
  v_person uuid := gen_random_uuid();
  v_conversation uuid := gen_random_uuid();
  v_attachment uuid := gen_random_uuid();
  v_document uuid;
  v_vehicle uuid;
  v_result jsonb;
  v_error text;
BEGIN
  INSERT INTO public.organizations(id, name, organization_type)
  VALUES(v_org, 'T_NZTA_MVR_IDENTITY', 'service_provider');
  INSERT INTO public.user_profiles(id, organization_id, role, display_name)
  VALUES(v_admin, v_org, 'admin', 'NZTA Review Admin');
  INSERT INTO public.person_records(id, organization_id, display_name, review_state, metadata)
  VALUES(v_person, v_org, 'Example Registered Person', 'manual_review_required', '{}'::jsonb);
  INSERT INTO public.bob_conversations(id, organization_id, user_id, module_key, title)
  VALUES(v_conversation, v_org, v_admin, 'operations', 'NZTA identity test');
  INSERT INTO public.bob_attachments(
    id, organization_id, conversation_id, uploaded_by, file_name, file_type,
    file_size_bytes, storage_bucket, storage_path, purpose, processing_state
  ) VALUES (
    v_attachment, v_org, v_conversation, v_admin, 'nzta-source.png', 'image/png',
    10, 'identity-evidence', 'org/' || v_org || '/identity/' || v_admin || '/nzta-source.png',
    'identity_document', 'processing'
  );

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin::text, 'role', 'authenticated')::text, true);
  v_result := public.register_deterministic_identity_document_proposal(
    v_admin, v_org, v_person, v_attachment, 'nzta_mvr_record', repeat('7', 64),
    jsonb_build_object(
      'display_name', 'Example Registered Person',
      'plate_number', 'TEST123',
      'query_completed_at', '2026-10-10T10:00:00+13:00',
      'vehicle_make', 'Example',
      'vehicle_model', 'Model'
    ),
    NULL, NULL, 0
  );
  v_document := (v_result->>'identity_document_id')::uuid;

  PERFORM pg_temp.as_user(v_admin);
  BEGIN
    PERFORM public.review_nzta_mvr_identity_evidence(
      v_document, 'approve',
      jsonb_build_object(
        'display_name', 'Example Registered Person',
        'plate_number', 'TEST123',
        'query_completed_at', '2026-10-10T10:00:00+13:00',
        'person_vehicle_match_confirmed', false
      ),
      'Source compared'
    );
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.check(
    'approval fails closed until the reviewer confirms the person-vehicle link',
    v_error LIKE '%Confirm that the private source image%'
  );

  v_result := public.review_nzta_mvr_identity_evidence(
    v_document, 'approve',
    jsonb_build_object(
      'display_name', 'Example Registered Person',
      'plate_number', 'TEST123',
      'query_completed_at', '2026-10-10T10:00:00+13:00',
      'person_vehicle_match_confirmed', true,
      'vehicle_year', '2020',
      'vehicle_make', 'Example',
      'vehicle_model', 'Model',
      'vehicle_colour', 'Silver',
      'vehicle_body_type', 'Passenger Car',
      'fuel_type', 'Petrol',
      'registration_status', 'Active',
      'rego_expiry', '2027-09-28',
      'wof_expiry', '2026-12-23',
      'vin', 'TESTVIN123456789',
      'chassis_number', 'TEST-CHASSIS',
      'engine_number', 'TEST-ENGINE'
    ),
    'Compared every promoted field with the private NZTA source image'
  );
  v_vehicle := (v_result->>'canonical_vehicle_id')::uuid;

  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check(
    'approval creates one evidence-linked source-time check',
    (SELECT count(*) = 1
     FROM public.vehicle_identity_checks
     WHERE identity_document_id = v_document
       AND canonical_vehicle_id = v_vehicle
       AND person_record_id = v_person
       AND evidence_item_id IS NOT NULL)
  );
  PERFORM pg_temp.check(
    'canonical vehicle records the completed NZTA check and reviewed facts',
    (SELECT compliance_source = 'nzta_mvr'
       AND compliance_checked_at = '2026-10-10T10:00:00+13:00'::timestamptz
       AND vin = 'TESTVIN123456789'
       AND rego_status = 'current'
     FROM public.canonical_vehicles WHERE id = v_vehicle)
  );
  PERFORM pg_temp.check(
    'canonical and tenant person records become verified with NZTA provenance',
    (SELECT record.review_state = 'verified'
       AND (record.metadata->'profile_details'->>'nzta_mvr_sourced')::boolean
       AND person.review_state = 'verified'
     FROM public.person_records record
     JOIN public.canonical_person_links link
       ON link.source_table = 'person_records' AND link.source_id = record.id
     JOIN public.canonical_people person ON person.id = link.canonical_person_id
     WHERE record.id = v_person)
  );

  PERFORM pg_temp.as_user(v_admin);
  PERFORM pg_temp.check(
    'administrator vehicle view returns the linked person and private source path',
    EXISTS (
      SELECT 1 FROM public.get_vehicle_identity_checks(v_org, v_vehicle) check_row
      WHERE check_row.person_record_id = v_person
        AND check_row.storage_bucket = 'identity-evidence'
        AND check_row.storage_path LIKE '%nzta-source.png'
    )
  );
END $$;

ROLLBACK;
