-- Owner ruling 2026-11-01 (docs/canon/ORG_SERVICE_MODEL.md): client approval is not a
-- condition of service. service_agreements.invitation_status records the client-portal
-- invitation lifecycle only. A provider's current operational agreement is enough to
-- configure, deliver, record, report and invoice its service. Client-side disclosure keeps
-- its acceptance gate: has_location_access('client_reads_provider') and
-- publish_location_event_continuity are deliberately unchanged.
--
-- Each live function definition is rewritten in place from pg_get_functiondef with an
-- exact-count anchor (precedent: 20261020103000_as_attended_patrol_schedules.sql), so no
-- unrelated part of a body is restated. Bodies saved with CRLF line endings are matched with
-- CRLF anchors. Any drift aborts the whole statement before anything changes. Grants,
-- owners, SECURITY DEFINER and search_path settings are preserved by CREATE OR REPLACE.
DO $migration$
DECLARE
  v_spec record;
  v_check record;
  v_oid oid;
  v_src text;
  v_def text;
  v_eol text;
  v_anchor text;
  v_replacement text;
  v_count integer;
BEGIN
  FOR v_spec IN
    SELECT * FROM (VALUES
    (1, 'public.can_manage_place_hazards(uuid,uuid)', $q$WHERE sal.status = 'active' AND sa.agreement_type = 'operational' AND sa.invitation_status = 'accepted'$q$,
      $q$WHERE sal.status = 'active' AND sa.agreement_type = 'operational'$q$, 1),
    (2, 'public.create_patrol_route_from_agreement(uuid,uuid,text,uuid)', $q$if v_agreement.agreement_type <> 'operational' or v_agreement.invitation_status not in ('not_invited', 'invited', 'accepted') then$q$,
      $q$if v_agreement.agreement_type <> 'operational' then$q$, 1),
    (3, 'public.crm_actor_can_manage_account(uuid)', $q$            and (agreement.invitation_status='accepted' or (
              agreement.external_refs->'engagement_confirmation'->>'confirmed_by' is not null
              and (agreement.starts_on is null or agreement.starts_on<=current_date)
              and (agreement.ends_on is null or agreement.ends_on>=current_date)
            ))$q$,
      $q$            and (agreement.starts_on is null or agreement.starts_on<=current_date)
            and (agreement.ends_on is null or agreement.ends_on>=current_date)$q$, 1),
    (4, 'public.crm_actor_can_manage_location(uuid)', $q$WHERE ((agreement.provider_organization_id = actor.organization_id AND agreement.invitation_status = 'accepted')$q$,
      $q$WHERE ((agreement.provider_organization_id = actor.organization_id)$q$, 1),
    (5, 'public.crm_actor_can_manage_location(uuid)', $q$
              AND (agreement.invitation_status = 'accepted' OR agreement.external_refs->'engagement_confirmation'->>'confirmed_by' IS NOT NULL)$q$,
      '', 1),
    (6, 'public.field_place_agreement_id(uuid,uuid)', $q$
      AND (invitation_status = 'accepted' OR external_refs->'engagement_confirmation'->>'confirmed_by' IS NOT NULL);$q$,
      $q$;$q$, 1),
    (7, 'public.field_place_agreement_id(uuid,uuid)', $q$RAISE EXCEPTION 'No confirmed operational engagement for this client';$q$,
      $q$RAISE EXCEPTION 'No current operational agreement for this client';$q$, 1),
    (8, 'public.field_place_client_allowed(uuid,uuid)', $q$
        AND (a.invitation_status = 'accepted'
          OR a.external_refs->'engagement_confirmation'->>'confirmed_by' IS NOT NULL)$q$,
      '', 1),
    (9, 'public.generate_crm_invoice_from_agreement(uuid,uuid,date,date,text,text)', $q$
  IF v_agreement.invitation_status <> 'accepted' AND NOT v_agreement.client_portal_finance_enabled THEN
    RAISE EXCEPTION 'Client approval or an active finance-share invite is required before invoicing this agreement';
  END IF;$q$,
      '', 1),
    (10, 'public.generate_custom_report_pack(uuid,date,date,text,uuid[],uuid[],uuid[],uuid[],text[])', $q$
    and agreement.invitation_status = 'accepted';$q$,
      $q$;$q$, 1),
    (11, 'public.generate_custom_report_pack(uuid,date,date,text,uuid[],uuid[],uuid[],uuid[],text[])', $q$raise exception 'Accepted operational service agreement not found';$q$,
      $q$raise exception 'Operational service agreement not found';$q$, 1),
    (12, 'public.get_custom_report_scope_options(uuid,date,date)', $q$
    and agreement.invitation_status = 'accepted';$q$,
      $q$;$q$, 1),
    (13, 'public.get_custom_report_scope_options(uuid,date,date)', $q$raise exception 'Accepted operational service agreement not found';$q$,
      $q$raise exception 'Operational service agreement not found';$q$, 1),
    (14, 'public.generate_due_report_packs(date,date,uuid)', E'\n\t\t\tand agreement.invitation_status = ''accepted''',
      '', 1),
    (15, 'public.generate_due_report_packs(date,date,uuid)', E'\n\t\t\t\t\tand agreement.invitation_status = ''accepted''',
      '', 1),
    (16, 'public.get_consolidated_commercial_overview(uuid,date,date)', $q$      AND agreement.invitation_status = 'accepted'
    GROUP BY agreement.provider_organization_id$q$,
      $q$      AND (agreement.starts_on IS NULL OR agreement.starts_on <= p_to)
      AND (agreement.ends_on IS NULL OR agreement.ends_on >= p_from)
    GROUP BY agreement.provider_organization_id$q$, 1),
    (17, 'public.get_crm_operational_geography()', $q$              AND (agreement.invitation_status = 'accepted' OR (
                agreement.external_refs->'engagement_confirmation'->>'confirmed_by' IS NOT NULL
                AND (agreement.starts_on IS NULL OR agreement.starts_on <= current_date)
                AND (agreement.ends_on IS NULL OR agreement.ends_on >= current_date)))$q$,
      $q$              AND (agreement.starts_on IS NULL OR agreement.starts_on <= current_date)
              AND (agreement.ends_on IS NULL OR agreement.ends_on >= current_date)$q$, 3),
    (18, 'public.get_field_place_workspace(uuid,uuid,text,integer,uuid)', $q$
      AND (a.invitation_status = 'accepted' OR a.external_refs->'engagement_confirmation'->>'confirmed_by' IS NOT NULL)$q$,
      '', 1),
    (19, 'public.get_field_place_workspace(uuid,uuid,text,integer,uuid)', $q$RAISE EXCEPTION 'This client has no confirmed operational engagement with your provider';$q$,
      $q$RAISE EXCEPTION 'This client has no current operational agreement with your provider';$q$, 1),
    (20, 'public.get_identity_registry(uuid,text,integer)', $q$
        AND agreement.invitation_status = 'accepted'$q$,
      '', 1),
    (21, 'public.get_identity_vehicle_activity(uuid,uuid,integer)', $q$
      AND agreement.invitation_status = 'accepted'$q$,
      '', 1),
    (22, 'public.promote_approved_rnm_vehicle_mentions(uuid)', $q$
      AND agreement.invitation_status = 'accepted'$q$,
      '', 1),
    (23, 'public.has_location_access(uuid,uuid,text)', $q$ and agreement.invitation_status = 'accepted'
        and (location.site_id = p_site_id or location.zone_id = p_zone_id)
        and public.org_access_allowed(agreement.provider_organization_id)$q$,
      $q$
        and (location.site_id = p_site_id or location.zone_id = p_zone_id)
        and public.org_access_allowed(agreement.provider_organization_id)$q$, 1),
    (24, 'public.has_location_access(uuid,uuid,text)', $q$ and agreement.invitation_status = 'accepted'
        and (location.site_id = p_site_id or location.zone_id = p_zone_id)
        and location.head_contractor_org_id is not null$q$,
      $q$
        and (location.site_id = p_site_id or location.zone_id = p_zone_id)
        and location.head_contractor_org_id is not null$q$, 1),
    (25, 'public.manage_crm_agreement_delivery_schedule(uuid,uuid,text,uuid,uuid,uuid,text,integer[],time without time zone,time without time zone,integer,integer,integer,text,uuid)', $q$IF v_agreement.agreement_type <> 'operational' OR v_agreement.invitation_status NOT IN ('not_invited', 'invited', 'accepted')
$q$,
      $q$IF v_agreement.agreement_type <> 'operational'
$q$, 1),
    (26, 'public.manage_crm_agreement_finance(uuid,text,boolean)', $q$IF v_agreement.agreement_type <> 'operational' OR v_agreement.invitation_status <> 'accepted' THEN RAISE EXCEPTION 'Only accepted operational agreements can be configured'; END IF;$q$,
      $q$IF v_agreement.agreement_type <> 'operational' THEN RAISE EXCEPTION 'Only operational agreements can be configured'; END IF;$q$, 1),
    (27, 'public.manage_crm_agreement_obligation(uuid,uuid,text,uuid,timestamp with time zone,text,text,text,integer,boolean,text,integer,text,uuid,jsonb)', $q$  IF v_agreement.agreement_type <> 'operational'
     OR v_agreement.invitation_status <> 'accepted' THEN
    RAISE EXCEPTION 'Only accepted operational agreements can be configured';$q$,
      $q$  IF v_agreement.agreement_type <> 'operational' THEN
    RAISE EXCEPTION 'Only operational agreements can be configured';$q$, 1),
    (28, 'public.manage_crm_agreement_reporting(uuid,text,boolean,text)', $q$
  IF v_agreement.invitation_status <> 'accepted' AND NOT v_agreement.client_portal_reports_enabled THEN
    RAISE EXCEPTION 'Client approval or an active reporting-share invite is required to configure reporting';
  END IF;$q$,
      '', 1),
    (29, 'public.manage_crm_agreement_setup(uuid,text,text,uuid,text,boolean,integer,boolean,boolean)', $q$if v_agreement.agreement_type<>'operational' or v_agreement.invitation_status not in ('not_invited','invited','accepted') then raise exception 'Only live operational agreements can be configured';end if;$q$,
      $q$if v_agreement.agreement_type<>'operational' then raise exception 'Only operational agreements can be configured';end if;$q$, 1),
    (30, 'public.manage_crm_agreement_zone_coverage(uuid,text,text,uuid)', $q$IF v_agreement.agreement_type<>'operational' OR v_agreement.invitation_status NOT IN ('not_invited','invited','accepted') THEN RAISE EXCEPTION 'Only live operational agreements can be configured';END IF;$q$,
      $q$IF v_agreement.agreement_type<>'operational' THEN RAISE EXCEPTION 'Only operational agreements can be configured';END IF;$q$, 1),
    (31, 'public.manage_crm_obligation_proof(text,uuid,uuid,uuid,uuid,timestamp with time zone,text,text)', $q$  IF v_agreement.agreement_type <> 'operational' OR v_agreement.invitation_status <> 'accepted' THEN
    RAISE EXCEPTION 'An accepted operational agreement is required';$q$,
      $q$  IF v_agreement.agreement_type <> 'operational' THEN
    RAISE EXCEPTION 'An operational agreement is required';$q$, 1),
    (32, 'public.manage_crm_onboarding_workflow(uuid,integer,text,timestamp with time zone,uuid,text)', $q$
      AND sa.invitation_status = 'accepted'
      AND (sa.ends_on IS NULL OR sa.ends_on >= current_date)$q$,
      $q$
      AND (sa.ends_on IS NULL OR sa.ends_on >= current_date)$q$, 1),
    (33, 'public.manage_crm_onboarding_workflow(uuid,integer,text,timestamp with time zone,uuid,text)', $q$RAISE EXCEPTION 'Accepted operational agreement required before review';$q$,
      $q$RAISE EXCEPTION 'A current operational agreement is required before review';$q$, 1),
    (34, 'public.manage_location_module_assignment(uuid,uuid,uuid,text,timestamp with time zone,boolean,date,date)', $q$     AND sa.invitation_status = 'accepted'
     AND sa.starts_on <= v_effective_from$q$,
      $q$     AND (sa.starts_on IS NULL OR sa.starts_on <= v_effective_from)$q$, 1),
    (35, 'public.post_finance_timesheet_labour_cost(uuid,uuid,uuid,text,uuid,uuid)', $q$
    AND invitation_status = 'accepted'$q$,
      '', 1),
    (36, 'public.resolve_operational_context(double precision,double precision,uuid,text,timestamp with time zone)', $q$
    AND sa.invitation_status = 'accepted'$q$,
      '', 2),
    (37, 'public.resolve_operational_context(double precision,double precision,uuid,text,timestamp with time zone)', $q$p_org_id AND sa.invitation_status = 'accepted'$q$,
      $q$p_org_id$q$, 4),
    (38, 'public.resolve_verified_site_context(double precision,double precision,uuid[],text,uuid)', $q$          AND sa.invitation_status = 'accepted'
          AND sa.starts_on <= current_date$q$,
      $q$          AND (sa.starts_on IS NULL OR sa.starts_on <= current_date)$q$, 1),
    (39, 'public.seed_crm_activation_handoff()', $q$
      AND sa.invitation_status = 'accepted'$q$,
      '', 1),
    (40, 'public.submit_access_control_event_receipt(uuid,uuid,timestamp with time zone,uuid,uuid,uuid,text,text,text,text,text,text,text,double precision,double precision,jsonb,jsonb,jsonb)', $q$
              AND agreement.invitation_status = 'accepted'$q$,
      '', 2),
    (41, 'private.subject_scope_organizations(uuid)', $q$      AND sa.agreement_type = 'operational' AND sa.invitation_status = 'accepted';$q$,
      $q$      AND sa.agreement_type = 'operational';$q$, 1),
    (42, 'public.accept_quote(uuid)', $q$insert into public.service_agreements (provider_organization_id, client_organization_id, name, starts_on, agreement_type, invitation_status)
    values (v_quote.provider_org_id, v_quote.client_org_id, v_quote.title, current_date, 'operational', 'accepted')$q$,
      $q$insert into public.service_agreements (provider_organization_id, client_organization_id, name, starts_on, agreement_type)
    values (v_quote.provider_org_id, v_quote.client_org_id, v_quote.title, current_date, 'operational')$q$, 1),
    (43, 'public.accept_quote(uuid)', $q$    set agreement_type = 'operational',
        invitation_status = 'accepted'
    where id = v_agreement_id;$q$,
      $q$    set agreement_type = 'operational'
    where id = v_agreement_id;$q$, 1)
    ) AS spec(step, target, anchor, replacement, expected)
    ORDER BY step
  LOOP
    v_oid := to_regprocedure(v_spec.target);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'service_without_client_approval step %: % does not exist', v_spec.step, v_spec.target;
    END IF;
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_oid;
    v_eol := CASE WHEN position(E'\r\n' IN v_src) > 0 THEN E'\r\n' ELSE E'\n' END;
    v_anchor := replace(replace(v_spec.anchor, E'\r\n', E'\n'), E'\n', v_eol);
    v_replacement := replace(replace(v_spec.replacement, E'\r\n', E'\n'), E'\n', v_eol);
    v_def := pg_get_functiondef(v_oid);
    v_count := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
    IF v_count <> v_spec.expected THEN
      RAISE EXCEPTION 'service_without_client_approval step %: % changed (expected % anchor match(es), found %); review before applying',
        v_spec.step, v_spec.target, v_spec.expected, v_count;
    END IF;
    EXECUTE replace(v_def, v_anchor, v_replacement);
  END LOOP;

  -- Every rewritten body must keep only its intended invitation_status references:
  -- portal-only reads, optimistic-concurrency checks and returned fields.
  FOR v_check IN
    SELECT * FROM (VALUES
    ('private.subject_scope_organizations(uuid)', 0),
    ('public.accept_quote(uuid)', 0),
    ('public.can_manage_place_hazards(uuid,uuid)', 0),
    ('public.create_patrol_route_from_agreement(uuid,uuid,text,uuid)', 0),
    ('public.crm_actor_can_manage_account(uuid)', 0),
    ('public.crm_actor_can_manage_location(uuid)', 0),
    ('public.field_place_agreement_id(uuid,uuid)', 0),
    ('public.field_place_client_allowed(uuid,uuid)', 0),
    ('public.generate_crm_invoice_from_agreement(uuid,uuid,date,date,text,text)', 0),
    ('public.generate_custom_report_pack(uuid,date,date,text,uuid[],uuid[],uuid[],uuid[],text[])', 0),
    ('public.generate_due_report_packs(date,date,uuid)', 0),
    ('public.get_consolidated_commercial_overview(uuid,date,date)', 0),
    ('public.get_crm_operational_geography()', 0),
    ('public.get_custom_report_scope_options(uuid,date,date)', 0),
    ('public.get_field_place_workspace(uuid,uuid,text,integer,uuid)', 0),
    ('public.get_identity_registry(uuid,text,integer)', 0),
    ('public.get_identity_vehicle_activity(uuid,uuid,integer)', 0),
    ('public.has_location_access(uuid,uuid,text)', 1),
    ('public.manage_crm_agreement_delivery_schedule(uuid,uuid,text,uuid,uuid,uuid,text,integer[],time without time zone,time without time zone,integer,integer,integer,text,uuid)', 0),
    ('public.manage_crm_agreement_finance(uuid,text,boolean)', 2),
    ('public.manage_crm_agreement_obligation(uuid,uuid,text,uuid,timestamp with time zone,text,text,text,integer,boolean,text,integer,text,uuid,jsonb)', 0),
    ('public.manage_crm_agreement_reporting(uuid,text,boolean,text)', 2),
    ('public.manage_crm_agreement_setup(uuid,text,text,uuid,text,boolean,integer,boolean,boolean)', 2),
    ('public.manage_crm_agreement_zone_coverage(uuid,text,text,uuid)', 2),
    ('public.manage_crm_obligation_proof(text,uuid,uuid,uuid,uuid,timestamp with time zone,text,text)', 0),
    ('public.manage_crm_onboarding_workflow(uuid,integer,text,timestamp with time zone,uuid,text)', 0),
    ('public.manage_location_module_assignment(uuid,uuid,uuid,text,timestamp with time zone,boolean,date,date)', 0),
    ('public.post_finance_timesheet_labour_cost(uuid,uuid,uuid,text,uuid,uuid)', 0),
    ('public.promote_approved_rnm_vehicle_mentions(uuid)', 0),
    ('public.resolve_operational_context(double precision,double precision,uuid,text,timestamp with time zone)', 0),
    ('public.resolve_verified_site_context(double precision,double precision,uuid[],text,uuid)', 0),
    ('public.seed_crm_activation_handoff()', 0),
    ('public.submit_access_control_event_receipt(uuid,uuid,timestamp with time zone,uuid,uuid,uuid,text,text,text,text,text,text,text,double precision,double precision,jsonb,jsonb,jsonb)', 0)
    ) AS expected(target, mentions)
  LOOP
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = to_regprocedure(v_check.target);
    v_count := (length(v_src) - length(replace(v_src, 'invitation_status', ''))) / length('invitation_status');
    IF v_count <> v_check.mentions THEN
      RAISE EXCEPTION 'service_without_client_approval: % keeps % invitation_status reference(s), expected %',
        v_check.target, v_count, v_check.mentions;
    END IF;
  END LOOP;
END
$migration$;
