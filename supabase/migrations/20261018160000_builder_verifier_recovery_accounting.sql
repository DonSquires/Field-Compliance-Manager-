-- Infrastructure/evidence retries and proven baseline failures are not engineering revisions. Keep append-only
-- recovery receipts even though the worker lease row is reused for the same patch.
CREATE OR REPLACE FUNCTION public.builder_account_verifier_recoveries(_job_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _job public.builder_jobs%rowtype;
  _run public.builder_worker_runs%rowtype;
  _key text;
  _recoveries integer;
  _baseline boolean;
  _count integer := 0;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  SELECT * INTO _job FROM public.builder_jobs WHERE id = _job_id FOR UPDATE;
  IF _job.id IS NULL THEN RAISE EXCEPTION 'Builder job is missing'; END IF;
  IF _job.status IN ('failed', 'cancelled', 'deployed', 'release_ready') THEN RETURN 0; END IF;
  FOR _run IN
    SELECT * FROM public.builder_worker_runs
    WHERE job_id = _job.id AND organization_id = _job.organization_id
      AND target_sha = _job.target_sha
      AND profile IN ('frontend-verify', 'backend-verify')
      AND started_at IS NOT NULL AND patch_artifact_id IS NOT NULL
      AND (status = 'timeout' OR (status = 'failed' AND (
        log_summary LIKE 'Frontend verifier infrastructure failure (%'
        OR log_summary LIKE 'Backend verifier infrastructure failure (%'
        OR log_summary LIKE 'Frontend verification attribution unresolved (%'
        OR log_summary LIKE 'Backend verification attribution unresolved (%'
        OR log_summary = 'Frontend worker handoff failed'
        OR log_summary = 'Backend worker handoff failed'
        OR log_summary LIKE 'Repository is red at the pinned commit (%'
      )))
    ORDER BY created_at
    FOR UPDATE
  LOOP
    _key := _run.id::text || ':' || extract(epoch FROM _run.started_at)::text;
    _baseline := coalesce(_run.log_summary LIKE 'Repository is red at the pinned commit (%', false);
    IF EXISTS (
      SELECT 1 FROM public.builder_audit_events
      WHERE job_id = _job.id AND organization_id = _job.organization_id
        AND event_type = 'error_recorded' AND new_value->>'verifier_recovery_key' = _key
    ) THEN CONTINUE; END IF;
    SELECT count(*) INTO _recoveries FROM public.builder_audit_events
    WHERE job_id = _job.id AND organization_id = _job.organization_id
      AND event_type = 'error_recorded'
      AND new_value->>'patch_artifact_id' = _run.patch_artifact_id::text
      AND new_value ? 'verifier_recovery_key'
      AND coalesce(new_value->>'recovery_kind', '') <> 'baseline';
    _recoveries := _recoveries + 1;
    UPDATE public.builder_job_steps
    SET attempt_count = greatest(0, coalesce(attempt_count, 0) - 1),
        retryable = NOT _baseline AND _recoveries < 2,
        error = CASE WHEN _baseline
          THEN 'baseline: repository red at the pinned commit: ' || left(_run.log_summary, 500)
          WHEN _recoveries < 2
          THEN 'Verifier recovery pending; re-verify the saved patch without another engineering revision'
          ELSE 'Verifier recovery paused after two infrastructure or attribution failures; patch preserved; inspect the runner and evidence before resuming'
        END,
        updated_at = now()
    WHERE id = _run.step_id AND job_id = _job.id AND status = 'failed'
      AND retryable = true AND coalesce(error, '') NOT LIKE 'Evidence conflict:%'
      AND input_context->>'patch_artifact_id' = _run.patch_artifact_id::text;
    IF NOT FOUND THEN CONTINUE; END IF;
    INSERT INTO public.builder_audit_events (
      organization_id, job_id, event_type, actor_type, new_value, change_summary, related_artifact_ids
    ) VALUES (
      _job.organization_id, _job.id, 'error_recorded', 'bot',
      jsonb_build_object('verifier_recovery_key', _key, 'step_id', _run.step_id,
        'patch_artifact_id', _run.patch_artifact_id, 'recovery_count', _recoveries,
        'recovery_kind', CASE WHEN _baseline THEN 'baseline' ELSE 'infrastructure_or_evidence' END,
        'engineering_attempt_refunded', true, 'retryable', NOT _baseline AND _recoveries < 2),
      'Verifier recovery recorded separately from engineering revisions; candidate patch preserved',
      ARRAY[_run.patch_artifact_id]
    );
    _count := _count + 1;
  END LOOP;
  RETURN _count;
END;
$function$;

REVOKE ALL ON FUNCTION public.builder_account_verifier_recoveries(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.builder_account_verifier_recoveries(uuid) TO service_role;
