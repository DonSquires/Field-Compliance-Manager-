CREATE OR REPLACE FUNCTION public.raise_officer_welfare_alert(
  p_client_request_id uuid,
  p_alert_type text,
  p_gps_lat double precision DEFAULT NULL,
  p_gps_lng double precision DEFAULT NULL,
  p_shift_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS TABLE(alert_id uuid, triggered_at timestamptz, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
declare v_actor uuid:=auth.uid();v_org uuid;v_alert public.welfare_alerts%rowtype;v_at timestamptz:=clock_timestamp();
begin
 if v_actor is null or p_client_request_id is null then raise exception 'Authentication and client_request_id are required';end if;
 if p_alert_type not in ('sos','man_down','inactivity','gps_lost','missed') then raise exception 'Unsupported officer welfare alert type';end if;
 select organization_id into v_org from public.user_profiles where id=v_actor and deactivated_at is null;if v_org is null then raise exception 'Active officer identity required';end if;
 if p_shift_id is not null and not exists(select 1 from public.shifts s where s.id=p_shift_id and s.organization_id=v_org and s.officer_user_id=v_actor and s.status='in_progress') then raise exception 'Welfare alert shift must be your active shift';end if;
 select * into v_alert from public.welfare_alerts where organization_id=v_org and officer_user_id=v_actor and client_request_id=p_client_request_id;if found then return query select v_alert.id,v_alert.triggered_at,false;return;end if;
 insert into public.welfare_alerts(organization_id,officer_user_id,shift_id,alert_type,status,triggered_at,last_activity_at,gps_lat,gps_lng,escalation_level,notes,client_request_id)
 values(v_org,v_actor,p_shift_id,p_alert_type,'pending',v_at,v_at,p_gps_lat,p_gps_lng,1,nullif(trim(coalesce(p_notes,'')),''),p_client_request_id) returning * into v_alert;
 perform public.enqueue_notification(v_org,'welfare',case when p_alert_type='sos' then 'Officer SOS' else 'Officer welfare alert' end,case when p_alert_type='sos' then 'An officer has triggered SOS. Open the welfare alert immediately.' else 'An officer welfare alert requires review.' end,case when p_alert_type='sos' then 'critical' else 'warning' end,null,'admin','welfare-outcome',jsonb_build_object('welfare_alert_id',v_alert.id),'officer_welfare_alert:'||v_alert.id::text);
 insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_org,v_actor,'officer_welfare_alert_raised','welfare_alerts',v_alert.id,jsonb_build_object('alert_type',p_alert_type,'shift_id',p_shift_id,'client_request_id',p_client_request_id));
 return query select v_alert.id,v_alert.triggered_at,true;
end;$$;
REVOKE ALL ON FUNCTION public.raise_officer_welfare_alert(uuid,text,double precision,double precision,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.raise_officer_welfare_alert(uuid,text,double precision,double precision,uuid,text) TO authenticated,service_role;
