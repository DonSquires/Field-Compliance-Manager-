-- The Builder's attempt ceiling only counted attempts that reached a worker (the claim RPCs
-- increment attempt_count). An author run that ends without a proposal (turn budget exhausted,
-- unparseable tool calls, model unavailable) left the implementation step 'pending' with
-- attempt_count 0, so the autopilot retried it every tick indefinitely: job 1021dbaa ran the
-- agentic engineer five times (~2M prompt tokens each) on 2026-09-26 before anyone noticed.
--
-- builder_record_generation_failure marks the step failed-but-retryable and counts the attempt,
-- so attemptCeilingReached() (MAX_STEP_ATTEMPTS) applies to author failures too. Service role
-- only (called by the control plane's runtime coordinator).

CREATE OR REPLACE FUNCTION public.builder_record_generation_failure(_job_id uuid, _step_id uuid, _reason text)
RETURNS public.builder_job_steps
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _step public.builder_job_steps%rowtype; _job public.builder_jobs%rowtype;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  SELECT * INTO _job FROM public.builder_jobs WHERE id = _job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Builder job is unavailable'; END IF;
  SELECT * INTO _step FROM public.builder_job_steps WHERE id = _step_id AND job_id = _job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Builder step is unavailable'; END IF;
  IF _step.builder_mode NOT IN ('backend_engineer', 'frontend_engineer') THEN RAISE EXCEPTION 'Only implementation steps record generation failures'; END IF;
  IF _step.status NOT IN ('pending', 'failed') THEN RAISE EXCEPTION 'Step is not awaiting an author attempt'; END IF;
  UPDATE public.builder_job_steps
  SET status = 'failed',
      retryable = true,
      attempt_count = COALESCE(attempt_count, 0) + 1,
      error = left(COALESCE(NULLIF(btrim(_reason), ''), 'author produced no proposal'), 2000),
      started_at = COALESCE(started_at, now()),
      completed_at = now(),
      updated_at = now()
  WHERE id = _step.id RETURNING * INTO _step;
  INSERT INTO public.builder_audit_events (organization_id, job_id, event_type, actor_type, previous_value, new_value, change_summary)
  VALUES (_job.organization_id, _job.id, 'step_failed', 'bot',
    jsonb_build_object('step', _step.step_id, 'attempt_count', _step.attempt_count - 1),
    jsonb_build_object('step', _step.step_id, 'attempt_count', _step.attempt_count, 'retryable', true, 'reason', left(_reason, 500)),
    'Author run ended without a proposal; attempt counted towards the step ceiling');
  RETURN _step;
END;
$$;
REVOKE ALL ON FUNCTION public.builder_record_generation_failure(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_record_generation_failure(uuid, uuid, text) TO service_role;
