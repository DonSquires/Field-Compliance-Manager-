CREATE OR REPLACE FUNCTION public.start_finance_external_oauth(
  p_request_id uuid,
  p_state_hash text,
  p_state_expires_at timestamptz,
  p_adapter_name text
)
RETURNS public.finance_external_connection_requests
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_request public.finance_external_connection_requests%rowtype;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'OAuth adapter execution only'; END IF;
  IF nullif(trim(p_state_hash), '') IS NULL OR p_state_expires_at <= now() OR nullif(trim(p_adapter_name), '') IS NULL THEN RAISE EXCEPTION 'Invalid OAuth start parameters'; END IF;
  SELECT * INTO v_request FROM public.finance_external_connection_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Finance connection request not found'; END IF;
  IF v_request.status NOT IN ('awaiting_authorisation','requested','connected','failed') THEN RAISE EXCEPTION 'Connection request is not available for OAuth'; END IF;
  UPDATE public.finance_external_connection_requests SET status = 'awaiting_authorisation', adapter_name = p_adapter_name, oauth_state_hash = p_state_hash, oauth_state_expires_at = p_state_expires_at, oauth_started_at = now(), last_error = NULL, updated_at = now() WHERE id = p_request_id RETURNING * INTO v_request;
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata) VALUES (v_request.organization_id, NULL, 'finance_external_oauth_started', 'finance_external_connection_requests', v_request.id, jsonb_build_object('provider_type', v_request.provider_type, 'adapter_name', p_adapter_name, 'reauthorisation', true));
  RETURN v_request;
END;
$$;
