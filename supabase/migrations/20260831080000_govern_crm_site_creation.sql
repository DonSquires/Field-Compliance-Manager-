alter table public.client_sites add column if not exists client_request_id uuid;
create unique index if not exists idx_client_sites_org_client_request on public.client_sites(client_organization_id,client_request_id) where client_request_id is not null;

create function public.find_crm_site_candidates(p_account_organization_id uuid,p_query text default null,p_address text default null)
returns table(id uuid,name text,address text,site_type text,active boolean,boundary_status text,boundary_verification text,match_reason text)
language plpgsql stable security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_query text:=lower(trim(coalesce(p_query,'')));v_address_key text:=regexp_replace(lower(trim(coalesce(p_address,''))),'[^a-z0-9]+','','g');
begin
  if v_actor is null or not public.crm_actor_can_manage_account(p_account_organization_id) then raise exception 'Not authorised to review sites for this CRM account';end if;
  if char_length(v_query)<2 and char_length(v_address_key)<4 then raise exception 'Enter at least two name characters or a complete address';end if;
  return query select s.id,s.name,s.address,s.site_type,s.active,s.boundary_status,s.boundary_verification,
    case when char_length(v_address_key)>=4 and s.address_match_key=v_address_key then 'Exact address' when lower(trim(s.name))=v_query then 'Exact name' else 'Similar site' end
  from public.client_sites s
  where s.client_organization_id=p_account_organization_id
    and ((char_length(v_query)>=2 and lower(s.name) like '%'||v_query||'%') or (char_length(v_address_key)>=4 and s.address_match_key=v_address_key))
  order by case when char_length(v_address_key)>=4 and s.address_match_key=v_address_key then 0 when lower(trim(s.name))=v_query then 1 else 2 end,s.name limit 20;
end;$$;

create function public.create_crm_site(p_client_request_id uuid,p_account_organization_id uuid,p_name text,p_address text,p_site_type text default 'commercial_premises')
returns table(id uuid,name text,address text,site_type text,active boolean,boundary_status text,boundary_verification text,created boolean)
language plpgsql volatile security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_provider uuid;v_site public.client_sites%rowtype;v_name text:=nullif(trim(coalesce(p_name,'')),'');v_address text:=nullif(trim(coalesce(p_address,'')),'');v_address_key text;
begin
  select organization_id into v_provider from public.user_profiles where id=v_actor and deactivated_at is null;
  if v_provider is null or not public.is_admin_for_org(v_provider) or not public.crm_actor_can_manage_account(p_account_organization_id) then raise exception 'Active CRM administrator required';end if;
  if p_client_request_id is null then raise exception 'client_request_id is required';end if;
  perform 1 from public.organizations where id=p_account_organization_id for update;
  if not found then raise exception 'CRM account organization not found';end if;
  select s.* into v_site from public.client_sites s where s.client_organization_id=p_account_organization_id and s.client_request_id=p_client_request_id;
  if found then return query select v_site.id,v_site.name,v_site.address,v_site.site_type,v_site.active,v_site.boundary_status,v_site.boundary_verification,false;return;end if;
  if v_name is null or char_length(v_name)>200 then raise exception 'Site name is required and must be 200 characters or fewer';end if;
  if v_address is null or char_length(v_address)<4 or char_length(v_address)>500 then raise exception 'A complete site address is required';end if;
  if p_site_type not in('freedom_camping_area','parking_area','commercial_premises','residential_complex','government_facility','hospital','education_facility','industrial_site','public_space','other') then raise exception 'Unsupported site type';end if;
  v_address_key:=regexp_replace(lower(v_address),'[^a-z0-9]+','','g');
  if exists(select 1 from public.client_sites s where s.client_organization_id=p_account_organization_id and s.address_match_key=v_address_key) then raise exception 'A site with this address already exists for the account';end if;
  insert into public.client_sites(client_organization_id,name,address,address_match_key,site_type,active,site_origin,boundary_status,boundary_verification,client_request_id)
  values(p_account_organization_id,v_name,v_address,v_address_key,p_site_type,true,'contracted','provisional','unverified',p_client_request_id) returning * into v_site;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  values(v_provider,v_actor,'crm_site_created','client_sites',v_site.id,jsonb_build_object('account_organization_id',p_account_organization_id,'address_match_key',v_address_key,'boundary_status',v_site.boundary_status,'boundary_verification',v_site.boundary_verification));
  return query select v_site.id,v_site.name,v_site.address,v_site.site_type,v_site.active,v_site.boundary_status,v_site.boundary_verification,true;
end;$$;

revoke insert on public.client_sites from public,anon,authenticated;
revoke all on function public.find_crm_site_candidates(uuid,text,text) from public,anon,authenticated;
revoke all on function public.create_crm_site(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.find_crm_site_candidates(uuid,text,text),public.create_crm_site(uuid,uuid,text,text,text) to authenticated,service_role;