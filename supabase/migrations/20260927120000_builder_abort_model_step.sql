-- A product-analyst or UX-designer model run that fails after its step was started leaves the
-- step 'running' forever: nothing marks it failed, so the planner sees a running step, reports
-- "the Builder is blocked" with no reason, and the autopilot parks the job. Job 958829bd
-- (2026-09-26) stalled this way when the UX designer's output failed contract validation.
--
-- builder_abort_model_step returns such a step to failed/retryable (the start RPCs already
-- counted the attempt) and records why. Service role only (control plane).

CREATE OR REPLACE FUNCTION public.builder_abort_model_step(_job_id uuid, _step_id uuid, _reason text)
RETURNS public.builder_job_steps
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _step public.builder_job_steps%rowtype; _job public.builder_jobs%rowtype;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  SELECT * INTO _job FROM public.builder_jobs WHERE id = _job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Builder job is unavailable'; END IF;
  SELECT * INTO _step FROM public.builder_job_steps WHERE id = _step_id AND job_id = _job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Builder step is unavailable'; END IF;
  IF _step.builder_mode NOT IN ('product_analyst', 'ux_designer') THEN RAISE EXCEPTION 'Only analyst and designer steps are aborted this way'; END IF;
  IF _step.status <> 'running' THEN RAISE EXCEPTION 'Step is not running'; END IF;
  UPDATE public.builder_job_steps
  SET status = 'failed',
      retryable = true,
      error = left(COALESCE(NULLIF(btrim(_reason), ''), 'model run failed'), 2000),
      completed_at = now(),
      updated_at = now()
  WHERE id = _step.id RETURNING * INTO _step;
  UPDATE public.builder_jobs SET last_error = left(COALESCE(NULLIF(btrim(_reason), ''), 'model run failed'), 1000), updated_at = now() WHERE id = _job.id;
  INSERT INTO public.builder_audit_events (organization_id, job_id, event_type, actor_type, previous_value, new_value, change_summary)
  VALUES (_job.organization_id, _job.id, 'step_failed', 'bot',
    jsonb_build_object('step', _step.step_id, 'step_status', 'running', 'attempt_count', _step.attempt_count),
    jsonb_build_object('step', _step.step_id, 'step_status', 'failed', 'retryable', true, 'reason', left(_reason, 500)),
    'Model run failed after the step started; step returned to failed/retryable');
  RETURN _step;
END;
$$;
REVOKE ALL ON FUNCTION public.builder_abort_model_step(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_abort_model_step(uuid, uuid, text) TO service_role;
