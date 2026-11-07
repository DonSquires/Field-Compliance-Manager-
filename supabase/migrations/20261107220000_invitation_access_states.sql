-- Invitations: let administrators see who can actually sign in, and invite active clients.
--
-- 1. get_user_sign_in_states: read-only sign-in state (no login / invitation pending / signed in)
--    for people the caller may manage. Mirrors update-user-email and resend-invite authority so the
--    UI only offers an action the server will accept.
-- 2. get_client_portal_access: whether a managed client account has anyone who can sign in.
-- 3. prepare_crm_client_invitation: active client accounts (not only prospects) can have their first
--    portal user invited; 25 of 27 active clients had no login and no path to one.

CREATE OR REPLACE FUNCTION public.get_user_sign_in_states(p_user_ids uuid[])
RETURNS TABLE(user_id uuid, sign_in_state text, last_sign_in_at timestamptz, invited_at timestamptz)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor public.user_profiles%rowtype;
BEGIN
  SELECT * INTO v_actor FROM public.user_profiles WHERE id = auth.uid() AND deactivated_at IS NULL;
  IF NOT FOUND OR v_actor.role NOT IN ('grand_master', 'master', 'admin', 'admin_officer', 'client_admin') THEN
    RAISE EXCEPTION 'Active identity administrator required';
  END IF;
  IF coalesce(cardinality(p_user_ids), 0) > 500 THEN RAISE EXCEPTION 'Request at most 500 people at a time'; END IF;

  RETURN QUERY
  SELECT target.id,
    CASE WHEN login.id IS NULL THEN 'no_login' WHEN login.last_sign_in_at IS NOT NULL THEN 'signed_in' ELSE 'invited' END,
    login.last_sign_in_at,
    coalesce(login.invited_at, login.confirmation_sent_at)
  FROM public.user_profiles target
  LEFT JOIN auth.users login ON login.id = target.id
  WHERE target.id = ANY(coalesce(p_user_ids, '{}'::uuid[]))
    AND (v_actor.role = 'grand_master' OR target.organization_id = v_actor.organization_id)
    AND (v_actor.role <> 'client_admin' OR target.role LIKE 'client\_%')
    AND public.identity_role_level(target.role) <= public.identity_role_level(v_actor.role);
END;
$function$;

REVOKE ALL ON FUNCTION public.get_user_sign_in_states(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_user_sign_in_states(uuid[]) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_client_portal_access(p_account_organization_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_provider uuid;
  v_account public.organizations%rowtype;
  v_email text;
  v_places integer;
  v_users integer;
  v_signed_in integer;
BEGIN
  SELECT organization_id INTO v_provider FROM public.user_profiles WHERE id = auth.uid() AND deactivated_at IS NULL;
  IF v_provider IS NULL OR NOT public.is_admin_for_org(v_provider) THEN RAISE EXCEPTION 'Active provider CRM administrator required'; END IF;
  SELECT * INTO v_account FROM public.organizations WHERE id = p_account_organization_id;
  IF NOT FOUND OR NOT public.crm_actor_can_manage_account(v_account.id) THEN RAISE EXCEPTION 'Managed client account not found'; END IF;

  SELECT lower(trim(c.email)) INTO v_email FROM public.crm_contacts c
  WHERE c.organization_id = v_account.id AND c.is_primary AND c.deactivated_at IS NULL AND c.email IS NOT NULL
  ORDER BY c.updated_at DESC LIMIT 1;
  v_email := coalesce(v_email, nullif(lower(trim(v_account.contact_email)), ''));

  SELECT (SELECT count(*) FROM public.client_sites s WHERE s.client_organization_id = v_account.id AND s.active)
    + (SELECT count(*) FROM public.location_zones z JOIN public.locations l ON l.id = z.location_id
       WHERE l.organization_id = v_account.id AND z.is_active)
  INTO v_places;

  SELECT count(*), count(*) FILTER (WHERE login.last_sign_in_at IS NOT NULL)
  INTO v_users, v_signed_in
  FROM public.user_profiles u LEFT JOIN auth.users login ON login.id = u.id
  WHERE u.organization_id = v_account.id AND u.deactivated_at IS NULL;

  RETURN jsonb_build_object(
    'account_organization_id', v_account.id,
    'account_status', v_account.status,
    'contact_email', v_email,
    'place_count', v_places,
    'client_user_count', v_users,
    'signed_in_user_count', v_signed_in,
    'pending_user_count', v_users - v_signed_in,
    'can_invite', v_users = 0 AND v_email IS NOT NULL AND v_places > 0
      AND ((v_account.status = 'prospect' AND NOT v_account.active) OR (v_account.status = 'active' AND v_account.active)),
    'invite_blocker', CASE
      WHEN v_users > 0 THEN NULL
      WHEN v_account.status NOT IN ('prospect', 'active') THEN 'This account is not active.'
      WHEN v_email IS NULL THEN 'Add a primary contact email before inviting the client.'
      WHEN v_places = 0 THEN 'Add at least one place before inviting the client.'
      ELSE NULL END);
END;
$function$;

REVOKE ALL ON FUNCTION public.get_client_portal_access(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_client_portal_access(uuid) TO authenticated, service_role;

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
  -- prospects before activation, and active clients that still have nobody who can sign in
  SELECT * INTO v_account FROM public.organizations
  WHERE id = p_account_organization_id AND ((status = 'prospect' AND NOT active) OR (status = 'active' AND active)) FOR UPDATE;
  IF NOT FOUND OR NOT public.crm_actor_can_manage_account(v_account.id) THEN RAISE EXCEPTION 'Managed client account not found'; END IF;

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
    jsonb_build_object('account_organization_id', v_account.id, 'account_status', v_account.status, 'site_count', v_site_count, 'zone_count', v_zone_count, 'contact_email', v_contact.email));
  RETURN jsonb_build_object('account_organization_id', v_account.id, 'agreement_id', v_agreement.id, 'provider_organization_id', v_agreement.provider_organization_id, 'agreement_status', v_agreement.invitation_status, 'email', lower(trim(v_contact.email)), 'display_name', trim(coalesce(v_contact.first_name, '') || ' ' || coalesce(v_contact.last_name, '')), 'site_count', v_site_count, 'zone_count', v_zone_count);
END;
$function$;

REVOKE ALL ON FUNCTION public.prepare_crm_client_invitation(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.prepare_crm_client_invitation(uuid) TO authenticated, service_role;
