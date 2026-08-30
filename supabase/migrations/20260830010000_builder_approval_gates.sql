-- Guarded human approval transitions for Builder jobs.

ALTER TABLE public.builder_approvals
  ADD COLUMN IF NOT EXISTS requested_target_sha text,
  ADD COLUMN IF NOT EXISTS reviewed_artifact_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS decided_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX builder_approvals_one_pending_gate
  ON public.builder_approvals (job_id, approval_type)
  WHERE status = 'pending';

CREATE OR REPLACE FUNCTION public.builder_request_approval(
  _job_id uuid,
  _approval_type text,
  _artifact_ids uuid[],
  _requested_from_users uuid[] DEFAULT '{}'
)
RETURNS public.builder_approvals
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _job public.builder_jobs%rowtype;
  _approval public.builder_approvals%rowtype;
  _expected_status text;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;

  _expected_status := CASE _approval_type
    WHEN 'specification_review' THEN 'specification_ready'
    WHEN 'release_approval' THEN 'approval_pending'
    ELSE NULL
  END;
  IF _expected_status IS NULL THEN
    RAISE EXCEPTION 'Unsupported approval gate';
  END IF;
  IF COALESCE(cardinality(_artifact_ids), 0) = 0 THEN
    RAISE EXCEPTION 'At least one review artifact is required';
  END IF;

  SELECT * INTO _job
  FROM public.builder_jobs
  WHERE id = _job_id
  FOR UPDATE;

  IF NOT FOUND OR _job.status <> _expected_status THEN
    RAISE EXCEPTION 'Job is not at the requested approval gate';
  END IF;
  IF (
    SELECT count(*)
    FROM public.builder_artifacts
    WHERE job_id = _job.id
      AND id = ANY(_artifact_ids)
      AND status = 'final'
  ) <> cardinality(_artifact_ids) THEN
    RAISE EXCEPTION 'Review artifacts must be final and belong to the job';
  END IF;

  INSERT INTO public.builder_approvals (
    organization_id,
    job_id,
    approval_type,
    triggered_at_status,
    status,
    requested_from_users,
    requested_target_sha,
    reviewed_artifact_ids
  )
  VALUES (
    _job.organization_id,
    _job.id,
    _approval_type,
    _expected_status,
    'pending',
    COALESCE(_requested_from_users, '{}'),
    _job.target_sha,
    _artifact_ids
  )
  RETURNING * INTO _approval;

  INSERT INTO public.builder_audit_events (
    organization_id,
    job_id,
    event_type,
    actor_type,
    new_value,
    change_summary,
    related_artifact_ids,
    related_approval_id
  )
  VALUES (
    _job.organization_id,
    _job.id,
    'approval_requested',
    'bot',
    jsonb_build_object(
      'approval_type', _approval_type,
      'triggered_at_status', _expected_status,
      'target_sha', _job.target_sha
    ),
    'Builder approval requested with immutable evidence snapshot',
    _artifact_ids,
    _approval.id
  );

  RETURN _approval;
END;
$$;

CREATE OR REPLACE FUNCTION public.builder_decide_approval(
  _approval_id uuid,
  _decision text,
  _comment text DEFAULT NULL
)
RETURNS public.builder_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _uid uuid := auth.uid();
  _approval public.builder_approvals%rowtype;
  _job public.builder_jobs%rowtype;
  _next_status text;
  _event_type text;
BEGIN
  IF auth.role() <> 'authenticated' OR _uid IS NULL THEN
    RAISE EXCEPTION 'Authenticated human identity required';
  END IF;
  IF _decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Decision must be approved or rejected';
  END IF;

  SELECT * INTO _approval
  FROM public.builder_approvals
  WHERE id = _approval_id
  FOR UPDATE;

  IF NOT FOUND OR _approval.status <> 'pending' THEN
    RAISE EXCEPTION 'Approval is missing or already decided';
  END IF;
  IF NOT public.can_approve_action(_uid, _approval.organization_id) THEN
    RAISE EXCEPTION 'User is not authorized to approve this job';
  END IF;
  IF cardinality(_approval.requested_from_users) > 0
     AND NOT (_uid = ANY(_approval.requested_from_users)) THEN
    RAISE EXCEPTION 'Approval was not requested from this user';
  END IF;

  SELECT * INTO _job
  FROM public.builder_jobs
  WHERE id = _approval.job_id
  FOR UPDATE;

  IF NOT FOUND OR _job.status <> _approval.triggered_at_status THEN
    RAISE EXCEPTION 'Job has moved beyond this approval gate';
  END IF;
  IF _approval.requested_target_sha IS DISTINCT FROM _job.target_sha THEN
    RAISE EXCEPTION 'Job target changed after approval was requested';
  END IF;
  IF (
    SELECT count(*)
    FROM public.builder_artifacts
    WHERE job_id = _job.id
      AND id = ANY(_approval.reviewed_artifact_ids)
      AND status = 'final'
  ) <> cardinality(_approval.reviewed_artifact_ids) THEN
    RAISE EXCEPTION 'Reviewed evidence is no longer valid';
  END IF;

  IF _decision = 'rejected' THEN
    _next_status := 'failed';
    _event_type := 'approval_rejected';
  ELSIF _approval.approval_type = 'specification_review'
        AND _approval.triggered_at_status = 'specification_ready' THEN
    _next_status := 'design_pending';
    _event_type := 'approval_approved';
  ELSIF _approval.approval_type = 'release_approval'
        AND _approval.triggered_at_status = 'approval_pending' THEN
    _next_status := 'release_ready';
    _event_type := 'approval_approved';
  ELSE
    RAISE EXCEPTION 'Approval gate cannot transition this job';
  END IF;

  UPDATE public.builder_approvals
  SET status = _decision,
      approved_by = CASE WHEN _decision = 'approved' THEN _uid ELSE NULL END,
      decided_by = _uid,
      approval_comment = NULLIF(btrim(_comment), ''),
      responded_at = now(),
      updated_at = now()
  WHERE id = _approval.id;

  UPDATE public.builder_jobs
  SET status = _next_status,
      last_error = CASE
        WHEN _decision = 'rejected' THEN COALESCE(NULLIF(btrim(_comment), ''), 'Builder approval rejected')
        ELSE NULL
      END,
      updated_at = now()
  WHERE id = _job.id
  RETURNING * INTO _job;

  INSERT INTO public.builder_audit_events (
    organization_id,
    job_id,
    event_type,
    actor_user_id,
    actor_type,
    previous_value,
    new_value,
    change_summary,
    related_artifact_ids,
    related_approval_id
  )
  VALUES (
    _approval.organization_id,
    _approval.job_id,
    _event_type,
    _uid,
    'user',
    jsonb_build_object('status', _approval.triggered_at_status),
    jsonb_build_object('status', _next_status, 'decision', _decision),
    CASE
      WHEN _decision = 'approved' THEN 'Human approved Builder gate'
      ELSE 'Human rejected Builder gate'
    END,
    _approval.reviewed_artifact_ids,
    _approval.id
  );

  RETURN _job;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.builder_request_approval(uuid, text, uuid[], uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_request_approval(uuid, text, uuid[], uuid[])
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.builder_decide_approval(uuid, text, text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.builder_decide_approval(uuid, text, text)
  TO authenticated;