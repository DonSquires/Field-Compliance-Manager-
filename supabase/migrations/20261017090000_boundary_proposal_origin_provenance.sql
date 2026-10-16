-- Keep the true origin of a boundary proposal. The place map ('house_map') and the canonical
-- place seed ('canonical_place_seed') were silently relabelled 'workbench', so the audit trail
-- could not show where a human-drawn or replaced boundary actually came from.
ALTER TABLE public.boundary_proposals DROP CONSTRAINT IF EXISTS boundary_proposals_proposed_via_check;
ALTER TABLE public.boundary_proposals ADD CONSTRAINT boundary_proposals_proposed_via_check
  CHECK (proposed_via = ANY (ARRAY['workbench'::text, 'batch'::text, 'bob'::text, 'house_map'::text, 'canonical_place_seed'::text]));

CREATE OR REPLACE FUNCTION "public"."propose_boundary"(p_organization_id uuid, p_entity_type text, p_entity_id uuid, p_geojson jsonb, p_source text, p_source_ref jsonb DEFAULT '{}'::jsonb, p_address_candidate jsonb DEFAULT NULL::jsonb, p_zone_type text DEFAULT NULL::text, p_proposed_via text DEFAULT 'workbench'::text)
 RETURNS TABLE(proposal_id uuid, area_m2 numeric, gate_ok boolean, gate_reason text, drift_from_current_m double precision, current_has_boundary boolean, proposed_geojson jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_geom geometry;
  v_area numeric;
  v_gate record;
  v_current geometry;
  v_drift double precision;
  v_zone_type text := p_zone_type;
  v_row public.boundary_proposals%rowtype;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF NOT public.is_admin_for_org(p_organization_id) AND NOT public.org_access_allowed(p_organization_id) THEN
    RAISE EXCEPTION 'Organization access denied';
  END IF;
  IF p_entity_type NOT IN ('client_site','location_zone','organization','patrol_checkpoint') THEN
    RAISE EXCEPTION 'Unsupported entity_type %', p_entity_type;
  END IF;

  v_geom := ST_Multi(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(p_geojson::text), 4326)));
  IF v_geom IS NULL OR ST_IsEmpty(v_geom) OR NOT ST_IsValid(v_geom) THEN
    RAISE EXCEPTION 'Proposed geometry is empty or invalid';
  END IF;
  IF GeometryType(v_geom) <> 'MULTIPOLYGON' THEN
    RAISE EXCEPTION 'Proposed geometry must be a polygon, got %', GeometryType(v_geom);
  END IF;
  v_area := ST_Area(v_geom::geography);

  IF p_entity_id IS NOT NULL THEN
    IF p_entity_type = 'client_site' THEN
      SELECT boundary INTO v_current FROM public.client_sites WHERE id = p_entity_id;
      v_zone_type := coalesce(v_zone_type, 'site');
    ELSIF p_entity_type = 'location_zone' THEN
      SELECT boundary, coalesce(v_zone_type, zone_type) INTO v_current, v_zone_type FROM public.location_zones WHERE id = p_entity_id;
    ELSIF p_entity_type = 'organization' THEN
      SELECT jurisdiction_geom INTO v_current FROM public.organizations WHERE id = p_entity_id;
      v_zone_type := coalesce(v_zone_type, 'jurisdiction');
    END IF;
    IF v_current IS NOT NULL THEN
      v_drift := ST_HausdorffDistance(ST_Transform(ST_SetSRID(v_current::geometry, 4326), 2193), ST_Transform(ST_SetSRID(v_geom::geometry, 4326), 2193));
    END IF;
  ELSE
    v_zone_type := coalesce(v_zone_type, CASE p_entity_type WHEN 'client_site' THEN 'site' WHEN 'organization' THEN 'jurisdiction' END);
  END IF;

  SELECT * INTO v_gate FROM public.geofence_area_gate(v_area, v_zone_type);

  -- Any older open proposal for the same entity is superseded by this one.
  IF p_entity_id IS NOT NULL THEN
    UPDATE public.boundary_proposals SET status = 'superseded', decided_at = clock_timestamp()
    WHERE entity_type = p_entity_type AND entity_id = p_entity_id AND status = 'proposed';
  END IF;

  INSERT INTO public.boundary_proposals (
    organization_id, entity_type, entity_id, proposed_boundary, center_point, area_m2,
    source, source_ref, address_candidate, zone_type, gate_ok, gate_reason,
    drift_from_current_m, proposed_by, proposed_via
  ) VALUES (
    p_organization_id, p_entity_type, p_entity_id, v_geom, ST_Centroid(v_geom), v_area,
    p_source, coalesce(p_source_ref, '{}'::jsonb), p_address_candidate, v_zone_type, v_gate.ok, v_gate.reason,
    v_drift, v_actor, CASE WHEN p_proposed_via IN ('workbench','batch','bob','house_map','canonical_place_seed') THEN p_proposed_via ELSE 'workbench' END
  ) RETURNING * INTO v_row;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (p_organization_id, v_actor, 'boundary_proposed', 'boundary_proposals', v_row.id,
    jsonb_build_object('entity_type', p_entity_type, 'entity_id', p_entity_id, 'source', p_source,
      'area_m2', round(v_area), 'gate_ok', v_gate.ok, 'gate_reason', v_gate.reason, 'drift_m', v_drift));

  RETURN QUERY SELECT v_row.id, v_area, v_gate.ok, v_gate.reason, v_drift, v_current IS NOT NULL, ST_AsGeoJSON(v_geom)::jsonb;
END;
$function$;
