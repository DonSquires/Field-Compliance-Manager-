CREATE OR REPLACE FUNCTION public.get_manageable_user_identities(p_operating_organization_id uuid)
RETURNS TABLE(
  id uuid,
  display_name text,
  role text,
  email text,
  phone text,
  module_access text[],
  deactivated_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_branch public.organizations%rowtype;
begin
  if v_actor is null or not public.user_can_operate_organization(p_operating_organization_id) then
    raise exception 'Active authorized operating branch required';
  end if;
  select * into v_branch from public.organizations where id = p_operating_organization_id and organization_type = 'branch' and active;
  if not found then raise exception 'Active delivery branch required'; end if;
  return query
  select user_profile.id, user_profile.display_name, user_profile.role, user_profile.email, user_profile.phone,
    user_profile.module_access, user_profile.deactivated_at, user_profile.updated_at
  from public.staff_branch_authorisations assignment
  join public.user_profiles user_profile on user_profile.id = assignment.user_id
  where assignment.branch_org_id = v_branch.id
    and public.staff_branch_authorisation_manager_can_manage(v_actor, v_branch.id, user_profile.id)
  order by user_profile.display_name nulls last, user_profile.email;
end;
$$;

REVOKE ALL ON FUNCTION public.get_manageable_user_identities(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_manageable_user_identities(uuid) TO authenticated, service_role;