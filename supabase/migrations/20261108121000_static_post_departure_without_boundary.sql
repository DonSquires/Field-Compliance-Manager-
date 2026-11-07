-- Allow a static guarding shift to be ended when the site boundary was never verified.
--
-- A static guarding shift has exactly one stop (module_key = 'static_guarding').
-- Before this change:
--   * get_officer_attendance_readiness counted that stop as "open" unless it had
--     already reached on_scene, so can_end stayed false for an officer who could not
--     verify the site boundary or never tapped Arrive;
--   * record_static_shift_presence refused 'depart' unless the stop was on_scene.
-- So the shift could not be ended at all.
--
-- After this change:
--   * the single static post stop is not counted as an open stop for the end-of-shift
--     gate, because ending the shift departs it;
--   * 'depart' is accepted from pending / en_route / on_scene. An unverified position
--     still requires an operations reason (existing guard kept) and is still written to
--     shift_stop_actions and audit_log with review_required = true.
-- create or replace keeps the existing grants on both functions.

create or replace function public.record_static_shift_presence(
  p_shift_id uuid, p_action text, p_request_id uuid, p_gps_lat double precision, p_gps_lng double precision, p_reason text
) returns void language plpgsql security definer set search_path = pg_catalog, public
as $function$
declare v_shift public.shifts%rowtype; v_stop public.shift_stops%rowtype; v_module public.shift_stop_modules%rowtype;
  v_position jsonb; v_at timestamptz := clock_timestamp(); v_action_id uuid := gen_random_uuid(); v_receipt jsonb;
begin
  select * into v_shift from public.shifts where id = p_shift_id for update;
  if not found or auth.uid() is null or v_shift.officer_user_id is distinct from auth.uid() or v_shift.status <> 'in_progress' then
    raise exception 'Assigned in-progress shift required' using errcode = '42501';
  end if;
  if p_action not in ('arrive','depart') or p_action is null or p_request_id is null then raise exception 'Attendance action and request required'; end if;
  v_position := public.evaluate_static_shift_position(v_shift.id, p_gps_lat, p_gps_lng);
  if v_position->>'status' <> 'on_site' and nullif(btrim(p_reason),'') is null then
    raise exception 'Explain the unverified attendance for operations review';
  end if;
  select * into v_stop from public.shift_stops where shift_id = v_shift.id and module_key = 'static_guarding' for update;
  if exists(select 1 from public.shift_stop_actions where shift_stop_id = v_stop.id
    and action_type = case when p_action = 'arrive' then 'static_post_arrived' else 'static_post_departed' end) then return; end if;
  select * into v_module from public.shift_stop_modules where shift_stop_id = v_stop.id and module_key = 'static_guarding' and is_required for update;
  if not found then raise exception 'Static guarding module task is missing'; end if;
  if not exists(select 1 from public.service_agreement_modules sam join public.service_agreement_locations sal on sal.service_agreement_id = sam.service_agreement_id
    where sam.id = v_module.service_agreement_module_id and sal.id = v_module.service_agreement_location_id
      and sam.module_key = 'static_guarding' and sam.enabled and sal.status = 'active') then raise exception 'Static guarding contract is no longer active'; end if;
  if p_action = 'arrive' then
    if v_stop.status not in ('pending','en_route','on_scene') then raise exception 'Static post cannot be started from this state'; end if;
    update public.shift_stops set status = 'on_scene', actual_arrived_at = coalesce(actual_arrived_at,v_at),
      arrived_gps_lat = p_gps_lat, arrived_gps_lng = p_gps_lng,
      arrival_verification = case when (v_position->>'verified_attendance')::boolean then 'verified_on_site'
        when v_position->>'status' = 'unverified_site' then 'unverified_boundary' else v_position->>'status' end,
      updated_at = v_at where id = v_stop.id returning * into v_stop;
    update public.shift_stop_modules set status = 'in_progress', started_at = coalesce(started_at,v_at), updated_at = v_at where id = v_module.id;
  else
    -- Departing ends the post. Allowed from pending / en_route / on_scene so an officer
    -- who could not verify the boundary can still close the shift; the unverified
    -- position already required a reason above and is recorded for operations review.
    if v_stop.status not in ('pending','en_route','on_scene') then raise exception 'Static post cannot be completed from this state'; end if;
    update public.shift_stop_modules set status = 'completed', completed_at = v_at, updated_at = v_at where id = v_module.id;
    update public.shift_stops set status = 'completed', actual_departed_at = v_at,
      departed_gps_lat = p_gps_lat, departed_gps_lng = p_gps_lng, sla_status = 'completed', updated_at = v_at
      where id = v_stop.id returning * into v_stop;
    update public.shifts set completed_stops = 1 where id = v_shift.id;
  end if;
  v_receipt := jsonb_build_object('reference','SG-'||upper(left(replace(v_action_id::text,'-',''),8)),
    'action',p_action,'occurred_at',v_at,'shift_id',v_shift.id,'stop_id',v_stop.id,
    'gps_result',v_position->>'status','timing_status','recorded',
    'dwell_minutes',greatest(0,floor(extract(epoch from (v_at-coalesce(v_stop.actual_arrived_at,v_at)))/60)),
    'handover_recorded',p_action = 'depart');
  insert into public.shift_stop_actions(id,organization_id,shift_stop_id,shift_id,shift_stop_module_id,action_type,
    gps_lat,gps_lng,performed_at,client_request_id,evidence_metadata,receipt)
  values(v_action_id,v_shift.organization_id,v_stop.id,v_shift.id,v_module.id,
    case when p_action = 'arrive' then 'static_post_arrived' else 'static_post_departed' end,
    p_gps_lat,p_gps_lng,v_at,p_request_id,jsonb_build_object('capture_method','shift_attendance',
      'position_status',v_position->>'status','verified_attendance',(v_position->>'verified_attendance')::boolean,
      'review_required',v_position->>'status' <> 'on_site','exception_reason',nullif(btrim(p_reason),'')),v_receipt);
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  values(v_shift.organization_id,auth.uid(),'static_shift_attendance','shift_stops',v_stop.id,
    jsonb_build_object('shift_id',v_shift.id,'action',p_action,'position_status',v_position->>'status',
      'review_required',v_position->>'status' <> 'on_site','exception_reason',nullif(btrim(p_reason),'')));
end;
$function$;

create or replace function public.get_officer_attendance_readiness(p_shift_id uuid)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public
as $function$
declare v_source jsonb; v_single boolean; v_stops integer; v_tasks integer; v_open_breaks integer; v_clear boolean;
begin
  if auth.uid() is null or not exists(select 1 from public.user_profiles where id = auth.uid() and deactivated_at is null) then
    raise exception 'Active officer required' using errcode = '42501';
  end if;
  v_source := public.get_officer_recovery_readiness(p_shift_id);
  select service_type = 'static_guarding' and (select count(*) from public.shift_stops where shift_id = s.id) = 1
    into v_single from public.shifts s where id = p_shift_id;
  v_stops := (v_source->>'open_stop_count')::integer;
  v_tasks := (v_source->>'open_required_task_count')::integer;
  if v_single then
    -- The one static post stop is closed by departing it as the shift ends, so it does
    -- not block the end-of-shift gate even when the officer never arrived on site.
    v_stops := 0;
    select count(*) into v_tasks from public.shift_stop_modules sm join public.shift_stops st on st.id = sm.shift_stop_id
      where st.shift_id = p_shift_id and sm.is_required and sm.status not in ('completed','skipped') and sm.module_key <> 'static_guarding';
  end if;
  select count(*) into v_open_breaks from public.shift_breaks where shift_id = p_shift_id and ended_at is null;
  v_clear := v_source->>'status' = 'in_progress' and v_stops = 0 and v_tasks = 0
    and (v_source->>'open_dispatch_job_count')::integer = 0 and (v_source->>'active_welfare_alert_count')::integer = 0 and v_open_breaks = 0;
  return v_source || jsonb_build_object('single_site_attendance',coalesce(v_single,false),
    'open_stop_count',v_stops,'open_required_task_count',v_tasks,'open_break_count',v_open_breaks,
    'can_end_after_debrief',v_clear,'can_end',v_clear and (v_source->>'debrief_submitted')::boolean);
end;
$function$;
