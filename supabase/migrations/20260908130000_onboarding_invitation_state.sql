-- Keep provider onboarding reads aligned with the invitation state shown in the Client Portfolio.

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
  invitation_status text,
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
  SELECT organization_id INTO v_provider FROM public.user_profiles WHERE id = v_actor AND deactivated_at IS NULL;
  IF v_provider IS NULL OR NOT public.is_admin_for_org(v_provider) THEN RAISE EXCEPTION 'Active CRM administrator required'; END IF;
  RETURN QUERY
  SELECT l.id, o.id, o.name, o.status, o.updated_at, l.current_stage, l.status, l.version, l.started_at, l.target_live_at,
    greatest(0, floor(extract(epoch FROM (now() - l.started_at)) / 86400)::integer), l.target_live_at < now(),
    EXISTS(SELECT 1 FROM public.crm_contacts c WHERE c.organization_id = o.id AND c.is_primary AND c.deactivated_at IS NULL),
    sa.id, sa.name, sa.invitation_status,
    CASE WHEN sa.id IS NULL THEN NULL ELSE public.get_crm_operational_readiness(sa.id) END,
    l.assigned_to, u.display_name, l.stage_note
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
