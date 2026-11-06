-- Service-only, explicitly targeted recovery of one failed Vibe coding turn.
CREATE OR REPLACE FUNCTION public.builder_vibe_recover_failed_turn(
  p_session_id uuid,
  p_message_id uuid,
  p_expected_head text,
  p_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_session public.builder_vibe_sessions%ROWTYPE;
  v_message public.builder_vibe_messages%ROWTYPE;
  v_error text;
  v_retries integer;
  v_committed boolean;
BEGIN
  IF p_session_id IS NULL OR p_message_id IS NULL OR p_request_id IS NULL
     OR p_expected_head IS NULL OR p_expected_head !~ '^[0-9a-f]{40}$' THEN
    RAISE EXCEPTION 'A session, owner message, full branch head and request id are required';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id::text, 0));
  SELECT * INTO v_session FROM public.builder_vibe_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Vibe session not found'; END IF;
  SELECT * INTO v_message FROM public.builder_vibe_messages
   WHERE id = p_message_id AND session_id = p_session_id FOR UPDATE;
  IF NOT FOUND OR v_message.role <> 'owner' OR v_message.kind <> 'message'
     OR coalesce(v_message.payload->>'action', 'message') <> 'message' THEN
    RAISE EXCEPTION 'Vibe coding turn not found';
  END IF;

  IF v_message.payload->>'governed_recovery_request_id' = p_request_id::text THEN
    IF v_message.payload->>'governed_recovery_expected_head' IS DISTINCT FROM p_expected_head THEN
      RAISE EXCEPTION 'Recovery request was already used with a different branch head';
    END IF;
    RETURN jsonb_build_object('result', 'already_scheduled', 'message_status', v_message.status);
  END IF;
  IF v_message.payload ? 'governed_recovery_request_id'
     OR EXISTS (
       SELECT 1 FROM public.builder_vibe_messages
        WHERE role = 'system' AND payload->>'reason' = 'governed_turn_recovery'
          AND payload->>'request_id' = p_request_id::text
     ) THEN
    RAISE EXCEPTION 'This turn or request id has already been used for recovery';
  END IF;
  IF v_session.status <> 'open' OR v_session.pr_url IS NOT NULL
     OR v_session.head_sha IS DISTINCT FROM p_expected_head THEN
    RAISE EXCEPTION 'Vibe session is closed, busy, published or no longer at the expected branch head';
  END IF;
  IF v_message.status IS DISTINCT FROM 'failed' OR v_message.completed_at IS NULL THEN
    RAISE EXCEPTION 'Only a completed failed turn can be recovered';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.builder_vibe_messages
     WHERE session_id = p_session_id AND role = 'owner' AND id <> p_message_id
       AND (seq > v_message.seq OR status IN ('queued', 'claimed'))
  ) THEN
    RAISE EXCEPTION 'A newer or pending owner instruction prevents recovery';
  END IF;

  SELECT content INTO v_error FROM public.builder_vibe_messages
   WHERE session_id = p_session_id AND role = 'bob' AND kind = 'error' AND seq > v_message.seq
   ORDER BY seq DESC LIMIT 1;
  IF NOT FOUND OR NOT (
    v_error LIKE 'Changes are not verified:%'
    OR v_error LIKE 'The automatic continuation %'
    OR v_error LIKE 'The execution budget %'
  ) THEN
    RAISE EXCEPTION 'The latest turn has no recoverable verification or budget failure';
  END IF;
  IF v_message.payload ? 'restart_retries'
     AND coalesce(v_message.payload->>'restart_retries', '') !~ '^[01]$' THEN
    RAISE EXCEPTION 'The turn restart count is invalid or exhausted';
  END IF;
  v_retries := coalesce((v_message.payload->>'restart_retries')::integer, 0) + 1;
  SELECT EXISTS (
    SELECT 1 FROM public.builder_vibe_messages
     WHERE session_id = p_session_id AND seq > v_message.seq AND role = 'bob' AND kind = 'diff'
       AND payload->>'commit' = p_expected_head
  ) INTO v_committed;

  UPDATE public.builder_vibe_messages
     SET status = 'queued', claimed_at = NULL, completed_at = NULL,
         payload = payload || jsonb_build_object(
           'restart_retries', v_retries,
           'governed_recovery_request_id', p_request_id::text,
           'governed_recovery_expected_head', p_expected_head,
           'governed_recovery_committed_edits', v_committed
         )
   WHERE id = p_message_id;
  INSERT INTO public.builder_vibe_messages (session_id, role, kind, content, payload)
  VALUES (
    p_session_id, 'system', 'status',
    'A governed recovery queued this original failed coding turn again on its existing branch. No new owner message was created; verification and approval gates remain in place.',
    jsonb_build_object(
      'reason', 'governed_turn_recovery', 'message_id', p_message_id,
      'request_id', p_request_id, 'expected_head', p_expected_head,
      'credential_class', 'service_operator'
    )
  );
  RETURN jsonb_build_object('result', 'scheduled', 'message_status', 'queued');
END;
$$;

REVOKE ALL ON FUNCTION public.builder_vibe_recover_failed_turn(uuid, uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_vibe_recover_failed_turn(uuid, uuid, text, uuid) TO service_role;
