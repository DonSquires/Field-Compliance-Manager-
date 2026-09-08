-- Provider-owned setup may create places and prepare an invitation before client auth exists.
-- Client access is still provisioned only by the invite-org Edge Function.

CREATE OR REPLACE FUNCTION public.crm_actor_can_manage_location(p_location_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.locations l
    JOIN public.user_profiles actor ON actor.id = auth.uid() AND actor.deactivated_at IS NULL
    WHERE l.id = p_location_id
      AND public.is_admin_for_org(actor.organization_id)
      AND (
        l.organization_id = actor.organization_id
        OR l.organization_id = ANY(public.get_descendant_organizations(coalesce(actor.employer_organization_id, actor.organization_id)))
        OR EXISTS (
          SELECT 1
          FROM public.service_agreements agreement
          JOIN public.service_agreement_locations coverage ON coverage.service_agreement_id = agreement.id AND coverage.status = 'active'
          LEFT JOIN public.client_sites site ON site.id = coverage.site_id
          LEFT JOIN public.location_zones zone ON zone.id = coverage.zone_id
          WHERE agreement.provider_organization_id = actor.organization_id
            AND agreement.invitation_status = 'accepted'
            AND agreement.agreement_type = 'operational'
            AND (site.location_id = l.id OR zone.location_id = l.id)
        )
      )
  );
$$;

CREATE OR REPLACE FUNCTION public.prepare_crm_client_invitation(p_account_organization_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
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
  WHERE provider_organization_id = v_provider AND client_organization_id = v_account.id AND agreement_type = 'operational'
  ORDER BY CASE WHEN invitation_status = 'accepted' THEN 0 WHEN invitation_status = 'invited' THEN 1 ELSE 2 END, created_at DESC
  LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.service_agreements (provider_organization_id, client_organization_id, name, starts_on, agreement_type, invitation_status, client_portal_access_mode, external_refs)
    VALUES (v_provider, v_account.id, v_account.name || ' service agreement', current_date, 'operational', 'not_invited', 'transparency_only', jsonb_build_object('created_for_client_invite', true, 'created_by', v_actor))
    RETURNING * INTO v_agreement;
  END IF;
  IF v_agreement.invitation_status = 'accepted' THEN RAISE EXCEPTION 'Client invitation has already been accepted'; END IF;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_provider, v_actor, 'crm_client_invitation_prepared', 'service_agreements', v_agreement.id,
    jsonb_build_object('account_organization_id', v_account.id, 'site_count', v_site_count, 'zone_count', v_zone_count, 'contact_email', v_contact.email));
  RETURN jsonb_build_object('account_organization_id', v_account.id, 'agreement_id', v_agreement.id, 'agreement_status', v_agreement.invitation_status, 'email', lower(trim(v_contact.email)), 'display_name', trim(coalesce(v_contact.first_name, '') || ' ' || coalesce(v_contact.last_name, '')), 'site_count', v_site_count, 'zone_count', v_zone_count);
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_crm_client_invitation(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_crm_client_invitation(uuid) TO authenticated, service_role;
