-- Bind an interactive Builder workspace to the job's immutable source commit.
-- The host derives the branch from the job id; callers never provide a branch.

ALTER TABLE public.builder_jobs
  ADD COLUMN IF NOT EXISTS workspace_branch text,
  ADD COLUMN IF NOT EXISTS workspace_head_sha text,
  ADD COLUMN IF NOT EXISTS workspace_created_at timestamptz;

CREATE OR REPLACE FUNCTION public.builder_bind_workspace(
  _job_id uuid,
  _workspace_branch text,
  _workspace_head_sha text
)
RETURNS public.builder_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _job public.builder_jobs%rowtype;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  IF _workspace_branch !~ '^bob/job-[a-z0-9]+$' THEN RAISE EXCEPTION 'Builder workspace branch is invalid'; END IF;
  IF _workspace_head_sha !~ '^[a-f0-9]{40}$' THEN RAISE EXCEPTION 'Builder workspace commit is invalid'; END IF;
  SELECT * INTO _job FROM public.builder_jobs WHERE id = _job_id FOR UPDATE;
  IF _job.id IS NULL OR _job.target_sha IS NULL THEN RAISE EXCEPTION 'Builder job or target SHA is unavailable'; END IF;
  IF _workspace_head_sha IS DISTINCT FROM _job.target_sha THEN RAISE EXCEPTION 'Builder workspace must start from the pinned target SHA'; END IF;
  IF _job.workspace_branch IS NOT NULL AND _job.workspace_branch <> _workspace_branch THEN RAISE EXCEPTION 'Builder workspace branch is already bound'; END IF;
  UPDATE public.builder_jobs
  SET workspace_branch = _workspace_branch, workspace_head_sha = _workspace_head_sha,
      workspace_created_at = COALESCE(workspace_created_at, now()), updated_at = now()
  WHERE id = _job.id
  RETURNING * INTO _job;
  INSERT INTO public.builder_audit_events (organization_id, job_id, event_type, actor_type, new_value, change_summary)
  VALUES (_job.organization_id, _job.id, 'job_status_changed', 'builder_mode',
    jsonb_build_object('workspace_branch', _job.workspace_branch, 'workspace_head_sha', _job.workspace_head_sha),
    'Interactive Builder workspace bound to the immutable target commit');
  RETURN _job;
END;
$$;

REVOKE ALL ON FUNCTION public.builder_bind_workspace(uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.builder_bind_workspace(uuid,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.builder_record_workspace_commit(
  _job_id uuid,
  _expected_head_sha text,
  _commit_sha text
)
RETURNS public.builder_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _job public.builder_jobs%rowtype;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  IF _expected_head_sha !~ '^[a-f0-9]{40}$' OR _commit_sha !~ '^[a-f0-9]{40}$' THEN RAISE EXCEPTION 'Builder workspace commit is invalid'; END IF;
  SELECT * INTO _job FROM public.builder_jobs WHERE id = _job_id FOR UPDATE;
  IF _job.id IS NULL OR _job.workspace_branch IS NULL OR _job.workspace_head_sha IS DISTINCT FROM _expected_head_sha THEN RAISE EXCEPTION 'Builder workspace head is stale'; END IF;
  UPDATE public.builder_jobs SET workspace_head_sha = _commit_sha, updated_at = now() WHERE id = _job.id RETURNING * INTO _job;
  INSERT INTO public.builder_audit_events (organization_id, job_id, event_type, actor_type, previous_value, new_value, change_summary)
  VALUES (_job.organization_id, _job.id, 'step_completed', 'builder_mode', jsonb_build_object('workspace_head_sha', _expected_head_sha), jsonb_build_object('workspace_head_sha', _commit_sha), 'Verified Builder patch committed to dedicated workspace branch');
  RETURN _job;
END;
$$;
REVOKE ALL ON FUNCTION public.builder_record_workspace_commit(uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.builder_record_workspace_commit(uuid,text,text) TO service_role;