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

-- schema.sql is schema-only; carry the reference row from 20261010204538 so the oracle runs on a bare snapshot.
INSERT INTO public.identity_document_type_definitions (
  document_kind, display_name, category, canonical_destination,
  staff_credential_type, default_authorized_activities, strong_identity,
  supports_face_enrollment, extraction_rules, display_order
) VALUES (
  'nzta_mvr_record', 'NZTA Motor Vehicle Register query result', 'identity', 'person_records',
  NULL, '{}', true, false,
  '{"indicators":["current details query results","current registered person details","vehicle details","registration details"],
    "required_review_fields":["display_name","plate_number","query_completed_at","person_vehicle_match_confirmed"],
    "authority":"NZTA Motor Vehicle Register","source_time_only":true}'::jsonb,
  35
) ON CONFLICT (document_kind) DO NOTHING;

CREATE OR REPLACE FUNCTION pg_temp.reviewed_nzta_check(
  p_admin uuid, p_org uuid, p_conversation uuid, p_person uuid, p_suffix text, p_plate text, p_name text, p_checked_at text
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_attachment uuid := gen_random_uuid();
  v_document uuid;
BEGIN
  PERFORM pg_temp.as_admin();
  INSERT INTO public.bob_attachments(
    id, organization_id, conversation_id, uploaded_by, file_name, file_type,
    file_size_bytes, storage_bucket, storage_path, purpose, processing_state
  ) VALUES (
    v_attachment, p_org, p_conversation, p_admin, 'nzta-' || p_suffix || '.png', 'image/png', 10,
    'identity-evidence', 'org/' || p_org || '/identity/' || p_admin || '/' || p_suffix || '.png',
    'identity_document', 'processing'
  );
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_admin::text, 'role', 'authenticated')::text, true);
  v_document := (public.register_deterministic_identity_document_proposal(
    p_admin, p_org, p_person, v_attachment, 'nzta_mvr_record', md5(p_suffix) || md5(p_suffix || '-source'),
    jsonb_build_object('display_name', p_name, 'plate_number', p_plate)
  )->>'identity_document_id')::uuid;
  PERFORM pg_temp.as_user(p_admin);
  PERFORM public.review_nzta_mvr_owner_evidence(v_document,
    jsonb_build_object('display_name', p_name, 'plate_number', p_plate, 'query_completed_at', p_checked_at,
      'person_vehicle_match_confirmed', true),
    'Consistent owner fields verified; mechanical facts remain pending');
  PERFORM pg_temp.as_admin();
END $$;

DO $$
DECLARE
  v_org uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid();
  v_conversation uuid := gen_random_uuid();
  v_source uuid := gen_random_uuid();
  v_target uuid := gen_random_uuid();
  v_source_canonical uuid;
  v_target_canonical uuid;
  v_only_plate text;
  v_shared_plate text;
  v_only_vehicle uuid;
  v_shared_vehicle uuid;
  v_result jsonb;
BEGIN
  v_only_plate := 'M' || upper(substr(replace(v_org::text, '-', ''), 1, 5));
  v_shared_plate := 'N' || upper(substr(replace(v_org::text, '-', ''), 1, 5));
  INSERT INTO public.organizations(id, name, organization_type)
  VALUES (v_org, 'Merge owner checks isolated fixture', 'service_provider');
  INSERT INTO public.user_profiles(id, organization_id, role, display_name)
  VALUES (v_admin, v_org, 'admin', 'Merge reviewer');
  -- One owner split across two seed records, the defect the NZTA name repair merges.
  INSERT INTO public.person_records(id, organization_id, display_name, review_state, metadata)
  VALUES (v_source, v_org, 'Merge Owner ' || left(v_org::text, 8), 'manual_review_required', '{}'::jsonb),
    (v_target, v_org, 'Merge Owner ' || left(v_org::text, 8), 'manual_review_required', '{}'::jsonb);
  INSERT INTO public.bob_conversations(id, organization_id, user_id, module_key, title)
  VALUES (v_conversation, v_org, v_admin, 'operations', 'Merge owner checks test');

  PERFORM pg_temp.reviewed_nzta_check(v_admin, v_org, v_conversation, v_source, 'merge-only', v_only_plate, 'Merge Owner', '2025-01-01T10:00:00+13:00');
  PERFORM pg_temp.reviewed_nzta_check(v_admin, v_org, v_conversation, v_source, 'merge-shared-old', v_shared_plate, 'Merge Owner', '2025-03-01T10:00:00+13:00');
  PERFORM pg_temp.reviewed_nzta_check(v_admin, v_org, v_conversation, v_target, 'merge-shared-new', v_shared_plate, 'Merge Owner', '2026-03-01T10:00:00+13:00');

  SELECT id INTO v_only_vehicle FROM public.canonical_vehicles WHERE plate_number = v_only_plate;
  SELECT id INTO v_shared_vehicle FROM public.canonical_vehicles WHERE plate_number = v_shared_plate;
  v_source_canonical := public.ensure_canonical_person_for_record(v_source);
  v_target_canonical := public.ensure_canonical_person_for_record(v_target);
  PERFORM pg_temp.check('fixture: the two records are separate canonical people', v_source_canonical <> v_target_canonical);
  PERFORM pg_temp.as_user(v_admin);
  PERFORM pg_temp.check('fixture: before the merge the split person is both current and previous owner of the shared vehicle',
    (SELECT count(*) = 2 FROM public.get_vehicle_owner_links(v_org, v_shared_vehicle)));
  PERFORM pg_temp.as_admin();

  PERFORM pg_temp.as_user(v_admin);
  v_result := public.merge_person_records(v_org, v_source, v_target, 'Same NZTA owner split by the seed defect', NULL);
  PERFORM pg_temp.as_admin();

  PERFORM pg_temp.check('merge reports both moved NZTA owner checks',
    (v_result->'moved'->>'vehicle_owner_checks')::integer = 2);
  PERFORM pg_temp.check('no NZTA owner check still names the merged record or its canonical person',
    NOT EXISTS (SELECT 1 FROM public.vehicle_identity_checks
      WHERE organization_id = v_org AND (person_record_id = v_source OR canonical_person_id = v_source_canonical)));
  PERFORM pg_temp.check('every NZTA owner check now names the kept record and its canonical person',
    (SELECT count(*) = 3 FROM public.vehicle_identity_checks
      WHERE organization_id = v_org AND person_record_id = v_target AND canonical_person_id = v_target_canonical));

  PERFORM pg_temp.as_user(v_admin);
  PERFORM pg_temp.check('the merged record''s own vehicle shows the kept person as its single current owner',
    (SELECT count(*) = 1 FROM public.get_vehicle_owner_links(v_org, v_only_vehicle)
      WHERE active AND person_record_id = v_target));
  PERFORM pg_temp.check('the shared vehicle shows one owner period, not the same person as current and previous',
    (SELECT count(*) = 1 FROM public.get_vehicle_owner_links(v_org, v_shared_vehicle))
    AND (SELECT bool_and(active AND person_record_id = v_target) FROM public.get_vehicle_owner_links(v_org, v_shared_vehicle)));
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('the merged canonical person keeps no active vehicle owner link',
    NOT EXISTS (SELECT 1 FROM public.entity_links WHERE organization_id = v_org AND from_type = 'person'
      AND from_id = v_source_canonical AND relationship = 'registered_owner' AND active));
END $$;

SELECT true AS merge_moves_nzta_owner_checks_passed;
ROLLBACK;
