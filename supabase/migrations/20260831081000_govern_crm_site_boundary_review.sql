create function public.get_crm_site_boundary_queue()
returns table(site_id uuid,account_organization_id uuid,account_name text,site_name text,address text,site_type text,active boolean,gps_lat double precision,gps_lng double precision,boundary_status text,boundary_verification text,boundary_verified_at timestamptz,has_boundary boolean)
language plpgsql stable security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_provider uuid;
begin
  select organization_id into v_provider from public.user_profiles where id=v_actor and deactivated_at is null;
  if v_provider is null or not public.is_admin_for_org(v_provider) then raise exception 'Active CRM administrator required';end if;
  return query select s.id,o.id,o.name,s.name,s.address,s.site_type,s.active,s.gps_lat,s.gps_lng,s.boundary_status,s.boundary_verification,s.boundary_verified_at,(s.boundary is not null)
  from public.client_sites s join public.organizations o on o.id=s.client_organization_id
  where public.crm_actor_can_manage_account(o.id)
  order by case when s.boundary_verification='unverified' then 0 else 1 end,case when s.boundary_status='provisional' then 0 else 1 end,o.name,s.name;
end;$$;

create function public.manage_crm_site_boundary(p_site_id uuid,p_action text,p_expected_verification text,p_center_lat double precision default null,p_center_lng double precision default null,p_radius_m double precision default 50)
returns table(site_id uuid,boundary_status text,boundary_verification text,gps_lat double precision,gps_lng double precision,boundary_verified_at timestamptz,area_m2 numeric)
language plpgsql volatile security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_provider uuid;v_site public.client_sites%rowtype;v_area numeric:=null;
begin
  select organization_id into v_provider from public.user_profiles where id=v_actor and deactivated_at is null;
  if v_provider is null or not public.is_admin_for_org(v_provider) then raise exception 'Active CRM administrator required';end if;
  select s.* into v_site from public.client_sites s where s.id=p_site_id for update;
  if not found then raise exception 'Site not found';end if;
  if not public.crm_actor_can_manage_account(v_site.client_organization_id) then raise exception 'Not authorised to review this site boundary';end if;
  if v_site.boundary_verification is distinct from p_expected_verification then raise exception 'Site boundary changed since it was opened';end if;
  if p_action='set_provisional' then
    if p_center_lat is null or p_center_lat not between -90 and 90 or p_center_lng is null or p_center_lng not between -180 and 180 then raise exception 'Valid latitude and longitude are required';end if;
    if p_radius_m is null or p_radius_m<5 or p_radius_m>5000 then raise exception 'Boundary radius must be between 5 and 5000 metres';end if;
    v_area:=public.set_site_geometry(v_site.id,null,p_center_lat,p_center_lng,p_radius_m,'point_radius',v_actor,'direct_edit');
    update public.client_sites set gps_lat=p_center_lat,gps_lng=p_center_lng,boundary_status='provisional',boundary_verification='unverified',boundary_verified_by=null,boundary_verified_at=null where id=v_site.id returning * into v_site;
  elsif p_action='verify' then
    if v_site.boundary is null then raise exception 'A boundary must be established before verification';end if;
    if not public.verify_boundary('client_site',v_site.id) then raise exception 'Boundary verification failed';end if;
    select s.* into v_site from public.client_sites s where s.id=p_site_id;
  else raise exception 'Unsupported site boundary action';end if;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  values(v_provider,v_actor,'crm_site_boundary_'||p_action,'client_sites',v_site.id,jsonb_build_object('account_organization_id',v_site.client_organization_id,'boundary_status',v_site.boundary_status,'boundary_verification',v_site.boundary_verification,'gps_lat',v_site.gps_lat,'gps_lng',v_site.gps_lng,'area_m2',v_area));
  return query select v_site.id,v_site.boundary_status,v_site.boundary_verification,v_site.gps_lat,v_site.gps_lng,v_site.boundary_verified_at,v_area;
end;$$;

revoke all on function public.get_crm_site_boundary_queue() from public,anon,authenticated;
revoke all on function public.manage_crm_site_boundary(uuid,text,text,double precision,double precision,double precision) from public,anon,authenticated;
grant execute on function public.get_crm_site_boundary_queue(),public.manage_crm_site_boundary(uuid,text,text,double precision,double precision,double precision) to authenticated,service_role;

revoke all on function public.set_site_geometry(uuid,jsonb,double precision,double precision,double precision,text,uuid,text) from public,anon,authenticated;
grant execute on function public.set_site_geometry(uuid,jsonb,double precision,double precision,double precision,text,uuid,text) to service_role;