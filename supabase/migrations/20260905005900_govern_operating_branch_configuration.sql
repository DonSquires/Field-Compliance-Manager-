CREATE OR REPLACE FUNCTION public.update_operating_branch_profile(p_operating_organization_id uuid,p_expected_updated_at timestamptz,p_contact_email text,p_contact_phone text,p_billing_email text,p_billing_address text,p_enforcement_workflow_mode text)
RETURNS public.organizations LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
declare v_actor uuid:=auth.uid();v_branch public.organizations%rowtype;
begin
  if not public.user_can_operate_organization(p_operating_organization_id) or not public.is_admin_for_org(p_operating_organization_id) then raise exception 'Active authorized operating branch administrator required';end if;
  select * into v_branch from public.organizations where id=p_operating_organization_id and organization_type='branch' and active for update;if not found then raise exception 'Active delivery branch not found';end if;
  if v_branch.updated_at<>p_expected_updated_at then raise exception 'Organization changed since it was opened';end if;if p_enforcement_workflow_mode not in('admin_first','officer_direct','hybrid') then raise exception 'Unsupported enforcement workflow mode';end if;
  update public.organizations set contact_email=nullif(lower(trim(coalesce(p_contact_email,''))),''),contact_phone=nullif(trim(coalesce(p_contact_phone,'')),''),billing_email=nullif(lower(trim(coalesce(p_billing_email,''))),''),billing_address=nullif(trim(coalesce(p_billing_address,'')),''),enforcement_workflow_mode=p_enforcement_workflow_mode,updated_at=clock_timestamp() where id=v_branch.id returning * into v_branch;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)values(v_branch.id,v_actor,'operating_branch_profile_updated','organizations',v_branch.id,jsonb_build_object('enforcement_workflow_mode',v_branch.enforcement_workflow_mode,'billing_configured',v_branch.billing_email is not null));return v_branch;
end;$$;

CREATE OR REPLACE FUNCTION public.set_operating_branch_module(p_operating_organization_id uuid,p_module_key text,p_enabled boolean)
RETURNS public.organization_modules LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
declare v_actor uuid:=auth.uid();v_module public.organization_modules%rowtype;
begin
  if not public.user_can_operate_organization(p_operating_organization_id) or not public.is_admin_for_org(p_operating_organization_id) then raise exception 'Active authorized operating branch administrator required';end if;
  if not exists(select 1 from public.organizations branch where branch.id=p_operating_organization_id and branch.organization_type='branch' and branch.active) then raise exception 'Active delivery branch not found';end if;
  if not exists(select 1 from public.module_catalog module where module.module_key=p_module_key and module.active) then raise exception 'Active platform module required';end if;
  insert into public.organization_modules(organization_id,module_key,enabled)values(p_operating_organization_id,p_module_key,p_enabled) on conflict(organization_id,module_key) do update set enabled=excluded.enabled returning * into v_module;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)values(p_operating_organization_id,v_actor,'operating_branch_module_set','organization_modules',v_module.id,jsonb_build_object('module_key',v_module.module_key,'enabled',v_module.enabled));return v_module;
end;$$;

CREATE OR REPLACE FUNCTION public.manage_operating_branch_geofence_config(p_operating_organization_id uuid,p_action text,p_config_id uuid DEFAULT NULL,p_config_key text DEFAULT NULL,p_zone_type text DEFAULT NULL,p_config_value integer DEFAULT NULL)
RETURNS public.org_geofence_config LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
declare v_actor uuid:=auth.uid();v_config public.org_geofence_config%rowtype;v_key text:=nullif(trim(coalesce(p_config_key,'')), '');v_zone text:=nullif(trim(coalesce(p_zone_type,'')), '');
begin
  if not public.user_can_operate_organization(p_operating_organization_id) or not public.is_admin_for_org(p_operating_organization_id) then raise exception 'Active authorized operating branch administrator required';end if;
  if p_action not in('set','remove') then raise exception 'Unsupported geofence configuration action';end if;
  if p_action='remove' then select * into v_config from public.org_geofence_config where id=p_config_id and organization_id=p_operating_organization_id for update;if not found then raise exception 'Branch geofence override not found';end if;delete from public.org_geofence_config where id=v_config.id;else
    if v_key not in('site_provisional_radius_m','zone_provisional_radius_m','checkpoint_radius_m') or p_config_value is null or p_config_value<0 or p_config_value>10000 then raise exception 'Valid geofence configuration key and value required';end if;
    select * into v_config from public.org_geofence_config where organization_id=p_operating_organization_id and config_key=v_key and zone_type is not distinct from v_zone for update;
    if found then update public.org_geofence_config set config_value=p_config_value,updated_at=clock_timestamp() where id=v_config.id returning * into v_config;else insert into public.org_geofence_config(organization_id,config_key,zone_type,config_value)values(p_operating_organization_id,v_key,v_zone,p_config_value)returning * into v_config;end if;
  end if;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)values(p_operating_organization_id,v_actor,'operating_branch_geofence_config_'||p_action,'org_geofence_config',v_config.id,jsonb_build_object('config_key',v_config.config_key,'zone_type',v_config.zone_type,'config_value',v_config.config_value));return v_config;
end;$$;

REVOKE ALL ON FUNCTION public.update_operating_branch_profile(uuid,timestamptz,text,text,text,text,text),public.set_operating_branch_module(uuid,text,boolean),public.manage_operating_branch_geofence_config(uuid,text,uuid,text,text,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.update_operating_branch_profile(uuid,timestamptz,text,text,text,text,text),public.set_operating_branch_module(uuid,text,boolean),public.manage_operating_branch_geofence_config(uuid,text,uuid,text,text,integer) TO authenticated,service_role;