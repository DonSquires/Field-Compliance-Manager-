ALTER TABLE public.staff_branch_authorisations
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT clock_timestamp();

DROP TRIGGER IF EXISTS trg_touch_staff_branch_authorisations ON public.staff_branch_authorisations;
CREATE TRIGGER trg_touch_staff_branch_authorisations
BEFORE UPDATE ON public.staff_branch_authorisations
FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

CREATE OR REPLACE FUNCTION public.staff_branch_authorisation_manager_can_manage(
  p_actor_id uuid,
  p_branch_organization_id uuid,
  p_target_user_id uuid
)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  select exists (
    select 1
    from public.user_profiles actor
    join public.user_profiles target on target.id = p_target_user_id
    where actor.id = p_actor_id
      and actor.deactivated_at is null
      and target.employer_organization_id is not null
      and (
        actor.role = 'grand_master'
        or (
          target.employer_organization_id = coalesce(actor.employer_organization_id, actor.organization_id)
          and p_branch_organization_id = any(public.get_descendant_organizations(coalesce(actor.employer_organization_id, actor.organization_id)))
          and (actor.role in ('master', 'admin') or p_branch_organization_id = any(public.user_managed_branch_ids()))
        )
      )
  );
$$;

CREATE OR REPLACE FUNCTION public.get_staff_branch_authorisations(p_user_id uuid)
RETURNS TABLE(
  id uuid,
  branch_organization_id uuid,
  branch_name text,
  role_at_branch text,
  module_access text[],
  can_be_rostered boolean,
  status text,
  starts_on date,
  ends_on date,
  authorised_by uuid,
  updated_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then raise exception 'Authenticated user required'; end if;
  if p_user_id <> v_actor and not exists (
    select 1 from public.user_profiles actor
    join public.user_profiles target on target.id = p_user_id
    where actor.id = v_actor
      and actor.deactivated_at is null
      and (actor.role = 'grand_master' or (target.employer_organization_id = coalesce(actor.employer_organization_id, actor.organization_id) and (actor.role in ('master', 'admin') or cardinality(public.user_managed_branch_ids()) > 0)))
  ) then
    raise exception 'Not authorised to view this staff member branch access';
  end if;
  return query
    select assignment.id, assignment.branch_org_id, branch.name, assignment.role_at_branch,
      assignment.module_access, assignment.can_be_rostered, assignment.status,
      assignment.starts_on, assignment.ends_on, assignment.authorised_by, assignment.updated_at
  from public.staff_branch_authorisations assignment
  join public.organizations branch on branch.id = assignment.branch_org_id
  where assignment.user_id = p_user_id
    and (p_user_id = v_actor or exists(select 1 from public.user_profiles actor where actor.id = v_actor and actor.role in ('grand_master', 'master', 'admin')) or assignment.branch_org_id = any(public.user_managed_branch_ids()))
  order by branch.name;
end;
$$;

CREATE OR REPLACE FUNCTION public.manage_staff_branch_authorisation(
  p_action text,
  p_user_id uuid,
  p_branch_organization_id uuid,
  p_expected_updated_at timestamptz DEFAULT NULL,
  p_role_at_branch text DEFAULT 'officer',
  p_module_access text[] DEFAULT '{}'::text[],
  p_can_be_rostered boolean DEFAULT true,
  p_starts_on date DEFAULT NULL,
  p_ends_on date DEFAULT NULL,
  p_reason text DEFAULT NULL
)
RETURNS public.staff_branch_authorisations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_target public.user_profiles%rowtype;
  v_branch public.organizations%rowtype;
  v_authorisation public.staff_branch_authorisations%rowtype;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_previous jsonb;
begin
  if v_actor is null then raise exception 'Authenticated user required'; end if;
  if v_actor = p_user_id then raise exception 'You cannot change your own branch access'; end if;
  if p_action not in ('grant', 'update', 'suspend', 'end') then raise exception 'Unsupported branch authorization action'; end if;
  if v_reason is null then raise exception 'A change reason is required'; end if;
  select * into v_target from public.user_profiles where id = p_user_id and deactivated_at is null;
  if not found then raise exception 'Active target user not found'; end if;
  select * into v_branch from public.organizations where id = p_branch_organization_id and organization_type = 'branch' and active;
  if not found then raise exception 'Active delivery branch not found'; end if;
  if not public.staff_branch_authorisation_manager_can_manage(v_actor, v_branch.id, v_target.id) then raise exception 'Not authorised to manage staff access for this branch'; end if;
  if p_action in ('grant', 'update') and p_role_at_branch not in ('officer', 'supervisor', 'branch_manager') then raise exception 'Unsupported branch role'; end if;
  if p_starts_on is not null and p_ends_on is not null and p_ends_on < p_starts_on then raise exception 'Branch authorization end date cannot precede its start date'; end if;
  select * into v_authorisation from public.staff_branch_authorisations where user_id = p_user_id and branch_org_id = v_branch.id for update;
  if found and p_expected_updated_at is not null and v_authorisation.updated_at <> p_expected_updated_at then raise exception 'Branch authorization changed since it was opened'; end if;
  v_previous := case when found then jsonb_build_object('role_at_branch', v_authorisation.role_at_branch, 'module_access', v_authorisation.module_access, 'can_be_rostered', v_authorisation.can_be_rostered, 'status', v_authorisation.status, 'starts_on', v_authorisation.starts_on, 'ends_on', v_authorisation.ends_on) else null end;
  if p_action = 'grant' then
    if found and v_authorisation.status = 'active' then raise exception 'An active authorization already exists for this branch'; end if;
    if found then
      update public.staff_branch_authorisations set role_at_branch = p_role_at_branch, module_access = coalesce(p_module_access, '{}'::text[]), can_be_rostered = p_can_be_rostered, status = 'active', starts_on = p_starts_on, ends_on = p_ends_on, authorised_by = v_actor where id = v_authorisation.id returning * into v_authorisation;
    else
      insert into public.staff_branch_authorisations(user_id, branch_org_id, role_at_branch, module_access, can_be_rostered, status, authorised_by, starts_on, ends_on) values(p_user_id, v_branch.id, p_role_at_branch, coalesce(p_module_access, '{}'::text[]), p_can_be_rostered, 'active', v_actor, p_starts_on, p_ends_on) returning * into v_authorisation;
    end if;
  elsif p_action = 'update' then
    if not found then raise exception 'Branch authorization not found'; end if;
    update public.staff_branch_authorisations set role_at_branch = p_role_at_branch, module_access = coalesce(p_module_access, '{}'::text[]), can_be_rostered = p_can_be_rostered, starts_on = p_starts_on, ends_on = p_ends_on, authorised_by = v_actor where id = v_authorisation.id returning * into v_authorisation;
  elsif p_action = 'suspend' then
    if not found or v_authorisation.status <> 'active' then raise exception 'Active branch authorization not found'; end if;
    update public.staff_branch_authorisations set status = 'suspended', can_be_rostered = false, authorised_by = v_actor where id = v_authorisation.id returning * into v_authorisation;
  else
    if not found or v_authorisation.status = 'ended' then raise exception 'Current branch authorization not found'; end if;
    update public.staff_branch_authorisations set status = 'ended', can_be_rostered = false, ends_on = coalesce(p_ends_on, current_date), authorised_by = v_actor where id = v_authorisation.id returning * into v_authorisation;
  end if;
  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values(v_branch.id, v_actor, 'staff_branch_authorisation_' || p_action, 'staff_branch_authorisations', v_authorisation.id,
    jsonb_build_object('target_user_id', p_user_id, 'employer_organization_id', v_target.employer_organization_id, 'branch_organization_id', v_branch.id, 'reason', v_reason, 'previous', v_previous, 'current', jsonb_build_object('role_at_branch', v_authorisation.role_at_branch, 'module_access', v_authorisation.module_access, 'can_be_rostered', v_authorisation.can_be_rostered, 'status', v_authorisation.status, 'starts_on', v_authorisation.starts_on, 'ends_on', v_authorisation.ends_on)));
  return v_authorisation;
end;
$$;

REVOKE ALL ON FUNCTION public.staff_branch_authorisation_manager_can_manage(uuid, uuid, uuid), public.get_staff_branch_authorisations(uuid), public.manage_staff_branch_authorisation(text, uuid, uuid, timestamptz, text, text[], boolean, date, date, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_staff_branch_authorisations(uuid), public.manage_staff_branch_authorisation(text, uuid, uuid, timestamptz, text, text[], boolean, date, date, text) TO authenticated, service_role;