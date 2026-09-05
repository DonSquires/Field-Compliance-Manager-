-- Provider branches are internal operating entities, not CRM client accounts.
-- They activate under their parent provider without a client agreement.
CREATE OR REPLACE FUNCTION public.activate_provider_branch(
  p_branch_organization_id uuid,
  p_expected_updated_at timestamptz
)
RETURNS public.organizations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_branch public.organizations%rowtype;
  v_parent public.organizations%rowtype;
begin
  select * into v_branch from public.organizations where id = p_branch_organization_id for update;
  if not found or v_branch.organization_type <> 'branch' then raise exception 'Internal provider branch not found'; end if;
  select * into v_parent from public.organizations where id = v_branch.parent_organization_id;
  if not found or v_parent.organization_type not in ('owner', 'service_provider', 'branch') or not public.is_admin_for_org(v_parent.id) then raise exception 'Parent provider administrator required'; end if;
  if v_branch.active and v_branch.status = 'active' then return v_branch; end if;
  if v_branch.status <> 'prospect' then raise exception 'Only a provider branch in prospect status can be activated'; end if;
  if p_expected_updated_at is not null and v_branch.updated_at <> p_expected_updated_at then raise exception 'Provider branch changed since activation review'; end if;
  update public.organizations set active = true, status = 'active', updated_at = now() where id = v_branch.id returning * into v_branch;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  values(v_parent.id,auth.uid(),'provider_branch_activated','organizations',v_branch.id,jsonb_build_object('parent_provider_organization_id',v_parent.id));
  return v_branch;
end;
$$;

REVOKE ALL ON FUNCTION public.activate_provider_branch(uuid,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.activate_provider_branch(uuid,timestamptz) TO authenticated, service_role;