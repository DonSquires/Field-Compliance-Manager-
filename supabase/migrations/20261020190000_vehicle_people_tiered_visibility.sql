-- People associated with a vehicle (owner, driver, associated person) and tiered
-- visibility of their details.
--
-- Owner ruling 2026-10-20: authorised users (vehicle_owner_identity area or
-- organisation administrators) see the full details of the people linked to a
-- vehicle on every screen that presents them. Everyone else in the organisation
-- sees only that the organisation has identified the owner / person responsible
-- and the suburb and town/city. The owner and the driver are often different
-- people, so a vehicle can carry drivers and associated people as well as its
-- owner, optionally tied to the sighting where they were established.
--
-- A person established at a sighting is recorded as a person->vehicle edge with
-- the observation in its evidence. observations.person_record_id stays reserved
-- for verified identities (link_observation_entities), so an unreviewed person
-- never becomes the observation's identity of record.

-- 1. Protected relationships on entity_links ---------------------------------
DROP POLICY IF EXISTS entity_links_select ON public.entity_links;
CREATE POLICY entity_links_select ON public.entity_links FOR SELECT USING (
  public.org_access_allowed(organization_id)
  AND (relationship NOT IN ('owner', 'registered_owner', 'driver', 'associated_person')
       OR public.can_access_vehicle_owner_identity(organization_id))
);
DROP POLICY IF EXISTS entity_links_write ON public.entity_links;
CREATE POLICY entity_links_write ON public.entity_links
  USING (public.org_access_allowed(organization_id)
    AND relationship NOT IN ('owner', 'registered_owner', 'driver', 'associated_person'))
  WITH CHECK (public.org_access_allowed(organization_id)
    AND relationship NOT IN ('owner', 'registered_owner', 'driver', 'associated_person'));

-- 2. Governed write path ------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_vehicle_person(
  p_organization_id uuid,
  p_canonical_vehicle_id uuid,
  p_person_record_id uuid,
  p_person_fields jsonb,
  p_relationship text,
  p_source text,
  p_basis text,
  p_observation_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_person_record_id uuid := p_person_record_id;
  v_canonical_person_id uuid;
  v_name text := nullif(trim(p_person_fields->>'display_name'), '');
  v_details jsonb;
  v_relationship text;
  v_link_id uuid;
  v_ended integer := 0;
  v_observations jsonb := CASE WHEN p_observation_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(p_observation_id) END;
BEGIN
  IF v_actor IS NULL OR NOT public.can_access_vehicle_owner_identity(p_organization_id, true) THEN
    RAISE EXCEPTION 'Vehicle owner identity access required';
  END IF;
  IF p_relationship NOT IN ('owner', 'driver', 'associated_person') THEN
    RAISE EXCEPTION 'Choose how this person relates to the vehicle';
  END IF;
  IF p_source NOT IN ('nzta_mvr', 'owner_declared', 'officer_observed', 'other') THEN
    RAISE EXCEPTION 'Choose where the details came from';
  END IF;
  IF p_source = 'nzta_mvr' AND p_relationship <> 'owner' THEN
    RAISE EXCEPTION 'The NZTA register only establishes the registered owner';
  END IF;
  IF coalesce(trim(p_basis), '') = '' THEN RAISE EXCEPTION 'A reason is required for the identity audit trail'; END IF;
  v_relationship := CASE WHEN p_relationship = 'owner' AND p_source = 'nzta_mvr' THEN 'registered_owner' ELSE p_relationship END;
  PERFORM 1 FROM public.canonical_vehicles WHERE id = p_canonical_vehicle_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Canonical vehicle not found'; END IF;
  IF p_observation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.observations o
    WHERE o.id = p_observation_id AND public.org_access_allowed(o.organization_id)
  ) THEN RAISE EXCEPTION 'Observation not found in your authorised scope'; END IF;

  IF v_person_record_id IS NULL THEN
    IF p_person_fields IS NULL OR jsonb_typeof(p_person_fields) <> 'object' THEN
      RAISE EXCEPTION 'Choose an existing person or enter their details';
    END IF;
    IF v_name IS NULL THEN RAISE EXCEPTION 'Person name is required'; END IF;
    v_details := jsonb_strip_nulls(jsonb_build_object(
      'phone', nullif(trim(p_person_fields->>'phone'), ''),
      'email', nullif(trim(p_person_fields->>'email'), ''),
      'address', nullif(trim(p_person_fields->>'address'), ''),
      'suburb', nullif(trim(p_person_fields->>'suburb'), ''),
      'city', nullif(trim(p_person_fields->>'city'), ''),
      'notes', nullif(trim(p_person_fields->>'notes'), ''),
      'nzta_mvr_sourced', p_source = 'nzta_mvr'
    ));
    INSERT INTO public.person_records (organization_id, display_name, review_state, metadata)
    VALUES (p_organization_id, v_name, 'manual_review_required',
      jsonb_build_object('profile_details', v_details, 'created_from', 'vehicle_' || p_relationship, 'created_by', v_actor))
    RETURNING id INTO v_person_record_id;
    v_canonical_person_id := public.ensure_canonical_person_for_record(v_person_record_id);
    INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
    VALUES (p_organization_id, v_actor, 'identity_person_create', 'person_records', v_person_record_id,
      jsonb_build_object('canonical_person_id', v_canonical_person_id,
        'reason', 'Vehicle ' || replace(p_relationship, '_', ' ') || ': ' || trim(p_basis),
        'fields', array(SELECT jsonb_object_keys(v_details))));
  ELSE
    PERFORM 1 FROM public.person_records WHERE id = v_person_record_id AND organization_id = p_organization_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Person record not found in this organization'; END IF;
    v_canonical_person_id := public.ensure_canonical_person_for_record(v_person_record_id);
  END IF;
  IF v_canonical_person_id IS NULL THEN RAISE EXCEPTION 'The person could not be linked to a canonical person'; END IF;

  -- A vehicle has one current owner per organisation; drivers and associated people accumulate.
  IF v_relationship IN ('owner', 'registered_owner') THEN
    UPDATE public.entity_links SET active = false, ends_at = clock_timestamp(), updated_at = clock_timestamp()
    WHERE organization_id = p_organization_id AND to_type = 'vehicle' AND to_id = p_canonical_vehicle_id
      AND relationship = v_relationship AND active
      AND NOT (from_type = 'person' AND from_id = v_canonical_person_id);
    GET DIAGNOSTICS v_ended = ROW_COUNT;
  END IF;

  INSERT INTO public.entity_links AS link (organization_id, from_type, from_id, to_type, to_id, relationship, evidence, active, starts_at, created_by)
  VALUES (p_organization_id, 'person', v_canonical_person_id, 'vehicle', p_canonical_vehicle_id, v_relationship,
    jsonb_build_object('source', p_source, 'basis', trim(p_basis), 'person_record_id', v_person_record_id,
      'nzta_restricted', p_source = 'nzta_mvr', 'observation_ids', v_observations),
    true, clock_timestamp(), v_actor)
  ON CONFLICT (organization_id, from_type, from_id, to_type, to_id, relationship) WHERE active
  DO UPDATE SET evidence = excluded.evidence || jsonb_build_object('observation_ids', (
      SELECT coalesce(jsonb_agg(DISTINCT item), '[]'::jsonb)
      FROM jsonb_array_elements(coalesce(link.evidence->'observation_ids', '[]'::jsonb) || v_observations) item
    )),
    updated_at = clock_timestamp()
  RETURNING id INTO v_link_id;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (p_organization_id, v_actor,
    CASE WHEN v_relationship IN ('owner', 'registered_owner') THEN 'vehicle_owner_recorded' ELSE 'vehicle_person_recorded' END,
    'entity_links', v_link_id,
    jsonb_strip_nulls(jsonb_build_object('canonical_vehicle_id', p_canonical_vehicle_id, 'person_record_id', v_person_record_id,
      'canonical_person_id', v_canonical_person_id, 'relationship', v_relationship, 'source', p_source,
      'basis', trim(p_basis), 'observation_id', p_observation_id, 'previous_owner_links_ended', v_ended)));
  RETURN jsonb_build_object('link_id', v_link_id, 'person_record_id', v_person_record_id,
    'canonical_person_id', v_canonical_person_id, 'relationship', v_relationship);
END;
$function$;
REVOKE ALL ON FUNCTION public.record_vehicle_person(uuid,uuid,uuid,jsonb,text,text,text,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_vehicle_person(uuid,uuid,uuid,jsonb,text,text,text,uuid) TO authenticated;
COMMENT ON FUNCTION public.record_vehicle_person(uuid,uuid,uuid,jsonb,text,text,text,uuid) IS
  'Authorised-user write path (vehicle_owner_identity at adjust/manage, or organisation administrator) linking a person to a canonical vehicle as owner (registered_owner when NZTA-sourced), driver or associated person, optionally at a specific sighting. Creates the tenant person record and canonical person when needed. Owners replace the previous owner; drivers and associated people accumulate. Audited.';

CREATE OR REPLACE FUNCTION public.record_vehicle_owner(
  p_organization_id uuid,
  p_canonical_vehicle_id uuid,
  p_person_record_id uuid,
  p_person_fields jsonb,
  p_source text,
  p_basis text
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $function$
  SELECT public.record_vehicle_person(p_organization_id, p_canonical_vehicle_id, p_person_record_id,
    p_person_fields, 'owner', p_source, p_basis, NULL);
$function$;
REVOKE ALL ON FUNCTION public.record_vehicle_owner(uuid,uuid,uuid,jsonb,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_vehicle_owner(uuid,uuid,uuid,jsonb,text,text) TO authenticated;
COMMENT ON FUNCTION public.record_vehicle_owner(uuid,uuid,uuid,jsonb,text,text) IS
  'Owner shortcut for record_vehicle_person (relationship owner).';

CREATE OR REPLACE FUNCTION public.end_vehicle_owner_link(p_link_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_link public.entity_links%rowtype;
BEGIN
  SELECT * INTO v_link FROM public.entity_links
  WHERE id = p_link_id AND relationship IN ('owner', 'registered_owner', 'driver', 'associated_person') FOR UPDATE;
  IF v_link.id IS NULL OR auth.uid() IS NULL
     OR NOT public.can_access_vehicle_owner_identity(v_link.organization_id, true) THEN
    RAISE EXCEPTION 'Vehicle owner identity access required';
  END IF;
  IF coalesce(trim(p_reason), '') = '' THEN RAISE EXCEPTION 'A reason is required for the identity audit trail'; END IF;
  IF NOT v_link.active THEN RETURN; END IF;
  UPDATE public.entity_links SET active = false, ends_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = p_link_id;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_link.organization_id, auth.uid(),
    CASE WHEN v_link.relationship IN ('owner', 'registered_owner') THEN 'vehicle_owner_ended' ELSE 'vehicle_person_ended' END,
    'entity_links', p_link_id,
    jsonb_build_object('canonical_vehicle_id', v_link.to_id, 'relationship', v_link.relationship, 'reason', trim(p_reason)));
END;
$function$;
REVOKE ALL ON FUNCTION public.end_vehicle_owner_link(uuid,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.end_vehicle_owner_link(uuid,text) TO authenticated;
COMMENT ON FUNCTION public.end_vehicle_owner_link(uuid,text) IS
  'Ends an owner, driver or associated-person link on a vehicle with a reason (authorised users). Audited.';

-- 3. Tiered reader ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_vehicle_owner_links(uuid, uuid);
CREATE FUNCTION public.get_vehicle_owner_links(p_organization_id uuid, p_canonical_vehicle_id uuid)
RETURNS TABLE(
  link_id uuid, relationship text, active boolean, source text, basis text, nzta_restricted boolean,
  person_record_id uuid, canonical_person_id uuid, display_name text, phone text, email text,
  address text, locality text, observation_ids uuid[], details_visible boolean,
  recorded_at timestamptz, recorded_by_name text, ended_at timestamptz
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_full boolean;
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL OR NOT public.org_access_allowed(p_organization_id) THEN
    RETURN;
  END IF;
  v_full := public.can_access_vehicle_owner_identity(p_organization_id);
  RETURN QUERY
  SELECT l.id, l.relationship, l.active, l.evidence->>'source',
    CASE WHEN v_full THEN l.evidence->>'basis' END,
    coalesce((l.evidence->>'nzta_restricted')::boolean, false),
    CASE WHEN v_full THEN p.id END,
    CASE WHEN v_full THEN l.from_id END,
    CASE WHEN v_full THEN coalesce(p.display_name, cp.display_name) END,
    CASE WHEN v_full THEN p.metadata->'profile_details'->>'phone' END,
    CASE WHEN v_full THEN p.metadata->'profile_details'->>'email' END,
    CASE WHEN v_full THEN p.metadata->'profile_details'->>'address' END,
    public.vehicle_owner_locality(p.metadata->'profile_details'),
    coalesce(ARRAY(SELECT (item #>> '{}')::uuid FROM jsonb_array_elements(coalesce(l.evidence->'observation_ids', '[]'::jsonb)) item), ARRAY[]::uuid[]),
    v_full,
    l.created_at, u.display_name, l.ends_at
  FROM public.entity_links l
  LEFT JOIN public.person_records p ON p.id = (l.evidence->>'person_record_id')::uuid AND p.organization_id = l.organization_id
  LEFT JOIN public.canonical_people cp ON cp.id = l.from_id
  LEFT JOIN public.user_profiles u ON u.id = l.created_by
  WHERE l.organization_id = p_organization_id AND l.to_type = 'vehicle' AND l.to_id = p_canonical_vehicle_id
    AND l.from_type = 'person' AND l.relationship IN ('owner', 'registered_owner', 'driver', 'associated_person')
  ORDER BY l.active DESC, (l.relationship IN ('owner', 'registered_owner')) DESC, l.created_at DESC
  LIMIT 50;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_vehicle_owner_links(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_vehicle_owner_links(uuid,uuid) TO authenticated;
COMMENT ON FUNCTION public.get_vehicle_owner_links(uuid,uuid) IS
  'People linked to a vehicle by the organisation (owner, registered owner, driver, associated person). Authorised users (vehicle_owner_identity area or administrators) receive full details including the address; other users of the organisation receive only the relationship, source, dates, linked sightings and the suburb/town-city locality (details_visible = false).';
