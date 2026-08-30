-- Bounded authorization gate for autonomous Frontend Engineer repair attempts.

CREATE OR REPLACE FUNCTION public.builder_authorize_frontend_repair(
  _job_id uuid,
  _step_id uuid,
  _failed_worker_run_id uuid,
  _failed_patch_artifact_id uuid,
  _failure_artifact_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _job public.builder_jobs%rowtype;
  _step public.builder_job_steps%rowtype;
  _failed_run public.builder_worker_runs%rowtype;
  _patch public.builder_artifacts%rowtype;
  _failure public.builder_artifacts%rowtype;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  SELECT * INTO _job FROM public.builder_jobs WHERE id = _job_id FOR UPDATE;
  SELECT * INTO _step FROM public.builder_job_steps WHERE id = _step_id AND job_id = _job_id FOR UPDATE;
  SELECT * INTO _failed_run FROM public.builder_worker_runs WHERE id = _failed_worker_run_id AND job_id = _job_id AND step_id = _step_id;
  SELECT * INTO _patch FROM public.builder_artifacts WHERE id = _failed_patch_artifact_id AND job_id = _job_id AND step_id = _step_id;
  SELECT * INTO _failure FROM public.builder_artifacts WHERE id = _failure_artifact_id AND job_id = _job_id AND step_id = _step_id;

  IF _job.id IS NULL OR _job.status <> 'implementation_pending' THEN RAISE EXCEPTION 'Job is not awaiting frontend repair'; END IF;
  IF _step.id IS NULL OR _step.builder_mode <> 'frontend_engineer' THEN RAISE EXCEPTION 'Frontend Engineer step is missing'; END IF;
  IF _step.status <> 'failed' OR NOT _step.retryable THEN RAISE EXCEPTION 'Frontend Engineer step is not retryable'; END IF;
  IF _step.attempt_count >= 3 THEN
    UPDATE public.builder_job_steps SET retryable = false, error = 'Frontend repair attempt limit reached', updated_at = now() WHERE id = _step.id;
    UPDATE public.builder_jobs SET status = 'failed', last_error = 'Frontend repair attempt limit reached', updated_at = now() WHERE id = _job.id;
    INSERT INTO public.builder_audit_events (
      organization_id, job_id, event_type, actor_type, previous_value, new_value, change_summary, related_artifact_ids
    ) VALUES (
      _job.organization_id, _job.id, 'step_failed', 'builder_mode',
      jsonb_build_object('job_status', _job.status, 'step_status', _step.status, 'attempt_count', _step.attempt_count),
      jsonb_build_object('job_status', 'failed', 'step_status', 'failed', 'retryable', false),
      'Frontend autonomous repair attempt limit reached', ARRAY[_patch.id, _failure.id]
    );
    RETURN jsonb_build_object('authorized', false, 'reason', 'frontend repair attempt limit reached');
  END IF;
  IF _failed_run.id IS NULL OR _failed_run.status <> 'failed' OR _failed_run.target_sha IS DISTINCT FROM _job.target_sha THEN
    RAISE EXCEPTION 'Failed worker run is missing or stale';
  END IF;
  IF _patch.id IS NULL OR _patch.artifact_type <> 'code_implementation' OR _patch.status <> 'final' THEN
    RAISE EXCEPTION 'Failed patch artifact is invalid';
  END IF;
  IF _failure.id IS NULL OR _failure.artifact_type <> 'build_logs' OR _failure.status <> 'final'
     OR NOT (_failure.id = ANY(COALESCE(_failed_run.output_artifact_ids, '{}'))) THEN
    RAISE EXCEPTION 'Failure evidence is invalid';
  END IF;
  IF _failed_run.patch_artifact_id IS DISTINCT FROM _patch.id THEN RAISE EXCEPTION 'Failed patch does not belong to worker run'; END IF;

  INSERT INTO public.builder_audit_events (
    organization_id, job_id, event_type, actor_type, new_value, change_summary, related_artifact_ids
  ) VALUES (
    _job.organization_id, _job.id, 'model_run_started', 'builder_mode',
    jsonb_build_object('mode', 'frontend_repair', 'repair_attempt', _step.attempt_count + 1,
      'failed_worker_run_id', _failed_run.id, 'target_sha', _job.target_sha),
    'Bounded autonomous frontend repair authorized', ARRAY[_patch.id, _failure.id]
  );
  RETURN jsonb_build_object('authorized', true, 'repair_attempt', _step.attempt_count + 1, 'target_sha', _job.target_sha);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.builder_authorize_frontend_repair(uuid,uuid,uuid,uuid,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_authorize_frontend_repair(uuid,uuid,uuid,uuid,uuid)
  TO service_role;