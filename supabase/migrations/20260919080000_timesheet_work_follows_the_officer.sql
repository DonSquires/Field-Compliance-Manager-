-- Timesheet work follows the officer, not the officer's home organisation.
-- Since 20260919030000 a shift belongs to the branch that rostered it, so an officer whose home organisation is the
-- employer (e.g. First Security) and who works a branch shift (First Security Nelson) had completed shifts that never
-- reached the timesheet: get_officer_timesheet_work filtered shifts by the home organisation and returned nothing.
-- Live check 2026-09-19: 6 completed branch shifts -> 0 timesheet work rows. Fixed here.
-- Also: unpaid breaks recorded on the shift (shift_breaks.is_paid = false, ended) come off the worked minutes;
-- paid rest breaks do not. The metadata carries the branch organisation and the break minutes for costing.

create or replace function public.get_officer_timesheet_work(p_period_start date, p_period_end date)
 returns table(source_type text, source_id uuid, work_status text, started_at timestamp with time zone, ended_at timestamp with time zone, calculated_minutes integer, label text, metadata jsonb)
 language plpgsql
 stable security definer
 set search_path to 'public'
as $$
#variable_conflict use_column
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
  with shift_window as (
    -- The officer's own completed shifts, whichever branch rostered them, clipped to the period.
    select s.*, greatest(s.actual_start, v_period_start) as w_start, least(s.actual_end, v_period_end) as w_end
    from public.shifts s
    where s.officer_user_id = v_user_id
      and s.status = 'completed' and s.actual_start is not null and s.actual_end is not null
      and s.actual_end > v_period_start and s.actual_start < v_period_end
  ), breaks_taken as (
    select b.shift_id,
      coalesce(sum(case when not b.is_paid then greatest(0, extract(epoch from (least(b.ended_at, w.w_end) - greatest(b.started_at, w.w_start))) / 60) end), 0)::integer as unpaid_minutes,
      coalesce(sum(case when b.is_paid then greatest(0, extract(epoch from (least(b.ended_at, w.w_end) - greatest(b.started_at, w.w_start))) / 60) end), 0)::integer as paid_minutes
    from public.shift_breaks b
    join shift_window w on w.id = b.shift_id
    where b.ended_at is not null
    group by b.shift_id
  ), shift_work(source_type, id, work_status, started_at, ended_at, deduct_minutes, label, metadata) as (
    select 'shift'::text, w.id, 'completed'::text, w.w_start, w.w_end, coalesce(bt.unpaid_minutes, 0),
      coalesce(w.service_type, 'shift'),
      jsonb_build_object('shift_id', w.id, 'organization_id', w.organization_id, 'service_type', w.service_type, 'status', w.status, 'ended_reason', w.ended_reason,
        'scheduled_start', w.scheduled_start, 'scheduled_end', w.scheduled_end, 'actual_start', w.actual_start, 'actual_end', w.actual_end,
        'unpaid_break_minutes', coalesce(bt.unpaid_minutes, 0), 'paid_break_minutes', coalesce(bt.paid_minutes, 0))
    from shift_window w
    left join breaks_taken bt on bt.shift_id = w.id
  ), job_work(source_type, id, work_status, started_at, ended_at, deduct_minutes, label, metadata) as (
    -- Standalone dispatch jobs the officer worked (no shift), whichever branch raised them.
    select 'dispatch_job'::text, d.id, 'completed'::text,
      greatest(coalesce(d.on_scene_at, d.en_route_at, d.acknowledged_at, d.dispatched_at, d.created_at), v_period_start),
      least(d.completed_at, v_period_end), 0, coalesce(d.job_type, 'Dispatch job'),
      jsonb_build_object('dispatch_job_id', d.id, 'organization_id', d.organization_id, 'job_type', d.job_type, 'status', d.status, 'shift_id', d.shift_id, 'shift_stop_id', d.shift_stop_id, 'dispatched_at', d.dispatched_at, 'on_scene_at', d.on_scene_at, 'completed_at', d.completed_at)
    from public.dispatch_jobs d
    where d.dispatch_resource_id in (select dr.id from public.dispatch_resources dr where dr.assigned_officer_id = v_user_id)
      and d.status = 'completed' and d.completed_at is not null and d.shift_id is null
      and d.completed_at > v_period_start
      and coalesce(d.on_scene_at, d.en_route_at, d.acknowledged_at, d.dispatched_at, d.created_at) < v_period_end
  ), sources as (
    select * from shift_work union all select * from job_work
  ), bounded as (
    select *, greatest(0, floor(extract(epoch from (ended_at - started_at)) / 60) - deduct_minutes)::integer as minutes
    from sources where ended_at > started_at
  )
  select source_type, id, work_status, started_at, ended_at, minutes, label,
    metadata || jsonb_build_object('calculated_minutes', minutes)
  from bounded order by started_at, source_type, id;
end;
$$;

comment on function public.get_officer_timesheet_work(date, date) is
  'The officer''s completed work in a period, from shift actual_start/actual_end (any branch) and completed standalone dispatch jobs. Unpaid ended breaks are deducted; metadata carries organization_id and break minutes.';

-- submit: rostered hours must also follow the officer across branches, or every worked hour reads as overtime.
create or replace function public.submit_officer_timesheet_from_work(p_client_event_id uuid, p_period_start date, p_period_end date, p_adjustment_hours numeric default 0, p_notes text default null)
 returns table(id uuid, created boolean, submitted_at timestamp with time zone, work_derived_hours numeric, actual_hours numeric, source_count integer)
 language plpgsql
 security definer
 set search_path to 'public'
as $$
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

  select coalesce(sum(extract(epoch from (s.scheduled_end - s.scheduled_start)) / 3600), 0) into v_scheduled from public.shifts s where s.officer_user_id = v_user_id and s.scheduled_start::date between p_period_start and p_period_end and s.status in ('accepted', 'in_progress', 'completed');

  insert into public.timesheets (organization_id, staff_id, period_start, period_end, scheduled_hours, actual_hours, overtime_hours, adjustment_hours, work_derived_hours, work_summary, status, notes, submitted_at, client_event_id)
  values (v_staff.organization_id, v_staff.id, p_period_start, p_period_end, round(v_scheduled, 2), v_actual, greatest(0, v_actual - round(v_scheduled, 2)), v_adjustment, round(v_work_minutes::numeric / 60, 2), jsonb_build_object('source_count', v_source_count, 'work_minutes', v_work_minutes, 'entries', v_work_json), 'submitted', nullif(trim(coalesce(p_notes, '')), ''), clock_timestamp(), p_client_event_id)
  returning * into v_sheet;

  for v_work in select value from jsonb_array_elements(v_work_json) loop
    insert into public.timesheet_work_entries (organization_id, timesheet_id, source_type, source_id, work_status, started_at, ended_at, calculated_minutes, metadata)
    values (v_staff.organization_id, v_sheet.id, (v_work.value)->>'source_type', ((v_work.value)->>'source_id')::uuid, (v_work.value)->>'work_status', ((v_work.value)->>'started_at')::timestamptz, ((v_work.value)->>'ended_at')::timestamptz, ((v_work.value)->>'calculated_minutes')::integer, coalesce((v_work.value)->'metadata', '{}'::jsonb));
  end loop;

  insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_staff.organization_id, v_user_id, 'timesheet_submitted_from_work', 'timesheets', v_sheet.id, jsonb_build_object('staff_id', v_sheet.staff_id, 'period_start', p_period_start, 'period_end', p_period_end, 'work_derived_hours', v_sheet.work_derived_hours, 'adjustment_hours', v_adjustment, 'actual_hours', v_sheet.actual_hours, 'source_count', v_source_count));

  return query select v_sheet.id, true, v_sheet.submitted_at, v_sheet.work_derived_hours, v_sheet.actual_hours, v_source_count;
end;
$$;

comment on function public.submit_officer_timesheet_from_work(uuid, date, date, numeric, text) is
  'Submits the officer''s timesheet for a period from completed work (get_officer_timesheet_work). Rostered hours are the officer''s accepted/in-progress/completed shifts in the period across every branch; the timesheet itself belongs to the employer (home organisation).';
