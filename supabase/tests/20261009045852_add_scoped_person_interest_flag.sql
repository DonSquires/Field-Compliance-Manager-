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
  v_rnm_org uuid := 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13';
  v_other_org uuid := gen_random_uuid();
  v_rnm_admin uuid := gen_random_uuid();
  v_other_admin uuid := gen_random_uuid();
  v_rnm_person_record uuid := gen_random_uuid();
  v_rnm_canonical_person uuid := gen_random_uuid();
  v_draft_person_record uuid := gen_random_uuid();
  v_draft_canonical_person uuid := gen_random_uuid();
  v_request_id uuid := gen_random_uuid();
  v_flag public.entity_flags%rowtype;
  v_replay public.entity_flags%rowtype;
  v_count integer;
  v_error text;
BEGIN
  INSERT INTO public.organizations (id, name, organization_type)
  VALUES (v_rnm_org, 'R&M POI Test Root', 'service_provider')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.organizations (id, name, organization_type)
  VALUES (v_other_org, 'Unrelated POI Test Org', 'service_provider');
  INSERT INTO public.user_profiles (id, organization_id, employer_organization_id, role, display_name)
  VALUES
    (v_rnm_admin, v_rnm_org, v_rnm_org, 'admin', 'POI Test Admin'),
    (v_other_admin, v_other_org, v_other_org, 'admin', 'Other Org Admin');

  INSERT INTO public.person_records (id, organization_id, display_name, review_state)
  VALUES
    (v_rnm_person_record, v_rnm_org, 'Verified POI Fixture', 'verified'),
    (v_draft_person_record, v_rnm_org, 'Draft POI Fixture', 'manual_review_required');
  INSERT INTO public.canonical_people (id, canonical_key, display_name, normalized_name, review_state, status)
  VALUES
    (v_rnm_canonical_person, 'poi-test-' || v_rnm_canonical_person::text, 'Verified POI Fixture', 'verifiedpoifixture', 'verified', 'active'),
    (v_draft_canonical_person, 'poi-test-' || v_draft_canonical_person::text, 'Draft POI Fixture', 'draftpoifixture', 'draft', 'active');
  INSERT INTO public.canonical_person_links (canonical_person_id, source_table, source_id, organization_id)
  VALUES
    (v_rnm_canonical_person, 'person_records', v_rnm_person_record, v_rnm_org),
    (v_draft_canonical_person, 'person_records', v_draft_person_record, v_rnm_org);

  PERFORM pg_temp.as_user(v_rnm_admin);
  v_flag := public.raise_scoped_person_interest_flag(
    v_rnm_org, v_request_id, v_rnm_canonical_person, 'medium', 'Supported test identification basis'
  );
  PERFORM pg_temp.check('R&M administrator raises an organization-scoped flag on a verified identity',
    v_flag.organization_id = v_rnm_org AND v_flag.entity_type = 'person'
      AND v_flag.entity_id = v_rnm_canonical_person AND v_flag.flag_type = 'poi'
      AND v_flag.active AND v_flag.hazard_class IS NULL);

  v_replay := public.raise_scoped_person_interest_flag(
    v_rnm_org, v_request_id, v_rnm_canonical_person, 'medium', 'Supported test identification basis'
  );
  SELECT count(*) INTO v_count FROM public.entity_flags
  WHERE organization_id = v_rnm_org AND entity_id = v_rnm_canonical_person
    AND flag_type = 'poi' AND active AND hazard_class IS NULL;
  PERFORM pg_temp.check('same request ID replays the same flag without failing or duplicating',
    v_replay.id = v_flag.id AND v_count = 1);

  BEGIN
    PERFORM public.raise_scoped_person_interest_flag(
      v_rnm_org, gen_random_uuid(), v_rnm_canonical_person, 'medium', 'Second active POI flag'
    );
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.check('a second active POI flag is rejected', v_error LIKE '%already exists%');

  BEGIN
    PERFORM public.raise_scoped_person_interest_flag(
      v_rnm_org, gen_random_uuid(), v_draft_canonical_person, 'medium', 'Unverified identity basis'
    );
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.check('an unverified person projection cannot receive a POI flag', v_error LIKE '%verified person record%');

  PERFORM pg_temp.as_user(v_other_admin);
  BEGIN
    PERFORM public.raise_scoped_person_interest_flag(
      v_other_org, gen_random_uuid(), v_rnm_canonical_person, 'medium', 'Out of scope test basis'
    );
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.check('an unrelated organization administrator cannot flag an R&M identity',
    v_error LIKE '%administrator access to this organization%');

  PERFORM pg_temp.as_admin();
  SELECT count(*) INTO v_count FROM public.audit_log
  WHERE organization_id = v_rnm_org AND target_table = 'entity_flags'
    AND target_id = v_flag.id AND action = 'entity_flag_raised';
  PERFORM pg_temp.check('raising the flag creates exactly one audit event', v_count = 1);
END $$;

ROLLBACK;