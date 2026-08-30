-- Prevent stale worker evidence from carrying across a retry of the same patch.

CREATE OR REPLACE FUNCTION public.builder_reset_frontend_worker_retry(_run_id uuid)
RETURNS public.builder_worker_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _run public.builder_worker_runs%rowtype;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  UPDATE public.builder_worker_runs
  SET output_artifact_ids = '{}',
      exit_code = NULL,
      log_summary = NULL,
      dangerous_patterns_detected = '{}',
      secrets_redacted_count = 0,
      updated_at = now()
  WHERE id = _run_id AND status = 'running'
  RETURNING * INTO _run;
  IF _run.id IS NULL THEN RAISE EXCEPTION 'Active frontend worker run not found'; END IF;
  RETURN _run;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.builder_reset_frontend_worker_retry(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_reset_frontend_worker_retry(uuid)
  TO service_role;