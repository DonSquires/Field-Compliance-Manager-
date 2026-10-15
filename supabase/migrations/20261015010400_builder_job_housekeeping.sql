CREATE OR REPLACE FUNCTION public.builder_retire_stale_job(
  _job_id uuid,
  _reason text,
  _outcome text,
  _details jsonb DEFAULT '{}'::jsonb
)
RETURNS public.builder_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _job public.builder_jobs%rowtype;
  _updated public.builder_jobs%rowtype;
  _trimmed_reason text := btrim(_reason);
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;
  IF _outcome NOT IN (
    'completed_autopilot',
    'superseded_main_health',
    'inactive_orphan',
    'owner_requested_cleanup'
  ) THEN
    RAISE EXCEPTION 'Unsupported Builder housekeeping outcome';
  END IF;
  IF NULLIF(_trimmed_reason, '') IS NULL OR char_length(_trimmed_reason) > 2000 THEN
    RAISE EXCEPTION 'Builder housekeeping reason must be 1 to 2000 characters';
  END IF;
  IF _details IS NULL OR jsonb_typeof(_details) <> 'object' THEN
    RAISE EXCEPTION 'Builder housekeeping details must be an object';
  END IF;

  SELECT * INTO _job
  FROM public.builder_jobs
  WHERE id = _job_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Builder job not found';
  END IF;
  IF _job.status IN ('deployed', 'failed', 'cancelled') THEN
    RETURN _job;
  END IF;
  IF _job.workspace_branch IS NOT NULL OR _job.workspace_pull_request_url IS NOT NULL THEN
    RAISE EXCEPTION 'Builder jobs with a workspace or pull request require explicit release handling';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.builder_model_runs
    WHERE job_id = _job.id AND status IN ('pending', 'running')
  ) OR EXISTS (
    SELECT 1 FROM public.builder_worker_runs
    WHERE job_id = _job.id AND status IN ('pending', 'running')
  ) THEN
    RAISE EXCEPTION 'Builder job still has active execution';
  END IF;
  IF _outcome = 'completed_autopilot' AND _job.autopilot_state IS DISTINCT FROM 'done' THEN
    RAISE EXCEPTION 'Builder job has not been recorded done';
  END IF;
  IF _outcome = 'superseded_main_health' AND _job.autopilot_source IS DISTINCT FROM 'main_monitor' THEN
    RAISE EXCEPTION 'Builder job is not a main-health repair';
  END IF;
  IF _outcome = 'inactive_orphan' AND (
    _job.autopilot_requested_by IS NOT NULL
    OR _job.autopilot_source IS NOT NULL
    OR _job.autopilot_state IS NOT NULL
    OR _job.updated_at > now() - interval '7 days'
    OR EXISTS (
      SELECT 1 FROM public.builder_approvals
      WHERE job_id = _job.id AND status = 'pending'
    )
  ) THEN
    RAISE EXCEPTION 'Builder job is not an inactive orphan';
  END IF;

  UPDATE public.builder_approvals
  SET status = 'cancelled',
      approval_comment = COALESCE(approval_comment, 'Cancelled because the Builder job was retired by audited housekeeping.'),
      responded_at = COALESCE(responded_at, now()),
      updated_at = now()
  WHERE job_id = _job.id
    AND status = 'pending';

  UPDATE public.builder_jobs
  SET status = 'cancelled',
      autopilot_state = CASE
        WHEN autopilot_requested_by IS NOT NULL OR autopilot_source IN ('main_monitor', 'routine_monitor') THEN 'done'
        ELSE autopilot_state
      END,
      autopilot_report = COALESCE(autopilot_report, '{}'::jsonb) || jsonb_build_object(
        'housekeeping',
        jsonb_build_object(
          'outcome', _outcome,
          'reason', _trimmed_reason,
          'details', _details,
          'retired_at', now()
        )
      ),
      last_error = 'Retired: ' || _trimmed_reason,
      updated_at = now()
  WHERE id = _job.id
  RETURNING * INTO _updated;

  INSERT INTO public.builder_audit_events (
    organization_id,
    job_id,
    event_type,
    actor_type,
    previous_value,
    new_value,
    change_summary
  ) VALUES (
    _job.organization_id,
    _job.id,
    'job_cancelled',
    'bot',
    jsonb_build_object('status', _job.status, 'autopilot_state', _job.autopilot_state),
    jsonb_build_object('status', 'cancelled', 'outcome', _outcome, 'details', _details),
    'Bob retired stale Builder work through the audited housekeeping policy: ' || _trimmed_reason
  );

  RETURN _updated;
END;
$function$;

REVOKE ALL ON FUNCTION public.builder_retire_stale_job(uuid, text, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.builder_retire_stale_job(uuid, text, text, jsonb)
  TO postgres, service_role;

CREATE OR REPLACE FUNCTION public.builder_cancel_terminal_approvals()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _count integer;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;

  UPDATE public.builder_approvals approval
  SET status = 'cancelled',
      approval_comment = COALESCE(approval.approval_comment, 'Cancelled because the Builder job is already terminal.'),
      responded_at = COALESCE(approval.responded_at, now()),
      updated_at = now()
  FROM public.builder_jobs job
  WHERE approval.job_id = job.id
    AND approval.status = 'pending'
    AND job.status IN ('deployed', 'failed', 'cancelled');

  GET DIAGNOSTICS _count = ROW_COUNT;
  RETURN _count;
END;
$function$;

REVOKE ALL ON FUNCTION public.builder_cancel_terminal_approvals()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.builder_cancel_terminal_approvals()
  TO postgres, service_role;
