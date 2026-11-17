-- Structured assignment data only. Private stop/site/checkpoint narratives require
-- a separate reviewed briefing path, which this projection deliberately omits.
CREATE OR REPLACE FUNCTION public.get_officer_patrol_journey(p_shift_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_shift public.shifts%ROWTYPE;
  v_patrol_id uuid;
  v_route_required boolean;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_profiles p
    WHERE p.id = v_actor AND p.deactivated_at IS NULL
      AND p.role IN ('grand_master', 'master', 'admin', 'admin_officer', 'officer')
  ) THEN
    RAISE EXCEPTION 'Active Patrol officer required';
  END IF;

  SELECT s.* INTO v_shift
  FROM public.shifts s
  WHERE s.id = p_shift_id AND s.officer_user_id = v_actor
    AND s.status IN ('published', 'accepted', 'in_progress')
    AND s.scheduled_end > now();
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.shift_stops st WHERE st.shift_id = v_shift.id
      AND st.organization_id IS DISTINCT FROM v_shift.organization_id
  ) THEN
    RAISE EXCEPTION 'Patrol stop configuration requires operations review';
  END IF;

  IF v_shift.patrol_route_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.patrol_routes r
    WHERE r.id = v_shift.patrol_route_id AND r.organization_id = v_shift.organization_id
  ) THEN
    RAISE EXCEPTION 'Patrol route configuration requires operations review';
  END IF;

  IF EXISTS (SELECT 1 FROM public.patrols p WHERE p.shift_id = v_shift.id
    AND p.status = 'in_progress' AND (p.officer_user_id IS DISTINCT FROM v_actor
      OR p.organization_id IS DISTINCT FROM v_shift.organization_id))
    OR (SELECT count(*) FROM public.patrols p WHERE p.shift_id = v_shift.id
      AND p.status = 'in_progress') > 1
  THEN RAISE EXCEPTION 'Patrol session configuration requires operations review'; END IF;

  SELECT p.id INTO v_patrol_id FROM public.patrols p
  WHERE p.shift_id = v_shift.id AND p.officer_user_id = v_actor
    AND p.organization_id = v_shift.organization_id AND p.status = 'in_progress'
  ORDER BY p.started_at DESC, p.id LIMIT 1;

  SELECT EXISTS (
    SELECT 1 FROM public.patrol_route_checkpoints c
    WHERE c.patrol_route_id = v_shift.patrol_route_id AND c.is_active AND c.is_mandatory
  ) INTO v_route_required;

  -- Completion currently considers matching checkpoints from any organisation,
  -- but the visit writer only permits the shift organisation. Do not disclose
  -- another organisation's checkpoint or pretend the blocking set is complete.
  IF NOT v_route_required AND EXISTS (
    SELECT 1 FROM public.patrol_checkpoints c
    WHERE c.active AND c.organization_id IS DISTINCT FROM v_shift.organization_id
      AND ((c.zone_id IS NOT NULL AND c.zone_id = v_shift.zone_id)
        OR EXISTS (
          SELECT 1 FROM public.shift_stops st WHERE st.shift_id = v_shift.id
            AND ((c.client_site_id IS NOT NULL AND st.site_id = c.client_site_id)
              OR (c.zone_id IS NOT NULL AND st.zone_id = c.zone_id))
        ))
  ) THEN
    RAISE EXCEPTION 'Patrol checkpoint configuration requires operations review';
  END IF;

  RETURN jsonb_build_object(
    'shift_id', v_shift.id,
    'patrol_id', v_patrol_id,
    'checkpoint_requirement', CASE WHEN v_route_required THEN 'route' ELSE 'site_zone' END,
    'route_geometry', NULL,
    'route_geometry_status', 'unavailable',
    'stops', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', st.id, 'stop_order', st.stop_order, 'visit_number', st.visit_number,
        'status', st.status,
        'place', jsonb_build_object(
          'kind', CASE WHEN st.site_id IS NOT NULL THEN 'site' WHEN st.zone_id IS NOT NULL THEN 'zone' ELSE 'unknown' END,
          'site_id', st.site_id, 'zone_id', st.zone_id,
          'name', coalesce(cs.name, z.name), 'address', cs.address,
          'coordinates', CASE
            WHEN st.site_id IS NOT NULL AND cs.gps_lat BETWEEN -90 AND 90 AND cs.gps_lng BETWEEN -180 AND 180
              THEN jsonb_build_object('lat', cs.gps_lat, 'lng', cs.gps_lng, 'source', 'site_center')
            WHEN st.site_id IS NULL AND st.zone_id IS NOT NULL AND z.center_point IS NOT NULL
              AND public.st_y(z.center_point) BETWEEN -90 AND 90 AND public.st_x(z.center_point) BETWEEN -180 AND 180
              THEN jsonb_build_object('lat', public.st_y(z.center_point), 'lng', public.st_x(z.center_point), 'source', 'zone_center')
            ELSE NULL END),
        'clients', attribution.clients,
        'client_attribution_complete', attribution.complete
      ) ORDER BY st.stop_order, st.visit_number, st.id)
      FROM public.shift_stops st
      LEFT JOIN public.client_sites cs ON cs.id = st.site_id
      LEFT JOIN public.location_zones z ON z.id = st.zone_id
      CROSS JOIN LATERAL (
        SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_object('id', a.client_organization_id, 'name', o.name)
                          ORDER BY jsonb_build_object('id', a.client_organization_id, 'name', o.name))
                 FILTER (WHERE a.id IS NOT NULL), '[]'::jsonb) AS clients,
          count(m.id) > 0 AND count(m.id) = count(a.id) AS complete
        FROM public.shift_stop_modules m
        LEFT JOIN public.service_agreement_locations sal
          ON m.organization_id = v_shift.organization_id
          AND sal.id = m.service_agreement_location_id AND sal.status = 'active'
          AND ((st.site_id IS NOT NULL AND sal.site_id = st.site_id)
            OR (st.site_id IS NULL AND st.zone_id IS NOT NULL AND sal.zone_id = st.zone_id))
        LEFT JOIN public.service_agreement_modules sam
          ON sam.id = m.service_agreement_module_id AND sam.enabled
          AND sam.service_agreement_id = sal.service_agreement_id AND sam.module_key = m.module_key
        LEFT JOIN public.service_agreements a
          ON a.id = sam.service_agreement_id AND a.agreement_type = 'operational'
          AND (a.starts_on IS NULL OR a.starts_on <= v_shift.scheduled_start::date)
          AND (a.ends_on IS NULL OR a.ends_on >= v_shift.scheduled_start::date)
          AND (a.provider_organization_id = v_shift.organization_id
            OR v_shift.organization_id = ANY(public.get_descendant_organizations(a.provider_organization_id)))
        LEFT JOIN public.organizations o ON o.id = a.client_organization_id
        WHERE m.shift_stop_id = st.id
      ) attribution
      WHERE st.shift_id = v_shift.id AND st.organization_id = v_shift.organization_id
        AND NOT st.is_adhoc AND st.module_key <> 'static_guarding'
    ), '[]'::jsonb),
    'checkpoints', coalesce((
      SELECT jsonb_agg(q.item ORDER BY q.kind_order, q.sequence_order, q.name, q.id)
      FROM (
        SELECT 0 AS kind_order, c.sequence_order, c.name, c.id,
          jsonb_build_object('id', c.id, 'kind', 'route', 'name', c.name,
            'required', c.is_mandatory, 'sequence_order', c.sequence_order,
            'site_id', NULL, 'zone_id', NULL, 'stop_ids', '[]'::jsonb,
            'auto_geofence_status', 'unavailable_route',
            'visited', EXISTS (SELECT 1 FROM public.patrol_checkpoint_visits v
              WHERE v.patrol_id = v_patrol_id AND v.route_checkpoint_id = c.id)) AS item
        FROM public.patrol_route_checkpoints c
        WHERE c.patrol_route_id = v_shift.patrol_route_id AND c.is_active
        UNION ALL
        SELECT 1, NULL::integer, c.name, c.id,
          jsonb_build_object('id', c.id, 'kind', 'site', 'name', c.name,
            'required', NOT v_route_required, 'sequence_order', NULL,
            'site_id', c.client_site_id, 'zone_id', c.zone_id,
            'auto_geofence_status', CASE
              WHEN c.gps_lat IS NULL OR c.gps_lat NOT BETWEEN -90 AND 90
                OR c.gps_lng IS NULL OR c.gps_lng NOT BETWEEN -180 AND 180
                OR c.radius_meters IS NULL OR c.radius_meters NOT BETWEEN 1 AND 500
                THEN 'missing_or_invalid_geofence'
              WHEN c.checkpoint_verification IS DISTINCT FROM 'verified'
                OR c.checkpoint_verified_by IS NULL OR c.checkpoint_verified_at IS NULL
                THEN 'unverified'
              ELSE 'verified' END,
            'stop_ids', coalesce((SELECT jsonb_agg(st.id ORDER BY st.stop_order, st.visit_number, st.id)
              FROM public.shift_stops st WHERE st.shift_id = v_shift.id
                AND ((c.client_site_id IS NOT NULL AND st.site_id = c.client_site_id)
                  OR (c.zone_id IS NOT NULL AND st.zone_id = c.zone_id))), '[]'::jsonb),
            'visited', EXISTS (SELECT 1 FROM public.patrol_checkpoint_visits v
              WHERE v.patrol_id = v_patrol_id AND v.checkpoint_id = c.id))
        FROM public.patrol_checkpoints c
        WHERE c.active AND c.organization_id = v_shift.organization_id
          AND ((c.zone_id IS NOT NULL AND c.zone_id = v_shift.zone_id)
            OR EXISTS (SELECT 1 FROM public.shift_stops st WHERE st.shift_id = v_shift.id
              AND ((c.client_site_id IS NOT NULL AND st.site_id = c.client_site_id)
                OR (c.zone_id IS NOT NULL AND st.zone_id = c.zone_id))))
      ) q
    ), '[]'::jsonb)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_officer_patrol_journey(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_officer_patrol_journey(uuid) TO authenticated;
COMMENT ON FUNCTION public.get_officer_patrol_journey(uuid) IS
  'Assigned, non-overdue officer patrol plan and checkpoint requirements. No unreviewed narrative or route geometry.';