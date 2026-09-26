-- Behavioural checks for the governed Identity Records workspace.
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
  RAISE NOTICE 'ok   [%]', p_label;
END $$;

DO $$
DECLARE
  v_org uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid();
  v_officer uuid := gen_random_uuid();
  v_person uuid := gen_random_uuid();
  v_photo_person uuid := gen_random_uuid();
  v_conversation uuid := gen_random_uuid();
  v_attachment uuid := gen_random_uuid();
  v_photo_attachment uuid := gen_random_uuid();
  v_document uuid;
  v_photo_document uuid;
  v_result jsonb;
  v_count integer;
  v_error text;
  v_embedding jsonb := to_jsonb(array_fill(0.125::real, ARRAY[128]));
BEGIN
  INSERT INTO public.organizations (id, name, organization_type) VALUES (v_org, 'T_IDENTITY_ORG', 'service_provider');
  INSERT INTO public.user_profiles (id, organization_id, role, display_name)
  VALUES (v_admin, v_org, 'admin', 'IdentityAdmin'), (v_officer, v_org, 'officer', 'IdentityOfficer');
  INSERT INTO public.person_records (id, organization_id, display_name, review_state, metadata)
  VALUES (v_person, v_org, 'Identity Fixture', 'manual_review_required', '{}'::jsonb),
         (v_photo_person, v_org, 'Photo Fixture', 'manual_review_required', '{}'::jsonb);
  INSERT INTO public.bob_conversations (id, organization_id, user_id, module_key, title)
  VALUES (v_conversation, v_org, v_admin, 'operations', 'Identity fixture');
  INSERT INTO public.bob_attachments (id, organization_id, conversation_id, uploaded_by, file_name, file_type, file_size_bytes, storage_bucket, storage_path, purpose, processing_state)
  VALUES
    (v_attachment, v_org, v_conversation, v_admin, 'licence.png', 'image/png', 10, 'identity-evidence', 'org/' || v_org || '/identity/' || v_admin || '/identity-licence.png', 'identity_document', 'processing'),
    (v_photo_attachment, v_org, v_conversation, v_admin, 'person.png', 'image/png', 10, 'identity-evidence', 'org/' || v_org || '/identity/' || v_admin || '/identity-person.png', 'identity_document', 'processing');

  PERFORM pg_temp.as_user(v_officer);
  SELECT count(*) INTO v_count FROM public.bob_attachments WHERE id IN (v_attachment, v_photo_attachment);
  PERFORM pg_temp.check('ordinary organization members cannot discover identity attachments', v_count = 0);
  BEGIN
    PERFORM metadata FROM public.face_observations LIMIT 1;
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.check('browser roles cannot read face-observation metadata', v_error LIKE '%permission denied%');
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('legacy person metadata no longer contains face vectors', NOT EXISTS (
    SELECT 1 FROM public.person_records WHERE metadata #> '{face_reference,embedding}' IS NOT NULL));

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin::text, 'role', 'authenticated')::text, true);
  v_result := public.register_identity_document_proposal(v_admin, v_org, v_person, v_attachment, 'driver_licence', repeat('0', 64),
    '{"display_name":"Proposed Name","driver_licence_number":"AB123456"}'::jsonb, v_embedding, 0.91, 1);
  v_document := (v_result->>'identity_document_id')::uuid;
  PERFORM pg_temp.check('valid source face is held as a private proposal', (v_result->>'face_candidate_pending')::boolean
    AND EXISTS (SELECT 1 FROM public.person_identity_face_proposals WHERE identity_document_id = v_document));
  PERFORM pg_temp.check('pending face is absent from the active observation corpus', NOT EXISTS (
    SELECT 1 FROM public.face_observations WHERE metadata->>'identity_document_id' = v_document::text));

  PERFORM pg_temp.as_user(v_admin);
  BEGIN
    PERFORM public.register_identity_document_proposal(v_admin, v_org, v_person, v_attachment, 'driver_licence', repeat('0', 64), '{}'::jsonb, v_embedding, 0.91, 1);
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.check('browser roles cannot register supplied biometric vectors',
    v_error LIKE '%Service identity required%' OR v_error LIKE '%permission denied%');
  BEGIN
    PERFORM 1 FROM public.person_identity_face_proposals LIMIT 1;
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.check('browser roles cannot read pending vectors', v_error LIKE '%permission denied%');

  v_result := public.review_identity_evidence(v_document, 'approve',
    '{"display_name":"Approved Name","date_of_birth":"1990-05-04","driver_licence_number":"AB123456","driver_licence_expiry":"2030-02-01","embedding":[1,2,3]}'::jsonb,
    'Compared each approved field with the source');
  PERFORM pg_temp.check('strong identity evidence can verify a person', (v_result->>'identity_verified')::boolean);
  PERFORM pg_temp.check('one approved source face becomes a candidate', (v_result->>'face_candidate_enrolled')::boolean);
  PERFORM pg_temp.check('unapproved payload keys are not persisted', NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements((public.get_identity_registry(v_org, NULL, 10))->'documents') document
    WHERE document->>'id' = v_document::text AND document->'extracted_fields'->'approved' ? 'embedding'));
  SELECT count(*) INTO v_count FROM public.find_cctv_portfolio_matches(v_org, 'person', v_embedding, NULL, NULL, NULL, 10)
  WHERE basis = 'face_identity' AND person_record_id = v_person;
  PERFORM pg_temp.check('approved private template participates in matching', v_count = 1);
  BEGIN
    PERFORM public.review_identity_evidence(v_document, 'reject', '{}'::jsonb, 'Second transition');
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.check('review decisions are immutable', v_error LIKE '%already been reviewed%');

  PERFORM pg_temp.as_admin();
  v_result := public.register_identity_document_proposal(v_admin, v_org, v_photo_person, v_photo_attachment, 'person_photo', repeat('1', 64),
    '{"display_name":"Photo Fixture"}'::jsonb, NULL, NULL, 0);
  v_photo_document := (v_result->>'identity_document_id')::uuid;
  PERFORM pg_temp.as_user(v_admin);
  v_result := public.review_identity_evidence(v_photo_document, 'approve', '{"display_name":"Photo Fixture"}'::jsonb, 'Confirmed this is the supplied reference photo');
  PERFORM pg_temp.check('a reference photo does not verify legal identity', NOT (v_result->>'identity_verified')::boolean
    AND (SELECT review_state = 'manual_review_required' FROM public.person_records WHERE id = v_photo_person));

  PERFORM public.manage_identity_person_record(v_org, v_person, 'retire_faces', '{}'::jsonb, 'No continuing operational purpose');
  SELECT count(*) INTO v_count FROM public.find_cctv_portfolio_matches(v_org, 'person', v_embedding, NULL, NULL, NULL, 10)
  WHERE basis = 'face_identity' AND person_record_id = v_person;
  PERFORM pg_temp.check('retired face templates stop matching immediately', v_count = 0);
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('retirement physically removes the biometric template', NOT EXISTS (
    SELECT 1 FROM public.person_face_templates WHERE person_record_id = v_person));
END $$;

ROLLBACK;
