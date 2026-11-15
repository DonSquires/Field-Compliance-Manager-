-- Allow payroll correction of an approved timesheet that is not yet in a payroll export batch.
-- The correction returns the timesheet to submitted so it must be approved again.
-- Timesheets in a payroll export batch remain uneditable.

drop function public.correct_timesheet_hours(uuid, text, numeric, numeric, text);

create function public.correct_timesheet_hours(
  p_timesheet_id uuid,
  p_expected_status text,
  p_expected_revision integer,
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
  v_previous_revision integer;
  v_previous_approved_by uuid;
  v_previous_approved_at timestamptz;
  v_previous_branch_reviewed_by uuid;
  v_previous_branch_reviewed_at timestamptz;
  v_previous_branch_review_notes text;
  v_previous_branch_reviewed_organization_id uuid;
begin
  if v_reason is null then raise exception 'A correction reason is required'; end if;
  if p_actual_hours is null or p_actual_hours < 0 or p_actual_hours > 744 then raise exception 'Actual hours are outside the accepted range'; end if;
  if p_overtime_hours is null or p_overtime_hours < 0 or p_overtime_hours > p_actual_hours then raise exception 'Overtime hours are outside the accepted range'; end if;
  select t.* into v_sheet from public.timesheets t where t.id = p_timesheet_id for update;
  if not found then raise exception 'Timesheet not found'; end if;
  if v_sheet.status = 'approved' then
    if not public.is_timesheet_payroll_admin(v_sheet.organization_id) then raise exception 'Active employer payroll administrator required'; end if;
  elsif not public.is_admin_for_org(v_sheet.organization_id) then
    raise exception 'Not authorised to correct this timesheet';
  end if;
  if v_sheet.status <> p_expected_status or v_sheet.status not in ('submitted', 'branch_checked', 'approved') then raise exception 'Only submitted, branch-checked or approved timesheets can be corrected'; end if;
  if v_sheet.revision is distinct from p_expected_revision then raise exception 'Timesheet changed; reload before correcting'; end if;
  if v_sheet.payroll_export_batch_id is not null then raise exception 'This timesheet is in a payroll export batch and cannot be corrected'; end if;
  v_previous_actual := v_sheet.actual_hours;
  v_previous_revision := v_sheet.revision;
  v_previous_approved_by := v_sheet.approved_by;
  v_previous_approved_at := v_sheet.approved_at;
  v_previous_branch_reviewed_by := v_sheet.branch_reviewed_by;
  v_previous_branch_reviewed_at := v_sheet.branch_reviewed_at;
  v_previous_branch_review_notes := v_sheet.branch_review_notes;
  v_previous_branch_reviewed_organization_id := v_sheet.branch_reviewed_organization_id;

  update public.timesheets set actual_hours = p_actual_hours, overtime_hours = p_overtime_hours, adjustment_hours = p_actual_hours - coalesce(work_derived_hours, 0), review_notes = v_reason, status = 'submitted', branch_reviewed_by = null, branch_reviewed_at = null, branch_review_notes = null, branch_reviewed_organization_id = null, approved_by = null, approved_at = null where id = v_sheet.id returning * into v_sheet;
  insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata) values (v_sheet.organization_id, v_actor, 'timesheet_hours_corrected', 'timesheets', v_sheet.id, jsonb_build_object('previous_status', p_expected_status, 'previous_revision', v_previous_revision, 'previous_approved_by', v_previous_approved_by, 'previous_approved_at', v_previous_approved_at, 'previous_branch_reviewed_by', v_previous_branch_reviewed_by, 'previous_branch_reviewed_at', v_previous_branch_reviewed_at, 'previous_branch_review_notes', v_previous_branch_review_notes, 'previous_branch_reviewed_organization_id', v_previous_branch_reviewed_organization_id, 'previous_actual_hours', v_previous_actual, 'actual_hours', p_actual_hours, 'overtime_hours', p_overtime_hours, 'reason', v_reason));
  return v_sheet;
end;
$$;

revoke all on function public.correct_timesheet_hours(uuid, text, integer, numeric, numeric, text) from public, anon, service_role;
grant execute on function public.correct_timesheet_hours(uuid, text, integer, numeric, numeric, text) to authenticated, service_role;

create or replace function public.correct_timesheet_pay(p_client_request_id uuid, p_timesheet_id uuid, p_expected_revision integer, p_pay_code text, p_hourly_rate numeric, p_reason text)
 returns public.timesheets
 language plpgsql
 security definer
 set search_path to ''
as $function$
DECLARE v_sheet public.timesheets%rowtype; v_request jsonb; v_old jsonb; v_receipt jsonb;
  v_previous_status text; v_previous_revision integer; v_previous_approved_by uuid; v_previous_approved_at timestamptz;
  v_previous_branch_reviewed_by uuid; v_previous_branch_reviewed_at timestamptz;
  v_previous_branch_review_notes text; v_previous_branch_reviewed_organization_id uuid;
BEGIN
  SELECT * INTO v_sheet FROM public.timesheets WHERE id = p_timesheet_id FOR UPDATE;
  IF NOT FOUND OR NOT public.is_timesheet_payroll_admin(v_sheet.organization_id) THEN
    RAISE EXCEPTION 'Active employer payroll administrator required' USING ERRCODE = '42501';
  END IF;
  IF p_client_request_id IS NULL OR nullif(btrim(p_reason),'') IS NULL OR length(p_reason)>2000 THEN
    RAISE EXCEPTION 'A request ID and audited pay override reason are required';
  END IF;
  v_request := jsonb_build_object('expected_revision',p_expected_revision,'pay_code',nullif(btrim(p_pay_code),''),
    'hourly_rate',p_hourly_rate,'reason',btrim(p_reason));
  SELECT metadata INTO v_receipt FROM public.audit_log WHERE target_id=v_sheet.id
    AND action='timesheet_pay_corrected' AND metadata->>'client_request_id'=p_client_request_id::text;
  IF FOUND THEN
    IF v_receipt->'request' IS DISTINCT FROM v_request THEN RAISE EXCEPTION 'Request ID already used with different pay details'; END IF;
    RETURN v_sheet;
  END IF;
  IF v_sheet.revision IS DISTINCT FROM p_expected_revision OR v_sheet.status NOT IN ('submitted','branch_checked','approved')
    OR v_sheet.payroll_export_batch_id IS NOT NULL THEN RAISE EXCEPTION 'Timesheet changed or is no longer editable; reload'; END IF;
  v_old := jsonb_build_object('pay_code',v_sheet.pay_code_override,'hourly_rate',v_sheet.hourly_rate_override);
  v_previous_status := v_sheet.status;
  v_previous_revision := v_sheet.revision;
  v_previous_approved_by := v_sheet.approved_by;
  v_previous_approved_at := v_sheet.approved_at;
  v_previous_branch_reviewed_by := v_sheet.branch_reviewed_by;
  v_previous_branch_reviewed_at := v_sheet.branch_reviewed_at;
  v_previous_branch_review_notes := v_sheet.branch_review_notes;
  v_previous_branch_reviewed_organization_id := v_sheet.branch_reviewed_organization_id;
  UPDATE public.timesheets SET pay_code_override=nullif(btrim(p_pay_code),''),
    hourly_rate_override=p_hourly_rate,pay_override_reason=btrim(p_reason),
    status='submitted',branch_reviewed_by=NULL,branch_reviewed_at=NULL,branch_review_notes=NULL,
    branch_reviewed_organization_id=NULL,approved_by=NULL,approved_at=NULL
    WHERE id=v_sheet.id RETURNING * INTO v_sheet;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
    VALUES(v_sheet.organization_id,auth.uid(),'timesheet_pay_corrected','timesheets',v_sheet.id,
      jsonb_build_object('client_request_id',p_client_request_id,'request',v_request,'previous',v_old,
        'previous_status',v_previous_status,'previous_revision',v_previous_revision,
        'previous_approved_by',v_previous_approved_by,'previous_approved_at',v_previous_approved_at,
        'previous_branch_reviewed_by',v_previous_branch_reviewed_by,
        'previous_branch_reviewed_at',v_previous_branch_reviewed_at,
        'previous_branch_review_notes',v_previous_branch_review_notes,
        'previous_branch_reviewed_organization_id',v_previous_branch_reviewed_organization_id,
        'scope','this_timesheet_only','revision',v_sheet.revision));
  RETURN v_sheet;
END $function$;
