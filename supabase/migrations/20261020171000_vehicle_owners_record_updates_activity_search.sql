-- Vehicle owner identity, append-only record updates/follow-ups, per-observation
-- status indicators and full-text activity search. Original observations and
-- location events stay immutable; everything here is additive and audited.

-- 1. Owner identity -----------------------------------------------------------
-- Owner knowledge is an org-scoped edge (entity_links) from a canonical person
-- to a canonical vehicle. Owner details are personal information (tier 2):
-- readable by the recording organisation's administrators only, and written
-- only through record_vehicle_owner / end_vehicle_owner_link.
DROP POLICY IF EXISTS entity_links_select ON public.entity_links;
CREATE POLICY entity_links_select ON public.entity_links FOR SELECT USING (
  public.org_access_allowed(organization_id)
  AND (relationship NOT IN ('owner', 'registered_owner') OR public.is_admin_for_org(organization_id))
);
DROP POLICY IF EXISTS entity_links_write ON public.entity_links;
CREATE POLICY entity_links_write ON public.entity_links
  USING (public.org_access_allowed(organization_id) AND relationship NOT IN ('owner', 'registered_owner'))
  WITH CHECK (public.org_access_allowed(organization_id) AND relationship NOT IN ('owner', 'registered_owner'));

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
  v_result jsonb;
  v_relationship text := CASE WHEN p_source = 'nzta_mvr' THEN 'registered_owner' ELSE 'owner' END;
  v_link_id uuid;
  v_ended integer;
BEGIN
  IF v_actor IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN
    RAISE EXCEPTION 'Identity registry administrator access required';
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
    -- Creates the tenant person record and its canonical person projection.
    v_result := public.manage_identity_person_record(p_organization_id, NULL, 'create',
      (p_person_fields - 'nzta_mvr_sourced') || jsonb_build_object('nzta_mvr_sourced', p_source = 'nzta_mvr'),
      'Vehicle owner: ' || trim(p_basis));
    v_person_record_id := (v_result->>'person_record_id')::uuid;
    v_canonical_person_id := (v_result->>'canonical_person_id')::uuid;
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
  'Administrator write path for vehicle owner identity. Creates or reuses the tenant person record and its canonical person, ends the previous active owner edge for this organisation, and records an audited person->vehicle owner edge. NZTA MVR sourced owners are marked restricted.';

CREATE OR REPLACE FUNCTION public.end_vehicle_owner_link(p_link_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_link public.entity_links%rowtype;
BEGIN
  SELECT * INTO v_link FROM public.entity_links
  WHERE id = p_link_id AND relationship IN ('owner', 'registered_owner') FOR UPDATE;
  IF v_link.id IS NULL OR auth.uid() IS NULL OR NOT public.is_admin_for_org(v_link.organization_id) THEN
    RAISE EXCEPTION 'Identity registry administrator access required';
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

CREATE OR REPLACE FUNCTION public.get_vehicle_owner_links(p_organization_id uuid, p_canonical_vehicle_id uuid)
RETURNS TABLE(
  link_id uuid, relationship text, active boolean, source text, basis text, nzta_restricted boolean,
  person_record_id uuid, canonical_person_id uuid, display_name text, phone text, email text, address text,
  recorded_at timestamptz, recorded_by_name text, ended_at timestamptz
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $function$
  SELECT l.id, l.relationship, l.active, l.evidence->>'source', l.evidence->>'basis',
    coalesce((l.evidence->>'nzta_restricted')::boolean, false),
    p.id, l.from_id, coalesce(p.display_name, cp.display_name),
    p.metadata->'profile_details'->>'phone', p.metadata->'profile_details'->>'email',
    p.metadata->'profile_details'->>'address',
    l.created_at, u.display_name, l.ends_at
  FROM public.entity_links l
  LEFT JOIN public.person_records p ON p.id = (l.evidence->>'person_record_id')::uuid AND p.organization_id = l.organization_id
  LEFT JOIN public.canonical_people cp ON cp.id = l.from_id
  LEFT JOIN public.user_profiles u ON u.id = l.created_by
  WHERE auth.uid() IS NOT NULL AND public.is_admin_for_org(p_organization_id)
    AND l.organization_id = p_organization_id AND l.to_type = 'vehicle' AND l.to_id = p_canonical_vehicle_id
    AND l.from_type = 'person' AND l.relationship IN ('owner', 'registered_owner')
  ORDER BY l.active DESC, l.created_at DESC
  LIMIT 20;
$function$;
REVOKE ALL ON FUNCTION public.get_vehicle_owner_links(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_vehicle_owner_links(uuid,uuid) TO authenticated;
COMMENT ON FUNCTION public.get_vehicle_owner_links(uuid,uuid) IS
  'Organisation-administrator-only reader for recorded vehicle owners (personal information). Returns nothing for other callers.';

-- 2. Append-only record updates and follow-ups ---------------------------------
CREATE TABLE public.record_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  record_kind text NOT NULL CHECK (record_kind IN ('observation', 'location_event')),
  record_id uuid NOT NULL,
  entry_kind text NOT NULL CHECK (entry_kind IN ('note', 'follow_up_requested', 'follow_up_resolved', 'hs_concern')),
  body text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 4000),
  created_by uuid NOT NULL REFERENCES public.user_profiles(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX record_updates_record_idx ON public.record_updates (record_kind, record_id, created_at DESC);
CREATE INDEX record_updates_body_trgm_idx ON public.record_updates USING gin (body extensions.gin_trgm_ops);
ALTER TABLE public.record_updates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.record_updates FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.record_updates IS
  'Append-only updates, follow-ups and H&S concerns added after an observation or location event was recorded. The original record is never edited. Read and written only through list_record_updates / add_record_update.';

CREATE OR REPLACE FUNCTION public.record_update_target_org(p_record_kind text, p_record_id uuid)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_org uuid;
  v_client uuid;
  v_site uuid;
  v_zone uuid;
BEGIN
  IF v_uid IS NULL THEN RETURN NULL; END IF;
  IF p_record_kind = 'observation' THEN
    SELECT organization_id, client_org_id INTO v_org, v_client FROM public.observations WHERE id = p_record_id;
    IF v_org IS NULL THEN RETURN NULL; END IF;
    IF public.org_access_allowed(v_org) OR public.org_access_allowed(v_client)
      OR public.user_has_task_entitlement(v_uid, p_record_id) THEN RETURN v_org; END IF;
  ELSIF p_record_kind = 'location_event' THEN
    SELECT organization_id, client_site_id, zone_id INTO v_org, v_site, v_zone FROM public.location_events WHERE id = p_record_id;
    IF v_org IS NULL THEN RETURN NULL; END IF;
    IF public.org_access_allowed(v_org) OR public.has_location_access(v_site, v_zone, 'client_reads_provider') THEN RETURN v_org; END IF;
  END IF;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.record_update_target_org(text,uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.add_record_update(p_record_kind text, p_record_id uuid, p_entry_kind text, p_body text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_org uuid := public.record_update_target_org(p_record_kind, p_record_id);
  v_id uuid;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'Record not found or not in your authorised scope'; END IF;
  IF p_entry_kind NOT IN ('note', 'follow_up_requested', 'follow_up_resolved', 'hs_concern') THEN
    RAISE EXCEPTION 'Unsupported update type';
  END IF;
  IF coalesce(trim(p_body), '') = '' OR length(trim(p_body)) > 4000 THEN
    RAISE EXCEPTION 'Enter the update (up to 4000 characters)';
  END IF;
  INSERT INTO public.record_updates (organization_id, record_kind, record_id, entry_kind, body, created_by)
  VALUES (v_org, p_record_kind, p_record_id, p_entry_kind, trim(p_body), auth.uid())
  RETURNING id INTO v_id;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_org, auth.uid(), 'record_update_added', p_record_kind || 's', p_record_id,
    jsonb_build_object('record_update_id', v_id, 'entry_kind', p_entry_kind));
  RETURN v_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.add_record_update(text,uuid,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.add_record_update(text,uuid,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.list_record_updates(p_record_kind text, p_record_id uuid)
RETURNS TABLE(id uuid, entry_kind text, body text, created_at timestamptz, created_by_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $function$
  SELECT r.id, r.entry_kind, r.body, r.created_at, u.display_name
  FROM public.record_updates r
  LEFT JOIN public.user_profiles u ON u.id = r.created_by
  WHERE public.record_update_target_org(p_record_kind, p_record_id) IS NOT NULL
    AND r.record_kind = p_record_kind AND r.record_id = p_record_id
  ORDER BY r.created_at DESC
  LIMIT 200;
$function$;
REVOKE ALL ON FUNCTION public.list_record_updates(text,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_record_updates(text,uuid) TO authenticated;

-- 3. Per-observation status indicators -----------------------------------------
CREATE OR REPLACE FUNCTION public.get_observation_annotations(p_observation_ids uuid[])
RETURNS TABLE(
  observation_id uuid, vehicle_flagged boolean, hs_concern boolean, hazard_classes text[],
  notice_issued boolean, prior_notice_count integer, follow_up_open boolean, update_count integer
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $function$
  WITH visible AS (
    SELECT o.id, o.canonical_vehicle_id, o.canonical_person_id, o.plate_number, o.observed_at
    FROM public.observations o
    WHERE o.id = ANY(p_observation_ids[1:200]) AND auth.uid() IS NOT NULL
      AND (public.org_access_allowed(o.organization_id) OR public.org_access_allowed(o.client_org_id)
        OR public.user_has_task_entitlement(auth.uid(), o.id))
  )
  SELECT v.id,
    EXISTS (SELECT 1 FROM public.entity_flags f WHERE f.active AND f.hazard_class IS NULL
      AND public.org_access_allowed(f.organization_id)
      AND ((f.entity_type = 'vehicle' AND f.entity_id = v.canonical_vehicle_id)
        OR (f.entity_type = 'person' AND f.entity_id = v.canonical_person_id))),
    EXISTS (SELECT 1 FROM public.entity_flags f WHERE f.active AND f.hazard_class IS NOT NULL
      AND ((f.entity_type = 'vehicle' AND f.entity_id = v.canonical_vehicle_id)
        OR (f.entity_type = 'person' AND f.entity_id = v.canonical_person_id)))
      OR EXISTS (SELECT 1 FROM public.record_updates r WHERE r.record_kind = 'observation' AND r.record_id = v.id AND r.entry_kind = 'hs_concern'),
    ARRAY(SELECT DISTINCT f.hazard_class FROM public.entity_flags f WHERE f.active AND f.hazard_class IS NOT NULL
      AND ((f.entity_type = 'vehicle' AND f.entity_id = v.canonical_vehicle_id)
        OR (f.entity_type = 'person' AND f.entity_id = v.canonical_person_id))),
    EXISTS (SELECT 1 FROM public.notices n WHERE n.observation_id = v.id)
      OR EXISTS (SELECT 1 FROM public.infringement_notices n WHERE n.observation_id = v.id)
      OR EXISTS (SELECT 1 FROM public.notices_to_vacate n WHERE n.observation_id = v.id),
    (SELECT count(*)::integer FROM (
      SELECT n.id FROM public.infringement_notices n
      WHERE v.plate_number IS NOT NULL AND public.normalize_plate_number(n.plate_number) = public.normalize_plate_number(v.plate_number)
        AND n.issued_at < v.observed_at AND public.org_access_allowed(n.organization_id)
      UNION ALL
      SELECT n.id FROM public.notices_to_vacate n
      WHERE v.plate_number IS NOT NULL AND public.normalize_plate_number(n.plate_number) = public.normalize_plate_number(v.plate_number)
        AND n.issued_at < v.observed_at AND public.org_access_allowed(n.organization_id)
      UNION ALL
      SELECT n.id FROM public.notices n JOIN public.observations prior ON prior.id = n.observation_id
      WHERE v.canonical_vehicle_id IS NOT NULL AND prior.canonical_vehicle_id = v.canonical_vehicle_id
        AND prior.observed_at < v.observed_at AND public.org_access_allowed(n.organization_id)
    ) prior_notices),
    coalesce((SELECT r.entry_kind = 'follow_up_requested' FROM public.record_updates r
      WHERE r.record_kind = 'observation' AND r.record_id = v.id AND r.entry_kind IN ('follow_up_requested', 'follow_up_resolved')
      ORDER BY r.created_at DESC LIMIT 1), false),
    (SELECT count(*)::integer FROM public.record_updates r WHERE r.record_kind = 'observation' AND r.record_id = v.id)
  FROM visible v;
$function$;
REVOKE ALL ON FUNCTION public.get_observation_annotations(uuid[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_observation_annotations(uuid[]) TO authenticated;
COMMENT ON FUNCTION public.get_observation_annotations(uuid[]) IS
  'Status indicators for observations the caller can read: own-organisation of-interest flag, platform H&S concern (hazard flag or recorded hs_concern update), notice issued on this observation, prior notices for the plate/vehicle, open follow-up and update count.';

-- 4. Full-text activity search --------------------------------------------------
CREATE OR REPLACE FUNCTION public.location_event_search_text(p_event_type text, p_payload jsonb)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $function$ SELECT coalesce(p_event_type, '') || ' ' || coalesce(p_payload::text, '') $function$;

CREATE OR REPLACE FUNCTION public.observation_search_text(
  p_plate text, p_notes text, p_reported_by text, p_document text, p_reference text,
  p_reason text, p_subject_kind text, p_make text, p_model text, p_colour text, p_external_refs jsonb
) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $function$
  SELECT coalesce(p_plate, '') || ' ' || coalesce(p_notes, '') || ' ' || coalesce(p_reported_by, '') || ' '
    || coalesce(p_document, '') || ' ' || coalesce(p_reference, '') || ' ' || coalesce(p_reason, '') || ' '
    || coalesce(p_subject_kind, '') || ' ' || coalesce(p_make, '') || ' ' || coalesce(p_model, '') || ' '
    || coalesce(p_colour, '') || ' ' || coalesce(p_external_refs::text, '')
$function$;

CREATE INDEX IF NOT EXISTS location_events_search_trgm_idx ON public.location_events
  USING gin (public.location_event_search_text(event_type, payload) extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS observations_search_trgm_idx ON public.observations
  USING gin (public.observation_search_text(plate_number, officer_notes, reported_by_name, source_document_name,
    source_reference, compliance_reason, subject_kind, vehicle_make, vehicle_model, vehicle_colour, external_refs) extensions.gin_trgm_ops);

CREATE OR REPLACE FUNCTION public.search_activity_records(
  p_kind text, p_zone_ids uuid[], p_site_ids uuid[], p_term text,
  p_from timestamptz DEFAULT NULL, p_to timestamptz DEFAULT NULL,
  p_limit integer DEFAULT 50, p_offset integer DEFAULT 0
) RETURNS TABLE(record jsonb, total_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_term text := trim(coalesce(p_term, ''));
  v_pattern text;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF length(v_term) < 2 THEN RAISE EXCEPTION 'Enter at least 2 characters to search'; END IF;
  v_pattern := '%' || replace(replace(replace(v_term, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  IF p_kind = 'visits' THEN
    RETURN QUERY
    WITH candidates AS (
      SELECT e.id FROM public.location_events e
      WHERE public.location_event_search_text(e.event_type, e.payload) ILIKE v_pattern
      UNION
      SELECT r.record_id FROM public.record_updates r WHERE r.record_kind = 'location_event' AND r.body ILIKE v_pattern
      UNION
      SELECT e.id FROM public.location_events e
      JOIN public.user_profiles u ON u.id = e.observed_entity_id
      WHERE u.display_name ILIKE v_pattern
    ), matched AS (
      SELECT e.* FROM candidates c JOIN public.location_events e ON e.id = c.id
      WHERE (e.zone_id = ANY(coalesce(p_zone_ids, '{}')) OR e.client_site_id = ANY(coalesce(p_site_ids, '{}')))
        AND (p_from IS NULL OR e.occurred_at >= p_from) AND (p_to IS NULL OR e.occurred_at < p_to)
        AND (public.org_access_allowed(e.organization_id) OR public.has_location_access(e.client_site_id, e.zone_id, 'client_reads_provider'))
    )
    SELECT jsonb_build_object('id', m.id, 'organization_id', m.organization_id, 'event_type', m.event_type,
        'occurred_at', m.occurred_at, 'module_key', m.module_key, 'source', m.source, 'distance_km', m.distance_km,
        'zone_id', m.zone_id, 'client_site_id', m.client_site_id, 'observed_entity_id', m.observed_entity_id,
        'payload', m.payload),
      count(*) OVER ()
    FROM matched m ORDER BY m.occurred_at DESC LIMIT v_limit OFFSET v_offset;
  ELSIF p_kind = 'sightings' THEN
    RETURN QUERY
    WITH candidates AS (
      SELECT o.id FROM public.observations o
      WHERE public.observation_search_text(o.plate_number, o.officer_notes, o.reported_by_name, o.source_document_name,
        o.source_reference, o.compliance_reason, o.subject_kind, o.vehicle_make, o.vehicle_model, o.vehicle_colour, o.external_refs) ILIKE v_pattern
      UNION
      SELECT r.record_id FROM public.record_updates r WHERE r.record_kind = 'observation' AND r.body ILIKE v_pattern
      UNION
      SELECT o.id FROM public.observations o JOIN public.person_records p ON p.id = o.person_record_id
      WHERE p.display_name ILIKE v_pattern
      UNION
      SELECT o.id FROM public.observations o JOIN public.user_profiles u ON u.id = o.officer_id
      WHERE u.display_name ILIKE v_pattern
    ), matched AS (
      SELECT o.* FROM candidates c JOIN public.observations o ON o.id = c.id
      WHERE (o.zone_id = ANY(coalesce(p_zone_ids, '{}')) OR o.site_id = ANY(coalesce(p_site_ids, '{}')))
        AND (p_from IS NULL OR o.observed_at >= p_from) AND (p_to IS NULL OR o.observed_at < p_to)
        AND (public.org_access_allowed(o.organization_id) OR public.org_access_allowed(o.client_org_id)
          OR public.user_has_task_entitlement(v_uid, o.id))
    )
    SELECT jsonb_build_object('id', m.id, 'organization_id', m.organization_id, 'observed_at', m.observed_at,
        'plate_number', m.plate_number, 'officer_id', m.officer_id, 'zone_id', m.zone_id, 'site_id', m.site_id,
        'distance_km', m.distance_km, 'officer_notes', m.officer_notes, 'is_compliant', m.is_compliant,
        'compliance_reason', m.compliance_reason, 'canonical_vehicle_id', m.canonical_vehicle_id,
        'canonical_person_id', m.canonical_person_id, 'person_record_id', m.person_record_id,
        'subject_kind', m.subject_kind, 'reported_by_name', m.reported_by_name,
        'source_document_name', m.source_document_name, 'source_reference', m.source_reference,
        'source_sha256', m.source_sha256, 'source_locator', m.source_locator,
        'person_record', (SELECT jsonb_build_object('display_name', p.display_name) FROM public.person_records p
          WHERE p.id = m.person_record_id AND public.org_access_allowed(p.organization_id)),
        'external_refs', m.external_refs),
      count(*) OVER ()
    FROM matched m ORDER BY m.observed_at DESC LIMIT v_limit OFFSET v_offset;
  ELSE
    RAISE EXCEPTION 'Unsupported record kind';
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.search_activity_records(text,uuid[],uuid[],text,timestamptz,timestamptz,integer,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.search_activity_records(text,uuid[],uuid[],text,timestamptz,timestamptz,integer,integer) TO authenticated;
COMMENT ON FUNCTION public.search_activity_records(text,uuid[],uuid[],text,timestamptz,timestamptz,integer,integer) IS
  'Full-text search of patrol visits (every payload field) or vehicle sightings (plate, notes, reporter, source, reason, vehicle, imported fields, person name, officer name) plus appended record updates, across all dates unless a window is given. Restricted to the requested places and the same row access as the table policies.';
