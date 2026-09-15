-- Geofence verification hardening (GEOFENCE_PRINCIPLES P1/P2; follows the
-- workbench engine 20260914004000, applied live by the geofence session).
--
-- Defect: verify_boundary marked a site/zone/organisation 'verified' without
-- checking that any geometry existed or was valid, so "no geofence" could be
-- certified as "verified" — the exact collapse P1 forbids. It also ran as
-- SECURITY DEFINER without a pinned search_path and was executable by anon, as
-- were the internal version helper and the history reader.
--
-- Additive re-issue: identical signature and return; same history discipline.

CREATE OR REPLACE FUNCTION public.verify_boundary(p_entity_type text, p_entity_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org_id   uuid;
  v_uid      uuid := auth.uid();
  v_boundary geometry;
  v_et       text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'verify_boundary: not authenticated'; END IF;

  IF p_entity_type = 'organization' THEN
    SELECT id, jurisdiction_geom INTO v_org_id, v_boundary FROM public.organizations WHERE id = p_entity_id;
    IF NOT FOUND THEN RETURN false; END IF;
    IF NOT public.is_admin_for_org(v_org_id) THEN RAISE EXCEPTION 'verify_boundary: access denied for organization %', p_entity_id; END IF;
    v_et := 'organization';
  ELSIF p_entity_type = 'location_zone' THEN
    SELECT organization_id, boundary INTO v_org_id, v_boundary FROM public.location_zones WHERE id = p_entity_id;
    IF NOT FOUND THEN RETURN false; END IF;
    IF NOT public.is_admin_for_org(v_org_id) THEN RAISE EXCEPTION 'verify_boundary: access denied for location_zone %', p_entity_id; END IF;
    v_et := 'location_zone';
  ELSIF p_entity_type = 'client_site' THEN
    SELECT client_organization_id, boundary INTO v_org_id, v_boundary FROM public.client_sites WHERE id = p_entity_id;
    IF NOT FOUND THEN RETURN false; END IF;
    IF NOT public.org_access_allowed(v_org_id) THEN RAISE EXCEPTION 'verify_boundary: access denied for client_site %', p_entity_id; END IF;
    v_et := 'client_site';
  ELSIF p_entity_type = 'patrol_checkpoint' THEN
    -- Tier 4 is a point + radius. Same P1 rule: nothing is certified without geometry (Q4: versioned too).
    SELECT organization_id,
           CASE WHEN gps_lat IS NOT NULL AND gps_lng IS NOT NULL AND coalesce(radius_meters, 0) > 0
                THEN ST_Buffer(ST_SetSRID(ST_MakePoint(gps_lng, gps_lat), 4326)::geography, radius_meters)::geometry END
      INTO v_org_id, v_boundary
      FROM public.patrol_checkpoints WHERE id = p_entity_id;
    IF NOT FOUND THEN RETURN false; END IF;
    IF NOT public.is_admin_for_org(v_org_id) THEN RAISE EXCEPTION 'verify_boundary: access denied for patrol_checkpoint %', p_entity_id; END IF;
    v_et := 'patrol_checkpoint';
  ELSE
    RAISE EXCEPTION 'verify_boundary: unknown entity_type "%"', p_entity_type;
  END IF;

  -- P1: "no geofence" and "geometry invalid" are distinct answers and neither can be certified.
  IF v_boundary IS NULL OR ST_IsEmpty(v_boundary) THEN
    RAISE EXCEPTION 'verify_boundary: % % has no boundary geometry to verify (unresolved_no_geofence)', v_et, p_entity_id;
  END IF;
  IF NOT ST_IsValid(v_boundary) THEN
    RAISE EXCEPTION 'verify_boundary: % % boundary geometry is invalid; redraw or re-import before verifying (unresolved_invalid)', v_et, p_entity_id;
  END IF;

  IF v_et = 'organization' THEN
    UPDATE public.organizations SET jurisdiction_verification = 'verified', jurisdiction_verified_by = v_uid, jurisdiction_verified_at = now() WHERE id = p_entity_id;
  ELSIF v_et = 'location_zone' THEN
    UPDATE public.location_zones SET boundary_verification = 'verified', boundary_verified_by = v_uid, boundary_verified_at = now() WHERE id = p_entity_id;
  ELSIF v_et = 'patrol_checkpoint' THEN
    UPDATE public.patrol_checkpoints SET checkpoint_verification = 'verified', checkpoint_verified_by = v_uid, checkpoint_verified_at = now() WHERE id = p_entity_id;
  ELSE
    UPDATE public.client_sites SET boundary_verification = 'verified', boundary_verified_by = v_uid, boundary_verified_at = now() WHERE id = p_entity_id;
  END IF;

  INSERT INTO public.geofence_boundary_history (
    entity_type, entity_id, boundary, boundary_source, verification_state, verified_by, verified_at,
    changed_by, changed_via, change_reason, version
  ) VALUES (
    v_et, p_entity_id, v_boundary, NULL, 'verified', v_uid, now(),
    v_uid, 'verification', 'Boundary verified via visual map confirmation', public._gbh_next_version(v_et, p_entity_id)
  );
  RETURN true;
END;
$$;
COMMENT ON FUNCTION public.verify_boundary(text, uuid) IS
  'Sets the verification state of a geofence-bearing entity to verified after a human visual map confirmation. Refuses when no geometry exists or the geometry is invalid (P1: distinct answers, never certified). Records a history row. Checkpoints: state only.';

REVOKE ALL ON FUNCTION public.verify_boundary(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_boundary(text, uuid) TO authenticated, service_role;

-- Internal version counter: only the SECURITY DEFINER writers call it.
REVOKE ALL ON FUNCTION public._gbh_next_version(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._gbh_next_version(text, uuid) TO service_role;

-- History reader is org-access gated inside; still never for anon.
REVOKE ALL ON FUNCTION public.get_boundary_history(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_boundary_history(text, uuid) TO authenticated, service_role;
