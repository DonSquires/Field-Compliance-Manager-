-- Recover expired aggregate security leases before a new claim attempts to take
-- the global Builder worker mutex.

CREATE OR REPLACE FUNCTION public.builder_recover_expired_security_review()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _count integer;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  WITH expired AS (
    UPDATE public.builder_worker_runs
    SET status = 'timeout', completed_at = now(), lease_token_hash = NULL,
        output_artifact_ids = '{}', review_summary = '{}'::jsonb, updated_at = now()
    WHERE profile = 'security-review' AND status = 'running' AND lease_expires_at <= now()
    RETURNING job_id, step_id
  ), updated_steps AS (
    UPDATE public.builder_job_steps step
    SET status = 'failed', retryable = true, error = 'Security review worker lease expired', updated_at = now()
    FROM expired WHERE step.id = expired.step_id RETURNING expired.job_id
  )
  UPDATE public.builder_jobs job
  SET status = 'testing', last_error = 'Security review worker lease expired', updated_at = now()
  WHERE job.id IN (SELECT job_id FROM updated_steps);
  GET DIAGNOSTICS _count = ROW_COUNT;
  RETURN _count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.builder_recover_expired_security_review() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.builder_recover_expired_security_review() TO service_role;