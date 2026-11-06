alter table public.roster_slots
  add column planned_break_minutes integer not null default 0,
  add column break_unpaid boolean not null default false,
  add constraint roster_slots_planned_break_check check (
    planned_break_minutes >= 0 and planned_break_minutes <= 240
    and planned_break_minutes < extract(epoch from (scheduled_end - scheduled_start)) / 60
  );

create or replace function public.create_roster_slot_with_break(
  p_client_request_id uuid, p_work_unit_id uuid, p_staff_id uuid,
  p_scheduled_start timestamptz, p_scheduled_end timestamptz,
  p_publish boolean default false, p_notes text default null,
  p_planned_break_minutes integer default 0, p_break_unpaid boolean default false
) returns public.roster_slots
language plpgsql security definer set search_path = pg_catalog, public
as $function$
declare v_slot public.roster_slots%rowtype;
begin
  if p_planned_break_minutes is null or p_break_unpaid is null then raise exception 'Break settings are required'; end if;
  select * into v_slot from public.create_roster_slot(p_client_request_id, p_work_unit_id, p_staff_id,
    p_scheduled_start, p_scheduled_end, false, p_notes);
  if auth.uid() is null or not public.is_admin_for_org(v_slot.organization_id)
    or not exists(select 1 from public.user_profiles where id = auth.uid() and deactivated_at is null) then
    raise exception 'Active roster administrator required' using errcode = '42501';
  end if;
  if v_slot.work_unit_id is distinct from p_work_unit_id or v_slot.staff_id is distinct from p_staff_id
    or v_slot.scheduled_start is distinct from p_scheduled_start or v_slot.scheduled_end is distinct from p_scheduled_end
    or v_slot.notes is distinct from nullif(btrim(coalesce(p_notes,'')),'') then
    raise exception 'This request already created a different roster slot';
  end if;
  if v_slot.status <> 'draft' then
    if v_slot.planned_break_minutes is distinct from p_planned_break_minutes
      or v_slot.break_unpaid is distinct from p_break_unpaid then
      raise exception 'This request already created a different break plan';
    end if;
    return v_slot;
  end if;
  select * into v_slot from public.set_roster_slot_break(v_slot.id, 'draft', p_planned_break_minutes, p_break_unpaid);
  if p_publish then
    if v_slot.staff_id is not null then
      perform public.manage_roster_slot(v_slot.id, 'draft', 'publish', null);
      select * into v_slot from public.roster_slots where id = v_slot.id;
    else
      update public.roster_slots set status = 'published' where id = v_slot.id returning * into v_slot;
      insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
      values(v_slot.organization_id,auth.uid(),'roster_slot_published','roster_slots',v_slot.id,jsonb_build_object('is_open',true));
    end if;
  end if;
  return v_slot;
end;
$function$;

create or replace function public.set_roster_slot_break(
  p_slot_id uuid, p_expected_status text, p_planned_break_minutes integer, p_break_unpaid boolean
) returns public.roster_slots
language plpgsql security definer set search_path = pg_catalog, public
as $function$
declare v_slot public.roster_slots%rowtype;
begin
  select * into v_slot from public.roster_slots where id = p_slot_id for update;
  if not found or auth.uid() is null or not public.is_admin_for_org(v_slot.organization_id) then
    raise exception 'Roster administrator required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.user_profiles where id = auth.uid() and deactivated_at is null) then
    raise exception 'Active administrator required' using errcode = '42501';
  end if;
  if v_slot.status is distinct from p_expected_status or v_slot.status <> 'draft' then
    raise exception 'Only an unchanged draft can have its break plan edited';
  end if;
  if p_planned_break_minutes is null or p_break_unpaid is null then raise exception 'Break settings are required'; end if;
  update public.roster_slots set planned_break_minutes = p_planned_break_minutes,
    break_unpaid = p_break_unpaid, updated_at = clock_timestamp() where id = v_slot.id returning * into v_slot;
  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values(v_slot.organization_id, auth.uid(), 'roster_break_planned', 'roster_slots', v_slot.id,
    jsonb_build_object('planned_break_minutes', p_planned_break_minutes, 'unpaid', p_break_unpaid));
  return v_slot;
end;
$function$;

create or replace function public.update_roster_slot_with_break(
  p_slot_id uuid, p_expected_status text, p_staff_id uuid,
  p_scheduled_start timestamptz, p_scheduled_end timestamptz, p_notes text default null,
  p_planned_break_minutes integer default 0, p_break_unpaid boolean default false
) returns public.roster_slots
language plpgsql security definer set search_path = pg_catalog, public
as $function$
declare v_slot public.roster_slots%rowtype;
begin
  select * into v_slot from public.roster_slots where id = p_slot_id for update;
  if not found or auth.uid() is null or not public.is_admin_for_org(v_slot.organization_id)
    or not exists(select 1 from public.user_profiles where id = auth.uid() and deactivated_at is null)
    or v_slot.status is distinct from p_expected_status or v_slot.status <> 'draft' then
    raise exception 'An unchanged draft and active roster administrator are required' using errcode = '42501';
  end if;
  -- The old allowance must not prevent shortening a shift while reducing its break in the same transaction.
  update public.roster_slots set planned_break_minutes = 0 where id = p_slot_id;
  perform public.update_roster_slot(p_slot_id, p_expected_status, p_staff_id, p_scheduled_start, p_scheduled_end, p_notes);
  select * into v_slot from public.set_roster_slot_break(p_slot_id, p_expected_status, p_planned_break_minutes, p_break_unpaid);
  return v_slot;
end;
$function$;

create or replace function public.guard_shift_break_lifecycle()
returns trigger language plpgsql security definer set search_path = pg_catalog, public
as $function$
begin
  if new.status = 'completed' and old.status is distinct from new.status
    and exists(select 1 from public.shift_breaks where shift_id = new.id and ended_at is null) then
    raise exception 'Finish the open break before completing this shift';
  end if;
  return new;
end;
$function$;
create trigger guard_shift_break_lifecycle before update of status on public.shifts
for each row execute function public.guard_shift_break_lifecycle();

create or replace function public.repeat_roster_slot_range(p_source_slot_id uuid,p_from_date date,p_to_date date)
returns table(created_count integer,skipped_conflict_count integer,leave_conflict_count integer)
language plpgsql security definer set search_path = pg_catalog, public
as $function$
declare v_actor uuid := auth.uid(); v_source public.roster_slots%rowtype; v_day date; v_start timestamptz;
  v_end timestamptz; v_created integer := 0; v_skipped integer := 0; v_leave integer := 0; v_duration interval;
begin
  select * into v_source from public.roster_slots where id = p_source_slot_id for update;
  if not found or v_actor is null or not public.is_admin_for_org(v_source.organization_id)
    or not exists(select 1 from public.user_profiles where id = v_actor and deactivated_at is null) then
    raise exception 'Active roster administrator required' using errcode = '42501';
  end if;
  if v_source.status in ('completed','cancelled') then raise exception 'Completed or cancelled slots cannot be repeated'; end if;
  if p_from_date is null or p_to_date is null or p_from_date > p_to_date or p_to_date - p_from_date > 92 then
    raise exception 'Repeat period must be between 1 and 93 days';
  end if;
  v_duration := v_source.scheduled_end - v_source.scheduled_start;
  for v_day in select generate_series(p_from_date,p_to_date,interval '1 day')::date loop
    v_start := v_day + v_source.scheduled_start::time; v_end := v_start + v_duration;
    if exists(select 1 from public.leave_requests l where l.staff_id = v_source.staff_id and l.status = 'approved'
      and daterange(l.starts_on,l.ends_on,'[]') && daterange(v_start::date,v_end::date,'[]')) then
      v_leave := v_leave + 1; continue;
    end if;
    if exists(select 1 from public.roster_slots s where s.staff_id = v_source.staff_id and s.status not in ('declined','cancelled')
      and s.scheduled_start < v_end and s.scheduled_end > v_start) then v_skipped := v_skipped + 1; continue; end if;
    insert into public.roster_slots(organization_id,work_unit_id,staff_id,scheduled_start,scheduled_end,status,
      client_request_id,notes,created_by,planned_break_minutes,break_unpaid)
    values(v_source.organization_id,v_source.work_unit_id,v_source.staff_id,v_start,v_end,'draft',gen_random_uuid(),
      coalesce(v_source.notes,'') || ' - Repeated assignment',v_actor,v_source.planned_break_minutes,v_source.break_unpaid);
    v_created := v_created + 1;
  end loop;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  values(v_source.organization_id,v_actor,'roster_slot_repeated','roster_slots',v_source.id,
    jsonb_build_object('from_date',p_from_date,'to_date',p_to_date,'created_count',v_created,
      'skipped_conflict_count',v_skipped,'leave_conflict_count',v_leave));
  return query select v_created,v_skipped,v_leave;
end;
$function$;

create or replace function public.get_officer_break_plan(p_shift_id uuid)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public
as $function$
declare v_shift public.shifts%rowtype; v_slot public.roster_slots%rowtype; v_minutes numeric;
begin
  select * into v_shift from public.shifts where id = p_shift_id;
  if not found or auth.uid() is null or v_shift.officer_user_id is distinct from auth.uid()
    or not exists(select 1 from public.user_profiles where id = auth.uid() and deactivated_at is null) then
    raise exception 'Active assigned officer required' using errcode = '42501';
  end if;
  select * into v_slot from public.roster_slots where linked_shift_id = v_shift.id and status <> 'cancelled';
  select coalesce(sum(extract(epoch from (b.ended_at - b.started_at)) / 60), 0) into v_minutes
    from public.shift_breaks b where b.shift_id = v_shift.id and b.ended_at is not null
      and b.is_paid = not coalesce(v_slot.break_unpaid, false);
  return jsonb_build_object('shift_id', v_shift.id, 'planned_minutes', coalesce(v_slot.planned_break_minutes, 0),
    'unpaid', coalesce(v_slot.break_unpaid, false), 'taken_minutes', v_minutes,
    'review_status', case when coalesce(v_slot.planned_break_minutes, 0) = 0 then 'not_planned'
      when v_minutes = 0 then 'not_recorded' when v_minutes < v_slot.planned_break_minutes then 'short'
      when v_minutes > v_slot.planned_break_minutes then 'long' else 'matched' end);
end;
$function$;

create or replace function public.evaluate_static_shift_position(p_shift_id uuid, p_gps_lat double precision, p_gps_lng double precision)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public, extensions
as $function$
declare v_shift public.shifts%rowtype; v_stop public.shift_stops%rowtype; v_verified boolean := false; v_status text;
begin
  select * into v_shift from public.shifts where id = p_shift_id;
  if not found or auth.uid() is null or v_shift.officer_user_id is distinct from auth.uid()
    or v_shift.service_type <> 'static_guarding'
    or not exists(select 1 from public.user_profiles where id = auth.uid() and deactivated_at is null) then
    raise exception 'Active assigned static officer required' using errcode = '42501';
  end if;
  if (select count(*) from public.shift_stops where shift_id = v_shift.id) <> 1 then
    raise exception 'Static work requires one assigned place; contact operations';
  end if;
  select * into v_stop from public.shift_stops where shift_id = v_shift.id and module_key = 'static_guarding';
  if not found then raise exception 'Static guarding stop is missing'; end if;
  if p_gps_lat is null or p_gps_lng is null then
    v_status := 'no_gps';
  elsif not (p_gps_lat between -90 and 90 and p_gps_lng between -180 and 180) then
    raise exception 'Invalid GPS position';
  else
    select coalesce(cs.boundary_verification = 'verified' and cs.boundary is not null
      and st_isvalid(cs.boundary) and not st_isempty(cs.boundary)
      and (st_covers(cs.boundary, st_setsrid(st_point(p_gps_lng, p_gps_lat),4326))
        or st_dwithin(coalesce(cs.center_point,cs.boundary)::geography,
          st_setsrid(st_point(p_gps_lng,p_gps_lat),4326)::geography,coalesce(cs.onsite_radius_meters,10))), false)
      into v_verified from public.client_sites cs where cs.id = v_stop.site_id and cs.active;
    v_status := case when coalesce(v_verified, false) then 'on_site'
      when exists(select 1 from public.client_sites where id = v_stop.site_id and active and boundary is not null and boundary_verification = 'verified') then 'off_site'
      else 'unverified_site' end;
  end if;
  return jsonb_build_object('status',v_status,'verified_attendance',coalesce(v_verified,false));
end;
$function$;

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
    if v_stop.status <> 'on_scene' then raise exception 'Start this static post before ending the shift'; end if;
    update public.shift_stop_modules set status = 'completed', completed_at = v_at, updated_at = v_at where id = v_module.id;
    update public.shift_stops set status = 'completed', actual_departed_at = v_at,
      departed_gps_lat = p_gps_lat, departed_gps_lng = p_gps_lng, sla_status = 'completed', updated_at = v_at
      where id = v_stop.id returning * into v_stop;
    update public.shifts set completed_stops = 1 where id = v_shift.id;
  end if;
  v_receipt := jsonb_build_object('reference','SG-'||upper(left(replace(v_action_id::text,'-',''),8)),
    'action',p_action,'occurred_at',v_at,'shift_id',v_shift.id,'stop_id',v_stop.id,
    'gps_result',v_position->>'status','timing_status','recorded',
    'dwell_minutes',greatest(0,floor(extract(epoch from (v_at-v_stop.actual_arrived_at))/60)),
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

create or replace function public.start_officer_static_shift(
  p_client_request_id uuid, p_shift_id uuid, p_expected_status text,
  p_gps_lat double precision default null, p_gps_lng double precision default null, p_off_site_reason text default null
) returns table(shift_id uuid,shift_status text,started_at timestamptz,created boolean,position_status text,
  place_name text,distance_m numeric,superseded_shift_id uuid,superseded_service_type text,superseded_started_at timestamptz)
language plpgsql security definer set search_path = pg_catalog, public
as $function$
begin
  perform public.evaluate_static_shift_position(p_shift_id,p_gps_lat,p_gps_lng);
  return query select * from public.start_officer_shift(p_client_request_id,p_shift_id,p_expected_status,p_gps_lat,p_gps_lng,p_off_site_reason);
  perform public.record_static_shift_presence(p_shift_id,'arrive',p_client_request_id,p_gps_lat,p_gps_lng,p_off_site_reason);
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
    select count(*) into v_stops from public.shift_stops where shift_id = p_shift_id and status not in ('on_scene','completed','skipped','cancelled');
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

create or replace function public.complete_officer_static_shift(
  p_shift_id uuid, p_expected_status text, p_gps_lat double precision default null,
  p_gps_lng double precision default null, p_off_site_reason text default null
) returns table(shift_id uuid,shift_status text,completed_at timestamptz)
language plpgsql security definer set search_path = pg_catalog, public
as $function$
declare v_readiness jsonb; v_shift public.shifts%rowtype;
begin
  select * into v_shift from public.shifts where id = p_shift_id for update;
  v_readiness := public.get_officer_attendance_readiness(p_shift_id);
  if v_shift.status = 'completed' and v_shift.actual_end is not null
    and (v_readiness->>'single_site_attendance')::boolean
    and exists(select 1 from public.shift_stop_actions a
      where a.shift_id = p_shift_id and a.action_type = 'static_post_departed') then
    return query select v_shift.id, v_shift.status, v_shift.actual_end;
    return;
  end if;
  if not coalesce((v_readiness->>'single_site_attendance')::boolean,false)
    or not coalesce((v_readiness->>'can_end')::boolean,false) then raise exception 'Finish required work, break and debrief before ending this static shift'; end if;
  perform public.record_static_shift_presence(p_shift_id,'depart',gen_random_uuid(),p_gps_lat,p_gps_lng,p_off_site_reason);
  return query select * from public.complete_officer_shift(p_shift_id,p_expected_status,p_gps_lat,p_gps_lng);
end;
$function$;

revoke all on function public.record_static_shift_presence(uuid,text,uuid,double precision,double precision,text) from public,anon,authenticated,service_role;
revoke all on function public.guard_shift_break_lifecycle() from public,anon,authenticated,service_role;
revoke all on function public.repeat_roster_slot_range(uuid,date,date) from public,anon,authenticated,service_role;
revoke all on function public.create_roster_slot_with_break(uuid,uuid,uuid,timestamptz,timestamptz,boolean,text,integer,boolean) from public,anon,authenticated,service_role;
revoke all on function public.set_roster_slot_break(uuid,text,integer,boolean) from public,anon,authenticated,service_role;
revoke all on function public.update_roster_slot_with_break(uuid,text,uuid,timestamptz,timestamptz,text,integer,boolean) from public,anon,authenticated,service_role;
revoke all on function public.get_officer_break_plan(uuid) from public,anon,authenticated,service_role;
revoke all on function public.evaluate_static_shift_position(uuid,double precision,double precision) from public,anon,authenticated,service_role;
revoke all on function public.start_officer_static_shift(uuid,uuid,text,double precision,double precision,text) from public,anon,authenticated,service_role;
revoke all on function public.get_officer_attendance_readiness(uuid) from public,anon,authenticated,service_role;
revoke all on function public.complete_officer_static_shift(uuid,text,double precision,double precision,text) from public,anon,authenticated,service_role;
grant execute on function public.create_roster_slot_with_break(uuid,uuid,uuid,timestamptz,timestamptz,boolean,text,integer,boolean),
  public.repeat_roster_slot_range(uuid,date,date),
  public.set_roster_slot_break(uuid,text,integer,boolean),
  public.update_roster_slot_with_break(uuid,text,uuid,timestamptz,timestamptz,text,integer,boolean),
  public.get_officer_break_plan(uuid),public.evaluate_static_shift_position(uuid,double precision,double precision),
  public.start_officer_static_shift(uuid,uuid,text,double precision,double precision,text),
  public.get_officer_attendance_readiness(uuid),public.complete_officer_static_shift(uuid,text,double precision,double precision,text)
to authenticated,postgres;