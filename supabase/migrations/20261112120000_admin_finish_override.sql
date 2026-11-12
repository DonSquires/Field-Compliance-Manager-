-- Owner direction 2026-11-12: an administrator can override the open-work restrictions and finish an
-- officer's shift remotely (forgot to log off, phone went flat, could not finish properly). Open dispatch
-- jobs return to the dispatch queue, open welfare alerts are resolved only after the administrator confirms
-- the officer is safe, and the officer's last GPS breadcrumb at or before the finish time is recorded as the
-- finish location. Lock waits fail fast instead of running into the role statement timeout.

ALTER TABLE public.shift_admin_attendance_events
  ADD COLUMN officer_safety_confirmed boolean NOT NULL DEFAULT false,
  ADD COLUMN released_dispatch_job_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN resolved_welfare_alert_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN finish_location_gps_log_id uuid REFERENCES public.officer_gps_log(id) ON DELETE SET NULL,
  ADD COLUMN finish_location_recorded_at timestamptz,
  ADD COLUMN finish_location_lat double precision,
  ADD COLUMN finish_location_lng double precision,
  ADD COLUMN finish_location_accuracy_m double precision,
  ADD COLUMN finish_location_address text,
  ADD CONSTRAINT shift_admin_attendance_events_finish_override_only_on_finish CHECK (
    event_type = 'admin_finish' OR (
      NOT officer_safety_confirmed AND cardinality(released_dispatch_job_ids) = 0
      AND cardinality(resolved_welfare_alert_ids) = 0 AND finish_location_recorded_at IS NULL
      AND finish_location_lat IS NULL AND finish_location_lng IS NULL));

CREATE INDEX IF NOT EXISTS shift_admin_attendance_events_finish_gps_idx
  ON public.shift_admin_attendance_events (finish_location_gps_log_id)
  WHERE finish_location_gps_log_id IS NOT NULL;

COMMENT ON COLUMN public.shift_admin_attendance_events.officer_safety_confirmed IS
  'admin_finish only: the administrator confirmed the officer is safe, which resolves the shift''s open welfare alerts.';
COMMENT ON COLUMN public.shift_admin_attendance_events.released_dispatch_job_ids IS
  'admin_finish only: open dispatch jobs detached from the shift and returned to the dispatch queue.';
COMMENT ON COLUMN public.shift_admin_attendance_events.resolved_welfare_alert_ids IS
  'admin_finish only: welfare alerts resolved on the administrator''s safety confirmation.';
COMMENT ON COLUMN public.shift_admin_attendance_events.finish_location_gps_log_id IS
  'admin_finish only: the officer''s last GPS breadcrumb at or before the finish time (null when none was reported).';
COMMENT ON COLUMN public.shift_admin_attendance_events.finish_location_recorded_at IS
  'When the officer''s device recorded the finish-location breadcrumb; it may be earlier than recorded_at when the phone stopped reporting.';

CREATE OR REPLACE FUNCTION public.get_admin_shift_finish_preview(p_shift_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_shift public.shifts%rowtype;
  v_fix public.officer_gps_log%rowtype;
BEGIN
  SELECT * INTO v_shift FROM public.shifts WHERE id = p_shift_id;
  IF auth.uid() IS NULL OR NOT FOUND OR NOT public.is_admin_for_org(v_shift.organization_id) THEN
    RAISE EXCEPTION 'Roster administrator access required' USING ERRCODE = '42501';
  END IF;

  SELECT gps.* INTO v_fix FROM public.officer_gps_log gps
  WHERE gps.organization_id = v_shift.organization_id
    AND gps.officer_id = v_shift.officer_user_id
    AND gps.recorded_at >= coalesce(v_shift.actual_start, v_shift.scheduled_start) - interval '1 hour'
    AND gps.recorded_at <= clock_timestamp()
  ORDER BY gps.recorded_at DESC
  LIMIT 1;

  RETURN jsonb_build_object(
    'shift_id', v_shift.id,
    'open_dispatch_jobs', (SELECT count(*) FROM public.dispatch_jobs j
      WHERE j.shift_id = v_shift.id AND j.status NOT IN ('completed', 'cancelled')),
    'open_welfare_alerts', (SELECT count(*) FROM public.welfare_alerts w
      WHERE w.shift_id = v_shift.id AND w.status <> 'resolved'),
    'last_location', CASE WHEN v_fix.id IS NULL THEN NULL ELSE jsonb_build_object(
      'recorded_at', v_fix.recorded_at, 'address', v_fix.physical_address,
      'accuracy_m', v_fix.accuracy_meters) END);
END;
$$;

COMMENT ON FUNCTION public.get_admin_shift_finish_preview(uuid) IS
  'Owner direction 2026-11-12. Roster administrators: what an admin finish will override on this shift (open dispatch jobs and welfare alerts) and the officer''s latest GPS breadcrumb, before they confirm.';
REVOKE ALL ON FUNCTION public.get_admin_shift_finish_preview(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_admin_shift_finish_preview(uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.get_admin_shift_finish_preview(uuid) TO authenticated;

DROP FUNCTION public.record_admin_shift_attendance(uuid, uuid, timestamptz, text, timestamptz, text, boolean);

CREATE FUNCTION public.record_admin_shift_attendance(
  p_client_request_id uuid,
  p_shift_id uuid,
  p_expected_updated_at timestamptz,
  p_event_type text,
  p_recorded_at timestamptz,
  p_reason text,
  p_site_briefed_by_phone boolean DEFAULT false,
  p_officer_safety_confirmed boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
SET lock_timeout TO '3s'
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_shift public.shifts%rowtype;
  v_event public.shift_admin_attendance_events%rowtype;
  v_fix public.officer_gps_log%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_briefed boolean := coalesce(p_site_briefed_by_phone, false);
  v_safe boolean := coalesce(p_officer_safety_confirmed, false);
  v_request jsonb;
  v_briefing jsonb;
  v_previous_status text;
  v_source text;
  v_released uuid[] := '{}';
  v_resolved uuid[] := '{}';
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
  -- Added only when confirmed, so requests recorded before this override existed still replay.
  IF v_safe THEN
    v_request := v_request || jsonb_build_object('officer_safety_confirmed', true);
  END IF;
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
      'shift_status', v_shift.status, 'actual_start', v_shift.actual_start, 'actual_end', v_shift.actual_end,
      'released_dispatch_jobs', cardinality(v_event.released_dispatch_job_ids),
      'resolved_welfare_alerts', cardinality(v_event.resolved_welfare_alert_ids),
      'finish_location', CASE WHEN v_event.finish_location_recorded_at IS NULL THEN NULL ELSE jsonb_build_object(
        'recorded_at', v_event.finish_location_recorded_at, 'lat', v_event.finish_location_lat,
        'lng', v_event.finish_location_lng, 'accuracy_m', v_event.finish_location_accuracy_m,
        'address', v_event.finish_location_address) END);
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
    IF v_safe THEN
      RAISE EXCEPTION 'The officer safety confirmation applies only to finishing a shift';
    END IF;
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
    IF p_recorded_at <= v_shift.actual_start THEN
      RAISE EXCEPTION 'The finish time must be after the shift started';
    END IF;

    -- Override: an officer who cannot finish properly must not leave their shift open behind them.
    IF EXISTS (SELECT 1 FROM public.welfare_alerts w WHERE w.shift_id = v_shift.id AND w.status <> 'resolved')
      AND NOT v_safe THEN
      RAISE EXCEPTION 'This shift has open welfare alerts. Confirm you have checked the officer is safe before finishing it';
    END IF;

    WITH resolved AS (
      UPDATE public.welfare_alerts w
      SET status = 'resolved', resolved_at = clock_timestamp(), resolved_by = v_actor,
        resolution_notes = concat_ws(E'\n', nullif(w.resolution_notes, ''),
          'Resolved when operations finished the shift; officer confirmed safe: ' || v_reason)
      WHERE w.shift_id = v_shift.id AND w.status <> 'resolved'
      RETURNING w.id
    )
    SELECT coalesce(array_agg(id), '{}') INTO v_resolved FROM resolved;

    -- Jobs keep their timestamps as evidence; the officer link is cleared so dispatch can reassign them.
    WITH released AS (
      UPDATE public.dispatch_jobs j
      SET status = CASE WHEN j.status = 'pending_approval' THEN 'pending_approval' ELSE 'pending' END,
        shift_id = NULL, shift_stop_id = NULL, assigned_officer_id = NULL, dispatch_resource_id = NULL,
        outcome_notes = concat_ws(E'\n', nullif(j.outcome_notes, ''),
          'Returned to the dispatch queue when operations finished the officer''s shift: ' || v_reason)
      WHERE j.shift_id = v_shift.id AND j.status NOT IN ('completed', 'cancelled')
      RETURNING j.id
    )
    SELECT coalesce(array_agg(id), '{}') INTO v_released FROM released;

    SELECT gps.* INTO v_fix FROM public.officer_gps_log gps
    WHERE gps.organization_id = v_shift.organization_id
      AND gps.officer_id = v_shift.officer_user_id
      AND gps.recorded_at >= v_shift.actual_start - interval '1 hour'
      AND gps.recorded_at <= p_recorded_at
    ORDER BY gps.recorded_at DESC
    LIMIT 1;

    -- The supervisor close path ends breaks, completes reached stops, skips the rest and audits it.
    PERFORM set_config('fcm.silent_shift_notice', 'on', true);
    PERFORM public.close_unfinished_officer_shift(p_client_request_id, v_shift.id, v_shift.status,
      v_shift.updated_at, p_recorded_at, v_reason);
    PERFORM set_config('fcm.silent_shift_notice', 'off', true);
    SELECT * INTO v_shift FROM public.shifts WHERE id = p_shift_id;

    INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
    VALUES (v_shift.organization_id, v_actor, 'officer_shift_finished_by_admin', 'shifts', v_shift.id,
      jsonb_build_object('reason', v_reason, 'actual_end', v_shift.actual_end,
        'officer_user_id', v_shift.officer_user_id, 'officer_safety_confirmed', v_safe,
        'released_dispatch_job_ids', to_jsonb(v_released), 'resolved_welfare_alert_ids', to_jsonb(v_resolved),
        'finish_location_gps_log_id', v_fix.id, 'finish_location_recorded_at', v_fix.recorded_at,
        'client_request_id', p_client_request_id));

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
    client_request_id, request_fingerprint, applied_to_shift, site_briefed_by_phone,
    officer_safety_confirmed, released_dispatch_job_ids, resolved_welfare_alert_ids,
    finish_location_gps_log_id, finish_location_recorded_at, finish_location_lat, finish_location_lng,
    finish_location_accuracy_m, finish_location_address
  ) VALUES (
    v_shift.organization_id, v_shift.id, p_event_type, p_recorded_at, v_reason,
    v_actor, p_client_request_id, v_request, true, p_event_type = 'admin_start' AND v_briefed,
    p_event_type = 'admin_finish' AND v_safe, v_released, v_resolved,
    v_fix.id, v_fix.recorded_at, v_fix.gps_lat, v_fix.gps_lng, v_fix.accuracy_meters, v_fix.physical_address
  ) RETURNING * INTO v_event;

  RETURN jsonb_build_object('event_id', v_event.id, 'shift_id', v_event.shift_id,
    'event_type', v_event.event_type, 'recorded_at', v_event.recorded_at,
    'created_at', v_event.created_at, 'replayed', false, 'source', v_source,
    'shift_status', v_shift.status, 'actual_start', v_shift.actual_start, 'actual_end', v_shift.actual_end,
    'released_dispatch_jobs', cardinality(v_released),
    'resolved_welfare_alerts', cardinality(v_resolved),
    'finish_location', CASE WHEN v_fix.id IS NULL THEN NULL ELSE jsonb_build_object(
      'recorded_at', v_fix.recorded_at, 'lat', v_fix.gps_lat, 'lng', v_fix.gps_lng,
      'accuracy_m', v_fix.accuracy_meters, 'address', v_fix.physical_address) END);
END;
$$;

COMMENT ON FUNCTION public.record_admin_shift_attendance(uuid, uuid, timestamptz, text, timestamptz, text, boolean, boolean) IS
  'Owner direction 2026-11-12. admin_start remotely starts the officer''s shift at the recorded time (requires the administrator''s confirmation that they briefed the officer by phone, stored as an admin_phone safety briefing acknowledgement that replaces the officer''s start-position check). admin_finish overrides the open-work restrictions when the officer could not finish (forgot to log off, phone went flat): open dispatch jobs return to the dispatch queue, open welfare alerts are resolved only with p_officer_safety_confirmed, the officer''s last GPS breadcrumb at or before the finish time is kept as the finish location, and the shift closes through close_unfinished_officer_shift. Reasoned, idempotent on client_request_id, audited, fails fast on lock waits, and the officer is notified.';
REVOKE ALL ON FUNCTION public.record_admin_shift_attendance(uuid, uuid, timestamptz, text, timestamptz, text, boolean, boolean) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.record_admin_shift_attendance(uuid, uuid, timestamptz, text, timestamptz, text, boolean, boolean) TO postgres;
GRANT EXECUTE ON FUNCTION public.record_admin_shift_attendance(uuid, uuid, timestamptz, text, timestamptz, text, boolean, boolean) TO authenticated;

DROP FUNCTION public.get_roster_admin_attendance(uuid, uuid[]);

CREATE FUNCTION public.get_roster_admin_attendance(p_organization_id uuid, p_shift_ids uuid[])
RETURNS TABLE(shift_id uuid, admin_start timestamptz, admin_start_reason text, admin_start_by text,
  admin_finish timestamptz, admin_finish_reason text, admin_finish_by text,
  location_captured_at timestamptz, location_address text,
  finish_location_captured_at timestamptz, finish_location_address text,
  finish_location_lat double precision, finish_location_lng double precision,
  finish_released_dispatch_jobs integer, finish_resolved_welfare_alerts integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
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
    max(fix.physical_address),
    max(event.finish_location_recorded_at) FILTER (WHERE event.event_type = 'admin_finish'),
    max(event.finish_location_address) FILTER (WHERE event.event_type = 'admin_finish'),
    max(event.finish_location_lat) FILTER (WHERE event.event_type = 'admin_finish'),
    max(event.finish_location_lng) FILTER (WHERE event.event_type = 'admin_finish'),
    max(cardinality(event.released_dispatch_job_ids)) FILTER (WHERE event.event_type = 'admin_finish'),
    max(cardinality(event.resolved_welfare_alert_ids)) FILTER (WHERE event.event_type = 'admin_finish')
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
$$;

COMMENT ON FUNCTION public.get_roster_admin_attendance(uuid, uuid[]) IS
  'Roster administrators: who started or finished each shift on the officer''s behalf and why, the first device location reported for an admin-started shift, and for an admin finish the officer''s last GPS breadcrumb at or before the finish time plus the dispatch jobs returned to the queue and welfare alerts resolved.';
REVOKE ALL ON FUNCTION public.get_roster_admin_attendance(uuid, uuid[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_roster_admin_attendance(uuid, uuid[]) TO postgres;
GRANT EXECUTE ON FUNCTION public.get_roster_admin_attendance(uuid, uuid[]) TO authenticated;

COMMENT ON FUNCTION public.close_unfinished_officer_shift(uuid, uuid, text, timestamptz, timestamptz, text) IS
  'Branch admin closes an in-progress shift the officer could not end, at the recorded end time (after start, not in the future). Reached stops complete, unreached stops are skipped, open breaks end; dispatch jobs and welfare alerts must already be closed. record_admin_shift_attendance (admin_finish) clears them first under the 2026-11-12 owner override. Replay-safe on client_request_id with a before/after audit receipt.';
