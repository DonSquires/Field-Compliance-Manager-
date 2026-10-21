-- Root failures are first-class repair evidence. Publication gates remain unchanged.
CREATE OR REPLACE FUNCTION public.builder_main_health_test_path_valid(_file text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    position('..' in _file) = 0 AND _file ~
    '^(test/[A-Za-z0-9_.-]+[.]test[.][cm]?js|apps/web/(src/[A-Za-z0-9_./-]+[.](test|spec)[.]tsx?|e2e/[A-Za-z0-9_./-]+[.]spec[.]ts))$',
    false
  );
$function$;
REVOKE ALL ON FUNCTION public.builder_main_health_test_path_valid(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_main_health_test_path_valid(text) TO service_role;

CREATE OR REPLACE FUNCTION public.builder_open_main_health_repair(
  _organization_id uuid, _project_id uuid, _health_sha text, _target_sha text,
  _title text, _task_description text, _failed_files text[], _parent_job_id uuid DEFAULT NULL
)
RETURNS public.builder_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _job public.builder_jobs%rowtype;
  _file text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;
  IF _health_sha IS NULL OR _target_sha IS NULL
     OR _health_sha !~ '^[a-f0-9]{40}$' OR _target_sha !~ '^[a-f0-9]{40}$' THEN
    RAISE EXCEPTION 'Main-health commits must be full Git SHAs';
  END IF;
  IF _title IS NULL OR length(btrim(_title)) = 0 OR length(_title) > 200
     OR _task_description IS NULL OR length(_task_description) = 0 OR length(_task_description) > 12000 THEN
    RAISE EXCEPTION 'Main-health repair brief is invalid';
  END IF;
  IF COALESCE(cardinality(_failed_files), 0) < 1 OR cardinality(_failed_files) > 8 THEN
    RAISE EXCEPTION 'Main-health repair requires one to eight failing test files';
  END IF;
  FOREACH _file IN ARRAY _failed_files LOOP
    IF NOT public.builder_main_health_test_path_valid(_file) THEN
      RAISE EXCEPTION 'Main-health failure must name root, web unit or browser test files';
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM public.builder_projects
    WHERE id = _project_id AND organization_id = _organization_id AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'Active Builder project is unavailable';
  END IF;
  IF _parent_job_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.builder_jobs
    WHERE id = _parent_job_id AND project_id = _project_id AND organization_id = _organization_id
  ) THEN
    RAISE EXCEPTION 'Main-health repair parent must belong to the same project and organization';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('main-health:' || _project_id::text || ':' || COALESCE(_parent_job_id::text, 'root'), 0));
  SELECT * INTO _job FROM public.builder_jobs
  WHERE organization_id = _organization_id AND project_id = _project_id
    AND autopilot_source = 'main_monitor'
    AND source_main_health_sha = _health_sha
    AND parent_job_id IS NOT DISTINCT FROM _parent_job_id
    AND status NOT IN ('failed', 'cancelled')
  ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF FOUND THEN RETURN _job; END IF;
  IF _parent_job_id IS NULL THEN
    SELECT * INTO _job FROM public.builder_jobs
    WHERE organization_id = _organization_id AND project_id = _project_id
      AND autopilot_source = 'main_monitor' AND parent_job_id IS NULL
      AND source_main_health_files @> _failed_files AND source_main_health_files <@ _failed_files
      AND status NOT IN ('failed', 'cancelled', 'deployed')
    ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
    IF FOUND THEN RETURN _job; END IF;
  END IF;
  SELECT * INTO _job FROM public.builder_create_job_v2(
    _organization_id, _project_id, _title, _task_description, _target_sha, 'main',
    'Opened automatically by Bob after isolated main-health verification failed.',
    true, true, 'independent_ai', NULL, 'prepare_change', 'development'
  );
  UPDATE public.builder_jobs
  SET parent_job_id = _parent_job_id, autopilot_source = 'main_monitor', repair_risk = 'routine',
      source_main_health_sha = _health_sha, source_main_health_files = _failed_files,
      autopilot_state = 'driving', autopilot_updated_at = now(), updated_at = now()
  WHERE id = _job.id RETURNING * INTO _job;
  INSERT INTO public.builder_audit_events (
    organization_id, job_id, event_type, actor_type, new_value, change_summary
  ) VALUES (
    _job.organization_id, _job.id, 'builder_job_policy_bound', 'bot',
    jsonb_build_object('autopilot_source', 'main_monitor', 'health_sha', _health_sha,
      'target_sha', _target_sha, 'repair_risk', 'routine', 'failed_files', _failed_files,
      'frontend_required', true, 'backend_required', true),
    'Bob opened a root/web root-cause repair; protected release gates remain unchanged'
  );
  RETURN _job;
END;
$function$;
REVOKE ALL ON FUNCTION public.builder_open_main_health_repair(uuid, uuid, text, text, text, text, text[], uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_open_main_health_repair(uuid, uuid, text, text, text, text, text[], uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.builder_autopilot_decide_approval_guarded(_approval_id uuid, _comment text DEFAULT NULL)
RETURNS public.builder_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _approval public.builder_approvals%rowtype;
  _job public.builder_jobs%rowtype;
  _packet public.bob_friction_packets%rowtype;
  _actor uuid;
  _next_status text;
  _source text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  SELECT * INTO _approval FROM public.builder_approvals WHERE id = _approval_id FOR UPDATE;
  IF NOT FOUND OR _approval.status <> 'pending' THEN RAISE EXCEPTION 'Approval is missing or already decided'; END IF;
  SELECT * INTO _job FROM public.builder_jobs WHERE id = _approval.job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Builder job is unavailable'; END IF;
  IF _job.autopilot_source = 'main_monitor' THEN
    IF _job.repair_risk <> 'routine'
       OR _job.source_main_health_sha IS NULL
       OR _job.source_main_health_sha !~ '^[a-f0-9]{40}$'
       OR COALESCE(cardinality(_job.source_main_health_files), 0) < 1
       OR cardinality(_job.source_main_health_files) > 8
       OR EXISTS (
         SELECT 1 FROM unnest(_job.source_main_health_files) AS file_name
         WHERE NOT public.builder_main_health_test_path_valid(file_name)
       ) THEN
      RAISE EXCEPTION 'Main-health repair authorization is no longer valid';
    END IF;
    _actor := NULL;
    _source := 'main_monitor';
  ELSIF _job.autopilot_source = 'routine_monitor' THEN
    SELECT * INTO _packet FROM public.bob_friction_packets WHERE id = _job.source_friction_packet_id;
    IF NOT FOUND OR _packet.repair_risk <> 'routine'
       OR _packet.route <> 'dispatch_flow' OR _packet.stop_line_hit IS NOT NULL THEN
      RAISE EXCEPTION 'Routine repair authorization is no longer valid';
    END IF;
    _actor := _packet.user_id;
    _source := 'routine_monitor';
  ELSE
    RETURN public.builder_autopilot_decide_approval(_approval_id, _comment);
  END IF;
  IF _approval.expires_at <= now() THEN RAISE EXCEPTION 'Approval has expired and requires a new evidence review'; END IF;
  IF _job.status <> _approval.triggered_at_status THEN RAISE EXCEPTION 'Job has moved beyond this approval gate'; END IF;
  IF _approval.requested_target_sha IS DISTINCT FROM _job.target_sha THEN RAISE EXCEPTION 'Job target changed after approval was requested'; END IF;
  IF (SELECT count(*) FROM public.builder_artifacts WHERE job_id = _job.id AND id = ANY(_approval.reviewed_artifact_ids) AND status = 'final') <> cardinality(_approval.reviewed_artifact_ids) THEN
    RAISE EXCEPTION 'Reviewed evidence is no longer valid';
  END IF;
  IF _approval.approval_type = 'specification_review' AND _approval.triggered_at_status = 'specification_ready' THEN
    _next_status := 'design_pending';
  ELSIF _approval.approval_type = 'release_approval' AND _approval.triggered_at_status = 'approval_pending' THEN
    _next_status := 'release_ready';
  ELSE
    RAISE EXCEPTION 'Approval gate cannot transition this job';
  END IF;
  UPDATE public.builder_approvals
  SET status = 'approved', approved_by = _actor, decided_by = _actor,
      approval_comment = left(COALESCE(NULLIF(btrim(_comment), ''), 'Cleared by Bob after bounded automated verification'), 2000),
      responded_at = now(), updated_at = now()
  WHERE id = _approval.id;
  UPDATE public.builder_jobs
  SET status = _next_status, last_error = NULL, autopilot_updated_at = now(), updated_at = now()
  WHERE id = _job.id RETURNING * INTO _job;
  INSERT INTO public.builder_audit_events (
    organization_id, job_id, event_type, actor_user_id, actor_type,
    previous_value, new_value, change_summary, related_artifact_ids, related_approval_id
  ) VALUES (
    _approval.organization_id, _approval.job_id, 'approval_approved', _actor, 'bot',
    jsonb_build_object('status', _approval.triggered_at_status),
    jsonb_build_object('status', _next_status, 'decision', 'approved', 'source', _source),
    CASE WHEN _source = 'main_monitor'
      THEN 'Bob cleared a bounded main-health repair gate; the verified draft remains subject to the protected release policy'
      ELSE 'Bob cleared a routine-repair gate after deterministic risk classification; protected scope remains held for Grandmaster review'
    END,
    _approval.reviewed_artifact_ids, _approval.id
  );
  RETURN _job;
END;
$function$;
REVOKE ALL ON FUNCTION public.builder_autopilot_decide_approval_guarded(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_autopilot_decide_approval_guarded(uuid, text) TO service_role;

COMMENT ON COLUMN public.builder_jobs.source_main_health_files IS
  'Pinned root node:test, web unit or browser failure paths. Protected and evidential release gates remain unchanged.';
