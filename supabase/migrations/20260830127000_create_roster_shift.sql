drop policy if exists shifts_update on public.shifts;
create policy shifts_admin_update on public.shifts for update to authenticated
  using (public.is_admin_for_org(organization_id)) with check (public.is_admin_for_org(organization_id));

create function public.create_roster_shift(
  p_officer_user_id uuid,
  p_service_type text,
  p_scheduled_start timestamptz,
  p_scheduled_end timestamptz,
  p_location_id uuid default null,
  p_zone_id uuid default null,
  p_patrol_route_id uuid default null,
  p_notes text default null,
  p_publish boolean default false
) returns public.shifts
language plpgsql volatile security definer set search_path=public as $$
declare v_actor uuid:=auth.uid(); v_profile public.user_profiles%rowtype; v_staff public.staff_profiles%rowtype; v_shift public.shifts%rowtype;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  select * into v_profile from public.user_profiles where id=p_officer_user_id and deactivated_at is null;
  if not found or v_profile.organization_id is null then raise exception 'Active officer profile not found'; end if;
  if not public.is_admin_for_org(v_profile.organization_id) then raise exception 'Not authorised to roster this officer'; end if;
  if v_profile.role not in ('officer','admin_officer') then raise exception 'Selected user is not rosterable as an officer'; end if;
  select * into v_staff from public.staff_profiles where (id=p_officer_user_id or user_id=p_officer_user_id) and organization_id=v_profile.organization_id limit 1;
  if not found or not v_staff.work_ready then raise exception 'Officer is not work ready'; end if;
  if p_scheduled_start is null or p_scheduled_end is null or p_scheduled_start>=p_scheduled_end then raise exception 'Shift end must be after shift start'; end if;
  if p_scheduled_start<now()-interval '5 minutes' or p_scheduled_end-p_scheduled_start>interval '24 hours' then raise exception 'Shift timing is outside the accepted range'; end if;
  if nullif(trim(coalesce(p_service_type,'')),'') is null then raise exception 'Service type is required'; end if;
  if exists(select 1 from public.leave_requests l where l.staff_id=v_staff.id and l.status='approved' and daterange(l.starts_on,l.ends_on,'[]') && daterange(p_scheduled_start::date,p_scheduled_end::date,'[]')) then raise exception 'Officer has approved leave during this shift'; end if;
  if exists(select 1 from public.shifts s where s.officer_user_id=p_officer_user_id and s.status not in ('declined','cancelled') and s.scheduled_end>s.scheduled_start and s.scheduled_start<p_scheduled_end and s.scheduled_end>p_scheduled_start) then raise exception 'Officer already has an overlapping shift'; end if;
  insert into public.shifts(organization_id,officer_user_id,service_type,location_id,zone_id,patrol_route_id,scheduled_start,scheduled_end,status,notes)
  values(v_profile.organization_id,p_officer_user_id,trim(p_service_type),p_location_id,p_zone_id,p_patrol_route_id,p_scheduled_start,p_scheduled_end,case when p_publish then 'published' else 'scheduled' end,nullif(trim(coalesce(p_notes,'')),'')) returning * into v_shift;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  values(v_profile.organization_id,v_actor,'roster_shift_created','shifts',v_shift.id,jsonb_build_object('officer_user_id',p_officer_user_id,'scheduled_start',p_scheduled_start,'scheduled_end',p_scheduled_end,'status',v_shift.status));
  return v_shift;
end;$$;
revoke all on function public.create_roster_shift(uuid,text,timestamptz,timestamptz,uuid,uuid,uuid,text,boolean) from public,anon;
grant execute on function public.create_roster_shift(uuid,text,timestamptz,timestamptz,uuid,uuid,uuid,text,boolean) to authenticated,service_role;