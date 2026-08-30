-- Aggregate deterministic security review for frontend-only, backend-only, or
-- one frontend plus one backend implementation worker.

CREATE OR REPLACE FUNCTION public.builder_claim_aggregate_security_review(
  _job_id uuid,
  _security_step_id uuid,
  _implementation_worker_run_ids uuid[],
  _runner_id text,
  _expected_target_sha text,
  _timeout_seconds integer DEFAULT 300
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  _job public.builder_jobs%rowtype; _security_step public.builder_job_steps%rowtype; _test_step public.builder_job_steps%rowtype;
  _run public.builder_worker_runs%rowtype; _patch_ids uuid[]; _manifest_ids uuid[]; _log_ids uuid[];
  _lease_token text := encode(extensions.gen_random_bytes(32), 'hex'); _lease_hash text; _idempotency_key text; _run_count integer;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  IF NULLIF(btrim(_runner_id), '') IS NULL THEN RAISE EXCEPTION 'runner_id is required'; END IF;
  IF _timeout_seconds < 60 OR _timeout_seconds > 900 THEN RAISE EXCEPTION 'security review timeout is invalid'; END IF;
  IF cardinality(_implementation_worker_run_ids) NOT BETWEEN 1 AND 2
     OR (SELECT count(DISTINCT id) FROM unnest(_implementation_worker_run_ids) id) <> cardinality(_implementation_worker_run_ids) THEN
    RAISE EXCEPTION 'One or two distinct implementation worker runs are required';
  END IF;
  IF EXISTS (SELECT 1 FROM public.builder_worker_runs WHERE status = 'running') THEN RAISE EXCEPTION 'Another Builder worker already holds the active lease'; END IF;

  SELECT * INTO _job FROM public.builder_jobs WHERE id = _job_id FOR UPDATE;
  SELECT * INTO _security_step FROM public.builder_job_steps WHERE id = _security_step_id AND job_id = _job_id FOR UPDATE;
  SELECT * INTO _test_step FROM public.builder_job_steps WHERE job_id = _job_id AND step_id = 'test_suite' FOR UPDATE;
  IF _job.id IS NULL OR _job.status <> 'testing' THEN RAISE EXCEPTION 'Job is not ready for security review'; END IF;
  IF _job.target_sha IS NULL OR _expected_target_sha IS DISTINCT FROM _job.target_sha THEN RAISE EXCEPTION 'Security review target SHA is stale or missing'; END IF;
  IF _security_step.id IS NULL OR _security_step.step_id <> 'security_review' OR _security_step.builder_mode <> 'qa_security_reviewer'
     OR (_security_step.status <> 'pending' AND NOT (_security_step.status = 'failed' AND _security_step.retryable)) THEN
    RAISE EXCEPTION 'Security review step is not pending';
  END IF;
  IF _test_step.id IS NULL OR _test_step.builder_mode <> 'qa_security_reviewer' OR _test_step.status NOT IN ('pending', 'completed') THEN
    RAISE EXCEPTION 'Test-suite step is not ready';
  END IF;

  SELECT count(*), array_agg(run.patch_artifact_id ORDER BY run.profile, run.id)
  INTO _run_count, _patch_ids
  FROM public.builder_worker_runs run
  WHERE run.id = ANY(_implementation_worker_run_ids) AND run.job_id = _job.id AND run.status = 'completed'
    AND run.organization_id = _job.organization_id AND run.target_sha = _job.target_sha
    AND run.profile IN ('frontend-verify', 'backend-verify');
  IF _run_count <> cardinality(_implementation_worker_run_ids) OR array_position(_patch_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Completed implementation worker evidence is missing or stale';
  END IF;
  IF _run_count = 2 AND (
    SELECT count(DISTINCT profile) FROM public.builder_worker_runs WHERE id = ANY(_implementation_worker_run_ids)
  ) <> 2 THEN RAISE EXCEPTION 'Aggregate review requires distinct frontend and backend worker profiles'; END IF;

  SELECT array_agg(artifact.id ORDER BY run.profile, run.id)
  INTO _manifest_ids
  FROM public.builder_worker_runs run
  JOIN public.builder_artifacts artifact ON artifact.id = ANY(run.output_artifact_ids)
  WHERE run.id = ANY(_implementation_worker_run_ids) AND artifact.job_id = _job.id
    AND artifact.step_id = run.step_id AND artifact.artifact_type = 'changed_file_manifest' AND artifact.status = 'final';
  SELECT array_agg(artifact.id ORDER BY run.profile, run.id)
  INTO _log_ids
  FROM public.builder_worker_runs run
  JOIN public.builder_artifacts artifact ON artifact.id = ANY(run.output_artifact_ids)
  WHERE run.id = ANY(_implementation_worker_run_ids) AND artifact.job_id = _job.id
    AND artifact.step_id = run.step_id AND artifact.artifact_type = 'build_logs' AND artifact.status = 'final';
  IF cardinality(_manifest_ids) <> _run_count OR cardinality(_log_ids) <> _run_count THEN
    RAISE EXCEPTION 'Implementation verification evidence is incomplete';
  END IF;

  UPDATE public.builder_job_steps SET status = 'completed', completed_at = now(),
    result_summary = 'Accepted isolated implementation verification evidence',
    artifact_ids = _patch_ids || _manifest_ids || _log_ids, updated_at = now() WHERE id = _test_step.id;
  UPDATE public.builder_job_steps SET status = 'running', attempt_count = attempt_count + 1, started_at = now(), retryable = false,
    input_context = jsonb_build_object('implementation_worker_run_ids', _implementation_worker_run_ids,
      'patch_artifact_ids', _patch_ids, 'manifest_artifact_ids', _manifest_ids,
      'build_log_artifact_ids', _log_ids, 'target_sha', _job.target_sha), updated_at = now()
  WHERE id = _security_step.id;
  UPDATE public.builder_jobs SET status = 'security_review', current_step_name = _security_step.step_id,
    current_step_index = _security_step.ordinal_position, updated_at = now() WHERE id = _job.id;

  _lease_hash := encode(extensions.digest(_lease_token, 'sha256'), 'hex');
  _idempotency_key := _job.id::text || '::security-aggregate::' || _job.target_sha || '::'
    || encode(extensions.digest(array_to_string(_patch_ids || _manifest_ids, '::'), 'sha256'), 'hex');
  INSERT INTO public.builder_worker_runs (
    organization_id, job_id, step_id, runner_id, worker_isolation_level, command, command_args,
    environment_variables_snapshot, profile, target_sha, patch_artifact_id, idempotency_key,
    lease_token_hash, lease_expires_at, heartbeat_at, status, started_at, timeout_seconds
  ) VALUES (
    _job.organization_id, _job.id, _security_step.id, _runner_id, 'container', 'security-review', ARRAY['security-review'],
    '{}'::jsonb, 'security-review', _job.target_sha, _patch_ids[1], _idempotency_key,
    _lease_hash, now() + make_interval(secs => _timeout_seconds), now(), 'running', now(), _timeout_seconds
  )
  ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE
  SET runner_id = EXCLUDED.runner_id, lease_token_hash = EXCLUDED.lease_token_hash,
      lease_expires_at = EXCLUDED.lease_expires_at, heartbeat_at = EXCLUDED.heartbeat_at,
      status = 'running', started_at = now(), completed_at = NULL,
      output_artifact_ids = '{}', review_summary = '{}'::jsonb, updated_at = now()
  RETURNING * INTO _run;
  INSERT INTO public.builder_audit_events (organization_id, job_id, event_type, actor_type, new_value, change_summary, related_artifact_ids)
  VALUES (_job.organization_id, _job.id, 'step_started', 'builder_mode',
    jsonb_build_object('step_id', _security_step.step_id, 'worker_run_id', _run.id, 'target_sha', _job.target_sha,
      'implementation_worker_run_ids', _implementation_worker_run_ids),
    'Aggregate independent security review worker claimed', _patch_ids || _manifest_ids || _log_ids);
  RETURN jsonb_build_object('run_id', _run.id, 'lease_token', _lease_token, 'lease_expires_at', _run.lease_expires_at,
    'organization_id', _job.organization_id, 'job_id', _job.id, 'step_id', _security_step.id, 'target_sha', _job.target_sha,
    'profile', 'security-review', 'patch_artifact_ids', _patch_ids, 'manifest_artifact_ids', _manifest_ids,
    'build_log_artifact_ids', _log_ids);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.builder_claim_aggregate_security_review(uuid,uuid,uuid[],text,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.builder_claim_aggregate_security_review(uuid,uuid,uuid[],text,text,integer) TO service_role;