-- Atomic intake for the executable Builder runtime.

ALTER TABLE public.builder_jobs
  ADD COLUMN IF NOT EXISTS frontend_required boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS backend_required boolean NOT NULL DEFAULT false;

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
  IF NOT COALESCE(_frontend_required, false) AND NOT COALESCE(_backend_required, false) THEN RAISE EXCEPTION 'At least one implementation scope is required'; END IF;
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
    ARRAY['specification_ready','approval_pending'], _frontend_required, _backend_required,
    _code_review_mode, CASE WHEN _code_review_mode = 'none' THEN 'not_required' ELSE 'pending' END
  ) RETURNING * INTO _job;

  INSERT INTO public.builder_job_steps (job_id, step_id, ordinal_position, builder_mode, status, blocked_dependencies, result_summary)
  VALUES
    (_job.id, 'product_analysis', 1, 'product_analyst', 'pending', '{}', NULL),
    (_job.id, 'ui_design', 2, 'ux_designer', CASE WHEN _frontend_required THEN 'pending' ELSE 'skipped' END,
      ARRAY['product_analysis'], CASE WHEN _frontend_required THEN NULL ELSE 'No frontend scope requested' END),
    (_job.id, 'frontend_implementation', 3, 'frontend_engineer', CASE WHEN _frontend_required THEN 'pending' ELSE 'skipped' END,
      ARRAY['ui_design'], CASE WHEN _frontend_required THEN NULL ELSE 'No frontend scope requested' END),
    (_job.id, 'backend_implementation', 4, 'backend_engineer', CASE WHEN _backend_required THEN 'pending' ELSE 'skipped' END,
      ARRAY['product_analysis'], CASE WHEN _backend_required THEN NULL ELSE 'No backend scope requested' END),
    (_job.id, 'test_suite', 5, 'qa_security_reviewer', 'pending', ARRAY['frontend_implementation','backend_implementation'], NULL),
    (_job.id, 'security_review', 6, 'qa_security_reviewer', 'pending', ARRAY['test_suite'], NULL),
    (_job.id, 'code_review', 7, 'code_reviewer', 'pending', ARRAY['security_review'], NULL),
    (_job.id, 'release_prep', 8, 'release_engineer', 'pending', ARRAY['code_review'], NULL);

  INSERT INTO public.builder_audit_events (organization_id, job_id, event_type, actor_type, new_value, change_summary)
  VALUES (_job.organization_id, _job.id, 'job_created', 'bot',
    jsonb_build_object('target_sha', _job.target_sha, 'frontend_required', _frontend_required,
      'backend_required', _backend_required, 'code_review_mode', _code_review_mode),
    'Builder job created with immutable repository target and implementation scope');
  RETURN _job;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.builder_create_job(uuid,uuid,text,text,text,text,text,boolean,boolean,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.builder_create_job(uuid,uuid,text,text,text,text,text,boolean,boolean,text,uuid) TO service_role;