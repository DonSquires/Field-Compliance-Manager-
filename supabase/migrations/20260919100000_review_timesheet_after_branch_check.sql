-- Final approval after a branch check (owner walk finding 2026-09-19).
-- review_timesheet predates the branch-check stage and only accepted a 'submitted' sheet, so a branch-checked
-- timesheet could never be approved: the HR page offered "Final approve" and the server answered
-- "Unsupported timesheet decision". Live: officer sent -> branch check recorded -> final approval impossible.
-- Now: approve/reject from 'submitted' (single-organisation employers) or 'branch_checked' (branch model), and the
-- final reviewer must be a different person from the branch check (the page already hides the button; the
-- server now enforces it).

create or replace function public.review_timesheet(p_timesheet_id uuid, p_expected_status text, p_decision text, p_review_notes text default null)
 returns timesheets
 language plpgsql
 security definer
 set search_path to 'public'
as $$
declare
  v_actor uuid := auth.uid();
  v_sheet public.timesheets%rowtype;
  v_notes text := nullif(trim(coalesce(p_review_notes, '')), '');
  v_officer_user_id uuid;
  v_pay_blocker text;
begin
  select t.* into v_sheet from public.timesheets t where t.id = p_timesheet_id for update;
  if not found then raise exception 'Timesheet not found'; end if;
  if not public.is_admin_for_org(v_sheet.organization_id) then raise exception 'Not authorised to review this timesheet'; end if;
  if v_sheet.status <> p_expected_status then raise exception 'Timesheet changed from expected status % to %', p_expected_status, v_sheet.status; end if;
  if v_sheet.status not in ('submitted', 'branch_checked') or p_decision not in ('approved', 'rejected') then raise exception 'Unsupported timesheet decision'; end if;
  if v_sheet.status = 'branch_checked' and v_sheet.branch_reviewed_by = v_actor then raise exception 'Final approval must come from a different reviewer than the branch check'; end if;
  if p_decision = 'rejected' and v_notes is null then raise exception 'Review notes are required to reject a timesheet'; end if;
  if v_sheet.actual_hours is null then raise exception 'Actual hours are required before review'; end if;

  if p_decision = 'approved' then
    v_pay_blocker := public.timesheet_dispatch_pay_review_blocker(v_sheet.id);
    if v_pay_blocker is not null then
      raise exception 'Timesheet cannot be approved: %', v_pay_blocker;
    end if;
  end if;

  update public.timesheets set status = p_decision, approved_by = v_actor, approved_at = clock_timestamp(), review_notes = v_notes where id = v_sheet.id returning * into v_sheet;
  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata) values(v_sheet.organization_id, v_actor, case when p_decision = 'approved' then 'timesheet_approved' else 'timesheet_rejected' end, 'timesheets', v_sheet.id, jsonb_build_object('staff_id', v_sheet.staff_id, 'period_start', v_sheet.period_start, 'period_end', v_sheet.period_end, 'actual_hours', v_sheet.actual_hours, 'overtime_hours', v_sheet.overtime_hours, 'review_notes', v_notes, 'previous_status', p_expected_status, 'branch_reviewed_by', v_sheet.branch_reviewed_by));
  select coalesce(sp.user_id, sp.id) into v_officer_user_id from public.staff_profiles sp where sp.id = v_sheet.staff_id;
  if v_officer_user_id is not null then perform public.enqueue_notification(p_organization_id => v_sheet.organization_id, p_category => 'timesheet_decision', p_title => 'Timesheet ' || v_sheet.status, p_body => coalesce(v_notes, 'Your timesheet has been ' || v_sheet.status || '.'), p_severity => 'info', p_recipient_user_id => v_officer_user_id, p_link_page => 'timesheet-decision', p_link_payload => jsonb_build_object('timesheet_id', v_sheet.id, 'status', v_sheet.status), p_dedup_key => 'timesheet_decision:' || v_sheet.id::text || ':' || v_sheet.status); end if;
  return v_sheet;
end;
$$;

comment on function public.review_timesheet(uuid, text, text, text) is
  'Corporate final decision on a timesheet: approve or reject from submitted (single-organisation employer) or branch_checked (branch model). The final reviewer must differ from the branch reviewer. Approval is blocked while dispatch pay lines await review.';
