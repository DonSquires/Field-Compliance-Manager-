-- Builder pull requests are review records only. They never merge or deploy.

ALTER TABLE public.builder_jobs
  ADD COLUMN IF NOT EXISTS workspace_pull_request_url text,
  ADD COLUMN IF NOT EXISTS workspace_pull_request_head_sha text,
  ADD COLUMN IF NOT EXISTS workspace_pull_request_created_at timestamptz;

CREATE OR REPLACE FUNCTION public.builder_record_workspace_pull_request(
  _job_id uuid,
  _expected_head_sha text,
  _pull_request_url text
)
RETURNS public.builder_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _job public.builder_jobs%rowtype;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  IF _expected_head_sha !~ '^[a-f0-9]{40}$' OR _pull_request_url !~ '^https://github\.com/.+/pull/[0-9]+$' THEN RAISE EXCEPTION 'Builder pull request metadata is invalid'; END IF;
  SELECT * INTO _job FROM public.builder_jobs WHERE id = _job_id FOR UPDATE;
  IF _job.id IS NULL OR _job.workspace_branch IS NULL OR _job.workspace_published_head_sha IS DISTINCT FROM _expected_head_sha OR _job.workspace_head_sha IS DISTINCT FROM _expected_head_sha THEN RAISE EXCEPTION 'Builder workspace publication is stale'; END IF;
  UPDATE public.builder_jobs SET workspace_pull_request_url = _pull_request_url, workspace_pull_request_head_sha = _expected_head_sha, workspace_pull_request_created_at = now(), updated_at = now() WHERE id = _job.id RETURNING * INTO _job;
  INSERT INTO public.builder_audit_events (organization_id, job_id, event_type, actor_type, new_value, change_summary)
  VALUES (_job.organization_id, _job.id, 'step_completed', 'builder_mode', jsonb_build_object('workspace_branch', _job.workspace_branch, 'workspace_head_sha', _expected_head_sha, 'pull_request_url', _pull_request_url), 'Verified Builder branch opened as a GitHub pull request for human review; no merge or deployment performed');
  RETURN _job;
END;
$$;
REVOKE ALL ON FUNCTION public.builder_record_workspace_pull_request(uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.builder_record_workspace_pull_request(uuid,text,text) TO service_role;