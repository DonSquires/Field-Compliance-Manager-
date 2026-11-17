CREATE OR REPLACE FUNCTION public.auto_record_patrol_checkpoints(
  p_shift_id uuid, p_gps_lat double precision, p_gps_lng double precision,
  p_gps_accuracy double precision, p_captured_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_profile public.user_profiles%ROWTYPE;
  v_patrol public.patrols%ROWTYPE;
  v_shift public.shifts%ROWTYPE;
  v_checkpoint public.patrol_checkpoints%ROWTYPE;
  v_now timestamptz;
  v_count integer;
  v_distance double precision;
  v_status text;
  v_visit_id uuid;
  v_stop_id uuid;
  v_results jsonb := '[]'::jsonb;
  v_recorded jsonb := '[]'::jsonb;
  v_routes jsonb;
  v_session_count integer;
BEGIN
  SELECT * INTO v_profile FROM public.user_profiles p
  WHERE p.id = v_actor AND p.deactivated_at IS NULL
    AND p.role IN ('grand_master', 'master', 'admin', 'admin_officer', 'officer')
  FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active Patrol officer required'; END IF;

  SELECT * INTO v_shift FROM public.shifts s WHERE s.id = p_shift_id;
  IF NOT FOUND OR v_shift.officer_user_id IS DISTINCT FROM v_actor
    OR v_shift.status <> 'in_progress'
  THEN RAISE EXCEPTION 'Active assigned Patrol shift not found'; END IF;

  -- Departure locks a stop before updating its shift, while other workflows
  -- lock the shift first. Never wait while holding either side of that cycle.
  BEGIN
    PERFORM st.id FROM public.shift_stops st WHERE st.shift_id = v_shift.id
      ORDER BY st.id FOR UPDATE NOWAIT;
    SELECT * INTO v_shift FROM public.shifts s WHERE s.id = p_shift_id FOR UPDATE NOWAIT;
    IF NOT FOUND OR v_shift.officer_user_id IS DISTINCT FROM v_actor
      OR v_shift.status <> 'in_progress'
    THEN RAISE EXCEPTION 'Active assigned Patrol shift not found'; END IF;
    PERFORM st.id FROM public.shift_stops st WHERE st.shift_id = v_shift.id
      ORDER BY st.id FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'Shift or stops are changing; retry' USING ERRCODE = '40001';
  END;

  IF v_shift.patrol_route_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.patrol_routes r WHERE r.id = v_shift.patrol_route_id
      AND r.organization_id = v_shift.organization_id
  ) THEN RAISE EXCEPTION 'Patrol route configuration requires operations review'; END IF;
  IF EXISTS (SELECT 1 FROM public.shift_stops st WHERE st.shift_id = v_shift.id
    AND st.organization_id IS DISTINCT FROM v_shift.organization_id)
  THEN RAISE EXCEPTION 'Patrol stop configuration requires operations review'; END IF;

  v_now := clock_timestamp();
  IF p_gps_lat IS NULL OR p_gps_lat NOT BETWEEN -90 AND 90
    OR p_gps_lng IS NULL OR p_gps_lng NOT BETWEEN -180 AND 180
    OR p_gps_accuracy IS NULL OR p_gps_accuracy <= 0 OR p_gps_accuracy > 50
    OR p_captured_at IS NULL OR NOT isfinite(p_captured_at)
    OR p_captured_at < v_now - interval '30 seconds'
    OR p_captured_at > v_now + interval '5 seconds'
    OR (v_shift.actual_start IS NOT NULL AND p_captured_at < v_shift.actual_start)
  THEN RAISE EXCEPTION 'A fresh valid location fix with accuracy at most 50 metres is required'; END IF;

  IF EXISTS (SELECT 1 FROM public.patrols p WHERE p.shift_id = v_shift.id
    AND p.status = 'in_progress' AND (p.officer_user_id IS DISTINCT FROM v_actor
      OR p.organization_id IS DISTINCT FROM v_shift.organization_id))
  THEN RAISE EXCEPTION 'Patrol session configuration requires operations review'; END IF;
  SELECT count(*) INTO v_session_count FROM public.patrols p
  WHERE p.shift_id = v_shift.id AND p.status = 'in_progress';
  IF v_session_count = 0 THEN
    RETURN jsonb_build_object('status', 'no_session', 'patrol_id', NULL,
      'shift_id', v_shift.id, 'recorded_checkpoint_ids', '[]'::jsonb, 'checkpoints', '[]'::jsonb);
  ELSIF v_session_count > 1 THEN
    RAISE EXCEPTION 'Patrol session configuration requires operations review';
  END IF;
  BEGIN
    SELECT * INTO STRICT v_patrol FROM public.patrols p
    WHERE p.shift_id = v_shift.id AND p.officer_user_id = v_actor
      AND p.organization_id = v_shift.organization_id AND p.status = 'in_progress'
    FOR UPDATE;
  EXCEPTION
    WHEN NO_DATA_FOUND THEN RAISE EXCEPTION 'Active assigned Patrol session changed; retry';
    WHEN TOO_MANY_ROWS THEN RAISE EXCEPTION 'Patrol session configuration requires operations review';
  END;

  IF p_captured_at < v_patrol.started_at
    OR p_captured_at < clock_timestamp() - interval '30 seconds'
  THEN RAISE EXCEPTION 'A fresh valid location fix with accuracy at most 50 metres is required'; END IF;

  FOR v_checkpoint IN
    SELECT c.* FROM public.patrol_checkpoints c
    WHERE c.organization_id = v_shift.organization_id AND c.active
      AND ((c.zone_id IS NOT NULL AND c.zone_id = v_shift.zone_id)
        OR EXISTS (SELECT 1 FROM public.shift_stops st WHERE st.shift_id = v_shift.id
          AND ((c.client_site_id IS NOT NULL AND st.site_id = c.client_site_id)
            OR (c.zone_id IS NOT NULL AND st.zone_id = c.zone_id))))
    ORDER BY c.id FOR SHARE
  LOOP
    v_status := NULL;
    IF v_checkpoint.gps_lat IS NULL OR v_checkpoint.gps_lat NOT BETWEEN -90 AND 90
      OR v_checkpoint.gps_lng IS NULL OR v_checkpoint.gps_lng NOT BETWEEN -180 AND 180
      OR v_checkpoint.radius_meters IS NULL OR v_checkpoint.radius_meters NOT BETWEEN 1 AND 500
    THEN v_status := 'missing_or_invalid_geofence';
    ELSIF v_checkpoint.checkpoint_verification IS DISTINCT FROM 'verified'
      OR v_checkpoint.checkpoint_verified_by IS NULL OR v_checkpoint.checkpoint_verified_at IS NULL
    THEN v_status := 'unverified';
    ELSIF v_checkpoint.checkpoint_verified_at > p_captured_at THEN
      v_status := 'not_verified_at_capture';
    ELSE
      -- Match the writer's non-terminal stop selection, but never let it
      -- attach a repeated or ambiguous visit to an arbitrary stop.
      SELECT count(*), (array_agg(st.id ORDER BY st.id))[1]
      INTO v_count, v_stop_id
      FROM public.shift_stops st
      WHERE st.shift_id = v_shift.id AND st.status IN ('pending','en_route','on_scene')
        AND ((v_checkpoint.client_site_id IS NOT NULL AND st.site_id = v_checkpoint.client_site_id)
          OR (v_checkpoint.zone_id IS NOT NULL AND st.zone_id = v_checkpoint.zone_id));
      IF v_count > 1 THEN v_stop_id := NULL; END IF;
      IF p_gps_accuracy > v_checkpoint.radius_meters THEN v_status := 'accuracy_too_low';
      ELSE
        v_distance := public.st_distance(
          public.st_setsrid(public.st_makepoint(p_gps_lng, p_gps_lat), 4326)::public.geography,
          public.st_setsrid(public.st_makepoint(v_checkpoint.gps_lng, v_checkpoint.gps_lat), 4326)::public.geography);
        IF v_distance > v_checkpoint.radius_meters THEN v_status := 'outside_geofence';
        ELSIF v_distance + p_gps_accuracy > v_checkpoint.radius_meters THEN v_status := 'boundary_uncertain';
        ELSE
          IF p_captured_at < clock_timestamp() - interval '30 seconds'
          THEN RAISE EXCEPTION 'Location fix expired; retry with a fresh fix'; END IF;
          -- The manual writer intentionally denies overdue cross-branch calls.
          -- Write only this verified automatic evidence under the same advisory key.
          PERFORM pg_advisory_xact_lock(hashtextextended(v_patrol.id::text || ':site:' || v_checkpoint.id::text, 0));
          IF p_captured_at < clock_timestamp() - interval '30 seconds'
          THEN RAISE EXCEPTION 'Location fix expired; retry with a fresh fix'; END IF;
          SELECT v.id INTO v_visit_id FROM public.patrol_checkpoint_visits v
          WHERE v.patrol_id = v_patrol.id AND v.checkpoint_id = v_checkpoint.id
          ORDER BY v.visited_at LIMIT 1;
          IF NOT FOUND THEN
            INSERT INTO public.patrol_checkpoint_visits(
              organization_id, patrol_id, checkpoint_id, officer_user_id,
              gps_lat, gps_lng, gps_accuracy, gps_distance_from_checkpoint,
              within_radius, scan_method, notes, shift_stop_id, checkpoint_verification_at_visit)
            VALUES(v_shift.organization_id, v_patrol.id, v_checkpoint.id, v_actor,
              p_gps_lat, p_gps_lng, p_gps_accuracy, v_distance,
              true, 'gps', NULL, v_stop_id, 'verified')
            RETURNING id INTO v_visit_id;
            INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
            VALUES(v_shift.organization_id, v_actor, 'patrol.checkpoint_recorded',
              'patrol_checkpoint_visits', v_visit_id,
              jsonb_build_object('patrol_id', v_patrol.id, 'checkpoint_kind', 'site',
                'checkpoint_id', v_checkpoint.id, 'distance_metres', round(v_distance::numeric, 1),
                'shift_stop_id', v_stop_id,
                'stop_resolution', CASE v_count WHEN 0 THEN 'missing' WHEN 1 THEN 'linked' ELSE 'ambiguous' END));
            INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
            VALUES(v_shift.organization_id, v_actor, 'patrol.checkpoint_auto_recorded',
              'patrol_checkpoint_visits', v_visit_id,
              jsonb_build_object('patrol_id', v_patrol.id, 'shift_id', v_shift.id,
                'checkpoint_id', v_checkpoint.id, 'captured_at', p_captured_at,
                'gps_accuracy', p_gps_accuracy, 'checkpoint_verification', 'verified',
                'stop_resolution', CASE v_count WHEN 0 THEN 'missing' WHEN 1 THEN 'linked' ELSE 'ambiguous' END));
            v_status := CASE WHEN v_count <> 1 THEN 'recorded_unattributed' ELSE 'recorded' END;
            v_recorded := v_recorded || jsonb_build_array(v_checkpoint.id);
          ELSE
            v_status := 'already_recorded';
          END IF;
        END IF;
      END IF;
    END IF;
    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'checkpoint_id', v_checkpoint.id, 'kind', 'site',
      'site_id', v_checkpoint.client_site_id, 'zone_id', v_checkpoint.zone_id,
      'status', v_status));
  END LOOP;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'checkpoint_id', c.id, 'kind', 'route', 'status', 'route_not_eligible'
  ) ORDER BY c.sequence_order, c.id), '[]'::jsonb) INTO v_routes
  FROM public.patrol_route_checkpoints c
  WHERE c.patrol_route_id = v_shift.patrol_route_id AND c.is_active;

  RETURN jsonb_build_object('status', 'processed', 'patrol_id', v_patrol.id, 'shift_id', v_shift.id,
    'recorded_checkpoint_ids', v_recorded, 'checkpoints', v_results || v_routes);
END;
$function$;

REVOKE ALL ON FUNCTION public.auto_record_patrol_checkpoints(uuid,double precision,double precision,double precision,timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.auto_record_patrol_checkpoints(uuid,double precision,double precision,double precision,timestamptz)
  TO authenticated;
COMMENT ON FUNCTION public.auto_record_patrol_checkpoints(uuid,double precision,double precision,double precision,timestamptz)
  IS 'Records assigned checkpoint visits only for fresh, accurate fixes wholly inside human-verified checkpoint geofences; route checkpoints are not auto-eligible.';