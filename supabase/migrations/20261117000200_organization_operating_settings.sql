-- Place patrols and services, Task 2 (owner design 2026-11-16).
-- Two optional organisation operating settings, both off by default:
--   place_changes_need_second_approver - place changes wait for a second administrator;
--   branches_may_set_up_static_posts   - descendant operating branches may set up static
--                                        posts on the provider's agreements.
-- create_operating_roster_work_unit's static branch now honours the second setting through
-- can_set_up_static_post. The static validation, insert and audit live in an internal helper
-- so a later approval path can create the unit for a provider administrator.

CREATE TABLE IF NOT EXISTS public.organization_operating_settings(
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id),
  place_changes_need_second_approver boolean NOT NULL DEFAULT false,
  branches_may_set_up_static_posts boolean NOT NULL DEFAULT false,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

COMMENT ON TABLE public.organization_operating_settings IS
  'Optional organisation operating settings. A missing row means every setting is off. Written only through set_organization_operating_setting.';

ALTER TABLE public.organization_operating_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY organization_operating_settings_admin_select ON public.organization_operating_settings
  FOR SELECT TO authenticated USING (public.is_admin_for_org(organization_id));

REVOKE ALL ON TABLE public.organization_operating_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.organization_operating_settings TO authenticated;
GRANT ALL ON TABLE public.organization_operating_settings TO service_role;

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_organization_operating_setting_request
  ON public.audit_log (organization_id, ((metadata ->> 'client_request_id')))
  WHERE action = 'organization_operating_setting_change';

CREATE OR REPLACE FUNCTION public.get_organization_operating_settings(p_organization_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
declare
  v_actor uuid := auth.uid();
  v_settings public.organization_operating_settings%rowtype;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not public.is_admin_for_org(p_organization_id) then
    raise exception 'Organisation administrator required' using errcode = '42501';
  end if;
  select * into v_settings from public.organization_operating_settings s where s.organization_id = p_organization_id;
  return jsonb_build_object(
    'place_changes_need_second_approver', coalesce(v_settings.place_changes_need_second_approver, false),
    'branches_may_set_up_static_posts', coalesce(v_settings.branches_may_set_up_static_posts, false),
    'other_approver_available', exists(
      select 1 from public.user_profiles profile
      where profile.id <> v_actor
        and profile.deactivated_at is null
        and public.can_approve_action(profile.id, p_organization_id)
    )
  );
end;
$$;

COMMENT ON FUNCTION public.get_organization_operating_settings(uuid) IS
  'Organisation operating settings for an administrator of that organisation. A missing row reads as both settings off. other_approver_available is true when another active (not deactivated) user passes can_approve_action for the organisation.';

REVOKE ALL ON FUNCTION public.get_organization_operating_settings(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_organization_operating_settings(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_organization_operating_setting(
  p_client_request_id uuid,
  p_organization_id uuid,
  p_setting text,
  p_value boolean
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
declare
  v_actor uuid := auth.uid();
  v_replay jsonb;
  v_from boolean;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_client_request_id is null or p_organization_id is null or p_value is null then
    raise exception 'Request ID, organisation and value are required' using errcode = '22023';
  end if;
  if p_setting is null or p_setting not in ('place_changes_need_second_approver', 'branches_may_set_up_static_posts') then
    raise exception 'Unknown organisation operating setting' using errcode = '22023';
  end if;
  if not public.is_admin_for_org(p_organization_id) then
    raise exception 'Organisation administrator required' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_client_request_id::text, 0));
  select audit.metadata into v_replay from public.audit_log audit
  where audit.organization_id = p_organization_id
    and audit.action = 'organization_operating_setting_change'
    and audit.metadata ->> 'client_request_id' = p_client_request_id::text;
  if found then
    if v_replay ->> 'setting' is distinct from p_setting or (v_replay ->> 'to')::boolean is distinct from p_value then
      raise exception 'Organisation setting request identity collision' using errcode = '22023';
    end if;
    return jsonb_build_object('organization_id', p_organization_id, 'setting', p_setting,
      'from', (v_replay ->> 'from')::boolean, 'to', (v_replay ->> 'to')::boolean);
  end if;

  insert into public.organization_operating_settings(organization_id) values (p_organization_id)
  on conflict (organization_id) do nothing;
  select case p_setting
           when 'place_changes_need_second_approver' then s.place_changes_need_second_approver
           else s.branches_may_set_up_static_posts
         end
    into v_from
  from public.organization_operating_settings s
  where s.organization_id = p_organization_id
  for update;

  update public.organization_operating_settings s
  set place_changes_need_second_approver = case when p_setting = 'place_changes_need_second_approver' then p_value else s.place_changes_need_second_approver end,
      branches_may_set_up_static_posts = case when p_setting = 'branches_may_set_up_static_posts' then p_value else s.branches_may_set_up_static_posts end,
      updated_by = v_actor,
      updated_at = clock_timestamp()
  where s.organization_id = p_organization_id;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (p_organization_id, v_actor, 'organization_operating_setting_change', 'organization_operating_settings', p_organization_id,
    jsonb_build_object('client_request_id', p_client_request_id, 'setting', p_setting, 'from', v_from, 'to', p_value));

  return jsonb_build_object('organization_id', p_organization_id, 'setting', p_setting, 'from', v_from, 'to', p_value);
end;
$$;

COMMENT ON FUNCTION public.set_organization_operating_setting(uuid, uuid, text, boolean) IS
  'Turns one organisation operating setting on or off as an administrator of that organisation. Audited as organization_operating_setting_change with {client_request_id, setting, from, to}; a replay of the same request ID returns the first result.';

REVOKE ALL ON FUNCTION public.set_organization_operating_setting(uuid, uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_organization_operating_setting(uuid, uuid, text, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.can_set_up_static_post(p_provider_organization_id uuid, p_operating_organization_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  select auth.uid() is not null
    and p_provider_organization_id is not null
    and p_operating_organization_id is not null
    and (
      p_operating_organization_id = p_provider_organization_id
      or (
        coalesce((select s.branches_may_set_up_static_posts from public.organization_operating_settings s
                  where s.organization_id = p_provider_organization_id), false)
        and p_operating_organization_id = any(public.get_descendant_organizations(p_provider_organization_id))
      )
    )
    and public.is_admin_for_org(p_operating_organization_id);
$$;

COMMENT ON FUNCTION public.can_set_up_static_post(uuid, uuid) IS
  'True when the caller administers the operating organisation and it is the agreement provider, or a descendant branch of a provider that allows branches to set up static posts.';

REVOKE ALL ON FUNCTION public.can_set_up_static_post(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_set_up_static_post(uuid, uuid) TO authenticated, service_role;

-- Internal: no caller checks. Callers must authorise the actor first.
CREATE OR REPLACE FUNCTION public.create_static_roster_work_unit_internal(
  p_actor_user_id uuid,
  p_operating_organization_id uuid,
  p_name text,
  p_service_type text,
  p_service_agreement_location_id uuid,
  p_service_agreement_module_id uuid
)
RETURNS public.roster_work_units
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
declare
  v_unit public.roster_work_units%rowtype;
  v_agreement uuid;
begin
  if nullif(trim(coalesce(p_name, '')), '') is null or nullif(trim(coalesce(p_service_type, '')), '') is null then
    raise exception 'Name and service type are required';
  end if;
  select location.service_agreement_id into v_agreement
  from public.service_agreement_locations location
  join public.service_agreements agreement on agreement.id = location.service_agreement_id
    and (
      agreement.provider_organization_id = p_operating_organization_id
      or (
        coalesce((select s.branches_may_set_up_static_posts from public.organization_operating_settings s
                  where s.organization_id = agreement.provider_organization_id), false)
        and p_operating_organization_id = any(public.get_descendant_organizations(agreement.provider_organization_id))
      )
    )
  where location.id = p_service_agreement_location_id and location.status = 'active';
  if v_agreement is null or not exists(select 1 from public.service_agreement_modules module where module.id = p_service_agreement_module_id and module.service_agreement_id = v_agreement and module.enabled and module.module_key = 'static_guarding') then
    raise exception 'Active static guarding agreement location and module required';
  end if;
  insert into public.roster_work_units(organization_id, name, work_unit_type, service_type, service_agreement_location_id, service_agreement_module_id, created_by)
  values(p_operating_organization_id, trim(p_name), 'static', trim(p_service_type), p_service_agreement_location_id, p_service_agreement_module_id, p_actor_user_id)
  returning * into v_unit;
  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values(p_operating_organization_id, p_actor_user_id, 'roster_work_unit_created', 'roster_work_units', v_unit.id,
    jsonb_build_object('work_unit_type', v_unit.work_unit_type, 'service_type', v_unit.service_type, 'operating_organization_id', p_operating_organization_id));
  return v_unit;
end;
$$;

COMMENT ON FUNCTION public.create_static_roster_work_unit_internal(uuid, uuid, text, text, uuid, uuid) IS
  'Internal. Validates and creates a static roster work unit on an active static guarding agreement location and module, for the provider or (when the provider allows it) a descendant branch, and audits it as roster_work_unit_created. Performs no caller checks; service_role only.';

REVOKE ALL ON FUNCTION public.create_static_roster_work_unit_internal(uuid, uuid, text, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_static_roster_work_unit_internal(uuid, uuid, text, text, uuid, uuid) TO service_role;

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
    select location.service_agreement_id into v_agreement from public.service_agreement_locations location join public.service_agreements agreement on agreement.id = location.service_agreement_id and public.can_set_up_static_post(agreement.provider_organization_id, p_operating_organization_id) where location.id = p_service_agreement_location_id and location.status = 'active';
    if v_agreement is null or not exists(select 1 from public.service_agreement_modules module where module.id = p_service_agreement_module_id and module.service_agreement_id = v_agreement and module.enabled and module.module_key = 'static_guarding') then raise exception 'Active static guarding agreement location and module required'; end if;
    return public.create_static_roster_work_unit_internal(v_actor, p_operating_organization_id, p_name, p_service_type, p_service_agreement_location_id, p_service_agreement_module_id);
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

REVOKE ALL ON FUNCTION public.create_operating_roster_work_unit(uuid, text, text, text, uuid, uuid, uuid, uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_operating_roster_work_unit(uuid, text, text, text, uuid, uuid, uuid, uuid, uuid, uuid) TO authenticated, service_role;
