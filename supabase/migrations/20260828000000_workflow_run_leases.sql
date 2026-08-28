-- Durable worker leases for the Supabase workflow path.
-- The caller still needs a valid authenticated workflow identity; the lease
-- token is an additional run-scoped capability, not a replacement for auth.

ALTER TABLE public.wf_runs
  ADD COLUMN IF NOT EXISTS lease_token text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS wf_runs_one_active_lease_per_job
  ON public.wf_runs (job_id)
  WHERE status = 'picked_up' AND lease_token IS NOT NULL;

CREATE OR REPLACE FUNCTION public.wf_pickup_run(_job_id uuid, _runner_id text)
RETURNS public.wf_runs
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _job public.wf_jobs%rowtype;
  _run public.wf_runs%rowtype;
  _lease_token text := encode(gen_random_bytes(32), 'hex');
  _now timestamptz := now();
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO _job
  FROM public.wf_jobs
  WHERE id = _job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found: %', _job_id;
  END IF;

  UPDATE public.wf_runs
  SET status = 'failed', finished_at = _now, result_summary = jsonb_build_object('reason', 'lease expired')
  WHERE job_id = _job_id
    AND status = 'picked_up'
    AND lease_expires_at IS NOT NULL
    AND lease_expires_at <= _now;

  IF EXISTS (
    SELECT 1 FROM public.wf_runs
    WHERE job_id = _job_id AND status = 'picked_up' AND lease_expires_at > _now
  ) THEN
    RAISE EXCEPTION 'Job already has an active worker lease';
  END IF;

  INSERT INTO public.wf_runs (
    job_id, runner_id, status, picked_up_at, lease_token, lease_expires_at, heartbeat_at
  ) VALUES (
    _job_id, _runner_id, 'picked_up', _now, _lease_token, _now + interval '15 minutes', _now
  )
  RETURNING * INTO _run;

  PERFORM public.wf_transition_job_state(
    _job_id, 'running', concat('runner pickup ', _runner_id), 'runner'
  );

  RETURN _run;
END;
$$;

CREATE OR REPLACE FUNCTION public.wf_heartbeat_run(_run_id uuid, _lease_token text)
RETURNS public.wf_runs
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _run public.wf_runs%rowtype;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  UPDATE public.wf_runs
  SET heartbeat_at = now(), lease_expires_at = now() + interval '15 minutes'
  WHERE id = _run_id
    AND status = 'picked_up'
    AND lease_token = _lease_token
    AND lease_expires_at > now()
  RETURNING * INTO _run;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Run lease is missing, expired, or invalid';
  END IF;

  RETURN _run;
END;
$$;

REVOKE ALL ON FUNCTION public.wf_heartbeat_run(uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.wf_heartbeat_run(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wf_heartbeat_run(uuid, text) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.wf_return_artifact(uuid, uuid, public.wf_artifact_kind, text, text, text, bigint);

CREATE OR REPLACE FUNCTION public.wf_return_artifact(
  _job_id uuid,
  _run_id uuid,
  _kind public.wf_artifact_kind,
  _bucket_id text,
  _object_path text,
  _sha256 text DEFAULT NULL,
  _size_bytes bigint DEFAULT NULL,
  _lease_token text DEFAULT NULL
)
RETURNS public.wf_artifacts
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _uid uuid := auth.uid();
  _artifact public.wf_artifacts%rowtype;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF _run_id IS NULL OR _lease_token IS NULL THEN
    RAISE EXCEPTION 'run_id and lease_token are required';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.wf_runs r
    WHERE r.id = _run_id
      AND r.job_id = _job_id
      AND r.status = 'picked_up'
      AND r.lease_token = _lease_token
      AND r.lease_expires_at > now()
  ) THEN
    RAISE EXCEPTION 'Run lease is missing, expired, or does not belong to job';
  END IF;

  INSERT INTO public.wf_artifacts (
    job_id, run_id, kind, bucket_id, object_path, sha256, size_bytes, created_by
  )
  VALUES (
    _job_id, _run_id, _kind, _bucket_id, _object_path, _sha256, _size_bytes, _uid
  )
  RETURNING * INTO _artifact;

  RETURN _artifact;
END;
$$;

REVOKE ALL ON FUNCTION public.wf_return_artifact(uuid, uuid, public.wf_artifact_kind, text, text, text, bigint, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.wf_return_artifact(uuid, uuid, public.wf_artifact_kind, text, text, text, bigint, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.wf_service_pickup_run(_job_id uuid, _runner_id text)
RETURNS public.wf_runs
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _job public.wf_jobs%rowtype;
  _run public.wf_runs%rowtype;
  _lease_token text := encode(gen_random_bytes(32), 'hex');
  _now timestamptz := now();
  _bob uuid := '00000000-0000-0000-0000-00000000b0b0';
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;
  IF _runner_id IS NULL OR btrim(_runner_id) = '' THEN
    RAISE EXCEPTION 'runner_id is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_profiles WHERE id = _bob) THEN
    RAISE EXCEPTION 'Bob system actor is not configured';
  END IF;

  SELECT * INTO _job FROM public.wf_jobs WHERE id = _job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job not found: %', _job_id; END IF;
  IF _job.state <> 'ratified' THEN
    RAISE EXCEPTION 'Job is not ratified for execution';
  END IF;

  UPDATE public.wf_runs
  SET status = 'failed', finished_at = _now, result_summary = jsonb_build_object('reason', 'lease expired')
  WHERE job_id = _job_id AND status = 'picked_up'
    AND lease_expires_at IS NOT NULL AND lease_expires_at <= _now;

  IF EXISTS (SELECT 1 FROM public.wf_runs WHERE job_id = _job_id AND status = 'picked_up' AND lease_token IS NOT NULL) THEN
    RAISE EXCEPTION 'Job already has an active worker lease';
  END IF;

  INSERT INTO public.wf_runs (job_id, runner_id, status, picked_up_at, lease_token, lease_expires_at, heartbeat_at)
  VALUES (_job_id, _runner_id, 'picked_up', _now, _lease_token, _now + interval '15 minutes', _now)
  RETURNING * INTO _run;

  UPDATE public.wf_jobs SET state = 'running', updated_at = _now WHERE id = _job_id;
  INSERT INTO public.wf_state_events (job_id, from_state, to_state, reason, actor_user_id, actor_type)
  VALUES (_job_id, 'ratified', 'running', concat('service runner pickup ', _runner_id), _bob, 'system');
  RETURN _run;
END;
$$;

CREATE OR REPLACE FUNCTION public.wf_service_return_artifact(
  _job_id uuid,
  _run_id uuid,
  _kind public.wf_artifact_kind,
  _bucket_id text,
  _object_path text,
  _sha256 text DEFAULT NULL,
  _size_bytes bigint DEFAULT NULL,
  _lease_token text DEFAULT NULL
)
RETURNS public.wf_artifacts
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _artifact public.wf_artifacts%rowtype;
  _bob uuid := '00000000-0000-0000-0000-00000000b0b0';
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.wf_runs
    WHERE id = _run_id AND job_id = _job_id AND status = 'picked_up'
      AND lease_token = _lease_token AND lease_expires_at > now()
  ) THEN
    RAISE EXCEPTION 'Run lease is missing, expired, or does not belong to job';
  END IF;
  INSERT INTO public.wf_artifacts (job_id, run_id, kind, bucket_id, object_path, sha256, size_bytes, created_by)
  VALUES (_job_id, _run_id, _kind, _bucket_id, _object_path, _sha256, _size_bytes, _bob)
  RETURNING * INTO _artifact;
  RETURN _artifact;
END;
$$;

REVOKE ALL ON FUNCTION public.wf_service_pickup_run(uuid, text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.wf_service_return_artifact(uuid, uuid, public.wf_artifact_kind, text, text, text, bigint, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.wf_service_pickup_run(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.wf_service_return_artifact(uuid, uuid, public.wf_artifact_kind, text, text, text, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wf_service_pickup_run(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.wf_service_return_artifact(uuid, uuid, public.wf_artifact_kind, text, text, text, bigint, text) TO service_role;

-- Workflow mutations must go through the guarded RPCs. Keep reads available
-- to the existing assessment policies, but remove direct write paths.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.wf_jobs, public.wf_runs, public.wf_artifacts FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.wf_pickup_run(uuid, text) FROM anon, authenticated, service_role;