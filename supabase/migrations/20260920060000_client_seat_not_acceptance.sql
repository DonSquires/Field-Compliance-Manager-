-- The client's portal seat is separate from commercial acceptance: a quote-accepted agreement still has nobody who
-- can sign in. prepare_crm_client_invitation now refuses only when the client already has an active user, and the
-- onboarding workspace reports client_user_count so the panel offers 'Invite client' on that fact.

-- prepare_crm_client_invitation: the first seat is what matters
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
    ORDER BY CASE WHEN a.invitation_status = 'accepted' THEN 0 WHEN a.invitation_status = 'invited' THEN 1 ELSE 2 END, a.created_at DESC
    LIMIT 1
  ) sa ON true
  WHERE l.provider_organization_id = ANY(public.get_descendant_organizations(v_provider)) AND l.status <> 'activated'
  ORDER BY l.target_live_at, l.started_at;
END;
$$;

revoke all on function public.get_crm_onboarding_workspace() from public, anon;
grant execute on function public.get_crm_onboarding_workspace() to authenticated, service_role;
