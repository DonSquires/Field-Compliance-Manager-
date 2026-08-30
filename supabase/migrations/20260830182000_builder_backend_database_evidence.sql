-- Backend completion records verified disposable database evidence when required.
-- Production migration execution remains outside the Builder authority boundary.

CREATE OR REPLACE FUNCTION public.builder_finish_backend_worker(
  _run_id uuid, _lease_token text, _succeeded boolean, _exit_code integer, _log_summary text DEFAULT NULL
)
RETURNS public.builder_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _run public.builder_worker_runs%rowtype; _job public.builder_jobs%rowtype; _next_status text; _event_type text;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  SELECT * INTO _run FROM public.builder_worker_runs WHERE id = _run_id AND profile = 'backend-verify' AND status = 'running'
    AND lease_expires_at > now() AND lease_token_hash = encode(extensions.digest(_lease_token, 'sha256'), 'hex') FOR UPDATE;
  IF _run.id IS NULL THEN RAISE EXCEPTION 'Backend worker lease is missing, expired, or invalid'; END IF;
  SELECT * INTO _job FROM public.builder_jobs WHERE id = _run.job_id FOR UPDATE;
  IF _job.target_sha IS DISTINCT FROM _run.target_sha THEN RAISE EXCEPTION 'Job target changed during worker execution'; END IF;
  IF _succeeded AND NOT (
    EXISTS (SELECT 1 FROM public.builder_artifacts WHERE id = ANY(_run.output_artifact_ids) AND job_id = _run.job_id AND artifact_type = 'code_implementation' AND status = 'final')
    AND EXISTS (SELECT 1 FROM public.builder_artifacts WHERE id = ANY(_run.output_artifact_ids) AND job_id = _run.job_id AND artifact_type = 'changed_file_manifest' AND status = 'final')
    AND EXISTS (SELECT 1 FROM public.builder_artifacts WHERE id = ANY(_run.output_artifact_ids) AND job_id = _run.job_id AND artifact_type = 'build_logs' AND status = 'final')
  ) THEN RAISE EXCEPTION 'Successful backend completion requires patch, manifest, and verification logs'; END IF;

  _next_status := CASE
    WHEN NOT _succeeded THEN 'implementation_pending'
    WHEN EXISTS (SELECT 1 FROM public.builder_job_steps WHERE job_id = _run.job_id AND builder_mode = 'frontend_engineer' AND status IN ('completed', 'skipped')) THEN 'testing'
    ELSE 'implementation_pending'
  END;
  _event_type := CASE WHEN _succeeded THEN 'step_completed' ELSE 'step_failed' END;
  UPDATE public.builder_worker_runs SET status = CASE WHEN _succeeded THEN 'completed' ELSE 'failed' END,
    completed_at = now(), exit_code = _exit_code, log_summary = left(COALESCE(_log_summary, ''), 1000),
    lease_token_hash = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = _run.id;
  UPDATE public.builder_job_steps SET status = CASE WHEN _succeeded THEN 'completed' ELSE 'failed' END,
    completed_at = now(), retryable = NOT _succeeded,
    error = CASE WHEN _succeeded THEN NULL ELSE 'Backend worker verification failed' END,
    artifact_ids = CASE WHEN _succeeded THEN COALESCE(_run.output_artifact_ids, '{}') ELSE artifact_ids END,
    result_summary = CASE WHEN _succeeded THEN 'Backend verification passed; disposable migration evidence registered when required' ELSE result_summary END,
    updated_at = now() WHERE id = _run.step_id;
  UPDATE public.builder_jobs SET status = _next_status,
    last_error = CASE WHEN _succeeded THEN NULL ELSE 'Backend worker verification failed' END,
    updated_at = now() WHERE id = _run.job_id RETURNING * INTO _job;
  INSERT INTO public.builder_audit_events (organization_id, job_id, event_type, actor_type, previous_value, new_value, change_summary, related_artifact_ids)
  VALUES (_run.organization_id, _run.job_id, _event_type, 'builder_mode',
    jsonb_build_object('job_status', 'building', 'step_status', 'running'),
    jsonb_build_object('job_status', _next_status, 'step_status', CASE WHEN _succeeded THEN 'completed' ELSE 'failed' END,
      'worker_run_id', _run.id, 'exit_code', _exit_code, 'verification_scope', 'backend_patch',
      'disposable_migration_evidence', CASE WHEN _succeeded THEN 'registered_or_not_required' ELSE 'failed' END,
      'production_execution', false),
    CASE WHEN _succeeded THEN 'Backend verification completed with disposable database evidence when required; production execution was not performed'
      ELSE 'Backend verification failed and is retryable' END,
    COALESCE(_run.output_artifact_ids, '{}'));
  RETURN _job;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.builder_finish_backend_worker(uuid,text,boolean,integer,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.builder_finish_backend_worker(uuid,text,boolean,integer,text) TO service_role;