ALTER TABLE public.patrol_checkpoint_visits ADD COLUMN IF NOT EXISTS client_request_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS idx_patrol_checkpoint_visits_request
  ON public.patrol_checkpoint_visits(organization_id, officer_user_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

REVOKE INSERT, UPDATE, DELETE ON public.patrols FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.patrol_checkpoint_visits FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.record_officer_checkpoint_visit(
  p_client_request_id uuid,
  p_shift_id uuid,
  p_checkpoint_id uuid,
  p_gps_lat double precision,
  p_gps_lng double precision,
  p_gps_accuracy double precision DEFAULT NULL,
  p_gps_distance_from_checkpoint double precision DEFAULT NULL,
  p_within_radius boolean DEFAULT NULL
)
RETURNS TABLE(visit_id uuid, patrol_id uuid, visited_at timestamptz, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_org uuid;
  v_checkpoint public.patrol_checkpoints%ROWTYPE;
  v_patrol public.patrols%ROWTYPE;
  v_visit public.patrol_checkpoint_visits%ROWTYPE;
  v_stop_id uuid;
  v_stop_count integer;
  v_at timestamptz := clock_timestamp();
BEGIN
  IF v_actor IS NULL OR p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'Authentication and client_request_id are required';
  END IF;

  SELECT organization_id INTO v_org
  FROM public.user_profiles
  WHERE id = v_actor AND deactivated_at IS NULL;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Active officer identity required'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.shifts s
    WHERE s.id = p_shift_id AND s.organization_id = v_org
      AND s.officer_user_id = v_actor AND s.status = 'in_progress'
  ) THEN RAISE EXCEPTION 'Checkpoint visit must be recorded for your active shift'; END IF;

  SELECT * INTO v_checkpoint FROM public.patrol_checkpoints
  WHERE id = p_checkpoint_id AND organization_id = v_org AND active = true;
  IF NOT FOUND THEN RAISE EXCEPTION 'Checkpoint is not active for your organization'; END IF;

  SELECT * INTO v_visit FROM public.patrol_checkpoint_visits
  WHERE organization_id = v_org AND officer_user_id = v_actor
    AND client_request_id = p_client_request_id;
  IF FOUND THEN
    RETURN QUERY SELECT v_visit.id, v_visit.patrol_id, v_visit.visited_at, false;
    RETURN;
  END IF;

  SELECT * INTO v_patrol FROM public.patrols
  WHERE organization_id = v_org AND shift_id = p_shift_id
    AND officer_user_id = v_actor AND status = 'in_progress'
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
    shift_stop_id, notes, visited_at, client_request_id
  ) VALUES (
    v_org, v_patrol.id, v_checkpoint.id, v_actor, p_gps_lat, p_gps_lng,
    p_gps_accuracy, p_gps_distance_from_checkpoint, p_within_radius, 'qr_camera',
    v_stop_id, 'QR checkpoint scan from mobile app', v_at, p_client_request_id
  ) RETURNING * INTO v_visit;

  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES(v_org, v_actor, 'officer_checkpoint_visit_recorded', 'patrol_checkpoint_visits', v_visit.id,
    jsonb_build_object('patrol_id', v_patrol.id, 'checkpoint_id', v_checkpoint.id, 'shift_id', p_shift_id,
      'client_request_id', p_client_request_id));
  RETURN QUERY SELECT v_visit.id, v_patrol.id, v_visit.visited_at, true;
END; $$;

REVOKE ALL ON FUNCTION public.record_officer_checkpoint_visit(uuid,uuid,uuid,double precision,double precision,double precision,double precision,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_officer_checkpoint_visit(uuid,uuid,uuid,double precision,double precision,double precision,double precision,boolean) TO authenticated, service_role;