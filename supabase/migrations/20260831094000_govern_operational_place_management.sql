alter table public.client_sites add column if not exists configuration_version integer not null default 1;
alter table public.location_zones add column if not exists configuration_version integer not null default 1;

create or replace function public.crm_actor_can_manage_location(p_location_id uuid) returns boolean
language sql stable security definer set search_path=public as $$
  select exists(
    select 1 from public.locations l join public.user_profiles u on u.id=auth.uid() and u.deactivated_at is null
    where l.id=p_location_id and public.is_admin_for_org(u.organization_id) and (
      l.organization_id=u.organization_id or exists(
        select 1 from public.service_agreements sa join public.service_agreement_locations sal on sal.service_agreement_id=sa.id and sal.status='active'
        left join public.client_sites s on s.id=sal.site_id left join public.location_zones z on z.id=sal.zone_id
        where sa.provider_organization_id=u.organization_id and sa.invitation_status='accepted' and sa.agreement_type='operational' and (s.location_id=l.id or z.location_id=l.id)
      )
    )
  );
$$;

create function public.manage_crm_site_profile(p_site_id uuid,p_expected_version integer,p_risk_level text,p_site_brief text,p_access_instructions text,p_hs_notes text,p_active boolean)
returns public.client_sites language plpgsql volatile security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_site public.client_sites%rowtype;v_provider uuid;
begin
  select organization_id into v_provider from public.user_profiles where id=v_actor and deactivated_at is null;
  select * into v_site from public.client_sites s where s.id=p_site_id for update;
  if not found or v_provider is null or not public.is_admin_for_org(v_provider) or not public.crm_actor_can_manage_account(v_site.client_organization_id) then raise exception 'Active CRM administrator required for this site';end if;
  if v_site.configuration_version<>p_expected_version then raise exception 'Site configuration changed since it was opened';end if;
  if p_risk_level is not null and p_risk_level not in('low','medium','high','critical') then raise exception 'Unsupported risk level';end if;
  update public.client_sites set risk_level=p_risk_level,site_brief=nullif(trim(coalesce(p_site_brief,'')),''),access_instructions=nullif(trim(coalesce(p_access_instructions,'')),''),hs_notes=nullif(trim(coalesce(p_hs_notes,'')),''),active=p_active,configuration_version=configuration_version+1 where id=v_site.id returning * into v_site;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_provider,v_actor,'crm_site_profile_updated','client_sites',v_site.id,jsonb_build_object('account_organization_id',v_site.client_organization_id,'configuration_version',v_site.configuration_version,'risk_level',v_site.risk_level,'active',v_site.active));
  return v_site;
end;$$;

create function public.manage_crm_zone(p_action text,p_zone_id uuid,p_location_id uuid,p_expected_version integer,p_name text,p_zone_type text,p_module_key text,p_rule_type text,p_is_active boolean,p_nightly_limit_consecutive integer,p_nightly_limit_monthly integer,p_scv_required boolean,p_enforcement_workflow_override text)
returns public.location_zones language plpgsql volatile security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_provider uuid;v_location public.locations%rowtype;v_zone public.location_zones%rowtype;
begin
  select organization_id into v_provider from public.user_profiles where id=v_actor and deactivated_at is null;
  if v_provider is null or not public.is_admin_for_org(v_provider) or not public.crm_actor_can_manage_location(p_location_id) then raise exception 'Active CRM administrator required for this location';end if;
  select * into v_location from public.locations l where l.id=p_location_id;
  if not found then raise exception 'Location not found';end if;
  if nullif(trim(coalesce(p_name,'')),'') is null then raise exception 'Zone name is required';end if;
  if p_zone_type not in('freedom_camping','parking','noise_control','biosecurity','trespass','access_control','general','patrol_route') then raise exception 'Unsupported zone type';end if;
  if p_rule_type not in('overnight_limited','day_visit_only','prohibited','restricted','unrestricted') then raise exception 'Unsupported zone rule';end if;
  if p_enforcement_workflow_override is not null and p_enforcement_workflow_override not in('admin_first','officer_direct','hybrid') then raise exception 'Unsupported enforcement workflow';end if;
  if not exists(select 1 from public.module_catalog m where m.module_key=p_module_key and m.active) then raise exception 'Select an active module';end if;
  if (p_nightly_limit_consecutive is not null and p_nightly_limit_consecutive<0) or (p_nightly_limit_monthly is not null and p_nightly_limit_monthly<0) then raise exception 'Night limits cannot be negative';end if;
  if p_action='create' then
    insert into public.location_zones(organization_id,location_id,name,zone_type,module_key,rule_type,is_active,nightly_limit_consecutive,nightly_limit_monthly,scv_required,enforcement_workflow_override,boundary_status,boundary_verification)
    values(v_location.organization_id,v_location.id,trim(p_name),p_zone_type,p_module_key,p_rule_type,coalesce(p_is_active,true),p_nightly_limit_consecutive,p_nightly_limit_monthly,coalesce(p_scv_required,false),nullif(p_enforcement_workflow_override,''),'provisional','unverified') returning * into v_zone;
  elsif p_action='update' then
    select * into v_zone from public.location_zones z where z.id=p_zone_id and z.location_id=p_location_id for update;
    if not found then raise exception 'Zone not found in this location';end if;if v_zone.configuration_version<>p_expected_version then raise exception 'Zone configuration changed since it was opened';end if;
    update public.location_zones set name=trim(p_name),zone_type=p_zone_type,module_key=p_module_key,rule_type=p_rule_type,is_active=p_is_active,nightly_limit_consecutive=p_nightly_limit_consecutive,nightly_limit_monthly=p_nightly_limit_monthly,scv_required=p_scv_required,enforcement_workflow_override=nullif(p_enforcement_workflow_override,''),configuration_version=configuration_version+1 where id=v_zone.id returning * into v_zone;
  else raise exception 'Unsupported zone action';end if;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_provider,v_actor,'crm_zone_'||p_action,'location_zones',v_zone.id,jsonb_build_object('location_id',v_location.id,'module_key',v_zone.module_key,'configuration_version',v_zone.configuration_version));return v_zone;
end;$$;

create function public.manage_crm_place_boundary(p_entity_type text,p_entity_id uuid,p_expected_version integer,p_geojson jsonb,p_source text,p_verify boolean default false)
returns jsonb language plpgsql volatile security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_provider uuid;v_site public.client_sites%rowtype;v_zone public.location_zones%rowtype;v_geometry geometry;v_version integer;v_verification text;
begin
  select organization_id into v_provider from public.user_profiles where id=v_actor and deactivated_at is null;if v_provider is null or not public.is_admin_for_org(v_provider) then raise exception 'Active CRM administrator required';end if;
  if p_entity_type='client_site' then
    select * into v_site from public.client_sites s where s.id=p_entity_id for update;if not found or not public.crm_actor_can_manage_account(v_site.client_organization_id) then raise exception 'Site not found or access denied';end if;if v_site.configuration_version<>p_expected_version then raise exception 'Site configuration changed since it was opened';end if;
    if p_verify then if v_site.boundary is null then raise exception 'Save a boundary before verification';end if;perform public.verify_boundary('client_site',v_site.id);update public.client_sites set configuration_version=configuration_version+1 where id=v_site.id returning configuration_version,boundary_verification into v_version,v_verification;
    else v_geometry:=st_makevalid(st_setsrid(st_geomfromgeojson(p_geojson::text),4326));if geometrytype(v_geometry)<>'POLYGON' then raise exception 'Site boundary must be a GeoJSON Polygon';end if;update public.client_sites set boundary=v_geometry,center_point=st_centroid(v_geometry),boundary_status='authoritative',boundary_verification='unverified',boundary_verified_by=null,boundary_verified_at=null,configuration_version=configuration_version+1 where id=v_site.id returning configuration_version,boundary_verification into v_version,v_verification;insert into public.geofence_boundary_history(entity_type,entity_id,boundary,boundary_source,verification_state,changed_by,changed_via,change_reason,version) values('client_site',v_site.id,v_geometry,coalesce(nullif(trim(p_source),''),'manual_geojson'),'unverified',v_actor,'admin_upload','Site boundary uploaded by administrator',public._gbh_next_version('client_site',v_site.id));end if;
  elsif p_entity_type='location_zone' then
    select * into v_zone from public.location_zones z where z.id=p_entity_id for update;if not found or not public.crm_actor_can_manage_location(v_zone.location_id) then raise exception 'Zone not found or access denied';end if;if v_zone.configuration_version<>p_expected_version then raise exception 'Zone configuration changed since it was opened';end if;
    if p_verify then if v_zone.boundary is null then raise exception 'Save a boundary before verification';end if;perform public.verify_boundary('location_zone',v_zone.id);update public.location_zones set configuration_version=configuration_version+1 where id=v_zone.id returning configuration_version,boundary_verification into v_version,v_verification;
    else v_geometry:=st_multi(st_makevalid(st_setsrid(st_geomfromgeojson(p_geojson::text),4326)));if geometrytype(v_geometry)<>'MULTIPOLYGON' then raise exception 'Zone boundary must be a GeoJSON Polygon or MultiPolygon';end if;update public.location_zones set boundary=v_geometry,center_point=st_centroid(v_geometry),boundary_status='authoritative',boundary_verification='unverified',boundary_verified_by=null,boundary_verified_at=null,configuration_version=configuration_version+1 where id=v_zone.id returning configuration_version,boundary_verification into v_version,v_verification;insert into public.geofence_boundary_history(entity_type,entity_id,boundary,boundary_source,verification_state,changed_by,changed_via,change_reason,version) values('location_zone',v_zone.id,v_geometry,coalesce(nullif(trim(p_source),''),'manual_geojson'),'unverified',v_actor,'admin_upload','Zone boundary uploaded by administrator',public._gbh_next_version('location_zone',v_zone.id));end if;
  else raise exception 'Unsupported boundary entity type';end if;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_provider,v_actor,case when p_verify then 'crm_place_boundary_verified' else 'crm_place_boundary_uploaded' end,case when p_entity_type='client_site' then 'client_sites' else 'location_zones' end,p_entity_id,jsonb_build_object('entity_type',p_entity_type,'configuration_version',v_version,'source',p_source));return jsonb_build_object('entity_type',p_entity_type,'entity_id',p_entity_id,'configuration_version',v_version,'boundary_verification',v_verification);
end;$$;

create function public.manage_crm_zone_closure(p_zone_id uuid,p_action text,p_closure_id uuid,p_closure_type text,p_effective_from date,p_effective_to date,p_reason text)
returns public.zone_closures language plpgsql volatile security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_provider uuid;v_zone public.location_zones%rowtype;v_closure public.zone_closures%rowtype;
begin select organization_id into v_provider from public.user_profiles where id=v_actor and deactivated_at is null;select * into v_zone from public.location_zones z where z.id=p_zone_id;if not found or v_provider is null or not public.is_admin_for_org(v_provider) or not public.crm_actor_can_manage_location(v_zone.location_id) then raise exception 'Active CRM administrator required for this zone';end if;
  if p_action='create' then if p_closure_type not in('prohibited','restricted','temporary_closure') then raise exception 'Unsupported closure type';end if;if p_effective_from is null or (p_effective_to is not null and p_effective_to<p_effective_from) then raise exception 'Valid closure dates are required';end if;if nullif(trim(coalesce(p_reason,'')),'') is null then raise exception 'Closure reason is required';end if;insert into public.zone_closures(organization_id,zone_id,closure_type,status,effective_from,effective_to,reason,created_by) values(v_zone.organization_id,v_zone.id,p_closure_type,case when p_effective_from<=current_date then 'active' else 'scheduled' end,p_effective_from,p_effective_to,trim(p_reason),v_actor) returning * into v_closure;
  elsif p_action='lift' then select * into v_closure from public.zone_closures c where c.id=p_closure_id and c.zone_id=v_zone.id for update;if not found then raise exception 'Closure not found';end if;update public.zone_closures set status='lifted',effective_to=coalesce(effective_to,current_date),resolution_notes=nullif(trim(coalesce(p_reason,'')),''),lifted_by=v_actor,lifted_at=clock_timestamp() where id=v_closure.id returning * into v_closure;else raise exception 'Unsupported closure action';end if;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_provider,v_actor,'crm_zone_closure_'||p_action,'zone_closures',v_closure.id,jsonb_build_object('zone_id',v_zone.id,'closure_type',v_closure.closure_type,'status',v_closure.status));return v_closure;
end;$$;

revoke all on function public.crm_actor_can_manage_location(uuid),public.manage_crm_site_profile(uuid,integer,text,text,text,text,boolean),public.manage_crm_zone(text,uuid,uuid,integer,text,text,text,text,boolean,integer,integer,boolean,text),public.manage_crm_place_boundary(text,uuid,integer,jsonb,text,boolean),public.manage_crm_zone_closure(uuid,text,uuid,text,date,date,text) from public,anon,authenticated;
grant execute on function public.manage_crm_site_profile(uuid,integer,text,text,text,text,boolean),public.manage_crm_zone(text,uuid,uuid,integer,text,text,text,text,boolean,integer,integer,boolean,text),public.manage_crm_place_boundary(text,uuid,integer,jsonb,text,boolean),public.manage_crm_zone_closure(uuid,text,uuid,text,date,date,text) to authenticated,service_role;
grant execute on function public.crm_actor_can_manage_location(uuid) to service_role;