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
  v_person_id uuid;
  v_result jsonb;
  v_details jsonb;
  v_audit_count integer;
  v_error text;
BEGIN
  INSERT INTO public.organizations (id, name, organization_type)
  VALUES (v_org, 'Historical NZTA Provenance Test', 'service_provider');
  INSERT INTO public.user_profiles (id, organization_id, role, display_name)
  VALUES (v_admin, v_org, 'admin', 'Provenance Test Admin');

  PERFORM pg_temp.as_user(v_admin);
  v_result := public.manage_identity_person_record(
    v_org, NULL, 'create',
    jsonb_build_object('display_name', 'MVR Source Fixture', 'nzta_mvr_sourced', true),
    'Record historical MVR source'
  );
  v_person_id := (v_result->>'person_record_id')::uuid;
  SELECT metadata->'profile_details' INTO v_details
  FROM public.person_records WHERE id = v_person_id AND organization_id = v_org;
  PERFORM pg_temp.check('the checked source marker persists as a JSON boolean',
    jsonb_typeof(v_details->'nzta_mvr_sourced') = 'boolean'
      AND (v_details->>'nzta_mvr_sourced')::boolean);

  v_result := public.manage_identity_person_record(
    v_org, v_person_id, 'update',
    jsonb_build_object('display_name', 'MVR Source Fixture Updated'),
    'Update name without changing source provenance'
  );
  SELECT metadata->'profile_details' INTO v_details
  FROM public.person_records WHERE id = v_person_id AND organization_id = v_org;
  PERFORM pg_temp.check('an update that omits the marker preserves historical provenance',
    (v_details->>'nzta_mvr_sourced')::boolean);

  PERFORM public.manage_identity_person_record(
    v_org, v_person_id, 'update',
    jsonb_build_object('display_name', 'MVR Source Fixture Updated', 'nzta_mvr_sourced', false),
    'Correct historical source classification'
  );
  SELECT metadata->'profile_details' INTO v_details
  FROM public.person_records WHERE id = v_person_id AND organization_id = v_org;
  PERFORM pg_temp.check('an explicit unchecked value clears the source marker',
    jsonb_typeof(v_details->'nzta_mvr_sourced') = 'boolean'
      AND NOT (v_details->>'nzta_mvr_sourced')::boolean);

  BEGIN
    PERFORM public.manage_identity_person_record(
      v_org, v_person_id, 'update',
      jsonb_build_object('display_name', 'MVR Source Fixture Updated', 'nzta_mvr_sourced', 'true'),
      'Reject a non-boolean marker'
    );
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.check('the provenance marker accepts only a JSON boolean',
    v_error LIKE '%must be a boolean%');

  PERFORM pg_temp.as_user(v_admin);
  v_result := public.get_identity_registry(v_org, NULL, 10);
  PERFORM pg_temp.check('registry returns the source marker for the identity workspace',
    EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_result->'people') person
      WHERE person->>'person_record_id' = v_person_id::text
        AND jsonb_typeof(person->'profile_details'->'nzta_mvr_sourced') = 'boolean'
        AND NOT (person->'profile_details'->>'nzta_mvr_sourced')::boolean
    ));

  PERFORM pg_temp.as_admin();
  SELECT count(*) INTO v_audit_count FROM public.audit_log
  WHERE organization_id = v_org AND target_table = 'person_records'
    AND target_id = v_person_id AND action = 'identity_person_update'
    AND metadata->>'reason' = 'Correct historical source classification'
    AND metadata->'fields' @> '["nzta_mvr_sourced"]'::jsonb;
  PERFORM pg_temp.check('the field change reason and changed-field name are audited',
    v_audit_count = 1);
END $$;

ROLLBACK;