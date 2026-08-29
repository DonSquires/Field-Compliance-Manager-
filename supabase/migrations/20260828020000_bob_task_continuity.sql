-- Durable task ledger for Bob's resumable repository and workflow work.
-- This is the foundation for deterministic resumption: task state lives in a
-- structured ledger instead of ephemeral conversation memory.

CREATE TABLE IF NOT EXISTS public.bob_task_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id text NOT NULL UNIQUE,
  conversation_id uuid NOT NULL REFERENCES public.bob_conversations(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
  goal text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'paused', 'completed', 'failed', 'cancelled')
  ),
  current_step_index integer NOT NULL DEFAULT 0,
  total_steps integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz,
  last_error text
);

CREATE TABLE IF NOT EXISTS public.bob_task_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id text NOT NULL REFERENCES public.bob_task_runs(task_id) ON DELETE CASCADE,
  task_run_id uuid NOT NULL REFERENCES public.bob_task_runs(id) ON DELETE CASCADE,
  step_id text NOT NULL,
  ordinal_position integer NOT NULL DEFAULT 0,
  requested_operation text NOT NULL,
  normalized_tool text,
  normalized_args jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'running', 'completed', 'failed', 'blocked', 'skipped')
  ),
  attempt_count integer NOT NULL DEFAULT 0,
  started_at timestamptz,
  completed_at timestamptz,
  result_summary text,
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  retryable boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_run_id, step_id),
  UNIQUE (task_run_id, ordinal_position)
);

CREATE INDEX IF NOT EXISTS idx_bob_task_runs_conversation
  ON public.bob_task_runs (conversation_id);

CREATE INDEX IF NOT EXISTS idx_bob_task_runs_status
  ON public.bob_task_runs (status);

CREATE INDEX IF NOT EXISTS idx_bob_task_steps_task
  ON public.bob_task_steps (task_id);

CREATE INDEX IF NOT EXISTS idx_bob_task_steps_status
  ON public.bob_task_steps (status);

ALTER TABLE public.bob_task_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bob_task_steps ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.bob_task_runs FROM anon, authenticated;
REVOKE ALL ON TABLE public.bob_task_steps FROM anon, authenticated;
GRANT ALL ON TABLE public.bob_task_runs TO service_role;
GRANT ALL ON TABLE public.bob_task_steps TO service_role;

CREATE POLICY "bob_task_runs_service_only"
  ON public.bob_task_runs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "bob_task_steps_service_only"
  ON public.bob_task_steps
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.set_bob_task_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bob_task_runs_updated_at ON public.bob_task_runs;
DROP TRIGGER IF EXISTS bob_task_steps_updated_at ON public.bob_task_steps;

CREATE TRIGGER bob_task_runs_updated_at
BEFORE UPDATE ON public.bob_task_runs
FOR EACH ROW
EXECUTE FUNCTION public.set_bob_task_updated_at();

CREATE TRIGGER bob_task_steps_updated_at
BEFORE UPDATE ON public.bob_task_steps
FOR EACH ROW
EXECUTE FUNCTION public.set_bob_task_updated_at();
