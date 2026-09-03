-- Pin/archive state for Bob sessions. Existing bob_conversations_update RLS
-- policy (org_access_allowed) already covers these columns; no new policy needed.

ALTER TABLE public.bob_conversations
  ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS archived_at timestamp with time zone;

CREATE INDEX IF NOT EXISTS bob_conversations_pinned_idx
  ON public.bob_conversations (organization_id, user_id, module_key, pinned, updated_at DESC);

COMMENT ON COLUMN public.bob_conversations.pinned IS
  'Operator-pinned session; pinned sessions surface above Today/Earlier groups in the session sidebar.';
COMMENT ON COLUMN public.bob_conversations.archived_at IS
  'When set, this session is archived and hidden from the default session list unless the Archived filter is selected.';
