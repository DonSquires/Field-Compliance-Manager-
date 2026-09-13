-- client_portal_finance_enabled had no authoring path anywhere: the column
-- exists, ServiceRelationshipContext already loads it, but no RPC ever wrote
-- it and no UI ever offered a control for it. Mirrors the shape of
-- manage_crm_agreement_reporting (provider-admin gated, audited) but simpler:
-- finance visibility has no template dependency, just a boolean toggle.
CREATE OR REPLACE FUNCTION public.manage_crm_agreement_finance(
  p_agreement_id uuid,
  p_expected_invitation_status text,
  p_client_portal_finance_enabled boolean
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_agreement public.service_agreements%rowtype;
BEGIN
  SELECT * INTO v_agreement FROM public.service_agreements WHERE id=p_agreement_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Service agreement not found'; END IF;
  IF v_actor IS NULL OR NOT public.is_admin_for_org(v_agreement.provider_organization_id) THEN RAISE EXCEPTION 'Provider administrator required'; END IF;
  IF v_agreement.agreement_type <> 'operational' OR v_agreement.invitation_status <> 'accepted' THEN RAISE EXCEPTION 'Only accepted operational agreements can be configured'; END IF;
  IF v_agreement.invitation_status IS DISTINCT FROM p_expected_invitation_status THEN RAISE EXCEPTION 'Service agreement changed since it was opened'; END IF;

  UPDATE public.service_agreements
  SET client_portal_finance_enabled = coalesce(p_client_portal_finance_enabled, false)
  WHERE id = v_agreement.id
  RETURNING * INTO v_agreement;

  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  VALUES(v_agreement.provider_organization_id,v_actor,'crm_agreement_finance_updated','service_agreements',v_agreement.id,jsonb_build_object('client_portal_finance_enabled',v_agreement.client_portal_finance_enabled));

  RETURN jsonb_build_object('agreement_id',v_agreement.id,'client_portal_finance_enabled',v_agreement.client_portal_finance_enabled);
END;
$$;

REVOKE ALL ON FUNCTION public.manage_crm_agreement_finance(uuid,text,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.manage_crm_agreement_finance(uuid,text,boolean) TO authenticated, service_role;
