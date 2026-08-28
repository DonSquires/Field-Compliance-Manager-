create or replace function public.set_zone_geometry (
  p_zone_id              uuid,
  p_center_lat           double precision,
  p_center_lng           double precision,
  p_provisional_radius_m double precision default 100,
  p_boundary_source      text             default null::text,
  p_changed_by           uuid             default null::uuid,
  p_changed_via          text             default 'governed_proposal'::text
)
  returns numeric
  language plpgsql
  security definer
  set search_path to 'public'
  AS $function$
DECLARE
  v_point   geometry;
  v_buffer  geometry;
  v_area_m2 numeric;
  v_source  text;
  v_via     text;
BEGIN
  IF p_center_lat IS NULL OR p_center_lng IS NULL THEN
    RAISE EXCEPTION 'set_zone_geometry: p_center_lat and p_center_lng are required for provisional fence';
  END IF;

  v_point  := st_setsrid(st_point(p_center_lng, p_center_lat), 4326);
  v_buffer := st_transform(
                st_buffer(
                  st_transform(v_point, 2193),
                  coalesce(p_provisional_radius_m, 100)
                ),
                4326
              );

  v_buffer  := st_multi(v_buffer);
  v_area_m2 := st_area(v_buffer::geography);

  UPDATE location_zones
     SET boundary     = v_buffer,
         center_point = v_point
   WHERE id = p_zone_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'set_zone_geometry: zone % not found', p_zone_id;
  END IF;

  -- Point-radius path: source is always 'point_radius' regardless of caller,
  -- unless the caller explicitly overrides (unlikely but supported).
  v_source := COALESCE(NULLIF(TRIM(p_boundary_source), ''), 'point_radius');

  -- Resolve changed_via: validate against the CHECK constraint values.
  v_via := CASE
    WHEN p_changed_via IN ('governed_proposal', 'direct_edit', 'reconciliation', 'refresh', 'verification', 'backfill')
    THEN p_changed_via
    ELSE 'governed_proposal'
  END;

  -- Record history
  INSERT INTO public.geofence_boundary_history (
    entity_type, entity_id, boundary, boundary_source,
    verification_state, verified_by, verified_at,
    changed_by, changed_via, change_reason, version
  ) VALUES (
    'location_zone', p_zone_id, v_buffer, v_source,
    'unverified', NULL, NULL,
    p_changed_by, v_via, 'Zone geometry set via set_zone_geometry (provisional point)',
    public._gbh_next_version('location_zone', p_zone_id)
  );

  RETURN v_area_m2;
END;
$function$;

create or replace function public.set_zone_geometry (
  p_zone_id         uuid,
  p_polygons        jsonb,
  p_boundary_source text  default null::text,
  p_changed_by      uuid  default null::uuid,
  p_changed_via     text  default 'governed_proposal'::text
)
  returns numeric
  language plpgsql
  security definer
  set search_path to 'public'
  AS $function$
DECLARE
  v_geom    geometry;
  v_center  geometry;
  v_area_m2 numeric;
  v_source  text;
  v_via     text;
BEGIN
  IF p_polygons IS NULL OR jsonb_array_length(p_polygons) = 0 THEN
    RAISE EXCEPTION 'set_zone_geometry: p_polygons must be a non-empty JSON array';
  END IF;

  SELECT st_union(array_agg(st_makevalid(st_setsrid(st_geomfromgeojson(elem::text), 4326))))
    INTO v_geom
    FROM jsonb_array_elements(p_polygons) AS elem;

  IF v_geom IS NULL OR st_isempty(v_geom) THEN
    RAISE EXCEPTION 'set_zone_geometry: could not build geometry from supplied polygons';
  END IF;

  v_geom := st_multi(st_makevalid(v_geom));

  IF NOT st_isvalid(v_geom) THEN
    RAISE EXCEPTION 'set_zone_geometry: geometry still invalid after ST_MakeValid: %', st_isvalidreason(v_geom);
  END IF;

  v_center  := st_centroid(v_geom);
  v_area_m2 := st_area(v_geom::geography);

  UPDATE location_zones
     SET boundary     = v_geom,
         center_point = v_center
   WHERE id = p_zone_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'set_zone_geometry: zone % not found', p_zone_id;
  END IF;

  -- Resolve provenance: use caller-supplied source, else 'UNKNOWN_SOURCE' (P1).
  v_source := COALESCE(NULLIF(TRIM(p_boundary_source), ''), 'UNKNOWN_SOURCE');

  -- Resolve changed_via: validate against the CHECK constraint values.
  v_via := CASE
    WHEN p_changed_via IN ('governed_proposal', 'direct_edit', 'reconciliation', 'refresh', 'verification', 'backfill')
    THEN p_changed_via
    ELSE 'governed_proposal'
  END;

  -- Record history
  INSERT INTO public.geofence_boundary_history (
    entity_type, entity_id, boundary, boundary_source,
    verification_state, verified_by, verified_at,
    changed_by, changed_via, change_reason, version
  ) VALUES (
    'location_zone', p_zone_id, v_geom, v_source,
    'unverified', NULL, NULL,
    p_changed_by, v_via, 'Zone geometry set via set_zone_geometry (polygon)',
    public._gbh_next_version('location_zone', p_zone_id)
  );

  RETURN v_area_m2;
END;
$function$;

grant execute
  on function "public"."set_zone_geometry"(uuid, double precision, double precision, double precision, text, uuid, text)
  to public, "anon", "authenticated", "postgres", "service_role";

grant execute on function "public"."set_zone_geometry"(uuid, jsonb, text, uuid, text) to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."set_zone_geometry"(uuid, double precision, double precision, double precision, text, uuid, text) is 'Writes a provisional circular boundary from a GPS point + radius (NZTM2000 metric buffer, wrapped as MultiPolygon) and returns its area (m^2). Records a history row with real provenance. Phase 1+4 geofence redesign (#226).';

comment on function "public"."set_zone_geometry"(uuid, jsonb, text, uuid, text) is 'Writes a zone boundary from a GeoJSON polygon array (union, ST_MakeValid, MultiPolygon) and returns its real area (m^2). Records a history row with real provenance. Phase 1+4 geofence redesign (#226).';
