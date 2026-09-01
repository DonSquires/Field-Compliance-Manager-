alter table public.notifications drop constraint if exists notifications_category_check;
alter table public.notifications add constraint notifications_category_check check(category in('credential_expiry','sla_breach','report_ready','report_reviewed','welfare','dispatch','roster','open_job','system','schema_change_request','bob_conversation','bob_self_memory'));

create or replace function public.review_officer_field_report(p_report_id uuid,p_expected_status public.report_status,p_review_notes text)
returns public.officer_field_reports language plpgsql volatile security definer set search_path=public as $$
declare v_actor_id uuid:=auth.uid();v_report public.officer_field_reports%rowtype;
begin
  if v_actor_id is null then raise exception 'Authentication required';end if;
  if nullif(trim(p_review_notes),'') is null then raise exception 'Review notes are required';end if;
  select * into v_report from public.officer_field_reports where id=p_report_id for update;if not found then raise exception 'Field report not found';end if;
  if not public.is_admin_for_org(v_report.organization_id) then raise exception 'Not authorised to review this field report';end if;
  if v_report.status<>p_expected_status then raise exception 'Field report changed from expected status % to %',p_expected_status,v_report.status;end if;
  if v_report.status<>'submitted' then raise exception 'Only submitted field reports can be reviewed';end if;
  update public.officer_field_reports set status='reviewed',reviewed_by=v_actor_id,reviewed_at=clock_timestamp(),review_notes=trim(p_review_notes),updated_at=clock_timestamp() where id=p_report_id returning * into v_report;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_report.organization_id,v_actor_id,'officer_field_report_reviewed','officer_field_reports',v_report.id,jsonb_build_object('officer_id',v_report.officer_id,'severity',v_report.severity,'review_notes',v_report.review_notes));
  perform public.enqueue_notification(p_organization_id=>v_report.organization_id,p_category=>'report_reviewed',p_title=>'Field report reviewed',p_body=>v_report.review_notes,p_severity=>'info',p_recipient_user_id=>v_report.officer_id,p_link_page=>'field-report-review',p_link_payload=>jsonb_build_object('report_id',v_report.id),p_dedup_key=>'field-report-reviewed:'||v_report.id::text);
  return v_report;
end;$$;
revoke all on function public.review_officer_field_report(uuid,public.report_status,text) from public,anon;
grant execute on function public.review_officer_field_report(uuid,public.report_status,text) to authenticated,service_role;