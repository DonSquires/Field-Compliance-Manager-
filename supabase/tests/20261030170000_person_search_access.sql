BEGIN;
SET LOCAL ROLE postgres;

DO $test$
DECLARE
  v_org uuid := gen_random_uuid();
  v_other_org uuid := gen_random_uuid();
  v_user uuid := gen_random_uuid();
  v_person uuid := gen_random_uuid();
  v_other_person uuid := gen_random_uuid();
  v_vehicle uuid := gen_random_uuid();
  v_notice uuid := gen_random_uuid();
  v_name text := 'PersonSearchFixture' || replace(gen_random_uuid()::text, '-', '');
  v_result jsonb;
  v_days integer;
  v_denied boolean;
BEGIN
  INSERT INTO public.organizations(id, name, organization_type)
  VALUES (v_org, 'Person search isolated fixture', 'service_provider'),
    (v_other_org, 'Person search out-of-scope fixture', 'service_provider');
  INSERT INTO auth.users(id, instance_id, aud, role, email)
  VALUES (v_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    'person-search-' || v_user::text || '@example.invalid');
  INSERT INTO public.user_profiles(id, organization_id, role)
  VALUES (v_user, v_org, 'admin_officer');
  INSERT INTO public.canonical_people(id, canonical_key, normalized_name, display_name)
  VALUES (v_person, v_person::text, lower(v_name), v_name),
    (v_other_person, v_other_person::text, lower(v_name), v_name);
  INSERT INTO public.canonical_person_links(canonical_person_id, source_table, source_id, organization_id)
  VALUES (v_person, 'person_records', gen_random_uuid(), v_org),
    (v_other_person, 'person_records', gen_random_uuid(), v_other_org);
  INSERT INTO public.canonical_vehicles(id, plate_number)
  VALUES (v_vehicle, upper(left(replace(gen_random_uuid()::text, '-', ''), 8)));
  INSERT INTO public.entity_links(organization_id, from_type, from_id, to_type, to_id, relationship)
  SELECT v_org, 'person', v_person, 'vehicle', v_vehicle, relationship
  FROM unnest(ARRAY['owner', 'registered_owner', 'driver', 'associated_person', 'occupant']) relationship;
  INSERT INTO public.entity_links(organization_id, from_type, from_id, to_type, to_id, relationship)
  VALUES (v_other_org, 'person', v_person, 'vehicle', v_vehicle, 'owner');
  INSERT INTO public.notices(id, organization_id, person_id, notice_type, status, issued_at, expires_at)
  VALUES (v_notice, v_org, v_person, 'warning', 'issued', clock_timestamp(),
    (((clock_timestamp() AT TIME ZONE 'Pacific/Auckland')::date + 1) + time '00:30')
      AT TIME ZONE 'Pacific/Auckland');

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_result := public.search_people(v_name);
  IF jsonb_array_length(v_result) <> 1
    OR (v_result->0->>'canonical_person_id')::uuid <> v_person
    OR (v_result->0->>'nzta_authorised')::boolean
    OR jsonb_array_length(v_result->0->'vehicles') <> 1
    OR v_result->0->'vehicles'->0->>'relationship' <> 'occupant' THEN
    RAISE EXCEPTION 'Person search leaked protected relationships or another organisation';
  END IF;

  SET LOCAL ROLE postgres;
  UPDATE public.user_profiles SET role = 'admin' WHERE id = v_user;
  SET LOCAL ROLE authenticated;
  v_result := public.search_people(v_name);
  IF NOT (v_result->0->>'nzta_authorised')::boolean
    OR jsonb_array_length(v_result->0->'vehicles') <> 5 THEN
    RAISE EXCEPTION 'Authorised identity access lost in-scope links or exposed out-of-scope links';
  END IF;
  SET LOCAL TIME ZONE 'UTC';
  SELECT days_remaining INTO v_days FROM public.get_notice_expiry_register() WHERE notice_id = v_notice;
  IF v_days IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'UTC session returned incorrect Auckland expiry days'; END IF;
  SET LOCAL TIME ZONE 'Pacific/Auckland';
  SELECT days_remaining INTO v_days FROM public.get_notice_expiry_register() WHERE notice_id = v_notice;
  IF v_days IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'Auckland session returned incorrect expiry days'; END IF;

  SET LOCAL ROLE postgres;
  UPDATE public.user_profiles SET role = 'officer' WHERE id = v_user;
  SET LOCAL ROLE authenticated;
  v_denied := false;
  BEGIN
    PERFORM public.search_people(v_name);
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Active operations role required' THEN RAISE; END IF;
    v_denied := true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Officer could call person search'; END IF;
  v_denied := false;
  BEGIN
    PERFORM public.get_notice_expiry_register();
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Active operations role required' THEN RAISE; END IF;
    v_denied := true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Officer could call notice expiry register'; END IF;

  SET LOCAL ROLE postgres;
  UPDATE public.user_profiles SET role = 'admin', deactivated_at = clock_timestamp() WHERE id = v_user;
  SET LOCAL ROLE authenticated;
  v_denied := false;
  BEGIN
    PERFORM public.search_people(v_name);
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Active operations role required' THEN RAISE; END IF;
    v_denied := true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Deactivated administrator could call person search'; END IF;
END;
$test$;

SELECT true AS person_search_access_passed;
ROLLBACK;
