-- The control plane is the only runner of frontend/backend verifiers, and it awaits each
-- container in-process. When it restarts (deploy, crash) every 'running' verification run it
-- owned is orphaned, yet its lease keeps the job waiting for up to 30 minutes (job 72edc782
-- waited 00:38-01:11 UTC across two deploys on 2026-09-27). At startup the runner may therefore
-- time out its own running verifications at once: _include_active ignores the lease.

DROP FUNCTION IF EXISTS public.builder_recover_expired_worker_runs();

CREATE OR REPLACE FUNCTION public.builder_recover_expired_worker_runs(_include_active boolean DEFAULT false, _reason text DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _count integer; _why text;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  _why := left(COALESCE(NULLIF(btrim(_reason), ''), CASE WHEN COALESCE(_include_active, false) THEN 'runner restarted before the verifier reported' ELSE 'worker lease expired: the runner was lost before it reported' END), 300);
  WITH expired AS (
    UPDATE public.builder_worker_runs
    SET status = 'timeout', completed_at = now(), lease_token_hash = NULL, lease_expires_at = NULL,
        log_summary = left(COALESCE(log_summary, '') || CASE WHEN log_summary IS NULL OR log_summary = '' THEN '' ELSE ' | ' END
          || _why || '; the same patch is verified again', 1000),
        updated_at = now()
    WHERE profile IN ('frontend-verify', 'backend-verify') AND status = 'running'
      AND (COALESCE(_include_active, false) OR lease_expires_at <= now())
    RETURNING id, job_id, step_id, organization_id, profile
  ), updated_steps AS (
    UPDATE public.builder_job_steps step
    SET status = 'failed', retryable = true, completed_at = now(), updated_at = now(),
        error = CASE WHEN expired.profile = 'frontend-verify' THEN 'Frontend' ELSE 'Backend' END
          || ' worker lease expired (runner lost); the same patch is verified again'
    FROM expired WHERE step.id = expired.step_id
    RETURNING expired.job_id, expired.id AS run_id, expired.organization_id, expired.profile, step.step_id AS step_name
  ), updated_jobs AS (
    UPDATE public.builder_jobs job
    SET status = 'implementation_pending', last_error = 'Verification worker lease expired (runner lost); verifying the same patch again', updated_at = now()
    WHERE job.id IN (SELECT job_id FROM updated_steps) AND job.status NOT IN ('deployed', 'failed', 'cancelled')
    RETURNING id
  )
  INSERT INTO public.builder_audit_events (organization_id, job_id, event_type, actor_type, previous_value, new_value, change_summary)
  SELECT organization_id, job_id, 'step_failed', 'bot',
    jsonb_build_object('step', step_name, 'step_status', 'running', 'worker_run_id', run_id),
    jsonb_build_object('step', step_name, 'step_status', 'failed', 'retryable', true, 'worker_run_status', 'timeout', 'reason', _why),
    'Verification worker run ended without a report (' || _why || '); step returned to failed/retryable so the same patch is verified again'
  FROM updated_steps;
  GET DIAGNOSTICS _count = ROW_COUNT;
  RETURN _count;
END;
$$;
REVOKE ALL ON FUNCTION public.builder_recover_expired_worker_runs(boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_recover_expired_worker_runs(boolean, text) TO service_role;
