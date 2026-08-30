-- Independent QA/security review of completed frontend worker evidence.

ALTER TABLE public.builder_worker_runs
  ADD COLUMN IF NOT EXISTS review_summary jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE OR REPLACE FUNCTION public.builder_claim_security_review(
  _job_id uuid,
  _security_step_id uuid,
  _frontend_worker_run_id uuid,
  _runner_id text,
  _expected_target_sha text,
  _timeout_seconds integer DEFAULT 300
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _job public.builder_jobs%rowtype;
  _security_step public.builder_job_steps%rowtype;
  _test_step public.builder_job_steps%rowtype;
  _frontend_run public.builder_worker_runs%rowtype;
  _run public.builder_worker_runs%rowtype;
  _patch_id uuid;
  _manifest_id uuid;
  _log_id uuid;
  _lease_token text := encode(extensions.gen_random_bytes(32), 'hex');
  _lease_hash text;
  _idempotency_key text;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  IF NULLIF(btrim(_runner_id), '') IS NULL THEN RAISE EXCEPTION 'runner_id is required'; END IF;
  IF _timeout_seconds < 60 OR _timeout_seconds > 900 THEN RAISE EXCEPTION 'security review timeout is invalid'; END IF;
  UPDATE public.builder_job_steps step
  SET status = 'failed', retryable = true, error = 'Security review worker lease expired', updated_at = now()
  FROM public.builder_worker_runs run
  WHERE run.step_id = step.id AND run.profile = 'security-review' AND run.status = 'running' AND run.lease_expires_at <= now();
  UPDATE public.builder_jobs job
  SET status = 'testing', last_error = 'Security review worker lease expired', updated_at = now()
  FROM public.builder_worker_runs run
  WHERE run.job_id = job.id AND run.profile = 'security-review' AND run.status = 'running' AND run.lease_expires_at <= now();
  UPDATE public.builder_worker_runs
  SET status = 'timeout', completed_at = now(), lease_token_hash = NULL,
      output_artifact_ids = '{}', review_summary = '{}'::jsonb, updated_at = now()
  WHERE profile = 'security-review' AND status = 'running' AND lease_expires_at <= now();
  -- The global mutex is defined by builder_worker_runs_one_active_global.
  IF EXISTS (SELECT 1 FROM public.builder_worker_runs WHERE status = 'running') THEN RAISE EXCEPTION 'Another Builder worker already holds the active lease'; END IF;

  SELECT * INTO _job FROM public.builder_jobs WHERE id = _job_id FOR UPDATE;
  SELECT * INTO _security_step FROM public.builder_job_steps WHERE id = _security_step_id AND job_id = _job_id FOR UPDATE;
  SELECT * INTO _test_step FROM public.builder_job_steps WHERE job_id = _job_id AND step_id = 'test_suite' FOR UPDATE;
  SELECT * INTO _frontend_run FROM public.builder_worker_runs WHERE id = _frontend_worker_run_id AND job_id = _job_id;

  IF _job.id IS NULL OR _job.status <> 'testing' THEN RAISE EXCEPTION 'Job is not ready for security review'; END IF;
  IF _job.target_sha IS NULL OR _expected_target_sha IS DISTINCT FROM _job.target_sha THEN RAISE EXCEPTION 'Security review target SHA is stale or missing'; END IF;
  IF _security_step.id IS NULL OR _security_step.step_id <> 'security_review' OR _security_step.builder_mode <> 'qa_security_reviewer'
     OR (_security_step.status <> 'pending' AND NOT (_security_step.status = 'failed' AND _security_step.retryable)) THEN
    RAISE EXCEPTION 'Security review step is not pending';
  END IF;
  IF _test_step.id IS NULL OR _test_step.builder_mode <> 'qa_security_reviewer' OR _test_step.status NOT IN ('pending', 'completed') THEN RAISE EXCEPTION 'Test-suite step is not ready'; END IF;
  IF _frontend_run.id IS NULL OR _frontend_run.status <> 'completed'
     OR _frontend_run.organization_id IS DISTINCT FROM _job.organization_id
     OR _frontend_run.target_sha IS DISTINCT FROM _job.target_sha THEN
    RAISE EXCEPTION 'Completed frontend worker evidence is missing or stale';
  END IF;

  SELECT id INTO _patch_id FROM public.builder_artifacts
  WHERE id = ANY(_frontend_run.output_artifact_ids) AND job_id = _job.id AND step_id = _frontend_run.step_id
    AND artifact_type = 'code_implementation' AND status = 'final' LIMIT 1;
  SELECT id INTO _manifest_id FROM public.builder_artifacts
  WHERE id = ANY(_frontend_run.output_artifact_ids) AND job_id = _job.id AND step_id = _frontend_run.step_id
    AND artifact_type = 'changed_file_manifest' AND status = 'final' LIMIT 1;
  SELECT id INTO _log_id FROM public.builder_artifacts
  WHERE id = ANY(_frontend_run.output_artifact_ids) AND job_id = _job.id AND step_id = _frontend_run.step_id
    AND artifact_type = 'build_logs' AND status = 'final' LIMIT 1;
  IF _patch_id IS NULL OR _manifest_id IS NULL OR _log_id IS NULL THEN RAISE EXCEPTION 'Frontend verification evidence is incomplete'; END IF;

  UPDATE public.builder_job_steps
  SET status = 'completed', completed_at = now(), result_summary = 'Accepted isolated frontend lint, build, and test evidence',
      artifact_ids = _frontend_run.output_artifact_ids, updated_at = now()
  WHERE id = _test_step.id;
  UPDATE public.builder_job_steps
  SET status = 'running', attempt_count = attempt_count + 1, started_at = now(), retryable = false,
      input_context = jsonb_build_object('frontend_worker_run_id', _frontend_run.id, 'patch_artifact_id', _patch_id,
        'manifest_artifact_id', _manifest_id, 'build_log_artifact_id', _log_id, 'target_sha', _job.target_sha), updated_at = now()
  WHERE id = _security_step.id;
  UPDATE public.builder_jobs SET status = 'security_review', current_step_name = _security_step.step_id,
    current_step_index = _security_step.ordinal_position, updated_at = now() WHERE id = _job.id;

  _lease_hash := encode(extensions.digest(_lease_token, 'sha256'), 'hex');
  _idempotency_key := _job.id::text || '::security::' || _job.target_sha || '::' || _patch_id::text || '::' || _manifest_id::text;
  INSERT INTO public.builder_worker_runs (
    organization_id, job_id, step_id, runner_id, worker_isolation_level, command, command_args,
    environment_variables_snapshot, profile, target_sha, patch_artifact_id, idempotency_key,
    lease_token_hash, lease_expires_at, heartbeat_at, status, started_at, timeout_seconds
  ) VALUES (
    _job.organization_id, _job.id, _security_step.id, _runner_id, 'container', 'security-review', ARRAY['security-review'],
    '{}'::jsonb, 'security-review', _job.target_sha, _patch_id, _idempotency_key,
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
    jsonb_build_object('step_id', _security_step.step_id, 'worker_run_id', _run.id, 'target_sha', _job.target_sha),
    'Independent security review worker claimed', ARRAY[_patch_id, _manifest_id, _log_id]);
  RETURN jsonb_build_object('run_id', _run.id, 'lease_token', _lease_token, 'lease_expires_at', _run.lease_expires_at,
    'organization_id', _job.organization_id, 'job_id', _job.id, 'step_id', _security_step.id, 'target_sha', _job.target_sha,
    'profile', 'security-review', 'patch_artifact_id', _patch_id, 'manifest_artifact_id', _manifest_id, 'build_log_artifact_id', _log_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.builder_register_security_review(
  _run_id uuid, _lease_token text, _object_path text, _sha256 text, _size_bytes integer
)
RETURNS public.builder_artifacts
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _run public.builder_worker_runs%rowtype; _artifact public.builder_artifacts%rowtype;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  SELECT * INTO _run FROM public.builder_worker_runs WHERE id = _run_id AND profile = 'security-review' AND status = 'running'
    AND lease_expires_at > now() AND lease_token_hash = encode(extensions.digest(_lease_token, 'sha256'), 'hex') FOR UPDATE;
  IF _run.id IS NULL THEN RAISE EXCEPTION 'Security review lease is missing, expired, or invalid'; END IF;
  IF _object_path IS NULL OR _object_path = '' OR _object_path LIKE '%..%' THEN RAISE EXCEPTION 'Invalid security artifact path'; END IF;
  IF _sha256 !~ '^[a-f0-9]{64}$' OR _size_bytes < 0 OR _size_bytes > 10485760 THEN RAISE EXCEPTION 'Invalid security artifact integrity metadata'; END IF;
  INSERT INTO public.builder_artifacts (job_id, step_id, artifact_type, content_type, content_size_bytes, storage_location, checksum, status)
  VALUES (_run.job_id, _run.step_id, 'security_review', 'application/json', _size_bytes,
    'supabase_storage://builder-artifacts/' || _object_path, _sha256, 'final') RETURNING * INTO _artifact;
  UPDATE public.builder_worker_runs SET output_artifact_ids = ARRAY[_artifact.id], updated_at = now() WHERE id = _run.id;
  INSERT INTO public.builder_audit_events (organization_id, job_id, event_type, actor_type, new_value, change_summary, related_artifact_ids)
  VALUES (_run.organization_id, _run.job_id, 'artifact_created', 'builder_mode',
    jsonb_build_object('worker_run_id', _run.id, 'artifact_type', 'security_review', 'checksum', _sha256),
    'Independent security review artifact registered', ARRAY[_artifact.id]);
  RETURN _artifact;
END;
$$;

CREATE OR REPLACE FUNCTION public.builder_finish_security_review(
  _run_id uuid, _lease_token text, _security_artifact_id uuid,
  _critical_count integer, _high_count integer, _medium_count integer, _low_count integer
)
RETURNS public.builder_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _run public.builder_worker_runs%rowtype; _job public.builder_jobs%rowtype; _next_job_status text; _passed boolean;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  IF LEAST(_critical_count, _high_count, _medium_count, _low_count) < 0 THEN RAISE EXCEPTION 'Finding counts cannot be negative'; END IF;
  SELECT * INTO _run FROM public.builder_worker_runs WHERE id = _run_id AND profile = 'security-review' AND status = 'running'
    AND lease_expires_at > now() AND lease_token_hash = encode(extensions.digest(_lease_token, 'sha256'), 'hex') FOR UPDATE;
  IF _run.id IS NULL THEN RAISE EXCEPTION 'Security review lease is missing, expired, or invalid'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.builder_artifacts WHERE id = _security_artifact_id AND job_id = _run.job_id
    AND step_id = _run.step_id AND artifact_type = 'security_review' AND status = 'final'
    AND id = ANY(_run.output_artifact_ids)) THEN RAISE EXCEPTION 'Verified security review artifact is required'; END IF;
  SELECT * INTO _job FROM public.builder_jobs WHERE id = _run.job_id FOR UPDATE;
  IF _job.status <> 'security_review' OR _job.target_sha IS DISTINCT FROM _run.target_sha THEN RAISE EXCEPTION 'Security review job state is stale'; END IF;

  _passed := NOT (_critical_count > 0 OR _high_count > 0);
  _next_job_status := CASE WHEN _passed THEN 'security_review' ELSE 'failed' END;
  UPDATE public.builder_worker_runs SET status = 'completed', completed_at = now(), exit_code = CASE WHEN _passed THEN 0 ELSE 1 END,
    review_summary = jsonb_build_object('passed', _passed, 'critical', _critical_count, 'high', _high_count, 'medium', _medium_count, 'low', _low_count),
    lease_token_hash = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = _run.id;
  UPDATE public.builder_job_steps SET status = CASE WHEN _passed THEN 'completed' ELSE 'failed' END, completed_at = now(),
    retryable = false, artifact_ids = ARRAY[_security_artifact_id],
    result_summary = CASE WHEN _passed THEN 'Independent security review passed' ELSE 'Security review blocked release' END,
    error = CASE WHEN _passed THEN NULL ELSE 'Critical or high security findings block release' END, updated_at = now()
  WHERE id = _run.step_id;
  UPDATE public.builder_jobs SET status = _next_job_status,
    last_error = CASE WHEN _passed THEN NULL ELSE 'Critical or high security findings block release' END, updated_at = now()
  WHERE id = _run.job_id RETURNING * INTO _job;
  INSERT INTO public.builder_audit_events (organization_id, job_id, event_type, actor_type, previous_value, new_value, change_summary, related_artifact_ids)
  VALUES (_run.organization_id, _run.job_id, CASE WHEN _passed THEN 'step_completed' ELSE 'step_failed' END, 'builder_mode',
    jsonb_build_object('job_status', 'security_review', 'step_status', 'running'),
    jsonb_build_object('job_status', _next_job_status, 'step_status', CASE WHEN _passed THEN 'completed' ELSE 'failed' END,
      'critical', _critical_count, 'high', _high_count, 'medium', _medium_count, 'low', _low_count),
    CASE WHEN _passed THEN 'Independent security review passed' ELSE 'Independent security review blocked release' END,
    ARRAY[_security_artifact_id]);
  RETURN _job;
END;
$$;

CREATE OR REPLACE FUNCTION public.builder_abort_security_review(
  _run_id uuid, _lease_token text, _reason text
)
RETURNS public.builder_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _run public.builder_worker_runs%rowtype; _job public.builder_jobs%rowtype;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  SELECT * INTO _run FROM public.builder_worker_runs WHERE id = _run_id AND profile = 'security-review' AND status = 'running'
    AND lease_token_hash = encode(extensions.digest(_lease_token, 'sha256'), 'hex') FOR UPDATE;
  IF _run.id IS NULL THEN RAISE EXCEPTION 'Security review lease is missing or invalid'; END IF;
  UPDATE public.builder_worker_runs SET status = 'failed', completed_at = now(), lease_token_hash = NULL,
    lease_expires_at = NULL, log_summary = left(COALESCE(_reason, 'Security review infrastructure failure'), 1000), updated_at = now()
  WHERE id = _run.id;
  UPDATE public.builder_job_steps SET status = 'failed', retryable = true,
    error = left(COALESCE(_reason, 'Security review infrastructure failure'), 1000), updated_at = now()
  WHERE id = _run.step_id;
  UPDATE public.builder_jobs SET status = 'testing',
    last_error = left(COALESCE(_reason, 'Security review infrastructure failure'), 1000), updated_at = now()
  WHERE id = _run.job_id RETURNING * INTO _job;
  INSERT INTO public.builder_audit_events (organization_id, job_id, event_type, actor_type, previous_value, new_value, change_summary)
  VALUES (_run.organization_id, _run.job_id, 'step_failed', 'builder_mode',
    jsonb_build_object('job_status', 'security_review', 'step_status', 'running'),
    jsonb_build_object('job_status', 'testing', 'step_status', 'failed', 'retryable', true),
    'Security review infrastructure failure is retryable');
  RETURN _job;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.builder_claim_security_review(uuid,uuid,uuid,text,text,integer) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.builder_register_security_review(uuid,text,text,text,integer) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.builder_finish_security_review(uuid,text,uuid,integer,integer,integer,integer) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.builder_abort_security_review(uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.builder_claim_security_review(uuid,uuid,uuid,text,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_register_security_review(uuid,text,text,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_finish_security_review(uuid,text,uuid,integer,integer,integer,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_abort_security_review(uuid,text,text) TO service_role;