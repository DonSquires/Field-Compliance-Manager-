-- Permit holders in person search, permit validity from dates, and a governed permit import.
--
-- R&M administers forest access permits for landowner clients (OneFortyOne first).
-- The permit holders imported from the booking system have no canonical person link
-- or notice, so person search never showed them and their permits were only visible
-- by plate. A person holding a permit in an organisation the caller can access is now
-- visible in person search (by name, alias or exact permit number), and the person
-- record lists each permit with its vehicles, dates, areas and the contact details
-- captured on the application. Validity is derived on read from the permit dates in
-- New Zealand time; `status` stays the administrative state (active, suspended,
-- revoked, expired). The firearm licence number is never returned by either read path.
--
-- import_person_permit is the governed write path for permit extracts: organisation
-- administrators only, replay-safe by permit number, fill-only (an imported value
-- never overwrites a recorded one; differences are reported), a permit's holder is
-- never changed, a new permit is attached only to an explicit person or the single
-- existing permit holder whose application email and name both agree, plates are
-- normalised and matched to the shared vehicle register, and every write leaves an
-- audit_log receipt naming the source file and hash.

CREATE OR REPLACE FUNCTION public.person_permit_validity(
  p_status text,
  p_date_from date,
  p_date_to date,
  p_window_days integer DEFAULT 30
)
RETURNS text
LANGUAGE sql
STABLE
SET search_path TO ''
AS $$
  WITH today AS (SELECT (clock_timestamp() AT TIME ZONE 'Pacific/Auckland')::date AS d)
  SELECT CASE
    WHEN p_status IN ('revoked', 'suspended', 'expired') THEN p_status
    WHEN p_date_to IS NOT NULL AND p_date_to < today.d THEN 'expired'
    WHEN p_date_from IS NOT NULL AND p_date_from > today.d THEN 'not_started'
    WHEN p_date_from IS NULL AND p_date_to IS NULL THEN 'dates_not_recorded'
    WHEN p_date_to IS NOT NULL AND p_date_to <= today.d + greatest(coalesce(p_window_days, 30), 0) THEN 'expiring_soon'
    ELSE 'valid'
  END
  FROM today;
$$;
COMMENT ON FUNCTION public.person_permit_validity(text, date, date, integer) IS
'Plain validity of a forest/site access permit on today''s New Zealand date: revoked, suspended or expired by status; expired after the finishing date (inclusive end); not_started before the start date; dates_not_recorded when neither date is known; expiring_soon inside the window; otherwise valid.';
REVOKE ALL ON FUNCTION public.person_permit_validity(text, date, date, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.person_permit_validity(text, date, date, integer) TO anon, authenticated, service_role;

CREATE OR REPLACE VIEW public.person_permits_fieldwork WITH (security_invoker = true) AS
 SELECT pp.id,
    pp.organization_id,
    pp.client_organization_id,
    pp.canonical_person_id,
    cp.display_name AS holder_name,
    pp.permit_number,
    pp.permit_type,
    pp.applicant_type,
    pp.company_name,
    pp.contact_email,
    pp.contact_phone,
    pp.address_text,
    pp.forest_areas,
    pp.activities,
    pp.hunting_season,
    pp.date_from,
    pp.date_to,
    pp.firearm_confirm,
    pp.firearm_licence_valid,
    pp.chainsaw_safety_equipment,
    pp.keys_issued,
    pp.conditions,
    pp.status,
    pp.compliance_checked_at,
    pp.compliance_source,
    ( SELECT array_agg(cv.plate_number ORDER BY cv.plate_number) AS array_agg
           FROM public.person_permit_vehicles ppv
             JOIN public.canonical_vehicle_public cv ON cv.id = ppv.canonical_vehicle_id
          WHERE ppv.permit_id = pp.id) AS vehicle_plates,
    public.person_permit_validity(pp.status, pp.date_from, pp.date_to) AS validity_state
   FROM public.person_permits pp
     LEFT JOIN public.canonical_person_public cp ON cp.id = pp.canonical_person_id
  WHERE public.org_access_allowed(pp.organization_id);
COMMENT ON VIEW public.person_permits_fieldwork IS 'Officer/dispatch-safe permit projection: excludes firearm_licence_number (personal information; is_admin_for_org base-table access only). Includes holder name, contact detail captured on the application, vehicle plates for field verification, and validity_state derived from the permit dates (person_permit_validity).';

CREATE OR REPLACE FUNCTION public.search_people(p_query text, p_limit integer DEFAULT 25)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_query text := regexp_replace(lower(trim(coalesce(p_query, ''))), '\s+', ' ', 'g');
  v_norm text;
  v_tokens text[];
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 50);
  v_orgs uuid[];
  v_identity_orgs uuid[];
  v_result jsonb;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE id = v_actor AND deactivated_at IS NULL
      AND role IN ('grand_master', 'master', 'admin', 'admin_officer')
  ) THEN
    RAISE EXCEPTION 'Active operations role required';
  END IF;
  v_norm := regexp_replace(v_query, '[^a-z0-9]+', '', 'g');
  IF length(v_norm) < 2 THEN RETURN '[]'::jsonb; END IF;
  v_tokens := array(
    SELECT token FROM unnest(regexp_split_to_array(regexp_replace(v_query, '[^a-z0-9 ]+', '', 'g'), ' ')) token
    WHERE token <> ''
  );
  v_orgs := array(SELECT o.id FROM public.organizations o WHERE public.org_access_allowed(o.id));
  v_identity_orgs := array(SELECT org_id FROM unnest(v_orgs) org_id WHERE public.can_access_vehicle_owner_identity(org_id));

  WITH matched AS (
    SELECT p.id
    FROM public.canonical_people p
    WHERE p.status = 'active'
      AND (p.normalized_name LIKE '%' || v_norm || '%'
        OR (cardinality(v_tokens) > 1 AND NOT EXISTS (
          SELECT 1 FROM unnest(v_tokens) token WHERE position(token IN lower(coalesce(p.display_name, ''))) = 0)))
    UNION
    SELECT link.canonical_person_id
    FROM public.person_record_aliases alias
    JOIN public.canonical_person_links link ON link.source_table = 'person_records' AND link.source_id = alias.person_record_id
    WHERE alias.active AND alias.organization_id = ANY (v_orgs) AND alias.alias_norm LIKE '%' || v_norm || '%'
    UNION
    SELECT link.canonical_person_id
    FROM public.person_records record
    JOIN public.canonical_person_links link ON link.source_table = 'person_records' AND link.source_id = record.id
    WHERE record.organization_id = ANY (v_orgs)
      AND regexp_replace(lower(coalesce(record.display_name, '')), '[^a-z0-9]+', '', 'g') LIKE '%' || v_norm || '%'
    UNION
    SELECT permit.canonical_person_id
    FROM public.person_permits permit
    WHERE permit.organization_id = ANY (v_orgs)
      AND regexp_replace(lower(permit.permit_number), '[^a-z0-9]+', '', 'g') = v_norm
  ),
  visible AS (
    SELECT p.*
    FROM public.canonical_people p
    WHERE p.id IN (SELECT id FROM matched)
      AND p.status = 'active'
      AND (EXISTS (SELECT 1 FROM public.canonical_person_links link
                   WHERE link.canonical_person_id = p.id AND link.organization_id = ANY (v_orgs))
        OR EXISTS (SELECT 1 FROM public.notices notice
                   WHERE notice.person_id = p.id AND notice.organization_id = ANY (v_orgs))
        OR EXISTS (SELECT 1 FROM public.person_permits permit
                   WHERE permit.canonical_person_id = p.id AND permit.organization_id = ANY (v_orgs)))
  ),
  ranked AS (
    SELECT v.*,
      (v.normalized_name = v_norm OR EXISTS (
        SELECT 1 FROM public.person_permits permit
        WHERE permit.canonical_person_id = v.id AND permit.organization_id = ANY (v_orgs)
          AND regexp_replace(lower(permit.permit_number), '[^a-z0-9]+', '', 'g') = v_norm)) AS exact_match,
      EXISTS (SELECT 1 FROM public.notices notice
              WHERE notice.person_id = v.id AND notice.organization_id = ANY (v_orgs)
                AND notice.status = 'issued' AND notice.notice_type IN ('trespass', 'warning')
                AND (notice.expires_at IS NULL OR notice.expires_at > clock_timestamp())) AS has_notice_in_force
    FROM visible v
    ORDER BY exact_match DESC, has_notice_in_force DESC, v.display_name
    LIMIT v_limit
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'canonical_person_id', r.id,
    'display_name', r.display_name,
    'review_state', r.review_state,
    'homeless_status', r.homeless_status,
    'has_notice_in_force', r.has_notice_in_force,
    'aliases', coalesce((
      SELECT jsonb_agg(DISTINCT alias.alias)
      FROM public.canonical_person_links link
      JOIN public.person_record_aliases alias ON alias.person_record_id = link.source_id AND alias.active
      WHERE link.canonical_person_id = r.id AND link.source_table = 'person_records' AND alias.organization_id = ANY (v_orgs)
    ), '[]'::jsonb),
    'organizations', coalesce((
      SELECT jsonb_agg(DISTINCT org.name)
      FROM public.organizations org
      WHERE org.id = ANY (v_orgs)
        AND (EXISTS (SELECT 1 FROM public.canonical_person_links link WHERE link.canonical_person_id = r.id AND link.organization_id = org.id)
          OR EXISTS (SELECT 1 FROM public.notices notice WHERE notice.person_id = r.id AND notice.organization_id = org.id)
          OR EXISTS (SELECT 1 FROM public.person_permits permit WHERE permit.canonical_person_id = r.id AND permit.organization_id = org.id))
    ), '[]'::jsonb),
    'notices', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'notice_id', notice.id,
        'organization_id', notice.organization_id,
        'organization_name', org.name,
        'notice_type', notice.notice_type,
        'notice_number', notice.notice_number,
        'status', notice.status,
        'issued_at', notice.issued_at,
        'expires_at', notice.expires_at,
        'expiry_state', public.notice_expiry_state(notice.status, notice.expires_at),
        'location_name', place.name
      ) ORDER BY notice.issued_at DESC NULLS LAST)
      FROM public.notices notice
      JOIN public.organizations org ON org.id = notice.organization_id
      LEFT JOIN public.observations observation ON observation.id = notice.observation_id
      LEFT JOIN public.locations place ON place.id = coalesce(notice.location_id, observation.location_id)
      WHERE notice.person_id = r.id AND notice.organization_id = ANY (v_orgs)
    ), '[]'::jsonb),
    'permits', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'permit_id', permit.id,
        'organization_name', org.name,
        'client_organization_name', client.name,
        'permit_number', permit.permit_number,
        'permit_type', permit.permit_type,
        'applicant_type', permit.applicant_type,
        'company_name', permit.company_name,
        'status', permit.status,
        'validity_state', public.person_permit_validity(permit.status, permit.date_from, permit.date_to),
        'date_from', permit.date_from,
        'date_to', permit.date_to,
        'forest_areas', coalesce(to_jsonb(permit.forest_areas), '[]'::jsonb),
        'activities', coalesce(to_jsonb(permit.activities), '[]'::jsonb),
        'hunting_season', permit.hunting_season,
        'firearm_licence_valid', permit.firearm_licence_valid,
        'chainsaw_safety_equipment', permit.chainsaw_safety_equipment,
        'keys_issued', permit.keys_issued,
        'conditions', permit.conditions,
        'contact_email', permit.contact_email,
        'contact_phone', permit.contact_phone,
        'address_text', permit.address_text,
        'compliance_checked_at', permit.compliance_checked_at,
        'source_document', permit.source_document,
        'vehicles', coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'canonical_vehicle_id', vehicle.id,
            'plate_number', vehicle.plate_number,
            'make', vehicle.make,
            'model', vehicle.model,
            'colour', vehicle.colour
          ) ORDER BY vehicle.plate_number)
          FROM public.person_permit_vehicles permit_vehicle
          JOIN public.canonical_vehicles vehicle ON vehicle.id = permit_vehicle.canonical_vehicle_id
          WHERE permit_vehicle.permit_id = permit.id
        ), '[]'::jsonb)
      ) ORDER BY permit.date_to DESC NULLS LAST, permit.created_at DESC)
      FROM public.person_permits permit
      JOIN public.organizations org ON org.id = permit.organization_id
      LEFT JOIN public.organizations client ON client.id = permit.client_organization_id
      WHERE permit.canonical_person_id = r.id AND permit.organization_id = ANY (v_orgs)
    ), '[]'::jsonb),
    'vehicles', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'canonical_vehicle_id', vehicle.id,
        'plate_number', vehicle.plate_number,
        'make', vehicle.make,
        'model', vehicle.model,
        'colour', vehicle.colour,
        'relationship', link.relationship,
        'since', link.starts_at,
        'source', CASE WHEN link.organization_id = ANY (v_identity_orgs) THEN link.evidence->>'source' END,
        'source_checked_at', CASE WHEN link.organization_id = ANY (v_identity_orgs)
          THEN link.evidence->>'source_checked_at' END
      ) ORDER BY link.starts_at DESC NULLS LAST)
      FROM public.entity_links link
      JOIN public.canonical_vehicles vehicle ON vehicle.id = link.to_id
      WHERE link.from_type = 'person' AND link.from_id = r.id AND link.to_type = 'vehicle'
        AND link.active AND link.organization_id = ANY (v_orgs)
        AND (link.relationship NOT IN ('owner', 'registered_owner', 'driver', 'associated_person')
          OR link.organization_id = ANY (v_identity_orgs))
    ), '[]'::jsonb),
    'nzta_authorised', cardinality(v_identity_orgs) > 0,
    'nzta', CASE WHEN cardinality(v_identity_orgs) = 0 THEN NULL ELSE (
      SELECT jsonb_build_object(
        'address', coalesce(doc.extracted_fields->'approved'->>'address',
                            doc.extracted_fields->'proposed'->>'physical_address',
                            doc.extracted_fields->'proposed'->>'address'),
        'last_checked_at', check_row.checked_at,
        'checks', (
          SELECT coalesce(jsonb_agg(jsonb_build_object(
            'plate_number', checked_vehicle.plate_number,
            'checked_at', history.checked_at
          ) ORDER BY history.checked_at DESC), '[]'::jsonb)
          FROM public.vehicle_identity_checks history
          JOIN public.canonical_vehicles checked_vehicle ON checked_vehicle.id = history.canonical_vehicle_id
          WHERE history.canonical_person_id = r.id AND history.organization_id = ANY (v_identity_orgs)
        )
      )
      FROM public.vehicle_identity_checks check_row
      JOIN public.person_identity_documents doc ON doc.id = check_row.identity_document_id
      WHERE check_row.canonical_person_id = r.id AND check_row.organization_id = ANY (v_identity_orgs)
      ORDER BY check_row.checked_at DESC
      LIMIT 1
    ) END
  ) ORDER BY r.exact_match DESC, r.has_notice_in_force DESC, r.display_name), '[]'::jsonb)
  INTO v_result
  FROM ranked r;

  RETURN v_result;
END;
$function$;
COMMENT ON FUNCTION public.search_people(text, integer) IS
  'Person search across the caller''s authorised organisations: name/alias or exact permit number match, notices and letters with expiry state, forest/site access permits with date-derived validity and permit vehicles (never the firearm licence number), linked vehicles. A permit holder is visible where the permit is held. Only issued trespass and warning notices count as in force. Address and NZTA register checks are only returned to users with vehicle-owner identity access (owner ruling 2026-10-26). Safety warnings come from get_safety_warnings.';
REVOKE ALL ON FUNCTION public.search_people(text, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.search_people(text, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.import_person_permit(
  p_organization_id uuid,
  p_client_organization_id uuid,
  p_permit jsonb,
  p_source_document text,
  p_source_sha256 text,
  p_source_checked_at timestamptz DEFAULT NULL,
  p_canonical_person_id uuid DEFAULT NULL
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
      IF v_input.contact_email IS NULL OR v_holder_norm IS NULL THEN
        RAISE EXCEPTION 'Permit holder not resolved: the holder name and application email are both required';
      END IF;
      v_candidates := array(
        SELECT DISTINCT permit.canonical_person_id
        FROM public.person_permits permit
        JOIN public.canonical_people p ON p.id = permit.canonical_person_id
        WHERE permit.organization_id = p_organization_id
          AND lower(trim(permit.contact_email)) = v_input.contact_email
          AND public.normalize_person_name(p.display_name) = v_holder_norm
          AND p.status = 'active' AND p.merged_into_id IS NULL
      );
      IF cardinality(v_candidates) <> 1 THEN
        RAISE EXCEPTION 'Permit holder not resolved: % existing permit holders share this name and application email', cardinality(v_candidates);
      END IF;
      v_person := v_candidates[1];
      v_basis := 'permit_email_and_name';
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
        'vehicles_linked', v_linked, 'vehicles_created', v_created));
  END IF;

  RETURN jsonb_build_object(
    'outcome', v_outcome, 'permit_id', v_permit.id, 'canonical_person_id', v_person, 'match_basis', v_basis,
    'fields_filled', to_jsonb(v_filled), 'fields_differing', to_jsonb(v_differing),
    'holder_name_differs', v_holder_name_differs, 'vehicles_linked', v_linked, 'vehicles_created', v_created,
    'vehicles_already_linked', v_already, 'vehicles_invalid', v_invalid);
END;
$$;
COMMENT ON FUNCTION public.import_person_permit(uuid, uuid, jsonb, text, text, timestamptz, uuid) IS
'Organisation-administrator import of a forest/site access permit extract row. Replay-safe by (organisation, permit number); fill-only (recorded values are never overwritten, differences are reported); never changes a permit''s holder; a new permit needs an explicit active person or the single existing permit holder whose application email and name agree. Plates are normalised and matched to the shared vehicle register; a new plate is created with the applicant''s description and an existing vehicle is never changed. Audited with source file and SHA-256.';
REVOKE ALL ON FUNCTION public.import_person_permit(uuid, uuid, jsonb, text, text, timestamptz, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.import_person_permit(uuid, uuid, jsonb, text, text, timestamptz, uuid) TO authenticated, service_role;
