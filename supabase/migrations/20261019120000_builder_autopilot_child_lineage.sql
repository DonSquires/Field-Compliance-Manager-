CREATE OR REPLACE FUNCTION public.builder_create_autopilot_child(
  _parent_job_id uuid,
  _target_sha text,
  _title text,
  _task_description text,
  _description text DEFAULT NULL,
  _frontend_required boolean DEFAULT true,
  _backend_required boolean DEFAULT false,
  _code_review_mode text DEFAULT 'independent_ai'
)
RETURNS public.builder_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _parent public.builder_jobs;
  _child public.builder_jobs;
  _child_description text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  SELECT * INTO _parent FROM public.builder_jobs WHERE id = _parent_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Parent Builder job is unavailable'; END IF;
  IF _parent.status IN ('cancelled', 'deployed') THEN RAISE EXCEPTION 'Parent Builder job cannot be continued'; END IF;
  IF _parent.autopilot_source = 'main_monitor' THEN RAISE EXCEPTION 'Main-health repairs require the main-health repair path'; END IF;
  IF _parent.autopilot_requested_by IS NULL
     OR NOT public.can_approve_action(_parent.autopilot_requested_by, _parent.organization_id) THEN
    RAISE EXCEPTION 'Parent autopilot requester cannot approve Builder work for this organisation';
  END IF;
  IF NULLIF(btrim(_title), '') IS NULL OR NULLIF(btrim(_task_description), '') IS NULL THEN
    RAISE EXCEPTION 'Title and task description are required';
  END IF;
  IF _target_sha IS NULL OR _target_sha !~ '^[a-f0-9]{40}$' THEN
    RAISE EXCEPTION 'A full lowercase Git target SHA is required';
  END IF;
  IF _parent.code_review_mode = 'human' AND _code_review_mode IS DISTINCT FROM 'human'
     OR _parent.code_review_mode = 'independent_ai' AND _code_review_mode = 'none' THEN
    RAISE EXCEPTION 'Parent code-review policy cannot be weakened';
  END IF;
  _child_description := COALESCE(NULLIF(btrim(_description), ''), 'Opened by Bob''s autopilot from job ' || _parent.id || '.');

  -- A retry after a lost response reuses the pinned child, even if main has moved again.
  SELECT * INTO _child FROM public.builder_jobs
  WHERE parent_job_id = _parent.id
    AND title = btrim(_title)
    AND task_description = btrim(_task_description)
    AND description = _child_description
    AND frontend_required = _frontend_required
    AND backend_required = _backend_required
    AND code_review_mode = _code_review_mode
  ORDER BY created_at LIMIT 1;
  IF FOUND THEN RETURN _child; END IF;

  SELECT * INTO _child FROM public.builder_create_job_v2(
    _parent.organization_id, _parent.project_id, _title, _task_description,
    _target_sha, 'main', _child_description, _frontend_required, _backend_required,
    _code_review_mode, _parent.task_run_id, _parent.requested_action, _parent.target_environment
  );
  PERFORM public.builder_autopilot_bind(
    _child.id, _parent.autopilot_requested_by, _parent.autopilot_conversation_id
  );
  UPDATE public.builder_jobs
  SET parent_job_id = _parent.id,
      autopilot_source = _parent.autopilot_source,
      source_friction_packet_id = _parent.source_friction_packet_id,
      repair_risk = _parent.repair_risk
  WHERE id = _child.id
  RETURNING * INTO _child;

  INSERT INTO public.builder_audit_events (
    organization_id, job_id, event_type, actor_type, new_value, change_summary
  ) VALUES (
    _child.organization_id, _child.id, 'builder_job_policy_bound', 'bot',
    jsonb_build_object('parent_job_id', _parent.id, 'target_sha', _child.target_sha,
      'autopilot_source', _child.autopilot_source),
    'Automatic Builder continuation linked and bound atomically; release controls remain unchanged'
  );
  RETURN _child;
END;
$$;

REVOKE ALL ON FUNCTION public.builder_create_autopilot_child(uuid, text, text, text, text, boolean, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_create_autopilot_child(uuid, text, text, text, text, boolean, boolean, text) TO service_role;
