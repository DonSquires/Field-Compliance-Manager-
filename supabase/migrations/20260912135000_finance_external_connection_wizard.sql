CREATE TABLE IF NOT EXISTS public.finance_external_connection_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider_type text NOT NULL CHECK (provider_type IN ('ird','bank')),
  connection_mode text NOT NULL CHECK (connection_mode IN ('oauth','approved_provider','secure_file_import','manual_review')),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','awaiting_authorisation','connected','needs_review','disconnected','failed')),
  requested_scopes text[] NOT NULL DEFAULT '{}',
  external_reference text,
  bank_account_id uuid REFERENCES public.bank_accounts(id) ON DELETE SET NULL,
  consent_confirmed boolean NOT NULL DEFAULT false,
  consent_confirmed_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  consent_confirmed_at timestamptz,
  last_sync_at timestamptz,
  last_error text,
  setup_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, provider_type, bank_account_id)
);

ALTER TABLE public.finance_external_connection_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY finance_external_connection_requests_select ON public.finance_external_connection_requests FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
REVOKE ALL ON TABLE public.finance_external_connection_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.finance_external_connection_requests TO authenticated;
GRANT ALL ON TABLE public.finance_external_connection_requests TO service_role;

CREATE OR REPLACE FUNCTION public.request_finance_external_connection(
  p_provider_type text,
  p_connection_mode text,
  p_requested_scopes text[] DEFAULT '{}',
  p_bank_account_id uuid DEFAULT NULL,
  p_consent_confirmed boolean DEFAULT false
)
RETURNS public.finance_external_connection_requests
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid(); v_org uuid; v_request public.finance_external_connection_requests%rowtype; v_account public.bank_accounts%rowtype;
BEGIN
  SELECT organization_id INTO v_org FROM public.user_profiles WHERE id = v_actor AND deactivated_at IS NULL;
  IF v_org IS NULL OR NOT public.is_admin_for_org(v_org) THEN RAISE EXCEPTION 'Active finance administrator required'; END IF;
  IF p_provider_type NOT IN ('ird','bank') THEN RAISE EXCEPTION 'Unsupported finance connection'; END IF;
  IF p_connection_mode NOT IN ('oauth','approved_provider','secure_file_import','manual_review') THEN RAISE EXCEPTION 'Unsupported connection method'; END IF;
  IF p_provider_type = 'bank' AND p_bank_account_id IS NULL THEN RAISE EXCEPTION 'Select the bank account to connect'; END IF;
  IF p_provider_type = 'bank' THEN
    SELECT * INTO v_account FROM public.bank_accounts WHERE id = p_bank_account_id AND organization_id = v_org AND is_active;
    IF NOT FOUND THEN RAISE EXCEPTION 'Active bank account not found in organization'; END IF;
  END IF;
  IF NOT p_consent_confirmed THEN RAISE EXCEPTION 'Connection consent is required'; END IF;
  INSERT INTO public.finance_external_connection_requests(organization_id, provider_type, connection_mode, requested_scopes, bank_account_id, consent_confirmed, consent_confirmed_by, consent_confirmed_at, status, setup_summary, created_by)
  VALUES (v_org, p_provider_type, p_connection_mode, COALESCE(p_requested_scopes, '{}'), p_bank_account_id, true, v_actor, now(), 'awaiting_authorisation', jsonb_build_object('credentials_collected', false, 'human_approval_required', true, 'data_minimised', true, 'next_action', CASE WHEN p_provider_type = 'ird' THEN 'Complete the approved IRD/provider authorization window' ELSE 'Complete the approved bank-provider authorization window' END), v_actor)
  ON CONFLICT (organization_id, provider_type, bank_account_id) DO UPDATE SET connection_mode = EXCLUDED.connection_mode, requested_scopes = EXCLUDED.requested_scopes, consent_confirmed = true, consent_confirmed_by = EXCLUDED.consent_confirmed_by, consent_confirmed_at = now(), status = CASE WHEN finance_external_connection_requests.status = 'connected' THEN finance_external_connection_requests.status ELSE 'awaiting_authorisation' END, setup_summary = EXCLUDED.setup_summary, updated_at = now()
  RETURNING * INTO v_request;
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata) VALUES (v_org, v_actor, 'finance_external_connection_requested', 'finance_external_connection_requests', v_request.id, jsonb_build_object('provider_type', p_provider_type, 'connection_mode', p_connection_mode, 'requested_scopes', p_requested_scopes, 'credentials_collected', false));
  RETURN v_request;
END;
$$;

REVOKE ALL ON FUNCTION public.request_finance_external_connection(text,text,text[],uuid,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_finance_external_connection(text,text,text[],uuid,boolean) TO authenticated, service_role;
