-- Bob Builder chat: the Builder page's own conversation lane for the platform owner.
-- Owner ruling 2026-10-25: the Bob Builder chat is independent of the in-app agentic
-- Bob chat (onspace-ai-chat / bob_conversations / bob_messages / bob_self_memory), which
-- serves users inside the app. Builder chat turns are written through the governed RPCs
-- below; the VPS control-plane worker (service role) claims them, answers with the
-- Builder model chain and Builder-only read tools, and may PROPOSE a Builder job. A
-- proposal becomes a job only when the owner confirms it through the existing
-- bob-builder-control-room create path. Nothing here touches tenant data.

CREATE TABLE IF NOT EXISTS public.builder_chat_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by uuid NOT NULL,
  title text NOT NULL DEFAULT 'Bob Builder chat' CHECK (char_length(title) BETWEEN 1 AND 160),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'working', 'closed')),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);

CREATE INDEX IF NOT EXISTS builder_chat_threads_activity_idx ON public.builder_chat_threads (last_activity_at DESC);

CREATE TABLE IF NOT EXISTS public.builder_chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY,
  thread_id uuid NOT NULL REFERENCES public.builder_chat_threads(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'bob', 'system', 'tool')),
  kind text NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'thinking', 'tool', 'proposal', 'error', 'status')),
  content text NOT NULL DEFAULT '' CHECK (char_length(content) <= 40000),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text CHECK (status IS NULL OR status IN ('queued', 'claimed', 'done', 'failed')),
  client_request_id text CHECK (client_request_id IS NULL OR char_length(client_request_id) <= 80),
  created_by uuid,
  claimed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (thread_id, client_request_id)
);

CREATE INDEX IF NOT EXISTS builder_chat_messages_thread_seq_idx ON public.builder_chat_messages (thread_id, seq);
CREATE INDEX IF NOT EXISTS builder_chat_messages_queue_idx ON public.builder_chat_messages (created_at) WHERE status = 'queued';

ALTER TABLE public.builder_chat_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.builder_chat_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS builder_chat_threads_grand_master_read ON public.builder_chat_threads;
CREATE POLICY builder_chat_threads_grand_master_read ON public.builder_chat_threads
  FOR SELECT TO authenticated USING (public.is_grand_master());
DROP POLICY IF EXISTS builder_chat_messages_grand_master_read ON public.builder_chat_messages;
CREATE POLICY builder_chat_messages_grand_master_read ON public.builder_chat_messages
  FOR SELECT TO authenticated USING (public.is_grand_master());

REVOKE ALL ON public.builder_chat_threads, public.builder_chat_messages FROM anon, authenticated;
GRANT SELECT ON public.builder_chat_threads, public.builder_chat_messages TO authenticated;
GRANT ALL ON public.builder_chat_threads, public.builder_chat_messages TO service_role;

CREATE OR REPLACE FUNCTION public.builder_chat_require_owner()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_grand_master() THEN
    RAISE EXCEPTION 'Bob Builder chat is limited to the platform owner' USING ERRCODE = '42501';
  END IF;
  RETURN auth.uid();
END;
$$;

CREATE OR REPLACE FUNCTION public.builder_chat_thread_open(p_title text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := public.builder_chat_require_owner();
  v_id uuid;
  v_title text := left(coalesce(nullif(btrim(p_title), ''), 'Bob Builder chat'), 160);
BEGIN
  INSERT INTO public.builder_chat_threads (created_by, title) VALUES (v_user, v_title) RETURNING id INTO v_id;
  INSERT INTO public.builder_chat_messages (thread_id, role, kind, content, created_by)
  VALUES (v_id, 'system', 'status', 'Bob Builder chat opened. This lane is separate from in-app Bob.', v_user);
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.builder_chat_send(p_thread_id uuid, p_content text, p_client_request_id text DEFAULT NULL, p_context jsonb DEFAULT '{}'::jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := public.builder_chat_require_owner();
  v_status text;
  v_id uuid;
  v_content text := btrim(coalesce(p_content, ''));
  v_context jsonb := CASE WHEN jsonb_typeof(p_context) = 'object' THEN p_context ELSE '{}'::jsonb END;
BEGIN
  IF v_content = '' THEN RAISE EXCEPTION 'Message is empty'; END IF;
  IF char_length(v_content) > 20000 THEN RAISE EXCEPTION 'Message is longer than 20000 characters'; END IF;
  IF octet_length(v_context::text) > 4000 THEN RAISE EXCEPTION 'Builder context is too large'; END IF;
  SELECT status INTO v_status FROM public.builder_chat_threads WHERE id = p_thread_id FOR UPDATE;
  IF v_status IS NULL THEN RAISE EXCEPTION 'Builder chat not found'; END IF;
  IF v_status = 'closed' THEN RAISE EXCEPTION 'Builder chat is closed'; END IF;
  IF p_client_request_id IS NOT NULL THEN
    SELECT id INTO v_id FROM public.builder_chat_messages WHERE thread_id = p_thread_id AND client_request_id = p_client_request_id;
    IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  END IF;
  INSERT INTO public.builder_chat_messages (thread_id, role, kind, content, payload, status, client_request_id, created_by)
  VALUES (p_thread_id, 'owner', 'message', v_content, jsonb_build_object('context', v_context), 'queued', left(p_client_request_id, 80), v_user)
  RETURNING id INTO v_id;
  UPDATE public.builder_chat_threads SET last_activity_at = now(), updated_at = now() WHERE id = p_thread_id;
  RETURN v_id;
END;
$$;

-- Links a Bob proposal to the Builder job the owner created from it (the job itself is created by
-- bob-builder-control-room, never here). A proposal can be accepted once.
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
     SET payload = payload || jsonb_build_object('job_id', p_job_id, 'accepted_by', v_user, 'accepted_at', now())
   WHERE id = p_message_id AND kind = 'proposal' AND NOT (payload ? 'job_id')
  RETURNING thread_id INTO v_thread;
  IF v_thread IS NULL THEN RAISE EXCEPTION 'Proposal not found or already accepted'; END IF;
  INSERT INTO public.builder_chat_messages (thread_id, role, kind, content, payload, created_by)
  VALUES (v_thread, 'system', 'status', 'Owner created the proposed Builder job.', jsonb_build_object('job_id', p_job_id, 'proposal_id', p_message_id), v_user);
  UPDATE public.builder_chat_threads SET last_activity_at = now(), updated_at = now() WHERE id = v_thread;
END;
$$;

CREATE OR REPLACE FUNCTION public.builder_chat_thread_close(p_thread_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := public.builder_chat_require_owner();
BEGIN
  UPDATE public.builder_chat_threads SET status = 'closed', closed_at = now(), updated_at = now()
   WHERE id = p_thread_id AND status <> 'closed';
  IF NOT FOUND THEN RAISE EXCEPTION 'Builder chat not found or already closed'; END IF;
  UPDATE public.builder_chat_messages SET status = 'failed', completed_at = now()
   WHERE thread_id = p_thread_id AND status = 'queued';
  INSERT INTO public.builder_chat_messages (thread_id, role, kind, content, created_by)
  VALUES (p_thread_id, 'system', 'status', 'Chat closed by the owner.', v_user);
END;
$$;

-- Worker-only: claim the oldest queued owner turn for a thread that is not already busy.
CREATE OR REPLACE FUNCTION public.builder_chat_claim_next()
RETURNS SETOF public.builder_chat_messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.builder_chat_messages m
     SET status = 'claimed', claimed_at = now()
   WHERE m.id = (
     SELECT q.id FROM public.builder_chat_messages q
       JOIN public.builder_chat_threads t ON t.id = q.thread_id
      WHERE q.status = 'queued' AND t.status <> 'closed'
        AND NOT EXISTS (SELECT 1 FROM public.builder_chat_messages c WHERE c.thread_id = q.thread_id AND c.status = 'claimed')
      ORDER BY q.created_at
      LIMIT 1
      FOR UPDATE OF q SKIP LOCKED)
  RETURNING m.*;
END;
$$;

REVOKE ALL ON FUNCTION public.builder_chat_require_owner() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.builder_chat_thread_open(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.builder_chat_send(uuid, text, text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.builder_chat_record_job(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.builder_chat_thread_close(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.builder_chat_claim_next() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_chat_require_owner() TO authenticated;
GRANT EXECUTE ON FUNCTION public.builder_chat_thread_open(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.builder_chat_send(uuid, text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.builder_chat_record_job(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.builder_chat_thread_close(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.builder_chat_claim_next() TO service_role;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.builder_chat_threads;
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$$;
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.builder_chat_messages;
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$$;
