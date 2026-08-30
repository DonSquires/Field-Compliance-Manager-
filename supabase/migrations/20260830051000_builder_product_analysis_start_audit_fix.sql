-- Preserve the pre-transition step status in Product Analyst start audit events.

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
  _previous_step_status text;
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

  _previous_step_status := _step.status;
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
    jsonb_build_object('job_status', _job.status, 'step_status', _previous_step_status),
    jsonb_build_object('job_status', 'analysis_pending', 'step_status', 'running', 'step_id', _step.step_id),
    'Product Analyst step started'
  );

  RETURN _step;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.builder_start_product_analysis(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_start_product_analysis(uuid, uuid)
  TO service_role;