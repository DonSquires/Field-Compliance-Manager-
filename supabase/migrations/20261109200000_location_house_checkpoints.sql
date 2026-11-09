CREATE OR REPLACE FUNCTION public.get_location_patrol_checkpoints(p_location_id uuid)
RETURNS TABLE(
  id uuid,
  location_id uuid,
  client_site_id uuid,
  zone_id uuid,
  name text,
  description text,
  gps_lat double precision,
  gps_lng double precision,
  radius_meters integer,
  qr_code text,
  active boolean,
  checkpoint_verification text,
  checkpoint_verified_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_provider uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT organization_id INTO v_provider
  FROM public.user_profiles WHERE id = v_actor AND deactivated_at IS NULL;
  IF v_provider IS NULL OR NOT public.is_admin_for_org(v_provider)
     OR NOT public.crm_actor_can_manage_location(p_location_id) THEN
    RAISE EXCEPTION 'Active authorised location administrator required';
  END IF;
  RETURN QUERY
  SELECT c.id, COALESCE(c.location_id, p_location_id), c.client_site_id, c.zone_id, c.name,
    c.description, c.gps_lat, c.gps_lng, c.radius_meters, c.qr_code, c.active,
    c.checkpoint_verification, c.checkpoint_verified_at
  FROM public.patrol_checkpoints c
  WHERE c.organization_id = v_provider
    AND (c.location_id = p_location_id
      OR EXISTS (SELECT 1 FROM public.client_sites s WHERE s.id = c.client_site_id AND s.location_id = p_location_id)
      OR EXISTS (SELECT 1 FROM public.location_zones z WHERE z.id = c.zone_id AND z.location_id = p_location_id))
  ORDER BY c.name;
END;
$$;

REVOKE ALL ON FUNCTION public.get_location_patrol_checkpoints(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_location_patrol_checkpoints(uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.get_location_patrol_checkpoints(uuid) IS
  'Reads only the current provider administrator''s checkpoints attached to a Location House that they are authorised to manage.';

CREATE OR REPLACE FUNCTION public.manage_location_patrol_checkpoint(
  p_client_request_id uuid,
  p_action text,
  p_organization_id uuid,
  p_location_id uuid,
  p_checkpoint_id uuid DEFAULT NULL,
  p_client_site_id uuid DEFAULT NULL,
  p_zone_id uuid DEFAULT NULL,
  p_name text DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_gps_lat double precision DEFAULT NULL,
  p_gps_lng double precision DEFAULT NULL,
  p_radius_meters integer DEFAULT NULL,
  p_qr_code text DEFAULT NULL
) RETURNS TABLE(
  id uuid,
  name text,
  location_id uuid,
  client_site_id uuid,
  zone_id uuid,
  gps_lat double precision,
  gps_lng double precision,
  radius_meters integer,
  checkpoint_verification text,
  active boolean,
  created boolean,
  geometry_changed boolean,
  history_version integer
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_location public.locations%rowtype;
  v_site public.client_sites%rowtype;
  v_zone public.location_zones%rowtype;
  v_checkpoint public.patrol_checkpoints%rowtype;
  v_provider uuid;
  v_name text := nullif(trim(coalesce(p_name, '')), '');
  v_radius integer;
  v_default_radius integer;
  v_version integer;
  v_changed boolean := false;
  v_action text := lower(trim(coalesce(p_action, '')));
BEGIN
  IF v_actor IS NULL OR p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'Authentication and client_request_id are required';
  END IF;
  SELECT organization_id INTO v_provider
  FROM public.user_profiles WHERE id = v_actor AND deactivated_at IS NULL;
  IF v_provider IS NULL OR p_organization_id IS NULL OR p_organization_id <> v_provider OR NOT public.is_admin_for_org(v_provider)
     OR NOT public.crm_actor_can_manage_location(p_location_id) THEN
    RAISE EXCEPTION 'Active authorised location administrator required';
  END IF;
  IF v_action NOT IN ('create', 'update', 'deactivate', 'reactivate') THEN
    RAISE EXCEPTION 'action must be create, update, deactivate or reactivate';
  END IF;
  IF p_gps_lat IS NOT NULL AND p_gps_lat NOT BETWEEN -90 AND 90 THEN
    RAISE EXCEPTION 'Checkpoint latitude must be between -90 and 90 degrees';
  END IF;
  IF p_gps_lng IS NOT NULL AND p_gps_lng NOT BETWEEN -180 AND 180 THEN
    RAISE EXCEPTION 'Checkpoint longitude must be between -180 and 180 degrees';
  END IF;
  IF p_radius_meters IS NOT NULL AND p_radius_meters <= 0 THEN
    RAISE EXCEPTION 'Checkpoint radius must be greater than zero';
  END IF;
  IF p_location_id IS NULL OR num_nonnulls(p_client_site_id, p_zone_id) <> 1 THEN
    RAISE EXCEPTION 'Select exactly one Site or Zone in this location';
  END IF;
  SELECT * INTO v_location FROM public.locations WHERE id = p_location_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Location not found'; END IF;

  IF p_client_site_id IS NOT NULL THEN
    SELECT * INTO v_site FROM public.client_sites
    WHERE id = p_client_site_id AND location_id = p_location_id;
    IF NOT FOUND OR NOT public.crm_actor_can_manage_account(v_site.client_organization_id) THEN
      RAISE EXCEPTION 'Site is not manageable in this location';
    END IF;
  ELSE
    SELECT * INTO v_zone FROM public.location_zones
    WHERE id = p_zone_id AND location_id = p_location_id;
    IF NOT FOUND OR v_zone.organization_id <> v_location.organization_id THEN
      RAISE EXCEPTION 'Zone is not part of this location';
    END IF;
  END IF;

  SELECT config_value INTO v_default_radius FROM public.org_geofence_config
  WHERE organization_id = v_provider AND config_key = 'checkpoint_radius_m' AND zone_type IS NULL LIMIT 1;
  v_default_radius := COALESCE(v_default_radius, 5);

  IF v_action = 'create' THEN
    SELECT * INTO v_checkpoint FROM public.patrol_checkpoints
    WHERE organization_id = v_provider AND client_request_id = p_client_request_id;
    IF FOUND THEN
      IF v_checkpoint.location_id <> p_location_id
         OR v_checkpoint.client_site_id IS DISTINCT FROM p_client_site_id
         OR v_checkpoint.zone_id IS DISTINCT FROM p_zone_id THEN
        RAISE EXCEPTION 'client_request_id was already used for another checkpoint';
      END IF;
      SELECT max(h.version) INTO v_version FROM public.geofence_boundary_history h
      WHERE h.entity_type = 'patrol_checkpoint' AND h.entity_id = v_checkpoint.id;
      RETURN QUERY SELECT v_checkpoint.id, v_checkpoint.name, v_checkpoint.location_id,
        v_checkpoint.client_site_id, v_checkpoint.zone_id, v_checkpoint.gps_lat, v_checkpoint.gps_lng,
        v_checkpoint.radius_meters, v_checkpoint.checkpoint_verification, v_checkpoint.active,
        false, false, v_version;
      RETURN;
    END IF;
    IF v_name IS NULL OR char_length(v_name) > 200 THEN
      RAISE EXCEPTION 'Checkpoint name is required and must be 200 characters or fewer';
    END IF;
    IF p_gps_lat IS NULL OR p_gps_lng IS NULL THEN
      RAISE EXCEPTION 'Choose a position on the map before placing a checkpoint';
    END IF;
    v_radius := COALESCE(p_radius_meters, v_default_radius);
    IF v_radius <= 0 THEN RAISE EXCEPTION 'Checkpoint radius must be greater than zero'; END IF;
    INSERT INTO public.patrol_checkpoints (
      organization_id, location_id, client_site_id, zone_id, name, description,
      gps_lat, gps_lng, radius_meters, qr_code, active, client_request_id
    ) VALUES (
      v_provider, p_location_id, p_client_site_id, p_zone_id, v_name,
      nullif(trim(coalesce(p_description, '')), ''), p_gps_lat, p_gps_lng, v_radius,
      nullif(trim(coalesce(p_qr_code, '')), ''), true, p_client_request_id
    ) RETURNING * INTO v_checkpoint;
    v_changed := true;
  ELSE
    SELECT * INTO v_checkpoint FROM public.patrol_checkpoints
    WHERE id = p_checkpoint_id AND organization_id = v_provider FOR UPDATE;
    IF NOT FOUND OR v_checkpoint.location_id <> p_location_id
       OR v_checkpoint.client_site_id IS DISTINCT FROM p_client_site_id
       OR v_checkpoint.zone_id IS DISTINCT FROM p_zone_id THEN
      RAISE EXCEPTION 'Checkpoint not found under the selected Site or Zone';
    END IF;
    IF v_action = 'deactivate' THEN
      UPDATE public.patrol_checkpoints SET active = false
      WHERE patrol_checkpoints.id = v_checkpoint.id RETURNING * INTO v_checkpoint;
    ELSIF v_action = 'reactivate' THEN
      UPDATE public.patrol_checkpoints SET active = true
      WHERE patrol_checkpoints.id = v_checkpoint.id RETURNING * INTO v_checkpoint;
    ELSE
      IF (p_gps_lat IS NULL) <> (p_gps_lng IS NULL) THEN
        RAISE EXCEPTION 'Checkpoint position needs both latitude and longitude';
      END IF;
      v_changed := (COALESCE(p_gps_lat, v_checkpoint.gps_lat),
                    COALESCE(p_gps_lng, v_checkpoint.gps_lng),
                    COALESCE(p_radius_meters, v_checkpoint.radius_meters))
                   IS DISTINCT FROM (v_checkpoint.gps_lat, v_checkpoint.gps_lng, v_checkpoint.radius_meters);
      UPDATE public.patrol_checkpoints
      SET name = COALESCE(v_name, patrol_checkpoints.name),
          description = COALESCE(nullif(trim(coalesce(p_description, '')), ''), patrol_checkpoints.description),
          qr_code = COALESCE(nullif(trim(coalesce(p_qr_code, '')), ''), patrol_checkpoints.qr_code),
          gps_lat = COALESCE(p_gps_lat, patrol_checkpoints.gps_lat),
          gps_lng = COALESCE(p_gps_lng, patrol_checkpoints.gps_lng),
          radius_meters = COALESCE(p_radius_meters, patrol_checkpoints.radius_meters)
      WHERE patrol_checkpoints.id = v_checkpoint.id RETURNING * INTO v_checkpoint;
    END IF;
  END IF;

  IF v_changed THEN
    v_version := public._gbh_next_version('patrol_checkpoint', v_checkpoint.id);
    INSERT INTO public.geofence_boundary_history (
      entity_type, entity_id, boundary, boundary_source, verification_state,
      changed_by, changed_via, change_reason, version
    ) VALUES (
      'patrol_checkpoint', v_checkpoint.id,
      ST_Buffer(ST_SetSRID(ST_MakePoint(v_checkpoint.gps_lng, v_checkpoint.gps_lat), 4326)::geography,
                v_checkpoint.radius_meters)::geometry,
      'manual_point_radius', 'unverified', v_actor, 'direct_edit',
      CASE WHEN v_action = 'create' THEN 'Checkpoint placed on the Location House map; unverified until visually confirmed (Q3)'
           ELSE 'Checkpoint moved or resized on the Location House map; verification reset (P2)' END,
      v_version
    );
  ELSE
    SELECT max(h.version) INTO v_version FROM public.geofence_boundary_history h
    WHERE h.entity_type = 'patrol_checkpoint' AND h.entity_id = v_checkpoint.id;
  END IF;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_provider, v_actor,
    'patrol_checkpoint_' || CASE WHEN v_action = 'create' THEN 'created' WHEN v_action = 'update' THEN 'updated' ELSE v_action || 'd' END,
    'patrol_checkpoints', v_checkpoint.id,
    jsonb_build_object('client_request_id', p_client_request_id, 'location_id', p_location_id,
      'client_site_id', v_checkpoint.client_site_id, 'zone_id', v_checkpoint.zone_id,
      'radius_meters', v_checkpoint.radius_meters, 'geometry_changed', v_changed,
      'checkpoint_verification', v_checkpoint.checkpoint_verification, 'history_version', v_version));

  RETURN QUERY SELECT v_checkpoint.id, v_checkpoint.name, v_checkpoint.location_id,
    v_checkpoint.client_site_id, v_checkpoint.zone_id, v_checkpoint.gps_lat, v_checkpoint.gps_lng,
    v_checkpoint.radius_meters, v_checkpoint.checkpoint_verification, v_checkpoint.active,
    v_action = 'create', v_changed, v_version;
END;
$$;

REVOKE ALL ON FUNCTION public.manage_location_patrol_checkpoint(uuid, text, uuid, uuid, uuid, uuid, uuid, text, text, double precision, double precision, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manage_location_patrol_checkpoint(uuid, text, uuid, uuid, uuid, uuid, uuid, text, text, double precision, double precision, integer, text) TO authenticated, service_role;
COMMENT ON FUNCTION public.manage_location_patrol_checkpoint(uuid, text, uuid, uuid, uuid, uuid, uuid, text, text, double precision, double precision, integer, text) IS
  'Location House checkpoint manager for exactly one Site or Zone anchor. Requires the active provider administrator to manage the House. Create and geometry changes are versioned, audited and unverified; verify_boundary is the only certification path. Radius defaults to org_geofence_config checkpoint_radius_m, else 5 m.';