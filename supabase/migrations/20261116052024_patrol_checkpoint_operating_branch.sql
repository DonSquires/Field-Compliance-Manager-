CREATE OR REPLACE FUNCTION public.record_officer_checkpoint_visit(
  p_client_request_id uuid, p_shift_id uuid, p_checkpoint_id uuid,
  p_gps_lat double precision, p_gps_lng double precision,
  p_gps_accuracy double precision DEFAULT NULL,
  p_gps_distance_from_checkpoint double precision DEFAULT NULL,
  p_within_radius boolean DEFAULT NULL
)
RETURNS TABLE(visit_id uuid, patrol_id uuid, visited_at timestamptz, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_org uuid;
  v_checkpoint public.patrol_checkpoints%ROWTYPE;
  v_patrol public.patrols%ROWTYPE;
  v_visit public.patrol_checkpoint_visits%ROWTYPE;
  v_stop_id uuid;
  v_stop_count integer;
  v_at timestamptz;
  v_distance double precision := NULL;
  v_within boolean := NULL;
BEGIN
  IF v_actor IS NULL OR p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'Authentication and client_request_id are required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_profiles WHERE id=v_actor AND deactivated_at IS NULL) THEN
    RAISE EXCEPTION 'Active officer identity required';
  END IF;

  -- The owned assignment, not the profile's home branch, is the operating context.
  -- Serialize retries with one another and with shift closure/amendment.
  SELECT s.organization_id INTO v_org FROM public.shifts s
  WHERE s.id=p_shift_id AND s.officer_user_id=v_actor
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Checkpoint visit must be recorded for your active shift'; END IF;

  -- A committed capture whose response was lost is recovered even after the shift closes.
  SELECT * INTO v_visit FROM public.patrol_checkpoint_visits
  WHERE organization_id=v_org AND officer_user_id=v_actor AND client_request_id=p_client_request_id;
  IF FOUND THEN
    IF v_visit.checkpoint_id IS DISTINCT FROM p_checkpoint_id
      OR v_visit.gps_lat IS DISTINCT FROM p_gps_lat
      OR v_visit.gps_lng IS DISTINCT FROM p_gps_lng
      OR v_visit.gps_accuracy IS DISTINCT FROM p_gps_accuracy
      OR NOT EXISTS (SELECT 1 FROM public.patrols p WHERE p.id=v_visit.patrol_id AND p.shift_id=p_shift_id)
    THEN RAISE EXCEPTION 'Checkpoint request replay conflicts with its original capture'; END IF;
    RETURN QUERY SELECT v_visit.id,v_visit.patrol_id,v_visit.visited_at,false;
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.shifts s WHERE s.id=p_shift_id AND s.status='in_progress') THEN
    RAISE EXCEPTION 'Checkpoint visit must be recorded for your active shift';
  END IF;
  v_at := clock_timestamp();

  SELECT * INTO v_checkpoint FROM public.patrol_checkpoints
  WHERE id=p_checkpoint_id AND organization_id=v_org AND active=true;
  IF NOT FOUND THEN RAISE EXCEPTION 'Checkpoint is not active for your organization'; END IF;

  -- Compatibility-only client proximity claims never determine server verification.
  IF p_gps_lat IS NOT NULL AND p_gps_lng IS NOT NULL
    AND v_checkpoint.gps_lat IS NOT NULL AND v_checkpoint.gps_lng IS NOT NULL THEN
    v_distance := round(ST_Distance(
      ST_SetSRID(ST_MakePoint(v_checkpoint.gps_lng,v_checkpoint.gps_lat),4326)::geography,
      ST_SetSRID(ST_MakePoint(p_gps_lng,p_gps_lat),4326)::geography)::numeric,1);
    v_within := v_distance<=v_checkpoint.radius_meters;
  END IF;

  SELECT * INTO v_patrol FROM public.patrols
  WHERE organization_id=v_org AND shift_id=p_shift_id AND officer_user_id=v_actor AND status='in_progress'
  ORDER BY started_at DESC LIMIT 1;
  IF NOT FOUND THEN
    INSERT INTO public.patrols(organization_id,shift_id,officer_user_id,zone_id,status,started_at)
    VALUES(v_org,p_shift_id,v_actor,v_checkpoint.zone_id,'in_progress',v_at)
    RETURNING * INTO v_patrol;
  END IF;

  SELECT count(*) INTO v_stop_count FROM (
    SELECT ss.id FROM public.shift_stops ss
    WHERE ss.shift_id=p_shift_id AND ss.organization_id=v_org AND ss.status IN ('pending','en_route','on_scene')
      AND ((v_checkpoint.client_site_id IS NOT NULL AND ss.site_id=v_checkpoint.client_site_id)
        OR (v_checkpoint.zone_id IS NOT NULL AND ss.zone_id=v_checkpoint.zone_id))
    ORDER BY ss.stop_order LIMIT 2
  ) candidates;
  IF v_stop_count=1 THEN
    SELECT ss.id INTO v_stop_id FROM public.shift_stops ss
    WHERE ss.shift_id=p_shift_id AND ss.organization_id=v_org AND ss.status IN ('pending','en_route','on_scene')
      AND ((v_checkpoint.client_site_id IS NOT NULL AND ss.site_id=v_checkpoint.client_site_id)
        OR (v_checkpoint.zone_id IS NOT NULL AND ss.zone_id=v_checkpoint.zone_id))
    ORDER BY ss.stop_order LIMIT 1;
  END IF;

  INSERT INTO public.patrol_checkpoint_visits(
    organization_id,patrol_id,checkpoint_id,officer_user_id,gps_lat,gps_lng,
    gps_accuracy,gps_distance_from_checkpoint,within_radius,scan_method,
    shift_stop_id,notes,visited_at,client_request_id,checkpoint_verification_at_visit
  ) VALUES (
    v_org,v_patrol.id,v_checkpoint.id,v_actor,p_gps_lat,p_gps_lng,
    p_gps_accuracy,v_distance,v_within,'qr_camera',
    v_stop_id,'QR checkpoint scan from mobile app',v_at,p_client_request_id,v_checkpoint.checkpoint_verification
  ) RETURNING * INTO v_visit;

  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  VALUES(v_org,v_actor,'officer_checkpoint_visit_recorded','patrol_checkpoint_visits',v_visit.id,
    jsonb_build_object('patrol_id',v_patrol.id,'checkpoint_id',v_checkpoint.id,'shift_id',p_shift_id,
      'client_request_id',p_client_request_id,'gps_distance_from_checkpoint',v_distance,'within_radius',v_within,
      'checkpoint_verification',v_checkpoint.checkpoint_verification,'client_claimed_within_radius',p_within_radius,
      'shift_stop_id',v_stop_id,'stop_resolution',CASE v_stop_count WHEN 0 THEN 'missing' WHEN 1 THEN 'linked' ELSE 'ambiguous' END));
  RETURN QUERY SELECT v_visit.id,v_patrol.id,v_visit.visited_at,true;
END;
$function$;

COMMENT ON FUNCTION public.record_officer_checkpoint_visit(uuid,uuid,uuid,double precision,double precision,double precision,double precision,boolean)
IS 'Officer QR capture scoped to the owned active operating shift. Serialized, payload-bound retries; server-computed proximity and checkpoint verification snapshot. Missing/ambiguous stop attribution remains unresolved and audited.';
REVOKE ALL ON FUNCTION public.record_officer_checkpoint_visit(uuid,uuid,uuid,double precision,double precision,double precision,double precision,boolean)
FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.record_officer_checkpoint_visit(uuid,uuid,uuid,double precision,double precision,double precision,double precision,boolean)
TO authenticated,service_role;

-- Officers may work shifts in a branch their profile RLS cannot read; resolve QR codes in the owned shift's branch.
CREATE FUNCTION public.resolve_officer_checkpoint_qr(p_shift_id uuid,p_qr_code text)
RETURNS TABLE(id uuid,name text,gps_lat double precision,gps_lng double precision,
  radius_meters integer,client_site_id uuid,zone_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $function$
  SELECT c.id,c.name,c.gps_lat,c.gps_lng,c.radius_meters,c.client_site_id,c.zone_id
  FROM public.shifts s
  JOIN public.user_profiles p ON p.id=auth.uid() AND p.deactivated_at IS NULL
  JOIN public.patrol_checkpoints c ON c.organization_id=s.organization_id AND c.qr_code=p_qr_code AND c.active
  WHERE s.id=p_shift_id AND s.officer_user_id=auth.uid() AND s.status='in_progress'
$function$;
REVOKE ALL ON FUNCTION public.resolve_officer_checkpoint_qr(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.resolve_officer_checkpoint_qr(uuid,text) TO authenticated;
