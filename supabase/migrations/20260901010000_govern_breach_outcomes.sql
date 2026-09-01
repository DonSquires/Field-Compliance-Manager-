alter table public.notifications drop constraint if exists notifications_category_check;
alter table public.notifications add constraint notifications_category_check check(category in('credential_expiry','sla_breach','report_ready','report_reviewed','leave_decision','timesheet_decision','breach_decision','welfare','dispatch','roster','open_job','system','schema_change_request','bob_conversation','bob_self_memory'));

revoke update,delete on table public.breach_alerts from authenticated;

create function public.manage_breach_alert(p_alert_id uuid,p_expected_status text,p_action text,p_notes text)
returns table(alert_id uuid,alert_status text,action_type text,actioned_at timestamptz,source_officer_id uuid) language plpgsql security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_alert public.breach_alerts%rowtype;v_officer uuid;v_next_status text;v_action_type text;v_notes text:=nullif(trim(coalesce(p_notes,'')),'');
begin
  select b.* into v_alert from public.breach_alerts b where b.id=p_alert_id for update;if not found then raise exception 'Breach alert not found';end if;
  if not public.is_admin_for_org(v_alert.organization_id) then raise exception 'Active compliance administrator required';end if;
  if v_alert.status<>p_expected_status then raise exception 'Breach alert changed from expected status % to %',p_expected_status,v_alert.status;end if;
  if v_notes is null then raise exception 'Breach decision notes are required';end if;
  if v_alert.status='open' and p_action in('verbal_warning','written_warning','notice_to_vacate','infringement','tow_request','welfare_referral') then v_next_status:='actioned';v_action_type:=p_action;
  elsif v_alert.status='open' and p_action='dismissed' then v_next_status:='dismissed';v_action_type:='dismissed';
  elsif v_alert.status='actioned' and p_action in('resolved','exempt_homeless') then v_next_status:=p_action;v_action_type:=v_alert.action_type;
  else raise exception 'Unsupported breach transition from % using %',v_alert.status,p_action;end if;
  update public.breach_alerts set status=v_next_status,action_type=v_action_type,actioned_by=v_actor,actioned_at=clock_timestamp(),notes=concat_ws(E'\n',nullif(notes,''),'Decision: '||v_notes) where id=v_alert.id returning * into v_alert;
  select o.officer_id into v_officer from public.observations o where o.id=v_alert.observation_id;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_alert.organization_id,v_actor,'breach_alert_managed','breach_alerts',v_alert.id,jsonb_build_object('previous_status',p_expected_status,'status',v_alert.status,'action',p_action,'source_officer_id',v_officer,'notes',v_notes));
  if v_officer is not null then perform public.enqueue_notification(p_organization_id=>v_alert.organization_id,p_category=>'breach_decision',p_title=>'Breach review updated',p_body=>v_notes,p_severity=>'info',p_recipient_user_id=>v_officer,p_link_page=>'breach-decision',p_link_payload=>jsonb_build_object('breach_alert_id',v_alert.id),p_dedup_key=>'breach_decision:'||v_alert.id::text||':'||v_alert.status);end if;
  return query select v_alert.id,v_alert.status,v_alert.action_type,v_alert.actioned_at,v_officer;
end;$$;
revoke all on function public.manage_breach_alert(uuid,text,text,text) from public,anon;
grant execute on function public.manage_breach_alert(uuid,text,text,text) to authenticated,service_role;
