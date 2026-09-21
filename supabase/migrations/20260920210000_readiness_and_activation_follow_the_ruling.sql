-- Readiness and activation follow the 2026-09-21 ruling (docs/canon/ORG_SERVICE_MODEL.md): the provider's live
-- operational agreement is the basis for configuring, readiness and activation; the client's portal acceptance is
-- portal access, not a gate. Observed live after the guided setup: a fully configured client (place, patrol service,
-- run, work unit) still read "agreement blocked / Create service agreement" because both readiness readers and
-- activate_crm_account required invitation_status = 'accepted'. Blockers and next actions now use the words a branch
-- manager uses.

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
          AND sa.agreement_type = 'operational'
          AND (sa.ends_on IS NULL OR sa.ends_on >= current_date)
      ) AS agreement_ready,
      EXISTS(
        SELECT 1 FROM public.service_agreements sa
        WHERE sa.provider_organization_id = ANY(public.get_descendant_organizations(v_provider))
          AND sa.client_organization_id = a.id
          AND sa.agreement_type = 'operational'
          AND (sa.ends_on IS NULL OR sa.ends_on >= current_date)
          AND (cardinality(sa.enabled_modules) > 0 OR EXISTS(SELECT 1 FROM public.service_agreement_delivery_schedules d WHERE d.service_agreement_id = sa.id AND d.active))
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
      CASE WHEN NOT f.identity_ready THEN 'Confirm who the client is' END,
      CASE WHEN NOT f.contact_ready THEN 'Add the person we deal with' END,
      CASE WHEN NOT f.location_ready THEN 'Add a place we work at' END,
      CASE WHEN NOT f.agreement_ready THEN 'Set up the service agreement' END,
      CASE WHEN NOT f.module_ready THEN 'Add a service (what we do there)' END,
      CASE WHEN NOT f.billing_ready THEN 'Set a price: a rate or an accepted quote' END,
      CASE WHEN NOT f.operations_ready THEN 'Build the patrol run or guard post' END
    ], NULL),
    CASE
      WHEN f.status = 'active' AND f.contact_ready AND f.location_ready AND f.agreement_ready AND f.module_ready AND f.billing_ready AND f.operations_ready THEN 'Active: roster the work and deliver'
      WHEN NOT f.contact_ready THEN 'Add the person we deal with'
      WHEN NOT f.location_ready THEN 'Add a place we work at'
      WHEN NOT f.agreement_ready THEN 'Set up the service agreement'
      WHEN NOT f.module_ready THEN 'Add a service'
      WHEN NOT f.billing_ready THEN 'Set a price'
      WHEN NOT f.operations_ready THEN 'Build the patrol run or guard post'
      ELSE 'Ready to activate'
    END
  FROM facts f
  ORDER BY f.id;
END;
$function$;

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

  return jsonb_build_object('agreement_id',v_agreement.id,'invitation_status',v_agreement.invitation_status,'ready',v_location_count>0 and v_boundary_ready and v_module_count>0 and v_billing_ready and v_work_unit_count>0 and v_reporting_ready,'dimensions',jsonb_build_array(
    jsonb_build_object('key','coverage','label','Covered places','status',case when v_location_count>0 then 'ready' else 'blocked' end,'detail',case when v_location_count>0 then v_location_count||' active location link'||case when v_location_count=1 then '' else 's' end else 'No active covered site or zone is linked' end,'owner','Account administration','destination','relationships'),
    jsonb_build_object('key','boundary','label','Boundary evidence','status',case when v_boundary_ready then 'ready' else 'blocked' end,'detail',case when v_boundary_ready then 'All covered places have authoritative verified boundaries' else 'Every covered place needs authoritative verified geometry' end,'owner','Operations administration','destination','sites'),
    jsonb_build_object('key','modules','label','Service scope','status',case when v_module_count>0 then 'ready' else 'blocked' end,'detail',case when v_module_count>0 then v_module_count||' enabled service module'||case when v_module_count=1 then '' else 's' end else 'No service module is enabled' end,'owner','Account administration','destination','relationships'),
    jsonb_build_object('key','billing','label','Commercial rates','status',case when v_billing_ready then 'ready' else 'blocked' end,'detail',case when v_billing_ready then 'A positive agreement or covered-place rate is recorded' else 'No positive billable rate is recorded' end,'owner','Commercial administration','destination','crm'),
    jsonb_build_object('key','operations','label','Operational work','status',case when v_work_unit_count>0 then 'ready' else 'blocked' end,'detail',case when v_work_unit_count>0 then v_work_unit_count||' active attributed work unit'||case when v_work_unit_count=1 then '' else 's' end else 'No active work unit is attributed to this agreement' end,'owner','Roster administration','destination','roster-targets'),
    jsonb_build_object('key','reporting','label','Reporting delivery','status',case when v_reporting_ready then 'ready' else 'blocked' end,'detail',case when not v_agreement.client_portal_reports_enabled then 'Client report delivery is disabled by contract' when v_reporting_ready then 'The configured monthly template exists for the provider' else 'Client reporting is enabled without a valid monthly template' end,'owner','Reporting administration','destination','reports')
  ));
end;$function$;

CREATE OR REPLACE FUNCTION "public"."activate_crm_account"(p_account_organization_id uuid, p_agreement_id uuid, p_expected_organization_updated_at timestamp with time zone, p_expected_ledger_version integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_provider uuid;
  v_org public.organizations%rowtype;
  v_ledger public.crm_onboarding_ledgers%rowtype;
  v_agreement public.service_agreements%rowtype;
  v_readiness jsonb;
BEGIN
  SELECT organization_id INTO v_provider
  FROM public.user_profiles
  WHERE id = v_actor AND deactivated_at IS NULL;

  IF v_provider IS NULL OR NOT public.is_admin_for_org(v_provider) THEN
    RAISE EXCEPTION 'Active CRM administrator required';
  END IF;

  SELECT * INTO v_org
  FROM public.organizations
  WHERE id = p_account_organization_id
    AND parent_organization_id = ANY(public.get_descendant_organizations(v_provider))
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Managed CRM account not found'; END IF;
  IF v_org.status <> 'prospect' OR v_org.active THEN RAISE EXCEPTION 'Only an inactive prospect can be activated'; END IF;
  IF v_org.updated_at IS DISTINCT FROM p_expected_organization_updated_at THEN RAISE EXCEPTION 'Organization changed since activation review'; END IF;

  SELECT * INTO v_ledger
  FROM public.crm_onboarding_ledgers
  WHERE provider_organization_id = ANY(public.get_descendant_organizations(v_provider))
    AND account_organization_id = v_org.id
  ORDER BY started_at DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND OR v_ledger.version <> p_expected_ledger_version THEN RAISE EXCEPTION 'Onboarding ledger changed since activation review'; END IF;
  IF v_ledger.current_stage <> 'review' THEN RAISE EXCEPTION 'Onboarding must be in review before activation'; END IF;
  IF v_ledger.assigned_to IS NULL OR nullif(trim(v_ledger.stage_note), '') IS NULL THEN RAISE EXCEPTION 'Named onboarding owner and review note required before activation'; END IF;

  SELECT * INTO v_agreement
  FROM public.service_agreements
  WHERE id = p_agreement_id
    AND provider_organization_id = ANY(public.get_descendant_organizations(v_ledger.provider_organization_id))
    AND client_organization_id = v_org.id
    AND agreement_type = 'operational'
  FOR UPDATE;

  -- Ruling 2026-09-21: the client's portal acceptance is not a condition of the provider starting service.
  IF NOT FOUND THEN RAISE EXCEPTION 'Live operational agreement required'; END IF;
  IF v_agreement.ends_on IS NOT NULL AND v_agreement.ends_on < current_date THEN RAISE EXCEPTION 'This agreement has ended; activate the account on a live agreement'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.crm_contacts c WHERE c.organization_id = v_org.id AND c.is_primary AND c.deactivated_at IS NULL) THEN RAISE EXCEPTION 'Active primary contact required'; END IF;
  v_readiness := public.get_crm_operational_readiness(v_agreement.id);
  IF NOT coalesce((v_readiness->>'ready')::boolean, false) THEN RAISE EXCEPTION 'Operational readiness blockers remain'; END IF;

  UPDATE public.organizations
  SET status = 'active', active = true, updated_at = clock_timestamp()
  WHERE id = v_org.id
  RETURNING * INTO v_org;

  UPDATE public.crm_onboarding_ledgers
  SET current_stage = 'activated', status = 'activated', version = version + 1, activated_at = clock_timestamp(), activated_by = v_actor, updated_at = clock_timestamp()
  WHERE id = v_ledger.id
  RETURNING * INTO v_ledger;

  INSERT INTO public.crm_onboarding_events(ledger_id,provider_organization_id,account_organization_id,event_type,from_stage,to_stage,ledger_status,assigned_to,note,actor_user_id,ledger_version)
  VALUES(v_ledger.id,v_ledger.provider_organization_id,v_org.id,'activated','review','activated','activated',v_ledger.assigned_to,'Account activated after governed readiness review',v_actor,v_ledger.version);
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  VALUES(v_ledger.provider_organization_id,v_actor,'crm_account_activated','organizations',v_org.id,jsonb_build_object('agreement_id',v_agreement.id,'ledger_id',v_ledger.id,'assigned_to',v_ledger.assigned_to,'ledger_version',v_ledger.version));

  RETURN jsonb_build_object('account_organization_id',v_org.id,'organization_status',v_org.status,'ledger_status',v_ledger.status,'activated_at',v_ledger.activated_at);
END;
$function$;
