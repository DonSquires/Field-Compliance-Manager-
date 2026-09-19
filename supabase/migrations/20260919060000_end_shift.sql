-- End shift: one button that says what is still open and, when nothing is, ends the shift.
--
-- Owner ask (2026-09-19): "we should have an end shift button as well". Until now a shift could only be
-- completed from the bottom of the Debrief page after a debrief was submitted; the completion rules lived
-- only as exception messages inside complete_officer_shift.
--
-- get_shift_end_readiness returns those same rules as facts the app can show before the officer presses
-- anything: open stops (by place), open required stop tasks, open dispatch jobs, active welfare alerts,
-- whether the debrief is in, and plain-words blockers. complete_officer_shift keeps every rule and gains
-- an optional end position (same advisory evaluation as the start) recorded in its audit row.

create or replace function public.get_shift_end_readiness(p_shift_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_actor uuid := auth.uid();
  v_shift public.shifts%rowtype;
  v_open_stops jsonb;
  v_open_stop_count integer;
  v_open_modules integer;
  v_open_jobs integer;
  v_alerts integer;
  v_debrief boolean;
  v_blockers text[] := '{}';
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  select s.* into v_shift from public.shifts s where s.id = p_shift_id;
  if not found then raise exception 'Shift not found'; end if;
  if v_shift.officer_user_id <> v_actor and not public.is_admin_for_org(v_shift.organization_id) then
    raise exception 'Only the assigned officer or an administrator can review this shift';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('stop_id', st.id, 'place', coalesce(cs.name, lz.name, 'Stop'), 'status', st.status, 'module_key', st.module_key) order by st.stop_order), '[]'::jsonb), count(*)::integer
  into v_open_stops, v_open_stop_count
  from public.shift_stops st
  left join public.client_sites cs on cs.id = st.site_id
  left join public.location_zones lz on lz.id = st.zone_id
  where st.shift_id = v_shift.id and st.status not in ('completed', 'skipped', 'cancelled');

  select count(*)::integer into v_open_modules
  from public.shift_stop_modules sm join public.shift_stops st on st.id = sm.shift_stop_id
  where st.shift_id = v_shift.id and sm.is_required and sm.status not in ('completed', 'skipped');

  select count(*)::integer into v_open_jobs from public.dispatch_jobs j where j.shift_id = v_shift.id and j.status not in ('completed', 'cancelled');
  select count(*)::integer into v_alerts from public.welfare_alerts w where w.shift_id = v_shift.id and w.status <> 'resolved';
  v_debrief := exists (select 1 from public.shift_debriefs d where d.shift_id = v_shift.id and d.officer_user_id = v_shift.officer_user_id);

  if v_shift.status <> 'in_progress' then v_blockers := array_append(v_blockers, format('The shift is %s, not in progress', replace(v_shift.status, '_', ' '))); end if;
  if v_open_stop_count > 0 then v_blockers := array_append(v_blockers, format('%s %s still open', v_open_stop_count, case when v_open_stop_count = 1 then 'stop is' else 'stops are' end)); end if;
  if v_open_modules > 0 then v_blockers := array_append(v_blockers, format('%s required stop %s not done', v_open_modules, case when v_open_modules = 1 then 'task is' else 'tasks are' end)); end if;
  if v_open_jobs > 0 then v_blockers := array_append(v_blockers, format('%s dispatch %s still open', v_open_jobs, case when v_open_jobs = 1 then 'job is' else 'jobs are' end)); end if;
  if v_alerts > 0 then v_blockers := array_append(v_blockers, format('%s welfare %s not resolved', v_alerts, case when v_alerts = 1 then 'alert is' else 'alerts are' end)); end if;
  if not v_debrief then v_blockers := array_append(v_blockers, 'The debrief has not been recorded'); end if;

  return jsonb_build_object(
    'shift_id', v_shift.id,
    'status', v_shift.status,
    'service_type', v_shift.service_type,
    'scheduled_end', v_shift.scheduled_end,
    'actual_start', v_shift.actual_start,
    'open_stops', v_open_stops,
    'open_stop_count', v_open_stop_count,
    'open_required_task_count', v_open_modules,
    'open_dispatch_job_count', v_open_jobs,
    'active_welfare_alert_count', v_alerts,
    'debrief_submitted', v_debrief,
    'blockers', to_jsonb(v_blockers),
    'can_end', v_shift.status = 'in_progress' and v_open_stop_count = 0 and v_open_modules = 0 and v_open_jobs = 0 and v_alerts = 0 and v_debrief,
    'can_end_after_debrief', v_shift.status = 'in_progress' and v_open_stop_count = 0 and v_open_modules = 0 and v_open_jobs = 0 and v_alerts = 0
  );
end;
$$;

revoke all on function public.get_shift_end_readiness(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_shift_end_readiness(uuid) to postgres, authenticated, service_role;
comment on function public.get_shift_end_readiness(uuid) is
  'What still stands between an in-progress shift and its end: open stops by place, open required stop tasks, open dispatch jobs, active welfare alerts, debrief state, plain-words blockers, and whether it can end now or after the debrief. Mirrors the rules complete_officer_shift enforces.';

drop function if exists public.complete_officer_shift(uuid, text);

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

  update public.shifts set status = 'completed', actual_end = coalesce(actual_end, v_completed_at), updated_at = v_completed_at where id = v_shift.id returning * into v_shift;
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
comment on function public.complete_officer_shift(uuid, text, double precision, double precision) is
  'Ends the officer''s in-progress shift once the debrief is in and every stop, required task, dispatch job and welfare alert is closed. Optional GPS records where the shift ended (advisory evaluation) in the audit row.';
