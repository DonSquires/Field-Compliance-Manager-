-- An author that honestly declines a change ("the named file does not exist at this commit;
-- inventing it would be unsafe") is not a failure to retry. Job 92f7369a (2026-09-26) gave that
-- answer six times, once per autopilot tick, until the attempt ceiling blocked it — six full
-- engineer runs to relay one sentence to the requester.
--
-- builder_record_generation_failure gains _retryable (default true, so existing callers keep
-- their behaviour); a non-retryable failure parks the step so the runner reports the author's
-- reason immediately instead of re-running the author.

DROP FUNCTION IF EXISTS public.builder_record_generation_failure(uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.builder_record_generation_failure(_job_id uuid, _step_id uuid, _reason text, _retryable boolean DEFAULT true)
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
      retryable = COALESCE(_retryable, true),
      attempt_count = COALESCE(attempt_count, 0) + 1,
      error = left(COALESCE(NULLIF(btrim(_reason), ''), 'author produced no proposal'), 2000),
      started_at = COALESCE(started_at, now()),
      completed_at = now(),
      updated_at = now()
  WHERE id = _step.id RETURNING * INTO _step;
  INSERT INTO public.builder_audit_events (organization_id, job_id, event_type, actor_type, previous_value, new_value, change_summary)
  VALUES (_job.organization_id, _job.id, 'step_failed', 'bot',
    jsonb_build_object('step', _step.step_id, 'attempt_count', _step.attempt_count - 1),
    jsonb_build_object('step', _step.step_id, 'attempt_count', _step.attempt_count, 'retryable', COALESCE(_retryable, true), 'reason', left(_reason, 500)),
    CASE WHEN COALESCE(_retryable, true) THEN 'Author run ended without a proposal; attempt counted towards the step ceiling'
         ELSE 'Author declined the change with a reason; step parked for a human, not retried' END);
  RETURN _step;
END;
$$;
REVOKE ALL ON FUNCTION public.builder_record_generation_failure(uuid, uuid, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_record_generation_failure(uuid, uuid, text, boolean) TO service_role;
