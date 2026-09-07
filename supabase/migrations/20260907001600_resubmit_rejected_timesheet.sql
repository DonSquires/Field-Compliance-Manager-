-- Allow an officer to correct and resubmit a rejected timesheet without creating
-- an overlapping duplicate period. Source work is recalculated and audited.

create or replace function public.resubmit_rejected_timesheet_from_work(
  p_timesheet_id uuid,
  p_adjustment_hours numeric default 0,
  p_notes text default null
) returns table (id uuid, submitted_at timestamptz, actual_hours numeric, source_count integer)
language plpgsql security definer set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_staff public.staff_profiles%rowtype;
  v_sheet public.timesheets%rowtype;
  v_work record;
  v_minutes integer := 0;
  v_count integer := 0;
  v_actual numeric;
  v_entries jsonb := '[]'::jsonb;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  select t.* into v_sheet from public.timesheets t where t.id = p_timesheet_id for update;
  if not found then raise exception 'Timesheet not found'; end if;
  select sp.* into v_staff from public.staff_profiles sp where (sp.user_id = v_actor or sp.id = v_actor) and sp.id = v_sheet.staff_id and sp.organization_id = v_sheet.organization_id;
  if not found then raise exception 'Only the timesheet owner can resubmit it'; end if;
  if v_sheet.status <> 'rejected' then raise exception 'Only rejected timesheets can be resubmitted'; end if;
  if p_adjustment_hours < -744 or p_adjustment_hours > 744 then raise exception 'Adjustment hours are outside the accepted range'; end if;

  for v_work in select * from public.get_officer_timesheet_work(v_sheet.period_start, v_sheet.period_end) loop
    v_minutes := v_minutes + v_work.calculated_minutes;
    v_count := v_count + 1;
    v_entries := v_entries || jsonb_build_array(jsonb_build_object('source_type', v_work.source_type, 'source_id', v_work.source_id, 'work_status', v_work.work_status, 'started_at', v_work.started_at, 'ended_at', v_work.ended_at, 'calculated_minutes', v_work.calculated_minutes, 'label', v_work.label, 'metadata', v_work.metadata));
  end loop;
  v_actual := round((v_minutes::numeric / 60) + coalesce(p_adjustment_hours, 0), 2);
  if v_actual < 0 or v_actual > 744 then raise exception 'Derived actual hours are outside the accepted range'; end if;

  delete from public.timesheet_work_entries where timesheet_id = v_sheet.id;
  update public.timesheets set actual_hours = v_actual, overtime_hours = greatest(0, v_actual - coalesce(scheduled_hours, 0)), adjustment_hours = coalesce(p_adjustment_hours, 0), work_derived_hours = round(v_minutes::numeric / 60, 2), work_summary = jsonb_build_object('source_count', v_count, 'work_minutes', v_minutes, 'entries', v_entries), status = 'submitted', review_notes = nullif(trim(coalesce(p_notes, '')), ''), submitted_at = clock_timestamp(), approved_by = null, approved_at = null where id = v_sheet.id returning * into v_sheet;

  for v_work in select * from jsonb_array_elements(v_entries) loop
    insert into public.timesheet_work_entries (organization_id, timesheet_id, source_type, source_id, work_status, started_at, ended_at, calculated_minutes, metadata) values (v_sheet.organization_id, v_sheet.id, v_work->>'source_type', (v_work->>'source_id')::uuid, v_work->>'work_status', (v_work->>'started_at')::timestamptz, (v_work->>'ended_at')::timestamptz, (v_work->>'calculated_minutes')::integer, coalesce(v_work->'metadata', '{}'::jsonb));
  end loop;

  insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata) values (v_sheet.organization_id, v_actor, 'timesheet_resubmitted_after_correction', 'timesheets', v_sheet.id, jsonb_build_object('actual_hours', v_actual, 'adjustment_hours', p_adjustment_hours, 'source_count', v_count, 'prior_status', 'rejected'));
  return query select v_sheet.id, v_sheet.submitted_at, v_sheet.actual_hours, v_count;
end;
$$;

revoke all on function public.resubmit_rejected_timesheet_from_work(uuid, numeric, text) from public, anon;
grant execute on function public.resubmit_rejected_timesheet_from_work(uuid, numeric, text) to authenticated, service_role;
