ALTER TABLE public.client_site_patrol_config
  DROP CONSTRAINT client_site_patrol_config_time_window_type_check,
  DROP CONSTRAINT client_site_patrol_config_visits_per_shift_check,
  DROP CONSTRAINT client_site_patrol_config_dwell_minutes_check,
  ALTER COLUMN sla_arrive_within_minutes DROP NOT NULL,
  ALTER COLUMN sla_depart_within_minutes DROP NOT NULL;

ALTER TABLE public.client_site_patrol_config
  ADD CONSTRAINT client_site_patrol_config_time_window_type_check
    CHECK (time_window_type IN ('fixed','sunrise_sunset','seasonal','as_attended')),
  ADD CONSTRAINT client_site_patrol_config_attendance_shape_check CHECK (
    (time_window_type='as_attended' AND visits_per_shift=0 AND dwell_minutes=0
      AND window_start IS NULL AND window_end IS NULL
      AND sla_arrive_within_minutes IS NULL AND sla_depart_within_minutes IS NULL)
    OR (time_window_type<>'as_attended' AND visits_per_shift>=1 AND dwell_minutes>=1)
  );

ALTER TABLE public.service_agreement_delivery_schedules
  ADD CONSTRAINT delivery_schedule_as_attended_shape_check CHECK (
    work_model<>'as_attended_patrol' OR (
      capability_key='patrol' AND module_key='general_patrol'
      AND visits_per_shift=0 AND dwell_minutes=0 AND min_gap_between_visits_minutes=0
      AND window_start IS NULL AND window_end IS NULL
      AND response_sla_minutes IS NULL AND depart_sla_minutes IS NULL
    )
  );

DO $patch$
DECLARE v_definition text;v_anchor text;
BEGIN
  v_definition:=pg_get_functiondef('public.generate_shift_stops(uuid,date)'::regprocedure);
  v_anchor:='AND  cspc.active = true';
  IF length(v_definition)-length(replace(v_definition,v_anchor,''))<>length(v_anchor) THEN
    RAISE EXCEPTION 'Shift-stop generator changed; review the attendance exclusion before applying';
  END IF;
  EXECUTE replace(v_definition,v_anchor,v_anchor||E'\n      AND  cspc.time_window_type <> ''as_attended''');
END;
$patch$;

CREATE OR REPLACE FUNCTION public.manage_crm_as_attended_patrol(
  p_client_request_id uuid,
  p_agreement_id uuid,
  p_patrol_route_id uuid,
  p_site_id uuid DEFAULT NULL,
  p_zone_id uuid DEFAULT NULL,
  p_officer_instructions text DEFAULT NULL,
  p_operating_organization_id uuid DEFAULT NULL,
  p_expected_work_model text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public
AS $function$
DECLARE
  v_agreement public.service_agreements%rowtype;
  v_schedule public.service_agreement_delivery_schedules%rowtype;
  v_config public.client_site_patrol_config%rowtype;
  v_route public.patrol_routes%rowtype;
  v_result jsonb;
  v_replay jsonb;
  v_count integer;
  v_operating uuid;
  v_module uuid;
  v_coverage uuid;
BEGIN
  SELECT * INTO v_agreement FROM public.service_agreements WHERE id=p_agreement_id;
  IF NOT FOUND OR auth.uid() IS NULL OR NOT public.is_admin_for_org(v_agreement.provider_organization_id) THEN
    RAISE EXCEPTION 'Provider administrator required';
  END IF;
  IF p_client_request_id IS NULL OR (p_site_id IS NULL)=(p_zone_id IS NULL) THEN
    RAISE EXCEPTION 'A request identity and exactly one place are required';
  END IF;
  v_operating:=coalesce(p_operating_organization_id,v_agreement.provider_organization_id);
  SELECT * INTO v_route FROM public.patrol_routes WHERE id=p_patrol_route_id AND is_active AND organization_id=v_operating;
  IF NOT FOUND THEN RAISE EXCEPTION 'Choose an active patrol in the operating organization'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_agreement_id::text||':'||coalesce(p_site_id,p_zone_id)::text||':as_attended',0));
  SELECT metadata->'result' INTO v_replay FROM public.audit_log
  WHERE organization_id=v_agreement.provider_organization_id AND action='crm_as_attended_patrol_configured'
    AND metadata->>'client_request_id'=p_client_request_id::text ORDER BY created_at DESC LIMIT 1;
  IF v_replay IS NOT NULL THEN
    IF v_replay->>'agreement_id'<>p_agreement_id::text OR v_replay->>'patrol_route_id'<>p_patrol_route_id::text
      OR coalesce(v_replay->>'site_id','')<>coalesce(p_site_id::text,'')
      OR coalesce(v_replay->>'zone_id','')<>coalesce(p_zone_id::text,'') THEN
      RAISE EXCEPTION 'Request identity was already used for another attendance schedule';
    END IF;
    RETURN v_replay||jsonb_build_object('replayed',true);
  END IF;
  SELECT count(*) INTO v_count FROM public.service_agreement_delivery_schedules
  WHERE service_agreement_id=p_agreement_id AND active AND module_key='general_patrol'
    AND site_id IS NOT DISTINCT FROM p_site_id AND zone_id IS NOT DISTINCT FROM p_zone_id;
  IF v_count>1 THEN RAISE EXCEPTION 'Multiple active patrol schedules require review'; END IF;
  SELECT * INTO v_schedule FROM public.service_agreement_delivery_schedules
  WHERE service_agreement_id=p_agreement_id AND active AND module_key='general_patrol'
    AND site_id IS NOT DISTINCT FROM p_site_id AND zone_id IS NOT DISTINCT FROM p_zone_id FOR UPDATE;
  IF FOUND AND v_schedule.work_model<>'as_attended_patrol'
    AND v_schedule.work_model IS DISTINCT FROM p_expected_work_model THEN
    RAISE EXCEPTION 'Review the existing timed schedule before changing it to as attended';
  END IF;
  IF v_schedule.id IS NOT NULL AND v_schedule.work_model='as_attended_patrol' THEN
    UPDATE public.service_agreement_delivery_schedules SET work_model='scheduled_patrol',visits_per_shift=1,dwell_minutes=1
    WHERE id=v_schedule.id;
  END IF;
  v_result:=public.manage_crm_agreement_delivery_schedule(
    p_client_request_id,p_agreement_id,CASE WHEN v_schedule.id IS NULL THEN 'create' ELSE 'update' END,
    v_schedule.id,p_site_id,p_zone_id,'patrol',ARRAY[1,2,3,4,5,6,7],NULL,NULL,1,0,1,p_officer_instructions,v_operating);
  SELECT * INTO v_schedule FROM public.service_agreement_delivery_schedules WHERE id=(v_result->>'schedule_id')::uuid;
  IF v_schedule.service_agreement_id<>p_agreement_id OR v_schedule.site_id IS DISTINCT FROM p_site_id
    OR v_schedule.zone_id IS DISTINCT FROM p_zone_id THEN RAISE EXCEPTION 'Attendance schedule replay scope mismatch'; END IF;
  UPDATE public.service_agreement_delivery_schedules
  SET work_model='as_attended_patrol',visits_per_shift=0,min_gap_between_visits_minutes=0,dwell_minutes=0,
    window_start=NULL,window_end=NULL,response_sla_minutes=NULL,depart_sla_minutes=NULL
  WHERE id=v_schedule.id;
  UPDATE public.client_site_patrol_config
  SET patrol_route_id=p_patrol_route_id,time_window_type='as_attended',visits_per_shift=0,
    min_gap_between_visits_minutes=0,dwell_minutes=0,window_start=NULL,window_end=NULL,
    sla_arrive_within_minutes=NULL,sla_depart_within_minutes=NULL,updated_at=clock_timestamp()
  WHERE delivery_schedule_id=v_schedule.id RETURNING * INTO v_config;
  IF NOT FOUND THEN RAISE EXCEPTION 'Attendance patrol configuration was not created'; END IF;
  SELECT id INTO v_module FROM public.service_agreement_modules
  WHERE service_agreement_id=p_agreement_id AND module_key='patrol' AND enabled;
  SELECT id INTO v_coverage FROM public.service_agreement_locations
  WHERE service_agreement_id=p_agreement_id AND status='active'
    AND site_id IS NOT DISTINCT FROM p_site_id AND zone_id IS NOT DISTINCT FROM p_zone_id;
  IF v_module IS NULL OR v_coverage IS NULL THEN RAISE EXCEPTION 'Authorized patrol module and place coverage required'; END IF;
  INSERT INTO public.patrol_route_stop_modules(organization_id,patrol_config_id,module_key,is_required,service_agreement_module_id,service_agreement_location_id)
  VALUES(v_operating,v_config.id,'general_patrol',false,v_module,v_coverage)
  ON CONFLICT(patrol_config_id,module_key) DO UPDATE SET active=true,is_required=false,
    service_agreement_module_id=excluded.service_agreement_module_id,service_agreement_location_id=excluded.service_agreement_location_id;
  IF p_site_id IS NOT NULL THEN
    INSERT INTO public.patrol_route_sites(patrol_route_id,site_id,expected_visits_per_shift,preferred_time_window,required_module)
    VALUES(p_patrol_route_id,p_site_id,NULL,NULL,'patrol')
    ON CONFLICT(patrol_route_id,site_id) DO UPDATE SET expected_visits_per_shift=NULL,preferred_time_window=NULL;
  ELSE
    INSERT INTO public.patrol_route_zones(patrol_route_id,zone_id,expected_visits_per_shift,preferred_time_window,required_module)
    VALUES(p_patrol_route_id,p_zone_id,NULL,NULL,'patrol')
    ON CONFLICT(patrol_route_id,zone_id) DO UPDATE SET expected_visits_per_shift=NULL,preferred_time_window=NULL;
  END IF;
  v_result:=jsonb_build_object('schedule_id',v_schedule.id,'patrol_config_id',v_config.id,
    'agreement_id',p_agreement_id,'patrol_route_id',p_patrol_route_id,'site_id',p_site_id,'zone_id',p_zone_id,
    'attendance_mode','as_attended','planned_visits',0,'replayed',false);
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  VALUES(v_agreement.provider_organization_id,auth.uid(),'crm_as_attended_patrol_configured',
    'service_agreement_delivery_schedules',v_schedule.id,
    jsonb_build_object('client_request_id',p_client_request_id,'result',v_result));
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.manage_crm_as_attended_patrol(uuid,uuid,uuid,uuid,uuid,text,uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.manage_crm_as_attended_patrol(uuid,uuid,uuid,uuid,uuid,text,uuid,text) TO authenticated,service_role;