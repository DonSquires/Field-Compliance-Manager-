-- Bob Builder vibe sessions: an independent chat-to-code lane for the platform owner.
-- The browser writes owner turns through the governed RPCs below; the VPS worker
-- (service role) claims them, works on one live branch per session, and streams its
-- replies back as message rows over Realtime. Nothing here touches tenant data.

CREATE TABLE IF NOT EXISTS public.builder_vibe_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by uuid NOT NULL,
  title text NOT NULL DEFAULT 'Untitled vibe session' CHECK (char_length(title) BETWEEN 1 AND 160),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'working', 'shipping', 'shipped', 'closed', 'failed')),
  base_sha text,
  branch text,
  head_sha text,
  changed_files text[] NOT NULL DEFAULT '{}',
  preview_requested boolean NOT NULL DEFAULT false,
  preview_status text NOT NULL DEFAULT 'off' CHECK (preview_status IN ('off', 'starting', 'ready', 'failed')),
  preview_detail text,
  pr_url text,
  pr_number integer,
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);

CREATE INDEX IF NOT EXISTS builder_vibe_sessions_activity_idx ON public.builder_vibe_sessions (last_activity_at DESC);

CREATE TABLE IF NOT EXISTS public.builder_vibe_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY,
  session_id uuid NOT NULL REFERENCES public.builder_vibe_sessions(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'bob', 'system', 'tool')),
  kind text NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'thinking', 'tool', 'diff', 'test', 'preview', 'error', 'status')),
  content text NOT NULL DEFAULT '' CHECK (char_length(content) <= 40000),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text CHECK (status IS NULL OR status IN ('queued', 'claimed', 'done', 'failed')),
  client_request_id text CHECK (client_request_id IS NULL OR char_length(client_request_id) <= 80),
  created_by uuid,
  claimed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, client_request_id)
);

CREATE INDEX IF NOT EXISTS builder_vibe_messages_session_seq_idx ON public.builder_vibe_messages (session_id, seq);
CREATE INDEX IF NOT EXISTS builder_vibe_messages_queue_idx ON public.builder_vibe_messages (created_at) WHERE status = 'queued';

CREATE TABLE IF NOT EXISTS public.builder_vibe_preview_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.builder_vibe_sessions(id) ON DELETE CASCADE,
  ticket_hash text NOT NULL UNIQUE,
  created_by uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.builder_vibe_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.builder_vibe_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.builder_vibe_preview_tickets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS builder_vibe_sessions_grand_master_read ON public.builder_vibe_sessions;
CREATE POLICY builder_vibe_sessions_grand_master_read ON public.builder_vibe_sessions
  FOR SELECT TO authenticated USING (public.is_grand_master());
DROP POLICY IF EXISTS builder_vibe_messages_grand_master_read ON public.builder_vibe_messages;
CREATE POLICY builder_vibe_messages_grand_master_read ON public.builder_vibe_messages
  FOR SELECT TO authenticated USING (public.is_grand_master());
-- Preview tickets carry no browser-readable policy: only their hash is stored and only the worker redeems them.

REVOKE ALL ON public.builder_vibe_sessions, public.builder_vibe_messages, public.builder_vibe_preview_tickets FROM anon, authenticated;
GRANT SELECT ON public.builder_vibe_sessions, public.builder_vibe_messages TO authenticated;
GRANT ALL ON public.builder_vibe_sessions, public.builder_vibe_messages, public.builder_vibe_preview_tickets TO service_role;

CREATE OR REPLACE FUNCTION public.builder_vibe_require_owner()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_grand_master() THEN
    RAISE EXCEPTION 'Vibe sessions are limited to the platform owner' USING ERRCODE = '42501';
  END IF;
  RETURN auth.uid();
END;
$$;

CREATE OR REPLACE FUNCTION public.builder_vibe_session_open(p_title text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := public.builder_vibe_require_owner();
  v_id uuid;
  v_title text := left(coalesce(nullif(btrim(p_title), ''), 'Untitled vibe session'), 160);
BEGIN
  INSERT INTO public.builder_vibe_sessions (created_by, title) VALUES (v_user, v_title) RETURNING id INTO v_id;
  INSERT INTO public.builder_vibe_messages (session_id, role, kind, content, created_by)
  VALUES (v_id, 'system', 'status', 'Session opened. Bob will branch from the current main on your first message.', v_user);
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.builder_vibe_send(p_session_id uuid, p_content text, p_client_request_id text DEFAULT NULL, p_action text DEFAULT 'message')
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := public.builder_vibe_require_owner();
  v_status text;
  v_id uuid;
  v_content text := btrim(coalesce(p_content, ''));
BEGIN
  IF p_action NOT IN ('message', 'ship', 'revert') THEN RAISE EXCEPTION 'Unsupported vibe action'; END IF;
  IF p_action = 'message' AND v_content = '' THEN RAISE EXCEPTION 'Message is empty'; END IF;
  IF char_length(v_content) > 20000 THEN RAISE EXCEPTION 'Message is longer than 20000 characters'; END IF;
  SELECT status INTO v_status FROM public.builder_vibe_sessions WHERE id = p_session_id FOR UPDATE;
  IF v_status IS NULL THEN RAISE EXCEPTION 'Vibe session not found'; END IF;
  IF v_status = 'closed' THEN RAISE EXCEPTION 'Vibe session is closed'; END IF;
  IF p_client_request_id IS NOT NULL THEN
    SELECT id INTO v_id FROM public.builder_vibe_messages WHERE session_id = p_session_id AND client_request_id = p_client_request_id;
    IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  END IF;
  INSERT INTO public.builder_vibe_messages (session_id, role, kind, content, payload, status, client_request_id, created_by)
  VALUES (p_session_id, 'owner', 'message', CASE WHEN v_content = '' THEN p_action ELSE v_content END,
          jsonb_build_object('action', p_action), 'queued', left(p_client_request_id, 80), v_user)
  RETURNING id INTO v_id;
  UPDATE public.builder_vibe_sessions SET last_activity_at = now(), updated_at = now() WHERE id = p_session_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.builder_vibe_set_preview(p_session_id uuid, p_on boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := public.builder_vibe_require_owner();
BEGIN
  UPDATE public.builder_vibe_sessions
     SET preview_requested = coalesce(p_on, false),
         preview_status = CASE WHEN coalesce(p_on, false) AND preview_status IN ('off', 'failed') THEN 'starting' ELSE preview_status END,
         last_activity_at = now(), updated_at = now()
   WHERE id = p_session_id AND status <> 'closed';
  IF NOT FOUND THEN RAISE EXCEPTION 'Vibe session not found or closed'; END IF;
  INSERT INTO public.builder_vibe_messages (session_id, role, kind, content, created_by)
  VALUES (p_session_id, 'system', 'preview', CASE WHEN p_on THEN 'Live preview requested.' ELSE 'Live preview turned off.' END, v_user);
END;
$$;

CREATE OR REPLACE FUNCTION public.builder_vibe_preview_ticket(p_session_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := public.builder_vibe_require_owner();
  v_ticket text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.builder_vibe_sessions WHERE id = p_session_id AND status <> 'closed') THEN
    RAISE EXCEPTION 'Vibe session not found or closed';
  END IF;
  DELETE FROM public.builder_vibe_preview_tickets WHERE expires_at < now() - interval '1 hour';
  INSERT INTO public.builder_vibe_preview_tickets (session_id, ticket_hash, created_by, expires_at)
  VALUES (p_session_id, encode(sha256(convert_to(v_ticket, 'UTF8')), 'hex'), v_user, now() + interval '5 minutes');
  RETURN v_ticket;
END;
$$;

CREATE OR REPLACE FUNCTION public.builder_vibe_session_close(p_session_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := public.builder_vibe_require_owner();
BEGIN
  UPDATE public.builder_vibe_sessions
     SET status = 'closed', preview_requested = false, closed_at = now(), updated_at = now()
   WHERE id = p_session_id AND status <> 'closed';
  IF NOT FOUND THEN RAISE EXCEPTION 'Vibe session not found or already closed'; END IF;
  UPDATE public.builder_vibe_messages SET status = 'failed', completed_at = now()
   WHERE session_id = p_session_id AND status = 'queued';
  INSERT INTO public.builder_vibe_messages (session_id, role, kind, content, created_by)
  VALUES (p_session_id, 'system', 'status', 'Session closed by the owner.', v_user);
END;
$$;

-- Worker-only: claim the oldest queued owner turn for a session that is not already busy.
CREATE OR REPLACE FUNCTION public.builder_vibe_claim_next()
RETURNS SETOF public.builder_vibe_messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.builder_vibe_messages m
     SET status = 'claimed', claimed_at = now()
   WHERE m.id = (
     SELECT q.id FROM public.builder_vibe_messages q
       JOIN public.builder_vibe_sessions s ON s.id = q.session_id
      WHERE q.status = 'queued' AND s.status IN ('open', 'shipped', 'failed')
        AND NOT EXISTS (SELECT 1 FROM public.builder_vibe_messages c WHERE c.session_id = q.session_id AND c.status = 'claimed')
      ORDER BY q.created_at
      LIMIT 1
      FOR UPDATE OF q SKIP LOCKED)
  RETURNING m.*;
END;
$$;

-- Worker-only: redeem a one-time preview ticket.
CREATE OR REPLACE FUNCTION public.builder_vibe_redeem_preview_ticket(p_session_id uuid, p_ticket text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
BEGIN
  UPDATE public.builder_vibe_preview_tickets
     SET used_at = now()
   WHERE session_id = p_session_id AND used_at IS NULL AND expires_at > now()
     AND ticket_hash = encode(sha256(convert_to(coalesce(p_ticket, ''), 'UTF8')), 'hex')
  RETURNING created_by INTO v_user;
  RETURN v_user;
END;
$$;

REVOKE ALL ON FUNCTION public.builder_vibe_require_owner() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.builder_vibe_session_open(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.builder_vibe_send(uuid, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.builder_vibe_set_preview(uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.builder_vibe_preview_ticket(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.builder_vibe_session_close(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.builder_vibe_claim_next() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_vibe_redeem_preview_ticket(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_vibe_require_owner() TO authenticated;
GRANT EXECUTE ON FUNCTION public.builder_vibe_session_open(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.builder_vibe_send(uuid, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.builder_vibe_set_preview(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.builder_vibe_preview_ticket(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.builder_vibe_session_close(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.builder_vibe_claim_next() TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_vibe_redeem_preview_ticket(uuid, text) TO service_role;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.builder_vibe_sessions;
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$$;
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.builder_vibe_messages;
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$$;
