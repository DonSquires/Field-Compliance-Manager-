-- Server-owned shift_stop status transitions for static guarding / patrol stop
-- attendance (#incidents-followup, static guard officer view). Mirrors
-- advance_dispatch_job_status: ownership + expected-state checked, timestamps
-- and SLA status server-computed, not client-supplied.
--
-- The existing complete_shift_stop() function has no ownership check and is
-- granted to service_role only -- it cannot be safely opened to authenticated
-- callers as-is. This adds a properly authorized replacement covering the
-- full pending -> en_route -> on_scene -> completed/skipped/cancelled
-- lifecycle so the officer-facing static guard view can call it directly.

create or replace function public.advance_shift_stop_status(
  p_stop_id uuid,
  p_expected_status text,
  p_next_status text,
  p_officer_notes text default null,
  p_gps_lat double precision default null,
  p_gps_lng double precision default null
) returns table(id uuid, status text, sla_status text, shift_id uuid, actual_arrived_at timestamptz, actual_departed_at timestamptz)
language plpgsql security definer set search_path to 'public' as $$
declare
  v_stop shift_stops%rowtype;
  v_shift shifts%rowtype;
  v_allowed boolean := false;
  v_sla_status text;
begin
  select * into v_stop from shift_stops where shift_stops.id = p_stop_id for update;
  if not found then raise exception 'Shift stop not found'; end if;

  select * into v_shift from shifts where shifts.id = v_stop.shift_id;
  if not found then raise exception 'Shift not found for stop'; end if;

  if not is_admin_for_org(v_stop.organization_id) and v_shift.officer_user_id <> auth.uid() then
    raise exception 'Not authorised to update this shift stop';
  end if;

  if v_stop.status <> p_expected_status then
    raise exception 'Shift stop changed from expected status';
  end if;

  v_allowed := case v_stop.status
    when 'pending' then p_next_status in ('en_route', 'skipped', 'cancelled')
    when 'en_route' then p_next_status in ('on_scene', 'skipped', 'cancelled')
    when 'on_scene' then p_next_status in ('completed', 'skipped', 'cancelled')
    else false end;
  if not v_allowed then raise exception 'Invalid shift stop transition'; end if;

  v_sla_status := case
    when p_next_status = 'on_scene' and now() > v_stop.sla_arrive_by then 'breached'
    when p_next_status = 'on_scene' then 'on_track'
    when p_next_status = 'completed' and v_stop.sla_status = 'breached' then 'breached'
    when p_next_status = 'completed' then 'completed'
    when p_next_status in ('skipped', 'cancelled') then 'skipped'
    else v_stop.sla_status
  end;

  update shift_stops set
    status = p_next_status,
    sla_status = v_sla_status,
    actual_arrived_at = case when p_next_status = 'on_scene' then now() else actual_arrived_at end,
    arrived_gps_lat = case when p_next_status = 'on_scene' then coalesce(p_gps_lat, arrived_gps_lat) else arrived_gps_lat end,
    arrived_gps_lng = case when p_next_status = 'on_scene' then coalesce(p_gps_lng, arrived_gps_lng) else arrived_gps_lng end,
    actual_departed_at = case when p_next_status in ('completed', 'skipped', 'cancelled') then now() else actual_departed_at end,
    officer_notes = coalesce(nullif(trim(p_officer_notes), ''), officer_notes),
    updated_at = now()
  where shift_stops.id = p_stop_id;

  if p_next_status = 'completed' then
    update shifts set completed_stops = completed_stops + 1 where shifts.id = v_stop.shift_id;
  end if;

  return query
  select updated.id, updated.status, updated.sla_status, updated.shift_id, updated.actual_arrived_at, updated.actual_departed_at
  from shift_stops updated
  where updated.id = p_stop_id;
end;
$$;

alter function public.advance_shift_stop_status(uuid, text, text, text, double precision, double precision) owner to postgres;

comment on function public.advance_shift_stop_status(uuid, text, text, text, double precision, double precision) is 'Server-owned shift_stop lifecycle transition: ownership + expected-state checked, SLA status and timestamps computed server-side.';

revoke all on function public.advance_shift_stop_status(uuid, text, text, text, double precision, double precision) from public, anon;
grant execute on function public.advance_shift_stop_status(uuid, text, text, text, double precision, double precision) to authenticated, service_role;
