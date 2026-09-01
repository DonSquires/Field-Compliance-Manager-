alter table public.notifications drop constraint if exists notifications_category_check;
alter table public.notifications add constraint notifications_category_check check(category in('credential_expiry','sla_breach','report_ready','report_reviewed','leave_decision','welfare','dispatch','roster','open_job','system','schema_change_request','bob_conversation','bob_self_memory'));

create or replace function public.review_leave_request(p_request_id uuid,p_expected_status text,p_decision text,p_review_notes text default null)
returns public.leave_requests language plpgsql volatile security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_leave public.leave_requests%rowtype;v_notes text:=nullif(trim(coalesce(p_review_notes,'')),'');v_officer_user_id uuid;
begin
  select l.* into v_leave from public.leave_requests l where l.id=p_request_id for update;if not found then raise exception 'Leave request not found';end if;
  if not public.is_admin_for_org(v_leave.organization_id) then raise exception 'Not authorised to review this leave request';end if;if v_leave.status<>p_expected_status then raise exception 'Leave request changed from expected status % to %',p_expected_status,v_leave.status;end if;if v_leave.status<>'pending' or p_decision not in('approved','declined') then raise exception 'Unsupported leave decision';end if;if p_decision='declined' and v_notes is null then raise exception 'Review notes are required to decline leave';end if;
  if p_decision='approved' and exists(select 1 from public.roster_slots s where s.staff_id=v_leave.staff_id and s.status not in('declined','cancelled') and daterange((s.scheduled_start at time zone 'Pacific/Auckland')::date,(s.scheduled_end at time zone 'Pacific/Auckland')::date,'[]')&&daterange(v_leave.starts_on,v_leave.ends_on,'[]')) then raise exception 'Active roster slots overlap this leave request';end if;
  update public.leave_requests set status=p_decision,approved_by=v_actor,approved_at=clock_timestamp(),decision_notes=v_notes where id=v_leave.id returning * into v_leave;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_leave.organization_id,v_actor,case when p_decision='approved' then 'leave_request_approved' else 'leave_request_declined' end,'leave_requests',v_leave.id,jsonb_build_object('staff_id',v_leave.staff_id,'starts_on',v_leave.starts_on,'ends_on',v_leave.ends_on,'review_notes',v_notes));
  select coalesce(sp.user_id,sp.id) into v_officer_user_id from public.staff_profiles sp where sp.id=v_leave.staff_id;
  if v_officer_user_id is not null then perform public.enqueue_notification(p_organization_id=>v_leave.organization_id,p_category=>'leave_decision',p_title=>'Leave request '||v_leave.status,p_body=>coalesce(v_notes,'Your leave request has been '||v_leave.status||'.'),p_severity=>'info',p_recipient_user_id=>v_officer_user_id,p_link_page=>'leave-decision',p_link_payload=>jsonb_build_object('leave_request_id',v_leave.id,'status',v_leave.status),p_dedup_key=>'leave_decision:'||v_leave.id::text||':'||v_leave.status);end if;
  return v_leave;
end;$$;
revoke all on function public.review_leave_request(uuid,text,text,text) from public,anon;
grant execute on function public.review_leave_request(uuid,text,text,text) to authenticated,service_role;