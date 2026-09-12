ALTER TABLE public.finance_external_connection_requests
  ADD COLUMN IF NOT EXISTS provider_name text;

CREATE OR REPLACE FUNCTION public.request_anz_bank_connection(
  p_bank_account_id uuid,
  p_connection_mode text DEFAULT 'approved_provider',
  p_requested_scopes text[] DEFAULT ARRAY['account_transactions','balances','payment_matches'],
  p_consent_confirmed boolean DEFAULT false
)
RETURNS public.finance_external_connection_requests
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid(); v_org uuid; v_account public.bank_accounts%rowtype; v_request public.finance_external_connection_requests%rowtype;
BEGIN
  SELECT organization_id INTO v_org FROM public.user_profiles WHERE id = v_actor AND deactivated_at IS NULL;
  IF v_org IS NULL OR NOT public.is_admin_for_org(v_org) THEN RAISE EXCEPTION 'Active finance administrator required'; END IF;
  IF p_connection_mode NOT IN ('oauth','approved_provider','secure_file_import','manual_review') THEN RAISE EXCEPTION 'Unsupported ANZ connection method'; END IF;
  IF NOT p_consent_confirmed THEN RAISE EXCEPTION 'ANZ connection consent is required'; END IF;
  SELECT * INTO v_account FROM public.bank_accounts WHERE id = p_bank_account_id AND organization_id = v_org AND is_active AND bank_name ILIKE '%ANZ%';
  IF NOT FOUND THEN RAISE EXCEPTION 'Select an active ANZ bank account'; END IF;
  INSERT INTO public.finance_external_connection_requests(organization_id, provider_type, provider_name, connection_mode, requested_scopes, bank_account_id, consent_confirmed, consent_confirmed_by, consent_confirmed_at, status, setup_summary, created_by)
  VALUES (v_org, 'bank', 'ANZ', p_connection_mode, COALESCE(p_requested_scopes, ARRAY['account_transactions','balances','payment_matches']), p_bank_account_id, true, v_actor, now(), 'awaiting_authorisation', jsonb_build_object('bank', 'ANZ', 'credentials_collected', false, 'human_approval_required', true, 'data_minimised', true, 'adapter_required', 'approved ANZ/Open Banking provider'), v_actor)
  ON CONFLICT (organization_id, provider_type, bank_account_id) DO UPDATE SET provider_name = 'ANZ', connection_mode = EXCLUDED.connection_mode, requested_scopes = EXCLUDED.requested_scopes, consent_confirmed = true, consent_confirmed_by = EXCLUDED.consent_confirmed_by, consent_confirmed_at = now(), status = CASE WHEN finance_external_connection_requests.status = 'connected' THEN finance_external_connection_requests.status ELSE 'awaiting_authorisation' END, setup_summary = EXCLUDED.setup_summary, updated_at = now()
  RETURNING * INTO v_request;
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata) VALUES (v_org, v_actor, 'anz_bank_connection_requested', 'finance_external_connection_requests', v_request.id, jsonb_build_object('provider_name', 'ANZ', 'bank_account_id', p_bank_account_id, 'credentials_collected', false));
  RETURN v_request;
END;
$$;

REVOKE ALL ON FUNCTION public.request_anz_bank_connection(uuid,text,text[],boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_anz_bank_connection(uuid,text,text[],boolean) TO authenticated, service_role;
