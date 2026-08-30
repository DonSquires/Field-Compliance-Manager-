alter table public.shifts
  add column if not exists roster_slot_id uuid references public.roster_slots(id) on delete set null,
  add column if not exists service_agreement_location_id uuid references public.service_agreement_locations(id) on delete set null,
  add column if not exists service_agreement_module_id uuid references public.service_agreement_modules(id) on delete set null;
create unique index if not exists idx_shifts_roster_slot on public.shifts(roster_slot_id) where roster_slot_id is not null;

create function public.materialize_roster_slot(p_slot_id uuid,p_expected_status text default 'published')
returns table(slot_id uuid,shift_id uuid,created boolean) language plpgsql volatile security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_slot public.roster_slots%rowtype;v_unit public.roster_work_units%rowtype;v_staff public.staff_profiles%rowtype;v_user uuid;v_shift public.shifts%rowtype;v_sal public.service_agreement_locations%rowtype;v_site_location uuid;v_stop uuid;
begin
  select s.* into v_slot from public.roster_slots s where s.id=p_slot_id for update;
  if not found then raise exception 'Roster slot not found';end if;
  if not public.is_admin_for_org(v_slot.organization_id) then raise exception 'Not authorised to materialize this roster slot';end if;
  if v_slot.status<>p_expected_status then raise exception 'Roster slot changed from expected status % to %',p_expected_status,v_slot.status;end if;
  if v_slot.linked_shift_id is not null then return query select v_slot.id,v_slot.linked_shift_id,false;return;end if;
  select u.* into v_unit from public.roster_work_units u where u.id=v_slot.work_unit_id and u.organization_id=v_slot.organization_id and u.active;
  if not found then raise exception 'Active work unit not found';end if;
  if v_unit.work_unit_type='internal' then raise exception 'Internal roster slots do not materialize field shifts';end if;
  select sp.* into v_staff from public.staff_profiles sp where sp.id=v_slot.staff_id and sp.organization_id=v_slot.organization_id and sp.work_ready;
  if not found then raise exception 'Work-ready staff profile required';end if;
  v_user:=coalesce(v_staff.user_id,v_staff.id);
  if not exists(select 1 from public.user_profiles up where up.id=v_user and up.deactivated_at is null and up.role in('officer','admin_officer')) then raise exception 'Roster slot staff is not an active field officer';end if;

  if v_unit.work_unit_type='patrol' then
    select * into v_shift from public.create_roster_shift(v_user,v_unit.service_type,v_slot.scheduled_start,v_slot.scheduled_end,null,null,v_unit.patrol_route_id,v_slot.notes,true);
    update public.shifts set roster_slot_id=v_slot.id where id=v_shift.id returning * into v_shift;
    perform public.generate_shift_stops(v_shift.id,(v_slot.scheduled_start at time zone 'Pacific/Auckland')::date);
  elsif v_unit.work_unit_type='static' then
    select sal.* into v_sal from public.service_agreement_locations sal where sal.id=v_unit.service_agreement_location_id and sal.status='active';
    if not found or not exists(select 1 from public.service_agreement_modules sam where sam.id=v_unit.service_agreement_module_id and sam.service_agreement_id=v_sal.service_agreement_id and sam.enabled and sam.module_key='static_guarding') then raise exception 'Static work unit contract is no longer active';end if;
    if v_sal.site_id is not null then select cs.location_id into v_site_location from public.client_sites cs where cs.id=v_sal.site_id;end if;
    select * into v_shift from public.create_roster_shift(v_user,v_unit.service_type,v_slot.scheduled_start,v_slot.scheduled_end,v_site_location,v_sal.zone_id,null,v_slot.notes,true);
    update public.shifts set roster_slot_id=v_slot.id,service_agreement_location_id=v_unit.service_agreement_location_id,service_agreement_module_id=v_unit.service_agreement_module_id,total_stops=1,generated_at=clock_timestamp() where id=v_shift.id returning * into v_shift;
    insert into public.shift_stops(organization_id,shift_id,site_id,zone_id,module_key,stop_order,visit_number,is_adhoc,sla_arrive_by,required_dwell_minutes,status,sla_status,officer_notes)
    values(v_slot.organization_id,v_shift.id,v_sal.site_id,v_sal.zone_id,'static_guarding',1,1,false,v_slot.scheduled_start,0,'pending','on_track',v_slot.notes) returning id into v_stop;
    insert into public.shift_stop_modules(organization_id,shift_stop_id,module_key,is_required,service_agreement_module_id,service_agreement_location_id)
    values(v_slot.organization_id,v_stop,'static_guarding',true,v_unit.service_agreement_module_id,v_unit.service_agreement_location_id);
  else raise exception 'Unsupported field work unit type';end if;

  update public.roster_slots set linked_shift_id=v_shift.id where id=v_slot.id;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  values(v_slot.organization_id,v_actor,'roster_slot_materialized','roster_slots',v_slot.id,jsonb_build_object('work_unit_id',v_unit.id,'work_unit_type',v_unit.work_unit_type,'shift_id',v_shift.id));
  return query select v_slot.id,v_shift.id,true;
end;$$;
revoke all on function public.materialize_roster_slot(uuid,text) from public,anon;
grant execute on function public.materialize_roster_slot(uuid,text) to authenticated,service_role;