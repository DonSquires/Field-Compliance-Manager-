create function public.get_crm_agreement_setup(p_agreement_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_agreement public.service_agreements%rowtype;
begin
  select sa.* into v_agreement from public.service_agreements sa where sa.id=p_agreement_id;
  if not found then raise exception 'Service agreement not found';end if;
  if v_actor is null or not public.is_admin_for_org(v_agreement.provider_organization_id) then raise exception 'Provider administrator required';end if;
  return jsonb_build_object(
    'agreement',jsonb_build_object('id',v_agreement.id,'name',v_agreement.name,'client_organization_id',v_agreement.client_organization_id,'invitation_status',v_agreement.invitation_status,'enabled_modules',v_agreement.enabled_modules),
    'sites',(select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'address',s.address,'boundary_status',s.boundary_status,'boundary_verification',s.boundary_verification,'linked',sal.id is not null,'link_status',sal.status) order by s.name),'[]'::jsonb) from public.client_sites s left join public.service_agreement_locations sal on sal.service_agreement_id=v_agreement.id and sal.site_id=s.id where s.client_organization_id=v_agreement.client_organization_id and s.active),
    'modules',(select coalesce(jsonb_agg(jsonb_build_object('module_key',mc.module_key,'enabled',coalesce(sam.enabled,false),'sla_minutes',sam.sla_minutes,'allows_client_submission',coalesce(sam.allows_client_submission,false),'allows_auto_dispatch',coalesce(sam.allows_auto_dispatch,false)) order by mc.module_key),'[]'::jsonb) from public.module_catalog mc left join public.service_agreement_modules sam on sam.service_agreement_id=v_agreement.id and sam.module_key=mc.module_key where mc.active)
  );
end;$$;

create function public.manage_crm_agreement_setup(p_agreement_id uuid,p_expected_invitation_status text,p_action text,p_site_id uuid default null,p_module_key text default null,p_enabled boolean default true,p_sla_minutes integer default null,p_allows_client_submission boolean default false,p_allows_auto_dispatch boolean default false)
returns jsonb language plpgsql volatile security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_agreement public.service_agreements%rowtype;v_link public.service_agreement_locations%rowtype;v_module public.service_agreement_modules%rowtype;
begin
  select sa.* into v_agreement from public.service_agreements sa where sa.id=p_agreement_id for update;
  if not found then raise exception 'Service agreement not found';end if;
  if v_actor is null or not public.is_admin_for_org(v_agreement.provider_organization_id) then raise exception 'Provider administrator required';end if;
  if v_agreement.agreement_type<>'operational' or v_agreement.invitation_status<>'accepted' then raise exception 'Only accepted operational agreements can be configured';end if;
  if v_agreement.invitation_status is distinct from p_expected_invitation_status then raise exception 'Service agreement changed since it was opened';end if;
  if p_action in('link_site','unlink_site') then
    if p_site_id is null or not exists(select 1 from public.client_sites s where s.id=p_site_id and s.client_organization_id=v_agreement.client_organization_id and s.active) then raise exception 'Active client site required';end if;
    if p_action='link_site' then
      insert into public.service_agreement_locations(service_agreement_id,site_id,status,created_by) values(v_agreement.id,p_site_id,'active',v_actor)
      on conflict(service_agreement_id,site_id) do update set status='active',updated_at=clock_timestamp() returning * into v_link;
    else
      update public.service_agreement_locations set status='ended',updated_at=clock_timestamp() where service_agreement_id=v_agreement.id and site_id=p_site_id returning * into v_link;
      if not found then raise exception 'Covered site link not found';end if;
    end if;
  elsif p_action='set_module' then
    if p_module_key is null or not exists(select 1 from public.module_catalog mc where mc.module_key=p_module_key and mc.active) then raise exception 'Active module catalog entry required';end if;
    if p_sla_minutes is not null and (p_sla_minutes<1 or p_sla_minutes>10080) then raise exception 'Module SLA must be between 1 and 10080 minutes';end if;
    insert into public.service_agreement_modules(service_agreement_id,module_key,enabled,sla_minutes,allows_client_submission,allows_auto_dispatch)
    values(v_agreement.id,p_module_key,coalesce(p_enabled,true),p_sla_minutes,p_allows_client_submission,p_allows_auto_dispatch)
    on conflict(service_agreement_id,module_key) do update set enabled=excluded.enabled,sla_minutes=excluded.sla_minutes,allows_client_submission=excluded.allows_client_submission,allows_auto_dispatch=excluded.allows_auto_dispatch returning * into v_module;
    update public.service_agreements set enabled_modules=coalesce((select array_agg(sam.module_key order by sam.module_key) from public.service_agreement_modules sam where sam.service_agreement_id=v_agreement.id and sam.enabled),'{}'::text[]) where id=v_agreement.id returning * into v_agreement;
  else raise exception 'Unsupported agreement setup action';end if;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  values(v_agreement.provider_organization_id,v_actor,'crm_agreement_'||p_action,'service_agreements',v_agreement.id,jsonb_build_object('site_id',p_site_id,'module_key',p_module_key,'enabled',p_enabled,'sla_minutes',p_sla_minutes));
  return jsonb_build_object('agreement_id',v_agreement.id,'action',p_action,'site_link_id',v_link.id,'module_id',v_module.id,'enabled_modules',v_agreement.enabled_modules);
end;$$;

revoke insert,update,delete,truncate on public.service_agreement_locations from public,anon,authenticated;
revoke insert,update,delete,truncate on public.service_agreement_modules from public,anon,authenticated;
revoke all on function public.get_crm_agreement_setup(uuid) from public,anon,authenticated;
revoke all on function public.manage_crm_agreement_setup(uuid,text,text,uuid,text,boolean,integer,boolean,boolean) from public,anon,authenticated;
grant execute on function public.get_crm_agreement_setup(uuid),public.manage_crm_agreement_setup(uuid,text,text,uuid,text,boolean,integer,boolean,boolean) to authenticated,service_role;