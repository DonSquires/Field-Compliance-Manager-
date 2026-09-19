-- Starting a shift outside its area is advised, not silently recorded and not blocked.
--
-- Owner ruling (2026-09-19): an officer should only be told they are outside the geofence when they
-- try to start a shift outside the area, or when they leave the area while on shift; and being on
-- site is a manual action, never inferred from driving through a geofence.
--
-- evaluate_shift_start_position: where the officer is relative to the shift's places (the static
-- post site, the shift zone, or the nearest patrol-run stop). Read-only; officer or administrator.
-- start_officer_shift: records the same evaluation and an optional off-site reason in its audit
-- row and returns it, so the app can advise before starting and the record shows what was known.

create or replace function public.evaluate_shift_start_position(p_shift_id uuid, p_gps_lat double precision, p_gps_lng double precision)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_actor uuid := auth.uid();
  v_shift public.shifts%rowtype;
  v_point geometry;
  v_radius integer;
  v_best record;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  select s.* into v_shift from public.shifts s where s.id = p_shift_id;
  if not found then raise exception 'Shift not found'; end if;
  if v_shift.officer_user_id <> v_actor and not public.is_admin_for_org(v_shift.organization_id) then
    raise exception 'Only the assigned officer or an administrator can evaluate this shift';
  end if;

  v_radius := coalesce(public.get_org_geofence_config(v_shift.organization_id, 'shift_start_advisory_radius_m', null, 250), 250);
  if p_gps_lat is not null and p_gps_lng is not null and p_gps_lat between -90 and 90 and p_gps_lng between -180 and 180 then
    v_point := st_setsrid(st_point(p_gps_lng, p_gps_lat), 4326);
  end if;

  -- Every place this shift is for: its stops' sites and zones, plus the shift's own zone. The place we are inside wins, else the nearest.
  with places as (
    select 'site'::text as kind, s.id, s.name, s.boundary::geometry as boundary, coalesce(s.center_point, st_centroid(s.boundary))::geometry as center, coalesce(s.onsite_radius_meters, 10) as onsite_radius
    from public.shift_stops st join public.client_sites s on s.id = st.site_id
    where st.shift_id = v_shift.id and st.status not in ('cancelled', 'skipped') and (s.boundary is not null or s.center_point is not null)
    union
    select 'zone'::text, z.id, z.name, z.boundary::geometry, coalesce(z.center_point, st_centroid(z.boundary))::geometry, 0
    from public.location_zones z
    where z.boundary is not null and (z.id = v_shift.zone_id or z.id in (select st.zone_id from public.shift_stops st where st.shift_id = v_shift.id and st.status not in ('cancelled', 'skipped') and st.zone_id is not null))
  ), scored as (
    select p.kind, p.id, p.name,
      ((p.boundary is not null and st_covers(p.boundary, v_point)) or st_dwithin(p.center::geography, v_point::geography, p.onsite_radius)) as inside,
      st_distance(coalesce(p.boundary, p.center)::geography, v_point::geography) as dist,
      count(*) over () as place_count
    from places p
  )
  select kind, id, name, inside, round(dist::numeric, 0) as distance_m, place_count
  into v_best
  from scored
  order by inside desc nulls last, dist asc nulls last, kind desc, name
  limit 1;

  if v_best.id is null then
    return jsonb_build_object('status', 'no_place', 'advisory_radius_m', v_radius, 'place_count', 0, 'route_shift', v_shift.patrol_route_id is not null);
  end if;
  if v_point is null then
    return jsonb_build_object('status', 'no_gps', 'advisory_radius_m', v_radius, 'place_count', v_best.place_count, 'place_kind', v_best.kind, 'place_id', v_best.id, 'place_name', v_best.name, 'route_shift', v_shift.patrol_route_id is not null);
  end if;

  return jsonb_build_object(
    'status', case when v_best.inside then 'on_site' when v_best.distance_m <= v_radius then 'near_site' else 'off_site' end,
    'place_kind', v_best.kind,
    'place_id', v_best.id,
    'place_name', v_best.name,
    'distance_m', v_best.distance_m,
    'advisory_radius_m', v_radius,
    'place_count', v_best.place_count,
    'route_shift', v_shift.patrol_route_id is not null
  );
end;
$$;

revoke all on function public.evaluate_shift_start_position(uuid, double precision, double precision) from public, anon, authenticated, service_role;
grant execute on function public.evaluate_shift_start_position(uuid, double precision, double precision) to postgres, authenticated, service_role;
comment on function public.evaluate_shift_start_position(uuid, double precision, double precision) is
  'Where the officer is relative to the shift''s places: on_site (inside a boundary or on-site radius), near_site (within the organisation''s shift_start_advisory_radius_m, default 250), off_site, no_gps, or no_place. Advisory only; never blocks.';

drop function if exists public.start_officer_shift(uuid, uuid, text, double precision, double precision);

create or replace function public.start_officer_shift(
  p_client_request_id uuid,
  p_shift_id uuid,
  p_expected_status text,
  p_gps_lat double precision default null,
  p_gps_lng double precision default null,
  p_off_site_reason text default null
) returns table(shift_id uuid, shift_status text, started_at timestamp with time zone, created boolean, position_status text, place_name text, distance_m numeric)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_actor uuid := auth.uid();
  v_shift public.shifts%rowtype;
  v_at timestamptz := now();
  v_position jsonb;
  v_reason text := nullif(trim(coalesce(p_off_site_reason, '')), '');
begin
  if p_client_request_id is null then
    raise exception 'client_request_id is required';
  end if;

  select s.* into v_shift from public.shifts s where s.id = p_shift_id for update;
  if not found then
    raise exception 'Shift not found';
  end if;

  if v_shift.officer_user_id <> v_actor and not public.is_admin_for_org(v_shift.organization_id) then
    raise exception 'Only the assigned officer or an administrator can start this shift';
  end if;

  if v_shift.status = 'in_progress' and v_shift.actual_start is not null then
    return query select v_shift.id, v_shift.status, v_shift.actual_start, false, null::text, null::text, null::numeric;
    return;
  end if;

  if v_shift.status <> p_expected_status then
    raise exception 'Shift changed from expected status % to %', p_expected_status, v_shift.status;
  end if;

  if v_shift.status not in ('scheduled', 'published', 'accepted') then
    raise exception 'Shift cannot be started from status %', v_shift.status;
  end if;

  v_position := public.evaluate_shift_start_position(v_shift.id, p_gps_lat, p_gps_lng);

  update public.shifts
  set status = 'in_progress', actual_start = coalesce(actual_start, v_at), updated_at = v_at
  where id = v_shift.id
  returning * into v_shift;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (
    v_shift.organization_id, v_actor, 'officer_shift_started', 'shifts', v_shift.id,
    jsonb_build_object(
      'previous_status', p_expected_status,
      'actual_start', v_shift.actual_start,
      'gps_lat', p_gps_lat,
      'gps_lng', p_gps_lng,
      'start_position', v_position,
      'off_site_reason', v_reason,
      'client_request_id', p_client_request_id
    )
  );

  return query select v_shift.id, v_shift.status, v_shift.actual_start, true,
    v_position->>'status', v_position->>'place_name', (v_position->>'distance_m')::numeric;
end;
$$;

revoke all on function public.start_officer_shift(uuid, uuid, text, double precision, double precision, text) from public, anon, authenticated, service_role;
grant execute on function public.start_officer_shift(uuid, uuid, text, double precision, double precision, text) to postgres, authenticated, service_role;
comment on function public.start_officer_shift(uuid, uuid, text, double precision, double precision, text) is
  'Starts the officer''s shift. Evaluates the start position against the shift''s places (advisory: on_site / near_site / off_site / no_gps / no_place), records it and any off-site reason in the audit row, and returns it. Never blocks on position.';
