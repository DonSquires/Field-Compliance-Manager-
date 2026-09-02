-- Separate operational assistance from repository/build assistance without
-- rewriting existing conversation history.

ALTER TABLE public.bob_conversations
  ADD COLUMN IF NOT EXISTS module_key text NOT NULL DEFAULT 'operations',
  ADD CONSTRAINT bob_conversations_module_key_check CHECK (module_key IN ('operations', 'builder'));

CREATE INDEX IF NOT EXISTS bob_conversations_user_org_mode_updated_idx
  ON public.bob_conversations (user_id, organization_id, module_key, updated_at DESC);

COMMENT ON COLUMN public.bob_conversations.module_key IS
  'Bob interaction purpose. operations is the in-app operational copilot; builder is the isolated repository/build workspace assistant.';
