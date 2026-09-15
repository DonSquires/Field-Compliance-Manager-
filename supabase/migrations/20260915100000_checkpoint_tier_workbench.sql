-- Tier 4 checkpoints on the geofence engine (GEOFENCE_PRINCIPLES Q3, Q4, Q8, P1, P2).
--
-- Q3: checkpoints are direct-save (no proposal flow) but every placement lands
--     `unverified` and is only certified by the map-confirm act (verify_boundary).
-- P2: ANY geometry change resets verification — enforced structurally by a trigger,
--     because RLS lets an organisation admin update the table directly.
-- Q4: every placement/move is versioned in geofence_boundary_history.
-- Q8: the radius defaults to org_geofence_config 'checkpoint_radius_m', else 5 m.
-- P1: a visit's distance and within_radius are computed by the server from the
--     recorded point; the officer client no longer asserts them. A checkpoint
--     with no point yields NULLs ("not evaluated"), never a fabricated answer.
--     The checkpoint's verification state at visit time is recorded with the visit.
--
-- Additive. record_officer_checkpoint_visit keeps its exact signature and return.

-- ── 1. Columns ─────────────────────────────────────────────────────────────
ALTER TABLE public.patrol_checkpoints ADD COLUMN IF NOT EXISTS client_request_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS idx_patrol_checkpoints_org_client_request
  ON public.patrol_checkpoints (organization_id, client_request_id) WHERE client_request_id IS NOT NULL;
ALTER TABLE public.patrol_checkpoint_visits ADD COLUMN IF NOT EXISTS checkpoint_verification_at_visit text;
COMMENT ON COLUMN public.patrol_checkpoint_visits.checkpoint_verification_at_visit IS
  'checkpoint_verification of the checkpoint when the visit was recorded. A visit at an unverified checkpoint is evidence of presence at the recorded point, not authoritative proof of presence at the checkpoint (P2).';
COMMENT ON COLUMN public.patrol_checkpoint_visits.within_radius IS
  'Server-computed since 20260915100000: gps_distance_from_checkpoint <= radius_meters. NULL when the visit carried no GPS or the checkpoint has no point.';

-- ── 2. Structural P2 guard: nothing lands verified; any geometry change resets ─
CREATE OR REPLACE FUNCTION public.patrol_checkpoints_geometry_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.radius_meters IS NULL OR NEW.radius_meters < 1 OR NEW.radius_meters > 500 THEN
    RAISE EXCEPTION 'Checkpoint radius must be between 1 and 500 metres';
  END IF;
  IF (NEW.gps_lat IS NULL) <> (NEW.gps_lng IS NULL) THEN
    RAISE EXCEPTION 'Checkpoint position needs both latitude and longitude';
  END IF;
  IF NEW.gps_lat IS NOT NULL AND (NEW.gps_lat NOT BETWEEN -90 AND 90 OR NEW.gps_lng NOT BETWEEN -180 AND 180) THEN
    RAISE EXCEPTION 'Checkpoint position is out of range';
  END IF;
  IF TG_OP = 'INSERT'
     OR (NEW.gps_lat, NEW.gps_lng, NEW.radius_meters) IS DISTINCT FROM (OLD.gps_lat, OLD.gps_lng, OLD.radius_meters) THEN
    NEW.checkpoint_verification := 'unverified';
    NEW.checkpoint_verified_by := NULL;
    NEW.checkpoint_verified_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_patrol_checkpoints_geometry_guard ON public.patrol_checkpoints;
CREATE TRIGGER trg_patrol_checkpoints_geometry_guard
  BEFORE INSERT OR UPDATE ON public.patrol_checkpoints
  FOR EACH ROW EXECUTE FUNCTION public.patrol_checkpoints_geometry_guard();

-- ── 3. Governed create / move / (de)activate ───────────────────────────────
CREATE OR REPLACE FUNCTION public.manage_patrol_checkpoint(
  p_client_request_id uuid,
  p_action text,
  p_organization_id uuid,
  p_checkpoint_id uuid DEFAULT NULL,
  p_client_site_id uuid DEFAULT NULL,
  p_name text DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_gps_lat double precision DEFAULT NULL,
  p_gps_lng double precision DEFAULT NULL,
  p_radius_meters integer DEFAULT NULL,
  p_qr_code text DEFAULT NULL
) RETURNS TABLE(id uuid, name text, client_site_id uuid, gps_lat double precision, gps_lng double precision, radius_meters integer,
                checkpoint_verification text, active boolean, created boolean, geometry_changed boolean, history_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_cp public.patrol_checkpoints%rowtype;
  v_site public.client_sites%rowtype;
  v_name text := nullif(trim(coalesce(p_name, '')), '');
  v_radius integer;
  v_default_radius integer;
  v_version integer := NULL;
  v_changed boolean := false;
  v_action text := lower(trim(coalesce(p_action, '')));
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required'; END IF;
  IF p_organization_id IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN RAISE EXCEPTION 'Organisation administrator required'; END IF;
  IF v_action NOT IN ('create', 'update', 'deactivate', 'reactivate') THEN RAISE EXCEPTION 'action must be create, update, deactivate or reactivate'; END IF;

  SELECT c.config_value INTO v_default_radius FROM public.org_geofence_config c
  WHERE c.organization_id = p_organization_id AND c.config_key = 'checkpoint_radius_m' AND c.zone_type IS NULL LIMIT 1;
  v_default_radius := COALESCE(v_default_radius, 5);

  IF v_action = 'create' THEN
    SELECT * INTO v_cp FROM public.patrol_checkpoints c WHERE c.organization_id = p_organization_id AND c.client_request_id = p_client_request_id;
    IF FOUND THEN
      RETURN QUERY SELECT v_cp.id, v_cp.name, v_cp.client_site_id, v_cp.gps_lat, v_cp.gps_lng, v_cp.radius_meters, v_cp.checkpoint_verification, v_cp.active, false, false,
        (SELECT max(h.version) FROM public.geofence_boundary_history h WHERE h.entity_type = 'patrol_checkpoint' AND h.entity_id = v_cp.id);
      RETURN;
    END IF;
    IF v_name IS NULL OR char_length(v_name) > 200 THEN RAISE EXCEPTION 'Checkpoint name is required and must be 200 characters or fewer'; END IF;
    -- Checkpoints are always tied to a site (canon: point + QR, always tied to a site).
    IF p_client_site_id IS NULL THEN RAISE EXCEPTION 'A checkpoint must be placed at a site'; END IF;
    SELECT * INTO v_site FROM public.client_sites s WHERE s.id = p_client_site_id;
    IF NOT FOUND OR NOT public.org_access_allowed(v_site.client_organization_id) THEN RAISE EXCEPTION 'Site is outside your reach'; END IF;
    IF p_gps_lat IS NULL OR p_gps_lng IS NULL THEN RAISE EXCEPTION 'A map position is required to place a checkpoint'; END IF;
    v_radius := COALESCE(p_radius_meters, v_default_radius);

    INSERT INTO public.patrol_checkpoints (organization_id, client_site_id, location_id, name, description, gps_lat, gps_lng, radius_meters, qr_code, active, client_request_id)
    VALUES (p_organization_id, v_site.id, v_site.location_id, v_name, nullif(trim(coalesce(p_description, '')), ''), p_gps_lat, p_gps_lng, v_radius,
            nullif(trim(coalesce(p_qr_code, '')), ''), true, p_client_request_id)
    RETURNING * INTO v_cp;
    v_changed := true;
  ELSE
    SELECT * INTO v_cp FROM public.patrol_checkpoints c WHERE c.id = p_checkpoint_id AND c.organization_id = p_organization_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Checkpoint not found in this organisation'; END IF;
    IF v_action = 'deactivate' THEN
      UPDATE public.patrol_checkpoints SET active = false WHERE patrol_checkpoints.id = v_cp.id RETURNING * INTO v_cp;
    ELSIF v_action = 'reactivate' THEN
      UPDATE public.patrol_checkpoints SET active = true WHERE patrol_checkpoints.id = v_cp.id RETURNING * INTO v_cp;
    ELSE
      IF (p_gps_lat IS NULL) <> (p_gps_lng IS NULL) THEN RAISE EXCEPTION 'Checkpoint position needs both latitude and longitude'; END IF;
      v_changed := (COALESCE(p_gps_lat, v_cp.gps_lat), COALESCE(p_gps_lng, v_cp.gps_lng), COALESCE(p_radius_meters, v_cp.radius_meters))
                   IS DISTINCT FROM (v_cp.gps_lat, v_cp.gps_lng, v_cp.radius_meters);
      UPDATE public.patrol_checkpoints
      SET name = COALESCE(v_name, patrol_checkpoints.name),
          description = COALESCE(nullif(trim(coalesce(p_description, '')), ''), patrol_checkpoints.description),
          qr_code = COALESCE(nullif(trim(coalesce(p_qr_code, '')), ''), patrol_checkpoints.qr_code),
          gps_lat = COALESCE(p_gps_lat, patrol_checkpoints.gps_lat),
          gps_lng = COALESCE(p_gps_lng, patrol_checkpoints.gps_lng),
          radius_meters = COALESCE(p_radius_meters, patrol_checkpoints.radius_meters)
      WHERE patrol_checkpoints.id = v_cp.id
      RETURNING * INTO v_cp;
    END IF;
  END IF;

  -- Q4: every placement or move is a version; the geometry is the point buffered by its radius.
  IF v_changed THEN
    v_version := public._gbh_next_version('patrol_checkpoint', v_cp.id);
    INSERT INTO public.geofence_boundary_history (entity_type, entity_id, boundary, boundary_source, verification_state, changed_by, changed_via, change_reason, version)
    VALUES ('patrol_checkpoint', v_cp.id,
      ST_Buffer(ST_SetSRID(ST_MakePoint(v_cp.gps_lng, v_cp.gps_lat), 4326)::geography, v_cp.radius_meters)::geometry,
      'manual_point_radius', 'unverified', v_actor, 'direct_edit',
      CASE WHEN v_action = 'create' THEN 'Checkpoint placed on the map; unverified until visually confirmed (Q3)'
           ELSE 'Checkpoint moved or resized on the map; verification reset (P2)' END,
      v_version);
  ELSE
    SELECT max(h.version) INTO v_version FROM public.geofence_boundary_history h WHERE h.entity_type = 'patrol_checkpoint' AND h.entity_id = v_cp.id;
  END IF;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (p_organization_id, v_actor, 'patrol_checkpoint_' || CASE WHEN v_action = 'create' THEN 'created' WHEN v_action = 'update' THEN 'updated' ELSE v_action || 'd' END,
    'patrol_checkpoints', v_cp.id,
    jsonb_build_object('client_request_id', p_client_request_id, 'client_site_id', v_cp.client_site_id, 'radius_meters', v_cp.radius_meters,
      'geometry_changed', v_changed, 'checkpoint_verification', v_cp.checkpoint_verification, 'history_version', v_version));

  RETURN QUERY SELECT v_cp.id, v_cp.name, v_cp.client_site_id, v_cp.gps_lat, v_cp.gps_lng, v_cp.radius_meters, v_cp.checkpoint_verification, v_cp.active,
    v_action = 'create', v_changed, v_version;
END;
$$;
REVOKE ALL ON FUNCTION public.manage_patrol_checkpoint(uuid, text, uuid, uuid, uuid, text, text, double precision, double precision, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manage_patrol_checkpoint(uuid, text, uuid, uuid, uuid, text, text, double precision, double precision, integer, text) TO authenticated, service_role;
COMMENT ON FUNCTION public.manage_patrol_checkpoint(uuid, text, uuid, uuid, uuid, text, text, double precision, double precision, integer, text) IS
  'Tier 4 checkpoint direct-save (Q3): create at a site with a map position, move/resize, (de)activate. Radius defaults to org_geofence_config checkpoint_radius_m else 5 m (Q8). Every placement or move is versioned in geofence_boundary_history and lands unverified; verify_boundary is the only path to verified (P2). Idempotent create by client_request_id; audited.';

-- ── 4. Visits: presence computed by the server, verification state recorded (P1/P2) ─
CREATE OR REPLACE FUNCTION public.record_officer_checkpoint_visit(
  p_client_request_id uuid, p_shift_id uuid, p_checkpoint_id uuid, p_gps_lat double precision, p_gps_lng double precision,
  p_gps_accuracy double precision DEFAULT NULL, p_gps_distance_from_checkpoint double precision DEFAULT NULL, p_within_radius boolean DEFAULT NULL
) RETURNS TABLE(visit_id uuid, patrol_id uuid, visited_at timestamp with time zone, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_org uuid;
  v_checkpoint public.patrol_checkpoints%ROWTYPE;
  v_patrol public.patrols%ROWTYPE;
  v_visit public.patrol_checkpoint_visits%ROWTYPE;
  v_stop_id uuid;
  v_stop_count integer;
  v_at timestamptz := clock_timestamp();
  v_distance double precision := NULL;
  v_within boolean := NULL;
BEGIN
  IF v_actor IS NULL OR p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'Authentication and client_request_id are required';
  END IF;

  SELECT organization_id INTO v_org FROM public.user_profiles WHERE id = v_actor AND deactivated_at IS NULL;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Active officer identity required'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.shifts s
    WHERE s.id = p_shift_id AND s.organization_id = v_org AND s.officer_user_id = v_actor AND s.status = 'in_progress'
  ) THEN RAISE EXCEPTION 'Checkpoint visit must be recorded for your active shift'; END IF;

  SELECT * INTO v_checkpoint FROM public.patrol_checkpoints WHERE id = p_checkpoint_id AND organization_id = v_org AND active = true;
  IF NOT FOUND THEN RAISE EXCEPTION 'Checkpoint is not active for your organization'; END IF;

  SELECT * INTO v_visit FROM public.patrol_checkpoint_visits
  WHERE organization_id = v_org AND officer_user_id = v_actor AND client_request_id = p_client_request_id;
  IF FOUND THEN
    RETURN QUERY SELECT v_visit.id, v_visit.patrol_id, v_visit.visited_at, false;
    RETURN;
  END IF;

  -- P1: presence is measured here, from the recorded point. The client's p_gps_distance_from_checkpoint /
  -- p_within_radius are accepted for signature compatibility only. No point or no GPS -> NULL, not a guess.
  IF p_gps_lat IS NOT NULL AND p_gps_lng IS NOT NULL AND v_checkpoint.gps_lat IS NOT NULL AND v_checkpoint.gps_lng IS NOT NULL THEN
    v_distance := round(ST_Distance(ST_SetSRID(ST_MakePoint(v_checkpoint.gps_lng, v_checkpoint.gps_lat), 4326)::geography,
                                    ST_SetSRID(ST_MakePoint(p_gps_lng, p_gps_lat), 4326)::geography)::numeric, 1);
    v_within := v_distance <= v_checkpoint.radius_meters;
  END IF;

  SELECT * INTO v_patrol FROM public.patrols
  WHERE organization_id = v_org AND shift_id = p_shift_id AND officer_user_id = v_actor AND status = 'in_progress'
  ORDER BY started_at DESC LIMIT 1;
  IF NOT FOUND THEN
    INSERT INTO public.patrols(organization_id, shift_id, officer_user_id, zone_id, status, started_at)
    VALUES(v_org, p_shift_id, v_actor, v_checkpoint.zone_id, 'in_progress', v_at)
    RETURNING * INTO v_patrol;
  END IF;

  SELECT count(*) INTO v_stop_count FROM (
    SELECT ss.id FROM public.shift_stops ss
    WHERE ss.shift_id = p_shift_id AND ss.status IN ('pending', 'en_route', 'on_scene')
      AND ((v_checkpoint.client_site_id IS NOT NULL AND ss.site_id = v_checkpoint.client_site_id)
        OR (v_checkpoint.zone_id IS NOT NULL AND ss.zone_id = v_checkpoint.zone_id))
    ORDER BY ss.stop_order LIMIT 2
  ) candidates;
  IF v_stop_count = 1 THEN
    SELECT ss.id INTO v_stop_id FROM public.shift_stops ss
    WHERE ss.shift_id = p_shift_id AND ss.status IN ('pending', 'en_route', 'on_scene')
      AND ((v_checkpoint.client_site_id IS NOT NULL AND ss.site_id = v_checkpoint.client_site_id)
        OR (v_checkpoint.zone_id IS NOT NULL AND ss.zone_id = v_checkpoint.zone_id))
    ORDER BY ss.stop_order LIMIT 1;
  END IF;

  INSERT INTO public.patrol_checkpoint_visits(
    organization_id, patrol_id, checkpoint_id, officer_user_id, gps_lat, gps_lng,
    gps_accuracy, gps_distance_from_checkpoint, within_radius, scan_method,
    shift_stop_id, notes, visited_at, client_request_id, checkpoint_verification_at_visit
  ) VALUES (
    v_org, v_patrol.id, v_checkpoint.id, v_actor, p_gps_lat, p_gps_lng,
    p_gps_accuracy, v_distance, v_within, 'qr_camera',
    v_stop_id, 'QR checkpoint scan from mobile app', v_at, p_client_request_id, v_checkpoint.checkpoint_verification
  ) RETURNING * INTO v_visit;

  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES(v_org, v_actor, 'officer_checkpoint_visit_recorded', 'patrol_checkpoint_visits', v_visit.id,
    jsonb_build_object('patrol_id', v_patrol.id, 'checkpoint_id', v_checkpoint.id, 'shift_id', p_shift_id,
      'client_request_id', p_client_request_id, 'gps_distance_from_checkpoint', v_distance, 'within_radius', v_within,
      'checkpoint_verification', v_checkpoint.checkpoint_verification, 'client_claimed_within_radius', p_within_radius));
  RETURN QUERY SELECT v_visit.id, v_patrol.id, v_visit.visited_at, true;
END;
$$;
REVOKE ALL ON FUNCTION public.record_officer_checkpoint_visit(uuid, uuid, uuid, double precision, double precision, double precision, double precision, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_officer_checkpoint_visit(uuid, uuid, uuid, double precision, double precision, double precision, double precision, boolean) TO authenticated, service_role;
COMMENT ON FUNCTION public.record_officer_checkpoint_visit(uuid, uuid, uuid, double precision, double precision, double precision, double precision, boolean) IS
  'Officer QR checkpoint visit. Since 20260915100000 the distance and within_radius are computed by the server from the checkpoint point + radius (client values accepted for compatibility only) and the checkpoint verification state is recorded with the visit (P1/P2). Idempotent by client_request_id; audited.';
