-- Assignment, not profile home, determines the operating branch.  Preserve the
-- existing API and its grants while binding patrol, shift, actor and route.
CREATE OR REPLACE FUNCTION public.start_patrol_session(p_shift_id uuid)
RETURNS public.patrols LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_profile public.user_profiles%ROWTYPE;
  v_shift public.shifts%ROWTYPE;
  v_patrol public.patrols%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO v_profile FROM public.user_profiles WHERE id=v_actor AND deactivated_at IS NULL FOR SHARE;
  IF NOT FOUND OR v_profile.role NOT IN ('grand_master','master','admin','admin_officer','officer')
  THEN RAISE EXCEPTION 'Active Patrol officer required'; END IF;
  SELECT * INTO v_shift FROM public.shifts WHERE id=p_shift_id FOR UPDATE;
  IF NOT FOUND OR v_shift.officer_user_id IS DISTINCT FROM v_actor
  THEN RAISE EXCEPTION 'Assigned Patrol shift not found'; END IF;
  IF v_shift.status NOT IN ('published','accepted','in_progress')
  THEN RAISE EXCEPTION 'Patrol shift is not active'; END IF;
  IF v_profile.organization_id IS DISTINCT FROM v_shift.organization_id
    AND (v_shift.scheduled_end IS NULL OR v_shift.scheduled_end <= clock_timestamp())
  THEN RAISE EXCEPTION 'Assigned Patrol shift is overdue'; END IF;
  IF (v_shift.patrol_route_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.patrol_routes r WHERE r.id=v_shift.patrol_route_id
      AND r.organization_id=v_shift.organization_id))
    OR EXISTS (SELECT 1 FROM public.shift_stops st WHERE st.shift_id=v_shift.id
      AND st.organization_id IS DISTINCT FROM v_shift.organization_id)
  THEN RAISE EXCEPTION 'Patrol configuration requires operations review'; END IF;
  IF EXISTS (SELECT 1 FROM public.patrols p WHERE p.shift_id=v_shift.id AND p.status='in_progress'
    AND (p.officer_user_id IS DISTINCT FROM v_actor OR p.organization_id IS DISTINCT FROM v_shift.organization_id))
    OR (SELECT count(*) FROM public.patrols p WHERE p.shift_id=v_shift.id AND p.status='in_progress') > 1
  THEN RAISE EXCEPTION 'Patrol session configuration requires operations review'; END IF;
  SELECT * INTO v_patrol FROM public.patrols WHERE shift_id=v_shift.id
    AND officer_user_id=v_actor AND status='in_progress' ORDER BY started_at DESC LIMIT 1;
  IF FOUND THEN
    IF v_profile.organization_id IS DISTINCT FROM v_shift.organization_id THEN v_patrol.notes := NULL; END IF;
    RETURN v_patrol;
  END IF;
  INSERT INTO public.patrols(organization_id,shift_id,officer_user_id,zone_id,status,started_at)
  VALUES(v_shift.organization_id,v_shift.id,v_actor,v_shift.zone_id,'in_progress',clock_timestamp()) RETURNING * INTO v_patrol;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  VALUES(v_shift.organization_id,v_actor,'patrol.started','patrols',v_patrol.id,
    jsonb_build_object('shift_id',v_shift.id,'patrol_route_id',v_shift.patrol_route_id));
  RETURN v_patrol;
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_patrol_checkpoint_visit(
  p_patrol_id uuid, p_checkpoint_kind text, p_checkpoint_id uuid, p_gps_lat double precision,
  p_gps_lng double precision, p_gps_accuracy double precision, p_notes text DEFAULT NULL
) RETURNS TABLE(visit_id uuid, created boolean, visited_at timestamptz, scan_method text, notes text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  v_actor uuid:=auth.uid(); v_profile public.user_profiles%ROWTYPE; v_patrol record;
  v_checkpoint record; v_existing public.patrol_checkpoint_visits%ROWTYPE;
  v_visit public.patrol_checkpoint_visits%ROWTYPE;
  v_radius double precision; v_distance double precision; v_shift_stop_id uuid; v_regular_id uuid; v_route_id uuid;
  v_locked_shift_id uuid; v_stop_count integer;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO v_profile FROM public.user_profiles WHERE id=v_actor AND deactivated_at IS NULL FOR SHARE;
  IF NOT FOUND OR v_profile.role NOT IN ('grand_master','master','admin','admin_officer','officer')
  THEN RAISE EXCEPTION 'Active Patrol officer required'; END IF;
  SELECT s.id INTO v_locked_shift_id FROM public.shifts s JOIN public.patrols p ON p.shift_id=s.id
    WHERE p.id=p_patrol_id AND s.officer_user_id=v_actor AND s.organization_id=p.organization_id
    AND p.officer_user_id=v_actor FOR UPDATE OF s;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active assigned Patrol session not found'; END IF;
  SELECT p.*,s.patrol_route_id,s.zone_id AS shift_zone_id,s.status AS shift_status,s.scheduled_end
  INTO v_patrol FROM public.patrols p JOIN public.shifts s ON s.id=p.shift_id
    AND s.officer_user_id=v_actor AND s.organization_id=p.organization_id
  WHERE p.id=p_patrol_id AND p.shift_id=v_locked_shift_id FOR UPDATE OF p;
  IF NOT FOUND OR v_patrol.officer_user_id IS DISTINCT FROM v_actor
  THEN RAISE EXCEPTION 'Active assigned Patrol session not found'; END IF;
  IF EXISTS (SELECT 1 FROM public.patrols p WHERE p.shift_id=v_patrol.shift_id AND p.status='in_progress'
    AND (p.officer_user_id IS DISTINCT FROM v_actor OR p.organization_id IS DISTINCT FROM v_patrol.organization_id))
    OR (SELECT count(*) FROM public.patrols p WHERE p.shift_id=v_patrol.shift_id AND p.status='in_progress') > 1
  THEN RAISE EXCEPTION 'Patrol session configuration requires operations review'; END IF;
  IF v_patrol.shift_status <> 'in_progress'
    OR (v_profile.organization_id IS DISTINCT FROM v_patrol.organization_id
      AND (v_patrol.scheduled_end IS NULL OR v_patrol.scheduled_end <= clock_timestamp()))
  THEN RAISE EXCEPTION 'Assigned Patrol shift is not active'; END IF;
  BEGIN
    PERFORM st.id FROM public.shift_stops st WHERE st.shift_id=v_patrol.shift_id
      ORDER BY st.id FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'Shift or stops are changing; retry' USING ERRCODE = '40001';
  END;
  IF (v_patrol.patrol_route_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.patrol_routes r WHERE r.id=v_patrol.patrol_route_id AND r.organization_id=v_patrol.organization_id))
    OR EXISTS (SELECT 1 FROM public.shift_stops st WHERE st.shift_id=v_patrol.shift_id
      AND st.organization_id IS DISTINCT FROM v_patrol.organization_id)
  THEN RAISE EXCEPTION 'Patrol configuration requires operations review'; END IF;
  IF v_patrol.status<>'in_progress' THEN RAISE EXCEPTION 'Patrol session is not in progress'; END IF;
  IF p_gps_lat IS NULL OR p_gps_lng IS NULL OR p_gps_accuracy IS NULL OR p_gps_lat NOT BETWEEN -90 AND 90
    OR p_gps_lng NOT BETWEEN -180 AND 180 OR p_gps_accuracy<0 OR p_gps_accuracy>1000
  THEN RAISE EXCEPTION 'Valid checkpoint GPS and accuracy are required'; END IF;
  IF p_checkpoint_kind='route' THEN
    SELECT id,gps_lat,gps_lng,geofence_radius_meters AS radius,patrol_route_id,is_active,
      NULL::uuid AS client_site_id,NULL::uuid AS zone_id,'unverified'::text AS checkpoint_verification INTO v_checkpoint
    FROM public.patrol_route_checkpoints WHERE id=p_checkpoint_id;
    IF NOT FOUND OR NOT v_checkpoint.is_active OR v_checkpoint.patrol_route_id IS DISTINCT FROM v_patrol.patrol_route_id
    THEN RAISE EXCEPTION 'Assigned route checkpoint not found'; END IF;
    v_route_id:=v_checkpoint.id;
  ELSIF p_checkpoint_kind='site' THEN
    SELECT id,gps_lat,gps_lng,radius_meters AS radius,NULL::uuid AS patrol_route_id,
      active AS is_active,client_site_id,zone_id,checkpoint_verification INTO v_checkpoint FROM public.patrol_checkpoints
    WHERE id=p_checkpoint_id AND organization_id=v_patrol.organization_id;
    IF NOT FOUND OR NOT v_checkpoint.is_active OR NOT ((v_checkpoint.zone_id IS NOT NULL AND v_checkpoint.zone_id=v_patrol.shift_zone_id)
      OR EXISTS(SELECT 1 FROM public.shift_stops st WHERE st.shift_id=v_patrol.shift_id
        AND ((v_checkpoint.client_site_id IS NOT NULL AND st.site_id=v_checkpoint.client_site_id)
          OR (v_checkpoint.zone_id IS NOT NULL AND st.zone_id=v_checkpoint.zone_id))))
    THEN RAISE EXCEPTION 'Assigned Patrol checkpoint not found'; END IF;
    v_regular_id:=v_checkpoint.id;
    SELECT count(*), (array_agg(st.id ORDER BY st.id))[1] INTO v_stop_count, v_shift_stop_id
    FROM public.shift_stops st WHERE st.shift_id=v_patrol.shift_id
      AND (st.site_id=v_checkpoint.client_site_id OR st.zone_id=v_checkpoint.zone_id)
      AND st.status IN ('pending','en_route','on_scene');
    IF v_stop_count > 1 THEN v_shift_stop_id := NULL; END IF;
  ELSE RAISE EXCEPTION 'Checkpoint kind must be route or site'; END IF;
  IF v_checkpoint.gps_lat IS NULL OR v_checkpoint.gps_lng IS NULL THEN RAISE EXCEPTION 'Checkpoint has no GPS anchor'; END IF;
  v_radius:=greatest(coalesce(v_checkpoint.radius,0),1);
  IF p_gps_accuracy>v_radius THEN RAISE EXCEPTION 'GPS accuracy is too poor for this checkpoint'; END IF;
  v_distance:=st_distance(st_setsrid(st_makepoint(p_gps_lng,p_gps_lat),4326)::geography,
    st_setsrid(st_makepoint(v_checkpoint.gps_lng,v_checkpoint.gps_lat),4326)::geography);
  IF v_distance>v_radius THEN RAISE EXCEPTION 'GPS position is outside the checkpoint radius'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_patrol_id::text||':'||p_checkpoint_kind||':'||p_checkpoint_id::text,0));
  SELECT * INTO v_existing FROM public.patrol_checkpoint_visits WHERE patrol_id=p_patrol_id
    AND ((p_checkpoint_kind='route' AND route_checkpoint_id=p_checkpoint_id)
      OR (p_checkpoint_kind='site' AND checkpoint_id=p_checkpoint_id)) ORDER BY visited_at LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT v_existing.id,false,v_existing.visited_at,v_existing.scan_method,
      CASE WHEN v_profile.organization_id IS DISTINCT FROM v_patrol.organization_id THEN NULL::text ELSE v_existing.notes END;
    RETURN;
  END IF;
  INSERT INTO public.patrol_checkpoint_visits(organization_id,patrol_id,checkpoint_id,route_checkpoint_id,
    officer_user_id,gps_lat,gps_lng,gps_accuracy,gps_distance_from_checkpoint,within_radius,scan_method,notes,shift_stop_id,
    checkpoint_verification_at_visit)
  VALUES(v_patrol.organization_id,v_patrol.id,v_regular_id,v_route_id,v_actor,p_gps_lat,p_gps_lng,p_gps_accuracy,
    v_distance,true,'gps',nullif(trim(coalesce(p_notes,'')),''),v_shift_stop_id,
    v_checkpoint.checkpoint_verification) RETURNING * INTO v_visit;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  VALUES(v_patrol.organization_id,v_actor,'patrol.checkpoint_recorded','patrol_checkpoint_visits',v_visit.id,
    jsonb_build_object('patrol_id',v_visit.patrol_id,'checkpoint_kind',p_checkpoint_kind,'checkpoint_id',p_checkpoint_id,
      'distance_metres',round(v_distance::numeric,1),'shift_stop_id',v_shift_stop_id,
      'stop_resolution',CASE coalesce(v_stop_count,0) WHEN 0 THEN 'missing' WHEN 1 THEN 'linked' ELSE 'ambiguous' END,
      'checkpoint_verification',v_checkpoint.checkpoint_verification));
  RETURN QUERY SELECT v_visit.id,true,v_visit.visited_at,v_visit.scan_method,
    CASE WHEN v_profile.organization_id IS DISTINCT FROM v_patrol.organization_id THEN NULL::text ELSE v_visit.notes END;
END;
$function$;

CREATE OR REPLACE FUNCTION public.complete_patrol_session(p_patrol_id uuid, p_notes text DEFAULT NULL)
RETURNS public.patrols LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  v_actor uuid:=auth.uid(); v_profile public.user_profiles%ROWTYPE; v_patrol record; v_result public.patrols%ROWTYPE;
  v_locked_shift_id uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO v_profile FROM public.user_profiles WHERE id=v_actor AND deactivated_at IS NULL FOR SHARE;
  IF NOT FOUND OR v_profile.role NOT IN ('grand_master','master','admin','admin_officer','officer')
  THEN RAISE EXCEPTION 'Active Patrol officer required'; END IF;
  SELECT s.id INTO v_locked_shift_id FROM public.shifts s JOIN public.patrols p ON p.shift_id=s.id
    WHERE p.id=p_patrol_id AND s.officer_user_id=v_actor AND s.organization_id=p.organization_id
    AND p.officer_user_id=v_actor FOR UPDATE OF s;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active assigned Patrol session not found'; END IF;
  SELECT p.*,s.patrol_route_id,s.zone_id AS shift_zone_id,s.status AS shift_status,s.scheduled_end
  INTO v_patrol FROM public.patrols p JOIN public.shifts s ON s.id=p.shift_id
    AND s.officer_user_id=v_actor AND s.organization_id=p.organization_id
  WHERE p.id=p_patrol_id AND p.shift_id=v_locked_shift_id FOR UPDATE OF p;
  IF NOT FOUND OR v_patrol.officer_user_id IS DISTINCT FROM v_actor
  THEN RAISE EXCEPTION 'Active assigned Patrol session not found'; END IF;
  IF EXISTS (SELECT 1 FROM public.patrols p WHERE p.shift_id=v_patrol.shift_id AND p.status='in_progress'
    AND (p.officer_user_id IS DISTINCT FROM v_actor OR p.organization_id IS DISTINCT FROM v_patrol.organization_id))
    OR (SELECT count(*) FROM public.patrols p WHERE p.shift_id=v_patrol.shift_id AND p.status='in_progress') > 1
  THEN RAISE EXCEPTION 'Patrol session configuration requires operations review'; END IF;
  IF v_profile.organization_id IS DISTINCT FROM v_patrol.organization_id
    AND (v_patrol.shift_status NOT IN ('published','accepted','in_progress')
      OR v_patrol.scheduled_end IS NULL OR v_patrol.scheduled_end <= clock_timestamp())
  THEN RAISE EXCEPTION 'Assigned Patrol shift is not active'; END IF;
  IF (v_patrol.patrol_route_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.patrol_routes r WHERE r.id=v_patrol.patrol_route_id AND r.organization_id=v_patrol.organization_id))
    OR EXISTS (SELECT 1 FROM public.shift_stops st WHERE st.shift_id=v_patrol.shift_id
      AND st.organization_id IS DISTINCT FROM v_patrol.organization_id)
  THEN RAISE EXCEPTION 'Patrol configuration requires operations review'; END IF;
  IF v_patrol.status='completed' THEN
    SELECT * INTO v_result FROM public.patrols WHERE id=p_patrol_id;
    IF v_profile.organization_id IS DISTINCT FROM v_patrol.organization_id THEN v_result.notes:=NULL; END IF;
    RETURN v_result;
  END IF;
  IF v_patrol.status<>'in_progress' THEN RAISE EXCEPTION 'Patrol session is not in progress'; END IF;
  IF EXISTS(SELECT 1 FROM public.patrol_route_checkpoints c WHERE c.patrol_route_id=v_patrol.patrol_route_id AND c.is_active AND c.is_mandatory
    AND NOT EXISTS(SELECT 1 FROM public.patrol_checkpoint_visits v WHERE v.patrol_id=v_patrol.id AND v.route_checkpoint_id=c.id))
  THEN RAISE EXCEPTION 'One or more mandatory checkpoints remain'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.patrol_route_checkpoints c WHERE c.patrol_route_id=v_patrol.patrol_route_id AND c.is_active AND c.is_mandatory)
    AND EXISTS(SELECT 1 FROM public.patrol_checkpoints c WHERE c.active
      AND ((c.zone_id IS NOT NULL AND c.zone_id=v_patrol.shift_zone_id)
        OR EXISTS(SELECT 1 FROM public.shift_stops st WHERE st.shift_id=v_patrol.shift_id
          AND ((c.client_site_id IS NOT NULL AND st.site_id=c.client_site_id) OR (c.zone_id IS NOT NULL AND st.zone_id=c.zone_id))))
      AND NOT EXISTS(SELECT 1 FROM public.patrol_checkpoint_visits v WHERE v.patrol_id=v_patrol.id AND v.checkpoint_id=c.id))
  THEN RAISE EXCEPTION 'One or more mandatory checkpoints remain'; END IF;
  UPDATE public.patrols SET status='completed',ended_at=clock_timestamp(),
    notes=coalesce(nullif(trim(coalesce(p_notes,'')),''),notes) WHERE id=v_patrol.id RETURNING * INTO v_result;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  VALUES(v_patrol.organization_id,v_actor,'patrol.completed','patrols',v_result.id,
    jsonb_build_object('shift_id',v_result.shift_id,'checkpoint_count',
      (SELECT count(*) FROM public.patrol_checkpoint_visits WHERE patrol_id=v_result.id)));
  IF v_profile.organization_id IS DISTINCT FROM v_patrol.organization_id THEN v_result.notes:=NULL; END IF;
  RETURN v_result;
END;
$function$;