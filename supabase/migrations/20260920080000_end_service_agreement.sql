-- An agreement can end (owner walk 2026-09-20). ends_on was read by every live-agreement predicate but nothing ever
-- wrote it, so a wrong or finished agreement could only be abandoned, and the onboarding ledger, the review gate and
-- activation kept picking the newest accepted agreement even when it had ended.
--   1. end_service_agreement(agreement, ends_on, reason): provider administrator, audited before/after.
--   2. The onboarding workspace, the review gate, activation and the client invitation consider live agreements only.

create or replace function public.end_service_agreement(p_agreement_id uuid, p_ends_on date, p_reason text)
returns public.service_agreements
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_actor uuid := auth.uid();
  v_before public.service_agreements%rowtype;
  v_after public.service_agreements%rowtype;
begin
  select * into v_before from public.service_agreements a where a.id = p_agreement_id for update;
  if not found or not public.is_admin_for_org(v_before.provider_organization_id) then raise exception 'Service agreement not found or access denied'; end if;
  if p_ends_on is null then raise exception 'Give the date the agreement ends'; end if;
  -- ends_on is the last day in force; the day before it started means it never took effect (cancelled)
  if v_before.starts_on is not null and p_ends_on < v_before.starts_on - 1 then raise exception 'The agreement cannot end before it started (%). To cancel one that never took effect, end it the day before it started.', to_char(v_before.starts_on, 'DD Mon YYYY'); end if;
  if char_length(trim(coalesce(p_reason, ''))) not between 3 and 500 then raise exception 'Say why the agreement is ending (3 to 500 characters)'; end if;
  update public.service_agreements a set ends_on = p_ends_on where a.id = v_before.id returning * into v_after;
  insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_before.provider_organization_id, v_actor, 'service_agreement_ended', 'service_agreements', v_before.id,
    jsonb_build_object('client_organization_id', v_before.client_organization_id, 'agreement_name', v_before.name, 'reason', trim(p_reason),
      'ends_on', p_ends_on, 'before', jsonb_build_object('ends_on', v_before.ends_on), 'after', jsonb_build_object('ends_on', v_after.ends_on)));
  return v_after;
end;
$$;
revoke all on function public.end_service_agreement(uuid, date, text) from public, anon;
grant execute on function public.end_service_agreement(uuid, date, text) to authenticated, service_role;
comment on function public.end_service_agreement(uuid, date, text) is 'Provider administrator ends (or re-dates the end of) a service agreement; reason required; audited service_agreement_ended with before/after ends_on. Live-agreement predicates read ends_on.';

drop function if exists public.get_crm_onboarding_workspace();
create function public.get_crm_onboarding_workspace()
 RETURNS TABLE(ledger_id uuid, account_organization_id uuid, account_name text, organization_status text, organization_updated_at timestamp with time zone, current_stage text, ledger_status text, version integer, started_at timestamp with time zone, target_live_at timestamp with time zone, days_open integer, overdue boolean, has_primary_contact boolean, agreement_id uuid, agreement_name text, invitation_status text, readiness jsonb, assigned_to uuid, assigned_name text, stage_note text, client_user_count integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
as $$
DECLARE
  v_actor uuid := auth.uid();
  v_provider uuid;
BEGIN
  SELECT organization_id INTO v_provider FROM public.user_profiles WHERE id = v_actor AND deactivated_at IS NULL;
  IF v_provider IS NULL OR NOT public.is_admin_for_org(v_provider) THEN RAISE EXCEPTION 'Active CRM administrator required'; END IF;
  RETURN QUERY
  SELECT l.id, o.id, o.name, o.status, o.updated_at, l.current_stage, l.status, l.version, l.started_at, l.target_live_at,
    greatest(0, floor(extract(epoch FROM (now() - l.started_at)) / 86400)::integer), l.target_live_at < now(),
    EXISTS(SELECT 1 FROM public.crm_contacts c WHERE c.organization_id = o.id AND c.is_primary AND c.deactivated_at IS NULL),
    sa.id, sa.name, sa.invitation_status,
    CASE WHEN sa.id IS NULL THEN NULL ELSE public.get_crm_operational_readiness(sa.id) END,
    l.assigned_to, u.display_name, l.stage_note,
    (SELECT count(*)::integer FROM public.user_profiles cu WHERE cu.organization_id = o.id AND cu.deactivated_at IS NULL)
  FROM public.crm_onboarding_ledgers l
  JOIN public.organizations o ON o.id = l.account_organization_id
  LEFT JOIN public.user_profiles u ON u.id = l.assigned_to
  LEFT JOIN LATERAL(
    SELECT a.id, a.name, a.invitation_status
    FROM public.service_agreements a
    WHERE a.provider_organization_id = ANY(public.get_descendant_organizations(l.provider_organization_id))
      AND a.client_organization_id = l.account_organization_id
      AND a.agreement_type = 'operational'
      AND (a.ends_on IS NULL OR a.ends_on >= current_date)
    ORDER BY CASE WHEN a.invitation_status = 'accepted' THEN 0 WHEN a.invitation_status = 'invited' THEN 1 ELSE 2 END, a.created_at DESC
    LIMIT 1
  ) sa ON true
  WHERE l.provider_organization_id = ANY(public.get_descendant_organizations(v_provider)) AND l.status <> 'activated'
  ORDER BY l.target_live_at, l.started_at;
END;
$$;
revoke all on function public.get_crm_onboarding_workspace() from public, anon;
grant execute on function public.get_crm_onboarding_workspace() to authenticated, service_role;

create or replace function public.manage_crm_onboarding_workflow(p_account_organization_id uuid, p_expected_version integer, p_stage text, p_target_live_at timestamp with time zone, p_assigned_to uuid, p_note text)
 RETURNS crm_onboarding_ledgers
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
as $$
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
      AND (sa.ends_on IS NULL OR sa.ends_on >= current_date)
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

create or replace function public.activate_crm_account(p_account_organization_id uuid, p_agreement_id uuid, p_expected_organization_updated_at timestamp with time zone, p_expected_ledger_version integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
as $$
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
$$;

create or replace function public.prepare_crm_client_invitation(p_account_organization_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
as $$
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
  IF v_site_count = 0 THEN RAISE EXCEPTION 'Add at least one active site before inviting the client'; END IF;
  IF v_zone_count = 0 THEN RAISE EXCEPTION 'Add at least one active zone before inviting the client'; END IF;

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
$$;
