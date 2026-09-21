-- Officer breadcrumbs follow the shift's operating branch, and the live picture is one governed read.
--
-- Before (observed live 2026-09-20, dry run as nelson-e2e-officer): record_officer_breadcrumb stamped
-- every breadcrumb with the officer's HOME organisation and refused any p_shift_id whose shift did not
-- belong to that home organisation ("Shift does not belong to the authenticated officer"). Shifts
-- belong to the operating branch (20260919030000), so an officer employed by First Security and
-- rostered at First Security Nelson would have every on-shift breadcrumb refused (the officer shell
-- attaches the active shift id) — the dispatcher sees "GPS offline" and welfare monitoring goes blind
-- for the whole shift. detected_zone_id was never populated. The Live officer page read four tables
-- from the client, filtered by columns that do not exist when a zoned agreement is selected
-- (officer_gps_log.zone_id, welfare_alerts.zone_id, officer_welfare_settings.zone_id -> HTTP 400),
-- and scoped to the home organisation only.
--
-- After:
--  * record_officer_breadcrumb accepts any shift of the authenticated officer, stamps the breadcrumb
--    with the shift's organisation (else the home organisation), resolves detected_zone_id through
--    resolve_context (never blocking the write), and de-duplicates by officer + client_event_id.
--  * get_live_officer_positions(p_organization_id, p_since_minutes, p_zone_ids) returns, for an
--    administrator or operator of that organisation, the latest position of every officer seen at the
--    organisation or its branches, everyone on a current shift there (with or without a fix), and
--    everyone with an open welfare alert — each with their current shift, welfare settings and alert.
--    The zone filter uses detected_zone_id or the shift's zone.
-- Doctrine: "a guard on a place for a shift" for the operating branch; welfare is a safety signal.

CREATE OR REPLACE FUNCTION "public"."record_officer_breadcrumb"(p_client_event_id uuid, p_recorded_at timestamp with time zone, p_gps_lat double precision, p_gps_lng double precision, p_accuracy_meters double precision DEFAULT NULL::double precision, p_heading double precision DEFAULT NULL::double precision, p_speed_kmh double precision DEFAULT NULL::double precision, p_activity_type text DEFAULT 'gps_update'::text, p_shift_id uuid DEFAULT NULL::uuid, p_physical_address text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, created boolean, received_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_home_org uuid;
  v_org_id uuid;
  v_shift public.shifts%rowtype;
  v_zone_id uuid;
  v_existing public.officer_gps_log%rowtype;
  v_created public.officer_gps_log%rowtype;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT up.organization_id INTO v_home_org FROM public.user_profiles up
  WHERE up.id = v_user_id AND up.deactivated_at IS NULL AND up.role IN ('officer', 'scan_operator');
  IF v_home_org IS NULL THEN RAISE EXCEPTION 'Active officer profile not found'; END IF;
  IF p_client_event_id IS NULL THEN RAISE EXCEPTION 'client_event_id is required'; END IF;
  IF p_recorded_at IS NULL OR p_recorded_at > now() + interval '5 minutes' OR p_recorded_at < now() - interval '24 hours' THEN
    RAISE EXCEPTION 'recorded_at is outside the accepted capture window';
  END IF;
  IF p_gps_lat NOT BETWEEN -90 AND 90 OR p_gps_lng NOT BETWEEN -180 AND 180 THEN RAISE EXCEPTION 'Invalid GPS coordinates'; END IF;
  IF p_accuracy_meters IS NOT NULL AND p_accuracy_meters < 0 THEN RAISE EXCEPTION 'GPS accuracy cannot be negative'; END IF;
  IF p_activity_type NOT IN ('gps_update', 'shift_start', 'shift_end', 'scan', 'welfare_checkin', 'sos', 'checkpoint_scan') THEN
    RAISE EXCEPTION 'Unsupported breadcrumb activity type';
  END IF;

  -- The shift may belong to any operating branch; the breadcrumb then belongs to that branch too.
  IF p_shift_id IS NOT NULL THEN
    SELECT s.* INTO v_shift FROM public.shifts s WHERE s.id = p_shift_id AND s.officer_user_id = v_user_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Shift does not belong to the authenticated officer'; END IF;
  END IF;
  v_org_id := coalesce(v_shift.organization_id, v_home_org);

  -- Replays return the original receipt whichever organisation it was stamped with.
  SELECT g.* INTO v_existing FROM public.officer_gps_log g
  WHERE g.officer_id = v_user_id AND g.client_event_id = p_client_event_id
  ORDER BY g.created_at LIMIT 1;
  IF FOUND THEN RETURN QUERY SELECT v_existing.id, false, v_existing.created_at; RETURN; END IF;

  -- Zone detection is evidence, never a gate: a resolver failure must not lose a position.
  BEGIN
    SELECT r.matched_zone_id INTO v_zone_id FROM public.resolve_context(p_gps_lat, p_gps_lng, v_org_id, NULL, p_recorded_at) r LIMIT 1;
  EXCEPTION WHEN OTHERS THEN v_zone_id := NULL;
  END;

  BEGIN
    INSERT INTO public.officer_gps_log (
      organization_id, officer_id, client_event_id, recorded_at, gps_lat, gps_lng,
      accuracy_meters, heading, speed_kmh, activity_type, shift_id, physical_address, detected_zone_id
    ) VALUES (
      v_org_id, v_user_id, p_client_event_id, p_recorded_at, p_gps_lat, p_gps_lng,
      p_accuracy_meters, p_heading, p_speed_kmh, p_activity_type, v_shift.id, NULLIF(trim(p_physical_address), ''), v_zone_id
    ) RETURNING * INTO v_created;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_created FROM public.officer_gps_log
    WHERE officer_id = v_user_id AND client_event_id = p_client_event_id ORDER BY created_at LIMIT 1;
    RETURN QUERY SELECT v_created.id, false, v_created.created_at; RETURN;
  END;
  RETURN QUERY SELECT v_created.id, true, v_created.created_at;
END;
$function$;
COMMENT ON FUNCTION "public"."record_officer_breadcrumb"(uuid, timestamp with time zone, double precision, double precision, double precision, double precision, double precision, text, uuid, text) IS 'Idempotent officer GPS breadcrumb. Stamped with the shift''s operating organisation when a shift of the caller is given, else the caller''s home organisation; detected_zone_id resolved best-effort through resolve_context. Replays (same officer + client_event_id) return the original receipt.';

-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."get_live_officer_positions"(p_organization_id uuid, p_since_minutes integer DEFAULT 240, p_zone_ids uuid[] DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_reach uuid[];
  v_since timestamptz := now() - make_interval(mins => greatest(coalesce(p_since_minutes, 240), 5));
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_organization_id IS NULL THEN RAISE EXCEPTION 'An organisation is required'; END IF;
  IF NOT (public.is_admin_for_org(p_organization_id) OR public.user_can_operate_organization(p_organization_id)) THEN
    RAISE EXCEPTION 'Not authorised to view live positions for this organisation';
  END IF;
  v_reach := array(SELECT DISTINCT d FROM unnest(public.get_descendant_organizations(p_organization_id) || p_organization_id) d);

  RETURN jsonb_build_object(
    'organization_id', p_organization_id,
    'reach', to_jsonb(v_reach),
    'since', v_since,
    'refreshed_at', now(),
    'officers', coalesce((
      WITH on_shift AS (
        SELECT DISTINCT ON (s.officer_user_id) s.officer_user_id, s.id, s.status, s.scheduled_start, s.scheduled_end, s.organization_id,
               s.service_type, s.zone_id, s.location_id, s.patrol_route_id
        FROM public.shifts s
        WHERE s.organization_id = ANY(v_reach)
          AND s.status IN ('published', 'accepted', 'in_progress')
          AND s.scheduled_start <= now() + interval '1 hour'
          AND s.scheduled_end >= now() - interval '1 hour'
        ORDER BY s.officer_user_id, CASE s.status WHEN 'in_progress' THEN 0 WHEN 'accepted' THEN 1 ELSE 2 END, s.scheduled_start
      ),
      latest AS (
        -- Positions stamped at the branch reach, plus the latest position of anyone on a current shift here wherever it was stamped.
        SELECT DISTINCT ON (g.officer_id) g.officer_id, g.id, g.gps_lat, g.gps_lng, g.accuracy_meters, g.heading, g.speed_kmh,
               g.activity_type, g.recorded_at, g.detected_zone_id, g.shift_id, g.physical_address, g.organization_id
        FROM public.officer_gps_log g
        WHERE g.recorded_at >= v_since
          AND (g.organization_id = ANY(v_reach) OR g.officer_id IN (SELECT os.officer_user_id FROM on_shift os))
        ORDER BY g.officer_id, g.recorded_at DESC
      ),
      alerting AS (
        SELECT DISTINCT ON (a.officer_user_id) a.officer_user_id, a.id, a.alert_type, a.status, a.triggered_at, a.gps_lat, a.gps_lng
        FROM public.welfare_alerts a
        WHERE a.organization_id = ANY(v_reach) AND a.status IN ('pending', 'acknowledged')
        ORDER BY a.officer_user_id, a.triggered_at DESC
      ),
      people AS (
        SELECT officer_id AS user_id FROM latest
        UNION SELECT officer_user_id FROM on_shift
        UNION SELECT officer_user_id FROM alerting
      )
      SELECT jsonb_agg(jsonb_build_object(
        'officer_id', p.user_id,
        'officer_name', coalesce(up.display_name, up.email, p.user_id::text),
        'home_organization_id', up.organization_id,
        'gps_lat', coalesce(l.gps_lat, al.gps_lat),
        'gps_lng', coalesce(l.gps_lng, al.gps_lng),
        'accuracy_meters', l.accuracy_meters,
        'heading', l.heading,
        'speed_kmh', l.speed_kmh,
        'activity_type', coalesce(l.activity_type, CASE WHEN al.id IS NOT NULL THEN 'active_welfare_alert' END),
        'recorded_at', coalesce(l.recorded_at, al.triggered_at),
        'physical_address', l.physical_address,
        'detected_zone_id', l.detected_zone_id,
        'zone_name', (SELECT z.name FROM public.location_zones z WHERE z.id = coalesce(l.detected_zone_id, os.zone_id)),
        'position_organization_id', l.organization_id,
        'shift', CASE WHEN os.id IS NULL THEN NULL ELSE jsonb_build_object(
          'id', os.id, 'status', os.status, 'scheduled_start', os.scheduled_start, 'scheduled_end', os.scheduled_end,
          'organization_id', os.organization_id, 'organization_name', (SELECT o.name FROM public.organizations o WHERE o.id = os.organization_id),
          'service_type', os.service_type, 'zone_id', os.zone_id,
          'route_name', (SELECT r.name FROM public.patrol_routes r WHERE r.id = os.patrol_route_id),
          'work_unit_name', (SELECT wu.name FROM public.roster_slots rs JOIN public.roster_work_units wu ON wu.id = rs.work_unit_id WHERE rs.linked_shift_id = os.id LIMIT 1)) END,
        'welfare', (SELECT jsonb_build_object('enabled', w.welfare_check_enabled, 'check_interval_minutes', w.check_interval_minutes, 'last_checkin_at', w.last_checkin_at)
                    FROM public.officer_welfare_settings w WHERE w.officer_user_id = p.user_id
                    ORDER BY (w.organization_id = ANY(v_reach)) DESC, w.updated_at DESC LIMIT 1),
        'alert', CASE WHEN al.id IS NULL THEN NULL ELSE jsonb_build_object('id', al.id, 'alert_type', al.alert_type, 'status', al.status, 'triggered_at', al.triggered_at) END
      ) ORDER BY (al.id IS NOT NULL) DESC, (os.id IS NOT NULL) DESC, coalesce(up.display_name, up.email))
      FROM people p
      JOIN public.user_profiles up ON up.id = p.user_id
      LEFT JOIN latest l ON l.officer_id = p.user_id
      LEFT JOIN on_shift os ON os.officer_user_id = p.user_id
      LEFT JOIN alerting al ON al.officer_user_id = p.user_id
      WHERE p_zone_ids IS NULL OR cardinality(p_zone_ids) = 0
         OR l.detected_zone_id = ANY(p_zone_ids) OR os.zone_id = ANY(p_zone_ids)
    ), '[]'::jsonb)
  );
END;
$function$;
COMMENT ON FUNCTION "public"."get_live_officer_positions"(uuid, integer, uuid[]) IS 'Live picture for an organisation and its branches: latest breadcrumb per officer within the window, everyone on a current shift there (with or without a fix), everyone with an open welfare alert; each with current shift, welfare settings and alert. Administrator or operator of the organisation only. Optional zone filter on detected_zone_id / shift zone.';
REVOKE ALL ON FUNCTION "public"."get_live_officer_positions"(uuid, integer, uuid[]) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."get_live_officer_positions"(uuid, integer, uuid[]) TO "authenticated", "service_role";
