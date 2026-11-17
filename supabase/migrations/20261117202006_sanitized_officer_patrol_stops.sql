-- Allow-list the operational shape: later legacy fields must not become
-- public through this wrapper without a separate privacy decision.
CREATE OR REPLACE FUNCTION public.get_officer_patrol_stops_sanitized(p_shift_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_shift public.shifts%ROWTYPE;
  v_source jsonb;
  v_stops jsonb;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_profiles p WHERE p.id = v_actor
      AND p.deactivated_at IS NULL
      AND p.role IN ('grand_master', 'master', 'admin', 'admin_officer', 'officer')
  ) THEN RAISE EXCEPTION 'Active Patrol officer required'; END IF;

  SELECT s.* INTO v_shift FROM public.shifts s
  WHERE s.id = p_shift_id AND s.officer_user_id = v_actor
    AND s.status IN ('published', 'accepted', 'in_progress')
    AND s.scheduled_end > now();
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF EXISTS (
    SELECT 1 FROM public.shift_stops st WHERE st.shift_id = v_shift.id
      AND st.organization_id IS DISTINCT FROM v_shift.organization_id
  ) THEN RAISE EXCEPTION 'Patrol stop configuration requires operations review'; END IF;
  IF v_shift.patrol_route_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.patrol_routes r WHERE r.id = v_shift.patrol_route_id
      AND r.organization_id = v_shift.organization_id
  ) THEN RAISE EXCEPTION 'Patrol route configuration requires operations review'; END IF;
  IF EXISTS (SELECT 1 FROM public.patrols p WHERE p.shift_id = v_shift.id
    AND p.status = 'in_progress' AND (p.officer_user_id IS DISTINCT FROM v_actor
      OR p.organization_id IS DISTINCT FROM v_shift.organization_id))
    OR (SELECT count(*) FROM public.patrols p WHERE p.shift_id = v_shift.id
      AND p.status = 'in_progress') > 1
  THEN RAISE EXCEPTION 'Patrol session configuration requires operations review'; END IF;

  v_source := public.get_officer_patrol_stops(v_shift.id);
  IF v_source IS NULL OR v_source = 'null'::jsonb THEN RETURN NULL; END IF;
  IF jsonb_typeof(v_source) IS DISTINCT FROM 'object'
    OR jsonb_typeof(v_source->'shift') IS DISTINCT FROM 'object'
    OR v_source->'shift'->>'id' IS DISTINCT FROM v_shift.id::text
    OR jsonb_typeof(v_source->'stops') IS DISTINCT FROM 'array'
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_source->'stops') x(stop)
      WHERE jsonb_typeof(x.stop) IS DISTINCT FROM 'object'
        OR jsonb_typeof(x.stop->'checks') IS DISTINCT FROM 'array'
        OR jsonb_typeof(x.stop->'modules') IS DISTINCT FROM 'array'
        OR NOT EXISTS (
          SELECT 1 FROM public.shift_stops st WHERE st.id::text = x.stop->>'id'
            AND st.shift_id = v_shift.id AND st.organization_id = v_shift.organization_id
            AND NOT st.is_adhoc AND st.module_key <> 'static_guarding'
        )
    )
  THEN RAISE EXCEPTION 'Patrol stop projection unavailable'; END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', x.stop->'id', 'stop_order', x.stop->'stop_order',
    'visit_number', x.stop->'visit_number', 'visits_total', x.stop->'visits_total',
    'status', x.stop->'status', 'sla_status', x.stop->'sla_status',
    'sla_window_open', x.stop->'sla_window_open', 'sla_arrive_by', x.stop->'sla_arrive_by',
    'sla_depart_by', x.stop->'sla_depart_by', 'required_dwell_minutes', x.stop->'required_dwell_minutes',
    'officer_instructions', NULL, 'officer_notes', NULL,
    'actual_arrived_at', x.stop->'actual_arrived_at', 'actual_departed_at', x.stop->'actual_departed_at',
    'actual_travel_distance_km', x.stop->'actual_travel_distance_km',
    'travel_from_stop_id', x.stop->'travel_from_stop_id',
    'travel_distance_method', x.stop->'travel_distance_method',
    'travel_distance_version', x.stop->'travel_distance_version',
    'arrival_verification', x.stop->'arrival_verification', 'arrival_distance_m', x.stop->'arrival_distance_m',
    'module_key', x.stop->'module_key',
    'checks', (SELECT coalesce(jsonb_agg(jsonb_build_object(
      'check_key', c.value->'check_key', 'label', c.value->'check_key',
      'needs_photo', c.value->'needs_photo', 'needs_note', c.value->'needs_note',
      'outcome', c.value->'outcome', 'notes', NULL, 'performed_at', c.value->'performed_at'
    ) ORDER BY c.ordinality), '[]'::jsonb)
      FROM jsonb_array_elements(x.stop->'checks') WITH ORDINALITY c(value, ordinality)),
    'modules', (SELECT coalesce(jsonb_agg(jsonb_build_object(
      'module_key', m.value->'module_key', 'is_required', m.value->'is_required',
      'status', m.value->'status'
    ) ORDER BY m.ordinality), '[]'::jsonb)
      FROM jsonb_array_elements(x.stop->'modules') WITH ORDINALITY m(value, ordinality)),
    'place', CASE WHEN jsonb_typeof(x.stop->'place') = 'object'
      THEN jsonb_build_object('kind', x.stop->'place'->'kind',
        'name', x.stop->'place'->'name', 'address', x.stop->'place'->'address',
        'access_instructions', NULL, 'hs_notes', NULL)
      ELSE NULL END
  ) ORDER BY x.ordinality), '[]'::jsonb) INTO v_stops
  FROM jsonb_array_elements(v_source->'stops') WITH ORDINALITY x(stop, ordinality);

  RETURN jsonb_build_object('shift', jsonb_build_object(
    'id', v_source->'shift'->'id', 'status', v_source->'shift'->'status',
    'scheduled_start', v_source->'shift'->'scheduled_start',
    'scheduled_end', v_source->'shift'->'scheduled_end', 'route_name', NULL
  ), 'stops', v_stops);
END;
$function$;
REVOKE ALL ON FUNCTION public.get_officer_patrol_stops_sanitized(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_officer_patrol_stops_sanitized(uuid) TO authenticated;
COMMENT ON FUNCTION public.get_officer_patrol_stops_sanitized(uuid) IS
  'Assigned non-overdue officer stop data, allow-listed without unreviewed narrative; legacy raw RPC remains unchanged.';