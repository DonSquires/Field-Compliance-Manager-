-- Bob autopilot for the agentic Builder lane (owner instruction, 2026-09-26):
-- "bob is going to need to be as reliable as you and just push fixes as you do
-- and let me know what has happened once it's done".
--
-- Canon (docs/canon/BOB_DOCTRINE.md §9, 2026-09-14): the agentic lane continues
-- without a human confirm at each step and stops only at a protected path, a
-- blocked state, a failed verification the subagents cannot repair, or the
-- action ceiling. Merge, deployment, DDL, auth/RLS, dependency and environment
-- changes stay human. So: when the owner asks Bob in chat to make a change, that
-- instruction is the key turn; Bob drives the job through its gates on the
-- owner's behalf (recorded as such), publishes the branch, opens the pull
-- request, and reports back. Nothing here merges or deploys.

ALTER TABLE public.builder_jobs
  ADD COLUMN IF NOT EXISTS autopilot_requested_by uuid,
  ADD COLUMN IF NOT EXISTS autopilot_conversation_id uuid,
  ADD COLUMN IF NOT EXISTS autopilot_state text,
  ADD COLUMN IF NOT EXISTS autopilot_report jsonb,
  ADD COLUMN IF NOT EXISTS autopilot_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS autopilot_reported_at timestamptz;

ALTER TABLE public.builder_jobs DROP CONSTRAINT IF EXISTS builder_jobs_autopilot_state_check;
ALTER TABLE public.builder_jobs
  ADD CONSTRAINT builder_jobs_autopilot_state_check
  CHECK (autopilot_state IS NULL OR autopilot_state IN ('driving', 'published', 'blocked', 'done'));

CREATE INDEX IF NOT EXISTS idx_builder_jobs_autopilot_active
  ON public.builder_jobs (autopilot_requested_by)
  WHERE autopilot_requested_by IS NOT NULL AND autopilot_state IS DISTINCT FROM 'done';

-- Bind a job to the person whose chat instruction opened it. Only the owning
-- service (control room, on the caller's authenticated request) may bind.
CREATE OR REPLACE FUNCTION public.builder_autopilot_bind(_job_id uuid, _requested_by uuid, _conversation_id uuid DEFAULT NULL)
RETURNS public.builder_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _job public.builder_jobs%rowtype;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  IF _requested_by IS NULL THEN RAISE EXCEPTION 'Autopilot requester is required'; END IF;
  SELECT * INTO _job FROM public.builder_jobs WHERE id = _job_id FOR UPDATE;
  IF _job.id IS NULL THEN RAISE EXCEPTION 'Builder job is unavailable'; END IF;
  IF _job.status IN ('failed', 'cancelled', 'deployed') THEN RAISE EXCEPTION 'Builder job is terminal'; END IF;
  IF NOT public.can_approve_action(_requested_by, _job.organization_id) THEN
    RAISE EXCEPTION 'Autopilot requester cannot approve Builder work for this organisation';
  END IF;
  UPDATE public.builder_jobs
  SET autopilot_requested_by = _requested_by,
      autopilot_conversation_id = _conversation_id,
      autopilot_state = 'driving',
      autopilot_updated_at = now(),
      updated_at = now()
  WHERE id = _job.id RETURNING * INTO _job;
  INSERT INTO public.builder_audit_events (organization_id, job_id, event_type, actor_user_id, actor_type, new_value, change_summary)
  VALUES (_job.organization_id, _job.id, 'builder_job_policy_bound', _requested_by, 'bot',
    jsonb_build_object('autopilot_requested_by', _requested_by, 'autopilot_conversation_id', _conversation_id),
    'Bob autopilot bound: gates will be cleared on this person''s standing chat instruction; merge and deployment remain human');
  RETURN _job;
END;
$$;
REVOKE ALL ON FUNCTION public.builder_autopilot_bind(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_autopilot_bind(uuid, uuid, uuid) TO service_role;

-- Clear a pending gate on the requester's behalf. Mirrors builder_decide_approval
-- (same invariants, same transitions) but records the requester as approver and
-- Bob as the actor. Approve only; a rejection is always a human decision.
CREATE OR REPLACE FUNCTION public.builder_autopilot_decide_approval(_approval_id uuid, _comment text DEFAULT NULL)
RETURNS public.builder_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _approval public.builder_approvals%rowtype; _job public.builder_jobs%rowtype; _next_status text; _uid uuid;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  SELECT * INTO _approval FROM public.builder_approvals WHERE id = _approval_id FOR UPDATE;
  IF NOT FOUND OR _approval.status <> 'pending' THEN RAISE EXCEPTION 'Approval is missing or already decided'; END IF;
  IF _approval.expires_at <= now() THEN RAISE EXCEPTION 'Approval has expired and requires a new evidence review'; END IF;
  SELECT * INTO _job FROM public.builder_jobs WHERE id = _approval.job_id FOR UPDATE;
  IF NOT FOUND OR _job.autopilot_requested_by IS NULL THEN RAISE EXCEPTION 'Job is not under Bob autopilot'; END IF;
  _uid := _job.autopilot_requested_by;
  IF NOT public.can_approve_action(_uid, _approval.organization_id) THEN RAISE EXCEPTION 'Autopilot requester is not authorized to approve this job'; END IF;
  IF cardinality(_approval.requested_from_users) > 0 AND NOT (_uid = ANY(_approval.requested_from_users)) THEN RAISE EXCEPTION 'Approval was not requested from the autopilot requester'; END IF;
  IF _job.status <> _approval.triggered_at_status THEN RAISE EXCEPTION 'Job has moved beyond this approval gate'; END IF;
  IF _approval.requested_target_sha IS DISTINCT FROM _job.target_sha THEN RAISE EXCEPTION 'Job target changed after approval was requested'; END IF;
  IF (SELECT count(*) FROM public.builder_artifacts WHERE job_id = _job.id AND id = ANY(_approval.reviewed_artifact_ids) AND status = 'final') <> cardinality(_approval.reviewed_artifact_ids) THEN
    RAISE EXCEPTION 'Reviewed evidence is no longer valid';
  END IF;
  IF _approval.approval_type = 'specification_review' AND _approval.triggered_at_status = 'specification_ready' THEN _next_status := 'design_pending';
  ELSIF _approval.approval_type = 'release_approval' AND _approval.triggered_at_status = 'approval_pending' THEN _next_status := 'release_ready';
  ELSE RAISE EXCEPTION 'Approval gate cannot transition this job'; END IF;
  UPDATE public.builder_approvals
  SET status = 'approved', approved_by = _uid, decided_by = _uid,
      approval_comment = left(COALESCE(NULLIF(btrim(_comment), ''), 'Cleared by Bob autopilot on the requester''s standing chat instruction'), 2000),
      responded_at = now(), updated_at = now()
  WHERE id = _approval.id;
  UPDATE public.builder_jobs SET status = _next_status, last_error = NULL, autopilot_updated_at = now(), updated_at = now() WHERE id = _job.id RETURNING * INTO _job;
  INSERT INTO public.builder_audit_events (organization_id, job_id, event_type, actor_user_id, actor_type, previous_value, new_value, change_summary, related_artifact_ids, related_approval_id)
  VALUES (_approval.organization_id, _approval.job_id, 'approval_approved', _uid, 'bot',
    jsonb_build_object('status', _approval.triggered_at_status),
    jsonb_build_object('status', _next_status, 'decision', 'approved', 'source', 'bob_autopilot'),
    'Bob autopilot cleared the ' || _approval.approval_type || ' gate on the requester''s standing chat instruction; merge and deployment remain human',
    _approval.reviewed_artifact_ids, _approval.id);
  RETURN _job;
END;
$$;
REVOKE ALL ON FUNCTION public.builder_autopilot_decide_approval(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_autopilot_decide_approval(uuid, text) TO service_role;

-- The autopilot's plain-language outcome for the requester (Bob relays it in chat).
CREATE OR REPLACE FUNCTION public.builder_autopilot_record(_job_id uuid, _state text, _report jsonb DEFAULT NULL)
RETURNS public.builder_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _job public.builder_jobs%rowtype;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  IF _state NOT IN ('driving', 'published', 'blocked', 'done') THEN RAISE EXCEPTION 'Unsupported autopilot state'; END IF;
  UPDATE public.builder_jobs
  SET autopilot_state = _state,
      autopilot_report = COALESCE(_report, autopilot_report),
      autopilot_reported_at = CASE WHEN _report IS NOT NULL THEN NULL ELSE autopilot_reported_at END,
      autopilot_updated_at = now(),
      updated_at = now()
  WHERE id = _job_id AND autopilot_requested_by IS NOT NULL RETURNING * INTO _job;
  IF _job.id IS NULL THEN RAISE EXCEPTION 'Builder job is not under Bob autopilot'; END IF;
  RETURN _job;
END;
$$;
REVOKE ALL ON FUNCTION public.builder_autopilot_record(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_autopilot_record(uuid, text, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.builder_autopilot_mark_reported(_job_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  UPDATE public.builder_jobs SET autopilot_reported_at = now(), updated_at = now()
  WHERE id = _job_id AND autopilot_report IS NOT NULL AND autopilot_reported_at IS NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.builder_autopilot_mark_reported(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_autopilot_mark_reported(uuid) TO service_role;
