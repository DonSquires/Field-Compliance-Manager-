-- Routine self-heal retries what it could not fix once the code that judged the failure has changed.
--
-- Live 2026-11-02: three routine packets (/admin/hub, /admin/module-subscriptions,
-- /admin/platform-subscribers) failed after one attempt and stayed `failed` with disposition `open`,
-- so Dr Bob folded every recurrence into a dead packet and no repair was ever tried again. The same
-- day the autopilot could not open a continuation for routine repair 7c6c68b6:
-- `duplicate key value violates unique constraint "builder_jobs_source_friction_packet_unique"`,
-- because builder_create_autopilot_child copies the parent's packet onto the child.
--
-- 1. One live intake job per packet: continuations (parent_job_id set) share their root's packet, and
--    a failed or cancelled root releases it for a new bounded attempt.
-- 2. builder_requeue_failed_routine_repairs gives a failed routine packet one more attempt per verified
--    production release, at most three attempts in total, within 21 days of the report. Only the
--    service identity may call it; every requeue is audited against the job that last tried.

DROP INDEX IF EXISTS public.builder_jobs_source_friction_packet_unique;
CREATE UNIQUE INDEX builder_jobs_source_friction_packet_unique
  ON public.builder_jobs (source_friction_packet_id)
  WHERE source_friction_packet_id IS NOT NULL
    AND parent_job_id IS NULL
    AND status NOT IN ('failed', 'cancelled');

COMMENT ON INDEX public.builder_jobs_source_friction_packet_unique IS
  'One live intake job per monitored packet. Continuations share the root packet; a failed or cancelled root releases it for a retry.';

-- One statement replaces the event-type check: the full existing list plus routine_repair_requeued.
ALTER TABLE public.builder_audit_events
  DROP CONSTRAINT IF EXISTS builder_audit_events_event_type_check,
  ADD CONSTRAINT builder_audit_events_event_type_check CHECK (event_type = ANY (ARRAY[
  'job_created', 'job_status_changed', 'step_started', 'step_completed', 'step_failed', 'step_blocked',
  'artifact_created', 'approval_requested', 'approval_approved', 'approval_rejected',
  'model_run_started', 'model_run_completed', 'model_run_failed', 'error_recorded', 'job_cancelled',
  'builder_job_policy_bound', 'routine_repair_requeued'
]::text[]));

CREATE OR REPLACE FUNCTION public.builder_requeue_failed_routine_repairs(
  _release_sha text,
  _released_at timestamptz,
  _limit integer DEFAULT 3
)
RETURNS SETOF public.bob_friction_packets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _candidate record;
  _packet public.bob_friction_packets%rowtype;
  _last_job public.builder_jobs%rowtype;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;
  IF _release_sha IS NULL OR _release_sha !~ '^[a-f0-9]{40}$' THEN
    RAISE EXCEPTION 'A full lowercase release SHA is required';
  END IF;
  IF _released_at IS NULL OR _released_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'A past release time is required';
  END IF;

  FOR _candidate IN
    SELECT packet.id, packet.covered_by_job_id
    FROM public.bob_friction_packets packet
    WHERE packet.automation_status = 'failed'
      AND packet.repair_risk = 'routine'
      AND packet.route = 'dispatch_flow'
      AND packet.stop_line_hit IS NULL
      AND packet.disposition IN ('open', 'reviewing')
      AND packet.automation_attempt_count < 3
      -- It failed under code that has since been replaced; a failure under this release waits for the next.
      AND packet.automation_updated_at < _released_at
      AND packet.created_at > now() - interval '21 days'
      AND NOT EXISTS (
        SELECT 1 FROM public.builder_jobs job
        WHERE (job.source_friction_packet_id = packet.id OR job.id = packet.covered_by_job_id)
          AND job.status NOT IN ('failed', 'cancelled', 'deployed')
      )
    ORDER BY packet.automation_updated_at, packet.created_at
    LIMIT LEAST(GREATEST(COALESCE(_limit, 3), 1), 10)
    FOR UPDATE OF packet SKIP LOCKED
  LOOP
    UPDATE public.bob_friction_packets packet
    SET automation_status = 'queued',
        covered_by_job_id = NULL,
        automation_error_redacted = left('Re-queued after release ' || left(_release_sha, 8)
          || ' for attempt ' || (packet.automation_attempt_count + 1) || ' of 3.', 300),
        automation_updated_at = now()
    WHERE packet.id = _candidate.id
    RETURNING packet.* INTO _packet;

    -- The job that last tried: the packet's own intake chain, or the repair that covered it.
    SELECT * INTO _last_job
    FROM public.builder_jobs job
    WHERE job.source_friction_packet_id = _packet.id
       OR job.id = _packet.builder_job_id
       OR job.id = _candidate.covered_by_job_id
    ORDER BY job.updated_at DESC
    LIMIT 1;

    IF FOUND THEN
      INSERT INTO public.builder_audit_events (
        organization_id, job_id, event_type, actor_user_id, actor_type,
        previous_value, new_value, change_summary
      ) VALUES (
        _last_job.organization_id, _last_job.id, 'routine_repair_requeued', _packet.user_id, 'bot',
        jsonb_build_object('packet_id', _packet.id, 'automation_status', 'failed', 'job_status', _last_job.status),
        jsonb_build_object('packet_id', _packet.id, 'automation_status', 'queued',
          'release_sha', _release_sha, 'next_attempt', _packet.automation_attempt_count + 1, 'max_attempts', 3),
        'Bob re-queued a failed routine repair after a verified production release; the next attempt is bounded by the same routine policy'
      );
    END IF;

    RETURN NEXT _packet;
  END LOOP;
END;
$function$;

COMMENT ON FUNCTION public.builder_requeue_failed_routine_repairs(text, timestamptz, integer) IS
  'Service-only. Re-queues failed routine friction packets once per verified production release (at most 3 attempts, 21 days) and audits each requeue.';

REVOKE ALL ON FUNCTION public.builder_requeue_failed_routine_repairs(text, timestamptz, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.builder_requeue_failed_routine_repairs(text, timestamptz, integer) TO service_role;
