-- Bounded recovery for independent AI code-review infrastructure failures.

CREATE OR REPLACE FUNCTION public.builder_abort_independent_code_review(
  _job_id uuid,
  _step_id uuid,
  _reason text
)
RETURNS public.builder_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _job public.builder_jobs%rowtype; _step public.builder_job_steps%rowtype; _terminal boolean;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  SELECT * INTO _job FROM public.builder_jobs WHERE id = _job_id FOR UPDATE;
  SELECT * INTO _step FROM public.builder_job_steps WHERE id = _step_id AND job_id = _job_id FOR UPDATE;
  IF _job.id IS NULL OR _job.status <> 'security_review' OR _job.code_review_mode <> 'independent_ai'
     OR _step.id IS NULL OR _step.status <> 'running' OR _step.builder_mode <> 'code_reviewer' THEN
    RAISE EXCEPTION 'Independent code review is not running';
  END IF;
  _terminal := _step.attempt_count >= 2;
  UPDATE public.builder_job_steps
  SET status = CASE WHEN _terminal THEN 'failed' ELSE 'pending' END,
      retryable = NOT _terminal,
      completed_at = CASE WHEN _terminal THEN now() ELSE NULL END,
      error = left(COALESCE(_reason, 'Independent reviewer infrastructure failure'), 1000),
      updated_at = now()
  WHERE id = _step.id;
  UPDATE public.builder_jobs
  SET code_review_status = CASE WHEN _terminal THEN 'blocked' ELSE 'pending' END,
      status = CASE WHEN _terminal THEN 'failed' ELSE 'security_review' END,
      last_error = left(COALESCE(_reason, 'Independent reviewer infrastructure failure'), 1000),
      updated_at = now()
  WHERE id = _job.id RETURNING * INTO _job;
  INSERT INTO public.builder_audit_events (organization_id, job_id, event_type, actor_type, previous_value, new_value, change_summary)
  VALUES (_job.organization_id, _job.id, 'step_failed', 'builder_mode',
    jsonb_build_object('step_status', 'running', 'attempt_count', _step.attempt_count),
    jsonb_build_object('step_status', CASE WHEN _terminal THEN 'failed' ELSE 'pending' END,
      'retryable', NOT _terminal, 'code_review_status', _job.code_review_status),
    CASE WHEN _terminal THEN 'Independent AI review retry limit reached' ELSE 'Independent AI review infrastructure failure is retryable' END);
  RETURN _job;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.builder_abort_independent_code_review(uuid,uuid,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_abort_independent_code_review(uuid,uuid,text)
  TO service_role;