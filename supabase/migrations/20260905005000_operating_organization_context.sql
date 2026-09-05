-- Employment remains anchored to the provider employer. This catalog exposes
-- only delivery branches that the current user may deliberately operate.
CREATE OR REPLACE FUNCTION public.get_operating_organization_contexts()
RETURNS TABLE(
  organization_id uuid,
  organization_name text,
  authority_basis text,
  role_at_branch text,
  module_access text[],
  can_be_rostered boolean,
  is_default boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  with actor as (
    select organization_id, employer_organization_id, role
    from public.user_profiles
    where id = auth.uid() and deactivated_at is null
  ), candidates as (
    select
      branch.id as organization_id,
      branch.name as organization_name,
      'branch_authorisation'::text as authority_basis,
      authorisation.role_at_branch,
      authorisation.module_access,
      authorisation.can_be_rostered,
      1 as authority_rank
    from actor
    join public.staff_branch_authorisations authorisation
      on authorisation.user_id = auth.uid() and authorisation.status = 'active'
    join public.organizations branch
      on branch.id = authorisation.branch_org_id
     and branch.organization_type = 'branch'
     and branch.active

    union all

    select
      branch.id,
      branch.name,
      'corporate_oversight'::text,
      null::text,
      array[]::text[],
      false,
      2
    from actor
    join public.organizations branch
      on branch.organization_type = 'branch'
     and branch.active
     and branch.id = any(public.get_descendant_organizations(coalesce(actor.employer_organization_id, actor.organization_id)))
    where actor.role in ('grand_master', 'master', 'admin')
  ), ranked as (
    select distinct on (organization_id)
      organization_id, organization_name, authority_basis, role_at_branch,
      module_access, can_be_rostered
    from candidates
    order by organization_id, authority_rank
  )
  select
    ranked.organization_id,
    ranked.organization_name,
    ranked.authority_basis,
    ranked.role_at_branch,
    ranked.module_access,
    ranked.can_be_rostered,
    ranked.organization_id = actor.organization_id as is_default
  from ranked
  cross join actor
  order by is_default desc, organization_name;
$$;

REVOKE ALL ON FUNCTION public.get_operating_organization_contexts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_operating_organization_contexts() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.user_can_operate_organization(p_organization_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  select exists (
    select 1
    from public.get_operating_organization_contexts() context
    where context.organization_id = p_organization_id
  );
$$;

REVOKE ALL ON FUNCTION public.user_can_operate_organization(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.create_operating_organization_workplace(
  p_operating_organization_id uuid,
  p_name text,
  p_address text DEFAULT NULL
)
RETURNS public.organization_workplaces
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_row public.organization_workplaces%rowtype;
begin
  if not public.user_can_operate_organization(p_operating_organization_id)
    or not public.is_admin_for_org(p_operating_organization_id) then
    raise exception 'Active authorized operating branch administrator required';
  end if;
  if nullif(trim(coalesce(p_name, '')), '') is null then raise exception 'Workplace name is required'; end if;
  insert into public.organization_workplaces(organization_id, name, address, created_by)
  values(p_operating_organization_id, trim(p_name), nullif(trim(coalesce(p_address, '')), ''), v_actor)
  returning * into v_row;
  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values(p_operating_organization_id, v_actor, 'organization_workplace_created', 'organization_workplaces', v_row.id,
    jsonb_build_object('name', v_row.name, 'operating_organization_id', p_operating_organization_id));
  return v_row;
end;
$$;

CREATE OR REPLACE FUNCTION public.create_operating_cost_centre(
  p_operating_organization_id uuid,
  p_code text,
  p_name text
)
RETURNS public.cost_centres
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_row public.cost_centres%rowtype;
begin
  if not public.user_can_operate_organization(p_operating_organization_id)
    or not public.is_admin_for_org(p_operating_organization_id) then
    raise exception 'Active authorized operating branch administrator required';
  end if;
  if nullif(trim(coalesce(p_code, '')), '') is null or nullif(trim(coalesce(p_name, '')), '') is null then
    raise exception 'Cost centre code and name are required';
  end if;
  insert into public.cost_centres(organization_id, code, name, created_by)
  values(p_operating_organization_id, upper(trim(p_code)), trim(p_name), v_actor)
  returning * into v_row;
  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values(p_operating_organization_id, v_actor, 'cost_centre_created', 'cost_centres', v_row.id,
    jsonb_build_object('code', v_row.code, 'name', v_row.name, 'operating_organization_id', p_operating_organization_id));
  return v_row;
end;
$$;

CREATE OR REPLACE FUNCTION public.create_operating_roster_work_unit(
  p_operating_organization_id uuid,
  p_name text,
  p_work_unit_type text,
  p_service_type text,
  p_patrol_route_id uuid DEFAULT NULL,
  p_service_agreement_location_id uuid DEFAULT NULL,
  p_service_agreement_module_id uuid DEFAULT NULL,
  p_workplace_id uuid DEFAULT NULL,
  p_team_id uuid DEFAULT NULL,
  p_cost_centre_id uuid DEFAULT NULL
)
RETURNS public.roster_work_units
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_unit public.roster_work_units%rowtype;
  v_agreement uuid;
begin
  if not public.user_can_operate_organization(p_operating_organization_id)
    or not public.is_admin_for_org(p_operating_organization_id) then
    raise exception 'Active authorized operating branch administrator required';
  end if;
  if nullif(trim(coalesce(p_name, '')), '') is null or nullif(trim(coalesce(p_service_type, '')), '') is null then
    raise exception 'Name and service type are required';
  end if;
  if p_work_unit_type = 'patrol' then
    if p_patrol_route_id is null or not exists(select 1 from public.patrol_routes route where route.id = p_patrol_route_id and route.organization_id = p_operating_organization_id and route.is_active) then raise exception 'Active patrol route in this operating branch required'; end if;
  elsif p_work_unit_type = 'static' then
    select location.service_agreement_id into v_agreement from public.service_agreement_locations location join public.service_agreements agreement on agreement.id = location.service_agreement_id and agreement.provider_organization_id = p_operating_organization_id where location.id = p_service_agreement_location_id and location.status = 'active';
    if v_agreement is null or not exists(select 1 from public.service_agreement_modules module where module.id = p_service_agreement_module_id and module.service_agreement_id = v_agreement and module.enabled and module.module_key = 'static_guarding') then raise exception 'Active static guarding agreement location and module required'; end if;
  elsif p_work_unit_type = 'internal' then
    if p_workplace_id is null or not exists(select 1 from public.organization_workplaces workplace where workplace.id = p_workplace_id and workplace.organization_id = p_operating_organization_id and workplace.active) then raise exception 'Active provider workplace required'; end if;
    if p_team_id is not null and not exists(select 1 from public.teams team where team.id = p_team_id and team.organization_id = p_operating_organization_id and team.status = 'active') then raise exception 'Active team in this operating branch required'; end if;
    if p_cost_centre_id is not null and not exists(select 1 from public.cost_centres centre where centre.id = p_cost_centre_id and centre.organization_id = p_operating_organization_id and centre.active) then raise exception 'Active cost centre in this operating branch required'; end if;
  else raise exception 'Unsupported work unit type'; end if;
  insert into public.roster_work_units(organization_id, name, work_unit_type, service_type, patrol_route_id, service_agreement_location_id, service_agreement_module_id, workplace_id, team_id, cost_centre_id, created_by)
  values(p_operating_organization_id, trim(p_name), p_work_unit_type, trim(p_service_type), p_patrol_route_id, p_service_agreement_location_id, p_service_agreement_module_id, p_workplace_id, p_team_id, p_cost_centre_id, v_actor)
  returning * into v_unit;
  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values(p_operating_organization_id, v_actor, 'roster_work_unit_created', 'roster_work_units', v_unit.id,
    jsonb_build_object('work_unit_type', v_unit.work_unit_type, 'service_type', v_unit.service_type, 'operating_organization_id', p_operating_organization_id));
  return v_unit;
end;
$$;

REVOKE ALL ON FUNCTION public.create_operating_organization_workplace(uuid, text, text), public.create_operating_cost_centre(uuid, text, text), public.create_operating_roster_work_unit(uuid, text, text, text, uuid, uuid, uuid, uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_operating_organization_workplace(uuid, text, text), public.create_operating_cost_centre(uuid, text, text), public.create_operating_roster_work_unit(uuid, text, text, text, uuid, uuid, uuid, uuid, uuid, uuid) TO authenticated, service_role;