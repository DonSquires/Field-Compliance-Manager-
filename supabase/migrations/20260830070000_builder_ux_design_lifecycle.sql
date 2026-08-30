-- Service-only UX Designer lifecycle after human specification approval.

CREATE OR REPLACE FUNCTION public.builder_start_ux_design(
  _job_id uuid,
  _step_id uuid,
  _specification_artifact_id uuid
)
RETURNS public.builder_job_steps
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _job public.builder_jobs%rowtype;
  _step public.builder_job_steps%rowtype;
  _specification public.builder_artifacts%rowtype;
  _previous_step_status text;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  SELECT * INTO _job FROM public.builder_jobs WHERE id = _job_id FOR UPDATE;
  SELECT * INTO _step FROM public.builder_job_steps WHERE id = _step_id AND job_id = _job_id FOR UPDATE;
  SELECT * INTO _specification FROM public.builder_artifacts WHERE id = _specification_artifact_id AND job_id = _job_id;

  IF _job.id IS NULL OR _job.status <> 'design_pending' THEN RAISE EXCEPTION 'Job is not ready for UX design'; END IF;
  IF _step.id IS NULL OR _step.builder_mode <> 'ux_designer' THEN RAISE EXCEPTION 'UX Designer step is missing'; END IF;
  IF _step.status <> 'pending' AND NOT (_step.status = 'failed' AND _step.retryable) THEN RAISE EXCEPTION 'UX Designer step cannot be started'; END IF;
  IF _specification.id IS NULL OR _specification.artifact_type <> 'product_specification' OR _specification.status <> 'final' THEN
    RAISE EXCEPTION 'Final product specification artifact is required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.builder_approvals
    WHERE job_id = _job.id AND approval_type = 'specification_review' AND status = 'approved'
      AND _specification.id = ANY(reviewed_artifact_ids)
  ) THEN RAISE EXCEPTION 'Product specification has not been approved'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.builder_job_steps
    WHERE job_id = _job.id AND builder_mode = 'product_analyst' AND status = 'completed'
      AND _specification.id = ANY(COALESCE(artifact_ids, '{}'))
  ) THEN RAISE EXCEPTION 'Product analysis dependency is incomplete'; END IF;

  _previous_step_status := _step.status;
  UPDATE public.builder_job_steps
  SET status='running', attempt_count=attempt_count+1, started_at=now(), completed_at=NULL,
      error=NULL, retryable=false, input_context=jsonb_build_object('specification_artifact_id', _specification.id), updated_at=now()
  WHERE id=_step.id RETURNING * INTO _step;
  UPDATE public.builder_jobs SET current_step_name=_step.step_id, current_step_index=_step.ordinal_position, updated_at=now() WHERE id=_job.id;
  INSERT INTO public.builder_audit_events (organization_id,job_id,event_type,actor_type,previous_value,new_value,change_summary,related_artifact_ids)
  VALUES (_job.organization_id,_job.id,'step_started','builder_mode',jsonb_build_object('job_status',_job.status,'step_status',_previous_step_status),jsonb_build_object('job_status','design_pending','step_status','running','step_id',_step.step_id),'UX Designer step started from approved specification',ARRAY[_specification.id]);
  RETURN _step;
END;
$$;

CREATE OR REPLACE FUNCTION public.builder_complete_ux_design(
  _job_id uuid,
  _step_id uuid,
  _artifact_id uuid,
  _result_summary text
)
RETURNS public.builder_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _job public.builder_jobs%rowtype;
  _step public.builder_job_steps%rowtype;
  _artifact public.builder_artifacts%rowtype;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  SELECT * INTO _job FROM public.builder_jobs WHERE id=_job_id FOR UPDATE;
  SELECT * INTO _step FROM public.builder_job_steps WHERE id=_step_id AND job_id=_job_id FOR UPDATE;
  SELECT * INTO _artifact FROM public.builder_artifacts WHERE id=_artifact_id AND job_id=_job_id;
  IF _job.id IS NULL OR _job.status <> 'design_pending' THEN RAISE EXCEPTION 'Job is not awaiting UX design completion'; END IF;
  IF _step.id IS NULL OR _step.builder_mode <> 'ux_designer' OR _step.status <> 'running' THEN RAISE EXCEPTION 'UX Designer step is not running'; END IF;
  IF _artifact.id IS NULL OR _artifact.step_id IS DISTINCT FROM _step.id OR _artifact.artifact_type <> 'ui_design_plan' OR _artifact.status <> 'final' THEN
    RAISE EXCEPTION 'A final UX design plan artifact is required';
  END IF;

  UPDATE public.builder_job_steps
  SET status='completed', completed_at=now(), result_summary=left(COALESCE(_result_summary,''),1000),
      artifact_ids=CASE WHEN _artifact.id=ANY(COALESCE(artifact_ids,'{}')) THEN artifact_ids ELSE array_append(COALESCE(artifact_ids,'{}'),_artifact.id) END,
      updated_at=now()
  WHERE id=_step.id;
  UPDATE public.builder_jobs
  SET status='implementation_pending', current_step_name=_step.step_id, current_step_index=_step.ordinal_position, updated_at=now()
  WHERE id=_job.id RETURNING * INTO _job;
  INSERT INTO public.builder_audit_events (organization_id,job_id,event_type,actor_type,previous_value,new_value,change_summary,related_artifact_ids)
  VALUES (_job.organization_id,_job.id,'step_completed','builder_mode',jsonb_build_object('job_status','design_pending','step_status','running'),jsonb_build_object('job_status','implementation_pending','step_status','completed','step_id',_step.step_id),'UX Designer completed a validated design plan',ARRAY[_artifact.id]);
  RETURN _job;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.builder_start_ux_design(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.builder_start_ux_design(uuid,uuid,uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.builder_complete_ux_design(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.builder_complete_ux_design(uuid,uuid,uuid,text) TO service_role;