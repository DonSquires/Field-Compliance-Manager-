-- Correct the historical forestry roster projection.
-- The dedicated R&M roster is date/beat evidence and belongs in roster_assignments.
-- Field-ledger rows supplement dates/times; they are task lines, not roster_slots.

CREATE OR REPLACE FUNCTION public.notify_roster_assignment_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF new.external_refs->>'source' IN ('rm_forestry_roster_history', 'rm_patrol_log_roster_evidence') THEN
    RETURN new;
  END IF;
  PERFORM public.enqueue_notification(
    p_organization_id => new.organization_id,
    p_category => 'roster',
    p_title => 'New roster assignment',
    p_body => coalesce(new.shift, 'Shift') || ' assignment has been added for you.',
    p_severity => 'info',
    p_recipient_user_id => new.officer_id,
    p_recipient_role => null,
    p_link_page => 'roster',
    p_link_payload => jsonb_build_object('assignment_id', new.id),
    p_dedup_key => 'roster_assignment:' || new.id::text
  );
  RETURN new;
END;
$function$;

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
BEGIN
  RAISE EXCEPTION 'Superseded: import the dedicated forestry roster with apply_historical_roster_assignment_import';
END;
$function$;
COMMENT ON FUNCTION public.project_historical_patrol_roster(uuid, uuid, uuid, text[], jsonb, boolean) IS
  'Disabled after the first OFO projection incorrectly treated task-line geocodes as roster-route evidence. Use apply_historical_roster_assignment_import with the dedicated roster source.';

CREATE OR REPLACE FUNCTION public.apply_historical_roster_assignment_import(
  p_client_request_id uuid,
  p_organization_id uuid,
  p_client_organization_id uuid,
  p_source_file text,
  p_source_sha256 text,
  p_assignments jsonb,
  p_unresolved_values jsonb DEFAULT '[]'::jsonb,
  p_field_source_codes text[] DEFAULT '{}'::text[],
  p_field_route_by_officer jsonb DEFAULT '{}'::jsonb,
  p_remove_prior_projection boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_item jsonb;
  v_route public.patrol_routes%rowtype;
  v_officer public.user_profiles%rowtype;
  v_source_key text;
  v_inserted integer := 0;
  v_skipped integer := 0;
  v_field_inserted integer := 0;
  v_prior_slots_removed integer := 0;
  v_prior_route_places_removed integer := 0;
  v_receipt jsonb;
  v_row_count integer;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required'; END IF;
  IF NOT public.is_admin_for_org(p_organization_id) THEN RAISE EXCEPTION 'Roster administrator access required'; END IF;
  IF nullif(trim(coalesce(p_source_file, '')), '') IS NULL THEN RAISE EXCEPTION 'source_file is required'; END IF;
  IF p_source_sha256 !~ '^[A-Fa-f0-9]{64}$' THEN RAISE EXCEPTION 'source_sha256 must be a SHA-256 digest'; END IF;
  IF jsonb_typeof(p_assignments) <> 'array' THEN RAISE EXCEPTION 'assignments must be an array'; END IF;
  IF jsonb_typeof(p_unresolved_values) <> 'array' THEN RAISE EXCEPTION 'unresolved_values must be an array'; END IF;
  IF jsonb_typeof(p_field_route_by_officer) <> 'object' THEN RAISE EXCEPTION 'field_route_by_officer must be an object'; END IF;

  SELECT audit.metadata INTO v_receipt
  FROM public.audit_log audit
  WHERE audit.organization_id = p_organization_id
    AND audit.action = 'historical_roster_assignment_imported'
    AND audit.metadata->>'client_request_id' = p_client_request_id::text
  ORDER BY audit.created_at DESC
  LIMIT 1;
  IF FOUND THEN RETURN v_receipt; END IF;

  IF p_remove_prior_projection THEN
    DELETE FROM public.roster_slots slot
    WHERE slot.organization_id = p_organization_id
      AND slot.external_refs->>'source' = 'rm_patrol_log_roster_projection';
    GET DIAGNOSTICS v_prior_slots_removed = ROW_COUNT;

    DELETE FROM public.patrol_route_zones route_zone
    USING public.patrol_routes route
    WHERE route.id = route_zone.patrol_route_id
      AND route.organization_id = p_organization_id
      AND route.route_code IN ('RM-NELSON-FORESTRY', 'RM-BLENHEIM-FORESTRY')
      AND route_zone.notes = 'Historical coverage evidence; future cadence requires an approved delivery schedule.';
    GET DIAGNOSTICS v_prior_route_places_removed = ROW_COUNT;

    DELETE FROM public.patrol_route_sites route_site
    USING public.patrol_routes route
    WHERE route.id = route_site.patrol_route_id
      AND route.organization_id = p_organization_id
      AND route.route_code IN ('RM-NELSON-FORESTRY', 'RM-BLENHEIM-FORESTRY')
      AND route_site.notes = 'Historical coverage evidence; future cadence requires an approved delivery schedule.';
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    v_prior_route_places_removed := v_prior_route_places_removed + v_row_count;
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_assignments)
  LOOP
    IF nullif(v_item->>'source_key', '') IS NULL
       OR nullif(v_item->>'officer_id', '') IS NULL
       OR nullif(v_item->>'route_code', '') IS NULL
       OR nullif(v_item->>'specific_date', '') IS NULL
       OR (v_item->>'shift') NOT IN ('day', 'swing', 'night', 'overnight') THEN
      RAISE EXCEPTION 'Every assignment requires source_key, officer_id, route_code, specific_date and a valid shift';
    END IF;
    IF (v_item->>'specific_date')::date > current_date THEN
      RAISE EXCEPTION 'Historical assignment % is in the future', v_item->>'source_key';
    END IF;
    SELECT * INTO v_officer FROM public.user_profiles profile
    WHERE profile.id = (v_item->>'officer_id')::uuid
      AND profile.organization_id = p_organization_id
      AND profile.deactivated_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'Officer % is not active in this organization', v_item->>'officer_id'; END IF;
    SELECT * INTO v_route FROM public.patrol_routes route
    WHERE route.organization_id = p_organization_id
      AND upper(route.route_code) = upper(v_item->>'route_code')
      AND route.is_active;
    IF NOT FOUND THEN RAISE EXCEPTION 'Active route % was not found', v_item->>'route_code'; END IF;
    v_source_key := v_item->>'source_key';
    IF EXISTS (
      SELECT 1 FROM public.roster_assignments assignment
      WHERE assignment.organization_id = p_organization_id
        AND assignment.external_refs->>'source_key' = v_source_key
    ) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;
    INSERT INTO public.roster_assignments(
      organization_id, officer_id, patrol_route_id, service_type, specific_date,
      shift, start_time, end_time, assignment_status, notification_sent_at,
      created_by, external_refs
    ) VALUES (
      p_organization_id, v_officer.id, v_route.id, 'patrol', (v_item->>'specific_date')::date,
      v_item->>'shift', nullif(v_item->>'start_time', '')::time, nullif(v_item->>'end_time', '')::time,
      'confirmed', now(), v_actor,
      jsonb_build_object(
        'source', 'rm_forestry_roster_history',
        'source_key', v_source_key,
        'source_file', p_source_file,
        'source_sha256', lower(p_source_sha256),
        'source_sheet', v_item->>'source_sheet',
        'source_rows', coalesce(v_item->'source_rows', '[]'::jsonb),
        'beat_names', coalesce(v_item->'beat_names', '[]'::jsonb),
        'time_precision', coalesce(v_item->>'time_precision', 'date_only')
      )
    );
    v_inserted := v_inserted + 1;
  END LOOP;

  WITH raw AS (
    SELECT event.observed_entity_id AS officer_id, event.occurred_at,
           event.external_ref AS source_ref,
           CASE WHEN event.payload->>'job_time_hours' ~ '^[0-9]+([.][0-9]+)?$'
                THEN least(greatest((event.payload->>'job_time_hours')::numeric, 0), 24)
                ELSE 0 END AS duration_hours
    FROM public.location_events event
    WHERE event.source = 'rm_patrol_log_import'
      AND event.organization_id = p_client_organization_id
      AND event.observed_entity_type = 'staff'
      AND event.observed_entity_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM unnest(p_field_source_codes) code WHERE upper(code) = upper(split_part(event.external_ref, ':', 2)))
    UNION ALL
    SELECT observation.officer_id, observation.observed_at,
           observation.external_refs->>'external_ref',
           CASE WHEN observation.external_refs->'import'->>'job_time_hours' ~ '^[0-9]+([.][0-9]+)?$'
                THEN least(greatest((observation.external_refs->'import'->>'job_time_hours')::numeric, 0), 24)
                ELSE 0 END
    FROM public.observations observation
    WHERE observation.organization_id = p_client_organization_id
      AND EXISTS (SELECT 1 FROM unnest(p_field_source_codes) code WHERE upper(code) = upper(split_part(observation.external_refs->>'external_ref', ':', 2)))
  ), grouped AS (
    SELECT raw.officer_id,
           (raw.occurred_at AT TIME ZONE 'Pacific/Auckland')::date AS work_date,
           min(raw.occurred_at AT TIME ZONE 'Pacific/Auckland') AS first_local,
           max((raw.occurred_at AT TIME ZONE 'Pacific/Auckland') + make_interval(secs => raw.duration_hours::double precision * 3600)) AS last_local,
           count(*)::integer AS source_event_count,
           jsonb_agg(raw.source_ref ORDER BY raw.occurred_at, raw.source_ref) AS source_event_refs
    FROM raw
    WHERE (raw.occurred_at AT TIME ZONE 'Pacific/Auckland')::date <= current_date
    GROUP BY raw.officer_id, (raw.occurred_at AT TIME ZONE 'Pacific/Auckland')::date
  )
  INSERT INTO public.roster_assignments(
    organization_id, officer_id, patrol_route_id, service_type, specific_date,
    shift, start_time, end_time, assignment_status, notification_sent_at,
    created_by, external_refs
  )
  SELECT p_organization_id, profile.id, route.id, 'patrol', grouped.work_date,
         CASE WHEN extract(hour FROM grouped.first_local) < 6 OR extract(hour FROM grouped.first_local) >= 20 THEN 'night'
              WHEN extract(hour FROM grouped.first_local) >= 14 THEN 'swing' ELSE 'day' END,
         grouped.first_local::time,
         CASE WHEN grouped.last_local::date = grouped.work_date AND grouped.last_local > grouped.first_local THEN grouped.last_local::time ELSE NULL END,
         'confirmed', now(), v_actor,
         jsonb_build_object(
           'source', 'rm_patrol_log_roster_evidence',
           'source_key', 'rm_patrol_log_roster:' || profile.id::text || ':' || grouped.work_date::text,
           'source_codes', to_jsonb(p_field_source_codes),
           'source_event_count', grouped.source_event_count,
           'source_event_refs', grouped.source_event_refs,
           'time_precision', 'field_evidence'
         )
  FROM grouped
  JOIN public.user_profiles profile ON profile.id = grouped.officer_id
    AND profile.organization_id = p_organization_id AND profile.deactivated_at IS NULL
  JOIN public.patrol_routes route ON route.organization_id = p_organization_id
    AND upper(route.route_code) = upper(p_field_route_by_officer->>grouped.officer_id::text)
    AND route.is_active
  WHERE NOT EXISTS (
    SELECT 1 FROM public.roster_assignments existing
    WHERE existing.organization_id = p_organization_id
      AND existing.officer_id = profile.id
      AND existing.specific_date = grouped.work_date
      AND existing.external_refs->>'source' = 'rm_forestry_roster_history'
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.roster_assignments existing
    WHERE existing.organization_id = p_organization_id
      AND existing.external_refs->>'source_key' = 'rm_patrol_log_roster:' || profile.id::text || ':' || grouped.work_date::text
  );
  GET DIAGNOSTICS v_field_inserted = ROW_COUNT;

  v_receipt := jsonb_build_object(
    'client_request_id', p_client_request_id,
    'organization_id', p_organization_id,
    'source_file', p_source_file,
    'source_sha256', lower(p_source_sha256),
    'dedicated_assignments_received', jsonb_array_length(p_assignments),
    'dedicated_assignments_inserted', v_inserted,
    'dedicated_assignments_skipped', v_skipped,
    'field_assignments_inserted', v_field_inserted,
    'unresolved_values', p_unresolved_values,
    'prior_slots_removed', v_prior_slots_removed,
    'prior_route_places_removed', v_prior_route_places_removed,
    'notifications_created', 0,
    'shifts_created', 0
  );
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, metadata)
  VALUES (p_organization_id, v_actor, 'historical_roster_assignment_imported', 'roster_assignments', v_receipt);
  RETURN v_receipt;
END;
$function$;

COMMENT ON FUNCTION public.apply_historical_roster_assignment_import(uuid, uuid, uuid, text, text, jsonb, jsonb, text[], jsonb, boolean) IS
  'Imports date-specific historical assignments from R&M roster evidence, supplements missing dates from field-log evidence, suppresses historical notifications, and optionally removes the superseded task-geocode roster_slots projection. PostgreSQL-only, audited and replay-safe.';
REVOKE ALL ON FUNCTION public.apply_historical_roster_assignment_import(uuid, uuid, uuid, text, text, jsonb, jsonb, text[], jsonb, boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.apply_historical_roster_assignment_import(uuid, uuid, uuid, text, text, jsonb, jsonb, text[], jsonb, boolean) TO postgres;