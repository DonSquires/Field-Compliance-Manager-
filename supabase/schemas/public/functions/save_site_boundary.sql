create or replace function public.save_site_boundary (
  p_site_id      uuid,
  p_org_id       uuid,
  p_geojson      text,
  p_centroid_lat double precision,
  p_centroid_lng double precision
)
  returns void
  language plpgsql
  security definer
  AS $function$
DECLARE
  v_boundary geometry;
  v_uid      uuid := auth.uid();
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.client_sites s
    WHERE s.id = p_site_id
      AND org_access_allowed(s.client_organization_id)
  ) THEN
    RAISE EXCEPTION 'Site not found or access denied';
  END IF;

  v_boundary := st_makevalid(st_setsrid(st_geomfromgeojson(p_geojson), 4326));

  UPDATE public.client_sites
  SET
    boundary     = v_boundary,
    center_point = st_setsrid(st_makepoint(p_centroid_lng, p_centroid_lat), 4326)
  WHERE id = p_site_id;

  -- Record history (browser editor = direct_edit, source = user_drawn)
  INSERT INTO public.geofence_boundary_history (
    entity_type, entity_id, boundary, boundary_source,
    verification_state, verified_by, verified_at,
    changed_by, changed_via, change_reason, version
  ) VALUES (
    'client_site', p_site_id, v_boundary, 'user_drawn',
    'unverified', NULL, NULL,
    v_uid, 'direct_edit', 'Site boundary saved via browser editor',
    public._gbh_next_version('client_site', p_site_id)
  );
END;
$function$;

grant execute on function "public"."save_site_boundary"(uuid, uuid, text, double precision, double precision) to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."save_site_boundary"(uuid, uuid, text, double precision, double precision) is 'Saves a GeoJSON polygon as PostGIS geometry on client_sites with ST_MakeValid. Records a history row. Used by SiteBoundaryEditor. Phase 4 geofence redesign (#226).';
