-- ============================================================
-- Migration 20260903180000 - Timesheet Work Ledger
-- ============================================================
-- Derives timesheet hours from actual completed or partially completed
-- shifts and dispatch jobs, preserving a reviewable source snapshot.

create table if not exists public.timesheet_work_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  timesheet_id uuid not null references public.timesheets(id) on delete cascade,
  source_type text not null,
  source_id uuid not null,
  work_status text not null,
  started_at timestamptz,
  ended_at timestamptz,
  calculated_minutes integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint timesheet_work_entries_source_check check (source_type in ('shift', 'dispatch_job')),
  constraint timesheet_work_entries_status_check check (work_status in ('completed', 'partial')),
  constraint timesheet_work_entries_minutes_check check (calculated_minutes >= 0)
);

create unique index if not exists idx_timesheet_work_entries_unique
  on public.timesheet_work_entries (timesheet_id, source_type, source_id);

alter table public.timesheet_work_entries enable row level security;
create policy twe_select on public.timesheet_work_entries
  for select using (public.org_access_allowed(organization_id));
revoke insert, update, delete on table public.timesheet_work_entries from authenticated, anon;

alter table public.timesheets
  add column if not exists work_derived_hours numeric(6,2),
  add column if not exists adjustment_hours numeric(6,2) not null default 0,
  add column if not exists work_summary jsonb not null default '{}'::jsonb;

-- Returns one row per source of work. A completed shift/job uses actual timestamps.
-- A partial source uses actual start/arrival through its last confirmed point or now.
create or replace function public.get_officer_timesheet_work(
  p_period_start date,
  p_period_end date
) returns table (
  source_type text,
  source_id uuid,
  work_status text,
  started_at timestamptz,
  ended_at timestamptz,
  calculated_minutes integer,
  label text,
  metadata jsonb
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
    select
      'shift'::text as source_type,
      s.id as source_id,
      case when s.status = 'completed' and s.actual_start is not null and s.actual_end is not null then 'completed' else 'partial' end as work_status,
      greatest(coalesce(s.actual_start, s.scheduled_start), v_period_start) as started_at,
      least(coalesce(s.actual_end, case when s.status in ('accepted', 'in_progress') then clock_timestamp() else s.scheduled_end end), v_period_end) as ended_at,
      coalesce(s.service_type, 'shift') as label,
      jsonb_build_object('shift_id', s.id, 'service_type', s.service_type, 'status', s.status, 'scheduled_start', s.scheduled_start, 'scheduled_end', s.scheduled_end, 'actual_start', s.actual_start, 'actual_end', s.actual_end) as metadata
    from public.shifts s
    where s.organization_id = v_org_id
      and s.officer_user_id = v_user_id
      and s.status in ('accepted', 'in_progress', 'completed')
      and coalesce(s.actual_end, case when s.status in ('accepted', 'in_progress') then clock_timestamp() else s.scheduled_end end) > v_period_start
      and coalesce(s.actual_start, s.scheduled_start) < v_period_end
  ), job_work as (
    select
      'dispatch_job'::text as source_type,
      d.id as source_id,
      case when d.status = 'completed' and d.completed_at is not null then 'completed' else 'partial' end as work_status,
      greatest(coalesce(d.on_scene_at, d.en_route_at, d.acknowledged_at, d.dispatched_at, d.created_at), v_period_start) as started_at,
      least(coalesce(d.completed_at, case when d.status in ('pending', 'pending_approval', 'dispatched', 'acknowledged', 'en_route', 'on_scene') then clock_timestamp() else d.created_at end), v_period_end) as ended_at,
      coalesce(d.job_type, 'Dispatch job') as label,
      jsonb_build_object('dispatch_job_id', d.id, 'job_type', d.job_type, 'status', d.status, 'shift_id', d.shift_id, 'shift_stop_id', d.shift_stop_id, 'dispatched_at', d.dispatched_at, 'on_scene_at', d.on_scene_at, 'completed_at', d.completed_at) as metadata
    from public.dispatch_jobs d
    left join public.shifts s on s.id = d.shift_id and s.officer_user_id = v_user_id
    where d.organization_id = v_org_id
      and (s.id is not null or d.dispatch_resource_id in (select dr.id from public.dispatch_resources dr where dr.assigned_officer_id = v_user_id))
      and d.status in ('dispatched', 'acknowledged', 'en_route', 'on_scene', 'completed')
        -- A dispatch job linked to a shift is already represented by that shift's
        -- work interval; count standalone dispatch work here to avoid double pay.
        and d.shift_id is null
      and coalesce(d.completed_at, case when d.status in ('dispatched', 'acknowledged', 'en_route', 'on_scene') then clock_timestamp() else d.created_at end) > v_period_start
      and coalesce(d.on_scene_at, d.en_route_at, d.acknowledged_at, d.dispatched_at, d.created_at) < v_period_end
  ), sources as (
    select * from shift_work
    union all
    select * from job_work
  ), bounded as (
    select *, greatest(0, floor(extract(epoch from (ended_at - started_at)) / 60))::integer as minutes
    from sources
    where ended_at > started_at
  )
  select source_type, source_id, work_status, started_at, ended_at, minutes, label,
    metadata || jsonb_build_object('calculated_minutes', minutes) as metadata
  from bounded
  order by started_at, source_type, source_id;
end;
$$;

revoke all on function public.get_officer_timesheet_work(date, date) from public, anon;
grant execute on function public.get_officer_timesheet_work(date, date) to authenticated, service_role;

-- Creates one governed timesheet from the source work snapshot. p_adjustment_hours
-- is the auditable payroll exception, not a replacement for source-derived hours.
create or replace function public.submit_officer_timesheet_from_work(
  p_client_event_id uuid,
  p_period_start date,
  p_period_end date,
  p_adjustment_hours numeric default 0,
  p_notes text default null
) returns table (
  id uuid,
  created boolean,
  submitted_at timestamptz,
  work_derived_hours numeric,
  actual_hours numeric,
  source_count integer
) language plpgsql security definer volatile set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_staff public.staff_profiles%rowtype;
  v_sheet public.timesheets%rowtype;
  v_work record;
  v_work_json jsonb := '[]'::jsonb;
  v_work_minutes integer := 0;
  v_source_count integer := 0;
  v_adjustment numeric := coalesce(p_adjustment_hours, 0);
  v_actual numeric;
  v_scheduled numeric;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  select sp.* into v_staff from public.staff_profiles sp join public.user_profiles up on up.id = v_user_id and up.deactivated_at is null where (sp.user_id = v_user_id or sp.id = v_user_id) and sp.organization_id = up.organization_id limit 1;
  if not found then raise exception 'Active staff profile required'; end if;
  if p_client_event_id is null then raise exception 'client_event_id is required'; end if;
  if p_period_start is null or p_period_end is null or p_period_start > p_period_end or p_period_end - p_period_start > 31 then raise exception 'Timesheet period must be between 1 and 32 days'; end if;
  if p_period_end > current_date then raise exception 'Future timesheet periods cannot be submitted'; end if;
  if v_adjustment < -744 or v_adjustment > 744 then raise exception 'Adjustment hours are outside the accepted range'; end if;

  select t.* into v_sheet from public.timesheets t where t.organization_id = v_staff.organization_id and t.staff_id = v_staff.id and t.client_event_id = p_client_event_id;
  if found then
    return query select v_sheet.id, false, v_sheet.submitted_at, coalesce(v_sheet.work_derived_hours, 0), v_sheet.actual_hours, (select count(*)::integer from public.timesheet_work_entries e where e.timesheet_id = v_sheet.id);
    return;
  end if;
  if exists (select 1 from public.timesheets t where t.staff_id = v_staff.id and daterange(t.period_start, t.period_end, '[]') && daterange(p_period_start, p_period_end, '[]')) then raise exception 'A timesheet already overlaps this period'; end if;

  for v_work in select * from public.get_officer_timesheet_work(p_period_start, p_period_end) loop
    v_work_minutes := v_work_minutes + v_work.calculated_minutes;
    v_source_count := v_source_count + 1;
    v_work_json := v_work_json || jsonb_build_array(jsonb_build_object('source_type', v_work.source_type, 'source_id', v_work.source_id, 'work_status', v_work.work_status, 'started_at', v_work.started_at, 'ended_at', v_work.ended_at, 'calculated_minutes', v_work.calculated_minutes, 'label', v_work.label, 'metadata', v_work.metadata));
  end loop;

  v_actual := round((v_work_minutes::numeric / 60) + v_adjustment, 2);
  if v_actual < 0 or v_actual > 744 then raise exception 'Derived actual hours are outside the accepted range'; end if;

  select coalesce(sum(extract(epoch from (s.scheduled_end - s.scheduled_start)) / 3600), 0) into v_scheduled from public.shifts s where s.organization_id = v_staff.organization_id and s.officer_user_id = v_user_id and s.scheduled_start::date between p_period_start and p_period_end and s.status in ('accepted', 'in_progress', 'completed');

  insert into public.timesheets (organization_id, staff_id, period_start, period_end, scheduled_hours, actual_hours, overtime_hours, adjustment_hours, work_derived_hours, work_summary, status, notes, submitted_at, client_event_id)
  values (v_staff.organization_id, v_staff.id, p_period_start, p_period_end, round(v_scheduled, 2), v_actual, greatest(0, v_actual - round(v_scheduled, 2)), v_adjustment, round(v_work_minutes::numeric / 60, 2), jsonb_build_object('source_count', v_source_count, 'work_minutes', v_work_minutes, 'entries', v_work_json), 'submitted', nullif(trim(coalesce(p_notes, '')), ''), clock_timestamp(), p_client_event_id)
  returning * into v_sheet;

  for v_work in select * from jsonb_array_elements(v_work_json) loop
    insert into public.timesheet_work_entries (organization_id, timesheet_id, source_type, source_id, work_status, started_at, ended_at, calculated_minutes, metadata)
    values (v_staff.organization_id, v_sheet.id, v_work->>'source_type', (v_work->>'source_id')::uuid, v_work->>'work_status', (v_work->>'started_at')::timestamptz, (v_work->>'ended_at')::timestamptz, (v_work->>'calculated_minutes')::integer, coalesce(v_work->'metadata', '{}'::jsonb));
  end loop;

  insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_staff.organization_id, v_user_id, 'timesheet_submitted_from_work', 'timesheets', v_sheet.id, jsonb_build_object('staff_id', v_sheet.staff_id, 'period_start', p_period_start, 'period_end', p_period_end, 'work_derived_hours', v_sheet.work_derived_hours, 'adjustment_hours', v_adjustment, 'actual_hours', v_sheet.actual_hours, 'source_count', v_source_count));

  return query select v_sheet.id, true, v_sheet.submitted_at, v_sheet.work_derived_hours, v_sheet.actual_hours, v_source_count;
end;
$$;

revoke all on function public.submit_officer_timesheet_from_work(uuid, date, date, numeric, text) from public, anon;
grant execute on function public.submit_officer_timesheet_from_work(uuid, date, date, numeric, text) to authenticated, service_role;
