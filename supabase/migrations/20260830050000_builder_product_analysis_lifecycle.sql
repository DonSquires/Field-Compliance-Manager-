-- Service-only lifecycle for the first Builder mode: Product Analyst.

CREATE OR REPLACE FUNCTION public.builder_start_product_analysis(
  _job_id uuid,
  _step_id uuid
)
RETURNS public.builder_job_steps
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _job public.builder_jobs%rowtype;
  _step public.builder_job_steps%rowtype;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;

  SELECT * INTO _job FROM public.builder_jobs WHERE id = _job_id FOR UPDATE;
  SELECT * INTO _step FROM public.builder_job_steps WHERE id = _step_id AND job_id = _job_id FOR UPDATE;

  IF _job.id IS NULL OR _job.status NOT IN ('intake', 'analysis_pending') THEN
    RAISE EXCEPTION 'Job is not ready for product analysis';
  END IF;
  IF _step.id IS NULL OR _step.builder_mode <> 'product_analyst' THEN
    RAISE EXCEPTION 'Product Analyst step is missing';
  END IF;
  IF _step.status <> 'pending' AND NOT (_step.status = 'failed' AND _step.retryable) THEN
    RAISE EXCEPTION 'Product Analyst step cannot be started';
  END IF;

  UPDATE public.builder_job_steps
  SET status = 'running',
      attempt_count = attempt_count + 1,
      started_at = now(),
      completed_at = NULL,
      error = NULL,
      retryable = false,
      updated_at = now()
  WHERE id = _step.id
  RETURNING * INTO _step;

  UPDATE public.builder_jobs
  SET status = 'analysis_pending',
      current_step_name = _step.step_id,
      current_step_index = _step.ordinal_position,
      last_error = NULL,
      updated_at = now()
  WHERE id = _job.id;

  INSERT INTO public.builder_audit_events (
    organization_id, job_id, event_type, actor_type,
    previous_value, new_value, change_summary
  ) VALUES (
    _job.organization_id, _job.id, 'step_started', 'builder_mode',
    jsonb_build_object('job_status', _job.status, 'step_status', _step.status),
    jsonb_build_object('job_status', 'analysis_pending', 'step_status', 'running', 'step_id', _step.step_id),
    'Product Analyst step started'
  );

  RETURN _step;
END;
$$;

CREATE OR REPLACE FUNCTION public.builder_complete_product_analysis(
  _job_id uuid,
  _step_id uuid,
  _artifact_id uuid,
  _result_summary text,
  _requested_from_users uuid[] DEFAULT '{}'
)
RETURNS public.builder_approvals
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _job public.builder_jobs%rowtype;
  _step public.builder_job_steps%rowtype;
  _artifact public.builder_artifacts%rowtype;
  _approval public.builder_approvals%rowtype;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;

  SELECT * INTO _job FROM public.builder_jobs WHERE id = _job_id FOR UPDATE;
  SELECT * INTO _step FROM public.builder_job_steps WHERE id = _step_id AND job_id = _job_id FOR UPDATE;
  SELECT * INTO _artifact FROM public.builder_artifacts WHERE id = _artifact_id AND job_id = _job_id;

  IF _job.id IS NULL OR _job.status <> 'analysis_pending' THEN
    RAISE EXCEPTION 'Job is not awaiting product analysis completion';
  END IF;
  IF _step.id IS NULL OR _step.builder_mode <> 'product_analyst' OR _step.status <> 'running' THEN
    RAISE EXCEPTION 'Product Analyst step is not running';
  END IF;
  IF _artifact.id IS NULL OR _artifact.step_id IS DISTINCT FROM _step.id
     OR _artifact.artifact_type <> 'product_specification' OR _artifact.status <> 'final' THEN
    RAISE EXCEPTION 'A final Product Analyst artifact is required';
  END IF;

  UPDATE public.builder_job_steps
  SET status = 'completed',
      completed_at = now(),
      result_summary = left(COALESCE(_result_summary, ''), 1000),
      artifact_ids = CASE
        WHEN _artifact.id = ANY(COALESCE(artifact_ids, '{}')) THEN artifact_ids
        ELSE array_append(COALESCE(artifact_ids, '{}'), _artifact.id)
      END,
      updated_at = now()
  WHERE id = _step.id;

  UPDATE public.builder_jobs
  SET status = 'specification_ready',
      current_step_name = _step.step_id,
      current_step_index = _step.ordinal_position,
      updated_at = now()
  WHERE id = _job.id;

  INSERT INTO public.builder_audit_events (
    organization_id, job_id, event_type, actor_type,
    previous_value, new_value, change_summary, related_artifact_ids
  ) VALUES (
    _job.organization_id, _job.id, 'step_completed', 'builder_mode',
    jsonb_build_object('job_status', _job.status, 'step_status', _step.status),
    jsonb_build_object('job_status', 'specification_ready', 'step_status', 'completed', 'step_id', _step.step_id),
    'Product Analyst completed a validated specification',
    ARRAY[_artifact.id]
  );

  SELECT * INTO _approval
  FROM public.builder_request_approval(
    _job.id,
    'specification_review',
    ARRAY[_artifact.id],
    COALESCE(_requested_from_users, '{}')
  );

  RETURN _approval;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.builder_start_product_analysis(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_start_product_analysis(uuid, uuid)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.builder_complete_product_analysis(uuid, uuid, uuid, text, uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_complete_product_analysis(uuid, uuid, uuid, text, uuid[])
  TO service_role;