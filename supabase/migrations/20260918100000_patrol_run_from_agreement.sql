-- 20260918100000_patrol_run_from_agreement.sql
-- Close the gap between an accepted agreement and a rosterable patrol.
--
-- Acceptance writes service_agreement_delivery_schedules and client_site_patrol_config,
-- but the patrol config rows carry no patrol_route_id, and generate_shift_stops only
-- picks configs by patrol_route_id = shifts.patrol_route_id. Nothing in the app created
-- a route or attached configs to one, so a contracted place never became a shift stop.
--
-- This RPC builds (once) a patrol run for an agreement: one patrol_routes row for the
-- provider, the agreement's unrouted contract configs attached to it in stop order,
-- patrol_route_sites rows (access-doctrine trigger validates each), and plan-time
-- patrol_route_stop_modules rows so shift_stop_modules inherit the agreement module
-- and location (contract inheritance in generate_shift_stops).

CREATE OR REPLACE FUNCTION public.create_patrol_route_from_agreement(
  p_client_request_id uuid,
  p_service_agreement_id uuid,
  p_name text DEFAULT NULL
)
RETURNS TABLE(route_id uuid, route_name text, created boolean, attached_places integer, skipped_places integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_agreement public.service_agreements%rowtype;
  v_route public.patrol_routes%rowtype;
  v_config public.client_site_patrol_config%rowtype;
  v_existing_route uuid;
  v_replay uuid;
  v_config_ids uuid[];
  v_name text := nullif(trim(coalesce(p_name, '')), '');
  v_attached integer := 0;
  v_skipped integer := 0;
  v_start time;
  v_end time;
  v_module_id uuid;
  v_location_id uuid;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;

  select * into v_agreement from public.service_agreements where id = p_service_agreement_id;
  if not found then raise exception 'Service agreement not found'; end if;
  if v_agreement.agreement_type <> 'operational' or v_agreement.invitation_status <> 'accepted' then
    raise exception 'A patrol run can only be built from an accepted operational agreement';
  end if;
  if not public.is_admin_for_org(v_agreement.provider_organization_id) then
    raise exception 'Active authorized operating branch administrator required';
  end if;

  -- Idempotent replay on the same client request id.
  select target_id into v_replay from public.audit_log
  where action = 'patrol_route_created_from_agreement' and metadata->>'client_request_id' = p_client_request_id::text
  limit 1;
  if v_replay is not null then
    select * into v_route from public.patrol_routes where id = v_replay;
    return query select v_route.id, v_route.name, false,
      (select count(*)::integer from public.client_site_patrol_config c where c.patrol_route_id = v_route.id), 0;
    return;
  end if;

  -- Contract configs for this agreement (joined through the accepted schedule they came from).
  select array_agg(cspc.id) into v_config_ids
  from public.client_site_patrol_config cspc
  join public.service_agreement_delivery_schedules sads on sads.proposal_scope_schedule_id = cspc.proposal_scope_schedule_id
  where sads.service_agreement_id = v_agreement.id
    and sads.active
    and cspc.organization_id = v_agreement.provider_organization_id
    and cspc.active;

  if v_config_ids is null then
    raise exception 'This agreement has no scheduled patrol places yet. Add delivery schedules in the quote or a variation first';
  end if;

  -- Already routed (fully): return that route instead of making a second one.
  select c.patrol_route_id into v_existing_route from public.client_site_patrol_config c
  where c.id = any(v_config_ids) and c.patrol_route_id is not null limit 1;
  if v_existing_route is not null and not exists (select 1 from public.client_site_patrol_config c where c.id = any(v_config_ids) and c.patrol_route_id is null) then
    select * into v_route from public.patrol_routes where id = v_existing_route;
    return query select v_route.id, v_route.name, false, cardinality(v_config_ids), 0;
    return;
  end if;

  if v_existing_route is not null then
    select * into v_route from public.patrol_routes where id = v_existing_route;
  else
    select min(c.window_start), max(c.window_end) into v_start, v_end from public.client_site_patrol_config c where c.id = any(v_config_ids);
    insert into public.patrol_routes(organization_id, name, description, route_type, assignment_type, checkpoint_mode, default_start_time, default_end_time, is_active)
    values (
      v_agreement.provider_organization_id,
      coalesce(v_name, v_agreement.name || ' patrol run'),
      'Built from the accepted agreement "' || v_agreement.name || '". Stops come from its delivery schedules.',
      'mobile', 'client_patrol', 'none', v_start, v_end, true
    )
    returning * into v_route;
  end if;

  for v_config in
    select cspc.* from public.client_site_patrol_config cspc
    where cspc.id = any(v_config_ids) and cspc.patrol_route_id is null
    order by cspc.preferred_stop_order, cspc.created_at
  loop
    begin
      update public.client_site_patrol_config
      set patrol_route_id = v_route.id, updated_at = now()
      where id = v_config.id;
    exception when unique_violation then
      -- Same site + module already on this route (duplicate schedule); leave it unrouted and report it.
      v_skipped := v_skipped + 1;
      continue;
    end;
    v_attached := v_attached + 1;

    if v_config.site_id is not null then
      insert into public.patrol_route_sites(patrol_route_id, site_id, expected_visits_per_shift, preferred_stop_order, dwell_minutes, sla_arrive_within_minutes, required_module, preferred_time_window, notes)
      values (
        v_route.id, v_config.site_id, v_config.visits_per_shift, v_config.preferred_stop_order, v_config.dwell_minutes, v_config.sla_arrive_within_minutes, v_config.module_key,
        case when v_config.window_start is not null then to_char(v_config.window_start, 'HH24:MI') || '-' || coalesce(to_char(v_config.window_end, 'HH24:MI'), '') end,
        v_config.officer_instructions
      )
      on conflict (patrol_route_id, site_id) do nothing;
    end if;

    -- Contract inheritance for generated stops: which agreement module and covered place this stop serves.
    select sam.id into v_module_id from public.service_agreement_modules sam
    where sam.service_agreement_id = v_agreement.id and sam.enabled
      and sam.module_key = any(case when v_config.module_key = 'general_patrol' then array['patrol', 'general_patrol'] else array[v_config.module_key] end)
    order by case when sam.module_key = v_config.module_key then 0 else 1 end
    limit 1;
    select sal.id into v_location_id from public.service_agreement_locations sal
    where sal.service_agreement_id = v_agreement.id and sal.status = 'active'
      and sal.site_id is not distinct from v_config.site_id and sal.zone_id is not distinct from v_config.zone_id
    limit 1;
    insert into public.patrol_route_stop_modules(organization_id, patrol_config_id, module_key, is_required, display_order, service_agreement_module_id, service_agreement_location_id)
    values (v_agreement.provider_organization_id, v_config.id, v_config.module_key, true, v_config.preferred_stop_order, v_module_id, v_location_id)
    on conflict (patrol_config_id, module_key) do nothing;
  end loop;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_agreement.provider_organization_id, v_actor, 'patrol_route_created_from_agreement', 'patrol_routes', v_route.id,
    jsonb_build_object('client_request_id', p_client_request_id, 'service_agreement_id', v_agreement.id, 'created', v_existing_route is null,
      'attached_places', v_attached, 'skipped_places', v_skipped));

  return query select v_route.id, v_route.name, v_existing_route is null, v_attached, v_skipped;
end;
$$;

REVOKE ALL ON FUNCTION public.create_patrol_route_from_agreement(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_patrol_route_from_agreement(uuid, uuid, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.create_patrol_route_from_agreement(uuid, uuid, text) IS
  'Build (once, idempotent on client_request_id) a patrol route for an accepted operational agreement from its contract-derived client_site_patrol_config rows: creates patrol_routes, sets patrol_route_id on the unrouted configs, adds patrol_route_sites (access-doctrine trigger validates), and seeds patrol_route_stop_modules with the agreement module/location so generated shift stops inherit the contract. Provider admin only; audited.';
