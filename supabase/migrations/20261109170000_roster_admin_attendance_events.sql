CREATE TABLE public.shift_admin_attendance_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  shift_id uuid NOT NULL REFERENCES public.shifts(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('admin_start', 'admin_finish')),
  recorded_at timestamptz NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 5 AND 1000),
  created_by uuid NOT NULL REFERENCES public.user_profiles(id),
  client_request_id uuid NOT NULL,
  request_fingerprint jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, client_request_id),
  UNIQUE (shift_id, event_type)
);

ALTER TABLE public.shift_admin_attendance_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.shift_admin_attendance_events FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.record_admin_shift_attendance(
  p_client_request_id uuid,
  p_shift_id uuid,
  p_expected_updated_at timestamptz,
  p_event_type text,
  p_recorded_at timestamptz,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_shift public.shifts%rowtype;
  v_event public.shift_admin_attendance_events%rowtype;
  v_start timestamptz;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_request jsonb;
BEGIN
  IF v_actor IS NULL OR p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'Authentication and a request ID are required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_shift FROM public.shifts WHERE id = p_shift_id FOR UPDATE;
  IF NOT FOUND OR NOT public.is_admin_for_org(v_shift.organization_id) THEN
    RAISE EXCEPTION 'Roster administrator access required' USING ERRCODE = '42501';
  END IF;

  v_request := jsonb_build_object('shift_id', p_shift_id, 'expected_updated_at', p_expected_updated_at,
    'event_type', p_event_type, 'recorded_at', p_recorded_at, 'reason', v_reason);
  SELECT * INTO v_event FROM public.shift_admin_attendance_events
  WHERE organization_id = v_shift.organization_id AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_event.request_fingerprint IS DISTINCT FROM v_request THEN
      RAISE EXCEPTION 'Request ID already used with different attendance details';
    END IF;
    RETURN jsonb_build_object('event_id', v_event.id, 'shift_id', v_event.shift_id,
      'event_type', v_event.event_type, 'recorded_at', v_event.recorded_at,
      'created_at', v_event.created_at, 'replayed', true,
      'source', 'admin_recorded_not_officer_attendance');
  END IF;

  IF v_shift.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'Shift changed since it was opened; reload before recording a time';
  END IF;
  IF p_event_type IS NULL OR p_event_type NOT IN ('admin_start', 'admin_finish') THEN
    RAISE EXCEPTION 'Choose an admin start or admin finish event';
  END IF;
  IF p_recorded_at IS NULL OR p_recorded_at > clock_timestamp() THEN
    RAISE EXCEPTION 'The admin-recorded time must be in the past';
  END IF;
  IF v_reason IS NULL OR length(v_reason) < 5 OR length(v_reason) > 1000 THEN
    RAISE EXCEPTION 'A reason of 5 to 1000 characters is required';
  END IF;
  IF v_shift.status IN ('cancelled', 'declined', 'missed', 'completed') THEN
    RAISE EXCEPTION 'Closed, cancelled, declined or missed shifts cannot receive an admin attendance time';
  END IF;

  IF p_event_type = 'admin_start' THEN
    IF v_shift.actual_start IS NOT NULL OR EXISTS (
      SELECT 1 FROM public.shift_admin_attendance_events
      WHERE shift_id = v_shift.id AND event_type = 'admin_start'
    ) THEN
      RAISE EXCEPTION 'A start time is already recorded; use the governed correction workflow';
    END IF;
  ELSE
    IF v_shift.actual_end IS NOT NULL OR EXISTS (
      SELECT 1 FROM public.shift_admin_attendance_events
      WHERE shift_id = v_shift.id AND event_type = 'admin_finish'
    ) THEN
      RAISE EXCEPTION 'A finish time is already recorded; use the governed correction workflow';
    END IF;
    SELECT coalesce(v_shift.actual_start, event.recorded_at) INTO v_start
    FROM (SELECT p_recorded_at AS placeholder) unused
    LEFT JOIN public.shift_admin_attendance_events event
      ON event.shift_id = v_shift.id AND event.event_type = 'admin_start';
    IF v_start IS NULL OR p_recorded_at <= v_start THEN
      RAISE EXCEPTION 'A finish time must follow the recorded start time';
    END IF;
  END IF;

  INSERT INTO public.shift_admin_attendance_events(
    organization_id, shift_id, event_type, recorded_at, reason, created_by,
    client_request_id, request_fingerprint
  ) VALUES (
    v_shift.organization_id, v_shift.id, p_event_type, p_recorded_at, v_reason,
    v_actor, p_client_request_id, v_request
  ) RETURNING * INTO v_event;

  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_shift.organization_id, v_actor, 'shift_admin_attendance_recorded', 'shifts', v_shift.id,
    jsonb_build_object('event_id', v_event.id, 'event_type', p_event_type,
      'recorded_at', p_recorded_at, 'reason', v_reason,
      'source', 'admin_recorded_not_officer_attendance',
      'actual_start_before', v_shift.actual_start,
      'actual_end_before', v_shift.actual_end));

  RETURN jsonb_build_object('event_id', v_event.id, 'shift_id', v_event.shift_id,
    'event_type', v_event.event_type, 'recorded_at', v_event.recorded_at,
    'created_at', v_event.created_at, 'replayed', false,
    'source', 'admin_recorded_not_officer_attendance');
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_roster_admin_attendance(
  p_organization_id uuid,
  p_shift_ids uuid[]
)
RETURNS TABLE(
  shift_id uuid,
  admin_start timestamptz,
  admin_start_reason text,
  admin_start_by text,
  admin_finish timestamptz,
  admin_finish_reason text,
  admin_finish_by text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN
    RAISE EXCEPTION 'Roster administrator access required' USING ERRCODE = '42501';
  END IF;
  IF p_shift_ids IS NULL OR cardinality(p_shift_ids) > 500 OR EXISTS (
    SELECT 1 FROM unnest(p_shift_ids) requested(id)
    LEFT JOIN public.shifts shift ON shift.id = requested.id
    WHERE shift.id IS NULL OR shift.organization_id <> p_organization_id
  ) THEN
    RAISE EXCEPTION 'Shift list is invalid for this organization';
  END IF;

  RETURN QUERY
  SELECT shift.id,
    max(event.recorded_at) FILTER (WHERE event.event_type = 'admin_start'),
    max(event.reason) FILTER (WHERE event.event_type = 'admin_start'),
    max(actor.display_name) FILTER (WHERE event.event_type = 'admin_start'),
    max(event.recorded_at) FILTER (WHERE event.event_type = 'admin_finish'),
    max(event.reason) FILTER (WHERE event.event_type = 'admin_finish'),
    max(actor.display_name) FILTER (WHERE event.event_type = 'admin_finish')
  FROM public.shifts shift
  LEFT JOIN public.shift_admin_attendance_events event ON event.shift_id = shift.id
  LEFT JOIN public.user_profiles actor ON actor.id = event.created_by
  WHERE shift.organization_id = p_organization_id AND shift.id = ANY(p_shift_ids)
  GROUP BY shift.id;
END;
$function$;

COMMENT ON TABLE public.shift_admin_attendance_events IS
  'Append-only administrative time reports for roster shifts. These are not officer attendance, GPS, site arrival/departure, or payable-hour evidence.';
COMMENT ON FUNCTION public.record_admin_shift_attendance(uuid, uuid, timestamptz, text, timestamptz, text) IS
  'Records one reasoned, idempotent admin start or finish event without changing officer attendance timestamps, shift status, stops, breaks, or payroll hours.';
REVOKE ALL ON FUNCTION public.record_admin_shift_attendance(uuid, uuid, timestamptz, text, timestamptz, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.record_admin_shift_attendance(uuid, uuid, timestamptz, text, timestamptz, text) TO postgres;
GRANT EXECUTE ON FUNCTION public.record_admin_shift_attendance(uuid, uuid, timestamptz, text, timestamptz, text) TO authenticated;
REVOKE ALL ON FUNCTION public.get_roster_admin_attendance(uuid, uuid[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_roster_admin_attendance(uuid, uuid[]) TO postgres;
GRANT EXECUTE ON FUNCTION public.get_roster_admin_attendance(uuid, uuid[]) TO authenticated;