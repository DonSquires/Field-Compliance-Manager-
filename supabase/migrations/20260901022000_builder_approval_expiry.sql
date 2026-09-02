-- Approval evidence is immutable and time-bound. Expired gates remain visible
-- for audit but cannot be decided without a newly requested approval.

ALTER TABLE public.builder_approvals
  ADD COLUMN IF NOT EXISTS expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days');

CREATE INDEX IF NOT EXISTS builder_approvals_pending_expiry
  ON public.builder_approvals (expires_at)
  WHERE status = 'pending';

CREATE OR REPLACE FUNCTION public.builder_decide_approval(
  _approval_id uuid,
  _decision text,
  _comment text DEFAULT NULL
)
RETURNS public.builder_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _uid uuid := auth.uid(); _approval public.builder_approvals%rowtype; _job public.builder_jobs%rowtype; _next_status text; _event_type text;
BEGIN
  IF auth.role() <> 'authenticated' OR _uid IS NULL THEN RAISE EXCEPTION 'Authenticated human identity required'; END IF;
  IF _decision NOT IN ('approved', 'rejected') THEN RAISE EXCEPTION 'Decision must be approved or rejected'; END IF;
  SELECT * INTO _approval FROM public.builder_approvals WHERE id = _approval_id FOR UPDATE;
  IF NOT FOUND OR _approval.status <> 'pending' THEN RAISE EXCEPTION 'Approval is missing or already decided'; END IF;
  IF _approval.expires_at <= now() THEN RAISE EXCEPTION 'Approval has expired and requires a new evidence review'; END IF;
  IF NOT public.can_approve_action(_uid, _approval.organization_id) THEN RAISE EXCEPTION 'User is not authorized to approve this job'; END IF;
  IF cardinality(_approval.requested_from_users) > 0 AND NOT (_uid = ANY(_approval.requested_from_users)) THEN RAISE EXCEPTION 'Approval was not requested from this user'; END IF;
  SELECT * INTO _job FROM public.builder_jobs WHERE id = _approval.job_id FOR UPDATE;
  IF NOT FOUND OR _job.status <> _approval.triggered_at_status THEN RAISE EXCEPTION 'Job has moved beyond this approval gate'; END IF;
  IF _approval.requested_target_sha IS DISTINCT FROM _job.target_sha THEN RAISE EXCEPTION 'Job target changed after approval was requested'; END IF;
  IF (SELECT count(*) FROM public.builder_artifacts WHERE job_id = _job.id AND id = ANY(_approval.reviewed_artifact_ids) AND status = 'final') <> cardinality(_approval.reviewed_artifact_ids) THEN RAISE EXCEPTION 'Reviewed evidence is no longer valid'; END IF;
  IF _decision = 'rejected' THEN _next_status := 'failed'; _event_type := 'approval_rejected';
  ELSIF _approval.approval_type = 'specification_review' AND _approval.triggered_at_status = 'specification_ready' THEN _next_status := 'design_pending'; _event_type := 'approval_approved';
  ELSIF _approval.approval_type = 'release_approval' AND _approval.triggered_at_status = 'approval_pending' THEN _next_status := 'release_ready'; _event_type := 'approval_approved';
  ELSE RAISE EXCEPTION 'Approval gate cannot transition this job'; END IF;
  UPDATE public.builder_approvals SET status = _decision, approved_by = CASE WHEN _decision = 'approved' THEN _uid ELSE NULL END, decided_by = _uid, approval_comment = NULLIF(btrim(_comment), ''), responded_at = now(), updated_at = now() WHERE id = _approval.id;
  UPDATE public.builder_jobs SET status = _next_status, last_error = CASE WHEN _decision = 'rejected' THEN COALESCE(NULLIF(btrim(_comment), ''), 'Builder approval rejected') ELSE NULL END, updated_at = now() WHERE id = _job.id RETURNING * INTO _job;
  INSERT INTO public.builder_audit_events (organization_id, job_id, event_type, actor_user_id, actor_type, previous_value, new_value, change_summary, related_artifact_ids, related_approval_id)
  VALUES (_approval.organization_id, _approval.job_id, _event_type, _uid, 'user', jsonb_build_object('status', _approval.triggered_at_status), jsonb_build_object('status', _next_status, 'decision', _decision), CASE WHEN _decision = 'approved' THEN 'Human approved Builder gate' ELSE 'Human rejected Builder gate' END, _approval.reviewed_artifact_ids, _approval.id);
  RETURN _job;
END;
$$;

CREATE OR REPLACE FUNCTION public.builder_decide_human_code_review(_approval_id uuid, _decision text, _comment text DEFAULT NULL)
RETURNS public.builder_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _uid uuid := auth.uid(); _approval public.builder_approvals%rowtype; _job public.builder_jobs%rowtype; _passed boolean;
BEGIN
  IF auth.role() <> 'authenticated' OR _uid IS NULL THEN RAISE EXCEPTION 'Authenticated human identity required'; END IF;
  IF _decision NOT IN ('approved', 'rejected') THEN RAISE EXCEPTION 'Decision must be approved or rejected'; END IF;
  SELECT * INTO _approval FROM public.builder_approvals WHERE id = _approval_id AND approval_type = 'implementation_review' FOR UPDATE;
  IF _approval.id IS NULL OR _approval.status <> 'pending' THEN RAISE EXCEPTION 'Human code review is missing or decided'; END IF;
  IF _approval.expires_at <= now() THEN RAISE EXCEPTION 'Approval has expired and requires a new evidence review'; END IF;
  IF NOT public.can_approve_action(_uid, _approval.organization_id) THEN RAISE EXCEPTION 'User cannot review this job'; END IF;
  IF cardinality(_approval.requested_from_users) > 0 AND NOT (_uid = ANY(_approval.requested_from_users)) THEN RAISE EXCEPTION 'Review was not requested from this user'; END IF;
  SELECT * INTO _job FROM public.builder_jobs WHERE id = _approval.job_id FOR UPDATE;
  IF _job.status <> 'security_review' OR _job.code_review_mode <> 'human' OR _approval.requested_target_sha IS DISTINCT FROM _job.target_sha THEN RAISE EXCEPTION 'Human code review is stale'; END IF;
  _passed := _decision = 'approved';
  UPDATE public.builder_approvals SET status = _decision, decided_by = _uid, approved_by = CASE WHEN _passed THEN _uid ELSE NULL END, approval_comment = NULLIF(btrim(_comment), ''), responded_at = now(), updated_at = now() WHERE id = _approval.id;
  UPDATE public.builder_job_steps SET status = CASE WHEN _passed THEN 'completed' ELSE 'failed' END, completed_at = now(), blocked_reason = NULL, result_summary = CASE WHEN _passed THEN 'Optional human code review passed' ELSE 'Human code review blocked release' END, error = CASE WHEN _passed THEN NULL ELSE 'Human code review rejected implementation' END, artifact_ids = _approval.reviewed_artifact_ids, updated_at = now() WHERE job_id = _job.id AND step_id = 'code_review';
  UPDATE public.builder_jobs SET code_review_status = CASE WHEN _passed THEN 'passed' ELSE 'blocked' END, status = CASE WHEN _passed THEN 'security_review' ELSE 'failed' END, last_error = CASE WHEN _passed THEN NULL ELSE COALESCE(NULLIF(btrim(_comment), ''), 'Human code review rejected implementation') END, updated_at = now() WHERE id = _job.id RETURNING * INTO _job;
  INSERT INTO public.builder_audit_events (organization_id, job_id, event_type, actor_user_id, actor_type, new_value, change_summary, related_artifact_ids, related_approval_id)
  VALUES (_job.organization_id, _job.id, CASE WHEN _passed THEN 'approval_approved' ELSE 'approval_rejected' END, _uid, 'user', jsonb_build_object('code_review_status', _job.code_review_status, 'target_sha', _job.target_sha), CASE WHEN _passed THEN 'Optional human code review passed' ELSE 'Human code review blocked release' END, _approval.reviewed_artifact_ids, _approval.id);
  RETURN _job;
END;
$$;