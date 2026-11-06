-- Officer GPS: tie positions to the shift's own place.
-- 1. get_live_officer_positions reports each current shift's contracted site, whether the latest fix is on it
--    (verified site boundary or on-site radius) and the distance, so static sites with no provider zone are still placed.
-- 2. record_officer_breadcrumb tags the shift's assigned zone (shift or agreement location) when the fix is inside it,
--    before falling back to the generic resolver.
-- 3. resolve_context ignores inactive/archived organisations (merged legacy shells) when naming the
--    out-of-bounds district and governing jurisdiction.

CREATE OR REPLACE FUNCTION public.resolve_context(p_lat double precision, p_lng double precision, p_org_id uuid, p_module_key text DEFAULT NULL::text, p_at timestamp with time zone DEFAULT now())
 RETURNS TABLE(in_operating_bounds boolean, out_of_bounds_district text, governing_jurisdiction_id uuid, governing_jurisdiction_name text, on_site boolean, site_id uuid, client_org_id uuid, matched_zone_id uuid, matched_module_key text, effective_rules jsonb, resolution_status text, governor_overlap_flag boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_point        geometry := st_setsrid(st_point(p_lng, p_lat), 4326);
  v_in_bounds    boolean := false;
  v_oob_district text := null;
  v_jur_id       uuid := null;
  v_jur_name     text := null;
  v_zone         record;
  v_on_site      boolean := false;
  v_site_id      uuid := null;
  v_client_org   uuid := null;
  v_rules        jsonb := '{}'::jsonb;
  v_resolution   text := 'outside_all_geofences';
  v_gov_overlap  boolean := false;
  v_org_jur_verification text;
  v_org_jur_geom_exists  boolean;
  v_org_jur_geom_valid   boolean;
  v_governor_count integer := 0;
BEGIN
  -- Layer 1: operating bounds (P1/P2: no-geofence / unverified / invalid / outside / inside are distinct).
  SELECT
    o.jurisdiction_geom IS NOT NULL,
    CASE WHEN o.jurisdiction_geom IS NOT NULL
         THEN ST_IsValid(o.jurisdiction_geom) AND NOT ST_IsEmpty(o.jurisdiction_geom)
         ELSE false END,
    o.jurisdiction_verification,
    CASE WHEN o.jurisdiction_geom IS NOT NULL
              AND ST_IsValid(o.jurisdiction_geom)
              AND NOT ST_IsEmpty(o.jurisdiction_geom)
              AND o.jurisdiction_verification = 'verified'
         THEN st_contains(o.jurisdiction_geom, v_point)
         ELSE false END
    INTO v_org_jur_geom_exists, v_org_jur_geom_valid,
         v_org_jur_verification, v_in_bounds
  FROM public.organizations o
  WHERE o.id = p_org_id;

  IF NOT COALESCE(v_org_jur_geom_exists, false) THEN
    v_resolution := 'unresolved_no_geofence';
  ELSIF NOT COALESCE(v_org_jur_geom_valid, false) THEN
    v_resolution := 'unresolved_invalid';
  ELSIF COALESCE(v_org_jur_verification, 'unverified') <> 'verified' THEN
    v_resolution := 'unresolved_unverified';
  ELSE
    v_resolution := 'outside_all_geofences';
  END IF;

  v_in_bounds := COALESCE(v_in_bounds, false);

  IF NOT v_in_bounds THEN
    SELECT o.name INTO v_oob_district
    FROM public.organizations o
    WHERE o.jurisdiction_geom IS NOT NULL
      AND o.active AND o.status IS DISTINCT FROM 'archived'
      AND st_contains(o.jurisdiction_geom, v_point)
    ORDER BY st_area(o.jurisdiction_geom) ASC
    LIMIT 1;
  END IF;

  -- Layer 2: governing council jurisdiction (role-aware; unchanged).
  SELECT count(*)
    INTO v_governor_count
  FROM public.organizations o
  WHERE o.jurisdiction_geom IS NOT NULL
    AND o.id <> p_org_id
    AND o.active AND o.status IS DISTINCT FROM 'archived'
    AND o.jurisdiction_verification = 'verified'
    AND ST_IsValid(o.jurisdiction_geom)
    AND NOT ST_IsEmpty(o.jurisdiction_geom)
    AND st_contains(o.jurisdiction_geom, v_point)
    AND (
      EXISTS (
        SELECT 1 FROM public.org_engagements e
        WHERE e.status = 'active'
          AND ((e.from_org_id = p_org_id AND e.to_org_id = o.id)
            OR (e.to_org_id = p_org_id AND e.from_org_id = o.id))
      )
      OR o.parent_organization_id = p_org_id
      OR o.id = (SELECT parent_organization_id FROM public.organizations WHERE id = p_org_id)
    )
    AND (
      o.organization_type IN ('government', 'service_provider', 'branch')
      OR EXISTS (
        SELECT 1 FROM public.service_agreements sa
        WHERE sa.provider_organization_id = o.id
          AND (sa.ends_on IS NULL OR sa.ends_on >= current_date)
      )
      OR EXISTS (
        SELECT 1 FROM public.organizations child
        WHERE child.parent_organization_id = o.id
      )
      OR EXISTS (
        SELECT 1 FROM public.org_engagements e2
        WHERE e2.to_org_id = o.id
          AND e2.status = 'active'
      )
    );

  IF v_governor_count > 1 THEN
    v_gov_overlap := true;
  END IF;

  SELECT o.id, o.name
    INTO v_jur_id, v_jur_name
  FROM public.organizations o
  WHERE o.jurisdiction_geom IS NOT NULL
    AND o.id <> p_org_id
    AND o.active AND o.status IS DISTINCT FROM 'archived'
    AND o.jurisdiction_verification = 'verified'
    AND ST_IsValid(o.jurisdiction_geom)
    AND NOT ST_IsEmpty(o.jurisdiction_geom)
    AND st_contains(o.jurisdiction_geom, v_point)
    AND (
      EXISTS (
        SELECT 1 FROM public.org_engagements e
        WHERE e.status = 'active'
          AND ((e.from_org_id = p_org_id AND e.to_org_id = o.id)
            OR (e.to_org_id = p_org_id AND e.from_org_id = o.id))
      )
      OR o.parent_organization_id = p_org_id
      OR o.id = (SELECT parent_organization_id FROM public.organizations WHERE id = p_org_id)
    )
    AND (
      o.organization_type IN ('government', 'service_provider', 'branch')
      OR EXISTS (
        SELECT 1 FROM public.service_agreements sa
        WHERE sa.provider_organization_id = o.id
          AND (sa.ends_on IS NULL OR sa.ends_on >= current_date)
      )
      OR EXISTS (
        SELECT 1 FROM public.organizations child
        WHERE child.parent_organization_id = o.id
      )
      OR EXISTS (
        SELECT 1 FROM public.org_engagements e2
        WHERE e2.to_org_id = o.id
          AND e2.status = 'active'
      )
    )
  ORDER BY st_area(o.jurisdiction_geom) ASC
  LIMIT 1;

  -- Layer 3: verified zone geofence. Matching is unchanged; the site and owner now come from the house.
  SELECT z.id, z.location_id, z.module_key, z.onsite_profile, z.boundary,
         z.jurisdiction_rule_set_id, z.rule_overrides,
         z.repeat_stay_radius_m, z.repeat_stay_window_nights,
         z.nightly_limit_consecutive, z.nightly_limit_monthly, z.scv_required
    INTO v_zone
  FROM public.location_zones z
  WHERE z.organization_id = p_org_id AND NOT z.is_verification_point
    AND z.boundary IS NOT NULL
    AND z.boundary_verification = 'verified'
    AND ST_IsValid(z.boundary)
    AND NOT ST_IsEmpty(z.boundary)
    AND st_contains(z.boundary, v_point)
    AND (p_module_key IS NULL OR z.module_key = p_module_key)
    AND public._geofence_active_at(z.active_schedule, p_at)
  ORDER BY st_area(z.boundary) ASC
  LIMIT 1;

  IF v_zone.id IS NOT NULL THEN
    v_resolution := 'resolved';

    -- The owner is the house (locations.organization_id); the zone's own org is the fallback.
    SELECT loc.organization_id INTO v_client_org FROM public.locations loc WHERE loc.id = v_zone.location_id;
    v_client_org := COALESCE(v_client_org, p_org_id);

    -- The site facet on the same house, preferring one whose geometry holds the point.
    SELECT cs.id,
           CASE
             WHEN v_zone.onsite_profile = 'approach_10m'
               THEN st_dwithin(COALESCE(cs.center_point, cs.boundary)::geography, v_point::geography, 10)
             ELSE
               (cs.boundary IS NOT NULL AND st_contains(cs.boundary, v_point))
               OR st_dwithin(COALESCE(cs.center_point, cs.boundary)::geography,
                             v_point::geography,
                             COALESCE(cs.onsite_radius_meters, 10))
           END
      INTO v_site_id, v_on_site
    FROM public.client_sites cs
    WHERE cs.location_id = v_zone.location_id
      AND cs.active
    ORDER BY (cs.boundary IS NOT NULL AND st_contains(cs.boundary, v_point)) DESC,
             st_dwithin(COALESCE(cs.center_point, cs.boundary)::geography, v_point::geography, COALESCE(cs.onsite_radius_meters, 10)) DESC,
             cs.created_at
    LIMIT 1;
    v_on_site := COALESCE(v_on_site, false);

    SELECT COALESCE(jrs.rules, '{}'::jsonb)
      INTO v_rules
    FROM public.jurisdiction_rule_sets jrs
    WHERE jrs.id = v_zone.jurisdiction_rule_set_id;

    v_rules := COALESCE(v_rules, '{}'::jsonb)
      || jsonb_strip_nulls(jsonb_build_object(
           'repeat_stay_radius_m',      v_zone.repeat_stay_radius_m,
           'repeat_stay_window_nights', v_zone.repeat_stay_window_nights,
           'nightly_limit_consecutive', v_zone.nightly_limit_consecutive,
           'nightly_limit_monthly',     v_zone.nightly_limit_monthly,
           'scv_required',              v_zone.scv_required
         ))
      || COALESCE(v_zone.rule_overrides, '{}'::jsonb);
  ELSE
    IF v_resolution NOT IN ('unresolved_no_geofence', 'unresolved_invalid', 'unresolved_unverified') THEN
      IF EXISTS (
        SELECT 1 FROM public.location_zones z
        WHERE z.organization_id = p_org_id AND NOT z.is_verification_point
          AND z.boundary IS NOT NULL
          AND z.boundary_verification = 'unverified'
          AND ST_IsValid(z.boundary)
          AND NOT ST_IsEmpty(z.boundary)
          AND st_contains(z.boundary, v_point)
          AND (p_module_key IS NULL OR z.module_key = p_module_key)
          AND public._geofence_active_at(z.active_schedule, p_at)
      ) THEN
        v_resolution := 'unresolved_unverified';
      ELSIF EXISTS (
        SELECT 1 FROM public.location_zones z
        WHERE z.organization_id = p_org_id AND NOT z.is_verification_point
          AND z.boundary IS NOT NULL
          AND (NOT ST_IsValid(z.boundary) OR ST_IsEmpty(z.boundary))
          AND st_contains(z.boundary, v_point)
          AND (p_module_key IS NULL OR z.module_key = p_module_key)
          AND public._geofence_active_at(z.active_schedule, p_at)
      ) THEN
        v_resolution := 'unresolved_invalid';
      ELSE
        IF NOT EXISTS (
          SELECT 1 FROM public.location_zones z
          WHERE z.organization_id = p_org_id AND NOT z.is_verification_point
            AND z.boundary IS NOT NULL
            AND (p_module_key IS NULL OR z.module_key = p_module_key)
        ) THEN
          v_resolution := 'unresolved_no_geofence';
        END IF;
      END IF;
    END IF;
  END IF;

  RETURN QUERY SELECT
    v_in_bounds, v_oob_district, v_jur_id, v_jur_name,
    v_on_site, v_site_id, v_client_org,
    v_zone.id, v_zone.module_key, v_rules,
    v_resolution,
    v_gov_overlap;
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_officer_breadcrumb(p_client_event_id uuid, p_recorded_at timestamp with time zone, p_gps_lat double precision, p_gps_lng double precision, p_accuracy_meters double precision DEFAULT NULL::double precision, p_heading double precision DEFAULT NULL::double precision, p_speed_kmh double precision DEFAULT NULL::double precision, p_activity_type text DEFAULT 'gps_update'::text, p_shift_id uuid DEFAULT NULL::uuid, p_physical_address text DEFAULT NULL::text)
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
  v_assigned_zone uuid;
  v_existing public.officer_gps_log%rowtype;
  v_created public.officer_gps_log%rowtype;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT up.organization_id INTO v_home_org FROM public.user_profiles up
  WHERE up.id = v_user_id AND up.deactivated_at IS NULL AND up.role IN ('officer', 'admin_officer', 'scan_operator');
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
  -- A shift's own assigned zone wins when the fix is inside it, so the crumb is tied to the job, not to whichever geofence overlaps.
  BEGIN
    IF v_shift.id IS NOT NULL THEN
      SELECT z.id INTO v_assigned_zone
      FROM public.location_zones z
      WHERE z.id = coalesce(v_shift.zone_id,
                            (SELECT sal.zone_id FROM public.service_agreement_locations sal WHERE sal.id = v_shift.service_agreement_location_id))
        AND z.boundary IS NOT NULL
        AND z.boundary_verification = 'verified'
        AND ST_IsValid(z.boundary) AND NOT ST_IsEmpty(z.boundary)
        AND ST_Covers(z.boundary, ST_SetSRID(ST_Point(p_gps_lng, p_gps_lat), 4326));
    END IF;
    IF v_assigned_zone IS NOT NULL THEN
      v_zone_id := v_assigned_zone;
    ELSE
      SELECT r.matched_zone_id INTO v_zone_id FROM public.resolve_context(p_gps_lat, p_gps_lng, v_org_id, NULL, p_recorded_at) r LIMIT 1;
    END IF;
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
REVOKE ALL ON FUNCTION public.record_officer_breadcrumb(uuid, timestamp with time zone, double precision, double precision, double precision, double precision, double precision, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_officer_breadcrumb(uuid, timestamp with time zone, double precision, double precision, double precision, double precision, double precision, text, uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_live_officer_positions(p_organization_id uuid, p_since_minutes integer DEFAULT 240, p_zone_ids uuid[] DEFAULT NULL::uuid[])
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
               s.service_type, s.zone_id, s.location_id, s.patrol_route_id, s.service_agreement_location_id
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
      shift_site AS (
        -- The contracted place the shift is for: name, and whether the latest fix is on it (boundary, or the site's on-site radius).
        SELECT os.id AS shift_id, cs.id AS site_id, cs.name AS site_name,
               CASE WHEN l.gps_lat IS NULL OR l.gps_lng IS NULL OR coalesce(cs.boundary, cs.center_point) IS NULL THEN NULL
                    ELSE (cs.boundary IS NOT NULL AND ST_Covers(cs.boundary, ST_SetSRID(ST_Point(l.gps_lng, l.gps_lat), 4326)))
                         OR ST_DWithin(coalesce(cs.boundary, cs.center_point)::geography, ST_SetSRID(ST_Point(l.gps_lng, l.gps_lat), 4326)::geography, coalesce(cs.onsite_radius_meters, 10))
               END AS on_site,
               CASE WHEN l.gps_lat IS NULL OR l.gps_lng IS NULL OR coalesce(cs.boundary, cs.center_point) IS NULL THEN NULL
                    ELSE round(ST_Distance(coalesce(cs.boundary, cs.center_point)::geography, ST_SetSRID(ST_Point(l.gps_lng, l.gps_lat), 4326)::geography))::integer
               END AS distance_m
        FROM on_shift os
        JOIN public.service_agreement_locations sal ON sal.id = os.service_agreement_location_id
        JOIN public.client_sites cs ON cs.id = sal.site_id
        LEFT JOIN latest l ON l.officer_id = os.officer_user_id
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
        'site', CASE WHEN ss.site_id IS NULL THEN NULL ELSE jsonb_build_object('id', ss.site_id, 'name', ss.site_name, 'on_site', ss.on_site, 'distance_m', ss.distance_m) END,
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
      LEFT JOIN shift_site ss ON ss.shift_id = os.id
      LEFT JOIN alerting al ON al.officer_user_id = p.user_id
      WHERE p_zone_ids IS NULL OR cardinality(p_zone_ids) = 0
         OR l.detected_zone_id = ANY(p_zone_ids) OR os.zone_id = ANY(p_zone_ids)
    ), '[]'::jsonb)
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.get_live_officer_positions(uuid, integer, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_live_officer_positions(uuid, integer, uuid[]) TO authenticated, service_role;
