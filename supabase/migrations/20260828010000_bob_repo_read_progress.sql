-- Track per-conversation read progress for Bob's repo_search 'read' action.
-- Nothing previously recorded which line ranges of a file had already been
-- read within a conversation, so repeated/out-of-order reads went undetected.
-- Additive, RLS-scoped like sibling bob_* tables; fail-open on any query error.

CREATE TABLE IF NOT EXISTS public.bob_repo_read_progress (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.bob_conversations(id) ON DELETE CASCADE,
  path text NOT NULL,
  ref text NOT NULL,
  max_line_read integer NOT NULL DEFAULT 0,
  last_start_line integer,
  last_end_line integer,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bob_repo_read_progress_unique UNIQUE (conversation_id, path, ref)
);

CREATE INDEX IF NOT EXISTS idx_bob_repo_read_progress_conversation
  ON public.bob_repo_read_progress (conversation_id);

ALTER TABLE public.bob_repo_read_progress ENABLE ROW LEVEL SECURITY;

-- Same admiral-only surface as bob-repo-search itself; only the service role
-- (used by the Edge Function) needs write access, no direct client access.
REVOKE ALL ON TABLE public.bob_repo_read_progress FROM anon, authenticated;
GRANT ALL ON TABLE public.bob_repo_read_progress TO service_role;

CREATE POLICY "bob_repo_read_progress_service_only"
  ON public.bob_repo_read_progress
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
