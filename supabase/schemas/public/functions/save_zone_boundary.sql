create or replace function public.save_zone_boundary (
  p_zone_id      uuid,
  p_org_id       uuid,
  p_geojson      text,
  p_centroid_lat double precision,
  p_centroid_lng double precision
)
  returns numeric
  language plpgsql
  security definer
  AS $function$
DECLARE
  v_geom    geometry;
  v_area_m2 numeric;
  v_uid     uuid := auth.uid();
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM location_zones
    WHERE id = p_zone_id AND organization_id = p_org_id
  ) THEN
    RAISE EXCEPTION 'Zone not found or access denied';
  END IF;

  v_geom    := st_multi(st_makevalid(st_setsrid(st_geomfromgeojson(p_geojson), 4326)));
  v_area_m2 := st_area(v_geom::geography);

  UPDATE location_zones
  SET
    boundary     = v_geom,
    center_point = st_setsrid(st_makepoint(p_centroid_lng, p_centroid_lat), 4326)
  WHERE
    id = p_zone_id
    AND organization_id = p_org_id;

  -- Record history (browser editor = direct_edit, source = user_drawn)
  INSERT INTO public.geofence_boundary_history (
    entity_type, entity_id, boundary, boundary_source,
    verification_state, verified_by, verified_at,
    changed_by, changed_via, change_reason, version
  ) VALUES (
    'location_zone', p_zone_id, v_geom, 'user_drawn',
    'unverified', NULL, NULL,
    v_uid, 'direct_edit', 'Zone boundary saved via browser editor',
    public._gbh_next_version('location_zone', p_zone_id)
  );

  RETURN v_area_m2;
END;
$function$;

grant execute on function "public"."save_zone_boundary"(uuid, uuid, text, double precision, double precision) to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."save_zone_boundary"(uuid, uuid, text, double precision, double precision) is 'Saves a GeoJSON polygon as PostGIS MultiPolygon geometry (ST_MakeValid + ST_Multi) on location_zones and returns its real area (m^2). Records a history row. Phase 1+4 geofence redesign (#226).';
