CREATE OR REPLACE FUNCTION public.builder_resolve_historical_health_job(
  _job_id uuid, _organization_id uuid, _project_id uuid,
  _main_sha text, _source_sha text, _verified_files text[], _verification jsonb
)
RETURNS public.builder_jobs
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _job public.builder_jobs%rowtype;
  _updated public.builder_jobs%rowtype;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  IF _main_sha IS NULL OR _main_sha !~ '^[a-f0-9]{40}$'
     OR _source_sha IS NULL OR _source_sha !~ '^[a-f0-9]{40}$' OR _main_sha = _source_sha
     OR _verification IS NULL
     OR _verification->>'status' IS DISTINCT FROM 'passed'
     OR _verification->>'profile' IS DISTINCT FROM 'main-health'
     OR _verification->>'sha' IS DISTINCT FROM _main_sha
     OR NULLIF(_verification->>'checked_at', '') IS NULL THEN
    RAISE EXCEPTION 'A passed pinned main-health receipt is required';
  END IF;
  SELECT * INTO _job FROM public.builder_jobs
  WHERE id = _job_id AND organization_id = _organization_id AND project_id = _project_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Historical job is unavailable in this project'; END IF;
  IF _job.status NOT IN ('failed', 'cancelled')
     OR _job.autopilot_source IS DISTINCT FROM 'main_monitor'
     OR _job.source_main_health_sha IS DISTINCT FROM _source_sha
     OR _job.workspace_branch IS NOT NULL OR _job.workspace_pull_request_url IS NOT NULL THEN
    RAISE EXCEPTION 'Only workspace-free failed or cancelled main-health jobs can be resolved';
  END IF;
  IF _job.autopilot_state = 'done' THEN RETURN _job; END IF;
  IF COALESCE(cardinality(_job.source_main_health_files), 0) NOT BETWEEN 1 AND 8
     OR _verified_files IS NULL OR NOT (_verified_files @> _job.source_main_health_files)
     OR EXISTS (
       SELECT 1 FROM unnest(_job.source_main_health_files) AS file_name
       WHERE NOT public.builder_main_health_test_path_valid(file_name)
     ) THEN
    RAISE EXCEPTION 'Every original failing test must be covered by the current verification';
  END IF;
  IF EXISTS (SELECT 1 FROM public.builder_model_runs WHERE job_id = _job.id AND status IN ('pending', 'queued', 'running'))
     OR EXISTS (SELECT 1 FROM public.builder_worker_runs WHERE job_id = _job.id AND status IN ('pending', 'queued', 'running')) THEN
    RAISE EXCEPTION 'Historical job still has active execution';
  END IF;
  UPDATE public.builder_jobs
  SET autopilot_state = 'done',
      autopilot_report = COALESCE(autopilot_report, '{}'::jsonb) || jsonb_build_object(
        'historical_resolution', jsonb_build_object(
          'outcome', 'resolved_historical_main_health', 'verification', _verification,
          'source_sha', _source_sha, 'failed_files', source_main_health_files, 'resolved_at', now()
        )
      ),
      autopilot_updated_at = now(), updated_at = now()
  WHERE id = _job.id RETURNING * INTO _updated;
  INSERT INTO public.builder_audit_events (
    organization_id, job_id, event_type, actor_type, previous_value, new_value, change_summary
  ) VALUES (
    _job.organization_id, _job.id, 'builder_job_policy_bound', 'bot',
    jsonb_build_object('status', _job.status, 'autopilot_state', _job.autopilot_state),
    jsonb_build_object('status', _updated.status, 'autopilot_state', 'done',
      'outcome', 'resolved_historical_main_health', 'verification', _verification),
    'A newer main passed every health step; historical failure/cancellation and release receipts were preserved'
  );
  RETURN _updated;
END;
$function$;
REVOKE ALL ON FUNCTION public.builder_resolve_historical_health_job(uuid,uuid,uuid,text,text,text[],jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_resolve_historical_health_job(uuid,uuid,uuid,text,text,text[],jsonb) TO service_role;
