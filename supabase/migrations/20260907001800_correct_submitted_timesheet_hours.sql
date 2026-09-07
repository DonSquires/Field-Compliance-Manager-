-- Manager correction of submitted/branch-checked time before payroll approval.

create or replace function public.correct_timesheet_hours(
  p_timesheet_id uuid,
  p_expected_status text,
  p_actual_hours numeric,
  p_overtime_hours numeric,
  p_reason text
) returns public.timesheets
language plpgsql security definer set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_sheet public.timesheets%rowtype;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_previous_actual numeric;
begin
  if v_reason is null then raise exception 'A correction reason is required'; end if;
  if p_actual_hours is null or p_actual_hours < 0 or p_actual_hours > 744 then raise exception 'Actual hours are outside the accepted range'; end if;
  if p_overtime_hours is null or p_overtime_hours < 0 or p_overtime_hours > p_actual_hours then raise exception 'Overtime hours are outside the accepted range'; end if;
  select t.* into v_sheet from public.timesheets t where t.id = p_timesheet_id for update;
  if not found then raise exception 'Timesheet not found'; end if;
  if not public.is_admin_for_org(v_sheet.organization_id) then raise exception 'Not authorised to correct this timesheet'; end if;
  if v_sheet.status <> p_expected_status or v_sheet.status not in ('submitted', 'branch_checked') then raise exception 'Only submitted or branch-checked timesheets can be corrected'; end if;
  v_previous_actual := v_sheet.actual_hours;

  update public.timesheets set actual_hours = p_actual_hours, overtime_hours = p_overtime_hours, adjustment_hours = p_actual_hours - coalesce(work_derived_hours, 0), review_notes = v_reason, status = 'submitted', branch_reviewed_by = null, branch_reviewed_at = null, branch_review_notes = null, branch_reviewed_organization_id = null where id = v_sheet.id returning * into v_sheet;
  insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata) values (v_sheet.organization_id, v_actor, 'timesheet_hours_corrected', 'timesheets', v_sheet.id, jsonb_build_object('previous_status', p_expected_status, 'previous_actual_hours', v_previous_actual, 'actual_hours', p_actual_hours, 'overtime_hours', p_overtime_hours, 'reason', v_reason));
  return v_sheet;
end;
$$;

revoke all on function public.correct_timesheet_hours(uuid, text, numeric, numeric, text) from public, anon;
grant execute on function public.correct_timesheet_hours(uuid, text, numeric, numeric, text) to authenticated, service_role;
