ALTER TABLE public.timesheets
  ADD COLUMN IF NOT EXISTS branch_reviewed_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS branch_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS branch_review_notes text,
  ADD COLUMN IF NOT EXISTS branch_reviewed_organization_id uuid REFERENCES public.organizations(id) ON DELETE SET NULL;

ALTER TABLE public.timesheets DROP CONSTRAINT IF EXISTS timesheets_status_check;
ALTER TABLE public.timesheets ADD CONSTRAINT timesheets_status_check CHECK (status IN ('draft','submitted','branch_checked','approved','rejected','paid'));

DROP FUNCTION IF EXISTS public.get_branch_timesheet_queue(uuid);
CREATE OR REPLACE FUNCTION public.get_branch_timesheet_queue(p_operating_organization_id uuid)
RETURNS TABLE(id uuid, staff_id uuid, period_start date, period_end date, scheduled_hours numeric, actual_hours numeric, work_derived_hours numeric, adjustment_hours numeric, work_summary jsonb, status text, branch_review_notes text, branch_reviewed_by uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
declare v_actor uuid := auth.uid();
begin
  if v_actor is null or not public.user_can_operate_organization(p_operating_organization_id) then raise exception 'Active authorized operating branch required'; end if;
  return query select t.id,t.staff_id,t.period_start,t.period_end,t.scheduled_hours,t.actual_hours,t.work_derived_hours,t.adjustment_hours,t.work_summary,t.status,t.branch_review_notes,t.branch_reviewed_by
  from public.timesheets t
  join public.staff_profiles staff on staff.id=t.staff_id
  join public.staff_branch_authorisations assignment on assignment.user_id=coalesce(staff.user_id,staff.id) and assignment.branch_org_id=p_operating_organization_id and assignment.status='active'
  where public.staff_branch_authorisation_manager_can_manage(v_actor,p_operating_organization_id,coalesce(staff.user_id,staff.id))
  order by t.period_start desc;
end;
$$;

CREATE OR REPLACE FUNCTION public.review_branch_timesheet(p_operating_organization_id uuid,p_timesheet_id uuid,p_expected_status text,p_decision text,p_review_notes text DEFAULT NULL)
RETURNS public.timesheets
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare v_actor uuid:=auth.uid();v_sheet public.timesheets%rowtype;v_staff_user uuid;v_notes text:=nullif(trim(coalesce(p_review_notes,'')), '');v_pay_blocker text;
begin
  if p_decision not in('branch_checked','rejected') then raise exception 'Unsupported branch timesheet decision'; end if;
  select t.* into v_sheet from public.timesheets t where t.id=p_timesheet_id for update;
  if not found then raise exception 'Timesheet not found'; end if;
  select coalesce(staff.user_id,staff.id) into v_staff_user from public.staff_profiles staff where staff.id=v_sheet.staff_id;
  if not public.user_can_operate_organization(p_operating_organization_id) or not exists(select 1 from public.staff_branch_authorisations assignment where assignment.user_id=v_staff_user and assignment.branch_org_id=p_operating_organization_id and assignment.status='active') or not public.staff_branch_authorisation_manager_can_manage(v_actor,p_operating_organization_id,v_staff_user) then raise exception 'Not authorised to review this branch timesheet'; end if;
  if v_sheet.status<>p_expected_status then raise exception 'Timesheet changed from expected status % to %',p_expected_status,v_sheet.status; end if;
  if v_sheet.status<>'submitted' then raise exception 'Only submitted timesheets are available for branch review'; end if;
  if p_decision='rejected' and v_notes is null then raise exception 'Review notes are required to return a timesheet for correction'; end if;
  if v_sheet.actual_hours is null then raise exception 'Actual hours are required before review'; end if;
  if p_decision='branch_checked' then v_pay_blocker:=public.timesheet_dispatch_pay_review_blocker(v_sheet.id);if v_pay_blocker is not null then raise exception 'Timesheet cannot be branch checked: %',v_pay_blocker;end if;end if;
  update public.timesheets set status=p_decision,branch_reviewed_by=v_actor,branch_reviewed_at=clock_timestamp(),branch_review_notes=v_notes,branch_reviewed_organization_id=p_operating_organization_id,review_notes=case when p_decision='rejected' then v_notes else review_notes end where id=v_sheet.id returning * into v_sheet;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)values(v_sheet.organization_id,v_actor,case when p_decision='branch_checked' then 'timesheet_branch_checked' else 'timesheet_returned_for_correction' end,'timesheets',v_sheet.id,jsonb_build_object('staff_id',v_sheet.staff_id,'operating_organization_id',p_operating_organization_id,'review_notes',v_notes));
  return v_sheet;
end;
$$;

CREATE OR REPLACE FUNCTION public.review_timesheet(p_timesheet_id uuid,p_expected_status text,p_decision text,p_review_notes text DEFAULT NULL)
RETURNS public.timesheets
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare v_actor uuid:=auth.uid();v_sheet public.timesheets%rowtype;v_notes text:=nullif(trim(coalesce(p_review_notes,'')), '');v_officer_user_id uuid;v_pay_blocker text;
begin
  select t.* into v_sheet from public.timesheets t where t.id=p_timesheet_id for update;
  if not found then raise exception 'Timesheet not found'; end if;
  if not exists(select 1 from public.user_profiles actor where actor.id=v_actor and actor.deactivated_at is null and actor.role in('grand_master','master','admin') and coalesce(actor.employer_organization_id,actor.organization_id)=v_sheet.organization_id) then raise exception 'Corporate payroll approval required'; end if;
  if v_sheet.status<>p_expected_status then raise exception 'Timesheet changed from expected status % to %',p_expected_status,v_sheet.status; end if;
  if v_sheet.status<>'branch_checked' or p_decision not in('approved','rejected') then raise exception 'Only branch-checked timesheets are available for payroll approval'; end if;
  if p_decision='approved' and v_sheet.branch_reviewed_by=v_actor then raise exception 'A different corporate payroll reviewer must approve this timesheet'; end if;
  if p_decision='rejected' and v_notes is null then raise exception 'Review notes are required to reject a timesheet'; end if;
  if v_sheet.actual_hours is null then raise exception 'Actual hours are required before review'; end if;
  if p_decision='approved' then v_pay_blocker:=public.timesheet_dispatch_pay_review_blocker(v_sheet.id);if v_pay_blocker is not null then raise exception 'Timesheet cannot be approved: %',v_pay_blocker;end if;end if;
  update public.timesheets set status=p_decision,approved_by=v_actor,approved_at=clock_timestamp(),review_notes=v_notes where id=v_sheet.id returning * into v_sheet;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)values(v_sheet.organization_id,v_actor,case when p_decision='approved' then 'timesheet_payroll_approved' else 'timesheet_payroll_rejected' end,'timesheets',v_sheet.id,jsonb_build_object('staff_id',v_sheet.staff_id,'branch_reviewed_organization_id',v_sheet.branch_reviewed_organization_id,'review_notes',v_notes));
  select coalesce(staff.user_id,staff.id) into v_officer_user_id from public.staff_profiles staff where staff.id=v_sheet.staff_id;
  if v_officer_user_id is not null then perform public.enqueue_notification(p_organization_id=>v_sheet.organization_id,p_category=>'timesheet_decision',p_title=>'Timesheet '||v_sheet.status,p_body=>coalesce(v_notes,'Your timesheet has been '||v_sheet.status||'.'),p_severity=>'info',p_recipient_user_id=>v_officer_user_id,p_link_page=>'timesheet-decision',p_link_payload=>jsonb_build_object('timesheet_id',v_sheet.id,'status',v_sheet.status),p_dedup_key=>'timesheet_decision:'||v_sheet.id::text||':'||v_sheet.status);end if;
  return v_sheet;
end;
$$;

REVOKE ALL ON FUNCTION public.get_branch_timesheet_queue(uuid),public.review_branch_timesheet(uuid,uuid,text,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_branch_timesheet_queue(uuid),public.review_branch_timesheet(uuid,uuid,text,text,text) TO authenticated,service_role;