-- Two Builder RPCs emit builder_audit_events.event_type values the check
-- constraint never allowed, so the transactions roll back and the control room
-- reports a generic 409:
--   * builder_create_job_v2 -> 'builder_job_policy_bound' (every Builder job
--     created through bob-builder-control-room since 2026-09-01 failed here)
--   * builder_continue_backend_only_job -> 'status_changed' (backend-only jobs
--     could never advance past the skipped UX step)
-- Found by Bob's self-heal end-to-end run (2026-09-26). The policy-binding
-- event is a distinct, meaningful record, so it is admitted; the backend-only
-- transition is a job status change, so it uses the existing canonical type.

ALTER TABLE public.builder_audit_events
  DROP CONSTRAINT IF EXISTS builder_audit_events_event_type_check;
ALTER TABLE public.builder_audit_events
  ADD CONSTRAINT builder_audit_events_event_type_check CHECK (
    event_type IN (
      'job_created', 'job_status_changed', 'step_started', 'step_completed',
      'step_failed', 'step_blocked', 'artifact_created', 'approval_requested',
      'approval_approved', 'approval_rejected', 'model_run_started',
      'model_run_completed', 'model_run_failed', 'error_recorded',
      'job_cancelled', 'builder_job_policy_bound'
    )
  );

CREATE OR REPLACE FUNCTION "public"."builder_continue_backend_only_job"(_job_id uuid)
 RETURNS builder_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _job public.builder_jobs%rowtype; _ux_step public.builder_job_steps%rowtype;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  SELECT * INTO _job FROM public.builder_jobs WHERE id = _job_id FOR UPDATE;
  SELECT * INTO _ux_step FROM public.builder_job_steps WHERE job_id = _job_id AND step_id = 'ui_design' FOR UPDATE;
  IF _job.id IS NULL OR _job.status <> 'design_pending' OR _job.frontend_required OR NOT _job.backend_required THEN
    RAISE EXCEPTION 'Job is not an approved backend-only build';
  END IF;
  IF _ux_step.id IS NULL OR _ux_step.status <> 'skipped' THEN RAISE EXCEPTION 'UX step was not intentionally skipped'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.builder_approvals WHERE job_id = _job.id
    AND approval_type = 'specification_review' AND status = 'approved'
    AND requested_target_sha = _job.target_sha) THEN RAISE EXCEPTION 'Approved specification evidence is required'; END IF;
  UPDATE public.builder_jobs SET status = 'implementation_pending', current_step_name = _ux_step.step_id,
    current_step_index = _ux_step.ordinal_position, updated_at = now() WHERE id = _job.id RETURNING * INTO _job;
  INSERT INTO public.builder_audit_events (organization_id, job_id, event_type, actor_type, previous_value, new_value, change_summary)
  VALUES (_job.organization_id, _job.id, 'job_status_changed', 'builder_mode',
    jsonb_build_object('job_status', 'design_pending', 'step_status', 'skipped'),
    jsonb_build_object('job_status', 'implementation_pending', 'frontend_required', false, 'backend_required', true),
    'Backend-only job advanced past intentionally skipped UX design');
  RETURN _job;
END;
$function$;
