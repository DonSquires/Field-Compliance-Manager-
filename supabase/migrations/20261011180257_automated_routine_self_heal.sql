ALTER TABLE public.bob_friction_packets
  ADD COLUMN IF NOT EXISTS repair_risk text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS automation_status text NOT NULL DEFAULT 'not_eligible',
  ADD COLUMN IF NOT EXISTS automation_attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS builder_job_id uuid REFERENCES public.builder_jobs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS automation_error_redacted text,
  ADD COLUMN IF NOT EXISTS automation_updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.bob_friction_packets
  DROP CONSTRAINT IF EXISTS bob_friction_packets_repair_risk_check,
  ADD CONSTRAINT bob_friction_packets_repair_risk_check
    CHECK (repair_risk IN ('routine', 'significant', 'protected', 'unknown')),
  DROP CONSTRAINT IF EXISTS bob_friction_packets_automation_status_check,
  ADD CONSTRAINT bob_friction_packets_automation_status_check
    CHECK (automation_status IN ('not_eligible', 'queued', 'claimed', 'builder_started', 'awaiting_grandmaster', 'published', 'completed', 'failed')),
  DROP CONSTRAINT IF EXISTS bob_friction_packets_automation_attempt_count_check,
  ADD CONSTRAINT bob_friction_packets_automation_attempt_count_check
    CHECK (automation_attempt_count >= 0 AND automation_attempt_count <= 5);

CREATE UNIQUE INDEX IF NOT EXISTS bob_friction_packets_builder_job_unique
  ON public.bob_friction_packets (builder_job_id)
  WHERE builder_job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS bob_friction_packets_routine_queue_idx
  ON public.bob_friction_packets (automation_updated_at, created_at)
  WHERE repair_risk = 'routine' AND automation_status = 'queued';

ALTER TABLE public.builder_jobs
  ADD COLUMN IF NOT EXISTS autopilot_source text,
  ADD COLUMN IF NOT EXISTS source_friction_packet_id uuid REFERENCES public.bob_friction_packets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS repair_risk text;

ALTER TABLE public.builder_jobs
  DROP CONSTRAINT IF EXISTS builder_jobs_autopilot_source_check,
  ADD CONSTRAINT builder_jobs_autopilot_source_check
    CHECK (autopilot_source IS NULL OR autopilot_source IN ('chat', 'routine_monitor')),
  DROP CONSTRAINT IF EXISTS builder_jobs_repair_risk_check,
  ADD CONSTRAINT builder_jobs_repair_risk_check
    CHECK (repair_risk IS NULL OR repair_risk IN ('routine', 'significant', 'protected', 'unknown'));

CREATE UNIQUE INDEX IF NOT EXISTS builder_jobs_source_friction_packet_unique
  ON public.builder_jobs (source_friction_packet_id)
  WHERE source_friction_packet_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.builder_claim_routine_repairs(_limit integer DEFAULT 3)
RETURNS SETOF public.bob_friction_packets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT packet.id
    FROM public.bob_friction_packets packet
    WHERE packet.repair_risk = 'routine'
      AND packet.automation_status = 'queued'
      AND packet.route = 'dispatch_flow'
      AND packet.stop_line_hit IS NULL
      AND packet.automation_attempt_count < 5
    ORDER BY packet.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(COALESCE(_limit, 3), 1), 10)
  )
  UPDATE public.bob_friction_packets packet
  SET automation_status = 'claimed',
      automation_attempt_count = packet.automation_attempt_count + 1,
      automation_error_redacted = NULL,
      automation_updated_at = now()
  FROM candidates
  WHERE packet.id = candidates.id
  RETURNING packet.*;
END;
$$;

REVOKE ALL ON FUNCTION public.builder_claim_routine_repairs(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_claim_routine_repairs(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.builder_bind_routine_repair(_job_id uuid, _packet_id uuid)
RETURNS public.builder_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _job public.builder_jobs%rowtype;
  _packet public.bob_friction_packets%rowtype;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;

  SELECT * INTO _packet
  FROM public.bob_friction_packets
  WHERE id = _packet_id
  FOR UPDATE;

  IF NOT FOUND
     OR _packet.repair_risk <> 'routine'
     OR _packet.route <> 'dispatch_flow'
     OR _packet.stop_line_hit IS NOT NULL
     OR _packet.automation_status <> 'claimed' THEN
    RAISE EXCEPTION 'Friction packet is not eligible for routine automation';
  END IF;

  SELECT * INTO _job
  FROM public.builder_jobs
  WHERE id = _job_id
  FOR UPDATE;

  IF NOT FOUND OR _job.status IN ('failed', 'cancelled', 'deployed') THEN
    RAISE EXCEPTION 'Builder job is unavailable';
  END IF;

  UPDATE public.builder_jobs
  SET autopilot_requested_by = _packet.user_id,
      autopilot_conversation_id = NULL,
      autopilot_source = 'routine_monitor',
      source_friction_packet_id = _packet.id,
      repair_risk = 'routine',
      autopilot_state = 'driving',
      autopilot_updated_at = now(),
      updated_at = now()
  WHERE id = _job.id
  RETURNING * INTO _job;

  UPDATE public.bob_friction_packets
  SET builder_job_id = _job.id,
      automation_status = 'builder_started',
      automation_updated_at = now()
  WHERE id = _packet.id;

  INSERT INTO public.builder_audit_events (
    organization_id, job_id, event_type, actor_user_id, actor_type,
    new_value, change_summary
  )
  VALUES (
    _job.organization_id, _job.id, 'builder_job_policy_bound', _packet.user_id, 'bot',
    jsonb_build_object(
      'autopilot_source', 'routine_monitor',
      'source_friction_packet_id', _packet.id,
      'repair_risk', 'routine'
    ),
    'Bob automatically opened a bounded routine repair from a monitored friction packet; protected or expanded scope still requires Grandmaster review'
  );

  RETURN _job;
END;
$$;

REVOKE ALL ON FUNCTION public.builder_bind_routine_repair(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_bind_routine_repair(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.builder_autopilot_decide_approval_guarded(
  _approval_id uuid,
  _comment text DEFAULT NULL
)
RETURNS public.builder_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _approval public.builder_approvals%rowtype;
  _job public.builder_jobs%rowtype;
  _packet public.bob_friction_packets%rowtype;
  _next_status text;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;

  SELECT * INTO _approval
  FROM public.builder_approvals
  WHERE id = _approval_id
  FOR UPDATE;

  IF NOT FOUND OR _approval.status <> 'pending' THEN
    RAISE EXCEPTION 'Approval is missing or already decided';
  END IF;

  SELECT * INTO _job
  FROM public.builder_jobs
  WHERE id = _approval.job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Builder job is unavailable';
  END IF;

  IF _job.autopilot_source IS DISTINCT FROM 'routine_monitor' THEN
    RETURN public.builder_autopilot_decide_approval(_approval_id, _comment);
  END IF;

  SELECT * INTO _packet
  FROM public.bob_friction_packets
  WHERE id = _job.source_friction_packet_id;

  IF NOT FOUND
     OR _packet.repair_risk <> 'routine'
     OR _packet.route <> 'dispatch_flow'
     OR _packet.stop_line_hit IS NOT NULL THEN
    RAISE EXCEPTION 'Routine repair authorization is no longer valid';
  END IF;

  IF _approval.expires_at <= now() THEN
    RAISE EXCEPTION 'Approval has expired and requires a new evidence review';
  END IF;
  IF _job.status <> _approval.triggered_at_status THEN
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

  IF _approval.approval_type = 'specification_review'
     AND _approval.triggered_at_status = 'specification_ready' THEN
    _next_status := 'design_pending';
  ELSIF _approval.approval_type = 'release_approval'
        AND _approval.triggered_at_status = 'approval_pending' THEN
    _next_status := 'release_ready';
  ELSE
    RAISE EXCEPTION 'Approval gate cannot transition this job';
  END IF;

  UPDATE public.builder_approvals
  SET status = 'approved',
      approved_by = _packet.user_id,
      decided_by = _packet.user_id,
      approval_comment = left(COALESCE(NULLIF(btrim(_comment), ''), 'Cleared by Bob for a verified routine repair'), 2000),
      responded_at = now(),
      updated_at = now()
  WHERE id = _approval.id;

  UPDATE public.builder_jobs
  SET status = _next_status,
      last_error = NULL,
      autopilot_updated_at = now(),
      updated_at = now()
  WHERE id = _job.id
  RETURNING * INTO _job;

  INSERT INTO public.builder_audit_events (
    organization_id, job_id, event_type, actor_user_id, actor_type,
    previous_value, new_value, change_summary, related_artifact_ids, related_approval_id
  )
  VALUES (
    _approval.organization_id, _approval.job_id, 'approval_approved', _packet.user_id, 'bot',
    jsonb_build_object('status', _approval.triggered_at_status),
    jsonb_build_object('status', _next_status, 'decision', 'approved', 'source', 'routine_monitor'),
    'Bob cleared a routine-repair gate after deterministic risk classification; protected scope remains held for Grandmaster review',
    _approval.reviewed_artifact_ids, _approval.id
  );

  RETURN _job;
END;
$$;

REVOKE ALL ON FUNCTION public.builder_autopilot_decide_approval_guarded(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_autopilot_decide_approval_guarded(uuid, text) TO service_role;

COMMENT ON COLUMN public.bob_friction_packets.repair_risk IS
  'Deterministic repair consequence class. Only routine packets may enter unattended Builder intake.';
COMMENT ON COLUMN public.bob_friction_packets.automation_status IS
  'Durable monitored-error to Builder handoff state; routing alone is not proof that repair started.';
COMMENT ON COLUMN public.builder_jobs.autopilot_source IS
  'chat for an explicit human build request, routine_monitor for a deterministic low-risk monitored defect.';