create or replace function public.get_officer_static_post(p_shift_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare
  v_actor uuid:=auth.uid();
  v_shift public.shifts%rowtype;
  v_stop public.shift_stops%rowtype;
  v_module public.shift_stop_modules%rowtype;
  v_site public.client_sites%rowtype;
  v_zone public.location_zones%rowtype;
  v_arrival_receipt jsonb;
  v_departure_receipt jsonb;
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
  select a.receipt into v_arrival_receipt from public.shift_stop_actions a where a.shift_stop_id=v_stop.id and a.action_type='static_post_arrived' order by a.performed_at desc limit 1;
  select a.receipt into v_departure_receipt from public.shift_stop_actions a where a.shift_stop_id=v_stop.id and a.action_type='static_post_departed' order by a.performed_at desc limit 1;

  return jsonb_build_object(
    'shift',jsonb_build_object('id',v_shift.id,'status',v_shift.status,'scheduled_start',v_shift.scheduled_start,'scheduled_end',v_shift.scheduled_end,'notes',v_shift.notes),
    'stop',jsonb_build_object('id',v_stop.id,'status',v_stop.status,'sla_arrive_by',v_stop.sla_arrive_by,'actual_arrived_at',v_stop.actual_arrived_at,'actual_departed_at',v_stop.actual_departed_at,'officer_notes',v_stop.officer_notes),
    'module',jsonb_build_object('id',v_module.id,'status',v_module.status,'started_at',v_module.started_at,'completed_at',v_module.completed_at),
    'place',jsonb_build_object('id',coalesce(v_site.id,v_zone.id),'name',coalesce(v_site.name,v_zone.name),'address',v_site.address,'risk_level',v_site.risk_level,'site_brief',v_site.site_brief,'access_instructions',v_site.access_instructions,'hs_notes',v_site.hs_notes),
    'attendance_evidence',jsonb_build_object('arrival',v_arrival_receipt,'departure',v_departure_receipt)
  );
end;$$;

revoke all on function public.get_officer_static_post(uuid) from public,anon;
grant execute on function public.get_officer_static_post(uuid) to authenticated,service_role;