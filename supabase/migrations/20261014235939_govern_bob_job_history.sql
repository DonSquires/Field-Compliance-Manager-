BEGIN;

LOCK TABLE public.bob_job_runs IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.bob_job_rollback_refs IN SHARE ROW EXCLUSIVE MODE;

UPDATE public.bob_job_rollback_refs
SET reversible = false
WHERE reversible;

ALTER TABLE public.bob_job_rollback_refs
  ALTER COLUMN reversible SET DEFAULT false;

COMMENT ON COLUMN public.bob_job_rollback_refs.reversible IS
  'False unless a dedicated domain correction workflow proves a safe inverse. Generic status mutation and hard deletion are not valid reversals.';

CREATE INDEX IF NOT EXISTS idx_bob_job_runs_job_id
  ON public.bob_job_runs (job_id);

DROP POLICY IF EXISTS bob_job_runs_select ON public.bob_job_runs;
DROP POLICY IF EXISTS bob_job_runs_write ON public.bob_job_runs;
DROP POLICY IF EXISTS bob_job_rollback_refs_select ON public.bob_job_rollback_refs;
DROP POLICY IF EXISTS bob_job_rollback_refs_write ON public.bob_job_rollback_refs;

CREATE POLICY bob_job_runs_select
ON public.bob_job_runs
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.user_profiles up
    WHERE up.id = (SELECT auth.uid())
      AND up.role = ANY (ARRAY['grand_master'::text, 'master'::text, 'admin'::text])
  )
  AND (
    (
      organization_id IS NOT NULL
      AND public.org_access_allowed(organization_id)
    )
    OR public.is_grand_master()
  )
);

CREATE POLICY bob_job_rollback_refs_select
ON public.bob_job_rollback_refs
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.user_profiles up
    WHERE up.id = (SELECT auth.uid())
      AND up.role = ANY (ARRAY['grand_master'::text, 'master'::text, 'admin'::text])
  )
  AND EXISTS (
    SELECT 1
    FROM public.bob_job_runs run
    WHERE run.job_id = bob_job_rollback_refs.job_id
      AND run.organization_id IS NOT NULL
      AND public.org_access_allowed(run.organization_id)
  )
);

REVOKE ALL ON TABLE public.bob_job_runs FROM anon, authenticated;
REVOKE ALL ON TABLE public.bob_job_rollback_refs FROM anon, authenticated;

GRANT SELECT ON TABLE public.bob_job_runs TO authenticated;
GRANT SELECT ON TABLE public.bob_job_rollback_refs TO authenticated;

COMMIT;