-- Both engineering lanes are available; the validated specification determines which needs work.
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
    IF _file IS NULL OR _file !~ '^apps/web/(src/[A-Za-z0-9_./-]+[.](test|spec)[.]tsx?|e2e/[A-Za-z0-9_./-]+[.]spec[.]ts)$'
       OR position('..' in _file) > 0 THEN
      RAISE EXCEPTION 'Main-health failure must name web unit or browser test files';
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
    'Bob opened a fullstack root-cause repair; unused lanes follow the validated specification and protected release gates remain'
  );
  RETURN _job;
END;
$function$;
REVOKE ALL ON FUNCTION public.builder_open_main_health_repair(uuid, uuid, text, text, text, text, text[], uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_open_main_health_repair(uuid, uuid, text, text, text, text, text[], uuid) TO service_role;
