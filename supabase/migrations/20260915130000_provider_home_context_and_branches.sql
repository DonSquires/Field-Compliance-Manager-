-- A subscriber runs its own organisation and may open branches under it
-- (owner direction 2026-09-15: "the master should create a branch or multiple
-- branches for R&M", from Organisation settings, simply).
--
-- 1. get_operating_organization_contexts(): an active provider organisation
--    (owner / service_provider) is itself an operating context for its
--    grand_master / master / admin users ('organisation_home'). Until now only
--    branches were contexts, so an own-rooted subscriber's master could read
--    their organisation but every governed write ("Active authorized operating
--    branch administrator required") failed.
-- 2. update_operating_branch_profile / set_operating_branch_module /
--    manage_operating_branch_rate_rule accept owner / service_provider / branch
--    operating organisations (verbatim bodies, predicate widened). A branch may
--    only enable a module its parent organisation has enabled.
-- 3. create_provider_branch / archive_provider_branch: the governed, idempotent
--    path Organisation settings uses. A new branch is active immediately (it is
--    the provider's own delivery region, not a CRM prospect) and inherits the
--    parent's enabled modules in dependency order.

-- ---------------------------------------------------------------------------
-- 1. Home organisation is an operating context
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."get_operating_organization_contexts"()
 RETURNS TABLE(organization_id uuid, organization_name text, authority_basis text, role_at_branch text, module_access text[], can_be_rostered boolean, is_default boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with actor as (
    select organization_id, employer_organization_id, role
    from public.user_profiles
    where id = auth.uid() and deactivated_at is null
  ), candidates as (
    -- The provider organisation itself, for its administrators.
    select
      home.id as organization_id,
      home.name as organization_name,
      'organisation_home'::text as authority_basis,
      null::text as role_at_branch,
      array[]::text[] as module_access,
      false as can_be_rostered,
      0 as authority_rank
    from actor
    join public.organizations home
      on home.id = actor.organization_id
     and home.organization_type in ('owner', 'service_provider')
     and home.active
    where actor.role in ('grand_master', 'master', 'admin')

    union all

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
  order by (ranked.organization_id = actor.organization_id) desc, ranked.organization_name;
$function$;
COMMENT ON FUNCTION "public"."get_operating_organization_contexts"() IS 'Operating contexts for the caller: their own provider organisation (organisation_home, for grand_master/master/admin), branches they are authorised at (branch_authorisation), and branches in their organisation tree (corporate_oversight). Ranked so an explicit authorisation wins over oversight; the home organisation is the default.';

-- ---------------------------------------------------------------------------
-- 2. Operating-organisation RPCs accept the provider organisation itself
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."manage_operating_branch_rate_rule"(p_operating_organization_id uuid, p_client_request_id uuid, p_action text, p_rate_rule_id uuid DEFAULT NULL::uuid, p_expected_updated_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_rule_kind text DEFAULT NULL::text, p_name text DEFAULT NULL::text, p_rate_type text DEFAULT NULL::text, p_amount numeric DEFAULT NULL::numeric, p_pay_code text DEFAULT NULL::text, p_service_type text DEFAULT NULL::text, p_job_type text DEFAULT NULL::text, p_client_org_id uuid DEFAULT NULL::uuid, p_site_id uuid DEFAULT NULL::uuid, p_zone_id uuid DEFAULT NULL::uuid, p_day_category text DEFAULT NULL::text, p_effective_from date DEFAULT NULL::date, p_effective_to date DEFAULT NULL::date, p_priority integer DEFAULT 0)
 RETURNS rate_rules
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_actor uuid:=auth.uid();v_rule public.rate_rules%rowtype;v_name text:=nullif(trim(coalesce(p_name,'')), '');
begin
  if p_client_request_id is null then raise exception 'client_request_id is required';end if;
  if not public.user_can_operate_organization(p_operating_organization_id) or not public.is_admin_for_org(p_operating_organization_id) then raise exception 'Active authorized operating branch finance administrator required';end if;
  if not exists(select 1 from public.organizations branch where branch.id=p_operating_organization_id and branch.organization_type in ('owner','service_provider','branch') and branch.active) then raise exception 'Active operating organisation not found';end if;
  if p_action='create' then
    if v_name is null or p_rule_kind not in('pay','billing') or p_rate_type not in('hourly','flat','daily','per_km','per_unit','percentage','per_hour_travel','per_hour_allowance','oncall_flat','callout','higher_duties_flat','per_visit','per_notice') or p_amount is null or p_amount<0 then raise exception 'Rule name, kind, rate type, and a non-negative amount are required';end if;
    if p_day_category is not null and p_day_category not in('weekday','weekend','public_holiday','night') then raise exception 'Unsupported day category';end if;if p_effective_to is not null and p_effective_from is not null and p_effective_to<p_effective_from then raise exception 'Effective end cannot precede effective start';end if;
    select * into v_rule from public.rate_rules where organization_id=p_operating_organization_id and client_request_id=p_client_request_id;if found then return v_rule;end if;
    insert into public.rate_rules(organization_id,rule_kind,name,rate_type,amount,pay_code,service_type,job_type,client_org_id,site_id,zone_id,day_category,effective_from,effective_to,priority,active,created_by,updated_by,client_request_id)values(p_operating_organization_id,p_rule_kind,v_name,p_rate_type,p_amount,nullif(trim(coalesce(p_pay_code,'')),''),nullif(trim(coalesce(p_service_type,'')),''),nullif(trim(coalesce(p_job_type,'')),''),p_client_org_id,p_site_id,p_zone_id,p_day_category,p_effective_from,p_effective_to,coalesce(p_priority,0),true,v_actor,v_actor,p_client_request_id)returning * into v_rule;
  else
    select * into v_rule from public.rate_rules where id=p_rate_rule_id and organization_id=p_operating_organization_id for update;if not found then raise exception 'Rate rule not found in this operating branch';end if;if p_expected_updated_at is not null and v_rule.updated_at<>p_expected_updated_at then raise exception 'Rate rule changed since it was opened';end if;
    if p_action='update' then if v_name is null or p_rate_type not in('hourly','flat','daily','per_km','per_unit','percentage','per_hour_travel','per_hour_allowance','oncall_flat','callout','higher_duties_flat','per_visit','per_notice') or p_amount is null or p_amount<0 then raise exception 'Rule name, rate type, and non-negative amount are required';end if;update public.rate_rules set name=v_name,rate_type=p_rate_type,amount=p_amount,pay_code=nullif(trim(coalesce(p_pay_code,'')),''),service_type=nullif(trim(coalesce(p_service_type,'')),''),job_type=nullif(trim(coalesce(p_job_type,'')),''),client_org_id=p_client_org_id,site_id=p_site_id,zone_id=p_zone_id,day_category=p_day_category,effective_from=p_effective_from,effective_to=p_effective_to,priority=coalesce(p_priority,0),updated_by=v_actor where id=v_rule.id returning * into v_rule;
    elsif p_action='deactivate' then update public.rate_rules set active=false,updated_by=v_actor where id=v_rule.id and active returning * into v_rule;if not found then raise exception 'Rate rule is already inactive';end if;
    elsif p_action='reactivate' then update public.rate_rules set active=true,updated_by=v_actor where id=v_rule.id and not active returning * into v_rule;if not found then raise exception 'Rate rule is already active';end if;
    else raise exception 'Unsupported rate rule action';end if;
  end if;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)values(v_rule.organization_id,v_actor,'operating_branch_rate_rule_managed','rate_rules',v_rule.id,jsonb_build_object('action',p_action,'rule_kind',v_rule.rule_kind,'rate_type',v_rule.rate_type,'amount',v_rule.amount,'client_request_id',p_client_request_id));return v_rule;
end;$function$;
REVOKE ALL ON FUNCTION "public"."manage_operating_branch_rate_rule"(p_operating_organization_id uuid, p_client_request_id uuid, p_action text, p_rate_rule_id uuid, p_expected_updated_at timestamp with time zone, p_rule_kind text, p_name text, p_rate_type text, p_amount numeric, p_pay_code text, p_service_type text, p_job_type text, p_client_org_id uuid, p_site_id uuid, p_zone_id uuid, p_day_category text, p_effective_from date, p_effective_to date, p_priority integer) FROM PUBLIC, "anon", "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION "public"."manage_operating_branch_rate_rule"(p_operating_organization_id uuid, p_client_request_id uuid, p_action text, p_rate_rule_id uuid, p_expected_updated_at timestamp with time zone, p_rule_kind text, p_name text, p_rate_type text, p_amount numeric, p_pay_code text, p_service_type text, p_job_type text, p_client_org_id uuid, p_site_id uuid, p_zone_id uuid, p_day_category text, p_effective_from date, p_effective_to date, p_priority integer) TO "postgres";
GRANT EXECUTE ON FUNCTION "public"."manage_operating_branch_rate_rule"(p_operating_organization_id uuid, p_client_request_id uuid, p_action text, p_rate_rule_id uuid, p_expected_updated_at timestamp with time zone, p_rule_kind text, p_name text, p_rate_type text, p_amount numeric, p_pay_code text, p_service_type text, p_job_type text, p_client_org_id uuid, p_site_id uuid, p_zone_id uuid, p_day_category text, p_effective_from date, p_effective_to date, p_priority integer) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."manage_operating_branch_rate_rule"(p_operating_organization_id uuid, p_client_request_id uuid, p_action text, p_rate_rule_id uuid, p_expected_updated_at timestamp with time zone, p_rule_kind text, p_name text, p_rate_type text, p_amount numeric, p_pay_code text, p_service_type text, p_job_type text, p_client_org_id uuid, p_site_id uuid, p_zone_id uuid, p_day_category text, p_effective_from date, p_effective_to date, p_priority integer) TO "service_role";

CREATE OR REPLACE FUNCTION "public"."manage_org_printer_settings"(p_organization_id uuid, p_paper_width text, p_connection_type text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_row public.org_printer_settings%rowtype;
BEGIN
  IF v_actor IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN
    RAISE EXCEPTION 'Organization administrator required';
  END IF;
  IF p_paper_width NOT IN ('58mm', '80mm', 'a4') THEN RAISE EXCEPTION 'Invalid paper_width'; END IF;
  IF p_connection_type NOT IN ('bluetooth_escpos', 'browser_print') THEN RAISE EXCEPTION 'Invalid connection_type'; END IF;

  INSERT INTO public.org_printer_settings (organization_id, paper_width, connection_type, updated_by)
  VALUES (p_organization_id, p_paper_width, p_connection_type, v_actor)
  ON CONFLICT (organization_id) DO UPDATE SET
    paper_width = excluded.paper_width,
    connection_type = excluded.connection_type,
    updated_at = now(),
    updated_by = excluded.updated_by
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'organization_id', v_row.organization_id,
    'paper_width', v_row.paper_width,
    'connection_type', v_row.connection_type
  );
END;
$function$;

CREATE OR REPLACE FUNCTION "public"."set_operating_branch_module"(p_operating_organization_id uuid, p_module_key text, p_enabled boolean)
 RETURNS organization_modules
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_actor uuid:=auth.uid();v_module public.organization_modules%rowtype;
begin
  if not public.user_can_operate_organization(p_operating_organization_id) or not public.is_admin_for_org(p_operating_organization_id) then raise exception 'Active authorized operating branch administrator required';end if;
  if not exists(select 1 from public.organizations branch where branch.id=p_operating_organization_id and branch.organization_type in ('owner','service_provider','branch') and branch.active) then raise exception 'Active operating organisation not found';end if;
  if not exists(select 1 from public.module_catalog module where module.module_key=p_module_key and module.active) then raise exception 'Active platform module required';end if;
  if p_enabled and exists(select 1 from public.organizations b where b.id=p_operating_organization_id and b.parent_organization_id is not null and not exists(select 1 from public.organization_modules pm where pm.organization_id=b.parent_organization_id and pm.module_key=p_module_key and pm.enabled)) then raise exception 'Enable this module for the organisation before enabling it for a branch';end if;
  insert into public.organization_modules(organization_id,module_key,enabled)values(p_operating_organization_id,p_module_key,p_enabled) on conflict(organization_id,module_key) do update set enabled=excluded.enabled returning * into v_module;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)values(p_operating_organization_id,v_actor,'operating_branch_module_set','organization_modules',v_module.id,jsonb_build_object('module_key',v_module.module_key,'enabled',v_module.enabled));return v_module;
end;$function$;
REVOKE ALL ON FUNCTION "public"."set_operating_branch_module"(p_operating_organization_id uuid, p_module_key text, p_enabled boolean) FROM PUBLIC, "anon", "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION "public"."set_operating_branch_module"(p_operating_organization_id uuid, p_module_key text, p_enabled boolean) TO "postgres";
GRANT EXECUTE ON FUNCTION "public"."set_operating_branch_module"(p_operating_organization_id uuid, p_module_key text, p_enabled boolean) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."set_operating_branch_module"(p_operating_organization_id uuid, p_module_key text, p_enabled boolean) TO "service_role";

CREATE OR REPLACE FUNCTION "public"."set_org_jurisdiction_geom"(p_org_id uuid, p_polygons jsonb, p_boundary_source text DEFAULT NULL::text, p_changed_by uuid DEFAULT NULL::uuid, p_changed_via text DEFAULT 'governed_proposal'::text)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_geom         geometry;
  v_area_m2      numeric;
  v_prev_geom    geometry;
  v_prev_verif   text;
  v_prev_vby     uuid;
  v_prev_vat     timestamptz;
  v_source       text;
  v_via          text;
BEGIN
  IF p_polygons IS NULL OR jsonb_typeof(p_polygons) <> 'array' OR jsonb_array_length(p_polygons) = 0 THEN
    RAISE EXCEPTION 'p_polygons must be a non-empty JSON array of GeoJSON geometries';
  END IF;

  SELECT st_multi(st_setsrid(st_makevalid(st_union(st_makevalid(st_geomfromgeojson(elem.value)))), 4326))
    INTO v_geom
    FROM jsonb_array_elements(p_polygons) AS elem;

  IF v_geom IS NULL THEN
    RAISE EXCEPTION 'Could not build geometry from supplied GeoJSON';
  END IF;

  IF st_isempty(v_geom) THEN
    RAISE EXCEPTION 'Geometry is empty after ST_MakeValid + ST_Union';
  END IF;

  IF NOT st_isvalid(v_geom) THEN
    RAISE EXCEPTION 'Geometry is still invalid after ST_MakeValid: %', st_isvalidreason(v_geom);
  END IF;

  v_area_m2 := st_area(v_geom::geography);

  -- Capture previous state for history BEFORE overwriting
  SELECT jurisdiction_geom, jurisdiction_verification,
         jurisdiction_verified_by, jurisdiction_verified_at
    INTO v_prev_geom, v_prev_verif, v_prev_vby, v_prev_vat
    FROM public.organizations
   WHERE id = p_org_id;

  -- Write the new geometry
  UPDATE public.organizations
     SET jurisdiction_geom = v_geom
   WHERE id = p_org_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Organization % not found', p_org_id;
  END IF;

  -- Resolve provenance: use caller-supplied source when provided,
  -- else fall back to 'UNKNOWN_SOURCE' (P1: loud, explicit).
  v_source := COALESCE(NULLIF(TRIM(p_boundary_source), ''), 'UNKNOWN_SOURCE');

  -- Resolve changed_via: validate against the CHECK constraint values.
  v_via := CASE
    WHEN p_changed_via IN ('governed_proposal', 'direct_edit', 'reconciliation', 'refresh', 'verification', 'backfill')
    THEN p_changed_via
    ELSE 'governed_proposal'
  END;

  -- Record history: snapshot of the NEW geometry with current state
  INSERT INTO public.geofence_boundary_history (
    entity_type, entity_id, boundary, boundary_source,
    verification_state, verified_by, verified_at,
    changed_by, changed_via, change_reason, version
  ) VALUES (
    'organization', p_org_id, v_geom, v_source,
    'unverified', NULL, NULL,
    p_changed_by, v_via, 'Jurisdiction geometry set via set_org_jurisdiction_geom',
    public._gbh_next_version('organization', p_org_id)
  );

  RETURN v_area_m2;
END;
$function$;

CREATE OR REPLACE FUNCTION "public"."update_operating_branch_profile"(p_operating_organization_id uuid, p_expected_updated_at timestamp with time zone, p_contact_email text, p_contact_phone text, p_billing_email text, p_billing_address text, p_enforcement_workflow_mode text)
 RETURNS organizations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_actor uuid:=auth.uid();v_branch public.organizations%rowtype;
begin
  if not public.user_can_operate_organization(p_operating_organization_id) or not public.is_admin_for_org(p_operating_organization_id) then raise exception 'Active authorized operating branch administrator required';end if;
  select * into v_branch from public.organizations where id=p_operating_organization_id and organization_type in ('owner','service_provider','branch') and active for update;if not found then raise exception 'Active operating organisation not found';end if;
  if v_branch.updated_at<>p_expected_updated_at then raise exception 'Organization changed since it was opened';end if;if p_enforcement_workflow_mode not in('admin_first','officer_direct','hybrid') then raise exception 'Unsupported enforcement workflow mode';end if;
  update public.organizations set contact_email=nullif(lower(trim(coalesce(p_contact_email,''))),''),contact_phone=nullif(trim(coalesce(p_contact_phone,'')),''),billing_email=nullif(lower(trim(coalesce(p_billing_email,''))),''),billing_address=nullif(trim(coalesce(p_billing_address,'')),''),enforcement_workflow_mode=p_enforcement_workflow_mode,updated_at=clock_timestamp() where id=v_branch.id returning * into v_branch;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)values(v_branch.id,v_actor,'operating_branch_profile_updated','organizations',v_branch.id,jsonb_build_object('enforcement_workflow_mode',v_branch.enforcement_workflow_mode,'billing_configured',v_branch.billing_email is not null));return v_branch;
end;$function$;
REVOKE ALL ON FUNCTION "public"."update_operating_branch_profile"(p_operating_organization_id uuid, p_expected_updated_at timestamp with time zone, p_contact_email text, p_contact_phone text, p_billing_email text, p_billing_address text, p_enforcement_workflow_mode text) FROM PUBLIC, "anon", "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION "public"."update_operating_branch_profile"(p_operating_organization_id uuid, p_expected_updated_at timestamp with time zone, p_contact_email text, p_contact_phone text, p_billing_email text, p_billing_address text, p_enforcement_workflow_mode text) TO "postgres";
GRANT EXECUTE ON FUNCTION "public"."update_operating_branch_profile"(p_operating_organization_id uuid, p_expected_updated_at timestamp with time zone, p_contact_email text, p_contact_phone text, p_billing_email text, p_billing_address text, p_enforcement_workflow_mode text) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."update_operating_branch_profile"(p_operating_organization_id uuid, p_expected_updated_at timestamp with time zone, p_contact_email text, p_contact_phone text, p_billing_email text, p_billing_address text, p_enforcement_workflow_mode text) TO "service_role";

CREATE OR REPLACE FUNCTION "public"."update_organization_profile"(p_expected_updated_at timestamp with time zone, p_contact_email text, p_contact_phone text, p_billing_email text, p_billing_address text, p_enforcement_workflow_mode text)
 RETURNS organizations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_actor uuid:=auth.uid();v_provider uuid;v_org public.organizations%rowtype;
begin
  select actor.organization_id into v_provider from public.user_profiles actor where actor.id=v_actor and actor.deactivated_at is null;
  if v_provider is null or not public.is_admin_for_org(v_provider) then raise exception 'Active organization administrator required';end if;
  select o.* into v_org from public.organizations o where o.id=v_provider for update;if not found then raise exception 'Organization not found';end if;
  if v_org.updated_at<>p_expected_updated_at then raise exception 'Organization changed since it was opened';end if;
  if p_enforcement_workflow_mode not in('admin_first','officer_direct','hybrid') then raise exception 'Unsupported enforcement workflow mode';end if;
  update public.organizations set contact_email=nullif(lower(trim(coalesce(p_contact_email,''))),''),contact_phone=nullif(trim(coalesce(p_contact_phone,'')),''),billing_email=nullif(lower(trim(coalesce(p_billing_email,''))),''),billing_address=nullif(trim(coalesce(p_billing_address,'')),''),enforcement_workflow_mode=p_enforcement_workflow_mode,updated_at=clock_timestamp() where id=v_provider returning * into v_org;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)values(v_provider,v_actor,'organization_profile_updated','organizations',v_provider,jsonb_build_object('enforcement_workflow_mode',v_org.enforcement_workflow_mode,'billing_configured',v_org.billing_email is not null));
  return v_org;
end;$function$;
REVOKE ALL ON FUNCTION "public"."update_organization_profile"(p_expected_updated_at timestamp with time zone, p_contact_email text, p_contact_phone text, p_billing_email text, p_billing_address text, p_enforcement_workflow_mode text) FROM PUBLIC, "anon", "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION "public"."update_organization_profile"(p_expected_updated_at timestamp with time zone, p_contact_email text, p_contact_phone text, p_billing_email text, p_billing_address text, p_enforcement_workflow_mode text) TO "postgres";
GRANT EXECUTE ON FUNCTION "public"."update_organization_profile"(p_expected_updated_at timestamp with time zone, p_contact_email text, p_contact_phone text, p_billing_email text, p_billing_address text, p_enforcement_workflow_mode text) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."update_organization_profile"(p_expected_updated_at timestamp with time zone, p_contact_email text, p_contact_phone text, p_billing_email text, p_billing_address text, p_enforcement_workflow_mode text) TO "service_role";

CREATE OR REPLACE FUNCTION "public"."update_roster_slot"(p_slot_id uuid, p_expected_status text, p_staff_id uuid, p_scheduled_start timestamp with time zone, p_scheduled_end timestamp with time zone, p_notes text DEFAULT NULL::text)
 RETURNS roster_slots
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_slot public.roster_slots%rowtype;
  v_staff public.staff_profiles%rowtype;
begin
  select s.* into v_slot from public.roster_slots s where s.id = p_slot_id for update;
  if not found then raise exception 'Roster slot not found'; end if;
  if not public.is_admin_for_org(v_slot.organization_id) then raise exception 'Not authorised to edit this roster slot'; end if;
  if v_slot.status <> p_expected_status then raise exception 'Roster slot changed from expected status % to %', p_expected_status, v_slot.status; end if;
  if v_slot.status <> 'draft' then raise exception 'Only draft roster slots can be edited'; end if;
  if p_scheduled_end <= p_scheduled_start then raise exception 'Roster slot must end after it starts'; end if;

  select sp.* into v_staff from public.staff_profiles sp where sp.id = p_staff_id;
  if not found or v_staff.organization_id <> v_slot.organization_id or not v_staff.work_ready then raise exception 'Assigned staff member is not work-ready'; end if;
  if public.staff_has_roster_availability_conflict(v_staff.id, p_scheduled_start, p_scheduled_end) then raise exception 'Staff member is unavailable during this roster slot'; end if;
  if public.staff_fatigue_conflict(v_staff.id, p_scheduled_start, p_scheduled_end, v_slot.id) is not null then raise exception 'Fatigue rule breach for assigned staff'; end if;

  update public.roster_slots set staff_id = p_staff_id, scheduled_start = p_scheduled_start, scheduled_end = p_scheduled_end, notes = nullif(trim(coalesce(p_notes, '')), '') where id = v_slot.id returning * into v_slot;
  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_slot.organization_id, v_actor, 'roster_slot_human_edited', 'roster_slots', v_slot.id, jsonb_build_object('staff_id', p_staff_id, 'scheduled_start', p_scheduled_start, 'scheduled_end', p_scheduled_end));
  return v_slot;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Branches, from Organisation settings
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_provider_branch(
  p_client_request_id uuid,
  p_parent_organization_id uuid,
  p_name text,
  p_contact_email text DEFAULT NULL,
  p_contact_phone text DEFAULT NULL
) RETURNS organizations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_parent public.organizations%rowtype;
  v_branch public.organizations%rowtype;
  v_name text := nullif(trim(coalesce(p_name, '')), '');
  v_key text;
begin
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  if v_actor is null or not public.user_can_operate_organization(p_parent_organization_id) or not public.is_admin_for_org(p_parent_organization_id) then
    raise exception 'Active organisation administrator required';
  end if;
  select * into v_parent from public.organizations where id = p_parent_organization_id for update;
  if not found or not v_parent.active or v_parent.organization_type not in ('owner', 'service_provider', 'branch') then
    raise exception 'Branches can only be added to an active provider organisation';
  end if;

  select * into v_branch from public.organizations
  where parent_organization_id = v_parent.id and client_request_id = p_client_request_id;
  if found then return v_branch; end if;

  if v_name is null or char_length(v_name) > 200 then raise exception 'Branch name is required and must be 200 characters or fewer'; end if;
  if exists (select 1 from public.organizations o where o.parent_organization_id = v_parent.id and lower(trim(o.name)) = lower(v_name) and o.status <> 'archived') then
    raise exception 'A branch with this name already exists';
  end if;

  insert into public.organizations (name, organization_type, parent_organization_id, active, status, contact_email, contact_phone, client_request_id)
  values (v_name, 'branch', v_parent.id, true, 'active',
          nullif(lower(trim(coalesce(p_contact_email, ''))), ''), nullif(trim(coalesce(p_contact_phone, '')), ''), p_client_request_id)
  returning * into v_branch;

  -- Inherit the parent's enabled modules, dependencies first, so the branch is usable immediately.
  for v_key in
    select pm.module_key from public.organization_modules pm
    where pm.organization_id = v_parent.id and pm.enabled
    order by (exists (select 1 from public.module_dependencies d where d.module_key = pm.module_key)), pm.module_key
  loop
    insert into public.organization_modules (organization_id, module_key, enabled)
    values (v_branch.id, v_key, true)
    on conflict (organization_id, module_key) do update set enabled = true;
  end loop;

  insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_parent.id, v_actor, 'provider_branch_created', 'organizations', v_branch.id,
          jsonb_build_object('name', v_branch.name, 'client_request_id', p_client_request_id));
  return v_branch;
end;
$function$;
REVOKE ALL ON FUNCTION public.create_provider_branch(uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_provider_branch(uuid, uuid, text, text, text) TO authenticated;
COMMENT ON FUNCTION public.create_provider_branch(uuid, uuid, text, text, text) IS 'Organisation settings: an administrator of an active provider organisation adds a branch (active immediately, inherits the parent''s enabled modules). Idempotent on (parent, client_request_id).';

CREATE OR REPLACE FUNCTION public.archive_provider_branch(
  p_branch_organization_id uuid,
  p_expected_updated_at timestamp with time zone
) RETURNS organizations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_branch public.organizations%rowtype;
  v_key text;
begin
  select * into v_branch from public.organizations where id = p_branch_organization_id for update;
  if not found or v_branch.organization_type <> 'branch' then raise exception 'Branch not found'; end if;
  if v_actor is null or not public.user_can_operate_organization(v_branch.parent_organization_id) or not public.is_admin_for_org(v_branch.parent_organization_id) then
    raise exception 'Active organisation administrator required';
  end if;
  if v_branch.status = 'archived' then return v_branch; end if;
  if p_expected_updated_at is not null and v_branch.updated_at <> p_expected_updated_at then raise exception 'Branch changed since it was opened'; end if;
  if exists (select 1 from public.user_profiles u where u.organization_id = v_branch.id and u.deactivated_at is null) then
    raise exception 'Move or deactivate the branch''s staff before archiving it';
  end if;
  if exists (select 1 from public.organizations c where c.parent_organization_id = v_branch.id and c.status <> 'archived') then
    raise exception 'Archive the branch''s own branches first';
  end if;

  for v_key in
    select om.module_key from public.organization_modules om
    where om.organization_id = v_branch.id and om.enabled
    order by (exists (select 1 from public.module_dependencies d where d.depends_on_module_key = om.module_key)), om.module_key
  loop
    update public.organization_modules set enabled = false where organization_id = v_branch.id and module_key = v_key;
  end loop;
  update public.staff_branch_authorisations set status = 'ended', ends_on = least(coalesce(ends_on, current_date), current_date)
   where branch_org_id = v_branch.id and status = 'active';

  update public.organizations set active = false, status = 'archived', updated_at = now()
   where id = v_branch.id returning * into v_branch;
  insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_branch.parent_organization_id, v_actor, 'provider_branch_archived', 'organizations', v_branch.id, jsonb_build_object('name', v_branch.name));
  return v_branch;
end;
$function$;
REVOKE ALL ON FUNCTION public.archive_provider_branch(uuid, timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.archive_provider_branch(uuid, timestamp with time zone) TO authenticated;
COMMENT ON FUNCTION public.archive_provider_branch(uuid, timestamp with time zone) IS 'Organisation settings: archive a branch that has no active staff or sub-branches; disables its modules and ends its branch authorisations. Requires the parent organisation''s administrator.';
