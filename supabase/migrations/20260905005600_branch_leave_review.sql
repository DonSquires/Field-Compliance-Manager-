ALTER TABLE public.leave_requests
  ADD COLUMN IF NOT EXISTS branch_reviewed_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS branch_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS branch_review_notes text,
  ADD COLUMN IF NOT EXISTS branch_reviewed_organization_id uuid REFERENCES public.organizations(id) ON DELETE SET NULL;

ALTER TABLE public.leave_requests DROP CONSTRAINT IF EXISTS leave_requests_status_check;
ALTER TABLE public.leave_requests ADD CONSTRAINT leave_requests_status_check CHECK (status IN ('pending','branch_checked','approved','declined','cancelled'));

CREATE OR REPLACE FUNCTION public.get_branch_leave_queue(p_operating_organization_id uuid)
RETURNS TABLE(id uuid,staff_id uuid,leave_type text,starts_on date,ends_on date,status text,reason text,branch_review_notes text,branch_reviewed_by uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
declare v_actor uuid:=auth.uid();
begin
  if v_actor is null or not public.user_can_operate_organization(p_operating_organization_id) then raise exception 'Active authorized operating branch required';end if;
  return query select l.id,l.staff_id,l.leave_type,l.starts_on,l.ends_on,l.status,l.reason,l.branch_review_notes,l.branch_reviewed_by from public.leave_requests l join public.staff_profiles staff on staff.id=l.staff_id join public.staff_branch_authorisations assignment on assignment.user_id=coalesce(staff.user_id,staff.id) and assignment.branch_org_id=p_operating_organization_id and assignment.status='active' where public.staff_branch_authorisation_manager_can_manage(v_actor,p_operating_organization_id,coalesce(staff.user_id,staff.id)) order by l.starts_on desc;
end;$$;

CREATE OR REPLACE FUNCTION public.review_branch_leave_request(p_operating_organization_id uuid,p_request_id uuid,p_expected_status text,p_decision text,p_review_notes text DEFAULT NULL)
RETURNS public.leave_requests LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
declare v_actor uuid:=auth.uid();v_leave public.leave_requests%rowtype;v_staff_user uuid;v_notes text:=nullif(trim(coalesce(p_review_notes,'')), '');
begin
  if p_decision not in('branch_checked','declined') then raise exception 'Unsupported branch leave decision';end if;
  select * into v_leave from public.leave_requests where id=p_request_id for update;if not found then raise exception 'Leave request not found';end if;
  select coalesce(staff.user_id,staff.id) into v_staff_user from public.staff_profiles staff where staff.id=v_leave.staff_id;
  if not public.user_can_operate_organization(p_operating_organization_id) or not exists(select 1 from public.staff_branch_authorisations assignment where assignment.user_id=v_staff_user and assignment.branch_org_id=p_operating_organization_id and assignment.status='active') or not public.staff_branch_authorisation_manager_can_manage(v_actor,p_operating_organization_id,v_staff_user) then raise exception 'Not authorised to review this branch leave request';end if;
  if v_leave.status<>p_expected_status or v_leave.status<>'pending' then raise exception 'Leave request changed since it was opened';end if;
  if p_decision='declined' and v_notes is null then raise exception 'Review notes are required to decline leave';end if;
  update public.leave_requests set status=p_decision,branch_reviewed_by=v_actor,branch_reviewed_at=clock_timestamp(),branch_review_notes=v_notes,branch_reviewed_organization_id=p_operating_organization_id,decision_notes=case when p_decision='declined' then v_notes else decision_notes end,approved_by=case when p_decision='declined' then v_actor else approved_by end,approved_at=case when p_decision='declined' then clock_timestamp() else approved_at end where id=v_leave.id returning * into v_leave;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)values(v_leave.organization_id,v_actor,case when p_decision='branch_checked' then 'leave_branch_checked' else 'leave_branch_declined' end,'leave_requests',v_leave.id,jsonb_build_object('staff_id',v_leave.staff_id,'operating_organization_id',p_operating_organization_id,'review_notes',v_notes));
  return v_leave;
end;$$;

CREATE OR REPLACE FUNCTION public.review_leave_request(p_request_id uuid,p_expected_status text,p_decision text,p_review_notes text DEFAULT NULL)
RETURNS public.leave_requests LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
declare v_actor uuid:=auth.uid();v_leave public.leave_requests%rowtype;v_notes text:=nullif(trim(coalesce(p_review_notes,'')), '');v_officer_user_id uuid;
begin
  select * into v_leave from public.leave_requests where id=p_request_id for update;if not found then raise exception 'Leave request not found';end if;
  if not exists(select 1 from public.user_profiles actor where actor.id=v_actor and actor.deactivated_at is null and actor.role in('grand_master','master','admin') and coalesce(actor.employer_organization_id,actor.organization_id)=v_leave.organization_id) then raise exception 'Corporate leave approval required';end if;
  if v_leave.status<>p_expected_status or v_leave.status<>'branch_checked' or p_decision not in('approved','declined') then raise exception 'Only branch-checked leave requests are available for corporate decision';end if;
  if p_decision='approved' and v_leave.branch_reviewed_by=v_actor then raise exception 'A different corporate reviewer must approve this leave request';end if;
  if p_decision='declined' and v_notes is null then raise exception 'Review notes are required to decline leave';end if;
  if p_decision='approved' and exists(select 1 from public.roster_slots slot where slot.staff_id=v_leave.staff_id and slot.status not in('declined','cancelled') and daterange((slot.scheduled_start at time zone 'Pacific/Auckland')::date,(slot.scheduled_end at time zone 'Pacific/Auckland')::date,'[]')&&daterange(v_leave.starts_on,v_leave.ends_on,'[]')) then raise exception 'Active roster slots overlap this leave request';end if;
  update public.leave_requests set status=p_decision,approved_by=v_actor,approved_at=clock_timestamp(),decision_notes=v_notes where id=v_leave.id returning * into v_leave;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)values(v_leave.organization_id,v_actor,case when p_decision='approved' then 'leave_corporate_approved' else 'leave_corporate_declined' end,'leave_requests',v_leave.id,jsonb_build_object('staff_id',v_leave.staff_id,'branch_reviewed_organization_id',v_leave.branch_reviewed_organization_id,'review_notes',v_notes));
  select coalesce(staff.user_id,staff.id) into v_officer_user_id from public.staff_profiles staff where staff.id=v_leave.staff_id;
  if v_officer_user_id is not null then perform public.enqueue_notification(p_organization_id=>v_leave.organization_id,p_category=>'leave_decision',p_title=>'Leave request '||v_leave.status,p_body=>coalesce(v_notes,'Your leave request has been '||v_leave.status||'.'),p_severity=>'info',p_recipient_user_id=>v_officer_user_id,p_link_page=>'leave-decision',p_link_payload=>jsonb_build_object('leave_request_id',v_leave.id,'status',v_leave.status),p_dedup_key=>'leave_decision:'||v_leave.id::text||':'||v_leave.status);end if;
  return v_leave;
end;$$;

REVOKE ALL ON FUNCTION public.get_branch_leave_queue(uuid),public.review_branch_leave_request(uuid,uuid,text,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_branch_leave_queue(uuid),public.review_branch_leave_request(uuid,uuid,text,text,text) TO authenticated,service_role;