alter table public.officer_gps_log
  add column if not exists client_event_id uuid,
  add column if not exists recorded_at timestamptz not null default now(),
  add column if not exists shift_id uuid references public.shifts(id) on delete set null;

create unique index if not exists idx_officer_gps_log_client_event
  on public.officer_gps_log (organization_id, officer_id, client_event_id)
  where client_event_id is not null;

drop policy if exists officer_gps_log_insert on public.officer_gps_log;
create policy officer_gps_log_insert on public.officer_gps_log
  for insert to authenticated
  with check (
    officer_id = auth.uid()
    and public.org_access_allowed(organization_id)
    and exists (
      select 1 from public.user_profiles
      where id = auth.uid()
        and deactivated_at is null
        and role in ('officer', 'scan_operator')
    )
  );

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
  select organization_id into v_org_id from public.user_profiles
  where id = v_user_id and deactivated_at is null and role in ('officer', 'scan_operator');
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
    select 1 from public.shifts where id = p_shift_id and organization_id = v_org_id and officer_user_id = v_user_id
  ) then raise exception 'Shift does not belong to the authenticated officer'; end if;

  select * into v_existing from public.officer_gps_log
  where organization_id = v_org_id and officer_id = v_user_id and client_event_id = p_client_event_id;
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
    select * into v_created from public.officer_gps_log
    where organization_id = v_org_id and officer_id = v_user_id and client_event_id = p_client_event_id;
    return query select v_created.id, false, v_created.created_at; return;
  end;
  return query select v_created.id, true, v_created.created_at;
end;
$$;

create or replace function public.get_officer_activity_timeline(
  p_officer_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_limit integer default 1000
) returns table (
  event_key text,
  event_type text,
  event_at timestamptz,
  received_at timestamptz,
  source_table text,
  source_id uuid,
  gps_lat double precision,
  gps_lng double precision,
  shift_id uuid,
  site_id uuid,
  zone_id uuid,
  summary text,
  details jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
begin
  select organization_id into v_org_id from public.user_profiles where id = p_officer_id;
  if v_org_id is null then return; end if;
  if auth.uid() <> p_officer_id and not public.is_admin_for_org(v_org_id) then raise exception 'Not authorised to view this officer timeline'; end if;
  if p_from is null or p_to is null or p_from >= p_to or p_to - p_from > interval '31 days' then raise exception 'Timeline range must be between 1 second and 31 days'; end if;

  return query
  with events as (
    select 'gps:' || g.id::text, 'gps_' || g.activity_type, g.recorded_at, g.created_at,
      'officer_gps_log'::text, g.id, g.gps_lat, g.gps_lng, g.shift_id, null::uuid, g.detected_zone_id,
      case when g.activity_type = 'gps_update' then 'GPS heartbeat' else replace(g.activity_type, '_', ' ') end,
      jsonb_build_object('accuracy_meters', g.accuracy_meters, 'heading', g.heading, 'speed_kmh', g.speed_kmh, 'client_event_id', g.client_event_id)
    from public.officer_gps_log g
    where g.organization_id = v_org_id and g.officer_id = p_officer_id and g.recorded_at between p_from and p_to

    union all
    select 'welfare_check:' || w.id::text, 'welfare_check', w.checked_in_at, w.checked_in_at,
      'welfare_checks', w.id, w.gps_lat, w.gps_lng, w.shift_id, null::uuid, null::uuid,
      'Welfare check-in: ' || w.status, jsonb_build_object('status', w.status, 'notes', w.notes)
    from public.welfare_checks w where w.organization_id = v_org_id and w.officer_user_id = p_officer_id and w.checked_in_at between p_from and p_to

    union all
    select 'observation:' || o.id::text, 'observation', o.observed_at, o.created_at,
      'observations', o.id, o.gps_lat, o.gps_lng, null::uuid, o.site_id, o.zone_id,
      'Vehicle observation ' || o.plate_number, jsonb_build_object('module_key', o.module_key, 'compliance_status', o.compliance_status, 'plate_number', o.plate_number)
    from public.observations o where o.organization_id = v_org_id and o.officer_id = p_officer_id and o.observed_at between p_from and p_to

    union all
    select 'checkpoint:' || v.id::text, 'checkpoint_visit', v.visited_at, v.visited_at,
      'patrol_checkpoint_visits', v.id, v.gps_lat, v.gps_lng, p.shift_id, null::uuid, null::uuid,
      'Patrol checkpoint visit', jsonb_build_object('checkpoint_id', v.checkpoint_id, 'scan_method', v.scan_method, 'within_radius', v.within_radius, 'notes', v.notes)
    from public.patrol_checkpoint_visits v join public.patrols p on p.id = v.patrol_id
    where v.organization_id = v_org_id and v.officer_user_id = p_officer_id and v.visited_at between p_from and p_to

    union all
    select 'report:' || r.id::text, 'field_report', r.reported_at, r.created_at,
      'officer_field_reports', r.id, r.gps_lat, r.gps_lng, r.shift_id, r.site_id, r.zone_id,
      r.title, jsonb_build_object('report_type', r.report_type, 'severity', r.severity, 'status', r.status, 'immediate_action', r.immediate_action)
    from public.officer_field_reports r where r.organization_id = v_org_id and r.officer_id = p_officer_id and r.reported_at between p_from and p_to

    union all
    select 'stop_action:' || a.id::text, 'shift_stop_action', a.performed_at, a.created_at,
      'shift_stop_actions', a.id, a.gps_lat, a.gps_lng, a.shift_id, null::uuid, null::uuid,
      replace(a.action_type, '_', ' '), jsonb_build_object('outcome', a.outcome, 'notes', a.notes, 'result_table', a.result_table, 'result_record_id', a.result_record_id)
    from public.shift_stop_actions a join public.shifts s on s.id = a.shift_id
    where a.organization_id = v_org_id and s.officer_user_id = p_officer_id and a.performed_at between p_from and p_to
  )
  select * from events order by event_at desc limit least(greatest(coalesce(p_limit, 1000), 1), 5000);
end;
$$;

revoke all on function public.record_officer_breadcrumb(uuid, timestamptz, double precision, double precision, double precision, double precision, double precision, text, uuid) from public;
grant execute on function public.record_officer_breadcrumb(uuid, timestamptz, double precision, double precision, double precision, double precision, double precision, text, uuid) to authenticated, service_role;

revoke all on function public.get_officer_activity_timeline(uuid, timestamptz, timestamptz, integer) from public;
grant execute on function public.get_officer_activity_timeline(uuid, timestamptz, timestamptz, integer) to authenticated, service_role;