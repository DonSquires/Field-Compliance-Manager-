-- Evidence-backed release preparation. Phase one stops at human approval.

CREATE OR REPLACE FUNCTION public.builder_start_release_preparation(
  _job_id uuid,
  _step_id uuid,
  _security_worker_run_id uuid
)
RETURNS public.builder_job_steps
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  _job public.builder_jobs%rowtype;
  _step public.builder_job_steps%rowtype;
  _security_run public.builder_worker_runs%rowtype;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  SELECT * INTO _job FROM public.builder_jobs WHERE id = _job_id FOR UPDATE;
  SELECT * INTO _step FROM public.builder_job_steps WHERE id = _step_id AND job_id = _job_id FOR UPDATE;
  SELECT * INTO _security_run FROM public.builder_worker_runs
  WHERE id = _security_worker_run_id AND job_id = _job_id AND profile = 'security-review';
  IF _job.id IS NULL OR _job.status <> 'security_review' THEN RAISE EXCEPTION 'Job is not ready for release preparation'; END IF;
    IF _step.id IS NULL OR _step.step_id <> 'release_prep' OR _step.builder_mode <> 'release_engineer'
      OR (_step.status <> 'pending' AND NOT (_step.status = 'failed' AND _step.retryable)) THEN
    RAISE EXCEPTION 'Release Engineer step is not pending';
  END IF;
  IF _security_run.id IS NULL OR _security_run.status <> 'completed'
     OR _security_run.organization_id IS DISTINCT FROM _job.organization_id
     OR _security_run.target_sha IS DISTINCT FROM _job.target_sha
     OR _security_run.review_summary->>'passed' <> 'true'
     OR COALESCE((_security_run.review_summary->>'critical')::integer, 0) <> 0
     OR COALESCE((_security_run.review_summary->>'high')::integer, 0) <> 0 THEN
    RAISE EXCEPTION 'A clean independent security review is required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.builder_job_steps
    WHERE job_id = _job.id AND step_id = 'security_review' AND status = 'completed'
      AND artifact_ids && _security_run.output_artifact_ids
  ) THEN RAISE EXCEPTION 'Security review step evidence is incomplete'; END IF;

  UPDATE public.builder_job_steps
  SET status = 'running', attempt_count = attempt_count + 1, started_at = now(), retryable = false,
      input_context = jsonb_build_object('security_worker_run_id', _security_run.id,
        'security_artifact_ids', _security_run.output_artifact_ids, 'target_sha', _job.target_sha), updated_at = now()
  WHERE id = _step.id RETURNING * INTO _step;
  UPDATE public.builder_jobs SET current_step_name = _step.step_id, current_step_index = _step.ordinal_position, updated_at = now()
  WHERE id = _job.id;
  INSERT INTO public.builder_audit_events (organization_id, job_id, event_type, actor_type, new_value, change_summary, related_artifact_ids)
  VALUES (_job.organization_id, _job.id, 'step_started', 'builder_mode',
    jsonb_build_object('step_id', _step.step_id, 'target_sha', _job.target_sha, 'security_worker_run_id', _security_run.id),
    'Release preparation started from clean security evidence', _security_run.output_artifact_ids);
  RETURN _step;
END;
$$;

CREATE OR REPLACE FUNCTION public.builder_register_release_artifact(
  _job_id uuid,
  _step_id uuid,
  _artifact_type text,
  _object_path text,
  _sha256 text,
  _size_bytes integer
)
RETURNS public.builder_artifacts
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _job public.builder_jobs%rowtype; _step public.builder_job_steps%rowtype; _artifact public.builder_artifacts%rowtype;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  IF _artifact_type NOT IN ('release_notes', 'rollback_plan', 'deployment_manifest') THEN RAISE EXCEPTION 'Unsupported release artifact type'; END IF;
  IF _object_path IS NULL OR _object_path = '' OR _object_path LIKE '%..%' THEN RAISE EXCEPTION 'Invalid release artifact path'; END IF;
  IF _sha256 !~ '^[a-f0-9]{64}$' OR _size_bytes < 0 OR _size_bytes > 10485760 THEN RAISE EXCEPTION 'Invalid release artifact integrity metadata'; END IF;
  SELECT * INTO _job FROM public.builder_jobs WHERE id = _job_id FOR UPDATE;
  SELECT * INTO _step FROM public.builder_job_steps WHERE id = _step_id AND job_id = _job_id FOR UPDATE;
  IF _job.id IS NULL OR _job.status <> 'security_review' OR _step.id IS NULL OR _step.status <> 'running' OR _step.builder_mode <> 'release_engineer' THEN
    RAISE EXCEPTION 'Release preparation is not running';
  END IF;
  INSERT INTO public.builder_artifacts (job_id, step_id, artifact_type, content_type, content_size_bytes, storage_location, checksum, status)
  VALUES (_job.id, _step.id, _artifact_type, 'application/json', _size_bytes,
    'supabase_storage://builder-artifacts/' || _object_path, _sha256, 'final') RETURNING * INTO _artifact;
  UPDATE public.builder_job_steps
  SET artifact_ids = CASE WHEN _artifact.id = ANY(COALESCE(artifact_ids, '{}')) THEN artifact_ids
    ELSE array_append(COALESCE(artifact_ids, '{}'), _artifact.id) END, updated_at = now()
  WHERE id = _step.id;
  INSERT INTO public.builder_audit_events (organization_id, job_id, event_type, actor_type, new_value, change_summary, related_artifact_ids)
  VALUES (_job.organization_id, _job.id, 'artifact_created', 'builder_mode',
    jsonb_build_object('artifact_type', _artifact_type, 'checksum', _sha256, 'target_sha', _job.target_sha),
    'Release preparation artifact registered', ARRAY[_artifact.id]);
  RETURN _artifact;
END;
$$;

CREATE OR REPLACE FUNCTION public.builder_complete_release_preparation(
  _job_id uuid,
  _step_id uuid,
  _release_notes_id uuid,
  _rollback_plan_id uuid,
  _deployment_manifest_id uuid,
  _reviewed_artifact_ids uuid[],
  _requested_from_users uuid[] DEFAULT '{}'
)
RETURNS public.builder_approvals
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _job public.builder_jobs%rowtype; _step public.builder_job_steps%rowtype; _approval public.builder_approvals%rowtype; _all_artifacts uuid[];
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  SELECT * INTO _job FROM public.builder_jobs WHERE id = _job_id FOR UPDATE;
  SELECT * INTO _step FROM public.builder_job_steps WHERE id = _step_id AND job_id = _job_id FOR UPDATE;
  IF _job.id IS NULL OR _job.status <> 'security_review' OR _step.id IS NULL OR _step.status <> 'running' OR _step.builder_mode <> 'release_engineer' THEN
    RAISE EXCEPTION 'Release preparation is not running';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.builder_artifacts WHERE id = _release_notes_id AND job_id = _job.id AND step_id = _step.id AND artifact_type = 'release_notes' AND status = 'final')
     OR NOT EXISTS (SELECT 1 FROM public.builder_artifacts WHERE id = _rollback_plan_id AND job_id = _job.id AND step_id = _step.id AND artifact_type = 'rollback_plan' AND status = 'final')
     OR NOT EXISTS (SELECT 1 FROM public.builder_artifacts WHERE id = _deployment_manifest_id AND job_id = _job.id AND step_id = _step.id AND artifact_type = 'deployment_manifest' AND status = 'final') THEN
    RAISE EXCEPTION 'Release notes, rollback plan, and deployment manifest are required';
  END IF;
  IF COALESCE(cardinality(_reviewed_artifact_ids), 0) = 0 OR (
    SELECT count(*) FROM public.builder_artifacts WHERE job_id = _job.id AND id = ANY(_reviewed_artifact_ids) AND status = 'final'
  ) <> cardinality(_reviewed_artifact_ids) THEN RAISE EXCEPTION 'Release evidence snapshot is invalid'; END IF;

  _all_artifacts := ARRAY[_release_notes_id, _rollback_plan_id, _deployment_manifest_id] || _reviewed_artifact_ids;
  UPDATE public.builder_job_steps SET status = 'completed', completed_at = now(),
    result_summary = 'Release package prepared for human approval', artifact_ids = _all_artifacts, updated_at = now()
  WHERE id = _step.id;
  UPDATE public.builder_jobs SET status = 'approval_pending', current_step_name = _step.step_id,
    current_step_index = _step.ordinal_position, updated_at = now() WHERE id = _job.id;
  INSERT INTO public.builder_audit_events (organization_id, job_id, event_type, actor_type, previous_value, new_value, change_summary, related_artifact_ids)
  VALUES (_job.organization_id, _job.id, 'step_completed', 'builder_mode',
    jsonb_build_object('job_status', 'security_review', 'step_status', 'running'),
    jsonb_build_object('job_status', 'approval_pending', 'step_status', 'completed', 'target_sha', _job.target_sha),
    'Release package prepared; production deployment remains disabled', _all_artifacts);
  SELECT * INTO _approval FROM public.builder_request_approval(
    _job.id, 'release_approval', _all_artifacts, COALESCE(_requested_from_users, '{}')
  );
  RETURN _approval;
END;
$$;

CREATE OR REPLACE FUNCTION public.builder_abort_release_preparation(
  _job_id uuid,
  _step_id uuid,
  _reason text
)
RETURNS public.builder_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _job public.builder_jobs%rowtype; _step public.builder_job_steps%rowtype;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  SELECT * INTO _job FROM public.builder_jobs WHERE id = _job_id FOR UPDATE;
  SELECT * INTO _step FROM public.builder_job_steps WHERE id = _step_id AND job_id = _job_id FOR UPDATE;
  IF _job.id IS NULL OR _job.status <> 'security_review' OR _step.id IS NULL OR _step.status <> 'running' OR _step.builder_mode <> 'release_engineer' THEN
    RAISE EXCEPTION 'Release preparation is not running';
  END IF;
  UPDATE public.builder_job_steps SET status = 'failed', retryable = true,
    error = left(COALESCE(_reason, 'Release preparation failed'), 1000), updated_at = now()
  WHERE id = _step.id;
  UPDATE public.builder_jobs SET last_error = left(COALESCE(_reason, 'Release preparation failed'), 1000), updated_at = now()
  WHERE id = _job.id RETURNING * INTO _job;
  INSERT INTO public.builder_audit_events (organization_id, job_id, event_type, actor_type, previous_value, new_value, change_summary)
  VALUES (_job.organization_id, _job.id, 'step_failed', 'builder_mode',
    jsonb_build_object('job_status', 'security_review', 'step_status', 'running'),
    jsonb_build_object('job_status', 'security_review', 'step_status', 'failed', 'retryable', true),
    'Release preparation failed and is retryable');
  RETURN _job;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.builder_start_release_preparation(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.builder_register_release_artifact(uuid,uuid,text,text,text,integer) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.builder_complete_release_preparation(uuid,uuid,uuid,uuid,uuid,uuid[],uuid[]) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.builder_abort_release_preparation(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.builder_start_release_preparation(uuid,uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_register_release_artifact(uuid,uuid,text,text,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_complete_release_preparation(uuid,uuid,uuid,uuid,uuid,uuid[],uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_abort_release_preparation(uuid,uuid,text) TO service_role;