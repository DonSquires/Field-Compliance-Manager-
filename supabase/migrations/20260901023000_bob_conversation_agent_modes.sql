-- Separate operational assistance from repository/build assistance without
-- rewriting existing conversation history.

ALTER TABLE public.bob_conversations
  ADD COLUMN IF NOT EXISTS agent_mode text NOT NULL DEFAULT 'operations',
  ADD CONSTRAINT bob_conversations_agent_mode_check CHECK (agent_mode IN ('operations', 'builder'));

CREATE INDEX IF NOT EXISTS bob_conversations_user_org_mode_updated_idx
  ON public.bob_conversations (user_id, organization_id, agent_mode, updated_at DESC);

COMMENT ON COLUMN public.bob_conversations.agent_mode IS
  'Bob interaction purpose. operations is the in-app operational copilot; builder is the isolated repository/build workspace assistant.';