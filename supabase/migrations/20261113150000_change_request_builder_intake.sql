-- Owner ruling 2026-11-13: every unprotected page change request is routed into
-- the owner's Bob Builder chat for assessment and planning, and a proposed job is
-- opened on autopilot. Protected and stop-line requests stay held for a human.
-- Merge and deployment remain human decisions.

CREATE OR REPLACE FUNCTION public.builder_change_request_owner(_project_id uuid)
RETURNS public.builder_projects
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _project public.builder_projects%rowtype;
BEGIN
  SELECT * INTO _project FROM public.builder_projects WHERE id = _project_id AND status = 'active';
  IF NOT FOUND OR _project.created_by IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.user_profiles
       WHERE id = _project.created_by AND role = 'grand_master' AND deactivated_at IS NULL
     )
     OR NOT public.can_approve_action(_project.created_by, _project.organization_id) THEN
    RAISE EXCEPTION 'Builder project owner must be an active grand master';
  END IF;
  RETURN _project;
END;
$$;

REVOKE ALL ON FUNCTION public.builder_change_request_owner(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_change_request_owner(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.builder_change_request_enqueue(_packet_id uuid, _project_id uuid, _content text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _project public.builder_projects%rowtype;
  _packet public.bob_friction_packets%rowtype;
  _thread uuid;
  _message uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;
  IF _content IS NULL OR char_length(btrim(_content)) = 0 OR char_length(_content) > 20000 THEN
    RAISE EXCEPTION 'Change request brief must be 1-20000 characters';
  END IF;

  _project := public.builder_change_request_owner(_project_id);

  SELECT * INTO _packet FROM public.bob_friction_packets WHERE id = _packet_id FOR UPDATE;
  IF NOT FOUND
     OR _packet.envelope->'during'->'user_report' IS NULL
     OR _packet.disposition <> 'open'
     OR _packet.repair_risk = 'protected'
     OR _packet.stop_line_hit IS NOT NULL
     OR _packet.builder_job_id IS NOT NULL
     OR _packet.automation_status <> 'awaiting_grandmaster'
     OR _packet.automation_attempt_count >= 5 THEN
    RAISE EXCEPTION 'Change request is not eligible for automatic Builder intake';
  END IF;

  SELECT id INTO _thread FROM public.builder_chat_threads
  WHERE created_by = _project.created_by AND status <> 'closed'
  ORDER BY updated_at DESC
  LIMIT 1
  FOR UPDATE;
  IF _thread IS NULL THEN
    INSERT INTO public.builder_chat_threads (created_by, title)
    VALUES (_project.created_by, 'Bob Builder chat')
    RETURNING id INTO _thread;
  END IF;

  INSERT INTO public.builder_chat_messages (thread_id, role, kind, content, payload, status, client_request_id, created_by)
  VALUES (
    _thread, 'owner', 'message', _content,
    jsonb_build_object(
      'context', jsonb_build_object('surface', 'change_request_intake', 'packet_id', _packet.id),
      'change_request', jsonb_build_object('packet_id', _packet.id, 'auto_implement', true)
    ),
    'queued', 'change-request:' || _packet.id::text, _project.created_by
  )
  RETURNING id INTO _message;

  -- Disposition stays with human review; only the automation state moves.
  UPDATE public.bob_friction_packets
  SET automation_status = 'claimed',
      automation_attempt_count = automation_attempt_count + 1,
      automation_error_redacted = NULL,
      automation_updated_at = now()
  WHERE id = _packet.id;

  UPDATE public.builder_chat_threads SET last_activity_at = now(), updated_at = now() WHERE id = _thread;
  RETURN _message;
END;
$$;

REVOKE ALL ON FUNCTION public.builder_change_request_enqueue(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_change_request_enqueue(uuid, uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.builder_change_request_bind_job(_job_id uuid, _packet_id uuid, _message_id uuid)
RETURNS public.builder_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _message public.builder_chat_messages%rowtype;
  _owner uuid;
  _packet public.bob_friction_packets%rowtype;
  _job public.builder_jobs%rowtype;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;

  SELECT m.* INTO _message FROM public.builder_chat_messages m WHERE m.id = _message_id FOR UPDATE;
  SELECT created_by INTO _owner FROM public.builder_chat_threads WHERE id = _message.thread_id;
  IF _message.id IS NULL OR _message.role <> 'owner' OR _message.created_by IS DISTINCT FROM _owner
     OR _message.payload->'change_request'->>'packet_id' IS DISTINCT FROM _packet_id::text THEN
    RAISE EXCEPTION 'Chat message does not belong to this change request';
  END IF;

  SELECT * INTO _packet FROM public.bob_friction_packets WHERE id = _packet_id FOR UPDATE;
  IF NOT FOUND
     OR _packet.automation_status <> 'claimed'
     OR _packet.disposition <> 'open'
     OR _packet.repair_risk = 'protected'
     OR _packet.stop_line_hit IS NOT NULL
     OR _packet.builder_job_id IS NOT NULL THEN
    RAISE EXCEPTION 'Change request is not claimed for automatic Builder intake';
  END IF;

  SELECT * INTO _job FROM public.builder_jobs WHERE id = _job_id FOR UPDATE;
  IF NOT FOUND OR _job.status IN ('failed', 'cancelled', 'deployed') OR _job.source_friction_packet_id IS NOT NULL THEN
    RAISE EXCEPTION 'Builder job is unavailable';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM public.user_profiles WHERE id = _owner AND role = 'grand_master' AND deactivated_at IS NULL
     ) OR NOT public.can_approve_action(_owner, _job.organization_id) THEN
    RAISE EXCEPTION 'Builder project owner must be an active grand master';
  END IF;

  -- A NULL source keeps owner-chat autopilot semantics: release stays human.
  UPDATE public.builder_jobs
  SET autopilot_requested_by = _owner,
      autopilot_conversation_id = NULL,
      autopilot_source = NULL,
      source_friction_packet_id = _packet.id,
      repair_risk = _packet.repair_risk,
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

  UPDATE public.builder_chat_messages
  SET payload = payload || jsonb_build_object('job_id', _job.id, 'accepted_by', _owner, 'accepted_at', now())
  WHERE thread_id = _message.thread_id AND kind = 'proposal'
    AND payload->>'message_id' = _message.id::text AND NOT (payload ? 'job_id');

  INSERT INTO public.builder_audit_events (
    organization_id, job_id, event_type, actor_user_id, actor_type, new_value, change_summary
  )
  VALUES (
    _job.organization_id, _job.id, 'builder_job_policy_bound', _owner, 'bot',
    jsonb_build_object('autopilot_source', 'chat', 'source_friction_packet_id', _packet.id,
      'repair_risk', _packet.repair_risk, 'chat_message_id', _message.id),
    'Bob automatically opened a Builder job from a page change request; merge and deployment remain human'
  );

  RETURN _job;
END;
$$;

REVOKE ALL ON FUNCTION public.builder_change_request_bind_job(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_change_request_bind_job(uuid, uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.builder_change_request_park(_packet_id uuid, _reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;
  UPDATE public.bob_friction_packets
  SET automation_status = 'failed',
      automation_error_redacted = left(coalesce(nullif(btrim(_reason), ''), 'Automatic Builder intake stopped'), 300),
      automation_updated_at = now()
  WHERE id = _packet_id AND builder_job_id IS NULL AND automation_status IN ('claimed', 'failed');
END;
$$;

REVOKE ALL ON FUNCTION public.builder_change_request_park(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_change_request_park(uuid, text) TO service_role;

-- Parks routed requests whose Builder chat turn never settled (worker restart, lost claim), so none stays claimed.
CREATE OR REPLACE FUNCTION public.builder_change_request_park_stale(_older_than_minutes integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _count integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;
  UPDATE public.bob_friction_packets
  SET automation_status = 'failed',
      automation_error_redacted = 'Builder chat turn did not finish',
      automation_updated_at = now()
  WHERE automation_status = 'claimed'
    AND builder_job_id IS NULL
    AND envelope->'during'->'user_report' IS NOT NULL
    AND automation_updated_at < now() - make_interval(mins => greatest(coalesce(_older_than_minutes, 180), 30));
  GET DIAGNOSTICS _count = ROW_COUNT;
  RETURN _count;
END;
$$;

REVOKE ALL ON FUNCTION public.builder_change_request_park_stale(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_change_request_park_stale(integer) TO service_role;
