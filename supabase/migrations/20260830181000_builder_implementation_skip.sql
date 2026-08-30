-- Explicit, audited no-op transitions for frontend-only and backend-only jobs.

CREATE OR REPLACE FUNCTION public.builder_skip_implementation_step(
  _job_id uuid, _step_id uuid, _builder_mode text, _reason text
)
RETURNS public.builder_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _job public.builder_jobs%rowtype; _step public.builder_job_steps%rowtype; _sibling_mode text; _next_status text;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  IF _builder_mode NOT IN ('frontend_engineer', 'backend_engineer') THEN RAISE EXCEPTION 'Unsupported implementation mode'; END IF;
  IF NULLIF(btrim(_reason), '') IS NULL THEN RAISE EXCEPTION 'A skip reason is required'; END IF;
  SELECT * INTO _job FROM public.builder_jobs WHERE id = _job_id FOR UPDATE;
  SELECT * INTO _step FROM public.builder_job_steps WHERE id = _step_id AND job_id = _job_id FOR UPDATE;
  IF _job.id IS NULL OR _job.status <> 'implementation_pending' THEN RAISE EXCEPTION 'Job is not ready for an implementation skip'; END IF;
  IF _step.id IS NULL OR _step.builder_mode <> _builder_mode OR _step.status NOT IN ('pending', 'blocked') THEN RAISE EXCEPTION 'Implementation step cannot be skipped'; END IF;
  _sibling_mode := CASE WHEN _builder_mode = 'frontend_engineer' THEN 'backend_engineer' ELSE 'frontend_engineer' END;
  _next_status := CASE
    WHEN EXISTS (SELECT 1 FROM public.builder_job_steps WHERE job_id = _job_id AND builder_mode = _sibling_mode AND status IN ('completed', 'skipped')) THEN 'testing'
    ELSE 'implementation_pending'
  END;
  UPDATE public.builder_job_steps SET status = 'skipped', completed_at = now(), retryable = false,
    result_summary = left(btrim(_reason), 1000), error = NULL, updated_at = now() WHERE id = _step.id;
  UPDATE public.builder_jobs SET status = _next_status, current_step_name = _step.step_id,
    current_step_index = _step.ordinal_position, updated_at = now() WHERE id = _job.id RETURNING * INTO _job;
  INSERT INTO public.builder_audit_events (organization_id, job_id, event_type, actor_type, previous_value, new_value, change_summary)
  VALUES (_job.organization_id, _job.id, 'step_completed', 'builder_mode',
    jsonb_build_object('job_status', 'implementation_pending', 'step_status', _step.status),
    jsonb_build_object('job_status', _next_status, 'step_status', 'skipped', 'builder_mode', _builder_mode),
    left('Implementation step skipped: ' || btrim(_reason), 1000));
  RETURN _job;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.builder_skip_implementation_step(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.builder_skip_implementation_step(uuid,uuid,text,text) TO service_role;