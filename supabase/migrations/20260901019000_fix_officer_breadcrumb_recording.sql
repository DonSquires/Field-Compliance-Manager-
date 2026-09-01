create or replace function public.record_officer_breadcrumb(
  p_client_event_id uuid,
  p_recorded_at timestamptz,
  p_gps_lat double precision,
  p_gps_lng double precision,
  p_accuracy_meters double precision default null,
  p_heading double precision default null,
  p_speed_kmh double precision default null,
  p_activity_type text default 'gps_update',
  p_shift_id uuid default null
) returns table (id uuid, created boolean, received_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_existing public.officer_gps_log%rowtype;
  v_created public.officer_gps_log%rowtype;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  select up.organization_id into v_org_id from public.user_profiles up
  where up.id = v_user_id and up.deactivated_at is null and up.role in ('officer', 'scan_operator');
  if v_org_id is null then raise exception 'Active officer profile not found'; end if;
  if p_client_event_id is null then raise exception 'client_event_id is required'; end if;
  if p_recorded_at is null or p_recorded_at > now() + interval '5 minutes' or p_recorded_at < now() - interval '24 hours' then
    raise exception 'recorded_at is outside the accepted capture window';
  end if;
  if p_gps_lat not between -90 and 90 or p_gps_lng not between -180 and 180 then raise exception 'Invalid GPS coordinates'; end if;
  if p_accuracy_meters is not null and p_accuracy_meters < 0 then raise exception 'GPS accuracy cannot be negative'; end if;
  if p_activity_type not in ('gps_update', 'shift_start', 'shift_end', 'scan', 'welfare_checkin', 'sos', 'checkpoint_scan') then
    raise exception 'Unsupported breadcrumb activity type';
  end if;
  if p_shift_id is not null and not exists (
    select 1 from public.shifts s
    where s.id = p_shift_id and s.organization_id = v_org_id and s.officer_user_id = v_user_id
  ) then raise exception 'Shift does not belong to the authenticated officer'; end if;

  select g.* into v_existing from public.officer_gps_log g
  where g.organization_id = v_org_id and g.officer_id = v_user_id and g.client_event_id = p_client_event_id;
  if found then return query select v_existing.id, false, v_existing.created_at; return; end if;

  begin
    insert into public.officer_gps_log (
      organization_id, officer_id, client_event_id, recorded_at, gps_lat, gps_lng,
      accuracy_meters, heading, speed_kmh, activity_type, shift_id
    ) values (
      v_org_id, v_user_id, p_client_event_id, p_recorded_at, p_gps_lat, p_gps_lng,
      p_accuracy_meters, p_heading, p_speed_kmh, p_activity_type, p_shift_id
    ) returning * into v_created;
  exception when unique_violation then
    select g.* into v_created from public.officer_gps_log g
    where g.organization_id = v_org_id and g.officer_id = v_user_id and g.client_event_id = p_client_event_id;
    return query select v_created.id, false, v_created.created_at; return;
  end;
  return query select v_created.id, true, v_created.created_at;
end;
$$;

revoke all on function public.record_officer_breadcrumb(uuid,timestamptz,double precision,double precision,double precision,double precision,double precision,text,uuid) from public,anon;
grant execute on function public.record_officer_breadcrumb(uuid,timestamptz,double precision,double precision,double precision,double precision,double precision,text,uuid) to authenticated,service_role;