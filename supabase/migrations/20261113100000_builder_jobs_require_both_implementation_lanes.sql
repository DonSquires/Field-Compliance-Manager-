-- New Builder jobs always include both implementation specialists.
-- Keep the scope arguments for older callers, but do not let them skip a lane.
CREATE OR REPLACE FUNCTION public.builder_create_job(
  _organization_id uuid,
  _project_id uuid,
  _title text,
  _task_description text,
  _target_sha text,
  _branch_name text DEFAULT 'main',
  _description text DEFAULT NULL,
  _frontend_required boolean DEFAULT true,
  _backend_required boolean DEFAULT false,
  _code_review_mode text DEFAULT 'none',
  _task_run_id uuid DEFAULT NULL
)
RETURNS public.builder_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _project public.builder_projects%rowtype; _job public.builder_jobs%rowtype;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  IF NULLIF(btrim(_title), '') IS NULL OR NULLIF(btrim(_task_description), '') IS NULL THEN RAISE EXCEPTION 'Title and task description are required'; END IF;
  IF _target_sha !~ '^[a-f0-9]{40}$' THEN RAISE EXCEPTION 'A full lowercase Git target SHA is required'; END IF;
  IF _code_review_mode NOT IN ('none', 'human', 'independent_ai') THEN RAISE EXCEPTION 'Unsupported code review mode'; END IF;
  SELECT * INTO _project FROM public.builder_projects WHERE id = _project_id AND organization_id = _organization_id AND status = 'active' FOR UPDATE;
  IF _project.id IS NULL THEN RAISE EXCEPTION 'Active Builder project is unavailable'; END IF;

  INSERT INTO public.builder_jobs (
    organization_id, project_id, task_run_id, title, description, task_description,
    status, current_step_index, total_steps, branch_name, target_sha, approval_required_at,
    frontend_required, backend_required, code_review_mode, code_review_status
  ) VALUES (
    _organization_id, _project_id, _task_run_id, btrim(_title), NULLIF(btrim(_description), ''), btrim(_task_description),
    'intake', 0, 8, COALESCE(NULLIF(btrim(_branch_name), ''), 'main'), _target_sha,
    ARRAY['specification_ready','approval_pending'], true, true,
    _code_review_mode, CASE WHEN _code_review_mode = 'none' THEN 'not_required' ELSE 'pending' END
  ) RETURNING * INTO _job;

  INSERT INTO public.builder_job_steps (job_id, step_id, ordinal_position, builder_mode, status, blocked_dependencies, result_summary)
  VALUES
    (_job.id, 'product_analysis', 1, 'product_analyst', 'pending', '{}', NULL),
    (_job.id, 'ui_design', 2, 'ux_designer', 'pending', ARRAY['product_analysis'], NULL),
    (_job.id, 'frontend_implementation', 3, 'frontend_engineer', 'pending', ARRAY['ui_design'], NULL),
    (_job.id, 'backend_implementation', 4, 'backend_engineer', 'pending', ARRAY['product_analysis'], NULL),
    (_job.id, 'test_suite', 5, 'qa_security_reviewer', 'pending', ARRAY['frontend_implementation','backend_implementation'], NULL),
    (_job.id, 'security_review', 6, 'qa_security_reviewer', 'pending', ARRAY['test_suite'], NULL),
    (_job.id, 'code_review', 7, 'code_reviewer', 'pending', ARRAY['security_review'], NULL),
    (_job.id, 'release_prep', 8, 'release_engineer', 'pending', ARRAY['code_review'], NULL);

  INSERT INTO public.builder_audit_events (organization_id, job_id, event_type, actor_type, new_value, change_summary)
  VALUES (_job.organization_id, _job.id, 'job_created', 'bot',
    jsonb_build_object('target_sha', _job.target_sha, 'frontend_required', true,
      'backend_required', true, 'code_review_mode', _code_review_mode),
    'Builder job created with both implementation specialists and immutable repository target');
  RETURN _job;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.builder_create_job(uuid,uuid,text,text,text,text,text,boolean,boolean,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.builder_create_job(uuid,uuid,text,text,text,text,text,boolean,boolean,text,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.builder_create_followup_job(
  _parent_job_id uuid,
  _title text,
  _task_description text,
  _frontend_required boolean DEFAULT true,
  _backend_required boolean DEFAULT false,
  _code_review_mode text DEFAULT 'none'
)
RETURNS public.builder_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _parent public.builder_jobs%rowtype; _job public.builder_jobs%rowtype;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  SELECT * INTO _parent FROM public.builder_jobs WHERE id = _parent_job_id FOR UPDATE;
  IF _parent.id IS NULL OR _parent.workspace_branch IS NULL OR _parent.workspace_head_sha IS NULL THEN RAISE EXCEPTION 'A verified Builder workspace is required for a follow-up iteration'; END IF;
  IF NULLIF(btrim(_title), '') IS NULL OR NULLIF(btrim(_task_description), '') IS NULL THEN RAISE EXCEPTION 'Title and task description are required'; END IF;
  IF _code_review_mode NOT IN ('none', 'human', 'independent_ai') THEN RAISE EXCEPTION 'Unsupported code review mode'; END IF;

  INSERT INTO public.builder_jobs (organization_id, project_id, parent_job_id, title, task_description, status, current_step_index, total_steps, branch_name, target_sha, workspace_branch, workspace_head_sha, workspace_created_at, approval_required_at, frontend_required, backend_required, code_review_mode, code_review_status)
  VALUES (_parent.organization_id, _parent.project_id, _parent.id, btrim(_title), btrim(_task_description), 'intake', 0, 8, _parent.workspace_branch, _parent.workspace_head_sha, _parent.workspace_branch, _parent.workspace_head_sha, _parent.workspace_created_at, ARRAY['specification_ready','approval_pending'], true, true, _code_review_mode, CASE WHEN _code_review_mode = 'none' THEN 'not_required' ELSE 'pending' END)
  RETURNING * INTO _job;

  INSERT INTO public.builder_job_steps (job_id, step_id, ordinal_position, builder_mode, status, blocked_dependencies, result_summary)
  VALUES
    (_job.id, 'product_analysis', 1, 'product_analyst', 'pending', '{}', NULL),
    (_job.id, 'ui_design', 2, 'ux_designer', 'pending', ARRAY['product_analysis'], NULL),
    (_job.id, 'frontend_implementation', 3, 'frontend_engineer', 'pending', ARRAY['ui_design'], NULL),
    (_job.id, 'backend_implementation', 4, 'backend_engineer', 'pending', ARRAY['product_analysis'], NULL),
    (_job.id, 'test_suite', 5, 'qa_security_reviewer', 'pending', ARRAY['frontend_implementation','backend_implementation'], NULL),
    (_job.id, 'security_review', 6, 'qa_security_reviewer', 'pending', ARRAY['test_suite'], NULL),
    (_job.id, 'code_review', 7, 'code_reviewer', 'pending', ARRAY['security_review'], NULL),
    (_job.id, 'release_prep', 8, 'release_engineer', 'pending', ARRAY['code_review'], NULL);

  INSERT INTO public.builder_audit_events (organization_id, job_id, event_type, actor_type, new_value, change_summary)
  VALUES (_job.organization_id, _job.id, 'job_created', 'user',
    jsonb_build_object('parent_job_id', _parent.id, 'workspace_branch', _job.workspace_branch,
      'target_sha', _job.target_sha, 'frontend_required', true, 'backend_required', true),
    'Builder follow-up iteration created with both implementation specialists from a verified workspace commit');
  RETURN _job;
END;
$$;

REVOKE ALL ON FUNCTION public.builder_create_followup_job(uuid,text,text,boolean,boolean,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.builder_create_followup_job(uuid,text,text,boolean,boolean,text) TO service_role;

CREATE OR REPLACE FUNCTION public.builder_create_autopilot_child(
  _parent_job_id uuid,
  _target_sha text,
  _title text,
  _task_description text,
  _description text DEFAULT NULL,
  _frontend_required boolean DEFAULT true,
  _backend_required boolean DEFAULT false,
  _code_review_mode text DEFAULT 'independent_ai'
)
RETURNS public.builder_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _parent public.builder_jobs; _child public.builder_jobs; _child_description text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  SELECT * INTO _parent FROM public.builder_jobs WHERE id = _parent_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Parent Builder job is unavailable'; END IF;
  IF _parent.status IN ('cancelled', 'deployed') THEN RAISE EXCEPTION 'Parent Builder job cannot be continued'; END IF;
  IF _parent.autopilot_source = 'main_monitor' THEN RAISE EXCEPTION 'Main-health repairs require the main-health repair path'; END IF;
  IF _parent.autopilot_requested_by IS NULL
     OR NOT public.can_approve_action(_parent.autopilot_requested_by, _parent.organization_id) THEN
    RAISE EXCEPTION 'Parent autopilot requester cannot approve Builder work for this organisation';
  END IF;
  IF NULLIF(btrim(_title), '') IS NULL OR NULLIF(btrim(_task_description), '') IS NULL THEN
    RAISE EXCEPTION 'Title and task description are required';
  END IF;
  IF _target_sha IS NULL OR _target_sha !~ '^[a-f0-9]{40}$' THEN
    RAISE EXCEPTION 'A full lowercase Git target SHA is required';
  END IF;
  IF _parent.code_review_mode = 'human' AND _code_review_mode IS DISTINCT FROM 'human'
     OR _parent.code_review_mode = 'independent_ai' AND _code_review_mode = 'none' THEN
    RAISE EXCEPTION 'Parent code-review policy cannot be weakened';
  END IF;
  _child_description := COALESCE(NULLIF(btrim(_description), ''), 'Opened by Bob''s autopilot from job ' || _parent.id || '.');

  SELECT * INTO _child FROM public.builder_jobs
  WHERE parent_job_id = _parent.id
    AND title = btrim(_title)
    AND task_description = btrim(_task_description)
    AND description = _child_description
    AND code_review_mode = _code_review_mode
  ORDER BY created_at LIMIT 1;
  IF FOUND THEN RETURN _child; END IF;

  SELECT * INTO _child FROM public.builder_create_job_v2(
    _parent.organization_id, _parent.project_id, _title, _task_description,
    _target_sha, 'main', _child_description, true, true,
    _code_review_mode, _parent.task_run_id, _parent.requested_action, _parent.target_environment
  );
  PERFORM public.builder_autopilot_bind(
    _child.id, _parent.autopilot_requested_by, _parent.autopilot_conversation_id
  );
  UPDATE public.builder_jobs
  SET parent_job_id = _parent.id,
      autopilot_source = _parent.autopilot_source,
      source_friction_packet_id = _parent.source_friction_packet_id,
      repair_risk = _parent.repair_risk
  WHERE id = _child.id
  RETURNING * INTO _child;

  INSERT INTO public.builder_audit_events (
    organization_id, job_id, event_type, actor_type, new_value, change_summary
  ) VALUES (
    _child.organization_id, _child.id, 'builder_job_policy_bound', 'bot',
    jsonb_build_object('parent_job_id', _parent.id, 'target_sha', _child.target_sha,
      'autopilot_source', _child.autopilot_source),
    'Automatic Builder continuation linked and bound atomically; release controls remain unchanged'
  );
  RETURN _child;
END;
$$;

REVOKE ALL ON FUNCTION public.builder_create_autopilot_child(uuid,text,text,text,text,boolean,boolean,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.builder_create_autopilot_child(uuid,text,text,text,text,boolean,boolean,text) TO postgres,service_role;