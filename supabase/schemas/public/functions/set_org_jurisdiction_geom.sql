create or replace function public.set_org_jurisdiction_geom (
  p_org_id          uuid,
  p_polygons        jsonb,
  p_boundary_source text  default null::text,
  p_changed_by      uuid  default null::uuid,
  p_changed_via     text  default 'governed_proposal'::text
)
  returns numeric
  language plpgsql
  security definer
  AS $function$
DECLARE
  v_geom         geometry;
  v_area_m2      numeric;
  v_prev_geom    geometry;
  v_prev_verif   text;
  v_prev_vby     uuid;
  v_prev_vat     timestamptz;
  v_source       text;
  v_via          text;
BEGIN
  IF p_polygons IS NULL OR jsonb_typeof(p_polygons) <> 'array' OR jsonb_array_length(p_polygons) = 0 THEN
    RAISE EXCEPTION 'p_polygons must be a non-empty JSON array of GeoJSON geometries';
  END IF;

  SELECT st_multi(st_setsrid(st_makevalid(st_union(st_makevalid(st_geomfromgeojson(elem.value)))), 4326))
    INTO v_geom
    FROM jsonb_array_elements(p_polygons) AS elem;

  IF v_geom IS NULL THEN
    RAISE EXCEPTION 'Could not build geometry from supplied GeoJSON';
  END IF;

  IF st_isempty(v_geom) THEN
    RAISE EXCEPTION 'Geometry is empty after ST_MakeValid + ST_Union';
  END IF;

  IF NOT st_isvalid(v_geom) THEN
    RAISE EXCEPTION 'Geometry is still invalid after ST_MakeValid: %', st_isvalidreason(v_geom);
  END IF;

  v_area_m2 := st_area(v_geom::geography);

  -- Capture previous state for history BEFORE overwriting
  SELECT jurisdiction_geom, jurisdiction_verification,
         jurisdiction_verified_by, jurisdiction_verified_at
    INTO v_prev_geom, v_prev_verif, v_prev_vby, v_prev_vat
    FROM public.organizations
   WHERE id = p_org_id;

  -- Write the new geometry
  UPDATE public.organizations
     SET jurisdiction_geom = v_geom
   WHERE id = p_org_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Organization % not found', p_org_id;
  END IF;

  -- Resolve provenance: use caller-supplied source when provided,
  -- else fall back to 'UNKNOWN_SOURCE' (P1: loud, explicit).
  v_source := COALESCE(NULLIF(TRIM(p_boundary_source), ''), 'UNKNOWN_SOURCE');

  -- Resolve changed_via: validate against the CHECK constraint values.
  v_via := CASE
    WHEN p_changed_via IN ('governed_proposal', 'direct_edit', 'reconciliation', 'refresh', 'verification', 'backfill')
    THEN p_changed_via
    ELSE 'governed_proposal'
  END;

  -- Record history: snapshot of the NEW geometry with current state
  INSERT INTO public.geofence_boundary_history (
    entity_type, entity_id, boundary, boundary_source,
    verification_state, verified_by, verified_at,
    changed_by, changed_via, change_reason, version
  ) VALUES (
    'organization', p_org_id, v_geom, v_source,
    'unverified', NULL, NULL,
    p_changed_by, v_via, 'Jurisdiction geometry set via set_org_jurisdiction_geom',
    public._gbh_next_version('organization', p_org_id)
  );

  RETURN v_area_m2;
END;
$function$;

grant execute on function "public"."set_org_jurisdiction_geom"(uuid, jsonb, text, uuid, text) to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."set_org_jurisdiction_geom"(uuid, jsonb, text, uuid, text) is 'Writes organizations.jurisdiction_geom by ST_Union-ing an array of GeoJSON polygons into one MultiPolygon(4326) with ST_MakeValid. Returns the written area in m^2. Records a history row in geofence_boundary_history with real provenance. Phase 1+4 geofence redesign (#226).';
