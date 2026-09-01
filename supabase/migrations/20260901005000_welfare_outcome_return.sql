create or replace function public.manage_welfare_alert(p_alert_id uuid,p_expected_status text,p_action text,p_notes text)
returns table(alert_id uuid,alert_status text,acted_at timestamptz) language plpgsql volatile security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_alert public.welfare_alerts%rowtype;v_notes text:=nullif(trim(coalesce(p_notes,'')),'');v_is_admin boolean;v_now timestamptz:=clock_timestamp();
begin
  if v_actor is null then raise exception 'Authentication required';end if;if v_notes is null then raise exception 'Welfare action notes are required';end if;
  select a.* into v_alert from public.welfare_alerts a where a.id=p_alert_id for update;if not found then raise exception 'Welfare alert not found';end if;
  v_is_admin:=public.is_admin_for_org(v_alert.organization_id);
  if p_action='acknowledge' then
    if not v_is_admin then raise exception 'Only an authorized supervisor can acknowledge this alert';end if;if v_alert.status<>p_expected_status or v_alert.status<>'pending' then raise exception 'Welfare alert changed from expected status % to %',p_expected_status,v_alert.status;end if;
    update public.welfare_alerts a set status='acknowledged',acknowledged_by=v_actor,acknowledged_at=v_now,acknowledgement_notes=v_notes where a.id=v_alert.id returning a.* into v_alert;
  elsif p_action='resolve' then
    if not v_is_admin and v_alert.officer_user_id<>v_actor then raise exception 'Not authorized to resolve this welfare alert';end if;if v_alert.status<>p_expected_status or v_alert.status not in('pending','acknowledged') then raise exception 'Welfare alert changed from expected status % to %',p_expected_status,v_alert.status;end if;
    update public.welfare_alerts a set status='resolved',resolved_by=v_actor,resolved_at=v_now,resolution_notes=v_notes where a.id=v_alert.id returning a.* into v_alert;
  else raise exception 'Unsupported welfare alert action';end if;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_alert.organization_id,v_actor,case when p_action='acknowledge' then 'welfare_alert_acknowledged' when v_is_admin then 'welfare_alert_resolved_by_supervisor' else 'welfare_alert_resolved_by_officer' end,'welfare_alerts',v_alert.id,jsonb_build_object('officer_user_id',v_alert.officer_user_id,'alert_type',v_alert.alert_type,'previous_status',p_expected_status,'status',v_alert.status,'notes',v_notes));
  perform public.enqueue_notification(p_organization_id=>v_alert.organization_id,p_category=>'welfare',p_title=>case when v_alert.status='acknowledged' then 'Welfare response acknowledged' else 'Welfare alert resolved' end,p_body=>v_notes,p_severity=>case when v_alert.status='resolved' then 'info' else 'warning' end,p_recipient_user_id=>v_alert.officer_user_id,p_link_page=>'welfare-outcome',p_link_payload=>jsonb_build_object('welfare_alert_id',v_alert.id,'status',v_alert.status),p_dedup_key=>'welfare_alert_outcome:'||v_alert.id::text||':'||v_alert.status);
  return query select v_alert.id,v_alert.status,v_now;
end;$$;
revoke all on function public.manage_welfare_alert(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.manage_welfare_alert(uuid,text,text,text) to authenticated,service_role;