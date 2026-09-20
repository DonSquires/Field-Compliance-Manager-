-- A parent-held agreement can be delivered by a branch (owner walk 2026-09-20, Multi Module client).
-- The variation quote named First Security Nelson as operating provider, so acceptance stamped the patrol configs with
-- the branch; the route builder only accepted configs stamped with the agreement holder (First Security) and refused
-- with "no scheduled patrol places yet" while the panel showed the schedule. It also created the route under the
-- holder, where no branch roster board would ever see it, and matched stop modules on the config's capability label
-- ('general_patrol') instead of the schedule's module ('parking_enforcement').
--   1. create_patrol_route_from_agreement(..., p_operating_organization_id): the route belongs to the delivering
--      branch (named, or inferred from the accepted schedules), which must be the holder or one of its branches.
--   2. Stop modules inherit the schedule's module first.
--   3. Readiness 'Operational work' counts a patrol run whose stops come from this agreement's schedules, not only a
--      static post attributed by location + module (which a patrol agreement could never satisfy).

drop function if exists public.create_patrol_route_from_agreement(uuid, uuid, text);
create or replace function public.create_patrol_route_from_agreement(p_client_request_id uuid, p_service_agreement_id uuid, p_name text default null, p_operating_organization_id uuid default null)
 RETURNS TABLE(route_id uuid, route_name text, created boolean, attached_places integer, skipped_places integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
as $$
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
  v_operating uuid;
  v_schedule_module text;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;

  select * into v_agreement from public.service_agreements where id = p_service_agreement_id;
  if not found then raise exception 'Service agreement not found'; end if;
  if v_agreement.agreement_type <> 'operational' or v_agreement.invitation_status <> 'accepted' then
    raise exception 'A patrol run can only be built from an accepted operational agreement';
  end if;
  -- The route belongs to the branch that delivers. It is named by the caller, otherwise it is the branch whose
  -- accepted schedules (patrol configs) carry this agreement, otherwise the agreement holder itself.
  v_operating := coalesce(p_operating_organization_id,
    (select cspc.organization_id from public.client_site_patrol_config cspc
       join public.service_agreement_delivery_schedules sads on sads.proposal_scope_schedule_id = cspc.proposal_scope_schedule_id
      where sads.service_agreement_id = v_agreement.id and sads.active and cspc.active
      order by cspc.created_at desc limit 1),
    v_agreement.provider_organization_id);
  if v_operating <> v_agreement.provider_organization_id and not (v_operating = any(public.get_descendant_organizations(v_agreement.provider_organization_id))) then
    raise exception 'The operating branch must be the agreement holder or one of its branches';
  end if;
  if not public.is_admin_for_org(v_operating) then
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
    and cspc.organization_id = v_operating
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
      v_operating,
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
    select sads.module_key into v_schedule_module from public.service_agreement_delivery_schedules sads
    where sads.proposal_scope_schedule_id = v_config.proposal_scope_schedule_id and sads.service_agreement_id = v_agreement.id limit 1;
    select sam.id into v_module_id from public.service_agreement_modules sam
    where sam.service_agreement_id = v_agreement.id and sam.enabled
      and sam.module_key = any(array_remove(array[v_schedule_module, v_config.module_key, case when v_config.module_key = 'general_patrol' then 'patrol' end], null))
    order by case when sam.module_key = v_schedule_module then 0 when sam.module_key = v_config.module_key then 1 else 2 end
    limit 1;
    select sal.id into v_location_id from public.service_agreement_locations sal
    where sal.service_agreement_id = v_agreement.id and sal.status = 'active'
      and sal.site_id is not distinct from v_config.site_id and sal.zone_id is not distinct from v_config.zone_id
    limit 1;
    insert into public.patrol_route_stop_modules(organization_id, patrol_config_id, module_key, is_required, display_order, service_agreement_module_id, service_agreement_location_id)
    values (v_operating, v_config.id, coalesce(v_schedule_module, v_config.module_key), true, v_config.preferred_stop_order, v_module_id, v_location_id)
    on conflict (patrol_config_id, module_key) do nothing;
  end loop;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_agreement.provider_organization_id, v_actor, 'patrol_route_created_from_agreement', 'patrol_routes', v_route.id,
    jsonb_build_object('client_request_id', p_client_request_id, 'service_agreement_id', v_agreement.id, 'created', v_existing_route is null,
      'attached_places', v_attached, 'skipped_places', v_skipped, 'operating_organization_id', v_operating));

  return query select v_route.id, v_route.name, v_existing_route is null, v_attached, v_skipped;
end;
$$;

revoke all on function public.create_patrol_route_from_agreement(uuid, uuid, text, uuid) from public, anon;
grant execute on function public.create_patrol_route_from_agreement(uuid, uuid, text, uuid) to authenticated, service_role;

create or replace function public.get_crm_operational_readiness(p_agreement_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
as $$
declare v_actor uuid:=auth.uid();v_agreement public.service_agreements%rowtype;v_location_count integer;v_boundary_ready boolean;v_module_count integer;v_billing_ready boolean;v_work_unit_count integer;v_reporting_ready boolean;
begin
  select sa.* into v_agreement from public.service_agreements sa where sa.id=p_agreement_id;
  if not found then raise exception 'Service agreement not found';end if;
  if v_actor is null or not public.is_admin_for_org(v_agreement.provider_organization_id) then raise exception 'Provider administrator required';end if;
  if v_agreement.agreement_type<>'operational' then raise exception 'Operational agreement required';end if;

  select count(*) into v_location_count from public.service_agreement_locations sal where sal.service_agreement_id=v_agreement.id and sal.status='active';
  select v_location_count>0 and not exists(
    select 1 from public.service_agreement_locations sal
    left join public.client_sites s on s.id=sal.site_id
    left join public.location_zones z on z.id=sal.zone_id
    where sal.service_agreement_id=v_agreement.id and sal.status='active' and (
      (sal.site_id is not null and (s.boundary is null or s.boundary_status<>'authoritative' or s.boundary_verification<>'verified'))
      or (sal.zone_id is not null and (z.boundary is null or not exists(select 1 from public.geofence_boundary_history h where h.entity_type='location_zone' and h.entity_id=z.id and h.verification_state='verified')))
    )
  ) into v_boundary_ready;
  select count(*) into v_module_count from public.service_agreement_modules sam where sam.service_agreement_id=v_agreement.id and sam.enabled;
  select exists(select 1 from public.crm_commercial_settings c where c.service_agreement_id=v_agreement.id and coalesce(c.base_rate_per_hour,c.callout_rate_per_hour,c.travel_rate_per_km)>0)
    or exists(select 1 from public.site_financial_config f join public.service_agreement_locations sal on sal.service_agreement_id=f.service_agreement_id and (sal.site_id=f.site_id or sal.zone_id=f.zone_id) where f.service_agreement_id=v_agreement.id and f.active and sal.status='active' and coalesce(f.hourly_rate,f.per_visit_rate,f.flat_rate_monthly,f.per_notice_rate,f.callout_rate)>0) into v_billing_ready;
  -- a static post attributed directly, or a patrol run whose stops come from this agreement's accepted schedules
  select count(*) into v_work_unit_count from public.roster_work_units wu
  where wu.active and (
    exists (select 1 from public.service_agreement_locations sal join public.service_agreement_modules sam on sam.id=wu.service_agreement_module_id and sam.service_agreement_id=v_agreement.id and sam.enabled
            where sal.id=wu.service_agreement_location_id and sal.service_agreement_id=v_agreement.id and sal.status='active')
    or exists (select 1 from public.client_site_patrol_config c join public.service_agreement_delivery_schedules s on s.proposal_scope_schedule_id=c.proposal_scope_schedule_id
               where c.patrol_route_id=wu.patrol_route_id and c.active and s.service_agreement_id=v_agreement.id and s.active));
  select not v_agreement.client_portal_reports_enabled or (v_agreement.monthly_report_template_code is not null and exists(select 1 from public.report_templates rt where rt.organization_id=v_agreement.provider_organization_id and rt.template_code=v_agreement.monthly_report_template_code)) into v_reporting_ready;

  return jsonb_build_object('agreement_id',v_agreement.id,'invitation_status',v_agreement.invitation_status,'ready',v_agreement.invitation_status='accepted' and v_location_count>0 and v_boundary_ready and v_module_count>0 and v_billing_ready and v_work_unit_count>0 and v_reporting_ready,'dimensions',jsonb_build_array(
    jsonb_build_object('key','coverage','label','Covered places','status',case when v_location_count>0 then 'ready' else 'blocked' end,'detail',case when v_location_count>0 then v_location_count||' active location link'||case when v_location_count=1 then '' else 's' end else 'No active covered site or zone is linked' end,'owner','Account administration','destination','relationships'),
    jsonb_build_object('key','boundary','label','Boundary evidence','status',case when v_boundary_ready then 'ready' else 'blocked' end,'detail',case when v_boundary_ready then 'All covered places have authoritative verified boundaries' else 'Every covered place needs authoritative verified geometry' end,'owner','Operations administration','destination','sites'),
    jsonb_build_object('key','modules','label','Service scope','status',case when v_module_count>0 then 'ready' else 'blocked' end,'detail',case when v_module_count>0 then v_module_count||' enabled service module'||case when v_module_count=1 then '' else 's' end else 'No service module is enabled' end,'owner','Account administration','destination','relationships'),
    jsonb_build_object('key','billing','label','Commercial rates','status',case when v_billing_ready then 'ready' else 'blocked' end,'detail',case when v_billing_ready then 'A positive agreement or covered-place rate is recorded' else 'No positive billable rate is recorded' end,'owner','Commercial administration','destination','crm'),
    jsonb_build_object('key','operations','label','Operational work','status',case when v_work_unit_count>0 then 'ready' else 'blocked' end,'detail',case when v_work_unit_count>0 then v_work_unit_count||' active attributed work unit'||case when v_work_unit_count=1 then '' else 's' end else 'No active work unit is attributed to this agreement' end,'owner','Roster administration','destination','roster-targets'),
    jsonb_build_object('key','reporting','label','Reporting delivery','status',case when v_reporting_ready then 'ready' else 'blocked' end,'detail',case when not v_agreement.client_portal_reports_enabled then 'Client report delivery is disabled by contract' when v_reporting_ready then 'The configured monthly template exists for the provider' else 'Client reporting is enabled without a valid monthly template' end,'owner','Reporting administration','destination','reports')
  ));
end;$$;
REVOKE ALL ON FUNCTION "public"."get_crm_operational_readiness"(p_agreement_id uuid) FROM PUBLIC, "anon", "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION "public"."get_crm_operational_readiness"(p_agreement_id uuid) TO "postgres";
GRANT EXECUTE ON FUNCTION "public"."get_crm_operational_readiness"(p_agreement_id uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."get_crm_operational_readiness"(p_agreement_id uuid) TO "service_role";

CREATE OR REPLACE FUNCTION "public"."get_crm_organization_readiness"(p_organization_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS TABLE(organization_id uuid, organization_status text, identity_status text, contact_status text, location_status text, agreement_status text, module_status text, billing_status text, operations_status text, blockers text[], next_action text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
as $$
DECLARE
  v_actor uuid := auth.uid();
  v_provider uuid;
BEGIN
  SELECT actor.organization_id INTO v_provider
  FROM public.user_profiles actor
  WHERE actor.id = v_actor AND actor.deactivated_at IS NULL;

  IF v_provider IS NULL OR NOT public.is_admin_for_org(v_provider) THEN
    RAISE EXCEPTION 'Active CRM administrator required';
  END IF;

  RETURN QUERY
  WITH accounts AS (
    SELECT o.*
    FROM public.organizations o
    WHERE o.parent_organization_id = ANY(public.get_descendant_organizations(v_provider))
      AND (p_organization_ids IS NULL OR o.id = ANY(p_organization_ids))
  ), facts AS (
    SELECT
      a.id,
      a.status,
      (a.name <> '' AND a.organization_type IS NOT NULL) AS identity_ready,
      EXISTS(SELECT 1 FROM public.crm_contacts c WHERE c.organization_id = a.id AND c.is_primary AND c.deactivated_at IS NULL) AS contact_ready,
      EXISTS(SELECT 1 FROM public.client_sites s WHERE s.client_organization_id = a.id AND s.active) AS location_ready,
      EXISTS(
        SELECT 1 FROM public.service_agreements sa
        WHERE sa.provider_organization_id = ANY(public.get_descendant_organizations(v_provider))
          AND sa.client_organization_id = a.id
          AND sa.invitation_status = 'accepted'
      ) AS agreement_ready,
      EXISTS(
        SELECT 1 FROM public.service_agreements sa
        WHERE sa.provider_organization_id = ANY(public.get_descendant_organizations(v_provider))
          AND sa.client_organization_id = a.id
          AND sa.invitation_status = 'accepted'
          AND cardinality(sa.enabled_modules) > 0
      ) AS module_ready,
      EXISTS(
        SELECT 1
        FROM public.service_agreements sa
        JOIN public.crm_commercial_settings cc ON cc.service_agreement_id = sa.id
        WHERE sa.provider_organization_id = ANY(public.get_descendant_organizations(v_provider))
          AND sa.client_organization_id = a.id
      ) AS billing_ready,
      EXISTS(
        SELECT 1
        FROM public.roster_work_units wu
        JOIN public.service_agreement_locations sal ON sal.id = wu.service_agreement_location_id
        JOIN public.service_agreements sa ON sa.id = sal.service_agreement_id
        WHERE sa.provider_organization_id = ANY(public.get_descendant_organizations(v_provider))
          AND sa.client_organization_id = a.id
          AND wu.active
      ) AS operations_ready
    FROM accounts a
  )
  SELECT
    f.id,
    f.status,
    CASE WHEN f.identity_ready THEN 'ready' ELSE 'blocked' END,
    CASE WHEN f.contact_ready THEN 'ready' ELSE 'blocked' END,
    CASE WHEN f.location_ready THEN 'ready' ELSE 'blocked' END,
    CASE WHEN f.agreement_ready THEN 'ready' ELSE 'blocked' END,
    CASE WHEN f.module_ready THEN 'ready' ELSE 'blocked' END,
    CASE WHEN f.billing_ready THEN 'ready' ELSE 'blocked' END,
    CASE WHEN f.operations_ready THEN 'ready' ELSE 'blocked' END,
    array_remove(ARRAY[
      CASE WHEN NOT f.identity_ready THEN 'Confirm the organization identity' END,
      CASE WHEN NOT f.contact_ready THEN 'Add a primary contact' END,
      CASE WHEN NOT f.location_ready THEN 'Add an active covered site' END,
      CASE WHEN NOT f.agreement_ready THEN 'Create and accept a service agreement' END,
      CASE WHEN NOT f.module_ready THEN 'Enable at least one agreement module' END,
      CASE WHEN NOT f.billing_ready THEN 'Complete commercial settings' END,
      CASE WHEN NOT f.operations_ready THEN 'Create an operational work unit' END
    ], NULL),
    CASE
      WHEN NOT f.contact_ready THEN 'Add primary contact'
      WHEN NOT f.location_ready THEN 'Add covered site'
      WHEN NOT f.agreement_ready THEN 'Create service agreement'
      WHEN NOT f.module_ready THEN 'Enable service modules'
      WHEN NOT f.billing_ready THEN 'Complete billing setup'
      WHEN NOT f.operations_ready THEN 'Complete operational setup'
      ELSE 'Ready for activation review'
    END
  FROM facts f
  ORDER BY f.id;
END;
$$;

