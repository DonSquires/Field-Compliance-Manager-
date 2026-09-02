-- Each conversational Builder follow-up is a new immutable job. It inherits
-- the previous job's dedicated branch but is pinned to that branch's verified
-- head, preserving an auditable iteration chain instead of mutating target_sha.

ALTER TABLE public.builder_jobs
  ADD COLUMN IF NOT EXISTS parent_job_id uuid REFERENCES public.builder_jobs(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS builder_jobs_parent_job_idx ON public.builder_jobs(parent_job_id);

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
  IF NOT COALESCE(_frontend_required, false) AND NOT COALESCE(_backend_required, false) THEN RAISE EXCEPTION 'At least one implementation scope is required'; END IF;
  IF _code_review_mode NOT IN ('none', 'human', 'independent_ai') THEN RAISE EXCEPTION 'Unsupported code review mode'; END IF;
  INSERT INTO public.builder_jobs (organization_id, project_id, parent_job_id, title, task_description, status, current_step_index, total_steps, branch_name, target_sha, workspace_branch, workspace_head_sha, workspace_created_at, approval_required_at, frontend_required, backend_required, code_review_mode, code_review_status)
  VALUES (_parent.organization_id, _parent.project_id, _parent.id, btrim(_title), btrim(_task_description), 'intake', 0, 8, _parent.workspace_branch, _parent.workspace_head_sha, _parent.workspace_branch, _parent.workspace_head_sha, _parent.workspace_created_at, ARRAY['specification_ready','approval_pending'], _frontend_required, _backend_required, _code_review_mode, CASE WHEN _code_review_mode = 'none' THEN 'not_required' ELSE 'pending' END)
  RETURNING * INTO _job;
  INSERT INTO public.builder_job_steps (job_id, step_id, ordinal_position, builder_mode, status, blocked_dependencies, result_summary)
  VALUES
    (_job.id, 'product_analysis', 1, 'product_analyst', 'pending', '{}', NULL),
    (_job.id, 'ui_design', 2, 'ux_designer', CASE WHEN _frontend_required THEN 'pending' ELSE 'skipped' END, ARRAY['product_analysis'], CASE WHEN _frontend_required THEN NULL ELSE 'No frontend scope requested' END),
    (_job.id, 'frontend_implementation', 3, 'frontend_engineer', CASE WHEN _frontend_required THEN 'pending' ELSE 'skipped' END, ARRAY['ui_design'], CASE WHEN _frontend_required THEN NULL ELSE 'No frontend scope requested' END),
    (_job.id, 'backend_implementation', 4, 'backend_engineer', CASE WHEN _backend_required THEN 'pending' ELSE 'skipped' END, ARRAY['product_analysis'], CASE WHEN _backend_required THEN NULL ELSE 'No backend scope requested' END),
    (_job.id, 'test_suite', 5, 'qa_security_reviewer', 'pending', ARRAY['frontend_implementation','backend_implementation'], NULL),
    (_job.id, 'security_review', 6, 'qa_security_reviewer', 'pending', ARRAY['test_suite'], NULL),
    (_job.id, 'code_review', 7, 'code_reviewer', 'pending', ARRAY['security_review'], NULL),
    (_job.id, 'release_prep', 8, 'release_engineer', 'pending', ARRAY['code_review'], NULL);
  INSERT INTO public.builder_audit_events (organization_id, job_id, event_type, actor_type, new_value, change_summary)
  VALUES (_job.organization_id, _job.id, 'job_created', 'user', jsonb_build_object('parent_job_id', _parent.id, 'workspace_branch', _job.workspace_branch, 'target_sha', _job.target_sha), 'Builder follow-up iteration created from a verified workspace commit');
  RETURN _job;
END;
$$;

REVOKE ALL ON FUNCTION public.builder_create_followup_job(uuid,text,text,boolean,boolean,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.builder_create_followup_job(uuid,text,text,boolean,boolean,text) TO service_role;