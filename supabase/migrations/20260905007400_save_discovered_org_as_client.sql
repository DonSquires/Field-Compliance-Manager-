CREATE OR REPLACE FUNCTION public.save_discovered_org_as_client(
  p_client_request_id uuid,
  p_source_organization_id uuid
)
RETURNS public.organizations
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_provider uuid;
  v_source public.organizations%rowtype;
  v_client public.organizations%rowtype;
BEGIN
  SELECT organization_id INTO v_provider
  FROM public.user_profiles
  WHERE id = v_actor AND deactivated_at IS NULL;
  IF v_provider IS NULL OR NOT public.is_admin_for_org(v_provider) THEN
    RAISE EXCEPTION 'Active CRM administrator required';
  END IF;
  IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required'; END IF;

  SELECT * INTO v_source FROM public.organizations WHERE id = p_source_organization_id;
  IF NOT FOUND OR v_source.id = v_provider THEN RAISE EXCEPTION 'A valid external organization is required'; END IF;
  IF NOT v_source.active OR v_source.status <> 'active' THEN RAISE EXCEPTION 'Only an active discovered organization can be saved as a client'; END IF;

  SELECT * INTO v_client
  FROM public.organizations
  WHERE parent_organization_id = v_provider
    AND (client_request_id = p_client_request_id OR external_refs->>'canonical_organization_id' = v_source.id::text);
  IF FOUND THEN RETURN v_client; END IF;

  INSERT INTO public.organizations(
    name, organization_type, parent_organization_id, active, status, nzbn,
    company_registration_number, contact_email, contact_phone, billing_email,
    billing_address, account_notes, external_refs, client_request_id
  ) VALUES (
    v_source.name, 'client', v_provider, false, 'prospect', v_source.nzbn,
    v_source.company_registration_number, v_source.contact_email, v_source.contact_phone,
    v_source.billing_email, v_source.billing_address, v_source.account_notes,
    jsonb_build_object('canonical_organization_id', v_source.id, 'source_status', v_source.status),
    p_client_request_id
  ) RETURNING * INTO v_client;

  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (
    v_provider, v_actor, 'crm_discovered_organization_saved_as_client', 'organizations', v_client.id,
    jsonb_build_object('canonical_organization_id', v_source.id, 'client_account_id', v_client.id)
  );
  RETURN v_client;
END;
$$;

REVOKE ALL ON FUNCTION public.save_discovered_org_as_client(uuid, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_discovered_org_as_client(uuid, uuid) TO authenticated, service_role;