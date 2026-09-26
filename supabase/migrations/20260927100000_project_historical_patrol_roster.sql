-- Project already-imported patrol evidence into route templates and completed roster history.
-- This does not create future shifts or infer a contractual delivery schedule.

CREATE OR REPLACE FUNCTION public.project_historical_patrol_roster(
  p_client_request_id uuid,
  p_provider_organization_id uuid,
  p_client_organization_id uuid,
  p_source_codes text[],
  p_routes jsonb,
  p_link_missing_agreement_locations boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_agreement_id uuid;
  v_route_def jsonb;
  v_route public.patrol_routes%rowtype;
  v_unit public.roster_work_units%rowtype;
  v_existing_slot public.roster_slots%rowtype;
  v_place record;
  v_slot record;
  v_route_count integer;
  v_row_count integer;
  v_routes_created integer := 0;
  v_units_created integer := 0;
  v_places_attached integer := 0;
  v_agreement_locations_linked integer := 0;
  v_slots_inserted integer := 0;
  v_slots_updated integer := 0;
  v_slots_conflicted integer := 0;
  v_source_events integer := 0;
  v_unresolved_staff integer := 0;
  v_unresolved_place integer := 0;
  v_uncontracted_place integer := 0;
  v_ambiguous_staff_days integer := 0;
  v_receipt jsonb;
  v_slot_request_id uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required'; END IF;
  IF p_provider_organization_id IS NULL OR p_client_organization_id IS NULL THEN
    RAISE EXCEPTION 'Provider and client organizations are required';
  END IF;
  IF NOT public.is_admin_for_org(p_provider_organization_id) THEN
    RAISE EXCEPTION 'Provider roster administrator access required';
  END IF;
  SELECT agreement.id INTO v_agreement_id
  FROM public.service_agreements agreement
    WHERE agreement.provider_organization_id = p_provider_organization_id
      AND agreement.client_organization_id = p_client_organization_id
      AND agreement.agreement_type = 'operational'
      AND agreement.invitation_status IN ('not_invited', 'invited', 'accepted')
  ORDER BY CASE WHEN agreement.invitation_status = 'accepted' THEN 0 ELSE 1 END, agreement.created_at DESC
  LIMIT 1;
  IF v_agreement_id IS NULL THEN
    RAISE EXCEPTION 'A live operational agreement between provider and client is required';
  END IF;
  IF coalesce(cardinality(p_source_codes), 0) = 0 THEN RAISE EXCEPTION 'At least one source code is required'; END IF;
  IF jsonb_typeof(p_routes) <> 'array' OR jsonb_array_length(p_routes) = 0 THEN
    RAISE EXCEPTION 'At least one route definition is required';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_routes) route
    GROUP BY upper(trim(route->>'route_code'))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Route codes must be unique within the projection';
  END IF;

  SELECT audit.metadata INTO v_receipt
  FROM public.audit_log audit
  WHERE audit.organization_id = p_provider_organization_id
    AND audit.action = 'historical_patrol_roster_projected'
    AND audit.metadata->>'client_request_id' = p_client_request_id::text
  ORDER BY audit.created_at DESC
  LIMIT 1;
  IF FOUND THEN RETURN v_receipt; END IF;

  DROP TABLE IF EXISTS pg_temp._historical_patrol_routes;
  CREATE TEMP TABLE pg_temp._historical_patrol_routes (
    route_code text PRIMARY KEY,
    route_name text NOT NULL,
    route_id uuid NOT NULL,
    work_unit_id uuid NOT NULL,
    hub public.geometry(Point, 4326) NOT NULL
  ) ON COMMIT DROP;

  FOR v_route_def IN SELECT value FROM jsonb_array_elements(p_routes)
  LOOP
    IF nullif(trim(v_route_def->>'route_code'), '') IS NULL
       OR nullif(trim(v_route_def->>'name'), '') IS NULL
       OR (v_route_def->>'hub_lat') IS NULL
       OR (v_route_def->>'hub_lng') IS NULL THEN
      RAISE EXCEPTION 'Every route requires route_code, name, hub_lat and hub_lng';
    END IF;
    IF (v_route_def->>'hub_lat')::double precision NOT BETWEEN -90 AND 90
       OR (v_route_def->>'hub_lng')::double precision NOT BETWEEN -180 AND 180 THEN
      RAISE EXCEPTION 'Route hub coordinates are invalid for %', v_route_def->>'route_code';
    END IF;

    SELECT count(*) INTO v_route_count
    FROM public.patrol_routes route
    WHERE route.organization_id = p_provider_organization_id
      AND upper(route.route_code) = upper(trim(v_route_def->>'route_code'));
    IF v_route_count > 1 THEN
      RAISE EXCEPTION 'More than one patrol route uses route code %', v_route_def->>'route_code';
    ELSIF v_route_count = 0 THEN
      INSERT INTO public.patrol_routes(
        organization_id, name, route_code, description, route_type,
        assignment_type, checkpoint_mode, is_active
      ) VALUES (
        p_provider_organization_id,
        trim(v_route_def->>'name'),
        upper(trim(v_route_def->>'route_code')),
        'Historical route template projected from imported R&M field evidence. Future frequency and time windows require a separately approved delivery schedule.',
        'mobile', 'client_patrol', 'none', true
      ) RETURNING * INTO v_route;
      v_routes_created := v_routes_created + 1;
    ELSE
      SELECT * INTO v_route FROM public.patrol_routes route
      WHERE route.organization_id = p_provider_organization_id
        AND upper(route.route_code) = upper(trim(v_route_def->>'route_code'));
      IF NOT v_route.is_active THEN RAISE EXCEPTION 'Patrol route % is inactive', v_route.route_code; END IF;
    END IF;

    SELECT * INTO v_unit FROM public.roster_work_units unit
    WHERE unit.organization_id = p_provider_organization_id
      AND unit.name = trim(v_route_def->>'name');
    IF NOT FOUND THEN
      INSERT INTO public.roster_work_units(
        organization_id, name, work_unit_type, service_type, patrol_route_id,
        active, created_by, external_refs
      ) VALUES (
        p_provider_organization_id, trim(v_route_def->>'name'), 'patrol', 'patrol',
        v_route.id, true, v_actor,
        jsonb_build_object(
          'source', 'rm_patrol_log_roster_projection',
          'client_organization_id', p_client_organization_id,
          'source_codes', to_jsonb(p_source_codes),
          'route_code', upper(trim(v_route_def->>'route_code'))
        )
      ) RETURNING * INTO v_unit;
      v_units_created := v_units_created + 1;
    ELSIF v_unit.work_unit_type <> 'patrol' OR v_unit.patrol_route_id <> v_route.id THEN
      RAISE EXCEPTION 'Work unit % already exists with a different target', v_unit.name;
    END IF;

    INSERT INTO pg_temp._historical_patrol_routes(route_code, route_name, route_id, work_unit_id, hub)
    VALUES (
      upper(trim(v_route_def->>'route_code')), trim(v_route_def->>'name'), v_route.id, v_unit.id,
      ST_SetSRID(ST_MakePoint((v_route_def->>'hub_lng')::double precision, (v_route_def->>'hub_lat')::double precision), 4326)
    );
  END LOOP;

  DROP TABLE IF EXISTS pg_temp._historical_patrol_source;
  CREATE TEMP TABLE pg_temp._historical_patrol_source ON COMMIT DROP AS
  WITH raw AS (
    SELECT event.external_ref AS source_ref, event.occurred_at, event.observed_entity_id AS user_id,
           event.zone_id, event.client_site_id AS site_id, event.payload->>'job_time_hours' AS job_time_hours
    FROM public.location_events event
    WHERE event.organization_id = p_client_organization_id
      AND event.source = 'rm_patrol_log_import'
      AND event.observed_entity_type = 'staff'
      AND event.observed_entity_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM unnest(p_source_codes) source_code
        WHERE upper(source_code) = upper(split_part(event.external_ref, ':', 2))
      )
    UNION ALL
    SELECT observation.external_refs->>'external_ref', observation.observed_at, observation.officer_id,
           observation.zone_id, observation.site_id,
           observation.external_refs->'import'->>'job_time_hours'
    FROM public.observations observation
    WHERE observation.organization_id = p_client_organization_id
      AND EXISTS (
        SELECT 1 FROM unnest(p_source_codes) source_code
        WHERE upper(source_code) = upper(split_part(observation.external_refs->>'external_ref', ':', 2))
      )
  ), resolved AS (
    SELECT raw.*,
      staff.id AS staff_id,
      agreement_location.id AS agreement_location_id,
      coalesce(zone.center_point, parent_zone.center_point, site.center_point,
               zone_place.center_point, parent_place.center_point, site_place.center_point) AS point,
      CASE WHEN raw.job_time_hours ~ '^[0-9]+([.][0-9]+)?$'
           THEN least(greatest(raw.job_time_hours::numeric, 0), 24)
           ELSE NULL END AS duration_hours
    FROM raw
    LEFT JOIN LATERAL (
      SELECT profile.id
      FROM public.staff_profiles profile
      JOIN public.user_profiles user_profile ON user_profile.id = coalesce(profile.user_id, profile.id)
      WHERE profile.organization_id = p_provider_organization_id
        AND (profile.user_id = raw.user_id OR profile.id = raw.user_id)
        AND user_profile.deactivated_at IS NULL
      ORDER BY (profile.user_id = raw.user_id) DESC
      LIMIT 1
    ) staff ON true
    LEFT JOIN public.location_zones zone ON zone.id = raw.zone_id
    LEFT JOIN public.location_zones parent_zone ON parent_zone.id = zone.parent_zone_id
    LEFT JOIN public.locations zone_location ON zone_location.id = zone.location_id
    LEFT JOIN public.canonical_places zone_place ON zone_place.id = zone_location.canonical_place_id
    LEFT JOIN public.locations parent_location ON parent_location.id = parent_zone.location_id
    LEFT JOIN public.canonical_places parent_place ON parent_place.id = parent_location.canonical_place_id
    LEFT JOIN public.client_sites site ON site.id = raw.site_id
    LEFT JOIN public.locations site_location ON site_location.id = site.location_id
    LEFT JOIN public.canonical_places site_place ON site_place.id = site_location.canonical_place_id
    LEFT JOIN LATERAL (
      SELECT location.id
      FROM public.service_agreement_locations location
      WHERE location.service_agreement_id = v_agreement_id
        AND location.status = 'active'
        AND location.site_id IS NOT DISTINCT FROM raw.site_id
        AND location.zone_id IS NOT DISTINCT FROM raw.zone_id
      LIMIT 1
    ) agreement_location ON true
  )
  SELECT * FROM resolved;

  IF p_link_missing_agreement_locations THEN
    INSERT INTO public.service_agreement_locations(service_agreement_id, zone_id, status, created_by)
    SELECT DISTINCT v_agreement_id, source.zone_id, 'active', v_actor
    FROM pg_temp._historical_patrol_source source
    JOIN public.location_zones zone ON zone.id = source.zone_id
    WHERE source.agreement_location_id IS NULL
      AND zone.organization_id = p_client_organization_id
      AND zone.is_active
    ON CONFLICT(service_agreement_id, zone_id) DO UPDATE SET status = 'active', updated_at = clock_timestamp();
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    v_agreement_locations_linked := v_agreement_locations_linked + v_row_count;

    INSERT INTO public.service_agreement_locations(service_agreement_id, site_id, status, created_by)
    SELECT DISTINCT v_agreement_id, source.site_id, 'active', v_actor
    FROM pg_temp._historical_patrol_source source
    JOIN public.client_sites site ON site.id = source.site_id
    WHERE source.agreement_location_id IS NULL
      AND site.client_organization_id = p_client_organization_id
      AND site.active
    ON CONFLICT(service_agreement_id, site_id) DO UPDATE SET status = 'active', updated_at = clock_timestamp();
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    v_agreement_locations_linked := v_agreement_locations_linked + v_row_count;

    UPDATE pg_temp._historical_patrol_source source
    SET agreement_location_id = location.id
    FROM public.service_agreement_locations location
    WHERE location.service_agreement_id = v_agreement_id
      AND location.status = 'active'
      AND location.site_id IS NOT DISTINCT FROM source.site_id
      AND location.zone_id IS NOT DISTINCT FROM source.zone_id;
  END IF;

  SELECT count(*), count(*) FILTER (WHERE staff_id IS NULL), count(*) FILTER (WHERE point IS NULL),
         count(*) FILTER (WHERE agreement_location_id IS NULL)
  INTO v_source_events, v_unresolved_staff, v_unresolved_place, v_uncontracted_place
  FROM pg_temp._historical_patrol_source;

  DROP TABLE IF EXISTS pg_temp._historical_patrol_classified;
  CREATE TEMP TABLE pg_temp._historical_patrol_classified ON COMMIT DROP AS
  SELECT source.*, route.route_code, route.route_name, route.route_id, route.work_unit_id
  FROM pg_temp._historical_patrol_source source
  JOIN LATERAL (
    SELECT candidate.*
    FROM pg_temp._historical_patrol_routes candidate
    ORDER BY ST_DistanceSphere(source.point, candidate.hub), candidate.route_code
    LIMIT 1
  ) route ON source.staff_id IS NOT NULL AND source.point IS NOT NULL AND source.agreement_location_id IS NOT NULL;

  FOR v_place IN
    SELECT route_id, zone_id, site_id
    FROM pg_temp._historical_patrol_classified
    GROUP BY route_id, zone_id, site_id
  LOOP
    IF v_place.zone_id IS NOT NULL THEN
      INSERT INTO public.patrol_route_zones(patrol_route_id, zone_id, required_module, notes)
      VALUES (v_place.route_id, v_place.zone_id, 'patrol', 'Historical coverage evidence; future cadence requires an approved delivery schedule.')
      ON CONFLICT (patrol_route_id, zone_id) DO NOTHING;
    ELSE
      INSERT INTO public.patrol_route_sites(patrol_route_id, site_id, required_module, notes)
      VALUES (v_place.route_id, v_place.site_id, 'patrol', 'Historical coverage evidence; future cadence requires an approved delivery schedule.')
      ON CONFLICT (patrol_route_id, site_id) DO NOTHING;
    END IF;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    v_places_attached := v_places_attached + v_row_count;
  END LOOP;

  DROP TABLE IF EXISTS pg_temp._historical_patrol_slots;
  CREATE TEMP TABLE pg_temp._historical_patrol_slots ON COMMIT DROP AS
  SELECT classified.route_code, classified.route_name, classified.work_unit_id, classified.staff_id,
         (classified.occurred_at AT TIME ZONE 'Pacific/Auckland')::date AS work_date,
         min(classified.occurred_at) AS scheduled_start,
         least(
           greatest(
             max(classified.occurred_at + make_interval(secs => coalesce(classified.duration_hours, 0)::double precision * 3600)),
             min(classified.occurred_at) + interval '1 minute'
           ),
           min(classified.occurred_at) + interval '24 hours'
         ) AS scheduled_end,
         count(*)::integer AS source_event_count,
         jsonb_agg(classified.source_ref ORDER BY classified.occurred_at, classified.source_ref) AS source_event_refs
  FROM pg_temp._historical_patrol_classified classified
  GROUP BY classified.route_code, classified.route_name, classified.work_unit_id, classified.staff_id,
           (classified.occurred_at AT TIME ZONE 'Pacific/Auckland')::date;

  SELECT count(*) INTO v_ambiguous_staff_days
  FROM pg_temp._historical_patrol_slots candidate
  WHERE EXISTS (
    SELECT 1 FROM pg_temp._historical_patrol_slots other
    WHERE other.staff_id = candidate.staff_id
      AND other.work_date = candidate.work_date
      AND other.route_code <> candidate.route_code
      AND other.scheduled_start < candidate.scheduled_end
      AND other.scheduled_end > candidate.scheduled_start
  );

  FOR v_slot IN
    SELECT * FROM pg_temp._historical_patrol_slots candidate
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_temp._historical_patrol_slots other
      WHERE other.staff_id = candidate.staff_id
        AND other.work_date = candidate.work_date
        AND other.route_code <> candidate.route_code
        AND other.scheduled_start < candidate.scheduled_end
        AND other.scheduled_end > candidate.scheduled_start
    )
    ORDER BY candidate.work_date, candidate.scheduled_start, candidate.route_code, candidate.staff_id
  LOOP
    v_slot_request_id := md5(
      p_provider_organization_id::text || ':' || p_client_organization_id::text || ':' ||
      v_slot.route_code || ':' || v_slot.staff_id::text || ':' || v_slot.work_date::text
    )::uuid;
    SELECT * INTO v_existing_slot FROM public.roster_slots slot
    WHERE slot.organization_id = p_provider_organization_id
      AND slot.client_request_id = v_slot_request_id;
    IF FOUND THEN
      IF v_existing_slot.external_refs->>'source' <> 'rm_patrol_log_roster_projection' THEN
        RAISE EXCEPTION 'Roster slot idempotency key collides with a non-projection slot';
      END IF;
      UPDATE public.roster_slots
      SET scheduled_start = v_slot.scheduled_start,
          scheduled_end = v_slot.scheduled_end,
          status = 'completed',
          notes = 'Historical patrol duty reconstructed from imported field evidence; not a future roster commitment.',
          external_refs = jsonb_build_object(
            'source', 'rm_patrol_log_roster_projection',
            'client_organization_id', p_client_organization_id,
            'source_codes', to_jsonb(p_source_codes),
            'route_code', v_slot.route_code,
            'work_date', v_slot.work_date,
            'source_event_count', v_slot.source_event_count,
            'source_event_refs', v_slot.source_event_refs
          ),
          updated_at = now()
      WHERE id = v_existing_slot.id;
      v_slots_updated := v_slots_updated + 1;
    ELSIF EXISTS (
      SELECT 1 FROM public.roster_slots slot
      WHERE slot.staff_id = v_slot.staff_id
        AND slot.status NOT IN ('declined', 'cancelled')
        AND slot.scheduled_start < v_slot.scheduled_end
        AND slot.scheduled_end > v_slot.scheduled_start
    ) THEN
      v_slots_conflicted := v_slots_conflicted + 1;
    ELSE
      INSERT INTO public.roster_slots(
        organization_id, work_unit_id, staff_id, scheduled_start, scheduled_end,
        status, client_request_id, notes, created_by, external_refs
      ) VALUES (
        p_provider_organization_id, v_slot.work_unit_id, v_slot.staff_id,
        v_slot.scheduled_start, v_slot.scheduled_end, 'completed', v_slot_request_id,
        'Historical patrol duty reconstructed from imported field evidence; not a future roster commitment.',
        v_actor,
        jsonb_build_object(
          'source', 'rm_patrol_log_roster_projection',
          'client_organization_id', p_client_organization_id,
          'source_codes', to_jsonb(p_source_codes),
          'route_code', v_slot.route_code,
          'work_date', v_slot.work_date,
          'source_event_count', v_slot.source_event_count,
          'source_event_refs', v_slot.source_event_refs
        )
      );
      v_slots_inserted := v_slots_inserted + 1;
    END IF;
  END LOOP;

  v_receipt := jsonb_build_object(
    'client_request_id', p_client_request_id,
    'provider_organization_id', p_provider_organization_id,
    'client_organization_id', p_client_organization_id,
    'source_codes', to_jsonb(p_source_codes),
    'routes_created', v_routes_created,
    'work_units_created', v_units_created,
    'agreement_locations_linked', v_agreement_locations_linked,
    'route_places_attached', v_places_attached,
    'source_staff_events', v_source_events,
    'unresolved_staff_events', v_unresolved_staff,
    'unresolved_place_events', v_unresolved_place,
    'uncontracted_place_events', v_uncontracted_place,
    'ambiguous_staff_days', v_ambiguous_staff_days,
    'slots_inserted', v_slots_inserted,
    'slots_updated', v_slots_updated,
    'slots_conflicted', v_slots_conflicted,
    'future_schedule_created', false,
    'shifts_created', 0
  );

  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, metadata)
  VALUES (p_provider_organization_id, v_actor, 'historical_patrol_roster_projected', 'roster_slots', v_receipt);
  RETURN v_receipt;
END;
$function$;

COMMENT ON FUNCTION public.project_historical_patrol_roster(uuid, uuid, uuid, text[], jsonb, boolean) IS
  'Projects provenance-bearing imported patrol events into permanent route/work-unit templates and completed historical roster slots. Missing active client-place coverage may be linked only through the explicit opt-in parameter. It never creates identities, shifts, or future delivery schedules; unclassified places and ambiguous days are reported rather than guessed.';

REVOKE ALL ON FUNCTION public.project_historical_patrol_roster(uuid, uuid, uuid, text[], jsonb, boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.project_historical_patrol_roster(uuid, uuid, uuid, text[], jsonb, boolean) TO postgres;