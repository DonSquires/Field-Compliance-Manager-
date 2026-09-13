CREATE OR REPLACE FUNCTION public.get_officer_activity_timeline_unlogged(
  p_officer_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_limit integer DEFAULT 1000
) RETURNS TABLE (
  event_key text,
  event_type text,
  event_at timestamptz,
  received_at timestamptz,
  source_table text,
  source_id uuid,
  gps_lat double precision,
  gps_lng double precision,
  shift_id uuid,
  site_id uuid,
  zone_id uuid,
  summary text,
  details jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id uuid;
BEGIN
  SELECT organization_id INTO v_org_id FROM public.user_profiles WHERE id = p_officer_id;
  IF v_org_id IS NULL THEN RETURN; END IF;
  IF auth.uid() <> p_officer_id AND NOT public.is_admin_for_org(v_org_id) THEN RAISE EXCEPTION 'Not authorised to view this officer timeline'; END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from >= p_to OR p_to - p_from > interval '31 days' THEN RAISE EXCEPTION 'Timeline range must be between 1 second and 31 days'; END IF;

  RETURN QUERY
  WITH events AS (
    SELECT 'gps:' || g.id::text, 'gps_' || g.activity_type, g.recorded_at, g.created_at,
      'officer_gps_log'::text, g.id, g.gps_lat, g.gps_lng, g.shift_id, NULL::uuid, g.detected_zone_id,
      CASE WHEN g.activity_type = 'gps_update' THEN 'GPS heartbeat' ELSE replace(g.activity_type, '_', ' ') END,
      jsonb_build_object('accuracy_meters', g.accuracy_meters, 'heading', g.heading, 'speed_kmh', g.speed_kmh, 'physical_address', g.physical_address, 'client_event_id', g.client_event_id)
    FROM public.officer_gps_log g
    WHERE g.organization_id = v_org_id AND g.officer_id = p_officer_id AND g.recorded_at BETWEEN p_from AND p_to

    UNION ALL
    SELECT 'welfare_check:' || w.id::text, 'welfare_check', w.checked_in_at, w.checked_in_at,
      'welfare_checks', w.id, w.gps_lat, w.gps_lng, w.shift_id, NULL::uuid, NULL::uuid,
      'Welfare check-in: ' || w.status, jsonb_build_object('status', w.status, 'notes', w.notes)
    FROM public.welfare_checks w WHERE w.organization_id = v_org_id AND w.officer_user_id = p_officer_id AND w.checked_in_at BETWEEN p_from AND p_to

    UNION ALL
    SELECT 'observation:' || o.id::text, 'observation', o.observed_at, o.created_at,
      'observations', o.id, o.gps_lat, o.gps_lng, NULL::uuid, o.site_id, o.zone_id,
      'Vehicle observation ' || o.plate_number, jsonb_build_object('module_key', o.module_key, 'compliance_status', o.compliance_status, 'plate_number', o.plate_number)
    FROM public.observations o WHERE o.organization_id = v_org_id AND o.officer_id = p_officer_id AND o.observed_at BETWEEN p_from AND p_to

    UNION ALL
    SELECT 'checkpoint:' || v.id::text, 'checkpoint_visit', v.visited_at, v.visited_at,
      'patrol_checkpoint_visits', v.id, v.gps_lat, v.gps_lng, p.shift_id, NULL::uuid, NULL::uuid,
      'Patrol checkpoint visit', jsonb_build_object('checkpoint_id', v.checkpoint_id, 'scan_method', v.scan_method, 'within_radius', v.within_radius, 'notes', v.notes)
    FROM public.patrol_checkpoint_visits v JOIN public.patrols p ON p.id = v.patrol_id
    WHERE v.organization_id = v_org_id AND v.officer_user_id = p_officer_id AND v.visited_at BETWEEN p_from AND p_to

    UNION ALL
    SELECT 'report:' || r.id::text, 'field_report', r.reported_at, r.created_at, 'officer_field_reports', r.id, r.gps_lat, r.gps_lng, r.shift_id, r.site_id, r.zone_id,
      r.title, jsonb_build_object('report_type', r.report_type, 'severity', r.severity, 'status', r.status, 'immediate_action', r.immediate_action)
    FROM public.officer_field_reports r WHERE r.organization_id = v_org_id AND r.officer_id = p_officer_id AND r.reported_at BETWEEN p_from AND p_to

    UNION ALL
    SELECT 'stop_action:' || a.id::text, 'shift_stop_action', a.performed_at, a.created_at,
      'shift_stop_actions', a.id, a.gps_lat, a.gps_lng, a.shift_id, NULL::uuid, NULL::uuid,
      replace(a.action_type, '_', ' '), jsonb_build_object('outcome', a.outcome, 'notes', a.notes, 'result_table', a.result_table, 'result_record_id', a.result_record_id)
    FROM public.shift_stop_actions a JOIN public.shifts s ON s.id = a.shift_id
    WHERE a.organization_id = v_org_id AND s.officer_user_id = p_officer_id AND a.performed_at BETWEEN p_from AND p_to
  )
  SELECT * FROM events ORDER BY event_at DESC LIMIT least(greatest(coalesce(p_limit, 1000), 1), 5000);
END;
$$;

REVOKE ALL ON FUNCTION public.get_officer_activity_timeline_unlogged(uuid, timestamptz, timestamptz, integer) FROM public, anon, authenticated;
