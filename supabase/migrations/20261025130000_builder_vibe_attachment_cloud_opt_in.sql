CREATE OR REPLACE FUNCTION public.builder_vibe_send_with_attachments_opt_in(
  p_session_id uuid,
  p_content text,
  p_client_request_id text,
  p_attachment_ids uuid[],
  p_allow_ollama_cloud boolean
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := public.builder_vibe_require_owner();
  v_message_id uuid;
  v_payload jsonb;
  v_consent boolean := coalesce(p_allow_ollama_cloud, false);
BEGIN
  PERFORM 1 FROM public.builder_vibe_sessions
   WHERE id = p_session_id AND created_by = v_user AND status <> 'closed'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Open Vibe session not found for this owner';
  END IF;
  IF p_client_request_id IS NULL OR char_length(p_client_request_id) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'Attachment consent requires a request id of 1 to 80 characters';
  END IF;

  SELECT payload INTO v_payload FROM public.builder_vibe_messages
   WHERE session_id = p_session_id AND client_request_id = p_client_request_id;
  IF FOUND AND coalesce(v_payload->'external_attachment_consent', 'false'::jsonb) <> to_jsonb(v_consent) THEN
    RAISE EXCEPTION 'Request id was already used with different attachment consent';
  END IF;

  v_message_id := public.builder_vibe_send_with_attachments(
    p_session_id,
    p_content,
    p_client_request_id,
    p_attachment_ids
  );

  UPDATE public.builder_vibe_messages
     SET payload = payload || jsonb_build_object(
       'external_attachment_consent', v_consent,
       'external_attachment_consent_receipt', jsonb_build_object(
         'policy_version', 'non_sensitive_context_v1',
         'actor_user_id', v_user,
         'recorded_at', now(),
         'attachment_ids', coalesce(p_attachment_ids, '{}'::uuid[]),
         'allowed', v_consent
       )
     )
   WHERE id = v_message_id
     AND session_id = p_session_id
     AND created_by = v_user
     AND NOT (payload ? 'external_attachment_consent');

  IF NOT FOUND AND v_payload IS NULL THEN
    RAISE EXCEPTION 'Vibe attachment consent could not be associated with this owner message';
  END IF;

  RETURN v_message_id;
END;
$$;

REVOKE ALL ON FUNCTION public.builder_vibe_send_with_attachments_opt_in(uuid, text, text, uuid[], boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.builder_vibe_send_with_attachments_opt_in(uuid, text, text, uuid[], boolean) TO authenticated;

COMMENT ON FUNCTION public.builder_vibe_send_with_attachments_opt_in(uuid, text, text, uuid[], boolean) IS
  'Owner-only attachment send with an explicit per-message Ollama Cloud egress attestation. The worker may send only extracted text or local image descriptions, never raw attachment bytes; no consent defaults to local-only.';
