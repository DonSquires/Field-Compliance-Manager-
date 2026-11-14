-- Persist whether the owner received a new Builder job or an existing idempotent result.
-- Keep builder_chat_record_job(uuid, uuid) unchanged for older clients.
CREATE OR REPLACE FUNCTION public.builder_chat_record_job_receipt(
  p_message_id uuid,
  p_job_id uuid,
  p_duplicate boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := public.builder_chat_require_owner();
  v_thread uuid;
BEGIN
  IF p_duplicate IS NULL THEN RAISE EXCEPTION 'A duplicate receipt value is required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.builder_jobs WHERE id = p_job_id) THEN RAISE EXCEPTION 'Builder job not found'; END IF;

  UPDATE public.builder_chat_messages
     SET payload = (payload - 'creating_token' - 'creating_by' - 'creating_at')
                   || jsonb_build_object('job_id', p_job_id, 'accepted_by', v_user,
                     'accepted_at', now(), 'duplicate_returned', p_duplicate)
   WHERE id = p_message_id AND kind = 'proposal' AND NOT (payload ? 'job_id')
  RETURNING thread_id INTO v_thread;

  IF v_thread IS NULL THEN
    SELECT thread_id INTO v_thread
      FROM public.builder_chat_messages
     WHERE id = p_message_id AND kind = 'proposal' AND payload->>'job_id' = p_job_id::text
       AND payload->>'accepted_by' = v_user::text;
    IF v_thread IS NULL THEN RAISE EXCEPTION 'Proposal not found or already accepted'; END IF;
    RETURN;
  END IF;

  INSERT INTO public.builder_chat_messages (thread_id, role, kind, content, payload, created_by)
  VALUES (v_thread, 'system', 'status',
    CASE WHEN p_duplicate THEN 'Owner received an existing Builder job; no duplicate was created.'
      ELSE 'Owner created the proposed Builder job.' END,
    jsonb_build_object('job_id', p_job_id, 'proposal_id', p_message_id, 'duplicate_returned', p_duplicate), v_user);
  UPDATE public.builder_chat_threads SET last_activity_at = now(), updated_at = now() WHERE id = v_thread;
END;
$$;

REVOKE ALL ON FUNCTION public.builder_chat_record_job_receipt(uuid,uuid,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.builder_chat_record_job_receipt(uuid,uuid,boolean) TO authenticated;