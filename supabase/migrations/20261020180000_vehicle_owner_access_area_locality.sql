-- Vehicle owner identity: authorised-user access area and locality-only display.
-- Owner ruling 2026-10-20: any user the organisation authorises may view and
-- record vehicle owner details (not only administrators). Authorisation is the
-- `vehicle_owner_identity` area of the existing access matrix
-- (staff_area_grants + access presets, resolved by resolve_access_grants), so
-- it can be granted per user (checkbox) or bundled into a preset ("skill").
-- Owner addresses are shown as suburb and city only; the street address may be
-- stored but is never returned by the owner reader.

-- 1. Access helper -------------------------------------------------------------
-- 'view' reads owners; 'adjust' or 'manage' also records and ends them.
-- Organisation administrators always hold the area.
CREATE OR REPLACE FUNCTION public.can_access_vehicle_owner_identity(
  p_organization_id uuid,
  p_record boolean DEFAULT false
) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $function$
  SELECT auth.uid() IS NOT NULL AND p_organization_id IS NOT NULL AND (
    public.is_admin_for_org(p_organization_id)
    OR EXISTS (
      SELECT 1
      FROM public.resolve_access_grants(auth.uid(), p_organization_id) grant_row
      JOIN public.user_profiles profile ON profile.id = auth.uid() AND profile.deactivated_at IS NULL
      WHERE grant_row.area = 'vehicle_owner_identity'
        AND (NOT p_record OR grant_row.level IN ('adjust', 'manage'))
    )
  );
$function$;
REVOKE ALL ON FUNCTION public.can_access_vehicle_owner_identity(uuid, boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_access_vehicle_owner_identity(uuid, boolean) TO authenticated, service_role;
COMMENT ON FUNCTION public.can_access_vehicle_owner_identity(uuid, boolean) IS
  'True when the caller may see (p_record=false) or record (p_record=true) vehicle owner identity for the organisation: organisation administrators, or users holding the vehicle_owner_identity access area (direct grant or preset; view reads, adjust/manage records).';

-- 2. Per-user authorisation (checkbox) ----------------------------------------
CREATE OR REPLACE FUNCTION public.get_vehicle_owner_access(p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_target public.user_profiles%rowtype;
  v_direct public.staff_area_grants%rowtype;
  v_preset_level text;
BEGIN
  SELECT * INTO v_target FROM public.user_profiles WHERE id = p_user_id;
  IF v_target.id IS NULL OR auth.uid() IS NULL
     OR NOT public.is_admin_for_org(v_target.organization_id) THEN
    RAISE EXCEPTION 'Organisation administrator required';
  END IF;
  SELECT * INTO v_direct FROM public.staff_area_grants
  WHERE user_id = p_user_id AND scope_org_id = v_target.organization_id
    AND area = 'vehicle_owner_identity' AND status = 'active';
  SELECT max(grant_row.level) INTO v_preset_level
  FROM public.preset_assignments assignment
  JOIN public.access_presets preset ON preset.id = assignment.preset_id
  CROSS JOIN LATERAL jsonb_each_text(preset.grants) AS grant_row(area, level)
  WHERE assignment.user_id = p_user_id AND assignment.status = 'active'
    AND grant_row.area = 'vehicle_owner_identity'
    AND v_target.organization_id = ANY (public.get_descendant_organizations(assignment.scope_org_id));
  RETURN jsonb_build_object(
    'direct', v_direct.id IS NOT NULL,
    'direct_level', v_direct.level,
    'granted_at', v_direct.updated_at,
    'via_preset', v_preset_level IS NOT NULL,
    'via_role', v_target.role IN ('admin', 'master', 'grand_master'),
    'organization_id', v_target.organization_id
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.get_vehicle_owner_access(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_vehicle_owner_access(uuid) TO authenticated;
COMMENT ON FUNCTION public.get_vehicle_owner_access(uuid) IS
  'Administrator view of whether a user holds the vehicle_owner_identity access area at their home organisation (direct grant, preset, or administrator role).';

CREATE OR REPLACE FUNCTION public.set_vehicle_owner_access(p_user_id uuid, p_enabled boolean, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_target public.user_profiles%rowtype;
  v_grant public.staff_area_grants%rowtype;
BEGIN
  SELECT * INTO v_target FROM public.user_profiles WHERE id = p_user_id FOR UPDATE;
  IF v_target.id IS NULL OR v_actor IS NULL OR NOT public.is_admin_for_org(v_target.organization_id) THEN
    RAISE EXCEPTION 'Organisation administrator required';
  END IF;
  IF v_target.role = 'grand_master' THEN RAISE EXCEPTION 'Grand master access is not configurable here'; END IF;
  IF coalesce(trim(p_reason), '') = '' THEN RAISE EXCEPTION 'A reason is required for the access audit trail'; END IF;
  IF p_enabled THEN
    INSERT INTO public.staff_area_grants (user_id, scope_org_id, area, level, status, granted_by)
    VALUES (p_user_id, v_target.organization_id, 'vehicle_owner_identity', 'manage', 'active', v_actor)
    ON CONFLICT (user_id, scope_org_id, area)
    DO UPDATE SET level = 'manage', status = 'active', granted_by = v_actor, updated_at = clock_timestamp()
    RETURNING * INTO v_grant;
  ELSE
    UPDATE public.staff_area_grants SET status = 'ended', updated_at = clock_timestamp()
    WHERE user_id = p_user_id AND scope_org_id = v_target.organization_id
      AND area = 'vehicle_owner_identity' AND status = 'active'
    RETURNING * INTO v_grant;
  END IF;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_target.organization_id, v_actor,
    CASE WHEN p_enabled THEN 'vehicle_owner_access_granted' ELSE 'vehicle_owner_access_ended' END,
    'staff_area_grants', v_grant.id,
    jsonb_build_object('user_id', p_user_id, 'area', 'vehicle_owner_identity', 'reason', trim(p_reason)));
  RETURN public.get_vehicle_owner_access(p_user_id);
END;
$function$;
REVOKE ALL ON FUNCTION public.set_vehicle_owner_access(uuid, boolean, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_vehicle_owner_access(uuid, boolean, text) TO authenticated;
COMMENT ON FUNCTION public.set_vehicle_owner_access(uuid, boolean, text) IS
  'Audited administrator switch for a user''s vehicle_owner_identity access area (view and record owner details, including NZTA-restricted owners) at the user''s home organisation.';

-- 3. Locality (suburb, city) without street ----------------------------------
CREATE OR REPLACE FUNCTION public.vehicle_owner_locality(p_details jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $function$
DECLARE
  v_street_types constant text := '(street|st|road|rd|terrace|tce|avenue|ave|drive|dr|place|pl|lane|ln|crescent|cres|way|close|grove|highway|hwy|parade|pde|quay|rise|court|ct|esplanade|mews|square|sq|boulevard|blvd|track|valley|heights|hts|view|glade|loop|green|walk)';
  v_structured text := concat_ws(', ',
    nullif(trim(p_details->>'suburb'), ''), nullif(trim(p_details->>'city'), ''));
  v_text text := nullif(trim(p_details->>'address'), '');
  v_rest text;
  v_parts text[];
  v_kept text[] := ARRAY[]::text[];
  v_part text;
BEGIN
  IF v_structured <> '' THEN RETURN v_structured; END IF;
  IF v_text IS NULL THEN RETURN NULL; END IF;
  v_text := regexp_replace(v_text, '[\s,]*\m\d{4}\s*$', '');
  v_text := regexp_replace(v_text, '\s*,?\s*(new zealand|nz)\s*$', '', 'i');

  IF position(',' IN v_text) > 0 THEN
    v_parts := regexp_split_to_array(v_text, '\s*,\s*');
    FOREACH v_part IN ARRAY v_parts LOOP
      v_part := trim(regexp_replace(v_part, '^(rd|r\.d\.)\s*\d+\s*', '', 'i'));
      CONTINUE WHEN v_part = '' OR v_part ~ '\d' OR v_part ~* ('\m' || v_street_types || '\M');
      v_kept := v_kept || v_part;
    END LOOP;
    IF cardinality(v_kept) = 0 THEN RETURN NULL; END IF;
    RETURN array_to_string(v_kept[greatest(1, cardinality(v_kept) - 1):], ', ');
  END IF;

  -- No commas: drop "<number> <name> <street type>" from the front.
  -- Leading lazy quantifier makes the whole match non-greedy (Postgres regex
  -- rule), so the first street-type word ends the street, not a later "RD 1".
  v_rest := regexp_replace(v_text, '^\s*?\S*\d\S*\s+(\S+\s+)+?' || v_street_types || '\M', '', 'i');
  IF v_rest = v_text THEN
    v_rest := regexp_replace(v_text, '^\s*?(\S+\s+)+?' || v_street_types || '\M', '', 'i');
  END IF;
  v_rest := regexp_replace(v_rest, '^[\s.,]+', '');
  -- Compound names such as "Bay View Road": drop a street type left at the front.
  -- Rural delivery numbers ("RD 1") are removed first.
  LOOP
    v_rest := regexp_replace(v_rest, '^(rd|r\.d\.)\s*\d+[\s.,]*', '', 'i');
    EXIT WHEN v_rest !~* ('^' || v_street_types || '\M');
    v_rest := regexp_replace(v_rest, '^\S+[\s.,]*', '');
  END LOOP;
  v_rest := trim(v_rest);
  -- Never leak a street number: if digits remain, the address could not be parsed safely.
  IF v_rest = '' OR v_rest ~ '\d' THEN RETURN NULL; END IF;
  RETURN v_rest;
END;
$function$;
REVOKE ALL ON FUNCTION public.vehicle_owner_locality(jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.vehicle_owner_locality(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION public.vehicle_owner_locality(jsonb) IS
  'Suburb and city for display from person profile_details: structured suburb/city when recorded, otherwise derived from the free-text address with the street number, street name and postcode removed. Returns NULL rather than risk exposing a street address.';

-- 4. Owner edges readable by authorised users ---------------------------------
DROP POLICY IF EXISTS entity_links_select ON public.entity_links;
CREATE POLICY entity_links_select ON public.entity_links FOR SELECT USING (
  public.org_access_allowed(organization_id)
  AND (relationship NOT IN ('owner', 'registered_owner') OR public.can_access_vehicle_owner_identity(organization_id))
);

CREATE OR REPLACE FUNCTION public.record_vehicle_owner(
  p_organization_id uuid,
  p_canonical_vehicle_id uuid,
  p_person_record_id uuid,
  p_person_fields jsonb,
  p_source text,
  p_basis text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_person_record_id uuid := p_person_record_id;
  v_canonical_person_id uuid;
  v_name text := nullif(trim(p_person_fields->>'display_name'), '');
  v_details jsonb;
  v_relationship text := CASE WHEN p_source = 'nzta_mvr' THEN 'registered_owner' ELSE 'owner' END;
  v_link_id uuid;
  v_ended integer;
BEGIN
  IF v_actor IS NULL OR NOT public.can_access_vehicle_owner_identity(p_organization_id, true) THEN
    RAISE EXCEPTION 'Vehicle owner identity access required';
  END IF;
  IF p_source NOT IN ('nzta_mvr', 'owner_declared', 'officer_observed', 'other') THEN
    RAISE EXCEPTION 'Choose where the owner details came from';
  END IF;
  IF coalesce(trim(p_basis), '') = '' THEN RAISE EXCEPTION 'A reason is required for the identity audit trail'; END IF;
  PERFORM 1 FROM public.canonical_vehicles WHERE id = p_canonical_vehicle_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Canonical vehicle not found'; END IF;

  IF v_person_record_id IS NULL THEN
    IF p_person_fields IS NULL OR jsonb_typeof(p_person_fields) <> 'object' THEN
      RAISE EXCEPTION 'Choose an existing person or enter the owner details';
    END IF;
    IF v_name IS NULL THEN RAISE EXCEPTION 'Person name is required'; END IF;
    v_details := jsonb_strip_nulls(jsonb_build_object(
      'phone', nullif(trim(p_person_fields->>'phone'), ''),
      'email', nullif(trim(p_person_fields->>'email'), ''),
      'address', nullif(trim(p_person_fields->>'address'), ''),
      'suburb', nullif(trim(p_person_fields->>'suburb'), ''),
      'city', nullif(trim(p_person_fields->>'city'), ''),
      'nzta_mvr_sourced', p_source = 'nzta_mvr'
    ));
    INSERT INTO public.person_records (organization_id, display_name, review_state, metadata)
    VALUES (p_organization_id, v_name, 'manual_review_required',
      jsonb_build_object('profile_details', v_details, 'created_from', 'vehicle_owner', 'created_by', v_actor))
    RETURNING id INTO v_person_record_id;
    v_canonical_person_id := public.ensure_canonical_person_for_record(v_person_record_id);
    INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
    VALUES (p_organization_id, v_actor, 'identity_person_create', 'person_records', v_person_record_id,
      jsonb_build_object('canonical_person_id', v_canonical_person_id, 'reason', 'Vehicle owner: ' || trim(p_basis),
        'fields', array(SELECT jsonb_object_keys(v_details))));
  ELSE
    PERFORM 1 FROM public.person_records WHERE id = v_person_record_id AND organization_id = p_organization_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Person record not found in this organization'; END IF;
    v_canonical_person_id := public.ensure_canonical_person_for_record(v_person_record_id);
  END IF;
  IF v_canonical_person_id IS NULL THEN RAISE EXCEPTION 'The owner could not be linked to a canonical person'; END IF;

  UPDATE public.entity_links SET active = false, ends_at = clock_timestamp(), updated_at = clock_timestamp()
  WHERE organization_id = p_organization_id AND to_type = 'vehicle' AND to_id = p_canonical_vehicle_id
    AND relationship = v_relationship AND active
    AND NOT (from_type = 'person' AND from_id = v_canonical_person_id);
  GET DIAGNOSTICS v_ended = ROW_COUNT;

  INSERT INTO public.entity_links (organization_id, from_type, from_id, to_type, to_id, relationship, evidence, active, starts_at, created_by)
  VALUES (p_organization_id, 'person', v_canonical_person_id, 'vehicle', p_canonical_vehicle_id, v_relationship,
    jsonb_build_object('source', p_source, 'basis', trim(p_basis), 'person_record_id', v_person_record_id,
      'nzta_restricted', p_source = 'nzta_mvr'),
    true, clock_timestamp(), v_actor)
  ON CONFLICT (organization_id, from_type, from_id, to_type, to_id, relationship) WHERE active
  DO UPDATE SET evidence = excluded.evidence, updated_at = clock_timestamp()
  RETURNING id INTO v_link_id;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (p_organization_id, v_actor, 'vehicle_owner_recorded', 'entity_links', v_link_id,
    jsonb_build_object('canonical_vehicle_id', p_canonical_vehicle_id, 'person_record_id', v_person_record_id,
      'canonical_person_id', v_canonical_person_id, 'relationship', v_relationship, 'source', p_source,
      'basis', trim(p_basis), 'previous_owner_links_ended', v_ended));
  RETURN jsonb_build_object('link_id', v_link_id, 'person_record_id', v_person_record_id,
    'canonical_person_id', v_canonical_person_id, 'relationship', v_relationship);
END;
$function$;
REVOKE ALL ON FUNCTION public.record_vehicle_owner(uuid,uuid,uuid,jsonb,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_vehicle_owner(uuid,uuid,uuid,jsonb,text,text) TO authenticated;
COMMENT ON FUNCTION public.record_vehicle_owner(uuid,uuid,uuid,jsonb,text,text) IS
  'Authorised-user write path for vehicle owner identity (vehicle_owner_identity area at adjust/manage, or organisation administrator). Creates or reuses the tenant person record and its canonical person, ends the previous active owner edge for this organisation, and records an audited person->vehicle owner edge. NZTA MVR sourced owners are marked restricted.';

CREATE OR REPLACE FUNCTION public.end_vehicle_owner_link(p_link_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_link public.entity_links%rowtype;
BEGIN
  SELECT * INTO v_link FROM public.entity_links
  WHERE id = p_link_id AND relationship IN ('owner', 'registered_owner') FOR UPDATE;
  IF v_link.id IS NULL OR auth.uid() IS NULL
     OR NOT public.can_access_vehicle_owner_identity(v_link.organization_id, true) THEN
    RAISE EXCEPTION 'Vehicle owner identity access required';
  END IF;
  IF coalesce(trim(p_reason), '') = '' THEN RAISE EXCEPTION 'A reason is required for the identity audit trail'; END IF;
  IF NOT v_link.active THEN RETURN; END IF;
  UPDATE public.entity_links SET active = false, ends_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = p_link_id;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_link.organization_id, auth.uid(), 'vehicle_owner_ended', 'entity_links', p_link_id,
    jsonb_build_object('canonical_vehicle_id', v_link.to_id, 'reason', trim(p_reason)));
END;
$function$;
REVOKE ALL ON FUNCTION public.end_vehicle_owner_link(uuid,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.end_vehicle_owner_link(uuid,text) TO authenticated;

-- Return type changes (address -> locality), so the reader is recreated.
DROP FUNCTION IF EXISTS public.get_vehicle_owner_links(uuid, uuid);
CREATE FUNCTION public.get_vehicle_owner_links(p_organization_id uuid, p_canonical_vehicle_id uuid)
RETURNS TABLE(
  link_id uuid, relationship text, active boolean, source text, basis text, nzta_restricted boolean,
  person_record_id uuid, canonical_person_id uuid, display_name text, phone text, email text, locality text,
  recorded_at timestamptz, recorded_by_name text, ended_at timestamptz
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $function$
  SELECT l.id, l.relationship, l.active, l.evidence->>'source', l.evidence->>'basis',
    coalesce((l.evidence->>'nzta_restricted')::boolean, false),
    p.id, l.from_id, coalesce(p.display_name, cp.display_name),
    p.metadata->'profile_details'->>'phone', p.metadata->'profile_details'->>'email',
    public.vehicle_owner_locality(p.metadata->'profile_details'),
    l.created_at, u.display_name, l.ends_at
  FROM public.entity_links l
  LEFT JOIN public.person_records p ON p.id = (l.evidence->>'person_record_id')::uuid AND p.organization_id = l.organization_id
  LEFT JOIN public.canonical_people cp ON cp.id = l.from_id
  LEFT JOIN public.user_profiles u ON u.id = l.created_by
  WHERE public.can_access_vehicle_owner_identity(p_organization_id)
    AND l.organization_id = p_organization_id AND l.to_type = 'vehicle' AND l.to_id = p_canonical_vehicle_id
    AND l.from_type = 'person' AND l.relationship IN ('owner', 'registered_owner')
  ORDER BY l.active DESC, l.created_at DESC
  LIMIT 20;
$function$;
REVOKE ALL ON FUNCTION public.get_vehicle_owner_links(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_vehicle_owner_links(uuid,uuid) TO authenticated;
COMMENT ON FUNCTION public.get_vehicle_owner_links(uuid,uuid) IS
  'Reader for recorded vehicle owners (personal information) for users authorised by the vehicle_owner_identity access area or organisation administrators. Returns suburb and city (locality) only, never the street address. Returns nothing for other callers.';
