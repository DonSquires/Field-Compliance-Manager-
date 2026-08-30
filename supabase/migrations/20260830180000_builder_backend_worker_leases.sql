-- Durable, commit-pinned handoff for static Backend Engineer verification.
-- This worker never connects to a live or disposable database; its evidence must
-- retain verification_scope=static_backend_patch and migration_execution=false.

CREATE OR REPLACE FUNCTION public.builder_claim_backend_worker(
  _job_id uuid,
  _step_id uuid,
  _patch_artifact_id uuid,
  _runner_id text,
  _expected_target_sha text,
  _timeout_seconds integer DEFAULT 900
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _job public.builder_jobs%rowtype;
  _step public.builder_job_steps%rowtype;
  _patch public.builder_artifacts%rowtype;
  _run public.builder_worker_runs%rowtype;
  _lease_token text := encode(extensions.gen_random_bytes(32), 'hex');
  _lease_token_hash text;
  _idempotency_key text;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  IF NULLIF(btrim(_runner_id), '') IS NULL THEN RAISE EXCEPTION 'runner_id is required'; END IF;
  IF _timeout_seconds < 60 OR _timeout_seconds > 3600 THEN RAISE EXCEPTION 'timeout must be between 60 and 3600 seconds'; END IF;

  UPDATE public.builder_job_steps step
  SET status = 'failed', retryable = true, error = 'Backend worker lease expired', updated_at = now()
  FROM public.builder_worker_runs run
  WHERE run.step_id = step.id AND run.profile = 'backend-verify'
    AND run.status = 'running' AND run.lease_expires_at <= now();
  UPDATE public.builder_worker_runs
  SET status = 'timeout', completed_at = now(), lease_token_hash = NULL, updated_at = now()
  WHERE profile = 'backend-verify' AND status = 'running' AND lease_expires_at <= now();

  SELECT * INTO _job FROM public.builder_jobs WHERE id = _job_id FOR UPDATE;
  SELECT * INTO _step FROM public.builder_job_steps WHERE id = _step_id AND job_id = _job_id FOR UPDATE;
  SELECT * INTO _patch FROM public.builder_artifacts WHERE id = _patch_artifact_id AND job_id = _job_id;

  IF _job.id IS NULL OR _job.status <> 'implementation_pending' THEN RAISE EXCEPTION 'Job is not ready for backend implementation'; END IF;
  IF _job.target_sha IS NULL OR _expected_target_sha IS DISTINCT FROM _job.target_sha THEN RAISE EXCEPTION 'Worker target SHA is stale or missing'; END IF;
  IF _step.id IS NULL OR _step.builder_mode <> 'backend_engineer' THEN RAISE EXCEPTION 'Backend Engineer step is missing'; END IF;
  IF _step.status <> 'pending' AND NOT (_step.status = 'failed' AND _step.retryable) THEN RAISE EXCEPTION 'Backend Engineer step cannot be claimed'; END IF;
  IF _patch.id IS NULL OR _patch.step_id IS DISTINCT FROM _step.id OR _patch.artifact_type <> 'code_implementation' OR _patch.status <> 'final' OR _patch.checksum IS NULL THEN
    RAISE EXCEPTION 'A final generated backend patch artifact is required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.builder_model_runs model_run
    WHERE model_run.job_id = _job.id AND model_run.step_id = _step.id
      AND model_run.status = 'completed' AND _patch.id = ANY(model_run.output_artifact_ids)
      AND EXISTS (
        SELECT 1 FROM public.builder_job_steps product_step
        JOIN public.builder_artifacts product_artifact ON product_artifact.step_id = product_step.id
        WHERE product_step.job_id = _job.id AND product_step.builder_mode = 'product_analyst' AND product_step.status = 'completed'
          AND product_artifact.artifact_type = 'product_specification' AND product_artifact.status = 'final'
          AND product_artifact.id = ANY(model_run.input_artifact_ids)
      )
  ) THEN RAISE EXCEPTION 'Patch provenance does not include the completed product specification'; END IF;
  IF EXISTS (SELECT 1 FROM public.builder_worker_runs WHERE status = 'running') THEN RAISE EXCEPTION 'Another Builder worker already holds the active lease'; END IF;

  _idempotency_key := _job.id::text || '::' || _step.id::text || '::' || _job.target_sha || '::' || _patch.checksum;
  IF EXISTS (SELECT 1 FROM public.builder_worker_runs WHERE idempotency_key = _idempotency_key AND status = 'completed') THEN
    RAISE EXCEPTION 'This exact backend patch was already verified';
  END IF;
  _lease_token_hash := encode(extensions.digest(_lease_token, 'sha256'), 'hex');

  INSERT INTO public.builder_worker_runs (
    organization_id, job_id, step_id, runner_id, worker_isolation_level,
    command, command_args, environment_variables_snapshot, profile, target_sha,
    patch_artifact_id, idempotency_key, lease_token_hash, lease_expires_at,
    heartbeat_at, status, started_at, timeout_seconds
  ) VALUES (
    _job.organization_id, _job.id, _step.id, _runner_id, 'container',
    'backend-verify', ARRAY['backend-verify'], '{}'::jsonb, 'backend-verify', _job.target_sha,
    _patch.id, _idempotency_key, _lease_token_hash, now() + make_interval(secs => _timeout_seconds),
    now(), 'running', now(), _timeout_seconds
  )
  ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE
  SET runner_id = EXCLUDED.runner_id, lease_token_hash = EXCLUDED.lease_token_hash,
      lease_expires_at = EXCLUDED.lease_expires_at, heartbeat_at = EXCLUDED.heartbeat_at,
      status = 'running', started_at = now(), completed_at = NULL, updated_at = now()
  RETURNING * INTO _run;

  UPDATE public.builder_job_steps
  SET status = 'running', attempt_count = attempt_count + 1, started_at = now(), completed_at = NULL,
      retryable = false, error = NULL,
      input_context = jsonb_build_object('patch_artifact_id', _patch.id, 'target_sha', _job.target_sha, 'verification_scope', 'static_backend_patch'), updated_at = now()
  WHERE id = _step.id;
  UPDATE public.builder_jobs SET status = 'building', current_step_name = _step.step_id,
    current_step_index = _step.ordinal_position, updated_at = now() WHERE id = _job.id;
  INSERT INTO public.builder_audit_events (organization_id, job_id, event_type, actor_type, previous_value, new_value, change_summary, related_artifact_ids)
  VALUES (_job.organization_id, _job.id, 'step_started', 'builder_mode',
    jsonb_build_object('job_status', 'implementation_pending', 'step_status', _step.status),
    jsonb_build_object('job_status', 'building', 'step_status', 'running', 'worker_run_id', _run.id, 'target_sha', _job.target_sha, 'verification_scope', 'static_backend_patch'),
    'Backend Engineer static verification lease claimed', ARRAY[_patch.id]);

  RETURN jsonb_build_object(
    'run_id', _run.id, 'lease_token', _lease_token, 'lease_expires_at', _run.lease_expires_at,
    'job_id', _job.id, 'step_id', _step.id, 'organization_id', _job.organization_id,
    'profile', 'backend-verify', 'target_sha', _job.target_sha, 'patch_artifact_id', _patch.id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.builder_heartbeat_backend_worker(_run_id uuid, _lease_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _run public.builder_worker_runs%rowtype;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  UPDATE public.builder_worker_runs
  SET heartbeat_at = now(), lease_expires_at = now() + make_interval(secs => timeout_seconds), updated_at = now()
  WHERE id = _run_id AND profile = 'backend-verify' AND status = 'running' AND lease_expires_at > now()
    AND lease_token_hash = encode(extensions.digest(_lease_token, 'sha256'), 'hex')
  RETURNING * INTO _run;
  IF _run.id IS NULL THEN RAISE EXCEPTION 'Backend worker lease is missing, expired, or invalid'; END IF;
  RETURN jsonb_build_object('run_id', _run.id, 'lease_expires_at', _run.lease_expires_at);
END;
$$;

CREATE OR REPLACE FUNCTION public.builder_reset_backend_worker_retry(_run_id uuid)
RETURNS public.builder_worker_runs LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _run public.builder_worker_runs%rowtype;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  UPDATE public.builder_worker_runs
  SET output_artifact_ids = '{}', exit_code = NULL, log_summary = NULL,
      dangerous_patterns_detected = '{}', secrets_redacted_count = 0, updated_at = now()
  WHERE id = _run_id AND profile = 'backend-verify' AND status = 'running'
  RETURNING * INTO _run;
  IF _run.id IS NULL THEN RAISE EXCEPTION 'Active backend worker run not found'; END IF;
  RETURN _run;
END;
$$;

CREATE OR REPLACE FUNCTION public.builder_finish_backend_worker(
  _run_id uuid, _lease_token text, _succeeded boolean, _exit_code integer, _log_summary text DEFAULT NULL
)
RETURNS public.builder_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _run public.builder_worker_runs%rowtype; _job public.builder_jobs%rowtype; _next_status text; _event_type text;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  SELECT * INTO _run FROM public.builder_worker_runs WHERE id = _run_id AND profile = 'backend-verify' AND status = 'running'
    AND lease_expires_at > now() AND lease_token_hash = encode(extensions.digest(_lease_token, 'sha256'), 'hex') FOR UPDATE;
  IF _run.id IS NULL THEN RAISE EXCEPTION 'Backend worker lease is missing, expired, or invalid'; END IF;
  SELECT * INTO _job FROM public.builder_jobs WHERE id = _run.job_id FOR UPDATE;
  IF _job.target_sha IS DISTINCT FROM _run.target_sha THEN RAISE EXCEPTION 'Job target changed during worker execution'; END IF;
  IF _succeeded AND NOT (
    EXISTS (SELECT 1 FROM public.builder_artifacts WHERE id = ANY(_run.output_artifact_ids) AND job_id = _run.job_id AND artifact_type = 'code_implementation' AND status = 'final')
    AND EXISTS (SELECT 1 FROM public.builder_artifacts WHERE id = ANY(_run.output_artifact_ids) AND job_id = _run.job_id AND artifact_type = 'changed_file_manifest' AND status = 'final')
    AND EXISTS (SELECT 1 FROM public.builder_artifacts WHERE id = ANY(_run.output_artifact_ids) AND job_id = _run.job_id AND artifact_type = 'build_logs' AND status = 'final')
  ) THEN RAISE EXCEPTION 'Successful backend completion requires patch, manifest, and static verification logs'; END IF;

  _next_status := CASE
    WHEN NOT _succeeded THEN 'implementation_pending'
    WHEN EXISTS (SELECT 1 FROM public.builder_job_steps WHERE job_id = _run.job_id AND builder_mode = 'frontend_engineer' AND status IN ('completed', 'skipped')) THEN 'testing'
    ELSE 'implementation_pending'
  END;
  _event_type := CASE WHEN _succeeded THEN 'step_completed' ELSE 'step_failed' END;
  UPDATE public.builder_worker_runs SET status = CASE WHEN _succeeded THEN 'completed' ELSE 'failed' END,
    completed_at = now(), exit_code = _exit_code, log_summary = left(COALESCE(_log_summary, ''), 1000),
    lease_token_hash = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = _run.id;
  UPDATE public.builder_job_steps SET status = CASE WHEN _succeeded THEN 'completed' ELSE 'failed' END,
    completed_at = now(), retryable = NOT _succeeded,
    error = CASE WHEN _succeeded THEN NULL ELSE 'Backend worker static verification failed' END,
    artifact_ids = CASE WHEN _succeeded THEN COALESCE(_run.output_artifact_ids, '{}') ELSE artifact_ids END,
    result_summary = CASE WHEN _succeeded THEN 'Static backend patch verification passed; migration execution not performed' ELSE result_summary END,
    updated_at = now() WHERE id = _run.step_id;
  UPDATE public.builder_jobs SET status = _next_status,
    last_error = CASE WHEN _succeeded THEN NULL ELSE 'Backend worker static verification failed' END,
    updated_at = now() WHERE id = _run.job_id RETURNING * INTO _job;
  INSERT INTO public.builder_audit_events (organization_id, job_id, event_type, actor_type, previous_value, new_value, change_summary, related_artifact_ids)
  VALUES (_run.organization_id, _run.job_id, _event_type, 'builder_mode',
    jsonb_build_object('job_status', 'building', 'step_status', 'running'),
    jsonb_build_object('job_status', _next_status, 'step_status', CASE WHEN _succeeded THEN 'completed' ELSE 'failed' END, 'worker_run_id', _run.id, 'exit_code', _exit_code, 'verification_scope', 'static_backend_patch', 'migration_execution', false),
    CASE WHEN _succeeded THEN 'Backend static verification completed; database execution was not performed' ELSE 'Backend static verification failed and is retryable' END,
    COALESCE(_run.output_artifact_ids, '{}'));
  RETURN _job;
END;
$$;

-- Correct the phase transition for parallel implementation steps. The job may
-- enter testing only after the sibling Backend Engineer step is satisfied.
CREATE OR REPLACE FUNCTION public.builder_finish_frontend_worker(
  _run_id uuid, _lease_token text, _succeeded boolean, _exit_code integer, _log_summary text DEFAULT NULL
)
RETURNS public.builder_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _run public.builder_worker_runs%rowtype; _job public.builder_jobs%rowtype; _next_status text; _event_type text;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  SELECT * INTO _run FROM public.builder_worker_runs WHERE id = _run_id AND profile = 'frontend-verify' AND status = 'running'
    AND lease_expires_at > now() AND lease_token_hash = encode(extensions.digest(_lease_token, 'sha256'), 'hex') FOR UPDATE;
  IF _run.id IS NULL THEN RAISE EXCEPTION 'Frontend worker lease is missing, expired, or invalid'; END IF;
  SELECT * INTO _job FROM public.builder_jobs WHERE id = _run.job_id FOR UPDATE;
  IF _job.target_sha IS DISTINCT FROM _run.target_sha THEN RAISE EXCEPTION 'Job target changed during worker execution'; END IF;
  IF _succeeded AND NOT (
    EXISTS (SELECT 1 FROM public.builder_artifacts WHERE id = ANY(_run.output_artifact_ids) AND job_id = _run.job_id AND artifact_type = 'code_implementation' AND status = 'final')
    AND EXISTS (SELECT 1 FROM public.builder_artifacts WHERE id = ANY(_run.output_artifact_ids) AND job_id = _run.job_id AND artifact_type = 'changed_file_manifest' AND status = 'final')
    AND EXISTS (SELECT 1 FROM public.builder_artifacts WHERE id = ANY(_run.output_artifact_ids) AND job_id = _run.job_id AND artifact_type = 'build_logs' AND status = 'final')
  ) THEN RAISE EXCEPTION 'Successful frontend completion requires patch, manifest, and build logs'; END IF;
  _next_status := CASE
    WHEN NOT _succeeded THEN 'implementation_pending'
    WHEN EXISTS (SELECT 1 FROM public.builder_job_steps WHERE job_id = _run.job_id AND builder_mode = 'backend_engineer' AND status IN ('completed', 'skipped')) THEN 'testing'
    ELSE 'implementation_pending'
  END;
  _event_type := CASE WHEN _succeeded THEN 'step_completed' ELSE 'step_failed' END;
  UPDATE public.builder_worker_runs SET status = CASE WHEN _succeeded THEN 'completed' ELSE 'failed' END,
    completed_at = now(), exit_code = _exit_code, log_summary = left(COALESCE(_log_summary, ''), 1000),
    lease_token_hash = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = _run.id;
  UPDATE public.builder_job_steps SET status = CASE WHEN _succeeded THEN 'completed' ELSE 'failed' END,
    completed_at = now(), retryable = NOT _succeeded,
    error = CASE WHEN _succeeded THEN NULL ELSE 'Frontend worker verification failed' END,
    artifact_ids = CASE WHEN _succeeded THEN COALESCE(_run.output_artifact_ids, '{}') ELSE artifact_ids END,
    updated_at = now() WHERE id = _run.step_id;
  UPDATE public.builder_jobs SET status = _next_status,
    last_error = CASE WHEN _succeeded THEN NULL ELSE 'Frontend worker verification failed' END,
    updated_at = now() WHERE id = _run.job_id RETURNING * INTO _job;
  INSERT INTO public.builder_audit_events (organization_id, job_id, event_type, actor_type, previous_value, new_value, change_summary, related_artifact_ids)
  VALUES (_run.organization_id, _run.job_id, _event_type, 'builder_mode',
    jsonb_build_object('job_status', 'building', 'step_status', 'running'),
    jsonb_build_object('job_status', _next_status, 'step_status', CASE WHEN _succeeded THEN 'completed' ELSE 'failed' END, 'worker_run_id', _run.id, 'exit_code', _exit_code),
    CASE WHEN _succeeded THEN 'Frontend worker verification completed' ELSE 'Frontend worker verification failed and is retryable' END,
    COALESCE(_run.output_artifact_ids, '{}'));
  RETURN _job;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.builder_claim_backend_worker(uuid,uuid,uuid,text,text,integer) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.builder_heartbeat_backend_worker(uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.builder_reset_backend_worker_retry(uuid) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.builder_finish_backend_worker(uuid,text,boolean,integer,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.builder_claim_backend_worker(uuid,uuid,uuid,text,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_heartbeat_backend_worker(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_reset_backend_worker_retry(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_finish_backend_worker(uuid,text,boolean,integer,text) TO service_role;