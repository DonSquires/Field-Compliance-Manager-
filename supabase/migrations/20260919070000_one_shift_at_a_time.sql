-- One shift at a time (owner ruling, 2026-09-19): an officer is on at most one shift.
-- When a second shift goes in progress for the same officer, the first is stopped — not blocked, not left running —
-- with what was still open written to the audit, and the start receipt says it happened.
-- "Paused" is not a state a shift can be in here (breaks are governed separately); stopped is the honest record.

alter table public.shifts
  add column if not exists ended_reason text,
  add column if not exists superseded_by_shift_id uuid references public.shifts(id) on delete set null;

alter table public.shifts drop constraint if exists shifts_ended_reason_check;
alter table public.shifts add constraint shifts_ended_reason_check
  check (ended_reason is null or ended_reason in ('officer', 'superseded_by_next_shift'));

comment on column public.shifts.ended_reason is 'How the shift ended: officer (End shift), superseded_by_next_shift (stopped when the officer''s next shift started). Null = ended by another path or not ended.';
comment on column public.shifts.superseded_by_shift_id is 'The shift whose start stopped this one (ended_reason = superseded_by_next_shift).';

-- Structural guarantee: no writer can leave an officer on two shifts.
create unique index if not exists shifts_one_in_progress_per_officer_idx
  on public.shifts (officer_user_id) where status = 'in_progress';

create or replace function public.shifts_one_at_a_time()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_other public.shifts%rowtype;
  v_at timestamptz := clock_timestamp();
  v_open_stops integer;
  v_open_modules integer;
  v_open_jobs integer;
  v_alerts integer;
  v_debrief boolean;
begin
  if new.status <> 'in_progress' or (tg_op = 'UPDATE' and old.status = 'in_progress') then
    return new;
  end if;

  for v_other in
    select s.* from public.shifts s
    where s.officer_user_id = new.officer_user_id and s.status = 'in_progress' and s.id <> new.id
    for update
  loop
    select count(*) into v_open_stops from public.shift_stops st where st.shift_id = v_other.id and st.status not in ('completed', 'skipped', 'cancelled');
    select count(*) into v_open_modules from public.shift_stop_modules sm join public.shift_stops st on st.id = sm.shift_stop_id where st.shift_id = v_other.id and sm.is_required and sm.status not in ('completed', 'skipped');
    select count(*) into v_open_jobs from public.dispatch_jobs j where j.shift_id = v_other.id and j.status not in ('completed', 'cancelled');
    select count(*) into v_alerts from public.welfare_alerts w where w.shift_id = v_other.id and w.status <> 'resolved';
    v_debrief := exists (select 1 from public.shift_debriefs d where d.shift_id = v_other.id);

    update public.shifts
    set status = 'completed', actual_end = coalesce(actual_end, v_at), ended_reason = 'superseded_by_next_shift', superseded_by_shift_id = new.id, updated_at = v_at
    where id = v_other.id;
    update public.roster_slots set status = 'completed' where linked_shift_id = v_other.id and status in ('published', 'accepted');

    insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
    values (v_other.organization_id, auth.uid(), 'officer_shift_superseded', 'shifts', v_other.id, jsonb_build_object(
      'superseded_by_shift_id', new.id,
      'actual_start', v_other.actual_start,
      'actual_end', v_at,
      'scheduled_end', v_other.scheduled_end,
      'open_stop_count', v_open_stops,
      'open_required_task_count', v_open_modules,
      'open_dispatch_job_count', v_open_jobs,
      'active_welfare_alert_count', v_alerts,
      'debrief_submitted', v_debrief,
      'rule', 'one shift at a time'
    ));
  end loop;

  return new;
end;
$$;

revoke all on function public.shifts_one_at_a_time() from public, anon, authenticated, service_role;

drop trigger if exists shifts_one_at_a_time on public.shifts;
create trigger shifts_one_at_a_time
  before insert or update of status on public.shifts
  for each row execute function public.shifts_one_at_a_time();

comment on function public.shifts_one_at_a_time() is
  'Owner ruling 2026-09-19: an officer is on at most one shift. When a shift goes in progress, any other in-progress shift of the same officer is stopped (completed, ended_reason = superseded_by_next_shift), its roster slot closed, and what was still open written to audit_log as officer_shift_superseded.';

-- start_officer_shift: same rules as before, and the receipt says which earlier shift the start stopped.
drop function if exists public.start_officer_shift(uuid, uuid, text, double precision, double precision, text);

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
  v_actor uuid := auth.uid();
  v_shift public.shifts%rowtype;
  v_at timestamptz := now();
  v_position jsonb;
  v_reason text := nullif(trim(coalesce(p_off_site_reason, '')), '');
  v_prev_id uuid;
  v_prev_type text;
  v_prev_started timestamptz;
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
    return query select v_shift.id, v_shift.status, v_shift.actual_start, false, null::text, null::text, null::numeric, null::uuid, null::text, null::timestamptz;
    return;
  end if;

  if v_shift.status <> p_expected_status then
    raise exception 'Shift changed from expected status % to %', p_expected_status, v_shift.status;
  end if;

  if v_shift.status not in ('scheduled', 'published', 'accepted') then
    raise exception 'Shift cannot be started from status %', v_shift.status;
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

revoke all on function public.start_officer_shift(uuid, uuid, text, double precision, double precision, text) from public, anon, authenticated, service_role;
grant execute on function public.start_officer_shift(uuid, uuid, text, double precision, double precision, text) to postgres, authenticated, service_role;
comment on function public.start_officer_shift(uuid, uuid, text, double precision, double precision, text) is
  'Starts the officer''s shift. Records the start position (advisory, never a gate) and any off-site reason. One shift at a time: an earlier in-progress shift is stopped by the shifts_one_at_a_time trigger and named in the receipt (superseded_shift_id).';

-- complete_officer_shift: the officer's own End shift is recorded as such.
create or replace function public.complete_officer_shift(
  p_shift_id uuid,
  p_expected_status text,
  p_gps_lat double precision default null,
  p_gps_lng double precision default null
) returns table(shift_id uuid, shift_status text, completed_at timestamp with time zone)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_actor uuid := auth.uid();
  v_shift public.shifts%rowtype;
  v_completed_at timestamptz := clock_timestamp();
  v_position jsonb;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  select s.* into v_shift from public.shifts s where s.id = p_shift_id for update;
  if not found then raise exception 'Shift not found'; end if;
  if v_shift.officer_user_id <> v_actor then raise exception 'Shift does not belong to the authenticated officer'; end if;
  if v_shift.status <> p_expected_status then raise exception 'Shift changed from expected status % to %', p_expected_status, v_shift.status; end if;
  if v_shift.status <> 'in_progress' then raise exception 'Only an in-progress shift can be completed'; end if;
  if not exists (select 1 from public.shift_debriefs d where d.shift_id = v_shift.id and d.officer_user_id = v_actor) then raise exception 'Submit the shift debrief before completing the shift'; end if;
  if exists (select 1 from public.shift_stops st where st.shift_id = v_shift.id and st.status not in ('completed', 'skipped', 'cancelled')) then raise exception 'Complete or skip every shift stop before completing the shift'; end if;
  if exists (select 1 from public.shift_stop_modules sm join public.shift_stops st on st.id = sm.shift_stop_id where st.shift_id = v_shift.id and sm.is_required and sm.status not in ('completed', 'skipped')) then raise exception 'Complete or skip every required module task before completing the shift'; end if;
  if exists (select 1 from public.dispatch_jobs j where j.shift_id = v_shift.id and j.status not in ('completed', 'cancelled')) then raise exception 'Complete or cancel every dispatch job before completing the shift'; end if;
  if exists (select 1 from public.welfare_alerts w where w.shift_id = v_shift.id and w.status <> 'resolved') then raise exception 'Resolve active welfare alerts before completing the shift'; end if;

  if p_gps_lat is not null and p_gps_lng is not null then
    v_position := public.evaluate_shift_start_position(v_shift.id, p_gps_lat, p_gps_lng);
  end if;

  update public.shifts set status = 'completed', actual_end = coalesce(actual_end, v_completed_at), ended_reason = 'officer', updated_at = v_completed_at where id = v_shift.id returning * into v_shift;
  update public.roster_slots set status = 'completed' where linked_shift_id = v_shift.id and status in ('published', 'accepted');
  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_shift.organization_id, v_actor, 'officer_shift_completed', 'shifts', v_shift.id, jsonb_build_object(
    'previous_status', p_expected_status,
    'actual_end', v_shift.actual_end,
    'gps_lat', p_gps_lat,
    'gps_lng', p_gps_lng,
    'end_position', v_position
  ));
  return query select v_shift.id, v_shift.status, v_shift.actual_end;
end;
$$;

revoke all on function public.complete_officer_shift(uuid, text, double precision, double precision) from public, anon, authenticated, service_role;
grant execute on function public.complete_officer_shift(uuid, text, double precision, double precision) to postgres, authenticated, service_role;
