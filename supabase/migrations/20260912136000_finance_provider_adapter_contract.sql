ALTER TABLE public.finance_external_connection_requests
  ADD COLUMN IF NOT EXISTS provider_connection_reference text,
  ADD COLUMN IF NOT EXISTS connected_at timestamptz,
  ADD COLUMN IF NOT EXISTS disconnected_at timestamptz,
  ADD COLUMN IF NOT EXISTS sync_cursor text,
  ADD COLUMN IF NOT EXISTS adapter_name text;

CREATE OR REPLACE FUNCTION public.complete_finance_external_connection(
  p_request_id uuid,
  p_provider_connection_reference text,
  p_adapter_name text,
  p_granted_scopes text[] DEFAULT '{}'
)
RETURNS public.finance_external_connection_requests
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_request public.finance_external_connection_requests%rowtype;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Provider adapter execution only'; END IF;
  IF nullif(trim(p_provider_connection_reference), '') IS NULL OR nullif(trim(p_adapter_name), '') IS NULL THEN RAISE EXCEPTION 'Provider connection reference and adapter are required'; END IF;
  SELECT * INTO v_request FROM public.finance_external_connection_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Finance connection request not found'; END IF;
  UPDATE public.finance_external_connection_requests
  SET status = 'connected', provider_connection_reference = trim(p_provider_connection_reference), adapter_name = trim(p_adapter_name), requested_scopes = COALESCE(p_granted_scopes, requested_scopes), connected_at = now(), disconnected_at = NULL, last_error = NULL, updated_at = now()
  WHERE id = p_request_id
  RETURNING * INTO v_request;
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_request.organization_id, NULL, 'finance_external_connection_completed', 'finance_external_connection_requests', v_request.id, jsonb_build_object('provider_type', v_request.provider_type, 'adapter_name', v_request.adapter_name, 'credentials_stored_in_browser', false));
  RETURN v_request;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_finance_external_sync(
  p_request_id uuid,
  p_sync_cursor text DEFAULT NULL,
  p_error text DEFAULT NULL
)
RETURNS public.finance_external_connection_requests
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_request public.finance_external_connection_requests%rowtype;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Provider adapter execution only'; END IF;
  SELECT * INTO v_request FROM public.finance_external_connection_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Finance connection request not found'; END IF;
  UPDATE public.finance_external_connection_requests
  SET status = CASE WHEN p_error IS NULL THEN 'connected' ELSE 'failed' END, sync_cursor = COALESCE(p_sync_cursor, sync_cursor), last_sync_at = CASE WHEN p_error IS NULL THEN now() ELSE last_sync_at END, last_error = nullif(trim(p_error), ''), updated_at = now()
  WHERE id = p_request_id
  RETURNING * INTO v_request;
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_request.organization_id, NULL, 'finance_external_sync_recorded', 'finance_external_connection_requests', v_request.id, jsonb_build_object('provider_type', v_request.provider_type, 'adapter_name', v_request.adapter_name, 'success', p_error IS NULL));
  RETURN v_request;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_finance_external_connection(uuid,text,text,text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_finance_external_connection(uuid,text,text,text[]) TO service_role;
REVOKE ALL ON FUNCTION public.record_finance_external_sync(uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_finance_external_sync(uuid,text,text) TO service_role;
