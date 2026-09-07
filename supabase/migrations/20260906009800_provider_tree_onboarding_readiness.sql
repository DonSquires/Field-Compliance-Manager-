CREATE OR REPLACE FUNCTION public.get_crm_organization_readiness(p_organization_ids uuid[] DEFAULT NULL)
RETURNS TABLE(organization_id uuid, organization_status text, identity_status text, contact_status text, location_status text, agreement_status text, module_status text, billing_status text, operations_status text, blockers text[], next_action text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
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

CREATE OR REPLACE FUNCTION public.get_crm_onboarding_workspace()
RETURNS TABLE(
  ledger_id uuid,
  account_organization_id uuid,
  account_name text,
  organization_status text,
  organization_updated_at timestamptz,
  current_stage text,
  ledger_status text,
  version integer,
  started_at timestamptz,
  target_live_at timestamptz,
  days_open integer,
  overdue boolean,
  has_primary_contact boolean,
  agreement_id uuid,
  agreement_name text,
  readiness jsonb,
  assigned_to uuid,
  assigned_name text,
  stage_note text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_provider uuid;
BEGIN
  SELECT organization_id INTO v_provider
  FROM public.user_profiles
  WHERE id = v_actor AND deactivated_at IS NULL;

  IF v_provider IS NULL OR NOT public.is_admin_for_org(v_provider) THEN
    RAISE EXCEPTION 'Active CRM administrator required';
  END IF;

  RETURN QUERY
  SELECT
    l.id,
    o.id,
    o.name,
    o.status,
    o.updated_at,
    l.current_stage,
    l.status,
    l.version,
    l.started_at,
    l.target_live_at,
    greatest(0, floor(extract(epoch FROM (now() - l.started_at)) / 86400)::integer),
    l.target_live_at < now(),
    EXISTS(SELECT 1 FROM public.crm_contacts c WHERE c.organization_id = o.id AND c.is_primary AND c.deactivated_at IS NULL),
    sa.id,
    sa.name,
    CASE WHEN sa.id IS NULL THEN NULL ELSE public.get_crm_operational_readiness(sa.id) END,
    l.assigned_to,
    u.display_name,
    l.stage_note
  FROM public.crm_onboarding_ledgers l
  JOIN public.organizations o ON o.id = l.account_organization_id
  LEFT JOIN public.user_profiles u ON u.id = l.assigned_to
  LEFT JOIN LATERAL(
    SELECT a.id, a.name
    FROM public.service_agreements a
    WHERE a.provider_organization_id = ANY(public.get_descendant_organizations(l.provider_organization_id))
      AND a.client_organization_id = l.account_organization_id
      AND a.agreement_type = 'operational'
    ORDER BY CASE WHEN a.invitation_status = 'accepted' THEN 0 ELSE 1 END, a.created_at DESC
    LIMIT 1
  ) sa ON true
  WHERE l.provider_organization_id = ANY(public.get_descendant_organizations(v_provider))
    AND l.status <> 'activated'
  ORDER BY l.target_live_at, l.started_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.manage_crm_onboarding_workflow(
  p_account_organization_id uuid,
  p_expected_version integer,
  p_stage text,
  p_target_live_at timestamptz,
  p_assigned_to uuid,
  p_note text
)
RETURNS public.crm_onboarding_ledgers
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_provider uuid;
  v_ledger public.crm_onboarding_ledgers%rowtype;
  v_previous_stage text;
  v_rank integer;
  v_next_rank integer;
  v_agreement_id uuid;
  v_readiness jsonb;
  v_note text := trim(coalesce(p_note, ''));
BEGIN
  SELECT organization_id INTO v_provider
  FROM public.user_profiles
  WHERE id = v_actor AND deactivated_at IS NULL;

  IF v_provider IS NULL OR NOT public.is_admin_for_org(v_provider) THEN
    RAISE EXCEPTION 'Active CRM administrator required';
  END IF;

  SELECT * INTO v_ledger
  FROM public.crm_onboarding_ledgers
  WHERE account_organization_id = p_account_organization_id
    AND provider_organization_id = ANY(public.get_descendant_organizations(v_provider))
  ORDER BY started_at DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Onboarding ledger not found'; END IF;
  IF v_ledger.version <> p_expected_version THEN RAISE EXCEPTION 'Onboarding ledger changed since it was opened'; END IF;
  IF v_ledger.status = 'activated' THEN RAISE EXCEPTION 'Activated onboarding cannot be changed'; END IF;
  IF char_length(v_note) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'Stage note must be between 3 and 1000 characters'; END IF;
  IF NOT EXISTS(
    SELECT 1 FROM public.user_profiles u
    WHERE u.id = p_assigned_to
      AND u.deactivated_at IS NULL
      AND u.role IN ('admin','master','grand_master')
      AND (u.organization_id = v_provider OR u.employer_organization_id = v_provider)
  ) THEN RAISE EXCEPTION 'Select an active provider CRM administrator'; END IF;

  v_rank := array_position(ARRAY['qualify','configure','review'], v_ledger.current_stage);
  v_next_rank := array_position(ARRAY['qualify','configure','review'], p_stage);
  IF v_next_rank IS NULL OR v_next_rank < v_rank OR v_next_rank > v_rank + 1 THEN
    RAISE EXCEPTION 'Onboarding stage transition is not allowed';
  END IF;

  IF p_stage = 'review' AND p_stage <> v_ledger.current_stage THEN
    SELECT sa.id INTO v_agreement_id
    FROM public.service_agreements sa
    WHERE sa.provider_organization_id = ANY(public.get_descendant_organizations(v_ledger.provider_organization_id))
      AND sa.client_organization_id = p_account_organization_id
      AND sa.agreement_type = 'operational'
      AND sa.invitation_status = 'accepted'
    ORDER BY sa.created_at DESC
    LIMIT 1;

    IF v_agreement_id IS NULL THEN RAISE EXCEPTION 'Accepted operational agreement required before review'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.crm_contacts c WHERE c.organization_id = p_account_organization_id AND c.is_primary AND c.deactivated_at IS NULL) THEN
      RAISE EXCEPTION 'Active primary contact required before review';
    END IF;
    v_readiness := public.get_crm_operational_readiness(v_agreement_id);
    IF NOT coalesce((v_readiness->>'ready')::boolean, false) THEN
      RAISE EXCEPTION 'Operational readiness blockers remain before review';
    END IF;
  END IF;

  v_previous_stage := v_ledger.current_stage;
  UPDATE public.crm_onboarding_ledgers
  SET current_stage = p_stage,
      status = CASE WHEN p_stage = v_ledger.current_stage THEN v_ledger.status WHEN p_stage = 'review' THEN 'ready' ELSE 'in_progress' END,
      target_live_at = coalesce(p_target_live_at, target_live_at),
      assigned_to = p_assigned_to,
      stage_note = v_note,
      version = version + 1,
      updated_at = clock_timestamp()
  WHERE id = v_ledger.id
  RETURNING * INTO v_ledger;

  INSERT INTO public.crm_onboarding_events(ledger_id,provider_organization_id,account_organization_id,event_type,from_stage,to_stage,ledger_status,assigned_to,note,actor_user_id,ledger_version)
  VALUES(v_ledger.id,v_ledger.provider_organization_id,p_account_organization_id,'workflow_updated',v_previous_stage,v_ledger.current_stage,v_ledger.status,v_ledger.assigned_to,v_note,v_actor,v_ledger.version);
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  VALUES(v_ledger.provider_organization_id,v_actor,'crm_onboarding_workflow_updated','crm_onboarding_ledgers',v_ledger.id,jsonb_build_object('account_organization_id',p_account_organization_id,'from_stage',v_previous_stage,'stage',v_ledger.current_stage,'assigned_to',v_ledger.assigned_to,'version',v_ledger.version));
  RETURN v_ledger;
END;
$$;

CREATE OR REPLACE FUNCTION public.activate_crm_account(
  p_account_organization_id uuid,
  p_agreement_id uuid,
  p_expected_organization_updated_at timestamptz,
  p_expected_ledger_version integer
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public AS $$
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

  IF NOT FOUND OR v_agreement.invitation_status <> 'accepted' THEN RAISE EXCEPTION 'Accepted operational agreement required'; END IF;
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
$$;

CREATE OR REPLACE FUNCTION public.seed_crm_activation_handoff()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_agreement_id uuid;
  v_handoff_id uuid;
BEGIN
  IF new.status = 'activated' AND old.status IS DISTINCT FROM 'activated' THEN
    SELECT sa.id INTO v_agreement_id
    FROM public.service_agreements sa
    WHERE sa.provider_organization_id = ANY(public.get_descendant_organizations(new.provider_organization_id))
      AND sa.client_organization_id = new.account_organization_id
      AND sa.agreement_type = 'operational'
      AND sa.invitation_status = 'accepted'
    ORDER BY sa.created_at DESC
    LIMIT 1;

    IF v_agreement_id IS NULL THEN RAISE EXCEPTION 'Accepted operational agreement required for activation handoff'; END IF;

    INSERT INTO public.crm_activation_handoffs(provider_organization_id,account_organization_id,agreement_id,onboarding_ledger_id,owner_user_id,activated_at)
    VALUES(new.provider_organization_id,new.account_organization_id,v_agreement_id,new.id,new.assigned_to,coalesce(new.activated_at,clock_timestamp()))
    ON CONFLICT(onboarding_ledger_id) DO UPDATE SET owner_user_id = excluded.owner_user_id
    RETURNING id INTO v_handoff_id;

    INSERT INTO public.crm_activation_handoff_tasks(handoff_id,task_key,title,destination)
    VALUES
      (v_handoff_id,'site_briefing','Confirm site access and safety briefing','site-360'),
      (v_handoff_id,'first_roster_action','Publish the first operational roster action','roster'),
      (v_handoff_id,'reporting_handoff','Confirm reporting delivery handoff','reports')
    ON CONFLICT(handoff_id,task_key) DO NOTHING;
  END IF;
  RETURN new;
END;
$$;
