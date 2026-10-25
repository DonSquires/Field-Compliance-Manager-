-- A Builder pull request that the owner closes without merging is a declined release. The job
-- must reach an audited terminal status (cancelled) instead of staying "release_ready" forever;
-- builder_retire_stale_job deliberately refuses jobs with a pull request, so this is the explicit
-- release-handling path for that case. Service identity only, and only for the job's own PR.
CREATE OR REPLACE FUNCTION public.builder_record_pull_request_closed(_job_id uuid, _pull_request_url text, _details jsonb DEFAULT '{}'::jsonb)
 RETURNS public.builder_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _job public.builder_jobs%rowtype;
  _updated public.builder_jobs%rowtype;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;
  IF NULLIF(btrim(_pull_request_url), '') IS NULL THEN
    RAISE EXCEPTION 'Pull request URL required';
  END IF;
  IF _details IS NULL OR jsonb_typeof(_details) <> 'object' THEN
    RAISE EXCEPTION 'Pull request closure details must be an object';
  END IF;

  SELECT * INTO _job FROM public.builder_jobs WHERE id = _job_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Builder job not found';
  END IF;
  IF _job.status IN ('deployed', 'failed', 'cancelled') THEN
    RETURN _job;
  END IF;
  IF _job.workspace_pull_request_url IS DISTINCT FROM btrim(_pull_request_url) THEN
    RAISE EXCEPTION 'Pull request does not belong to this Builder job';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.builder_model_runs WHERE job_id = _job.id AND status IN ('pending', 'running')
  ) OR EXISTS (
    SELECT 1 FROM public.builder_worker_runs WHERE job_id = _job.id AND status IN ('pending', 'running')
  ) THEN
    RAISE EXCEPTION 'Builder job still has active execution';
  END IF;

  UPDATE public.builder_approvals
  SET status = 'cancelled',
      approval_comment = COALESCE(approval_comment, 'Cancelled because the pull request was closed without merging.'),
      responded_at = COALESCE(responded_at, now()),
      updated_at = now()
  WHERE job_id = _job.id AND status = 'pending';

  UPDATE public.builder_jobs
  SET status = 'cancelled',
      last_error = 'Cancelled: pull request closed without merging',
      autopilot_state = CASE
        WHEN autopilot_requested_by IS NOT NULL OR autopilot_source IN ('main_monitor', 'routine_monitor') THEN 'done'
        ELSE autopilot_state
      END,
      updated_at = now()
  WHERE id = _job.id
  RETURNING * INTO _updated;

  INSERT INTO public.builder_audit_events (
    organization_id, job_id, event_type, actor_type, previous_value, new_value, change_summary
  ) VALUES (
    _job.organization_id, _job.id, 'job_cancelled', 'bot',
    jsonb_build_object('status', _job.status),
    jsonb_build_object('status', 'cancelled', 'reason', 'pull_request_closed_unmerged', 'pull_request_url', _job.workspace_pull_request_url) || _details,
    'Builder job cancelled because its pull request was closed without merging'
  );

  RETURN _updated;
END;
$function$;

REVOKE ALL ON FUNCTION public.builder_record_pull_request_closed(uuid, text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.builder_record_pull_request_closed(uuid, text, jsonb) TO postgres;
GRANT EXECUTE ON FUNCTION public.builder_record_pull_request_closed(uuid, text, jsonb) TO service_role;
