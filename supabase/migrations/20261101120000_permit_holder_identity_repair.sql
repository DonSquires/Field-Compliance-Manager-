-- Permit holder identity repair (owner ruling 2026-10-27).
--
-- The September 2026 booking-system import created every forest-permit holder as a canonical
-- person named and keyed by surname alone, so most holders carry only a surname and some records
-- combine different people who share one. OneFortyOne's permit extract names each holder in full
-- against a permit number, which proves who holds that permit. The owner ruled:
--   * complete a holder's name where the permit extract proves it;
--   * split a record that combines differently named holders, giving each holder their own record;
--   * a new permit whose application email and surname match exactly one existing holder is that
--     holder's permit, and that holder's name is completed from it;
--   * a new permit for a different full name under a shared email is a new person.
--
-- public.attribute_permit_holder attributes evidence permits to a full name. When they are all the
-- record's permits the record's name is completed in place; otherwise they move to a new record of
-- their own. It only ever adds given names in front of the recorded name, never renames a person
-- another organisation records, keeps the previous name on the person, and audits every change
-- without personal values. public.import_person_permit gains the email-and-surname rule and an
-- opt-in, governed creation of a new holder.

CREATE OR REPLACE FUNCTION public.person_name_extends(p_recorded text, p_full text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  WITH words AS (
    SELECT array_remove(regexp_split_to_array(lower(coalesce(p_recorded, '')), '[^a-z0-9]+'), '') AS recorded,
           array_remove(regexp_split_to_array(lower(coalesce(p_full, '')), '[^a-z0-9]+'), '') AS full_name
  )
  SELECT cardinality(recorded) > 0 AND cardinality(full_name) > cardinality(recorded)
    AND full_name[cardinality(full_name) - cardinality(recorded) + 1 : cardinality(full_name)] = recorded
  FROM words
$$;
COMMENT ON FUNCTION public.person_name_extends(text, text) IS
  'True when the recorded name''s words are the trailing words of a longer full name (Smith -> Jane Smith). Used to add proven given names to a surname-only person; never matches equal or unrelated names.';
REVOKE ALL ON FUNCTION public.person_name_extends(text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.person_name_extends(text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.attribute_permit_holder(
  p_organization_id uuid,
  p_canonical_person_id uuid,
  p_full_name text,
  p_permit_numbers text[],
  p_source_document text,
  p_source_sha256 text,
  p_with_same_email boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_name text := nullif(regexp_replace(trim(coalesce(p_full_name, '')), '\s+', ' ', 'g'), '');
  v_source text := nullif(trim(coalesce(p_source_document, '')), '');
  v_hash text := lower(nullif(trim(coalesce(p_source_sha256, '')), ''));
  v_person public.canonical_people%rowtype;
  v_evidence text[];
  v_numbers text[];
  v_held text[];
  v_missing integer;
  v_added integer;
  v_target uuid;
  v_outcome text;
  v_moved integer := 0;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_organization_id IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN
    RAISE EXCEPTION 'Administrator access to the permit organisation is required';
  END IF;
  IF v_source IS NULL THEN RAISE EXCEPTION 'The source document is required'; END IF;
  IF v_hash IS NULL OR v_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'A SHA-256 source hash is required'; END IF;
  IF cardinality(array_remove(regexp_split_to_array(lower(coalesce(v_name, '')), '[^a-z0-9]+'), '')) < 2 THEN
    RAISE EXCEPTION 'A full name of at least two words is required';
  END IF;
  v_evidence := array(
    SELECT DISTINCT cleaned.permit_number FROM (
      SELECT nullif(regexp_replace(trim(item), '\s+', ' ', 'g'), '') AS permit_number
      FROM unnest(coalesce(p_permit_numbers, '{}'::text[])) AS listed(item)
    ) cleaned
    WHERE cleaned.permit_number IS NOT NULL
    ORDER BY cleaned.permit_number
  );
  IF cardinality(v_evidence) = 0 THEN RAISE EXCEPTION 'At least one evidence permit is required'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('canonical-person:' || coalesce(p_canonical_person_id::text, ''), 0));
  SELECT * INTO v_person FROM public.canonical_people p WHERE p.id = p_canonical_person_id FOR UPDATE;
  IF v_person.id IS NULL OR v_person.status <> 'active' OR v_person.merged_into_id IS NOT NULL THEN
    RAISE EXCEPTION 'The permit holder must be an active, unmerged person';
  END IF;

  v_held := array(
    SELECT permit.permit_number FROM public.person_permits permit
    WHERE permit.organization_id = p_organization_id AND permit.canonical_person_id = v_person.id
    ORDER BY permit.permit_number
  );
  SELECT count(*) INTO v_missing FROM unnest(v_evidence) AS listed(permit_number) WHERE listed.permit_number <> ALL (v_held);
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'Permit holder conflict: % of the listed permits are not held by this person', v_missing;
  END IF;

  v_numbers := v_evidence;
  IF coalesce(p_with_same_email, false) THEN
    -- The record's other permits applied for under an evidence permit's email belong to the same holder.
    v_numbers := array(
      SELECT permit.permit_number FROM public.person_permits permit
      WHERE permit.organization_id = p_organization_id AND permit.canonical_person_id = v_person.id
        AND (permit.permit_number = ANY (v_evidence) OR lower(trim(permit.contact_email)) IN (
          SELECT lower(trim(evidence.contact_email)) FROM public.person_permits evidence
          WHERE evidence.organization_id = p_organization_id AND evidence.canonical_person_id = v_person.id
            AND evidence.permit_number = ANY (v_evidence) AND nullif(trim(evidence.contact_email), '') IS NOT NULL))
      ORDER BY permit.permit_number
    );
  END IF;

  IF public.normalize_person_name(v_person.display_name) = public.normalize_person_name(v_name) THEN
    IF cardinality(v_numbers) = cardinality(v_held) THEN
      RETURN jsonb_build_object('outcome', 'unchanged', 'canonical_person_id', v_person.id,
        'from_canonical_person_id', v_person.id, 'permits_attributed', cardinality(v_numbers),
        'permits_moved', 0, 'permits_remaining', cardinality(v_held));
    END IF;
    RAISE EXCEPTION 'Permit holder name conflict: the person already carries this name, so it cannot separate their permits';
  END IF;
  IF NOT public.person_name_extends(v_person.display_name, v_name) THEN
    RAISE EXCEPTION 'Permit holder name conflict: the full name must end with the recorded name';
  END IF;
  v_added := cardinality(array_remove(regexp_split_to_array(lower(v_name), '[^a-z0-9]+'), ''))
    - cardinality(array_remove(regexp_split_to_array(lower(coalesce(v_person.display_name, '')), '[^a-z0-9]+'), ''));

  IF cardinality(v_numbers) = cardinality(v_held) THEN
    IF EXISTS (SELECT 1 FROM public.person_permits permit
               WHERE permit.canonical_person_id = v_person.id AND permit.organization_id <> p_organization_id)
       OR EXISTS (SELECT 1 FROM public.canonical_person_links link
                  WHERE link.canonical_person_id = v_person.id AND link.organization_id IS DISTINCT FROM p_organization_id)
       OR EXISTS (SELECT 1 FROM public.notices notice
                  WHERE notice.person_id = v_person.id AND notice.organization_id IS DISTINCT FROM p_organization_id)
       OR EXISTS (SELECT 1 FROM public.entity_links link
                  WHERE ((link.from_type = 'person' AND link.from_id = v_person.id) OR (link.to_type = 'person' AND link.to_id = v_person.id))
                    AND link.organization_id IS DISTINCT FROM p_organization_id)
       OR EXISTS (SELECT 1 FROM public.vehicle_identity_checks identity_check
                  WHERE identity_check.canonical_person_id = v_person.id
                    AND identity_check.organization_id IS DISTINCT FROM p_organization_id) THEN
      RAISE EXCEPTION 'Permit holder is shared: another organisation records this person, so the name is not changed here';
    END IF;
    UPDATE public.canonical_people p SET
      display_name = v_name,
      normalized_name = public.normalize_person_name(v_name),
      metadata = p.metadata || jsonb_build_object('name_completed', jsonb_build_object(
        'previous_display_name', v_person.display_name, 'source_document', v_source, 'source_sha256', v_hash,
        'permit_numbers', to_jsonb(v_numbers), 'completed_at', now())),
      updated_at = clock_timestamp()
    WHERE p.id = v_person.id;
    v_target := v_person.id;
    v_outcome := 'name_completed';
  ELSE
    v_target := gen_random_uuid();
    INSERT INTO public.canonical_people (id, canonical_key, display_name, normalized_name, metadata, review_state, status)
    VALUES (v_target, 'person:permit-holder:' || v_target::text, v_name, public.normalize_person_name(v_name),
      jsonb_build_object('split_from_canonical_person_id', v_person.id, 'source_document', v_source,
        'source_sha256', v_hash, 'permit_numbers', to_jsonb(v_numbers)),
      'draft', 'active');
    UPDATE public.person_permits permit SET canonical_person_id = v_target, updated_at = now()
    WHERE permit.organization_id = p_organization_id AND permit.canonical_person_id = v_person.id
      AND permit.permit_number = ANY (v_numbers);
    GET DIAGNOSTICS v_moved = ROW_COUNT;
    v_outcome := 'split';
  END IF;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (p_organization_id, v_actor,
    CASE v_outcome WHEN 'split' THEN 'permit_holder_split' ELSE 'permit_holder_name_completed' END,
    'canonical_people', v_target,
    jsonb_build_object(
      'source_document', v_source, 'source_sha256', v_hash, 'permit_numbers', to_jsonb(v_numbers),
      'from_canonical_person_id', v_person.id, 'canonical_person_id', v_target,
      'with_same_email', coalesce(p_with_same_email, false), 'given_name_words_added', v_added,
      'permits_moved', v_moved, 'permits_remaining', cardinality(v_held) - v_moved));

  RETURN jsonb_build_object('outcome', v_outcome, 'canonical_person_id', v_target, 'from_canonical_person_id', v_person.id,
    'permits_attributed', cardinality(v_numbers), 'permits_moved', v_moved, 'permits_remaining', cardinality(v_held) - v_moved);
END;
$$;
COMMENT ON FUNCTION public.attribute_permit_holder(uuid, uuid, text, text[], text, text, boolean) IS
  'Organisation-administrator repair of a permit holder''s identity from a permit extract that names the holder of each listed permit. When the listed permits (plus, on request, the record''s other permits applied for under the same email) are all the record''s permits, the given names are added in front of the recorded name; otherwise they move to a new person of their own. Refuses names that do not extend the recorded name, permits the person does not hold, and renaming a person another organisation records. Keeps the previous name on the person; audited with source file and SHA-256 and no personal values.';
REVOKE ALL ON FUNCTION public.attribute_permit_holder(uuid, uuid, text, text[], text, text, boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.attribute_permit_holder(uuid, uuid, text, text[], text, text, boolean) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.import_person_permit(uuid, uuid, jsonb, text, text, timestamptz, uuid);

CREATE OR REPLACE FUNCTION public.import_person_permit(
  p_organization_id uuid,
  p_client_organization_id uuid,
  p_permit jsonb,
  p_source_document text,
  p_source_sha256 text,
  p_source_checked_at timestamptz DEFAULT NULL,
  p_canonical_person_id uuid DEFAULT NULL,
  p_create_holder boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_fields constant text[] := ARRAY[
    'contact_email', 'contact_phone', 'address_text', 'permit_type', 'applicant_type', 'company_name',
    'forest_areas', 'activities', 'hunting_season', 'date_from', 'date_to', 'firearm_confirm',
    'firearm_licence_valid', 'firearm_licence_number', 'chainsaw_safety_equipment', 'keys_issued', 'conditions'
  ];
  v_unknown text[];
  v_number text := nullif(regexp_replace(trim(coalesce(p_permit->>'permit_number', '')), '\s+', ' ', 'g'), '');
  v_hash text := lower(nullif(trim(coalesce(p_source_sha256, '')), ''));
  v_source text := nullif(trim(coalesce(p_source_document, '')), '');
  v_holder_name text := nullif(regexp_replace(trim(coalesce(p_permit->>'holder_name', '')), '\s+', ' ', 'g'), '');
  v_holder_norm text := public.normalize_person_name(p_permit->>'holder_name');
  v_input public.person_permits%rowtype;
  v_permit public.person_permits%rowtype;
  v_merged public.person_permits%rowtype;
  v_in jsonb;
  v_old jsonb;
  v_patch jsonb := '{}'::jsonb;
  v_field text;
  v_person uuid;
  v_basis text;
  v_candidates uuid[];
  v_filled text[] := '{}';
  v_differing text[] := '{}';
  v_holder_name_differs boolean := false;
  v_holder_created boolean := false;
  v_vehicle jsonb;
  v_plate text;
  v_vehicle_id uuid;
  v_rows integer;
  v_linked integer := 0;
  v_created integer := 0;
  v_already integer := 0;
  v_invalid integer := 0;
  v_outcome text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_organization_id IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN
    RAISE EXCEPTION 'Administrator access to the permit organisation is required';
  END IF;
  IF p_client_organization_id IS NOT NULL AND NOT public.org_access_allowed(p_client_organization_id) THEN
    RAISE EXCEPTION 'Access to the client organisation is required';
  END IF;
  IF p_permit IS NULL OR jsonb_typeof(p_permit) <> 'object' THEN RAISE EXCEPTION 'Permit details must be a JSON object'; END IF;
  SELECT array_agg(field_name ORDER BY field_name) INTO v_unknown
  FROM jsonb_object_keys(p_permit) AS supplied(field_name)
  WHERE field_name <> ALL (v_fields || ARRAY['permit_number', 'holder_name', 'vehicles']);
  IF v_unknown IS NOT NULL THEN RAISE EXCEPTION 'Unsupported permit fields: %', array_to_string(v_unknown, ', '); END IF;
  IF v_number IS NULL THEN RAISE EXCEPTION 'A permit number is required'; END IF;
  IF v_source IS NULL THEN RAISE EXCEPTION 'The source document is required'; END IF;
  IF v_hash IS NULL OR v_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'A SHA-256 source hash is required'; END IF;
  IF p_permit ? 'vehicles' AND jsonb_typeof(p_permit->'vehicles') <> 'array' THEN RAISE EXCEPTION 'Permit vehicles must be a list'; END IF;

  v_input := jsonb_populate_record(NULL::public.person_permits, p_permit - 'permit_number' - 'holder_name' - 'vehicles');
  v_input.contact_email := lower(nullif(trim(v_input.contact_email), ''));
  v_input.contact_phone := nullif(trim(v_input.contact_phone), '');
  v_input.address_text := nullif(regexp_replace(trim(v_input.address_text), '\s+', ' ', 'g'), '');
  v_input.permit_type := nullif(trim(v_input.permit_type), '');
  v_input.applicant_type := nullif(trim(v_input.applicant_type), '');
  v_input.company_name := nullif(trim(v_input.company_name), '');
  v_input.hunting_season := nullif(trim(v_input.hunting_season), '');
  v_input.firearm_licence_number := nullif(trim(v_input.firearm_licence_number), '');
  v_input.conditions := nullif(trim(v_input.conditions), '');
  v_input.forest_areas := nullif(array(SELECT trim(item) FROM unnest(v_input.forest_areas) item WHERE trim(item) <> ''), '{}');
  v_input.activities := nullif(array(SELECT trim(item) FROM unnest(v_input.activities) item WHERE trim(item) <> ''), '{}');
  IF v_input.date_from IS NOT NULL AND v_input.date_to IS NOT NULL AND v_input.date_to < v_input.date_from THEN
    RAISE EXCEPTION 'A permit cannot finish before it starts';
  END IF;
  v_in := to_jsonb(v_input);

  PERFORM pg_advisory_xact_lock(hashtextextended(p_organization_id::text || ':person-permit:' || v_number, 0));
  SELECT * INTO v_permit FROM public.person_permits permit
  WHERE permit.organization_id = p_organization_id AND permit.permit_number = v_number
  FOR UPDATE;

  IF v_permit.id IS NOT NULL THEN
    IF p_canonical_person_id IS NOT NULL AND p_canonical_person_id <> v_permit.canonical_person_id THEN
      RAISE EXCEPTION 'Permit holder conflict: this permit is recorded against another person';
    END IF;
    IF p_client_organization_id IS NOT NULL AND v_permit.client_organization_id IS NOT NULL
       AND p_client_organization_id <> v_permit.client_organization_id THEN
      RAISE EXCEPTION 'Permit client conflict: this permit is recorded for another client';
    END IF;
    v_person := v_permit.canonical_person_id;
    v_basis := 'existing_permit';
    SELECT v_holder_norm IS NOT NULL AND v_holder_norm IS DISTINCT FROM public.normalize_person_name(p.display_name)
      INTO v_holder_name_differs
    FROM public.canonical_people p WHERE p.id = v_person;
    v_holder_name_differs := coalesce(v_holder_name_differs, false);

    v_old := to_jsonb(v_permit);
    FOREACH v_field IN ARRAY v_fields LOOP
      CONTINUE WHEN coalesce(jsonb_typeof(v_in->v_field), 'null') = 'null';
      IF coalesce(jsonb_typeof(v_old->v_field), 'null') = 'null' OR v_old->v_field IN ('[]'::jsonb, '""'::jsonb)
         OR (jsonb_typeof(v_old->v_field) = 'string' AND trim(v_old->>v_field) = '') THEN
        v_patch := v_patch || jsonb_build_object(v_field, v_in->v_field);
        v_filled := v_filled || v_field;
      ELSIF regexp_replace(lower(v_old->>v_field), '[^a-z0-9]+', '', 'g')
            IS DISTINCT FROM regexp_replace(lower(v_in->>v_field), '[^a-z0-9]+', '', 'g') THEN
        v_differing := v_differing || v_field;
      END IF;
    END LOOP;
    IF v_permit.client_organization_id IS NULL AND p_client_organization_id IS NOT NULL THEN
      v_patch := v_patch || jsonb_build_object('client_organization_id', p_client_organization_id);
      v_filled := v_filled || 'client_organization_id'::text;
    END IF;
    IF v_permit.compliance_checked_at IS NULL AND p_source_checked_at IS NOT NULL THEN
      v_patch := v_patch || jsonb_build_object('compliance_checked_at', p_source_checked_at);
      v_filled := v_filled || 'compliance_checked_at'::text;
    END IF;
    IF v_patch <> '{}'::jsonb THEN
      v_merged := jsonb_populate_record(v_permit, v_patch);
      IF v_merged.date_from IS NOT NULL AND v_merged.date_to IS NOT NULL AND v_merged.date_to < v_merged.date_from THEN
        RAISE EXCEPTION 'A permit cannot finish before it starts';
      END IF;
      UPDATE public.person_permits permit SET
        client_organization_id = v_merged.client_organization_id,
        contact_email = v_merged.contact_email,
        contact_phone = v_merged.contact_phone,
        address_text = v_merged.address_text,
        permit_type = v_merged.permit_type,
        applicant_type = v_merged.applicant_type,
        company_name = v_merged.company_name,
        forest_areas = v_merged.forest_areas,
        activities = v_merged.activities,
        hunting_season = v_merged.hunting_season,
        date_from = v_merged.date_from,
        date_to = v_merged.date_to,
        firearm_confirm = v_merged.firearm_confirm,
        firearm_licence_valid = v_merged.firearm_licence_valid,
        firearm_licence_number = v_merged.firearm_licence_number,
        chainsaw_safety_equipment = v_merged.chainsaw_safety_equipment,
        keys_issued = v_merged.keys_issued,
        conditions = v_merged.conditions,
        compliance_checked_at = v_merged.compliance_checked_at,
        updated_at = now()
      WHERE permit.id = v_permit.id;
    END IF;
    v_outcome := CASE WHEN v_patch <> '{}'::jsonb THEN 'enriched' ELSE 'unchanged' END;
  ELSE
    IF p_canonical_person_id IS NOT NULL THEN
      SELECT p.id INTO v_person FROM public.canonical_people p
      WHERE p.id = p_canonical_person_id AND p.status = 'active' AND p.merged_into_id IS NULL;
      IF v_person IS NULL THEN RAISE EXCEPTION 'The permit holder must be an active, unmerged person'; END IF;
      v_basis := 'explicit';
    ELSE
      IF v_holder_norm IS NULL THEN
        RAISE EXCEPTION 'Permit holder not resolved: the holder name is required';
      END IF;
      IF v_input.contact_email IS NULL AND NOT coalesce(p_create_holder, false) THEN
        RAISE EXCEPTION 'Permit holder not resolved: the holder name and application email are both required';
      END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended(
        p_organization_id::text || ':permit-holder:' || coalesce(v_input.contact_email, v_holder_norm), 0));
      IF v_input.contact_email IS NOT NULL THEN
        v_candidates := array(
          SELECT DISTINCT permit.canonical_person_id
          FROM public.person_permits permit
          JOIN public.canonical_people p ON p.id = permit.canonical_person_id
          WHERE permit.organization_id = p_organization_id
            AND lower(trim(permit.contact_email)) = v_input.contact_email
            AND public.normalize_person_name(p.display_name) = v_holder_norm
            AND p.status = 'active' AND p.merged_into_id IS NULL
        );
        IF cardinality(v_candidates) > 1 THEN
          RAISE EXCEPTION 'Permit holder not resolved: % existing permit holders share this name and application email', cardinality(v_candidates);
        END IF;
        IF cardinality(v_candidates) = 1 THEN
          v_person := v_candidates[1];
          v_basis := 'permit_email_and_name';
        ELSE
          -- A holder recorded by surname alone is the same person when the email agrees and only one such holder exists.
          v_candidates := array(
            SELECT DISTINCT permit.canonical_person_id
            FROM public.person_permits permit
            JOIN public.canonical_people p ON p.id = permit.canonical_person_id
            WHERE permit.organization_id = p_organization_id
              AND lower(trim(permit.contact_email)) = v_input.contact_email
              AND public.person_name_extends(p.display_name, v_holder_name)
              AND p.status = 'active' AND p.merged_into_id IS NULL
          );
          IF cardinality(v_candidates) > 1 THEN
            RAISE EXCEPTION 'Permit holder not resolved: % existing permit holders share this surname and application email', cardinality(v_candidates);
          END IF;
          IF cardinality(v_candidates) = 1 THEN
            v_person := v_candidates[1];
            v_basis := 'permit_email_and_surname';
            v_holder_name_differs := true;
          END IF;
        END IF;
      END IF;
      IF v_person IS NULL THEN
        IF NOT coalesce(p_create_holder, false) THEN
          RAISE EXCEPTION 'Permit holder not resolved: no existing permit holder shares this name and application email';
        END IF;
        IF cardinality(array_remove(regexp_split_to_array(lower(v_holder_name), '[^a-z0-9]+'), '')) < 2 THEN
          RAISE EXCEPTION 'Permit holder not resolved: a new holder needs a full name';
        END IF;
        v_person := gen_random_uuid();
        INSERT INTO public.canonical_people (id, canonical_key, display_name, normalized_name, metadata, review_state, status)
        VALUES (v_person, 'person:permit-holder:' || v_person::text, v_holder_name, v_holder_norm,
          jsonb_build_object('created_from_permit_number', v_number, 'source_document', v_source, 'source_sha256', v_hash),
          'draft', 'active');
        v_basis := 'created_holder';
        v_holder_created := true;
      END IF;
    END IF;
    INSERT INTO public.person_permits (
      organization_id, client_organization_id, canonical_person_id, permit_number, permit_type, applicant_type,
      company_name, forest_areas, activities, hunting_season, date_from, date_to, firearm_confirm,
      firearm_licence_valid, firearm_licence_number, chainsaw_safety_equipment, keys_issued, conditions,
      status, compliance_checked_at, compliance_source, source_document, created_by,
      contact_email, contact_phone, address_text
    ) VALUES (
      p_organization_id, p_client_organization_id, v_person, v_number, v_input.permit_type, v_input.applicant_type,
      v_input.company_name, v_input.forest_areas, v_input.activities, v_input.hunting_season, v_input.date_from,
      v_input.date_to, v_input.firearm_confirm, v_input.firearm_licence_valid, v_input.firearm_licence_number,
      v_input.chainsaw_safety_equipment, v_input.keys_issued, v_input.conditions,
      'active', p_source_checked_at, 'import', v_source, v_actor,
      v_input.contact_email, v_input.contact_phone, v_input.address_text
    ) RETURNING * INTO v_permit;
    v_filled := array(SELECT field FROM unnest(v_fields) field WHERE jsonb_typeof(v_in->field) <> 'null');
    v_outcome := 'inserted';
  END IF;

  FOR v_vehicle IN SELECT value FROM jsonb_array_elements(coalesce(p_permit->'vehicles', '[]'::jsonb)) LOOP
    v_plate := public.normalize_plate_number(v_vehicle->>'plate');
    IF v_plate IS NULL OR length(v_plate) < 2 OR length(v_plate) > 8 THEN
      v_invalid := v_invalid + 1;
      CONTINUE;
    END IF;
    v_vehicle_id := NULL;
    SELECT vehicle.id INTO v_vehicle_id FROM public.canonical_vehicles vehicle WHERE vehicle.plate_number = v_plate;
    IF v_vehicle_id IS NULL THEN
      SELECT vehicle.id INTO v_vehicle_id FROM public.canonical_vehicles vehicle
      WHERE public.normalize_plate_number(vehicle.plate_number) = v_plate
      ORDER BY vehicle.created_at
      LIMIT 1;
    END IF;
    IF v_vehicle_id IS NULL THEN
      -- A new plate takes the applicant's description; an existing shared vehicle is never changed.
      INSERT INTO public.canonical_vehicles (plate_number, make, model, colour)
      VALUES (v_plate, nullif(trim(v_vehicle->>'make'), ''), nullif(trim(v_vehicle->>'model'), ''), nullif(trim(v_vehicle->>'colour'), ''))
      ON CONFLICT (plate_number) DO NOTHING
      RETURNING id INTO v_vehicle_id;
      IF v_vehicle_id IS NULL THEN
        SELECT vehicle.id INTO v_vehicle_id FROM public.canonical_vehicles vehicle WHERE vehicle.plate_number = v_plate;
      ELSE
        v_created := v_created + 1;
      END IF;
    END IF;
    INSERT INTO public.person_permit_vehicles (organization_id, permit_id, canonical_vehicle_id)
    VALUES (p_organization_id, v_permit.id, v_vehicle_id)
    ON CONFLICT (permit_id, canonical_vehicle_id) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 1 THEN v_linked := v_linked + 1; ELSE v_already := v_already + 1; END IF;
  END LOOP;
  IF v_outcome = 'unchanged' AND v_linked > 0 THEN v_outcome := 'enriched'; END IF;

  IF v_outcome <> 'unchanged' THEN
    INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
    VALUES (p_organization_id, v_actor,
      CASE WHEN v_outcome = 'inserted' THEN 'person_permit_imported' ELSE 'person_permit_enriched' END,
      'person_permits', v_permit.id,
      jsonb_build_object(
        'source_document', v_source, 'source_sha256', v_hash, 'source_checked_at', p_source_checked_at,
        'permit_number', v_number, 'match_basis', v_basis, 'fields_filled', to_jsonb(v_filled),
        'fields_differing', to_jsonb(v_differing), 'holder_name_differs', v_holder_name_differs,
        'holder_created', v_holder_created, 'canonical_person_id', v_person,
        'vehicles_linked', v_linked, 'vehicles_created', v_created));
  END IF;

  RETURN jsonb_build_object(
    'outcome', v_outcome, 'permit_id', v_permit.id, 'canonical_person_id', v_person, 'match_basis', v_basis,
    'fields_filled', to_jsonb(v_filled), 'fields_differing', to_jsonb(v_differing),
    'holder_name_differs', v_holder_name_differs, 'holder_created', v_holder_created,
    'holder_name_incomplete', v_basis = 'permit_email_and_surname',
    'vehicles_linked', v_linked, 'vehicles_created', v_created,
    'vehicles_already_linked', v_already, 'vehicles_invalid', v_invalid);
END;
$$;
COMMENT ON FUNCTION public.import_person_permit(uuid, uuid, jsonb, text, text, timestamptz, uuid, boolean) IS
'Organisation-administrator import of a forest/site access permit extract row. Replay-safe by (organisation, permit number); fill-only (recorded values are never overwritten, differences are reported); never changes a permit''s holder. A new permit goes to an explicit active person, else the single existing permit holder whose application email and name agree, else the single holder with that email recorded by surname alone (reported as holder_name_incomplete so the name can be completed through attribute_permit_holder), else - only when p_create_holder is true and the holder has a full name - a new draft person. Plates are normalised and matched to the shared vehicle register; a new plate is created with the applicant''s description and an existing vehicle is never changed. Audited with source file and SHA-256.';
REVOKE ALL ON FUNCTION public.import_person_permit(uuid, uuid, jsonb, text, text, timestamptz, uuid, boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.import_person_permit(uuid, uuid, jsonb, text, text, timestamptz, uuid, boolean) TO authenticated, service_role;
