-- Organization is the tenancy root. Branches and departments are accountable
-- child organizations; they are never aliases for client accounts.
ALTER TABLE public.organizations
  DROP CONSTRAINT IF EXISTS organizations_organization_type_check;
ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_organization_type_check CHECK (organization_type IN ('owner', 'service_provider', 'branch', 'department', 'client', 'contractor', 'government', 'private_enterprise'));

CREATE OR REPLACE FUNCTION public.manage_crm_organization_child(
  p_client_request_id uuid,
  p_parent_organization_id uuid,
  p_name text,
  p_organization_type text,
  p_nzbn text DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS public.organizations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_parent public.organizations%rowtype;
  v_child public.organizations%rowtype;
  v_name text := nullif(trim(coalesce(p_name, '')), '');
  v_nzbn text := nullif(regexp_replace(coalesce(p_nzbn, ''), '[^0-9]', '', 'g'), '');
begin
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  select * into v_parent from public.organizations where id = p_parent_organization_id;
  if not found or not public.is_admin_for_org(v_parent.id) then raise exception 'Parent organization is not available for management'; end if;
  if v_name is null or char_length(v_name) > 200 then raise exception 'Organization name is required and must be 200 characters or fewer'; end if;
  if p_organization_type not in ('branch', 'department', 'client', 'contractor', 'government', 'private_enterprise') then raise exception 'Unsupported child organization type'; end if;
  if p_organization_type = 'branch' and v_parent.organization_type not in ('owner', 'service_provider', 'branch') then raise exception 'A branch must belong to a provider organization or branch'; end if;
  if p_organization_type = 'department' and v_parent.organization_type not in ('client', 'government', 'private_enterprise', 'department') then raise exception 'A department must belong to a client organization or department'; end if;
  if p_organization_type in ('client', 'government', 'private_enterprise') and v_parent.organization_type not in ('owner', 'service_provider', 'branch') then raise exception 'A client organization must belong to a provider organization or branch'; end if;
  if v_nzbn is not null and char_length(v_nzbn) <> 13 then raise exception 'NZBN must contain 13 digits'; end if;
  select * into v_child from public.organizations where parent_organization_id = v_parent.id and client_request_id = p_client_request_id;
  if found then return v_child; end if;
  if exists (select 1 from public.organizations child where child.parent_organization_id = v_parent.id and lower(trim(child.name)) = lower(v_name)) then raise exception 'A child organization with this name already exists'; end if;
  insert into public.organizations(name,organization_type,parent_organization_id,active,status,nzbn,account_notes,client_request_id)
  values(v_name,p_organization_type,v_parent.id,false,'prospect',v_nzbn,nullif(trim(coalesce(p_notes, '')), ''),p_client_request_id)
  returning * into v_child;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  values(v_parent.id,v_actor,'crm_organization_child_created','organizations',v_child.id,jsonb_build_object('parent_organization_id',v_parent.id,'organization_type',v_child.organization_type,'name',v_child.name));
  return v_child;
end;
$$;

REVOKE ALL ON FUNCTION public.manage_crm_organization_child(uuid,uuid,text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.manage_crm_organization_child(uuid,uuid,text,text,text,text) TO authenticated, service_role;