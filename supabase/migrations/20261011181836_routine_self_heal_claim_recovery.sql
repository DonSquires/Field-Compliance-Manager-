DROP INDEX IF EXISTS public.bob_friction_packets_routine_queue_idx;

CREATE INDEX bob_friction_packets_routine_queue_idx
  ON public.bob_friction_packets (automation_updated_at, created_at)
  WHERE repair_risk = 'routine' AND automation_status IN ('queued', 'claimed');

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
      AND (
        packet.automation_status = 'queued'
        OR (
          packet.automation_status = 'claimed'
          AND packet.automation_updated_at < now() - interval '10 minutes'
        )
      )
      AND packet.route = 'dispatch_flow'
      AND packet.stop_line_hit IS NULL
      AND packet.automation_attempt_count < 5
    ORDER BY packet.automation_updated_at, packet.created_at
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