create or replace function public.set_site_geometry (
  p_site_id              uuid,
  p_boundary             jsonb            default null::jsonb,
  p_center_lat           double precision default null::double precision,
  p_center_lng           double precision default null::double precision,
  p_provisional_radius_m double precision default 50,
  p_boundary_source      text             default null::text,
  p_changed_by           uuid             default null::uuid,
  p_changed_via          text             default 'governed_proposal'::text
)
  returns numeric
  language plpgsql
  security definer
  AS $function$
DECLARE
  v_boundary   geometry;
  v_center     geometry;
  v_area_m2    numeric;
  v_source     text;
  v_via        text;
BEGIN
  IF p_boundary IS NOT NULL THEN
    v_boundary := st_makevalid(st_setsrid(st_geomfromgeojson(p_boundary::text), 4326));
    IF v_boundary IS NULL THEN
      RAISE EXCEPTION 'set_site_geometry: could not build geometry from p_boundary GeoJSON';
    END IF;
    IF geometrytype(v_boundary) <> 'POLYGON' THEN
      v_boundary := st_convexhull(v_boundary);
    END IF;
    -- Polygon path: use caller-supplied source, else 'UNKNOWN_SOURCE' (P1).
    v_source := COALESCE(NULLIF(TRIM(p_boundary_source), ''), 'UNKNOWN_SOURCE');
  ELSIF p_center_lat IS NOT NULL AND p_center_lng IS NOT NULL THEN
    v_boundary := st_setsrid(
      st_buffer(
        st_setsrid(st_makepoint(p_center_lng, p_center_lat), 4326)::geography,
        greatest(coalesce(p_provisional_radius_m, 50), 1)
      )::geometry,
      4326
    );
    IF geometrytype(v_boundary) <> 'POLYGON' THEN
      v_boundary := st_convexhull(v_boundary);
    END IF;
    -- Point-radius path: source is always 'point_radius' regardless of caller.
    v_source := 'point_radius';
  ELSE
    RAISE EXCEPTION 'set_site_geometry: supply either p_boundary (GeoJSON polygon) or p_center_lat + p_center_lng (provisional point)';
  END IF;

  v_center  := st_centroid(v_boundary);
  v_area_m2 := st_area(v_boundary::geography);

  UPDATE public.client_sites
     SET boundary     = v_boundary,
         center_point = v_center
   WHERE id = p_site_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'set_site_geometry: site % not found', p_site_id;
  END IF;

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
    'client_site', p_site_id, v_boundary, v_source,
    'unverified', NULL, NULL,
    p_changed_by, v_via, 'Site geometry set via set_site_geometry',
    public._gbh_next_version('client_site', p_site_id)
  );

  RETURN v_area_m2;
END;
$function$;

grant execute
  on function "public"."set_site_geometry"(uuid, jsonb, double precision, double precision, double precision, text, uuid, text)
  to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."set_site_geometry"(uuid, jsonb, double precision, double precision, double precision, text, uuid, text) is 'Writes client_sites.boundary (GeoJSON polygon with ST_MakeValid, or a buffered provisional point) and center_point = ST_Centroid(boundary). Returns area in m^2. Records a history row with real provenance. Phase 1+4 geofence redesign (#226).';
