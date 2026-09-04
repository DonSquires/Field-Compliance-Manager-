-- Self-owned welfare actions are atomic, retry-safe commands. The client cannot
-- choose a different officer or organization; both are derived from auth.uid().

ALTER TABLE public.welfare_checks ADD COLUMN IF NOT EXISTS client_request_id uuid;
ALTER TABLE public.welfare_alerts ADD COLUMN IF NOT EXISTS client_request_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS idx_welfare_checks_request ON public.welfare_checks(organization_id, officer_user_id, client_request_id) WHERE client_request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_welfare_alerts_request ON public.welfare_alerts(organization_id, officer_user_id, client_request_id) WHERE client_request_id IS NOT NULL;

DROP POLICY IF EXISTS welfare_checks_insert ON public.welfare_checks;
REVOKE INSERT, UPDATE, DELETE ON public.welfare_checks FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS ows_write ON public.officer_welfare_settings;
REVOKE INSERT, UPDATE, DELETE ON public.officer_welfare_settings FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS welfare_alerts_insert ON public.welfare_alerts;
REVOKE INSERT ON public.welfare_alerts FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.record_officer_welfare_checkin(
  p_client_request_id uuid,
  p_gps_lat double precision DEFAULT NULL,
  p_gps_lng double precision DEFAULT NULL,
  p_shift_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS TABLE(check_id uuid, checked_in_at timestamptz, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
declare v_actor uuid:=auth.uid();v_org uuid;v_check public.welfare_checks%rowtype;v_at timestamptz:=clock_timestamp();
begin
 if v_actor is null or p_client_request_id is null then raise exception 'Authentication and client_request_id are required';end if;
 select organization_id into v_org from public.user_profiles where id=v_actor and deactivated_at is null;if v_org is null then raise exception 'Active officer identity required';end if;
 if p_shift_id is not null and not exists(select 1 from public.shifts s where s.id=p_shift_id and s.organization_id=v_org and s.officer_user_id=v_actor and s.status='in_progress') then raise exception 'Check-in shift must be your active shift';end if;
 select * into v_check from public.welfare_checks where organization_id=v_org and officer_user_id=v_actor and client_request_id=p_client_request_id;if found then return query select v_check.id,v_check.checked_in_at,false;return;end if;
 insert into public.welfare_checks(organization_id,officer_user_id,shift_id,status,notes,gps_lat,gps_lng,checked_in_at,client_request_id) values(v_org,v_actor,p_shift_id,'ok',nullif(trim(coalesce(p_notes,'')),''),p_gps_lat,p_gps_lng,v_at,p_client_request_id) returning * into v_check;
 insert into public.officer_welfare_settings(organization_id,officer_user_id,last_checkin_at) values(v_org,v_actor,v_at) on conflict(officer_user_id,organization_id) do update set last_checkin_at=excluded.last_checkin_at;
 insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_org,v_actor,'officer_welfare_checkin','welfare_checks',v_check.id,jsonb_build_object('shift_id',p_shift_id,'client_request_id',p_client_request_id));
 return query select v_check.id,v_check.checked_in_at,true;
end;$$;
REVOKE ALL ON FUNCTION public.record_officer_welfare_checkin(uuid,double precision,double precision,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_officer_welfare_checkin(uuid,double precision,double precision,uuid,text) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.raise_officer_sos(
  p_client_request_id uuid,
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
 select organization_id into v_org from public.user_profiles where id=v_actor and deactivated_at is null;if v_org is null then raise exception 'Active officer identity required';end if;
 if p_shift_id is not null and not exists(select 1 from public.shifts s where s.id=p_shift_id and s.organization_id=v_org and s.officer_user_id=v_actor and s.status='in_progress') then raise exception 'SOS shift must be your active shift';end if;
 select * into v_alert from public.welfare_alerts where organization_id=v_org and officer_user_id=v_actor and client_request_id=p_client_request_id;if found then return query select v_alert.id,v_alert.triggered_at,false;return;end if;
 insert into public.welfare_alerts(organization_id,officer_user_id,shift_id,alert_type,status,triggered_at,last_activity_at,gps_lat,gps_lng,escalation_level,notes,client_request_id) values(v_org,v_actor,p_shift_id,'sos','pending',v_at,v_at,p_gps_lat,p_gps_lng,1,nullif(trim(coalesce(p_notes,'')),'SOS triggered by officer'),p_client_request_id) returning * into v_alert;
 perform public.enqueue_notification(v_org,'welfare','Officer SOS', 'An officer has triggered SOS. Open the welfare alert immediately.','critical',null,'admin','welfare-outcome',jsonb_build_object('welfare_alert_id',v_alert.id),'officer_sos:'||v_alert.id::text);
 insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_org,v_actor,'officer_sos_raised','welfare_alerts',v_alert.id,jsonb_build_object('shift_id',p_shift_id,'client_request_id',p_client_request_id));
 return query select v_alert.id,v_alert.triggered_at,true;
end;$$;
REVOKE ALL ON FUNCTION public.raise_officer_sos(uuid,double precision,double precision,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.raise_officer_sos(uuid,double precision,double precision,uuid,text) TO authenticated,service_role;
