-- 20260918110000_officer_patrol_stops.sql
-- Give officers the contracted site visits of their shift, and a governed way to record
-- arrival and departure at each one.
--
-- Until now shift_stops (one row per contracted visit, generated from the agreement's
-- patrol run) were never shown to the officer; the only writer an officer could reach was
-- the legacy complete_shift_stop, which has no officer check. This mirrors the governed
-- static-post pattern (expected status, request id receipt in shift_stop_actions, audit)
-- with the dispatch-place arrival rule: geofence verification is recorded loudly but never
-- blocks attendance (GEOFENCE_PRINCIPLES P1/P2), because contracted places may still have
-- an unverified boundary.

CREATE OR REPLACE FUNCTION public.get_officer_patrol_stops(p_shift_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_shift public.shifts%rowtype;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if p_shift_id is not null then
    select * into v_shift from public.shifts where id = p_shift_id and officer_user_id = v_actor;
  else
    select * into v_shift from public.shifts
    where officer_user_id = v_actor and status in ('in_progress', 'accepted')
    order by case status when 'in_progress' then 0 else 1 end, scheduled_start desc limit 1;
  end if;
  if not found then return null; end if;

  return jsonb_build_object(
    'shift', jsonb_build_object('id', v_shift.id, 'status', v_shift.status, 'scheduled_start', v_shift.scheduled_start, 'scheduled_end', v_shift.scheduled_end,
      'route_name', (select r.name from public.patrol_routes r where r.id = v_shift.patrol_route_id)),
    'stops', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', st.id, 'stop_order', st.stop_order, 'visit_number', st.visit_number,
        'visits_total', (select count(*) from public.shift_stops v where v.shift_id = st.shift_id and v.patrol_config_id is not distinct from st.patrol_config_id and v.site_id is not distinct from st.site_id and v.zone_id is not distinct from st.zone_id and v.is_adhoc = false),
        'status', st.status, 'sla_status', st.sla_status,
        'sla_window_open', st.sla_window_open, 'sla_arrive_by', st.sla_arrive_by, 'sla_depart_by', st.sla_depart_by,
        'required_dwell_minutes', st.required_dwell_minutes, 'officer_instructions', st.officer_instructions,
        'actual_arrived_at', st.actual_arrived_at, 'actual_departed_at', st.actual_departed_at,
        'arrival_verification', st.arrival_verification, 'arrival_distance_m', st.arrival_distance_m, 'officer_notes', st.officer_notes,
        'module_key', st.module_key,
        'place', case
          when st.site_id is not null then (select jsonb_build_object('kind', 'site', 'name', cs.name, 'address', cs.address, 'access_instructions', cs.access_instructions, 'hs_notes', cs.hs_notes) from public.client_sites cs where cs.id = st.site_id)
          when st.zone_id is not null then (select jsonb_build_object('kind', 'zone', 'name', lz.name, 'address', null, 'access_instructions', null, 'hs_notes', null) from public.location_zones lz where lz.id = st.zone_id)
          else jsonb_build_object('kind', 'unknown', 'name', 'Contracted place', 'address', null, 'access_instructions', null, 'hs_notes', null) end
      ) order by st.stop_order, st.visit_number)
      from public.shift_stops st
      where st.shift_id = v_shift.id and st.is_adhoc = false and st.module_key <> 'static_guarding'
    ), '[]'::jsonb)
  );
end;
$$;

REVOKE ALL ON FUNCTION public.get_officer_patrol_stops(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_officer_patrol_stops(uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.get_officer_patrol_stops(uuid) IS 'Officer-scoped read of the contracted (non-adhoc, non-static) shift stops for one of the caller''s shifts, with place brief, timing window, instructions, and attendance evidence. Returns null when the caller has no such shift.';


CREATE OR REPLACE FUNCTION public.manage_officer_patrol_stop(
  p_stop_id uuid,
  p_expected_status text,
  p_action text,
  p_request_id uuid,
  p_notes text DEFAULT NULL,
  p_gps_lat double precision DEFAULT NULL,
  p_gps_lng double precision DEFAULT NULL,
  p_gps_accuracy_metres double precision DEFAULT NULL,
  p_sla_delay_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_stop public.shift_stops%rowtype;
  v_shift public.shifts%rowtype;
  v_site public.client_sites%rowtype;
  v_receipt jsonb;
  v_notes text := nullif(trim(coalesce(p_notes, '')), '');
  v_delay text := nullif(trim(coalesce(p_sla_delay_reason, '')), '');
  v_at timestamptz := now();
  v_action_id uuid := gen_random_uuid();
  v_verification text;
  v_distance numeric;
  v_point geometry;
  v_onsite_m numeric;
  v_approach_m numeric;
  v_dwell_minutes integer;
  v_dwell_short boolean := false;
  v_next public.shift_stops%rowtype;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if p_request_id is null then raise exception 'Request id is required'; end if;
  if p_action not in ('arrive', 'depart') then raise exception 'Unsupported patrol stop action'; end if;

  select * into v_stop from public.shift_stops where id = p_stop_id for update;
  if not found then raise exception 'Patrol stop not found'; end if;
  select * into v_shift from public.shifts where id = v_stop.shift_id;
  if not found or v_shift.officer_user_id <> v_actor then raise exception 'This stop is not on your shift'; end if;
  if v_shift.status <> 'in_progress' then raise exception 'Start your shift before recording attendance at a stop'; end if;
  if v_stop.is_adhoc or v_stop.dispatch_job_id is not null then raise exception 'Dispatch stops are recorded from the Dispatch page'; end if;
  if v_stop.module_key = 'static_guarding' then raise exception 'Static posts are recorded from the Static guarding page'; end if;

  select a.receipt into v_receipt from public.shift_stop_actions a
  where a.organization_id = v_shift.organization_id and a.client_request_id = p_request_id;
  if found then return v_receipt; end if;

  if v_stop.status <> p_expected_status then
    raise exception 'This stop changed from % to % on another device. Refresh and try again', p_expected_status, v_stop.status;
  end if;

  if p_action = 'arrive' then
    if v_stop.status not in ('pending', 'en_route') then raise exception 'Arrival cannot be recorded from status %', v_stop.status; end if;

    -- Geofence verification: loud, never blocking.
    if p_gps_lat is null or p_gps_lng is null then
      v_verification := 'no_gps';
    else
      if p_gps_lat not between -90 and 90 or p_gps_lng not between -180 and 180 then raise exception 'GPS position is out of range'; end if;
      v_point := st_setsrid(st_makepoint(p_gps_lng, p_gps_lat), 4326);
      if v_stop.site_id is not null then select * into v_site from public.client_sites cs where cs.id = v_stop.site_id; end if;
      if v_site.id is null or (v_site.boundary is null and v_site.center_point is null) then
        v_verification := 'no_geofence';
      else
        v_distance := round((case when v_site.boundary is not null
          then st_distance(v_site.boundary::geography, v_point::geography)
          else st_distance(v_site.center_point::geography, v_point::geography) end)::numeric, 1);
        v_onsite_m := coalesce(v_site.onsite_radius_meters, 10);
        select c.config_value::numeric into v_approach_m from public.org_geofence_config c
        where c.organization_id = v_shift.organization_id and c.config_key = 'approach_radius_m' and c.zone_type is null limit 1;
        v_approach_m := coalesce(v_approach_m, v_site.prompt_radius_meters, 50);
        if v_site.boundary_verification is distinct from 'verified' then v_verification := 'unverified_boundary';
        elsif v_distance <= v_onsite_m then v_verification := 'verified_on_site';
        elsif v_distance <= v_approach_m then v_verification := 'near_site';
        else v_verification := 'off_site';
        end if;
      end if;
    end if;

    update public.shift_stops
    set status = 'on_scene',
        actual_arrived_at = v_at,
        arrived_gps_lat = p_gps_lat, arrived_gps_lng = p_gps_lng, arrived_gps_accuracy = p_gps_accuracy_metres,
        arrival_verification = v_verification, arrival_distance_m = v_distance,
        sla_status = case when v_at > sla_arrive_by then 'breached' else 'on_track' end,
        updated_at = v_at
    where id = v_stop.id
    returning * into v_stop;
  else
    if v_stop.status <> 'on_scene' then raise exception 'Record your arrival before leaving this stop'; end if;
    v_dwell_minutes := greatest(0, floor(extract(epoch from (v_at - v_stop.actual_arrived_at)) / 60))::integer;
    v_dwell_short := v_dwell_minutes < v_stop.required_dwell_minutes;
    if v_stop.sla_status = 'breached' and v_delay is null then
      raise exception 'You arrived after the contracted window. Give a short reason for the delay before leaving';
    end if;
    if v_dwell_short and v_notes is null then
      raise exception 'You are leaving before the contracted % minutes on site. Say why in the notes', v_stop.required_dwell_minutes;
    end if;

    update public.shift_stops
    set status = 'completed',
        actual_departed_at = v_at,
        departed_gps_lat = p_gps_lat, departed_gps_lng = p_gps_lng,
        officer_notes = coalesce(v_notes, officer_notes),
        sla_status = case when sla_status = 'breached' then 'breached' else 'completed' end,
        updated_at = v_at
    where id = v_stop.id
    returning * into v_stop;

    update public.shifts set completed_stops = completed_stops + 1 where id = v_shift.id;
  end if;

  select * into v_next from public.shift_stops n
  where n.shift_id = v_shift.id and n.is_adhoc = false and n.status in ('pending', 'en_route')
  order by n.stop_order, n.visit_number limit 1;

  v_receipt := jsonb_build_object(
    'reference', 'PS-' || upper(left(replace(v_action_id::text, '-', ''), 8)),
    'action', p_action, 'occurred_at', v_at, 'shift_id', v_shift.id, 'stop_id', v_stop.id, 'stop_status', v_stop.status,
    'sla_status', v_stop.sla_status, 'arrival_verification', v_stop.arrival_verification, 'arrival_distance_m', v_stop.arrival_distance_m,
    'dwell_minutes', v_dwell_minutes, 'dwell_short', v_dwell_short, 'delay_reason', v_delay,
    'next_stop_id', v_next.id,
    'completed_stops', (select completed_stops from public.shifts where id = v_shift.id),
    'total_stops', (select total_stops from public.shifts where id = v_shift.id));

  insert into public.shift_stop_actions(id, organization_id, shift_stop_id, shift_id, action_type, outcome, notes, gps_lat, gps_lng, performed_at, client_request_id, gps_accuracy_metres, evidence_metadata, receipt)
  values (v_action_id, v_shift.organization_id, v_stop.id, v_shift.id,
    case when p_action = 'arrive' then 'patrol_stop_arrived' else 'patrol_stop_departed' end,
    v_stop.status, coalesce(v_notes, v_delay), p_gps_lat, p_gps_lng, v_at, p_request_id, p_gps_accuracy_metres,
    jsonb_build_object('capture_method', 'browser_geolocation', 'geofence_result', v_stop.arrival_verification, 'distance_m', v_stop.arrival_distance_m, 'delay_reason', v_delay, 'dwell_short', v_dwell_short),
    v_receipt);

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_shift.organization_id, v_actor, case when p_action = 'arrive' then 'patrol_stop_arrived' else 'patrol_stop_departed' end, 'shift_stops', v_stop.id, v_receipt);

  return v_receipt;
end;
$$;

REVOKE ALL ON FUNCTION public.manage_officer_patrol_stop(uuid, text, text, uuid, text, double precision, double precision, double precision, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manage_officer_patrol_stop(uuid, text, text, uuid, text, double precision, double precision, double precision, text) TO authenticated, service_role;
COMMENT ON FUNCTION public.manage_officer_patrol_stop(uuid, text, text, uuid, text, double precision, double precision, double precision, text) IS
  'Officer records arrival (pending/en_route -> on_scene) or departure (on_scene -> completed) at a contracted, non-adhoc patrol stop on their own in-progress shift. Expected-status race check; idempotent on request id via shift_stop_actions.receipt; geofence verification recorded but never blocking; late arrival needs a delay reason and a short dwell needs a note before leaving; audited.';
