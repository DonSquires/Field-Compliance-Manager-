-- Owner direction 2026-11-12 (docs/canon/UNIFIED_FIELD_OPERATIONS_MODEL.md): an administrator's
-- "Record admin start" remotely starts the officer's shift in their portal, and "Record admin finish"
-- ends it. The administrator has spoken with the officer by phone, so that confirmation replaces the
-- officer's own pre-start safety briefing acknowledgement and start-position check. The officer's
-- location is captured by their device once their portal reports against the started shift.
-- Rows written before this ruling stay as separate reported times (applied_to_shift = false).

ALTER TABLE public.shift_admin_attendance_events
  ADD COLUMN applied_to_shift boolean NOT NULL DEFAULT false,
  ADD COLUMN site_briefed_by_phone boolean NOT NULL DEFAULT false;

ALTER TABLE public.shift_admin_attendance_events
  DROP CONSTRAINT shift_admin_attendance_events_shift_id_event_type_key;
CREATE UNIQUE INDEX shift_admin_attendance_events_applied_once
  ON public.shift_admin_attendance_events (shift_id, event_type) WHERE applied_to_shift;

COMMENT ON TABLE public.shift_admin_attendance_events IS
  'Append-only record of an administrator starting or finishing an officer''s shift on their behalf (owner direction 2026-11-12). applied_to_shift = true rows started or ended the shift itself; earlier rows (false) are separate reported times only.';
COMMENT ON COLUMN public.shift_admin_attendance_events.applied_to_shift IS
  'True when this event started (actual_start) or finished (actual_end) the shift. False for reported times recorded before the 2026-11-12 ruling.';
COMMENT ON COLUMN public.shift_admin_attendance_events.site_briefed_by_phone IS
  'For admin_start: the administrator confirmed they covered the site risks and safety briefing with the officer by phone.';

ALTER TABLE public.safety_briefing_acknowledgements
  ADD COLUMN acknowledged_via text NOT NULL DEFAULT 'officer_portal'
    CHECK (acknowledged_via IN ('officer_portal', 'admin_phone')),
  ADD COLUMN recorded_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL;

COMMENT ON TABLE public.safety_briefing_acknowledgements IS
  'Receipt that the exact safety briefing (briefing_hash over hazard ids, versions and statuses plus active place warnings) for a shift, or one patrol stop, was read and understood. hazard_snapshot preserves what was shown. Written by acknowledge_safety_briefing (officer_portal) or, for a shift an administrator started after briefing the officer by phone, by record_admin_shift_attendance (admin_phone, recorded_by = administrator).';
COMMENT ON COLUMN public.safety_briefing_acknowledgements.acknowledged_via IS
  'officer_portal = the officer confirmed it in their portal; admin_phone = an administrator briefed the officer by phone and started the shift for them.';

DROP FUNCTION public.record_admin_shift_attendance(uuid, uuid, timestamptz, text, timestamptz, text);

CREATE FUNCTION public.record_admin_shift_attendance(
  p_client_request_id uuid,
  p_shift_id uuid,
  p_expected_updated_at timestamptz,
  p_event_type text,
  p_recorded_at timestamptz,
  p_reason text,
  p_site_briefed_by_phone boolean DEFAULT false
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
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_briefed boolean := coalesce(p_site_briefed_by_phone, false);
  v_request jsonb;
  v_briefing jsonb;
  v_previous_status text;
  v_source text;
BEGIN
  IF v_actor IS NULL OR p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'Authentication and a request ID are required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_shift FROM public.shifts WHERE id = p_shift_id FOR UPDATE;
  IF NOT FOUND OR NOT public.is_admin_for_org(v_shift.organization_id) THEN
    RAISE EXCEPTION 'Roster administrator access required' USING ERRCODE = '42501';
  END IF;

  v_request := jsonb_build_object('shift_id', p_shift_id, 'expected_updated_at', p_expected_updated_at,
    'event_type', p_event_type, 'recorded_at', p_recorded_at, 'reason', v_reason,
    'site_briefed_by_phone', v_briefed);
  v_source := CASE p_event_type WHEN 'admin_start' THEN 'admin_started_officer_shift'
    ELSE 'admin_finished_officer_shift' END;

  SELECT * INTO v_event FROM public.shift_admin_attendance_events
  WHERE organization_id = v_shift.organization_id AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_event.request_fingerprint IS DISTINCT FROM v_request THEN
      RAISE EXCEPTION 'Request ID already used with different attendance details';
    END IF;
    RETURN jsonb_build_object('event_id', v_event.id, 'shift_id', v_event.shift_id,
      'event_type', v_event.event_type, 'recorded_at', v_event.recorded_at,
      'created_at', v_event.created_at, 'replayed', true, 'source', v_source,
      'shift_status', v_shift.status, 'actual_start', v_shift.actual_start, 'actual_end', v_shift.actual_end);
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
  v_previous_status := v_shift.status;

  IF p_event_type = 'admin_start' THEN
    IF v_shift.actual_start IS NOT NULL OR v_shift.status = 'in_progress' THEN
      RAISE EXCEPTION 'This shift has already started';
    END IF;
    IF v_shift.officer_user_id IS NULL THEN
      RAISE EXCEPTION 'Assign an officer before starting this shift';
    END IF;
    IF v_shift.status NOT IN ('scheduled', 'published', 'accepted') THEN
      RAISE EXCEPTION 'A shift cannot be started from status %', v_shift.status;
    END IF;
    IF p_recorded_at < v_shift.scheduled_start - interval '24 hours' THEN
      RAISE EXCEPTION 'The start time is more than 24 hours before the rostered start; check the date';
    END IF;
    IF NOT v_briefed THEN
      RAISE EXCEPTION 'Confirm you briefed the officer on the site and its risks by phone before starting their shift';
    END IF;
    -- shifts_one_at_a_time would end another open shift at "now", overlapping a back-dated start.
    IF EXISTS (SELECT 1 FROM public.shifts other WHERE other.officer_user_id = v_shift.officer_user_id
      AND other.status = 'in_progress' AND other.id <> v_shift.id) THEN
      RAISE EXCEPTION 'This officer is still on another shift; finish that shift first';
    END IF;

    -- The phone briefing is recorded first: shifts_require_safety_briefing checks it when the status changes.
    v_briefing := public.build_shift_safety_briefing(v_shift.id, NULL);
    INSERT INTO public.safety_briefing_acknowledgements (
      organization_id, shift_id, shift_stop_id, officer_user_id, briefing_hash,
      hazard_snapshot, item_count, client_request_id, acknowledged_via, recorded_by
    ) VALUES (
      v_shift.organization_id, v_shift.id, NULL, v_shift.officer_user_id, v_briefing->>'briefing_hash',
      v_briefing, (v_briefing->>'item_count')::integer, p_client_request_id, 'admin_phone', v_actor
    );

    -- This function sends its own officer notice, so the generic shift-change notice is suppressed.
    PERFORM set_config('fcm.silent_shift_notice', 'on', true);
    UPDATE public.shifts
    SET status = 'in_progress', actual_start = p_recorded_at, updated_at = clock_timestamp()
    WHERE id = v_shift.id
    RETURNING * INTO v_shift;
    PERFORM set_config('fcm.silent_shift_notice', 'off', true);

    INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
    VALUES (v_shift.organization_id, v_actor, 'officer_shift_started', 'shifts', v_shift.id,
      jsonb_build_object('previous_status', v_previous_status, 'actual_start', v_shift.actual_start,
        'scheduled_start', v_shift.scheduled_start, 'started_by', 'administrator',
        'officer_user_id', v_shift.officer_user_id, 'reason', v_reason,
        'site_briefed_by_phone', true, 'briefing_hash', v_briefing->>'briefing_hash',
        'start_position', jsonb_build_object('status', 'admin_confirmed_by_phone'),
        'location_capture', 'officer_device_on_next_report',
        'client_request_id', p_client_request_id));

    PERFORM public.enqueue_notification(
      p_organization_id => v_shift.organization_id,
      p_category => 'roster',
      p_title => 'Operations started your shift',
      p_body => 'Your shift was started for you after your phone call with operations. Keep the app open so your location is recorded.',
      p_severity => 'info',
      p_recipient_user_id => v_shift.officer_user_id,
      p_link_page => 'schedule',
      p_link_payload => jsonb_build_object('shift_id', v_shift.id),
      p_dedup_key => 'admin_shift_start:' || v_shift.id::text);
  ELSE
    IF v_shift.status <> 'in_progress' OR v_shift.actual_start IS NULL OR v_shift.actual_end IS NOT NULL THEN
      RAISE EXCEPTION 'Only a started, unfinished shift can be finished';
    END IF;
    -- The supervisor close path ends breaks, completes reached stops, skips the rest and audits it.
    PERFORM set_config('fcm.silent_shift_notice', 'on', true);
    PERFORM public.close_unfinished_officer_shift(p_client_request_id, v_shift.id, v_shift.status,
      v_shift.updated_at, p_recorded_at, v_reason);
    PERFORM set_config('fcm.silent_shift_notice', 'off', true);
    SELECT * INTO v_shift FROM public.shifts WHERE id = p_shift_id;

    PERFORM public.enqueue_notification(
      p_organization_id => v_shift.organization_id,
      p_category => 'roster',
      p_title => 'Operations finished your shift',
      p_body => 'Your shift was finished for you by operations.',
      p_severity => 'info',
      p_recipient_user_id => v_shift.officer_user_id,
      p_link_page => 'schedule',
      p_link_payload => jsonb_build_object('shift_id', v_shift.id),
      p_dedup_key => 'admin_shift_finish:' || v_shift.id::text);
  END IF;

  INSERT INTO public.shift_admin_attendance_events(
    organization_id, shift_id, event_type, recorded_at, reason, created_by,
    client_request_id, request_fingerprint, applied_to_shift, site_briefed_by_phone
  ) VALUES (
    v_shift.organization_id, v_shift.id, p_event_type, p_recorded_at, v_reason,
    v_actor, p_client_request_id, v_request, true, p_event_type = 'admin_start' AND v_briefed
  ) RETURNING * INTO v_event;

  RETURN jsonb_build_object('event_id', v_event.id, 'shift_id', v_event.shift_id,
    'event_type', v_event.event_type, 'recorded_at', v_event.recorded_at,
    'created_at', v_event.created_at, 'replayed', false, 'source', v_source,
    'shift_status', v_shift.status, 'actual_start', v_shift.actual_start, 'actual_end', v_shift.actual_end);
END;
$function$;

COMMENT ON FUNCTION public.record_admin_shift_attendance(uuid, uuid, timestamptz, text, timestamptz, text, boolean) IS
  'Owner direction 2026-11-12. admin_start remotely starts the officer''s shift at the recorded time (requires the administrator''s confirmation that they briefed the officer by phone, which is stored as an admin_phone safety briefing acknowledgement and replaces the officer''s start-position check); admin_finish ends an in-progress shift through close_unfinished_officer_shift. Reasoned, idempotent on client_request_id, audited, and the officer is notified.';
REVOKE ALL ON FUNCTION public.record_admin_shift_attendance(uuid, uuid, timestamptz, text, timestamptz, text, boolean) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.record_admin_shift_attendance(uuid, uuid, timestamptz, text, timestamptz, text, boolean) TO postgres;
GRANT EXECUTE ON FUNCTION public.record_admin_shift_attendance(uuid, uuid, timestamptz, text, timestamptz, text, boolean) TO authenticated;

DROP FUNCTION public.get_roster_admin_attendance(uuid, uuid[]);

CREATE FUNCTION public.get_roster_admin_attendance(
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
  admin_finish_by text,
  location_captured_at timestamptz,
  location_address text
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
    max(actor.display_name) FILTER (WHERE event.event_type = 'admin_finish'),
    max(fix.recorded_at),
    max(fix.physical_address)
  FROM public.shifts shift
  LEFT JOIN public.shift_admin_attendance_events event
    ON event.shift_id = shift.id AND event.applied_to_shift
  LEFT JOIN public.user_profiles actor ON actor.id = event.created_by
  LEFT JOIN LATERAL (
    SELECT gps.recorded_at, gps.physical_address
    FROM public.officer_gps_log gps
    WHERE event.event_type = 'admin_start'
      AND gps.officer_id = shift.officer_user_id
      AND gps.shift_id = shift.id
    ORDER BY gps.recorded_at
    LIMIT 1
  ) fix ON true
  WHERE shift.organization_id = p_organization_id AND shift.id = ANY(p_shift_ids)
  GROUP BY shift.id;
END;
$function$;

COMMENT ON FUNCTION public.get_roster_admin_attendance(uuid, uuid[]) IS
  'Roster administrators: who started or finished each shift on the officer''s behalf, why, and the first device location the officer''s portal reported for an admin-started shift (null until it reports).';
REVOKE ALL ON FUNCTION public.get_roster_admin_attendance(uuid, uuid[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_roster_admin_attendance(uuid, uuid[]) TO postgres;
GRANT EXECUTE ON FUNCTION public.get_roster_admin_attendance(uuid, uuid[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_shift_safety_briefing(p_shift_id uuid, p_stop_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_shift public.shifts%rowtype;
  v_briefing jsonb;
  v_ack public.safety_briefing_acknowledgements%rowtype;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO v_shift FROM public.shifts WHERE id = p_shift_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Shift not found'; END IF;
  IF v_shift.officer_user_id IS DISTINCT FROM v_actor AND NOT public.is_admin_for_org(v_shift.organization_id) THEN
    RAISE EXCEPTION 'Only the assigned officer or an administrator can read this briefing';
  END IF;
  IF p_stop_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.shift_stops WHERE id = p_stop_id AND shift_id = p_shift_id) THEN
    RAISE EXCEPTION 'Stop is not part of this shift';
  END IF;

  v_briefing := public.build_shift_safety_briefing(p_shift_id, p_stop_id);

  SELECT * INTO v_ack
  FROM public.safety_briefing_acknowledgements a
  WHERE a.shift_id = p_shift_id
    AND a.officer_user_id = v_shift.officer_user_id
    AND a.shift_stop_id IS NOT DISTINCT FROM p_stop_id
  ORDER BY a.acknowledged_at DESC
  LIMIT 1;

  RETURN v_briefing || jsonb_build_object(
    'shift_status', v_shift.status,
    'acknowledgement_required', (v_briefing->>'item_count')::int > 0,
    'acknowledged', v_ack.id IS NOT NULL AND v_ack.briefing_hash = v_briefing->>'briefing_hash',
    'acknowledged_at', CASE WHEN v_ack.briefing_hash = v_briefing->>'briefing_hash' THEN v_ack.acknowledged_at END,
    'acknowledged_via', CASE WHEN v_ack.briefing_hash = v_briefing->>'briefing_hash' THEN v_ack.acknowledged_via END,
    'changed_since_acknowledgement', v_ack.id IS NOT NULL AND v_ack.briefing_hash <> v_briefing->>'briefing_hash',
    'is_assigned_officer', v_shift.officer_user_id = v_actor
  );
END;
$function$;
