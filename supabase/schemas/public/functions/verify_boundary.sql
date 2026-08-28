create or replace function public.verify_boundary (
  p_entity_type text,
  p_entity_id   uuid
)
  returns boolean
  language plpgsql
  security definer
  AS $function$
DECLARE
  v_org_id   uuid;
  v_uid      uuid := auth.uid();
  v_boundary geometry;
  v_et       text;  -- normalised entity_type for history table
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'verify_boundary: not authenticated';
  END IF;

  IF p_entity_type = 'organization' THEN
    SELECT id, jurisdiction_geom INTO v_org_id, v_boundary
      FROM public.organizations WHERE id = p_entity_id;
    IF NOT FOUND THEN RETURN false; END IF;
    IF NOT is_admin_for_org(v_org_id) THEN
      RAISE EXCEPTION 'verify_boundary: access denied for organization %', p_entity_id;
    END IF;
    UPDATE public.organizations
       SET jurisdiction_verification = 'verified',
           jurisdiction_verified_by  = v_uid,
           jurisdiction_verified_at  = now()
     WHERE id = p_entity_id;
    v_et := 'organization';

  ELSIF p_entity_type = 'location_zone' THEN
    SELECT organization_id, boundary INTO v_org_id, v_boundary
      FROM public.location_zones WHERE id = p_entity_id;
    IF NOT FOUND THEN RETURN false; END IF;
    IF NOT is_admin_for_org(v_org_id) THEN
      RAISE EXCEPTION 'verify_boundary: access denied for location_zone %', p_entity_id;
    END IF;
    UPDATE public.location_zones
       SET boundary_verification = 'verified',
           boundary_verified_by  = v_uid,
           boundary_verified_at  = now()
     WHERE id = p_entity_id;
    v_et := 'location_zone';

  ELSIF p_entity_type = 'client_site' THEN
    SELECT client_organization_id, boundary INTO v_org_id, v_boundary
      FROM public.client_sites WHERE id = p_entity_id;
    IF NOT FOUND THEN RETURN false; END IF;
    IF NOT org_access_allowed(v_org_id) THEN
      RAISE EXCEPTION 'verify_boundary: access denied for client_site %', p_entity_id;
    END IF;
    UPDATE public.client_sites
       SET boundary_verification = 'verified',
           boundary_verified_by  = v_uid,
           boundary_verified_at  = now()
     WHERE id = p_entity_id;
    v_et := 'client_site';

  ELSIF p_entity_type = 'patrol_checkpoint' THEN
    -- Checkpoints are NOT in the boundary history table (point geometry,
    -- not polygon boundary). Still update verification state but skip history.
    SELECT organization_id INTO v_org_id
      FROM public.patrol_checkpoints WHERE id = p_entity_id;
    IF NOT FOUND THEN RETURN false; END IF;
    IF NOT is_admin_for_org(v_org_id) THEN
      RAISE EXCEPTION 'verify_boundary: access denied for patrol_checkpoint %', p_entity_id;
    END IF;
    UPDATE public.patrol_checkpoints
       SET checkpoint_verification = 'verified',
           checkpoint_verified_by  = v_uid,
           checkpoint_verified_at  = now()
     WHERE id = p_entity_id;
    RETURN true;  -- early return, no history row for checkpoints

  ELSE
    RAISE EXCEPTION 'verify_boundary: unknown entity_type "%"', p_entity_type;
  END IF;

  -- Record the verification event in history
  INSERT INTO public.geofence_boundary_history (
    entity_type, entity_id, boundary, boundary_source,
    verification_state, verified_by, verified_at,
    changed_by, changed_via, change_reason, version
  ) VALUES (
    v_et, p_entity_id, v_boundary, NULL,
    'verified', v_uid, now(),
    v_uid, 'verification', 'Boundary verified via visual map confirmation',
    public._gbh_next_version(v_et, p_entity_id)
  );

  RETURN true;
END;
$function$;

grant execute on function "public"."verify_boundary"(text, uuid) to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."verify_boundary"(text, uuid) is 'Sets the verification state of a geofence-bearing entity to verified. Records a history row for the unverified->verified transition. Gated by org_access_allowed / is_admin_for_org. Phase 1A+4 (#226).';
