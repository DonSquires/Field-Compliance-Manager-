-- Setting up a client in plain steps: who they are, where we work, what we do there, who logs in.
--
-- Owner feedback 2026-09-21: setting up a client was "extremely confusing" — a new client, a place, and a module
-- each lived on a different island with its own words (portfolio, onboarding ledger, proposal scope schedule,
-- facet, variation), and the order was forced: places and modules could only be configured on an agreement the
-- client had already accepted, a client could not be invited without an "active zone", and a patrol schedule
-- existed only if it had come through a quote. This migration gives the guided "Set up a new client" walk one
-- governed writer per step over the existing spine (organizations / crm_contacts / client_sites /
-- service_agreements / service_agreement_modules / service_agreement_locations /
-- service_agreement_delivery_schedules / client_site_patrol_config):
--  * ensure_crm_client_agreement: the live operational agreement between the operating branch and the client,
--    created (not_invited, transparency_only) when there is none. The invite is a separate, optional step.
--  * manage_crm_agreement_delivery_schedule: a contracted schedule for a place + module (days ISO 1–7, window,
--    visits, gap, dwell) written straight to the delivery schedule AND its patrol config, linked by the new
--    client_site_patrol_config.delivery_schedule_id (quote acceptance now sets it too; every reader joins on
--    either link). Patrol runs, readiness, roster coverage and the officer's stops work identically whichever
--    path created the schedule.
--  * manage_crm_agreement_setup / _zone_coverage / create_patrol_route_from_agreement accept any live
--    operational agreement (not_invited, invited, accepted): the provider records what it has been contracted to
--    do; the client's acceptance is portal access, not permission to configure. (Ruling recorded in
--    docs/canon/ORG_SERVICE_MODEL.md, 2026-09-21.)
--  * prepare_crm_client_invitation needs a place (site or area), not specifically a zone.

ALTER TABLE public.client_site_patrol_config
  ADD COLUMN IF NOT EXISTS delivery_schedule_id uuid REFERENCES public.service_agreement_delivery_schedules(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS client_site_patrol_config_delivery_schedule_uidx
  ON public.client_site_patrol_config(delivery_schedule_id) WHERE delivery_schedule_id IS NOT NULL;
COMMENT ON COLUMN public.client_site_patrol_config.delivery_schedule_id IS 'The agreement delivery schedule this patrol config implements. Set directly by manage_crm_agreement_delivery_schedule, and by quote acceptance alongside proposal_scope_schedule_id.';

UPDATE public.client_site_patrol_config c
SET delivery_schedule_id = d.id
FROM public.service_agreement_delivery_schedules d
WHERE c.delivery_schedule_id IS NULL AND c.proposal_scope_schedule_id IS NOT NULL AND d.proposal_scope_schedule_id = c.proposal_scope_schedule_id;



CREATE OR REPLACE FUNCTION public.activate_quote_proposal_scope_schedules()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF new.status='accepted' AND new.service_agreement_id IS NOT NULL AND old.status IS DISTINCT FROM 'accepted' THEN
    INSERT INTO public.service_agreement_delivery_schedules(service_agreement_id,proposal_scope_schedule_id,site_id,zone_id,module_key,capability_key,work_model,active_days,active_months,visits_per_shift,min_gap_between_visits_minutes,window_start,window_end,response_sla_minutes,depart_sla_minutes,dwell_minutes,preferred_stop_order,pricing_basis,rate_rule_id,chargeable_conditions,notes,officer_instructions)
    SELECT new.service_agreement_id,schedule.id,coalesce(scope.site_id,place.converted_site_id),coalesce(scope.zone_id,place.converted_zone_id),scope.module_key,schedule.capability_key,schedule.work_model,schedule.active_days,schedule.active_months,schedule.visits_per_shift,schedule.min_gap_between_visits_minutes,schedule.window_start,schedule.window_end,schedule.response_sla_minutes,schedule.depart_sla_minutes,schedule.dwell_minutes,schedule.preferred_stop_order,schedule.pricing_basis,schedule.rate_rule_id,schedule.chargeable_conditions,schedule.notes,schedule.officer_instructions
    FROM public.quote_proposal_scope_schedules schedule
    JOIN public.quote_proposal_service_scopes scope ON scope.id=schedule.proposal_scope_id
    LEFT JOIN public.quote_proposal_places place ON place.id=scope.proposed_place_id
    WHERE scope.quote_id=new.id
    ON CONFLICT(proposal_scope_schedule_id) DO NOTHING;

    INSERT INTO public.client_site_patrol_config(organization_id,site_id,zone_id,module_key,active_days,visits_per_shift,min_gap_between_visits_minutes,time_window_type,window_start,window_end,active_months,dwell_minutes,sla_arrive_within_minutes,sla_depart_within_minutes,preferred_stop_order,officer_instructions,proposal_scope_schedule_id,delivery_schedule_id)
    SELECT new.provider_org_id,coalesce(scope.site_id,place.converted_site_id),coalesce(scope.zone_id,place.converted_zone_id),
      CASE schedule.capability_key WHEN 'patrol' THEN 'general_patrol' ELSE schedule.capability_key END,
      schedule.active_days,schedule.visits_per_shift,schedule.min_gap_between_visits_minutes,
      'fixed',schedule.window_start,schedule.window_end,schedule.active_months,schedule.dwell_minutes,
      coalesce(schedule.response_sla_minutes,30),coalesce(schedule.depart_sla_minutes,45),
      schedule.preferred_stop_order,schedule.officer_instructions,schedule.id,
      (SELECT d.id FROM public.service_agreement_delivery_schedules d WHERE d.proposal_scope_schedule_id = schedule.id)
    FROM public.quote_proposal_scope_schedules schedule
    JOIN public.quote_proposal_service_scopes scope ON scope.id=schedule.proposal_scope_id
    LEFT JOIN public.quote_proposal_places place ON place.id=scope.proposed_place_id
    WHERE scope.quote_id=new.id AND schedule.capability_key<>'alarm_response'
    ON CONFLICT (proposal_scope_schedule_id) WHERE proposal_scope_schedule_id IS NOT NULL DO NOTHING;
  END IF;
  RETURN new;
END;$function$
;

CREATE OR REPLACE FUNCTION public.create_patrol_route_from_agreement(p_client_request_id uuid, p_service_agreement_id uuid, p_name text DEFAULT NULL::text, p_operating_organization_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(route_id uuid, route_name text, created boolean, attached_places integer, skipped_places integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  if v_agreement.agreement_type <> 'operational' or v_agreement.invitation_status not in ('not_invited', 'invited', 'accepted') then
    raise exception 'A patrol run can only be built from a live operational agreement';
  end if;
  -- The route belongs to the branch that delivers. It is named by the caller, otherwise it is the branch whose
  -- accepted schedules (patrol configs) carry this agreement, otherwise the agreement holder itself.
  v_operating := coalesce(p_operating_organization_id,
    (select cspc.organization_id from public.client_site_patrol_config cspc
       join public.service_agreement_delivery_schedules sads on (cspc.delivery_schedule_id = sads.id OR (cspc.proposal_scope_schedule_id IS NOT NULL AND sads.proposal_scope_schedule_id = cspc.proposal_scope_schedule_id))
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
  join public.service_agreement_delivery_schedules sads on (cspc.delivery_schedule_id = sads.id OR (cspc.proposal_scope_schedule_id IS NOT NULL AND sads.proposal_scope_schedule_id = cspc.proposal_scope_schedule_id))
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
    where (v_config.delivery_schedule_id = sads.id OR (v_config.proposal_scope_schedule_id IS NOT NULL AND sads.proposal_scope_schedule_id = v_config.proposal_scope_schedule_id)) and sads.service_agreement_id = v_agreement.id limit 1;
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
$function$
;

CREATE OR REPLACE FUNCTION public.get_crm_operational_readiness(p_agreement_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    or exists (select 1 from public.client_site_patrol_config c join public.service_agreement_delivery_schedules s on (c.delivery_schedule_id = s.id OR (c.proposal_scope_schedule_id IS NOT NULL AND s.proposal_scope_schedule_id = c.proposal_scope_schedule_id))
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
end;$function$
;

CREATE OR REPLACE FUNCTION public.get_crm_organization_readiness(p_organization_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS TABLE(organization_id uuid, organization_status text, identity_status text, contact_status text, location_status text, agreement_status text, module_status text, billing_status text, operations_status text, blockers text[], next_action text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
        -- a static post attributed to a covered place, or a patrol run whose stops come from an accepted schedule
        SELECT 1
        FROM public.roster_work_units wu
        JOIN public.service_agreements sa ON (
          sa.id = (SELECT sal.service_agreement_id FROM public.service_agreement_locations sal WHERE sal.id = wu.service_agreement_location_id)
          OR sa.id IN (SELECT s.service_agreement_id FROM public.client_site_patrol_config c JOIN public.service_agreement_delivery_schedules s ON (c.delivery_schedule_id = s.id OR (c.proposal_scope_schedule_id IS NOT NULL AND s.proposal_scope_schedule_id = c.proposal_scope_schedule_id)) WHERE c.patrol_route_id = wu.patrol_route_id AND c.active AND s.active)
        )
        WHERE sa.provider_organization_id = ANY(public.get_descendant_organizations(v_provider))
          AND sa.client_organization_id = a.id
          AND (sa.ends_on IS NULL OR sa.ends_on >= current_date)
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
      WHEN f.status = 'active' AND f.contact_ready AND f.location_ready AND f.agreement_ready AND f.module_ready AND f.billing_ready AND f.operations_ready THEN 'Active: roster the work units and deliver'
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
$function$
;

CREATE OR REPLACE FUNCTION public.manage_crm_agreement_setup(p_agreement_id uuid, p_expected_invitation_status text, p_action text, p_site_id uuid DEFAULT NULL::uuid, p_module_key text DEFAULT NULL::text, p_enabled boolean DEFAULT true, p_sla_minutes integer DEFAULT NULL::integer, p_allows_client_submission boolean DEFAULT false, p_allows_auto_dispatch boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_actor uuid:=auth.uid();v_agreement public.service_agreements%rowtype;v_link public.service_agreement_locations%rowtype;v_module public.service_agreement_modules%rowtype;
begin
  select sa.* into v_agreement from public.service_agreements sa where sa.id=p_agreement_id for update;
  if not found then raise exception 'Service agreement not found';end if;
  if v_actor is null or not public.is_admin_for_org(v_agreement.provider_organization_id) then raise exception 'Provider administrator required';end if;
  if v_agreement.agreement_type<>'operational' or v_agreement.invitation_status not in ('not_invited','invited','accepted') then raise exception 'Only live operational agreements can be configured';end if;
  if v_agreement.invitation_status is distinct from p_expected_invitation_status then raise exception 'Service agreement changed since it was opened';end if;
  if p_action in('link_site','unlink_site') then
    if p_site_id is null or not exists(select 1 from public.client_sites s where s.id=p_site_id and s.client_organization_id=v_agreement.client_organization_id and s.active) then raise exception 'Active client site required';end if;
    if p_action='link_site' then
      insert into public.service_agreement_locations(service_agreement_id,site_id,status,created_by) values(v_agreement.id,p_site_id,'active',v_actor)
      on conflict(service_agreement_id,site_id) do update set status='active',updated_at=clock_timestamp() returning * into v_link;
    else
      update public.service_agreement_locations set status='ended',updated_at=clock_timestamp() where service_agreement_id=v_agreement.id and site_id=p_site_id returning * into v_link;
      if not found then raise exception 'Covered site link not found';end if;
    end if;
  elsif p_action='set_module' then
    if p_module_key is null or not exists(select 1 from public.module_catalog mc where mc.module_key=p_module_key and mc.active) then raise exception 'Active module catalog entry required';end if;
    if p_sla_minutes is not null and (p_sla_minutes<1 or p_sla_minutes>10080) then raise exception 'Module SLA must be between 1 and 10080 minutes';end if;
    insert into public.service_agreement_modules(service_agreement_id,module_key,enabled,sla_minutes,allows_client_submission,allows_auto_dispatch)
    values(v_agreement.id,p_module_key,coalesce(p_enabled,true),p_sla_minutes,p_allows_client_submission,p_allows_auto_dispatch)
    on conflict(service_agreement_id,module_key) do update set enabled=excluded.enabled,sla_minutes=excluded.sla_minutes,allows_client_submission=excluded.allows_client_submission,allows_auto_dispatch=excluded.allows_auto_dispatch returning * into v_module;
    update public.service_agreements set enabled_modules=coalesce((select array_agg(sam.module_key order by sam.module_key) from public.service_agreement_modules sam where sam.service_agreement_id=v_agreement.id and sam.enabled),'{}'::text[]) where id=v_agreement.id returning * into v_agreement;
  else raise exception 'Unsupported agreement setup action';end if;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  values(v_agreement.provider_organization_id,v_actor,'crm_agreement_'||p_action,'service_agreements',v_agreement.id,jsonb_build_object('site_id',p_site_id,'module_key',p_module_key,'enabled',p_enabled,'sla_minutes',p_sla_minutes));
  return jsonb_build_object('agreement_id',v_agreement.id,'action',p_action,'site_link_id',v_link.id,'module_id',v_module.id,'enabled_modules',v_agreement.enabled_modules);
end;$function$
;

CREATE OR REPLACE FUNCTION public.manage_crm_agreement_zone_coverage(p_agreement_id uuid, p_expected_invitation_status text, p_action text, p_zone_id uuid)
 RETURNS service_agreement_locations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_actor uuid:=auth.uid();v_agreement public.service_agreements%rowtype;v_link public.service_agreement_locations%rowtype;
BEGIN
  SELECT sa.* INTO v_agreement FROM public.service_agreements sa WHERE sa.id=p_agreement_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Service agreement not found';END IF;
  IF v_actor IS NULL OR NOT public.is_admin_for_org(v_agreement.provider_organization_id) THEN RAISE EXCEPTION 'Provider administrator required';END IF;
  IF v_agreement.agreement_type<>'operational' OR v_agreement.invitation_status NOT IN ('not_invited','invited','accepted') THEN RAISE EXCEPTION 'Only live operational agreements can be configured';END IF;
  IF v_agreement.invitation_status IS DISTINCT FROM p_expected_invitation_status THEN RAISE EXCEPTION 'Service agreement changed since it was opened';END IF;
  IF p_action NOT IN ('link_zone','unlink_zone') THEN RAISE EXCEPTION 'Unsupported agreement zone coverage action';END IF;
  IF p_zone_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.location_zones z WHERE z.id=p_zone_id AND z.organization_id=v_agreement.client_organization_id AND z.is_active) THEN RAISE EXCEPTION 'Active client zone required';END IF;
  IF p_action='link_zone' THEN
    INSERT INTO public.service_agreement_locations(service_agreement_id,zone_id,status,created_by) VALUES(v_agreement.id,p_zone_id,'active',v_actor)
    ON CONFLICT(service_agreement_id,zone_id) DO UPDATE SET status='active',updated_at=clock_timestamp() RETURNING * INTO v_link;
  ELSE
    UPDATE public.service_agreement_locations SET status='ended',updated_at=clock_timestamp() WHERE service_agreement_id=v_agreement.id AND zone_id=p_zone_id RETURNING * INTO v_link;
    IF NOT FOUND THEN RAISE EXCEPTION 'Covered zone link not found';END IF;
  END IF;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) VALUES(v_agreement.provider_organization_id,v_actor,'crm_agreement_'||p_action,'service_agreement_locations',v_link.id,jsonb_build_object('agreement_id',v_agreement.id,'zone_id',p_zone_id,'status',v_link.status));
  RETURN v_link;
END;$function$
;

CREATE OR REPLACE FUNCTION public.prepare_crm_client_invitation(p_account_organization_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_provider uuid;
  v_account public.organizations%rowtype;
  v_contact public.crm_contacts%rowtype;
  v_agreement public.service_agreements%rowtype;
  v_site_count integer;
  v_zone_count integer;
BEGIN
  SELECT organization_id INTO v_provider FROM public.user_profiles WHERE id = v_actor AND deactivated_at IS NULL;
  IF v_provider IS NULL OR NOT public.is_admin_for_org(v_provider) THEN RAISE EXCEPTION 'Active provider CRM administrator required'; END IF;
  SELECT * INTO v_account FROM public.organizations WHERE id = p_account_organization_id AND status = 'prospect' AND NOT active FOR UPDATE;
  IF NOT FOUND OR NOT public.crm_actor_can_manage_account(v_account.id) THEN RAISE EXCEPTION 'Managed prospect account not found'; END IF;

  SELECT * INTO v_contact FROM public.crm_contacts WHERE organization_id = v_account.id AND is_primary AND deactivated_at IS NULL ORDER BY updated_at DESC LIMIT 1;
  IF v_contact.email IS NULL AND v_account.contact_email IS NOT NULL THEN
    v_contact.email := lower(trim(v_account.contact_email));
  END IF;
  IF v_contact.email IS NULL THEN RAISE EXCEPTION 'A primary client contact email is required before inviting the client'; END IF;

  SELECT count(*) INTO v_site_count FROM public.client_sites WHERE client_organization_id = v_account.id AND active;
  SELECT count(*) INTO v_zone_count
  FROM public.location_zones zone
  JOIN public.locations location ON location.id = zone.location_id
  WHERE location.organization_id = v_account.id AND zone.is_active;
  IF v_site_count = 0 AND v_zone_count = 0 THEN RAISE EXCEPTION 'Add at least one place (a site address or an area) before inviting the client'; END IF;

  SELECT * INTO v_agreement
  FROM public.service_agreements
  WHERE provider_organization_id = ANY(public.get_descendant_organizations(v_provider)) AND client_organization_id = v_account.id AND agreement_type = 'operational'
    AND (ends_on IS NULL OR ends_on >= current_date)
  ORDER BY CASE WHEN invitation_status = 'accepted' THEN 0 WHEN invitation_status = 'invited' THEN 1 ELSE 2 END, created_at DESC
  LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    -- the branch that manages the account holds the agreement; the actor's own organisation only when the account is parented to it
    INSERT INTO public.service_agreements (provider_organization_id, client_organization_id, name, starts_on, agreement_type, invitation_status, client_portal_access_mode, external_refs)
    VALUES (CASE WHEN v_account.parent_organization_id = ANY(public.get_descendant_organizations(v_provider)) THEN v_account.parent_organization_id ELSE v_provider END,
      v_account.id, v_account.name || ' service agreement', current_date, 'operational', 'not_invited', 'transparency_only', jsonb_build_object('created_for_client_invite', true, 'created_by', v_actor))
    RETURNING * INTO v_agreement;
  END IF;
  IF EXISTS (SELECT 1 FROM public.user_profiles cu WHERE cu.organization_id = v_account.id AND cu.deactivated_at IS NULL) THEN RAISE EXCEPTION 'This client already has a user who can sign in; add more people from their own administrator account'; END IF;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_provider, v_actor, 'crm_client_invitation_prepared', 'service_agreements', v_agreement.id,
    jsonb_build_object('account_organization_id', v_account.id, 'site_count', v_site_count, 'zone_count', v_zone_count, 'contact_email', v_contact.email));
  RETURN jsonb_build_object('account_organization_id', v_account.id, 'agreement_id', v_agreement.id, 'provider_organization_id', v_agreement.provider_organization_id, 'agreement_status', v_agreement.invitation_status, 'email', lower(trim(v_contact.email)), 'display_name', trim(coalesce(v_contact.first_name, '') || ' ' || coalesce(v_contact.last_name, '')), 'site_count', v_site_count, 'zone_count', v_zone_count);
END;
$function$
;


CREATE OR REPLACE FUNCTION public.ensure_crm_client_agreement(p_account_organization_id uuid, p_provider_organization_id uuid DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_home uuid;
  v_provider uuid;
  v_account public.organizations%rowtype;
  v_agreement public.service_agreements%rowtype;
  v_created boolean := false;
BEGIN
  SELECT organization_id INTO v_home FROM public.user_profiles WHERE id = v_actor AND deactivated_at IS NULL;
  IF v_home IS NULL THEN RAISE EXCEPTION 'Active CRM administrator required'; END IF;
  v_provider := coalesce(p_provider_organization_id, v_home);
  IF NOT public.is_admin_for_org(v_provider) THEN RAISE EXCEPTION 'Not authorised to hold agreements for this organisation'; END IF;
  SELECT * INTO v_account FROM public.organizations WHERE id = p_account_organization_id FOR UPDATE;
  IF NOT FOUND OR NOT public.crm_actor_can_manage_account(v_account.id) THEN RAISE EXCEPTION 'Client account not found'; END IF;
  IF v_account.id = v_provider THEN RAISE EXCEPTION 'An organisation cannot be its own client'; END IF;

  SELECT * INTO v_agreement
  FROM public.service_agreements
  WHERE provider_organization_id = v_provider AND client_organization_id = v_account.id AND agreement_type = 'operational'
    AND (ends_on IS NULL OR ends_on >= current_date)
  ORDER BY CASE WHEN invitation_status = 'accepted' THEN 0 WHEN invitation_status = 'invited' THEN 1 ELSE 2 END, created_at DESC
  LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.service_agreements (provider_organization_id, client_organization_id, name, starts_on, agreement_type, invitation_status, client_portal_access_mode, external_refs)
    VALUES (v_provider, v_account.id, v_account.name || ' service agreement', current_date, 'operational', 'not_invited', 'transparency_only', jsonb_build_object('created_via', 'client_setup', 'created_by', v_actor))
    RETURNING * INTO v_agreement;
    v_created := true;
    INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
    VALUES (v_provider, v_actor, 'service_agreement_created', 'service_agreements', v_agreement.id, jsonb_build_object('client_organization_id', v_account.id, 'via', 'client_setup'));
  END IF;
  RETURN jsonb_build_object('agreement_id', v_agreement.id, 'created', v_created, 'invitation_status', v_agreement.invitation_status,
    'provider_organization_id', v_agreement.provider_organization_id, 'client_organization_id', v_agreement.client_organization_id, 'name', v_agreement.name);
END;
$function$;
COMMENT ON FUNCTION public.ensure_crm_client_agreement(uuid, uuid) IS 'The live operational agreement between the operating organisation (default: the caller''s home) and a client account, created not_invited / transparency_only when none exists. Used by the guided client setup so places and services can be recorded before the client is invited.';
REVOKE ALL ON FUNCTION public.ensure_crm_client_agreement(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ensure_crm_client_agreement(uuid, uuid) TO authenticated, service_role;



CREATE OR REPLACE FUNCTION public.manage_crm_agreement_delivery_schedule(
  p_client_request_id uuid, p_agreement_id uuid, p_action text, p_schedule_id uuid DEFAULT NULL,
  p_site_id uuid DEFAULT NULL, p_zone_id uuid DEFAULT NULL, p_module_key text DEFAULT NULL,
  p_active_days integer[] DEFAULT NULL, p_window_start time DEFAULT NULL, p_window_end time DEFAULT NULL,
  p_visits_per_shift integer DEFAULT 1, p_min_gap_between_visits_minutes integer DEFAULT 60, p_dwell_minutes integer DEFAULT 10,
  p_officer_instructions text DEFAULT NULL, p_operating_organization_id uuid DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_agreement public.service_agreements%rowtype;
  v_schedule public.service_agreement_delivery_schedules%rowtype;
  v_config public.client_site_patrol_config%rowtype;
  v_operating uuid;
  v_days integer[];
  v_capability text;
  v_config_module text;
  v_toolset text;
  v_place_ok boolean;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required'; END IF;
  IF p_action NOT IN ('create', 'update', 'remove') THEN RAISE EXCEPTION 'Unsupported schedule action'; END IF;
  SELECT * INTO v_agreement FROM public.service_agreements WHERE id = p_agreement_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Service agreement not found'; END IF;
  IF NOT public.is_admin_for_org(v_agreement.provider_organization_id) THEN RAISE EXCEPTION 'Provider administrator required'; END IF;
  IF v_agreement.agreement_type <> 'operational' OR v_agreement.invitation_status NOT IN ('not_invited', 'invited', 'accepted')
     OR (v_agreement.ends_on IS NOT NULL AND v_agreement.ends_on < current_date) THEN
    RAISE EXCEPTION 'Only live operational agreements can carry a delivery schedule';
  END IF;

  -- Idempotent replay of a create.
  IF p_action = 'create' AND EXISTS (SELECT 1 FROM public.audit_log a WHERE a.action = 'crm_delivery_schedule_create' AND a.metadata->>'client_request_id' = p_client_request_id::text) THEN
    SELECT s.* INTO v_schedule FROM public.service_agreement_delivery_schedules s
    WHERE s.id = (SELECT (a.metadata->>'schedule_id')::uuid FROM public.audit_log a WHERE a.action = 'crm_delivery_schedule_create' AND a.metadata->>'client_request_id' = p_client_request_id::text LIMIT 1);
    RETURN jsonb_build_object('schedule_id', v_schedule.id, 'replayed', true);
  END IF;

  IF p_action = 'remove' THEN
    SELECT * INTO v_schedule FROM public.service_agreement_delivery_schedules WHERE id = p_schedule_id AND service_agreement_id = v_agreement.id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Delivery schedule not found on this agreement'; END IF;
    UPDATE public.service_agreement_delivery_schedules SET active = false WHERE id = v_schedule.id;
    UPDATE public.client_site_patrol_config SET active = false, updated_at = clock_timestamp() WHERE delivery_schedule_id = v_schedule.id;
    INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
    VALUES (v_agreement.provider_organization_id, v_actor, 'crm_delivery_schedule_remove', 'service_agreement_delivery_schedules', v_schedule.id, jsonb_build_object('client_request_id', p_client_request_id, 'agreement_id', v_agreement.id));
    RETURN jsonb_build_object('schedule_id', v_schedule.id, 'removed', true);
  END IF;

  -- Validate the place, the module and the schedule shape.
  IF (p_site_id IS NULL) = (p_zone_id IS NULL) THEN RAISE EXCEPTION 'Choose one place: a site or an area'; END IF;
  IF p_site_id IS NOT NULL THEN
    SELECT EXISTS (SELECT 1 FROM public.client_sites s WHERE s.id = p_site_id AND s.client_organization_id = v_agreement.client_organization_id AND s.active) INTO v_place_ok;
  ELSE
    SELECT EXISTS (SELECT 1 FROM public.location_zones z JOIN public.locations l ON l.id = z.location_id WHERE z.id = p_zone_id AND z.is_active
                   AND (l.organization_id = v_agreement.client_organization_id OR z.organization_id = v_agreement.provider_organization_id)) INTO v_place_ok;
  END IF;
  IF NOT v_place_ok THEN RAISE EXCEPTION 'That place does not belong to this client'; END IF;
  IF p_module_key IS NULL OR NOT EXISTS (SELECT 1 FROM public.module_catalog m WHERE m.module_key = p_module_key AND m.active) THEN RAISE EXCEPTION 'Choose an active service (module)'; END IF;
  IF p_module_key = 'static_guarding' THEN RAISE EXCEPTION 'A guard on post is covered by the place and the module; it does not take a visit schedule'; END IF;
  v_days := (SELECT coalesce(array_agg(DISTINCT d ORDER BY d), '{}') FROM unnest(coalesce(p_active_days, '{1,2,3,4,5,6,7}'::integer[])) d WHERE d BETWEEN 1 AND 7);
  IF cardinality(v_days) = 0 THEN RAISE EXCEPTION 'Choose at least one day of the week (Monday = 1)'; END IF;
  IF (p_window_start IS NULL) <> (p_window_end IS NULL) THEN RAISE EXCEPTION 'Set both window times, or neither for any time of day'; END IF;
  IF p_visits_per_shift IS NULL OR p_visits_per_shift < 1 OR p_visits_per_shift > 24 THEN RAISE EXCEPTION 'Visits per shift must be between 1 and 24'; END IF;
  IF p_min_gap_between_visits_minutes IS NULL OR p_min_gap_between_visits_minutes < 0 OR p_min_gap_between_visits_minutes > 720 THEN RAISE EXCEPTION 'Minimum gap must be between 0 and 720 minutes'; END IF;
  IF p_dwell_minutes IS NULL OR p_dwell_minutes < 0 OR p_dwell_minutes > 480 THEN RAISE EXCEPTION 'Time on site must be between 0 and 480 minutes'; END IF;
  v_operating := coalesce(p_operating_organization_id, v_agreement.provider_organization_id);
  IF NOT (v_operating = v_agreement.provider_organization_id OR v_operating = ANY(public.get_descendant_organizations(v_agreement.provider_organization_id))) THEN
    RAISE EXCEPTION 'The operating branch must be the agreement holder or one of its branches';
  END IF;
  v_capability := CASE WHEN p_module_key IN ('dispatch', 'alarm_response') THEN 'alarm_response' WHEN p_module_key = 'noise_control' THEN 'noise_control' WHEN p_module_key = 'freedom_camping' THEN 'freedom_camping' ELSE 'patrol' END;
  -- The catalog module is what the agreement covers; the toolset key is what the officer does at the stop.
  v_toolset := CASE p_module_key WHEN 'patrol' THEN 'general_patrol' WHEN 'dispatch' THEN 'alarm_response' WHEN 'welfare' THEN 'welfare_check' ELSE p_module_key END;
  IF v_toolset NOT IN ('freedom_camping', 'parking_enforcement', 'noise_control', 'biosecurity', 'smoke_complaints', 'access_control', 'ems', 'alarm_response', 'welfare_check', 'general_patrol') THEN
    RAISE EXCEPTION 'This service is not delivered as visits to a place';
  END IF;
  v_config_module := CASE WHEN v_capability = 'patrol' THEN 'general_patrol' ELSE v_capability END;

  -- The module and the place are on the agreement (idempotent).
  INSERT INTO public.service_agreement_modules(service_agreement_id, module_key, enabled)
  VALUES (v_agreement.id, p_module_key, true)
  ON CONFLICT (service_agreement_id, module_key) DO UPDATE SET enabled = true;
  UPDATE public.service_agreements SET enabled_modules = coalesce((SELECT array_agg(sam.module_key ORDER BY sam.module_key) FROM public.service_agreement_modules sam WHERE sam.service_agreement_id = v_agreement.id AND sam.enabled), '{}') WHERE id = v_agreement.id;
  IF p_site_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.service_agreement_locations l WHERE l.service_agreement_id = v_agreement.id AND l.site_id = p_site_id AND l.status = 'active') THEN
    INSERT INTO public.service_agreement_locations(service_agreement_id, site_id, status, created_by) VALUES (v_agreement.id, p_site_id, 'active', v_actor);
  END IF;
  IF p_zone_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.service_agreement_locations l WHERE l.service_agreement_id = v_agreement.id AND l.zone_id = p_zone_id AND l.status = 'active') THEN
    INSERT INTO public.service_agreement_locations(service_agreement_id, zone_id, status, created_by) VALUES (v_agreement.id, p_zone_id, 'active', v_actor);
  END IF;

  IF p_action = 'create' THEN
    INSERT INTO public.service_agreement_delivery_schedules(service_agreement_id, site_id, zone_id, module_key, capability_key, work_model, active_days, active_months, visits_per_shift, min_gap_between_visits_minutes, window_start, window_end, dwell_minutes, preferred_stop_order, pricing_basis, officer_instructions, active)
    VALUES (v_agreement.id, p_site_id, p_zone_id, v_toolset, v_capability, CASE WHEN v_capability = 'alarm_response' THEN 'on_demand_callout' ELSE 'scheduled_patrol' END, v_days, '{}', p_visits_per_shift, p_min_gap_between_visits_minutes, p_window_start, p_window_end, p_dwell_minutes, 0, 'standard_rate_rule', nullif(trim(coalesce(p_officer_instructions, '')), ''), true)
    RETURNING * INTO v_schedule;
  ELSE
    SELECT * INTO v_schedule FROM public.service_agreement_delivery_schedules WHERE id = p_schedule_id AND service_agreement_id = v_agreement.id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Delivery schedule not found on this agreement'; END IF;
    UPDATE public.service_agreement_delivery_schedules
    SET site_id = p_site_id, zone_id = p_zone_id, module_key = v_toolset, capability_key = v_capability, active_days = v_days, visits_per_shift = p_visits_per_shift,
        min_gap_between_visits_minutes = p_min_gap_between_visits_minutes, window_start = p_window_start, window_end = p_window_end, dwell_minutes = p_dwell_minutes,
        officer_instructions = nullif(trim(coalesce(p_officer_instructions, '')), ''), active = true
    WHERE id = v_schedule.id RETURNING * INTO v_schedule;
  END IF;

  -- The patrol config the run builder and stop generator read (same shape the quote acceptance trigger writes).
  IF v_capability <> 'alarm_response' THEN
    SELECT * INTO v_config FROM public.client_site_patrol_config WHERE delivery_schedule_id = v_schedule.id FOR UPDATE;
    IF FOUND THEN
      UPDATE public.client_site_patrol_config
      SET organization_id = v_operating, site_id = p_site_id, zone_id = p_zone_id, module_key = v_config_module, active_days = v_days, visits_per_shift = p_visits_per_shift,
          min_gap_between_visits_minutes = p_min_gap_between_visits_minutes, time_window_type = 'fixed', window_start = p_window_start, window_end = p_window_end,
          dwell_minutes = p_dwell_minutes, officer_instructions = v_schedule.officer_instructions, active = true, updated_at = clock_timestamp()
      WHERE id = v_config.id;
    ELSE
      INSERT INTO public.client_site_patrol_config(organization_id, site_id, zone_id, module_key, active_days, visits_per_shift, min_gap_between_visits_minutes, time_window_type, window_start, window_end, active_months, dwell_minutes, sla_arrive_within_minutes, sla_depart_within_minutes, preferred_stop_order, officer_instructions, delivery_schedule_id)
      VALUES (v_operating, p_site_id, p_zone_id, v_config_module, v_days, p_visits_per_shift, p_min_gap_between_visits_minutes, 'fixed', p_window_start, p_window_end, '{}', p_dwell_minutes, 30, 45, 0, v_schedule.officer_instructions, v_schedule.id);
    END IF;
  END IF;

  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_agreement.provider_organization_id, v_actor, 'crm_delivery_schedule_' || p_action, 'service_agreement_delivery_schedules', v_schedule.id,
    jsonb_build_object('client_request_id', p_client_request_id, 'schedule_id', v_schedule.id, 'agreement_id', v_agreement.id, 'site_id', p_site_id, 'zone_id', p_zone_id, 'module_key', p_module_key,
      'active_days', v_days, 'window_start', p_window_start, 'window_end', p_window_end, 'visits_per_shift', p_visits_per_shift, 'operating_organization_id', v_operating));
  RETURN jsonb_build_object('schedule_id', v_schedule.id, 'agreement_id', v_agreement.id, 'module_key', p_module_key, 'toolset_key', v_toolset, 'capability_key', v_capability, 'operating_organization_id', v_operating, 'active_days', v_days);
END;
$function$;
COMMENT ON FUNCTION public.manage_crm_agreement_delivery_schedule(uuid, uuid, text, uuid, uuid, uuid, text, integer[], time, time, integer, integer, integer, text, uuid) IS 'Guided client setup: a contracted schedule for one place and one service on a live operational agreement — days (ISO 1–7, default every day), window (none = any time of day), visits per shift, minimum gap, time on site. Writes the delivery schedule and its patrol config (linked by delivery_schedule_id), enables the module and links the place on the agreement. Idempotent on client_request_id.';
REVOKE ALL ON FUNCTION public.manage_crm_agreement_delivery_schedule(uuid, uuid, text, uuid, uuid, uuid, text, integer[], time, time, integer, integer, integer, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manage_crm_agreement_delivery_schedule(uuid, uuid, text, uuid, uuid, uuid, text, integer[], time, time, integer, integer, integer, text, uuid) TO authenticated, service_role;
