-- Advance an approved backend-only job past its intentionally skipped UX step.

CREATE OR REPLACE FUNCTION public.builder_continue_backend_only_job(_job_id uuid)
RETURNS public.builder_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
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
  VALUES (_job.organization_id, _job.id, 'status_changed', 'builder_mode',
    jsonb_build_object('job_status', 'design_pending', 'step_status', 'skipped'),
    jsonb_build_object('job_status', 'implementation_pending', 'frontend_required', false, 'backend_required', true),
    'Backend-only job advanced past intentionally skipped UX design');
  RETURN _job;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.builder_continue_backend_only_job(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.builder_continue_backend_only_job(uuid) TO service_role;