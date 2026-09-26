CREATE OR REPLACE FUNCTION public.builder_cancel_job(_job_id uuid, _reason text)
RETURNS public.builder_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _uid uuid := auth.uid();
  _trimmed_reason text := btrim(_reason);
  _job public.builder_jobs;
  _updated_job public.builder_jobs;
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR _uid IS NULL THEN
    RAISE EXCEPTION 'Authenticated human required';
  END IF;
  IF _trimmed_reason IS NULL OR _trimmed_reason = '' OR char_length(_trimmed_reason) > 2000 THEN
    RAISE EXCEPTION 'Cancellation reason must be 1 to 2000 characters';
  END IF;

  SELECT * INTO _job
  FROM public.builder_jobs
  WHERE id = _job_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Builder job not found';
  END IF;
  IF _job.status IN ('deployed', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'Builder job is already finished';
  END IF;
  IF NOT public.can_approve_action(_uid, _job.organization_id) THEN
    RAISE EXCEPTION 'Not authorized to cancel Builder job';
  END IF;

  UPDATE public.builder_jobs
  SET status = 'cancelled',
      last_error = 'Cancelled: ' || _trimmed_reason,
      autopilot_state = CASE WHEN autopilot_requested_by IS NOT NULL THEN 'done' ELSE autopilot_state END,
      updated_at = now()
  WHERE id = _job.id
  RETURNING * INTO _updated_job;

  INSERT INTO public.builder_audit_events (
    organization_id, job_id, event_type, actor_user_id, actor_type,
    previous_value, new_value, change_summary
  ) VALUES (
    _job.organization_id, _job.id, 'job_cancelled', _uid, 'human',
    jsonb_build_object('status', _job.status),
    jsonb_build_object('status', 'cancelled', 'reason', _trimmed_reason),
    'Builder job cancelled by human operator'
  );

  RETURN _updated_job;
END;
$$;

REVOKE ALL ON FUNCTION public.builder_cancel_job(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.builder_cancel_job(uuid, text) TO authenticated;
