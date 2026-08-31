alter table public.organizations add column if not exists client_request_id uuid;
alter table public.organizations add column if not exists updated_at timestamptz not null default now();
create unique index if not exists idx_organizations_parent_client_request on public.organizations(parent_organization_id,client_request_id) where client_request_id is not null;
create index if not exists idx_organizations_parent_normalized_name on public.organizations(parent_organization_id,lower(trim(name)));

create function public.find_crm_organization_candidates(p_query text,p_nzbn text default null)
returns table(id uuid,name text,organization_type text,status text,nzbn text,parent_organization_id uuid,match_reason text,manageable boolean)
language plpgsql stable security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_provider uuid;v_query text:=lower(trim(coalesce(p_query,'')));v_nzbn text:=nullif(regexp_replace(coalesce(p_nzbn,''),'[^0-9]','','g'),'');
begin
  select actor.organization_id into v_provider from public.user_profiles actor where actor.id=v_actor and actor.deactivated_at is null;
  if v_provider is null or not public.is_admin_for_org(v_provider) then raise exception 'Active CRM administrator required';end if;
  if char_length(v_query)<2 and v_nzbn is null then raise exception 'Enter at least two name characters or an NZBN';end if;
  return query select o.id,o.name,o.organization_type,o.status,o.nzbn,o.parent_organization_id,
    case when v_nzbn is not null and regexp_replace(coalesce(o.nzbn,''),'[^0-9]','','g')=v_nzbn then 'Exact NZBN' when lower(trim(o.name))=v_query then 'Exact name' else 'Similar name' end,
    (o.id=v_provider or o.parent_organization_id=v_provider or public.crm_actor_can_manage_account(o.id))
  from public.organizations o
  where (o.id=v_provider or o.parent_organization_id=v_provider or public.crm_actor_can_manage_account(o.id) or o.discoverable)
    and ((char_length(v_query)>=2 and lower(o.name) like '%'||v_query||'%') or (v_nzbn is not null and regexp_replace(coalesce(o.nzbn,''),'[^0-9]','','g')=v_nzbn))
  order by case when v_nzbn is not null and regexp_replace(coalesce(o.nzbn,''),'[^0-9]','','g')=v_nzbn then 0 when lower(trim(o.name))=v_query then 1 else 2 end,o.name limit 20;
end;$$;

create function public.manage_crm_organization(
  p_client_request_id uuid,p_organization_id uuid,p_expected_updated_at timestamptz,p_action text,p_name text,p_organization_type text,
  p_nzbn text default null,p_company_registration_number text default null,p_contact_email text default null,p_contact_phone text default null,
  p_billing_email text default null,p_billing_address text default null,p_account_notes text default null,p_status text default null
) returns public.organizations language plpgsql volatile security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_provider uuid;v_org public.organizations%rowtype;v_name text:=nullif(trim(coalesce(p_name,'')),'');v_nzbn text:=nullif(regexp_replace(coalesce(p_nzbn,''),'[^0-9]','','g'),'');v_status text;
begin
  select actor.organization_id into v_provider from public.user_profiles actor where actor.id=v_actor and actor.deactivated_at is null;
  if v_provider is null or not public.is_admin_for_org(v_provider) then raise exception 'Active CRM administrator required';end if;
  if p_action='create' then
    if p_client_request_id is null then raise exception 'client_request_id is required';end if;
    select o.* into v_org from public.organizations o where o.parent_organization_id=v_provider and o.client_request_id=p_client_request_id;if found then return v_org;end if;
  else
    select o.* into v_org from public.organizations o where o.id=p_organization_id for update;if not found then raise exception 'Organization not found';end if;
    if v_org.id<>v_provider and v_org.parent_organization_id is distinct from v_provider then raise exception 'Organization is outside your managed account hierarchy';end if;
    if v_org.updated_at<>p_expected_updated_at then raise exception 'Organization changed since it was opened';end if;
  end if;
  if p_action in('create','update') then
    if v_name is null or char_length(v_name)>200 then raise exception 'Organization name is required and must be 200 characters or fewer';end if;
    if p_organization_type not in('client','branch','contractor','government','private_enterprise') then raise exception 'Unsupported CRM organization type';end if;
    if exists(select 1 from public.organizations o where o.parent_organization_id=v_provider and lower(trim(o.name))=lower(v_name) and o.id is distinct from p_organization_id) then raise exception 'An organization with this name already exists in your account hierarchy';end if;
    if v_nzbn is not null and char_length(v_nzbn)<>13 then raise exception 'NZBN must contain 13 digits';end if;
    if p_action='create' then
      insert into public.organizations(name,organization_type,parent_organization_id,active,status,nzbn,company_registration_number,contact_email,contact_phone,billing_email,billing_address,account_notes,client_request_id)
      values(v_name,p_organization_type,v_provider,false,'prospect',v_nzbn,nullif(trim(coalesce(p_company_registration_number,'')),''),nullif(lower(trim(coalesce(p_contact_email,''))),''),nullif(trim(coalesce(p_contact_phone,'')),''),nullif(lower(trim(coalesce(p_billing_email,''))),''),nullif(trim(coalesce(p_billing_address,'')),''),nullif(trim(coalesce(p_account_notes,'')),''),p_client_request_id) returning * into v_org;
    else
      update public.organizations set name=v_name,organization_type=p_organization_type,nzbn=v_nzbn,company_registration_number=nullif(trim(coalesce(p_company_registration_number,'')),''),contact_email=nullif(lower(trim(coalesce(p_contact_email,''))),''),contact_phone=nullif(trim(coalesce(p_contact_phone,'')),''),billing_email=nullif(lower(trim(coalesce(p_billing_email,''))),''),billing_address=nullif(trim(coalesce(p_billing_address,'')),''),account_notes=nullif(trim(coalesce(p_account_notes,'')),''),updated_at=clock_timestamp() where id=v_org.id returning * into v_org;
    end if;
  elsif p_action='set_status' then
    if v_org.id=v_provider then raise exception 'Provider status is managed outside CRM accounts';end if;
    v_status:=p_status;if v_status not in('prospect','suspended','archived') then raise exception 'CRM cannot directly activate an organization';end if;
    if v_org.status='archived' and v_status='suspended' then raise exception 'Archived organizations must return to prospect review first';end if;
    update public.organizations set status=v_status,active=false,updated_at=clock_timestamp() where id=v_org.id returning * into v_org;
  else raise exception 'Unsupported organization action';end if;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_provider,v_actor,'crm_organization_'||p_action,'organizations',v_org.id,jsonb_build_object('name',v_org.name,'organization_type',v_org.organization_type,'status',v_org.status));
  return v_org;
end;$$;

create function public.get_crm_organization_readiness(p_organization_ids uuid[] default null)
returns table(organization_id uuid,organization_status text,identity_status text,contact_status text,location_status text,agreement_status text,module_status text,billing_status text,operations_status text,blockers text[],next_action text)
language plpgsql stable security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_provider uuid;
begin
  select actor.organization_id into v_provider from public.user_profiles actor where actor.id=v_actor and actor.deactivated_at is null;
  if v_provider is null or not public.is_admin_for_org(v_provider) then raise exception 'Active CRM administrator required';end if;
  return query with accounts as(select o.* from public.organizations o where o.parent_organization_id=v_provider and (p_organization_ids is null or o.id=any(p_organization_ids))),facts as(
    select a.id,a.status,
      (a.name<>'' and a.organization_type is not null) identity_ready,
      exists(select 1 from public.crm_contacts c where c.organization_id=a.id and c.is_primary and c.deactivated_at is null) contact_ready,
      exists(select 1 from public.client_sites s where s.client_organization_id=a.id and s.active) location_ready,
      exists(select 1 from public.service_agreements sa where sa.provider_organization_id=v_provider and sa.client_organization_id=a.id and sa.invitation_status='accepted') agreement_ready,
      exists(select 1 from public.service_agreements sa where sa.provider_organization_id=v_provider and sa.client_organization_id=a.id and sa.invitation_status='accepted' and cardinality(sa.enabled_modules)>0) module_ready,
      exists(select 1 from public.service_agreements sa join public.crm_commercial_settings cc on cc.service_agreement_id=sa.id where sa.provider_organization_id=v_provider and sa.client_organization_id=a.id) billing_ready,
      exists(select 1 from public.roster_work_units wu join public.service_agreement_locations sal on sal.id=wu.service_agreement_location_id join public.service_agreements sa on sa.id=sal.service_agreement_id where sa.provider_organization_id=v_provider and sa.client_organization_id=a.id and wu.active) operations_ready
    from accounts a)
  select f.id,f.status,case when f.identity_ready then 'ready' else 'blocked' end,case when f.contact_ready then 'ready' else 'blocked' end,case when f.location_ready then 'ready' else 'blocked' end,case when f.agreement_ready then 'ready' else 'blocked' end,case when f.module_ready then 'ready' else 'blocked' end,case when f.billing_ready then 'ready' else 'blocked' end,case when f.operations_ready then 'ready' else 'blocked' end,
    array_remove(array[case when not f.identity_ready then 'Confirm the organization identity' end,case when not f.contact_ready then 'Add a primary contact' end,case when not f.location_ready then 'Add an active covered site' end,case when not f.agreement_ready then 'Create and accept a service agreement' end,case when not f.module_ready then 'Enable at least one agreement module' end,case when not f.billing_ready then 'Complete commercial settings' end,case when not f.operations_ready then 'Create an operational work unit' end],null),
    case when not f.contact_ready then 'Add primary contact' when not f.location_ready then 'Add covered site' when not f.agreement_ready then 'Create service agreement' when not f.module_ready then 'Enable service modules' when not f.billing_ready then 'Complete billing setup' when not f.operations_ready then 'Complete operational setup' else 'Ready for activation review' end
  from facts f order by f.id;
end;$$;

create function public.update_organization_profile(p_expected_updated_at timestamptz,p_contact_email text,p_contact_phone text,p_billing_email text,p_billing_address text,p_enforcement_workflow_mode text)
returns public.organizations language plpgsql volatile security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_provider uuid;v_org public.organizations%rowtype;
begin
  select actor.organization_id into v_provider from public.user_profiles actor where actor.id=v_actor and actor.deactivated_at is null;
  if v_provider is null or not public.is_admin_for_org(v_provider) then raise exception 'Active organization administrator required';end if;
  select o.* into v_org from public.organizations o where o.id=v_provider for update;if not found then raise exception 'Organization not found';end if;
  if v_org.updated_at<>p_expected_updated_at then raise exception 'Organization changed since it was opened';end if;
  if p_enforcement_workflow_mode not in('admin_first','officer_direct','hybrid') then raise exception 'Unsupported enforcement workflow mode';end if;
  update public.organizations set contact_email=nullif(lower(trim(coalesce(p_contact_email,''))),''),contact_phone=nullif(trim(coalesce(p_contact_phone,'')),''),billing_email=nullif(lower(trim(coalesce(p_billing_email,''))),''),billing_address=nullif(trim(coalesce(p_billing_address,'')),''),enforcement_workflow_mode=p_enforcement_workflow_mode,updated_at=clock_timestamp() where id=v_provider returning * into v_org;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)values(v_provider,v_actor,'organization_profile_updated','organizations',v_provider,jsonb_build_object('enforcement_workflow_mode',v_org.enforcement_workflow_mode,'billing_configured',v_org.billing_email is not null));
  return v_org;
end;$$;

revoke insert,update,delete,truncate on public.organizations from public,anon,authenticated;
revoke all on function public.find_crm_organization_candidates(text,text) from public,anon,authenticated;
revoke all on function public.manage_crm_organization(uuid,uuid,timestamptz,text,text,text,text,text,text,text,text,text,text,text) from public,anon,authenticated;
revoke all on function public.get_crm_organization_readiness(uuid[]) from public,anon,authenticated;
revoke all on function public.update_organization_profile(timestamptz,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.find_crm_organization_candidates(text,text),public.manage_crm_organization(uuid,uuid,timestamptz,text,text,text,text,text,text,text,text,text,text,text),public.get_crm_organization_readiness(uuid[]),public.update_organization_profile(timestamptz,text,text,text,text,text) to authenticated,service_role;