-- A shift can be started from an hour before its rostered start (owner walk finding 2026-09-19: the schedule
-- offered "Start shift" on a shift three days away, and the server accepted it). Starting late is still allowed and
-- recorded; only starting far too early is refused, in plain words. Administrators starting a shift on an officer's
-- behalf are not bound by the window. The web schedule hides the button until the window opens; this is the backstop.

create or replace function public.start_officer_shift(
  p_client_request_id uuid,
  p_shift_id uuid,
  p_expected_status text,
  p_gps_lat double precision default null,
  p_gps_lng double precision default null,
  p_off_site_reason text default null
) returns table(shift_id uuid, shift_status text, started_at timestamp with time zone, created boolean, position_status text, place_name text, distance_m numeric, superseded_shift_id uuid, superseded_service_type text, superseded_started_at timestamp with time zone)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  c_start_window constant interval := interval '60 minutes';
  v_actor uuid := auth.uid();
  v_shift public.shifts%rowtype;
  v_at timestamptz := now();
  v_position jsonb;
  v_reason text := nullif(trim(coalesce(p_off_site_reason, '')), '');
  v_prev_id uuid;
  v_prev_type text;
  v_prev_started timestamptz;
  v_is_admin boolean;
begin
  if p_client_request_id is null then
    raise exception 'client_request_id is required';
  end if;

  select s.* into v_shift from public.shifts s where s.id = p_shift_id for update;
  if not found then
    raise exception 'Shift not found';
  end if;

  v_is_admin := public.is_admin_for_org(v_shift.organization_id);
  if v_shift.officer_user_id <> v_actor and not v_is_admin then
    raise exception 'Only the assigned officer or an administrator can start this shift';
  end if;

  if v_shift.status = 'in_progress' and v_shift.actual_start is not null then
    return query select v_shift.id, v_shift.status, v_shift.actual_start, false, null::text, null::text, null::numeric, null::uuid, null::text, null::timestamptz;
    return;
  end if;

  if v_shift.status <> p_expected_status then
    raise exception 'Shift changed from expected status % to %', p_expected_status, v_shift.status;
  end if;

  if v_shift.status not in ('scheduled', 'published', 'accepted') then
    raise exception 'Shift cannot be started from status %', v_shift.status;
  end if;

  if not v_is_admin and v_shift.scheduled_start - v_at > c_start_window then
    raise exception 'Too early to start this shift: it is rostered for later. You can start it from an hour before its rostered start.'
      using errcode = 'P0001', hint = format('opens_at=%s', to_char((v_shift.scheduled_start - c_start_window) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
  end if;

  v_position := public.evaluate_shift_start_position(v_shift.id, p_gps_lat, p_gps_lng);

  -- The shift this start will stop (the shifts_one_at_a_time trigger does the stopping and its audit).
  select s.id, s.service_type, s.actual_start into v_prev_id, v_prev_type, v_prev_started
  from public.shifts s
  where s.officer_user_id = v_shift.officer_user_id and s.status = 'in_progress' and s.id <> v_shift.id
  order by s.actual_start desc nulls last
  limit 1;

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
      'scheduled_start', v_shift.scheduled_start,
      'started_early_by_minutes', greatest(0, floor(extract(epoch from (v_shift.scheduled_start - v_shift.actual_start)) / 60))::integer,
      'gps_lat', p_gps_lat,
      'gps_lng', p_gps_lng,
      'start_position', v_position,
      'off_site_reason', v_reason,
      'superseded_shift_id', v_prev_id,
      'client_request_id', p_client_request_id
    )
  );

  return query select v_shift.id, v_shift.status, v_shift.actual_start, true,
    v_position->>'status', v_position->>'place_name', (v_position->>'distance_m')::numeric,
    v_prev_id, v_prev_type, v_prev_started;
end;
$$;

comment on function public.start_officer_shift(uuid, uuid, text, double precision, double precision, text) is
  'Starts the officer''s shift from an hour before its rostered start (administrators are not bound by the window). Records the start position (advisory, never a gate) and any off-site reason. One shift at a time: an earlier in-progress shift is stopped by the shifts_one_at_a_time trigger and named in the receipt (superseded_shift_id).';
