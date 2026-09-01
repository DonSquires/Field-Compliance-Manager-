alter table public.notifications drop constraint if exists notifications_category_check;
alter table public.notifications add constraint notifications_category_check check(category in('credential_expiry','sla_breach','report_ready','report_reviewed','leave_decision','timesheet_decision','welfare','dispatch','roster','open_job','system','schema_change_request','bob_conversation','bob_self_memory'));

create or replace function public.review_timesheet(p_timesheet_id uuid,p_expected_status text,p_decision text,p_review_notes text default null)
returns public.timesheets language plpgsql security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_sheet public.timesheets%rowtype;v_notes text:=nullif(trim(coalesce(p_review_notes,'')),'');v_officer_user_id uuid;
begin
  select t.* into v_sheet from public.timesheets t where t.id=p_timesheet_id for update;if not found then raise exception 'Timesheet not found';end if;
  if not public.is_admin_for_org(v_sheet.organization_id) then raise exception 'Not authorised to review this timesheet';end if;
  if v_sheet.status<>p_expected_status then raise exception 'Timesheet changed from expected status % to %',p_expected_status,v_sheet.status;end if;
  if v_sheet.status<>'submitted' or p_decision not in('approved','rejected') then raise exception 'Unsupported timesheet decision';end if;
  if p_decision='rejected' and v_notes is null then raise exception 'Review notes are required to reject a timesheet';end if;
  if v_sheet.actual_hours is null then raise exception 'Actual hours are required before review';end if;
  update public.timesheets set status=p_decision,approved_by=v_actor,approved_at=clock_timestamp(),review_notes=v_notes where id=v_sheet.id returning * into v_sheet;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_sheet.organization_id,v_actor,case when p_decision='approved' then 'timesheet_approved' else 'timesheet_rejected' end,'timesheets',v_sheet.id,jsonb_build_object('staff_id',v_sheet.staff_id,'period_start',v_sheet.period_start,'period_end',v_sheet.period_end,'actual_hours',v_sheet.actual_hours,'overtime_hours',v_sheet.overtime_hours,'review_notes',v_notes));
  select coalesce(sp.user_id,sp.id) into v_officer_user_id from public.staff_profiles sp where sp.id=v_sheet.staff_id;
  if v_officer_user_id is not null then perform public.enqueue_notification(p_organization_id=>v_sheet.organization_id,p_category=>'timesheet_decision',p_title=>'Timesheet '||v_sheet.status,p_body=>coalesce(v_notes,'Your timesheet has been '||v_sheet.status||'.'),p_severity=>'info',p_recipient_user_id=>v_officer_user_id,p_link_page=>'timesheet-decision',p_link_payload=>jsonb_build_object('timesheet_id',v_sheet.id,'status',v_sheet.status),p_dedup_key=>'timesheet_decision:'||v_sheet.id::text||':'||v_sheet.status);end if;
  return v_sheet;
end;$$;
revoke all on function public.review_timesheet(uuid,text,text,text) from public,anon;
grant execute on function public.review_timesheet(uuid,text,text,text) to authenticated,service_role;