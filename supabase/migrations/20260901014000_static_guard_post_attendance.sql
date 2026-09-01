alter table public.shift_stop_actions
  add column if not exists client_request_id uuid,
  add column if not exists gps_accuracy_metres double precision,
  add column if not exists evidence_metadata jsonb not null default '{}'::jsonb,
  add column if not exists receipt jsonb;
create unique index if not exists shift_stop_actions_org_request_uidx on public.shift_stop_actions(organization_id,client_request_id) where client_request_id is not null;

create or replace function public.get_officer_static_post(p_shift_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare
  v_actor uuid:=auth.uid();
  v_shift public.shifts%rowtype;
  v_stop public.shift_stops%rowtype;
  v_module public.shift_stop_modules%rowtype;
  v_site public.client_sites%rowtype;
  v_zone public.location_zones%rowtype;
begin
  if v_actor is null then raise exception 'Authentication required';end if;
  select s.* into v_shift from public.shifts s
  where s.officer_user_id=v_actor and s.service_type='static_guarding'
    and s.status in('accepted','in_progress') and (p_shift_id is null or s.id=p_shift_id)
  order by
    case
      when s.status='in_progress' then 0
      when now() between s.scheduled_start and s.scheduled_end then 1
      when s.scheduled_start>now() then 2
      else 3
    end,
    case when s.scheduled_start>now() then s.scheduled_start end,
    s.scheduled_start desc
  limit 1;
  if not found then return null;end if;

  select st.* into v_stop from public.shift_stops st
  where st.shift_id=v_shift.id and st.module_key='static_guarding'
  order by st.stop_order limit 1;
  if not found then raise exception 'Static guarding stop is missing';end if;
  select sm.* into v_module from public.shift_stop_modules sm
  where sm.shift_stop_id=v_stop.id and sm.module_key='static_guarding' and sm.is_required
  order by sm.created_at limit 1;
  if not found then raise exception 'Static guarding module task is missing';end if;
  if not exists(select 1 from public.service_agreement_modules sam join public.service_agreement_locations sal on sal.service_agreement_id=sam.service_agreement_id where sam.id=v_module.service_agreement_module_id and sal.id=v_module.service_agreement_location_id and sam.module_key='static_guarding' and sam.enabled and sal.status='active') then raise exception 'Static guarding contract is no longer active';end if;

  if v_stop.site_id is not null then select cs.* into v_site from public.client_sites cs where cs.id=v_stop.site_id and cs.active;end if;
  if v_stop.zone_id is not null then select z.* into v_zone from public.location_zones z where z.id=v_stop.zone_id;end if;
  return jsonb_build_object(
    'shift',jsonb_build_object('id',v_shift.id,'status',v_shift.status,'scheduled_start',v_shift.scheduled_start,'scheduled_end',v_shift.scheduled_end,'notes',v_shift.notes),
    'stop',jsonb_build_object('id',v_stop.id,'status',v_stop.status,'sla_arrive_by',v_stop.sla_arrive_by,'actual_arrived_at',v_stop.actual_arrived_at,'actual_departed_at',v_stop.actual_departed_at,'officer_notes',v_stop.officer_notes),
    'module',jsonb_build_object('id',v_module.id,'status',v_module.status,'started_at',v_module.started_at,'completed_at',v_module.completed_at),
    'place',jsonb_build_object('id',coalesce(v_site.id,v_zone.id),'name',coalesce(v_site.name,v_zone.name),'address',v_site.address,'risk_level',v_site.risk_level,'site_brief',v_site.site_brief,'access_instructions',v_site.access_instructions,'hs_notes',v_site.hs_notes)
  );
end;$$;

create or replace function public.manage_officer_static_post(p_stop_id uuid,p_expected_status text,p_action text,p_request_id uuid,p_notes text default null,p_gps_lat double precision default null,p_gps_lng double precision default null,p_gps_accuracy_metres double precision default null)
returns jsonb language plpgsql volatile security definer set search_path=public as $$
declare
  v_actor uuid:=auth.uid();
  v_stop public.shift_stops%rowtype;
  v_shift public.shifts%rowtype;
  v_module public.shift_stop_modules%rowtype;
  v_at timestamptz:=clock_timestamp();
  v_notes text:=nullif(trim(coalesce(p_notes,'')),'');
  v_action_id uuid:=gen_random_uuid();
  v_receipt jsonb;
begin
  if v_actor is null then raise exception 'Authentication required';end if;
  if p_request_id is null then raise exception 'Request id is required';end if;
  if p_action not in('arrive','depart') then raise exception 'Unsupported static post action';end if;
  select st.* into v_stop from public.shift_stops st where st.id=p_stop_id for update;
  if not found then raise exception 'Static guarding stop not found';end if;
  select s.* into v_shift from public.shifts s where s.id=v_stop.shift_id for update;
  if not found or v_shift.officer_user_id<>v_actor then raise exception 'Static guarding stop is not assigned to this officer';end if;
  if v_shift.service_type<>'static_guarding' or v_stop.module_key<>'static_guarding' then raise exception 'Stop is not static guarding work';end if;
  select a.receipt into v_receipt from public.shift_stop_actions a where a.organization_id=v_shift.organization_id and a.client_request_id=p_request_id;
  if found then return v_receipt;end if;
  if v_stop.status<>p_expected_status then raise exception 'Static guarding stop changed from expected status % to %',p_expected_status,v_stop.status;end if;
  select sm.* into v_module from public.shift_stop_modules sm where sm.shift_stop_id=v_stop.id and sm.module_key='static_guarding' and sm.is_required for update;
  if not found then raise exception 'Static guarding module task is missing';end if;
  if not exists(select 1 from public.service_agreement_modules sam join public.service_agreement_locations sal on sal.service_agreement_id=sam.service_agreement_id where sam.id=v_module.service_agreement_module_id and sal.id=v_module.service_agreement_location_id and sam.module_key='static_guarding' and sam.enabled and sal.status='active') then raise exception 'Static guarding contract is no longer active';end if;

  if p_gps_lat is null or p_gps_lng is null or p_gps_lat not between -90 and 90 or p_gps_lng not between -180 and 180 then raise exception 'A valid GPS position is required';end if;
  if p_gps_accuracy_metres is null or p_gps_accuracy_metres<=0 then raise exception 'GPS accuracy is required';end if;

  if p_action='arrive' then
    if p_expected_status not in('pending','en_route') then raise exception 'Static post cannot be started from %',p_expected_status;end if;
    update public.shift_stops set status='on_scene',actual_arrived_at=coalesce(actual_arrived_at,v_at),arrived_gps_lat=p_gps_lat,arrived_gps_lng=p_gps_lng,sla_status=case when v_at>sla_arrive_by then 'breached' else 'on_track' end,updated_at=v_at where id=v_stop.id returning * into v_stop;
    update public.shift_stop_modules set status='in_progress',started_at=coalesce(started_at,v_at),updated_at=v_at where id=v_module.id returning * into v_module;
    update public.shifts set status='in_progress',actual_start=coalesce(actual_start,v_at),updated_at=v_at where id=v_shift.id and status='accepted';
  else
    if p_expected_status<>'on_scene' then raise exception 'Static post cannot be completed from %',p_expected_status;end if;
    if v_notes is null then raise exception 'Departure notes are required';end if;
    update public.shift_stop_modules set status='completed',completed_at=v_at,outcome=v_notes,updated_at=v_at where id=v_module.id returning * into v_module;
    update public.shift_stops set status=case when exists(select 1 from public.shift_stop_modules sm where sm.shift_stop_id=v_stop.id and sm.is_required and sm.status not in('completed','skipped')) then status else 'completed' end,actual_departed_at=v_at,officer_notes=v_notes,sla_status=case when exists(select 1 from public.shift_stop_modules sm where sm.shift_stop_id=v_stop.id and sm.is_required and sm.status not in('completed','skipped')) then sla_status else 'completed' end,updated_at=v_at where id=v_stop.id returning * into v_stop;
    update public.shifts set completed_stops=(select count(*) from public.shift_stops st where st.shift_id=v_shift.id and st.status='completed'),updated_at=v_at where id=v_shift.id;
  end if;

  v_receipt:=jsonb_build_object('reference','SG-'||upper(left(replace(v_action_id::text,'-',''),8)),'action',p_action,'occurred_at',v_at,'shift_id',v_shift.id,'stop_id',v_stop.id,'stop_status',v_stop.status,'module_status',v_module.status,'gps_result','captured','gps_accuracy_metres',p_gps_accuracy_metres,'timing_status',case when p_action='arrive' and v_at>v_stop.sla_arrive_by then 'late' when p_action='arrive' then 'on_time' else 'recorded' end,'dwell_minutes',case when v_stop.actual_arrived_at is null then null else greatest(0,floor(extract(epoch from (v_at-v_stop.actual_arrived_at))/60)) end,'handover_recorded',p_action='depart' and v_notes is not null);
  insert into public.shift_stop_actions(id,organization_id,shift_stop_id,shift_id,shift_stop_module_id,action_type,outcome,notes,gps_lat,gps_lng,performed_at,client_request_id,gps_accuracy_metres,evidence_metadata,receipt) values(v_action_id,v_shift.organization_id,v_stop.id,v_shift.id,v_module.id,case when p_action='arrive' then 'static_post_arrived' else 'static_post_departed' end,v_stop.status,v_notes,p_gps_lat,p_gps_lng,v_at,p_request_id,p_gps_accuracy_metres,jsonb_build_object('capture_method','browser_geolocation','mocked_location_reported',null,'geofence_result','not_evaluated'),v_receipt);
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_shift.organization_id,v_actor,case when p_action='arrive' then 'static_post_arrived' else 'static_post_departed' end,'shift_stops',v_stop.id,jsonb_build_object('shift_id',v_shift.id,'module_task_id',v_module.id,'previous_status',p_expected_status,'new_status',v_stop.status,'gps_captured',p_gps_lat is not null and p_gps_lng is not null));
  return v_receipt;
end;$$;

revoke all on function public.get_officer_static_post(uuid) from public,anon;
grant execute on function public.get_officer_static_post(uuid) to authenticated,service_role;
revoke all on function public.manage_officer_static_post(uuid,text,text,uuid,text,double precision,double precision,double precision) from public,anon;
grant execute on function public.manage_officer_static_post(uuid,text,text,uuid,text,double precision,double precision,double precision) to authenticated,service_role;
revoke insert,update,delete,truncate on table public.shift_stops from authenticated;
revoke insert,update,delete,truncate on table public.shift_stop_modules from authenticated;
revoke insert,update,delete,truncate on table public.shift_stop_actions from authenticated;
