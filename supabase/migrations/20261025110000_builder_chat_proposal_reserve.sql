-- Builder chat: serialize proposal acceptance so two tabs cannot both create a job from one proposal.
-- The owner's browser must win builder_chat_reserve_proposal before calling the control-room create
-- action; the reservation is keyed by a per-tab token so that tab can retry (the create action returns
-- the same job for a retried brief), and it lapses after five minutes if that tab disappears.

CREATE OR REPLACE FUNCTION public.builder_chat_reserve_proposal(p_message_id uuid, p_token text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := public.builder_chat_require_owner();
  v_id uuid;
BEGIN
  IF p_token IS NULL OR length(p_token) < 8 OR length(p_token) > 120 THEN RAISE EXCEPTION 'A reservation token is required'; END IF;
  UPDATE public.builder_chat_messages
     SET payload = payload || jsonb_build_object('creating_token', p_token, 'creating_by', v_user, 'creating_at', now())
   WHERE id = p_message_id AND kind = 'proposal' AND NOT (payload ? 'job_id')
     AND (NOT (payload ? 'creating_token')
          OR payload->>'creating_token' = p_token
          OR (payload->>'creating_at')::timestamptz < now() - interval '5 minutes')
  RETURNING id INTO v_id;
  RETURN v_id IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.builder_chat_release_proposal(p_message_id uuid, p_token text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := public.builder_chat_require_owner();
BEGIN
  UPDATE public.builder_chat_messages
     SET payload = payload - 'creating_token' - 'creating_by' - 'creating_at'
   WHERE id = p_message_id AND kind = 'proposal' AND payload->>'creating_token' = p_token;
END;
$$;

CREATE OR REPLACE FUNCTION public.builder_chat_record_job(p_message_id uuid, p_job_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := public.builder_chat_require_owner();
  v_thread uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.builder_jobs WHERE id = p_job_id) THEN RAISE EXCEPTION 'Builder job not found'; END IF;
  UPDATE public.builder_chat_messages
     SET payload = (payload - 'creating_token' - 'creating_by' - 'creating_at')
                   || jsonb_build_object('job_id', p_job_id, 'accepted_by', v_user, 'accepted_at', now())
   WHERE id = p_message_id AND kind = 'proposal' AND NOT (payload ? 'job_id')
  RETURNING thread_id INTO v_thread;
  IF v_thread IS NULL THEN
    -- A retried record for the job already linked is a success, not an error.
    IF EXISTS (SELECT 1 FROM public.builder_chat_messages WHERE id = p_message_id AND kind = 'proposal' AND payload->>'job_id' = p_job_id::text) THEN RETURN; END IF;
    RAISE EXCEPTION 'Proposal not found or already accepted';
  END IF;
  INSERT INTO public.builder_chat_messages (thread_id, role, kind, content, payload, created_by)
  VALUES (v_thread, 'system', 'status', 'Owner created the proposed Builder job.', jsonb_build_object('job_id', p_job_id, 'proposal_id', p_message_id), v_user);
  UPDATE public.builder_chat_threads SET last_activity_at = now(), updated_at = now() WHERE id = v_thread;
END;
$$;

REVOKE ALL ON FUNCTION public.builder_chat_reserve_proposal(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.builder_chat_release_proposal(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.builder_chat_reserve_proposal(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.builder_chat_release_proposal(uuid, text) TO authenticated;
