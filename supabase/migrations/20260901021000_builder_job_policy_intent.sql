-- Persist the approved intent for a Builder job. Legacy builder_create_job
-- remains available for existing callers; new intake uses this versioned RPC.

ALTER TABLE public.builder_jobs
  ADD COLUMN IF NOT EXISTS requested_action text NOT NULL DEFAULT 'prepare_change',
  ADD COLUMN IF NOT EXISTS target_environment text NOT NULL DEFAULT 'development',
  ADD CONSTRAINT builder_jobs_requested_action_check CHECK (requested_action IN ('prepare_change', 'prepare_release')),
  ADD CONSTRAINT builder_jobs_target_environment_check CHECK (target_environment IN ('development', 'staging', 'production'));

CREATE OR REPLACE FUNCTION public.builder_create_job_v2(
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
  _task_run_id uuid DEFAULT NULL,
  _requested_action text DEFAULT 'prepare_change',
  _target_environment text DEFAULT 'development'
)
RETURNS public.builder_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _job public.builder_jobs%rowtype;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  IF _requested_action NOT IN ('prepare_change', 'prepare_release') THEN RAISE EXCEPTION 'Unsupported Builder requested action'; END IF;
  IF _target_environment NOT IN ('development', 'staging', 'production') THEN RAISE EXCEPTION 'Unsupported Builder target environment'; END IF;
  IF _target_environment = 'production' AND _requested_action <> 'prepare_release' THEN RAISE EXCEPTION 'Production Builder jobs must prepare a release'; END IF;
  IF _target_environment = 'production' AND _code_review_mode <> 'human' THEN RAISE EXCEPTION 'Production Builder jobs require human code review'; END IF;

  SELECT * INTO _job FROM public.builder_create_job(
    _organization_id, _project_id, _title, _task_description, _target_sha,
    _branch_name, _description, _frontend_required, _backend_required,
    _code_review_mode, _task_run_id
  );

  UPDATE public.builder_jobs
  SET requested_action = _requested_action,
      target_environment = _target_environment
  WHERE id = _job.id
  RETURNING * INTO _job;

  INSERT INTO public.builder_audit_events (organization_id, job_id, event_type, actor_type, new_value, change_summary)
  VALUES (_job.organization_id, _job.id, 'builder_job_policy_bound', 'bot',
    jsonb_build_object('requested_action', _job.requested_action, 'target_environment', _job.target_environment, 'target_sha', _job.target_sha),
    'Builder job intent and target environment bound to the immutable repository target');

  RETURN _job;
END;
$$;

REVOKE ALL ON FUNCTION public.builder_create_job_v2(uuid,uuid,text,text,text,text,text,boolean,boolean,text,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.builder_create_job_v2(uuid,uuid,text,text,text,text,text,boolean,boolean,text,uuid,text,text) TO service_role;