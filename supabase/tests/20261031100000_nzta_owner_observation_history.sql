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
  v_org uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid();
  v_officer uuid := gen_random_uuid();
  v_conversation uuid := gen_random_uuid();
  v_person_a uuid := gen_random_uuid();
  v_person_b uuid := gen_random_uuid();
  v_person_c uuid := gen_random_uuid();
  v_person_d uuid := gen_random_uuid();
  v_document_a uuid;
  v_document_b uuid;
  v_document_c uuid;
  v_document_b_repeat uuid;
  v_document_tie uuid;
  v_vehicle uuid;
  v_plate text;
  v_error text;
BEGIN
  v_plate := 'T' || upper(substr(replace(v_org::text, '-', ''), 1, 6));
  INSERT INTO public.organizations(id, name, organization_type)
  VALUES (v_org, 'NZTA owner history isolated fixture', 'service_provider');
  INSERT INTO public.user_profiles(id, organization_id, role, display_name)
  VALUES (v_admin, v_org, 'admin', 'NZTA history reviewer'),
    (v_officer, v_org, 'officer', 'NZTA history officer');
  INSERT INTO public.person_records(id, organization_id, display_name, review_state, metadata)
  VALUES (v_person_a, v_org, 'History Owner A ' || left(v_person_a::text, 8), 'manual_review_required', '{}'::jsonb),
    (v_person_b, v_org, 'History Owner B ' || left(v_person_b::text, 8), 'manual_review_required', '{}'::jsonb),
    (v_person_c, v_org, 'History Owner C ' || left(v_person_c::text, 8), 'manual_review_required', '{}'::jsonb),
    (v_person_d, v_org, 'History Owner D ' || left(v_person_d::text, 8), 'manual_review_required', '{}'::jsonb);
  INSERT INTO public.bob_conversations(id, organization_id, user_id, module_key, title)
  VALUES (v_conversation, v_org, v_admin, 'operations', 'NZTA owner history test');

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin::text, 'role', 'authenticated')::text, true);
  v_document_a := pg_temp.make_nzta_document(v_admin, v_org, v_conversation, v_person_a, 'fixture-a', v_plate);
  v_document_b := pg_temp.make_nzta_document(v_admin, v_org, v_conversation, v_person_b, 'fixture-b', v_plate);
  v_document_c := pg_temp.make_nzta_document(v_admin, v_org, v_conversation, v_person_c, 'fixture-c', v_plate);
  v_document_b_repeat := pg_temp.make_nzta_document(v_admin, v_org, v_conversation, v_person_b, 'fixture-b-repeat', v_plate);
  v_document_tie := pg_temp.make_nzta_document(v_admin, v_org, v_conversation, v_person_d, 'fixture-tie', v_plate);

  PERFORM pg_temp.as_user(v_admin);
  PERFORM public.review_nzta_mvr_owner_evidence(
    v_document_a,
    jsonb_build_object('display_name', 'History Owner A', 'plate_number', v_plate,
      'query_completed_at', '2025-01-01T10:00:00+13:00', 'person_vehicle_match_confirmed', true),
    'Consistent owner fields verified; mechanical facts remain pending'
  );
  PERFORM pg_temp.as_admin();
  SELECT id INTO v_vehicle FROM public.canonical_vehicles WHERE plate_number = v_plate;
  PERFORM pg_temp.check('first review creates the canonical vehicle', v_vehicle IS NOT NULL);
  PERFORM pg_temp.as_user(v_admin);
  PERFORM public.review_nzta_mvr_owner_evidence(
    v_document_b,
    jsonb_build_object('display_name', 'History Owner B', 'plate_number', v_plate,
      'query_completed_at', '2026-01-01T10:00:00+13:00', 'person_vehicle_match_confirmed', true),
    'Consistent owner fields verified; mechanical facts remain pending'
  );

  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check(
    'latest source-time check is the sole active registered owner',
    (SELECT count(*) = 1 FROM public.entity_links
     WHERE organization_id = v_org AND to_id = v_vehicle
       AND relationship = 'registered_owner' AND active
       AND from_id = public.ensure_canonical_person_for_record(v_person_b))
  );
  PERFORM pg_temp.check(
    'older owner is retained as a previous link with observation dates',
    (SELECT count(*) = 1 FROM public.entity_links
     WHERE organization_id = v_org AND to_id = v_vehicle
       AND relationship = 'registered_owner' AND NOT active
       AND from_id = public.ensure_canonical_person_for_record(v_person_a)
       AND starts_at = '2025-01-01T10:00:00+13:00'::timestamptz
       AND ends_at = '2026-01-01T10:00:00+13:00'::timestamptz
       AND evidence->>'basis' LIKE '%not legal transfer dates%')
  );
  PERFORM pg_temp.check(
    'conflicting vehicle facts remain pending instead of approving the whole document',
    (SELECT review_state = 'manual_review_required'
       AND extracted_fields->'owner_review'->>'vehicle_facts_pending' = 'true'
     FROM public.person_identity_documents WHERE id = v_document_a)
  );

  PERFORM pg_temp.as_user(v_admin);
  PERFORM public.review_nzta_mvr_owner_evidence(
    v_document_c,
    jsonb_build_object('display_name', 'History Owner C', 'plate_number', v_plate,
      'query_completed_at', '2024-01-01T10:00:00+13:00', 'person_vehicle_match_confirmed', true),
    'Late-arriving older check; mechanical facts remain pending'
  );
  PERFORM public.review_nzta_mvr_owner_evidence(
    v_document_b_repeat,
    jsonb_build_object('display_name', 'History Owner B', 'plate_number', v_plate,
      'query_completed_at', '2026-06-01T10:00:00+13:00', 'person_vehicle_match_confirmed', true),
    'Repeated check for the same registered person'
  );

  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check(
    'out-of-order arrival rebuilds three owner periods without duplicate current owner',
    (SELECT count(*) = 3 FROM public.entity_links
     WHERE organization_id = v_org AND to_id = v_vehicle
       AND relationship = 'registered_owner'
       AND NOT coalesce((evidence->>'superseded_by_reconciliation')::boolean, false))
    AND
    (SELECT count(*) = 1 FROM public.entity_links
     WHERE organization_id = v_org AND to_id = v_vehicle
       AND relationship = 'registered_owner' AND active
       AND from_id = public.ensure_canonical_person_for_record(v_person_b))
    AND
    (SELECT count(*) = 2 FROM public.entity_links
     WHERE organization_id = v_org AND to_id = v_vehicle
       AND relationship = 'registered_owner' AND NOT active
       AND NOT coalesce((evidence->>'superseded_by_reconciliation')::boolean, false))
  );
  PERFORM pg_temp.check(
    'same-person repeated checks remain in one episode',
    (SELECT jsonb_array_length(evidence->'nzta_owner_history_check_ids') = 2
     FROM public.entity_links
     WHERE organization_id = v_org AND to_id = v_vehicle
       AND relationship = 'registered_owner' AND active)
  );

  PERFORM pg_temp.as_user(v_admin);
  BEGIN
    PERFORM public.review_nzta_mvr_owner_evidence(
      v_document_tie,
      jsonb_build_object('display_name', 'History Owner D', 'plate_number', v_plate,
        'query_completed_at', '2026-06-01T10:00:00+13:00', 'person_vehicle_match_confirmed', true),
      'Contradictory same-time owner check must be held'
    );
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN
    v_error := SQLERRM;
  END;
  PERFORM pg_temp.check(
    'equal-time contradictory owners are refused and remain pending',
    v_error LIKE 'Conflicting owners share an NZTA check timestamp%'
      AND (SELECT review_state = 'manual_review_required'
           FROM public.person_identity_documents WHERE id = v_document_tie)
  );

  PERFORM pg_temp.as_user(v_officer);
  v_error := NULL;
  BEGIN
    PERFORM public.sync_nzta_registered_owner_history(v_org, v_vehicle);
  EXCEPTION WHEN OTHERS THEN
    v_error := SQLERRM;
  END;
  PERFORM pg_temp.check(
    'non-administrator cannot synchronize protected owner identity',
    v_error = 'Vehicle owner identity administrator access required'
  );
END $$;

SELECT true AS nzta_owner_observation_history_passed;
ROLLBACK;
