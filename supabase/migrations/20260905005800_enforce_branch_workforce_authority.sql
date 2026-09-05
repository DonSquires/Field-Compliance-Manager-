CREATE OR REPLACE FUNCTION public.user_can_exercise_branch_authority(p_branch_organization_id uuid,p_target_user_id uuid,p_area text,p_minimum_level text DEFAULT 'approve')
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  with ranks(level,rank) as(values('view',1),('verify',2),('approve',3),('adjust',4),('manage',5)), actor as(select id,role from public.user_profiles where id=auth.uid() and deactivated_at is null)
  select exists(select 1 from actor where public.staff_branch_authorisation_manager_can_manage(actor.id,p_branch_organization_id,p_target_user_id))
    or exists(select 1 from actor join public.staff_branch_authorisations assignment on assignment.user_id=actor.id and assignment.branch_org_id=p_branch_organization_id and assignment.status='active' join public.resolve_access_grants(actor.id,p_branch_organization_id) authority_grant on authority_grant.area=p_area join ranks actual on actual.level=authority_grant.level join ranks required on required.level=p_minimum_level where actual.rank>=required.rank);
$$;

DROP FUNCTION IF EXISTS public.get_branch_timesheet_queue(uuid);
CREATE OR REPLACE FUNCTION public.get_branch_timesheet_queue(p_operating_organization_id uuid)
RETURNS TABLE(id uuid, staff_id uuid, period_start date, period_end date, scheduled_hours numeric, actual_hours numeric, work_derived_hours numeric, adjustment_hours numeric, work_summary jsonb, status text, branch_review_notes text, branch_reviewed_by uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
declare v_actor uuid:=auth.uid();
begin
  if v_actor is null or not public.user_can_operate_organization(p_operating_organization_id) then raise exception 'Active authorized operating branch required';end if;
  return query select t.id,t.staff_id,t.period_start,t.period_end,t.scheduled_hours,t.actual_hours,t.work_derived_hours,t.adjustment_hours,t.work_summary,t.status,t.branch_review_notes,t.branch_reviewed_by from public.timesheets t join public.staff_profiles staff on staff.id=t.staff_id join public.staff_branch_authorisations assignment on assignment.user_id=coalesce(staff.user_id,staff.id) and assignment.branch_org_id=p_operating_organization_id and assignment.status='active' where public.user_can_exercise_branch_authority(p_operating_organization_id,coalesce(staff.user_id,staff.id),'timesheet_local_review') order by t.period_start desc;
end;$$;

DROP FUNCTION IF EXISTS public.get_branch_leave_queue(uuid);
CREATE OR REPLACE FUNCTION public.get_branch_leave_queue(p_operating_organization_id uuid)
RETURNS TABLE(id uuid,staff_id uuid,leave_type text,starts_on date,ends_on date,status text,reason text,branch_review_notes text,branch_reviewed_by uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
declare v_actor uuid:=auth.uid();
begin
  if v_actor is null or not public.user_can_operate_organization(p_operating_organization_id) then raise exception 'Active authorized operating branch required';end if;
  return query select l.id,l.staff_id,l.leave_type,l.starts_on,l.ends_on,l.status,l.reason,l.branch_review_notes,l.branch_reviewed_by from public.leave_requests l join public.staff_profiles staff on staff.id=l.staff_id join public.staff_branch_authorisations assignment on assignment.user_id=coalesce(staff.user_id,staff.id) and assignment.branch_org_id=p_operating_organization_id and assignment.status='active' where public.user_can_exercise_branch_authority(p_operating_organization_id,coalesce(staff.user_id,staff.id),'leave_branch_approve') order by l.starts_on desc;
end;$$;

CREATE OR REPLACE FUNCTION public.review_branch_timesheet(p_operating_organization_id uuid,p_timesheet_id uuid,p_expected_status text,p_decision text,p_review_notes text DEFAULT NULL)
RETURNS public.timesheets LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
declare v_actor uuid:=auth.uid();v_sheet public.timesheets%rowtype;v_staff_user uuid;v_notes text:=nullif(trim(coalesce(p_review_notes,'')), '');v_pay_blocker text;
begin
  if p_decision not in('branch_checked','rejected') then raise exception 'Unsupported branch timesheet decision';end if;select * into v_sheet from public.timesheets where id=p_timesheet_id for update;if not found then raise exception 'Timesheet not found';end if;select coalesce(staff.user_id,staff.id) into v_staff_user from public.staff_profiles staff where staff.id=v_sheet.staff_id;
  if not public.user_can_operate_organization(p_operating_organization_id) or not public.user_can_exercise_branch_authority(p_operating_organization_id,v_staff_user,'timesheet_local_review') then raise exception 'Not authorised to review this branch timesheet';end if;
  if v_sheet.status<>p_expected_status or v_sheet.status<>'submitted' then raise exception 'Only submitted timesheets are available for branch review';end if;if p_decision='rejected' and v_notes is null then raise exception 'Review notes are required to return a timesheet for correction';end if;if v_sheet.actual_hours is null then raise exception 'Actual hours are required before review';end if;if p_decision='branch_checked' then v_pay_blocker:=public.timesheet_dispatch_pay_review_blocker(v_sheet.id);if v_pay_blocker is not null then raise exception 'Timesheet cannot be branch checked: %',v_pay_blocker;end if;end if;
  update public.timesheets set status=p_decision,branch_reviewed_by=v_actor,branch_reviewed_at=clock_timestamp(),branch_review_notes=v_notes,branch_reviewed_organization_id=p_operating_organization_id,review_notes=case when p_decision='rejected' then v_notes else review_notes end where id=v_sheet.id returning * into v_sheet;insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)values(v_sheet.organization_id,v_actor,case when p_decision='branch_checked' then 'timesheet_branch_checked' else 'timesheet_returned_for_correction' end,'timesheets',v_sheet.id,jsonb_build_object('staff_id',v_sheet.staff_id,'operating_organization_id',p_operating_organization_id,'review_notes',v_notes));return v_sheet;
end;$$;

CREATE OR REPLACE FUNCTION public.review_branch_leave_request(p_operating_organization_id uuid,p_request_id uuid,p_expected_status text,p_decision text,p_review_notes text DEFAULT NULL)
RETURNS public.leave_requests LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
declare v_actor uuid:=auth.uid();v_leave public.leave_requests%rowtype;v_staff_user uuid;v_notes text:=nullif(trim(coalesce(p_review_notes,'')), '');
begin
  if p_decision not in('branch_checked','declined') then raise exception 'Unsupported branch leave decision';end if;select * into v_leave from public.leave_requests where id=p_request_id for update;if not found then raise exception 'Leave request not found';end if;select coalesce(staff.user_id,staff.id) into v_staff_user from public.staff_profiles staff where staff.id=v_leave.staff_id;
  if not public.user_can_operate_organization(p_operating_organization_id) or not public.user_can_exercise_branch_authority(p_operating_organization_id,v_staff_user,'leave_branch_approve') then raise exception 'Not authorised to review this branch leave request';end if;
  if v_leave.status<>p_expected_status or v_leave.status<>'pending' then raise exception 'Leave request changed since it was opened';end if;if p_decision='declined' and v_notes is null then raise exception 'Review notes are required to decline leave';end if;
  update public.leave_requests set status=p_decision,branch_reviewed_by=v_actor,branch_reviewed_at=clock_timestamp(),branch_review_notes=v_notes,branch_reviewed_organization_id=p_operating_organization_id,decision_notes=case when p_decision='declined' then v_notes else decision_notes end,approved_by=case when p_decision='declined' then v_actor else approved_by end,approved_at=case when p_decision='declined' then clock_timestamp() else approved_at end where id=v_leave.id returning * into v_leave;insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)values(v_leave.organization_id,v_actor,case when p_decision='branch_checked' then 'leave_branch_checked' else 'leave_branch_declined' end,'leave_requests',v_leave.id,jsonb_build_object('staff_id',v_leave.staff_id,'operating_organization_id',p_operating_organization_id,'review_notes',v_notes));return v_leave;
end;$$;

REVOKE ALL ON FUNCTION public.user_can_exercise_branch_authority(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;