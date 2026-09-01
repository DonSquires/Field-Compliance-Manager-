create or replace function public.get_boundary_history (
  p_entity_type text,
  p_entity_id   uuid
)
  returns table (
    id                 uuid,
    entity_type        text,
    entity_id          uuid,
    boundary_source    text,
    verification_state text,
    verified_by        uuid,
    verified_at        timestamp with time zone,
    changed_by         uuid,
    changed_via        text,
    change_reason      text,
    version            integer,
    created_at         timestamp with time zone,
    has_boundary       boolean
  )
  language plpgsql
  stable
  security definer
  AS $function$
DECLARE
  v_org_id uuid;
BEGIN
  -- Org-access gate: verify the caller can access this entity's org
  IF p_entity_type = 'organization' THEN
    IF NOT org_access_allowed(p_entity_id) THEN
      RAISE EXCEPTION 'get_boundary_history: access denied for organization %', p_entity_id;
    END IF;
  ELSIF p_entity_type = 'location_zone' THEN
    SELECT z.organization_id INTO v_org_id
      FROM public.location_zones z WHERE z.id = p_entity_id;
    IF NOT FOUND OR NOT org_access_allowed(v_org_id) THEN
      RAISE EXCEPTION 'get_boundary_history: access denied for location_zone %', p_entity_id;
    END IF;
  ELSIF p_entity_type = 'client_site' THEN
    SELECT s.client_organization_id INTO v_org_id
      FROM public.client_sites s WHERE s.id = p_entity_id;
    IF NOT FOUND OR NOT org_access_allowed(v_org_id) THEN
      RAISE EXCEPTION 'get_boundary_history: access denied for client_site %', p_entity_id;
    END IF;
  ELSE
    RAISE EXCEPTION 'get_boundary_history: unknown entity_type "%"', p_entity_type;
  END IF;

  -- Return history ordered newest-first.
  -- The boundary geometry column is NOT returned directly (it can be very
  -- large). Instead, has_boundary indicates whether a geometry was recorded.
  -- A future UI can fetch the full geometry for a specific version if needed.
  RETURN QUERY
    SELECT
      h.id,
      h.entity_type,
      h.entity_id,
      h.boundary_source,
      h.verification_state,
      h.verified_by,
      h.verified_at,
      h.changed_by,
      h.changed_via,
      h.change_reason,
      h.version,
      h.created_at,
      (h.boundary IS NOT NULL) AS has_boundary
    FROM public.geofence_boundary_history h
    WHERE h.entity_type = p_entity_type
      AND h.entity_id   = p_entity_id
    ORDER BY h.created_at DESC, h.version DESC;
END;
$function$;

grant execute on function "public"."get_boundary_history"(text, uuid) to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."get_boundary_history"(text, uuid) is 'Returns the ordered boundary history for a geofence-bearing entity (newest first). Org-access-gated. Does not return the full geometry blob (has_boundary flag instead). Phase 4 geofence redesign (#226). A history-viewer UI is deferred to a fast-follow.';
