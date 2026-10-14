CREATE INDEX idx_obligation_proof_artifacts_created_by
  ON public.obligation_proof_artifacts (created_by)
  WHERE created_by IS NOT NULL;

CREATE INDEX idx_obligation_proof_artifacts_withdrawn_by
  ON public.obligation_proof_artifacts (withdrawn_by)
  WHERE withdrawn_by IS NOT NULL;

DROP POLICY IF EXISTS bob_full_read ON public.obligation_proof_artifacts;
DROP POLICY IF EXISTS obligation_proof_artifacts_insert ON public.obligation_proof_artifacts;
DROP POLICY IF EXISTS obligation_proof_artifacts_select ON public.obligation_proof_artifacts;
DROP POLICY IF EXISTS obligation_proof_artifacts_update ON public.obligation_proof_artifacts;

COMMENT ON TABLE public.obligation_proof_artifacts IS
  'Governed links between reviewed source records and contract obligations. Browser access is RPC-only; withdrawn links preserve correction history.';