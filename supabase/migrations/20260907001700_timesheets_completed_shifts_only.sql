-- Timesheet generation is based on completed work only. In-progress and accepted
-- assignments remain operational records, not payable timesheet evidence.

create or replace function public.get_officer_timesheet_work(
  p_period_start date,
  p_period_end date
) returns table (
  source_type text, source_id uuid, work_status text, started_at timestamptz,
  ended_at timestamptz, calculated_minutes integer, label text, metadata jsonb
) language plpgsql security definer stable set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_period_start timestamptz := p_period_start::timestamptz;
  v_period_end timestamptz := (p_period_end + 1)::timestamptz;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if p_period_start is null or p_period_end is null or p_period_start > p_period_end then raise exception 'Invalid timesheet period'; end if;
  select p.organization_id into v_org_id from public.user_profiles p where p.id = v_user_id and p.deactivated_at is null;
  if v_org_id is null then raise exception 'Active staff profile required'; end if;

  return query
  with shift_work as (
    select 'shift'::text, s.id, 'completed'::text,
      greatest(s.actual_start, v_period_start), least(s.actual_end, v_period_end),
      coalesce(s.service_type, 'shift'),
      jsonb_build_object('shift_id', s.id, 'service_type', s.service_type, 'status', s.status, 'scheduled_start', s.scheduled_start, 'scheduled_end', s.scheduled_end, 'actual_start', s.actual_start, 'actual_end', s.actual_end)
    from public.shifts s
    where s.organization_id = v_org_id and s.officer_user_id = v_user_id
      and s.status = 'completed' and s.actual_start is not null and s.actual_end is not null
      and s.actual_end > v_period_start and s.actual_start < v_period_end
  ), job_work as (
    select 'dispatch_job'::text, d.id, 'completed'::text,
      greatest(coalesce(d.on_scene_at, d.en_route_at, d.acknowledged_at, d.dispatched_at, d.created_at), v_period_start),
      least(d.completed_at, v_period_end), coalesce(d.job_type, 'Dispatch job'),
      jsonb_build_object('dispatch_job_id', d.id, 'job_type', d.job_type, 'status', d.status, 'shift_id', d.shift_id, 'shift_stop_id', d.shift_stop_id, 'dispatched_at', d.dispatched_at, 'on_scene_at', d.on_scene_at, 'completed_at', d.completed_at)
    from public.dispatch_jobs d
    left join public.shifts s on s.id = d.shift_id and s.officer_user_id = v_user_id
    where d.organization_id = v_org_id
      and (s.id is not null or d.dispatch_resource_id in (select dr.id from public.dispatch_resources dr where dr.assigned_officer_id = v_user_id))
      and d.status = 'completed' and d.completed_at is not null and d.shift_id is null
      and d.completed_at > v_period_start
      and coalesce(d.on_scene_at, d.en_route_at, d.acknowledged_at, d.dispatched_at, d.created_at) < v_period_end
  ), sources as (
    select * from shift_work union all select * from job_work
  ), bounded as (
    select *, greatest(0, floor(extract(epoch from (ended_at - started_at)) / 60))::integer as minutes
    from sources where ended_at > started_at
  )
  select source_type, id, work_status, started_at, ended_at, minutes, label,
    metadata || jsonb_build_object('calculated_minutes', minutes)
  from bounded order by started_at, source_type, id;
end;
$$;

revoke all on function public.get_officer_timesheet_work(date, date) from public, anon;
grant execute on function public.get_officer_timesheet_work(date, date) to authenticated, service_role;
