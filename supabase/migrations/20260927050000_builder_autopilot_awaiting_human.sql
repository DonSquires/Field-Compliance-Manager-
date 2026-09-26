-- Owner ruling (2026-09-26): "human approval is required for evidential work".
--
-- Bob's autopilot may still clear the specification and release gates on the
-- requester's standing chat instruction for ordinary changes, but when a job
-- touches evidential work (capture, CCTV/photo/video inference, incidents and
-- breaches, notices and infringements, patrol and dispatch records,
-- observations, report packs, audit trails — builder-path-policy.js
-- isEvidentialPath) it parks the job as 'awaiting_human' and a person decides
-- the gate through builder_decide_approval. The autopilot resumes only after
-- that decision. Canon: docs/canon/BOB_DOCTRINE.md §9 (2026-09-26 addendum).

ALTER TABLE public.builder_jobs DROP CONSTRAINT IF EXISTS builder_jobs_autopilot_state_check;
ALTER TABLE public.builder_jobs
  ADD CONSTRAINT builder_jobs_autopilot_state_check
  CHECK (autopilot_state IS NULL OR autopilot_state IN ('driving', 'awaiting_human', 'published', 'blocked', 'done'));

CREATE OR REPLACE FUNCTION public.builder_autopilot_record(_job_id uuid, _state text, _report jsonb DEFAULT NULL)
RETURNS public.builder_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _job public.builder_jobs%rowtype;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  IF _state NOT IN ('driving', 'awaiting_human', 'published', 'blocked', 'done') THEN RAISE EXCEPTION 'Unsupported autopilot state'; END IF;
  UPDATE public.builder_jobs
  SET autopilot_state = _state,
      autopilot_report = COALESCE(_report, autopilot_report),
      autopilot_reported_at = CASE WHEN _report IS NOT NULL THEN NULL ELSE autopilot_reported_at END,
      autopilot_updated_at = now(),
      updated_at = now()
  WHERE id = _job_id AND autopilot_requested_by IS NOT NULL RETURNING * INTO _job;
  IF _job.id IS NULL THEN RAISE EXCEPTION 'Builder job is not under Bob autopilot'; END IF;
  IF _state = 'awaiting_human' THEN
    INSERT INTO public.builder_audit_events (organization_id, job_id, event_type, actor_type, new_value, change_summary)
    VALUES (_job.organization_id, _job.id, 'approval_requested', 'bot',
      jsonb_build_object('autopilot_state', _state, 'gate', _report->>'gate', 'evidential_files', COALESCE(_report->'evidential_files', '[]'::jsonb)),
      'Bob autopilot paused: this job touches evidential work, so a human must decide the ' || COALESCE(_report->>'gate', 'approval') || ' gate (owner ruling 2026-09-26)');
  END IF;
  RETURN _job;
END;
$$;
REVOKE ALL ON FUNCTION public.builder_autopilot_record(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_autopilot_record(uuid, text, jsonb) TO service_role;
