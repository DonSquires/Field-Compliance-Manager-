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

CREATE OR REPLACE FUNCTION pg_temp.import_on_plate(
  p_client uuid, p_plate text, p_subject text, p_key text, p_hash_char text
) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  RETURN public.import_person_notice(
    p_organization_id => p_client,
    p_notice_type => 'warning',
    p_status => 'issued',
    p_issued_at => '2025-01-01T09:00:00+13:00',
    p_subject_display_name => p_subject,
    p_source_document_name => 'Given-name fixture ' || p_key,
    p_source_reference => 'local://fixture/given-name/' || p_key,
    p_source_sha256 => repeat(p_hash_char, 64),
    p_import_key => 'notice-given-name-test:' || p_key,
    p_plate_number => p_plate,
    p_issued_date_basis => 'register'
  );
END $$;

CREATE OR REPLACE FUNCTION pg_temp.make_owner(
  p_admin uuid, p_org uuid, p_conversation uuid, p_name text, p_plate text, p_suffix text
) RETURNS uuid LANGUAGE plpgsql AS $fn$
DECLARE
  v_record uuid := gen_random_uuid();
  v_attachment uuid := gen_random_uuid();
  v_document uuid;
  v_person uuid;
BEGIN
  PERFORM pg_temp.as_admin();
  INSERT INTO public.person_records(id, organization_id, display_name, review_state, metadata)
  VALUES (v_record, p_org, p_name, 'manual_review_required', '{}'::jsonb);
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
    p_admin, p_org, v_record, v_attachment, 'nzta_mvr_record',
    md5(p_suffix) || md5(p_suffix || '-source'),
    jsonb_build_object('display_name', p_name, 'plate_number', p_plate)
  )->>'identity_document_id')::uuid;
  PERFORM pg_temp.as_user(p_admin);
  PERFORM public.review_nzta_mvr_owner_evidence(
    v_document,
    jsonb_build_object('display_name', p_name, 'plate_number', p_plate,
      'query_completed_at', '2024-01-01T10:00:00+13:00', 'person_vehicle_match_confirmed', true),
    'Source image reviewed for given-name notice matching'
  );
  PERFORM pg_temp.as_admin();
  SELECT canonical_person_id INTO v_person
  FROM public.vehicle_identity_checks WHERE identity_document_id = v_document;
  PERFORM pg_temp.as_user(p_admin);
  RETURN v_person;
END $fn$;

DO $$
DECLARE
  v_provider uuid := gen_random_uuid();
  v_client uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid();
  v_conversation uuid := gen_random_uuid();
  v_stem text;
  v_plate text;
  v_owner uuid;
  v_hyphen_owner uuid;
  v_repeat_owner uuid;
  v_initial_owner uuid;
  v_apostrophe_owner uuid;
  v_result jsonb;
  v_family_member uuid;
BEGIN
  v_stem := upper(substr(replace(v_provider::text, '-', ''), 1, 5));
  v_plate := 'G' || v_stem;
  INSERT INTO public.organizations(id, name, organization_type, parent_organization_id)
  VALUES (v_provider, 'Given-name test provider', 'service_provider', NULL),
    (v_client, 'Given-name test client', 'private_enterprise', v_provider);
  INSERT INTO public.user_profiles(id, organization_id, role, display_name)
  VALUES (v_admin, v_provider, 'admin', 'Given-name test reviewer');
  INSERT INTO public.service_agreements(
    id, provider_organization_id, client_organization_id, name, starts_on,
    agreement_type, invitation_status
  ) VALUES (
    gen_random_uuid(), v_provider, v_client, 'Given-name notice test',
    current_date - 30, 'operational', 'accepted'
  );
  INSERT INTO public.bob_conversations(id, organization_id, user_id, module_key, title)
  VALUES (v_conversation, v_provider, v_admin, 'operations', 'Given-name notice test');

  v_owner := pg_temp.make_owner(v_admin, v_provider, v_conversation, 'Mira Alder', v_plate, 'owner-alder');
  v_hyphen_owner := pg_temp.make_owner(v_admin, v_provider, v_conversation, 'Mira Smith-Jones', 'H' || v_stem, 'owner-hyphen');
  v_repeat_owner := pg_temp.make_owner(v_admin, v_provider, v_conversation, 'Andrew Thomas', 'J' || v_stem, 'owner-repeat');
  v_initial_owner := pg_temp.make_owner(v_admin, v_provider, v_conversation, 'M Birch', 'K' || v_stem, 'owner-initial');
  v_apostrophe_owner := pg_temp.make_owner(v_admin, v_provider, v_conversation, 'Mira O''Connor', 'L' || v_stem, 'owner-apostrophe');
  PERFORM pg_temp.check(
    'owner reviews resolved five distinct registered people',
    (SELECT count(DISTINCT person) FROM unnest(ARRAY[v_owner, v_hyphen_owner, v_repeat_owner, v_initial_owner, v_apostrophe_owner]) AS person) = 5
  );

  v_result := pg_temp.import_on_plate(v_client, v_plate, 'Rowan Alder', 'different-given', '1');
  v_family_member := (v_result->>'canonical_person_id')::uuid;
  PERFORM pg_temp.check(
    'a different given name with the owner''s surname on the same plate is not the owner',
    v_result->>'match_basis' = 'created_from_notice' AND v_family_member <> v_owner
  );

  v_result := pg_temp.import_on_plate(v_client, v_plate, 'Rowan Alder', 'different-given-again', '2');
  PERFORM pg_temp.check(
    'a second notice for the family member joins that person by exact name, not the owner',
    v_result->>'match_basis' = 'exact_name' AND (v_result->>'canonical_person_id')::uuid = v_family_member
  );

  v_result := pg_temp.import_on_plate(v_client, v_plate, 'Mila Alder', 'spelling-variant', '3');
  PERFORM pg_temp.check(
    'a near-spelling of the owner''s given name is recorded under the name on the notice',
    v_result->>'match_basis' = 'created_from_notice'
      AND (v_result->>'canonical_person_id')::uuid NOT IN (v_owner, v_family_member)
  );

  v_result := pg_temp.import_on_plate(v_client, 'H' || v_stem, 'Rowan Smith-Jones', 'hyphen-different-given', '8');
  PERFORM pg_temp.check(
    'a hyphenated family name does not leave a shared part that passes as a given name',
    v_result->>'match_basis' = 'created_from_notice'
      AND (v_result->>'canonical_person_id')::uuid <> v_hyphen_owner
  );

  v_result := pg_temp.import_on_plate(v_client, 'J' || v_stem, 'Thomas Thomas', 'repeated-name', '9');
  PERFORM pg_temp.check(
    'a given name repeated as the family name is kept and does not match a different owner',
    v_result->>'match_basis' = 'created_from_notice'
      AND (v_result->>'canonical_person_id')::uuid <> v_repeat_owner
  );

  v_result := pg_temp.import_on_plate(v_client, 'K' || v_stem, 'Milo Birch', 'owner-initial-only', 'a');
  PERFORM pg_temp.check(
    'an owner recorded only by initial does not claim a full given name on the notice',
    v_result->>'match_basis' = 'created_from_notice'
      AND (v_result->>'canonical_person_id')::uuid <> v_initial_owner
  );

  v_result := pg_temp.import_on_plate(v_client, 'L' || v_stem, 'Owen O''Connor', 'apostrophe-different-given', 'b');
  PERFORM pg_temp.check(
    'an apostrophe family name does not leave a stray initial that matches the owner',
    v_result->>'match_basis' = 'created_from_notice'
      AND (v_result->>'canonical_person_id')::uuid <> v_apostrophe_owner
  );

  v_result := pg_temp.import_on_plate(v_client, v_plate, 'Mrs Mira Alder', 'same-given-title', '4');
  PERFORM pg_temp.check(
    'the same given name behind a title still resolves the registered owner',
    v_result->>'match_basis' = 'vehicle_registered_owner_at_notice'
      AND (v_result->>'canonical_person_id')::uuid = v_owner
  );

  v_result := pg_temp.import_on_plate(v_client, v_plate, 'M Alder', 'initial', '5');
  PERFORM pg_temp.check(
    'an initial agreeing with the owner''s given name resolves the registered owner',
    v_result->>'match_basis' = 'vehicle_registered_owner_at_notice'
      AND (v_result->>'canonical_person_id')::uuid = v_owner
  );

  v_result := pg_temp.import_on_plate(v_client, v_plate, 'Mr Alder', 'surname-only', '6');
  PERFORM pg_temp.check(
    'a notice naming only the surname still resolves the registered owner',
    v_result->>'match_basis' = 'vehicle_registered_owner_at_notice'
      AND (v_result->>'canonical_person_id')::uuid = v_owner
  );

  v_result := pg_temp.import_on_plate(v_client, v_plate, 'Mirabel Alder', 'prefix', '7');
  PERFORM pg_temp.check(
    'a given name sharing a 3+ letter prefix with the owner''s resolves the registered owner',
    v_result->>'match_basis' = 'vehicle_registered_owner_at_notice'
      AND (v_result->>'canonical_person_id')::uuid = v_owner
  );

  v_result := pg_temp.import_on_plate(v_client, 'H' || v_stem, 'Mira Smith-Jones', 'hyphen-same-given', 'c');
  PERFORM pg_temp.check(
    'the same given name with a hyphenated family name resolves the registered owner',
    v_result->>'match_basis' = 'vehicle_registered_owner_at_notice'
      AND (v_result->>'canonical_person_id')::uuid = v_hyphen_owner
  );

  v_result := pg_temp.import_on_plate(v_client, 'L' || v_stem, 'O''Connor M', 'apostrophe-family-first', 'd');
  PERFORM pg_temp.check(
    'a family-name-first notice with an agreeing initial resolves the registered owner',
    v_result->>'match_basis' = 'vehicle_registered_owner_at_notice'
      AND (v_result->>'canonical_person_id')::uuid = v_apostrophe_owner
  );
END $$;

SELECT true AS notice_owner_match_given_name_passed;
ROLLBACK;
