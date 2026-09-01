drop function if exists public.submit_officer_field_report(uuid,timestamptz,public.report_type,public.report_severity,text,text,text,text,double precision,double precision,uuid,text,boolean,text);

create function public.submit_officer_field_report(p_client_event_id uuid,p_reported_at timestamptz,p_report_type public.report_type,p_severity public.report_severity,p_title text,p_description text,p_location_name text default null,p_address text default null,p_gps_lat double precision default null,p_gps_lng double precision default null,p_shift_id uuid default null,p_immediate_action text default null,p_follow_up_required boolean default false,p_follow_up_notes text default null) returns table(id uuid,created boolean,received_at timestamptz,shift_id uuid)
language plpgsql security definer set search_path=public as $$
declare v_user_id uuid:=auth.uid();v_org_id uuid;v_existing public.officer_field_reports%rowtype;v_report public.officer_field_reports%rowtype;
begin
  if v_user_id is null then raise exception 'Authentication required';end if;
  select p.organization_id into v_org_id from public.user_profiles p where p.id=v_user_id and p.deactivated_at is null and p.role in('officer','admin_officer');
  if v_org_id is null then raise exception 'Active officer profile required';end if;
  if p_client_event_id is null then raise exception 'client_event_id is required';end if;
  if p_reported_at is null or p_reported_at>now()+interval '5 minutes' or p_reported_at<now()-interval '24 hours' then raise exception 'reported_at is outside the accepted capture window';end if;
  if char_length(trim(coalesce(p_title,''))) not between 5 and 200 then raise exception 'Title must be between 5 and 200 characters';end if;
  if char_length(trim(coalesce(p_description,''))) not between 10 and 10000 then raise exception 'Description must be between 10 and 10000 characters';end if;
  if (p_gps_lat is null)<>(p_gps_lng is null) then raise exception 'Both GPS coordinates are required together';end if;
  if p_gps_lat is not null and(p_gps_lat not between -90 and 90 or p_gps_lng not between -180 and 180) then raise exception 'Invalid GPS coordinates';end if;
  if p_follow_up_required and nullif(trim(coalesce(p_follow_up_notes,'')),'') is null then raise exception 'Follow-up notes are required';end if;
  if p_shift_id is not null and not exists(select 1 from public.shifts s where s.id=p_shift_id and s.organization_id=v_org_id and s.officer_user_id=v_user_id) then raise exception 'Shift does not belong to the authenticated officer';end if;
  select r.* into v_existing from public.officer_field_reports r where r.organization_id=v_org_id and r.officer_id=v_user_id and r.client_event_id=p_client_event_id;
  if found then return query select v_existing.id,false,v_existing.created_at,v_existing.shift_id;return;end if;
  insert into public.officer_field_reports(organization_id,officer_id,client_event_id,reported_at,report_type,severity,status,title,description,location_name,address,gps_lat,gps_lng,shift_id,immediate_action,follow_up_required,follow_up_notes)
  values(v_org_id,v_user_id,p_client_event_id,p_reported_at,p_report_type,p_severity,'submitted',trim(p_title),trim(p_description),nullif(trim(coalesce(p_location_name,'')),''),nullif(trim(coalesce(p_address,'')),''),p_gps_lat,p_gps_lng,p_shift_id,nullif(trim(coalesce(p_immediate_action,'')),''),coalesce(p_follow_up_required,false),nullif(trim(coalesce(p_follow_up_notes,'')),'')) returning * into v_report;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_org_id,v_user_id,'officer_field_report_submitted','officer_field_reports',v_report.id,jsonb_build_object('report_type',v_report.report_type,'severity',v_report.severity,'shift_id',v_report.shift_id,'follow_up_required',v_report.follow_up_required));
  return query select v_report.id,true,v_report.created_at,v_report.shift_id;
end;
$$;
comment on function public.submit_officer_field_report(uuid,timestamptz,public.report_type,public.report_severity,text,text,text,text,double precision,double precision,uuid,text,boolean,text) is 'Creates a retry-safe officer field report and returns its verified shift linkage in the receipt.';
revoke all on function public.submit_officer_field_report(uuid,timestamptz,public.report_type,public.report_severity,text,text,text,text,double precision,double precision,uuid,text,boolean,text) from public,anon;
grant execute on function public.submit_officer_field_report(uuid,timestamptz,public.report_type,public.report_severity,text,text,text,text,double precision,double precision,uuid,text,boolean,text) to authenticated,service_role;