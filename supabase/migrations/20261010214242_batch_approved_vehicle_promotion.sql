CREATE OR REPLACE FUNCTION public.promote_approved_rnm_vehicle_mentions(
  p_provider_organization_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_candidates integer := 0;
  v_inserted integer := 0;
  v_audited integer := 0;
BEGIN
  IF v_actor IS NULL OR NOT public.is_admin_for_org(p_provider_organization_id) THEN
    RAISE EXCEPTION 'Provider administrator access required';
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS approved_rnm_vehicle_mentions_batch (
    event_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    zone_id uuid,
    site_id uuid,
    location_id uuid,
    occurred_at timestamptz NOT NULL,
    event_type text NOT NULL,
    officer_id uuid,
    payload jsonb NOT NULL,
    comments text NOT NULL,
    plate text NOT NULL,
    import_key text NOT NULL,
    PRIMARY KEY (event_id, plate)
  ) ON COMMIT DROP;
  TRUNCATE pg_temp.approved_rnm_vehicle_mentions_batch;

  INSERT INTO pg_temp.approved_rnm_vehicle_mentions_batch (
    event_id, organization_id, zone_id, site_id, location_id,
    occurred_at, event_type, officer_id, payload, comments, plate, import_key
  )
  WITH scoped_organizations AS (
    SELECT p_provider_organization_id AS organization_id
    UNION
    SELECT unnest(public.get_descendant_organizations(p_provider_organization_id))
    UNION
    SELECT agreement.client_organization_id
    FROM public.service_agreements AS agreement
    WHERE agreement.provider_organization_id = p_provider_organization_id
      AND agreement.agreement_type = 'operational'
      AND agreement.invitation_status = 'accepted'
  ),
  extracted AS (
    SELECT DISTINCT ON (event.id, normalized.plate)
      event.id AS event_id,
      event.organization_id,
      event.zone_id,
      event.client_site_id AS site_id,
      coalesce(source_zone.location_id, source_site.location_id) AS location_id,
      event.occurred_at,
      event.event_type,
      CASE
        WHEN event.observed_entity_type = 'staff'
          AND EXISTS (
            SELECT 1 FROM public.user_profiles profile
            WHERE profile.id = event.observed_entity_id
          )
        THEN event.observed_entity_id
      END AS officer_id,
      event.payload,
      event.payload->>'comments' AS comments,
      normalized.plate,
      'rm_approved_note_plate:' || event.id::text || ':' || normalized.plate AS import_key
    FROM public.location_events AS event
    JOIN scoped_organizations AS scope
      ON scope.organization_id = event.organization_id
    LEFT JOIN public.location_zones AS source_zone
      ON source_zone.id = event.zone_id
    LEFT JOIN public.client_sites AS source_site
      ON source_site.id = event.client_site_id
    CROSS JOIN LATERAL regexp_matches(
      coalesce(event.payload->>'comments', ''),
      '\m([A-Z]{2,3}[0-9]{2,4}|[0-9]{1,3}[A-Z]{2,3})\M',
      'gi'
    ) AS matched(value)
    CROSS JOIN LATERAL (
      SELECT public.normalize_plate_number(matched.value[1]) AS plate
    ) AS normalized
    WHERE event.payload->>'source' = 'rm_patrol_log_import'
      AND normalized.plate IS NOT NULL
    ORDER BY event.id, normalized.plate
  )
  SELECT
    extracted.event_id,
    extracted.organization_id,
    extracted.zone_id,
    extracted.site_id,
    extracted.location_id,
    extracted.occurred_at,
    extracted.event_type,
    extracted.officer_id,
    extracted.payload,
    extracted.comments,
    extracted.plate,
    extracted.import_key
  FROM extracted
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.canonical_vehicle_links AS processed
    WHERE processed.source_system = 'approved_working_file_observation'
      AND processed.source_table = 'location_events'
      AND processed.source_key = extracted.event_id::text || ':' || extracted.plate
  )
  ORDER BY extracted.occurred_at, extracted.event_id, extracted.plate
  LIMIT 100;
  GET DIAGNOSTICS v_candidates = ROW_COUNT;

  IF v_candidates = 0 THEN
    RETURN jsonb_build_object(
      'candidates', 0,
      'observations_inserted', 0,
      'observations_matched', 0,
      'audit_receipts_inserted', 0
    );
  END IF;

  INSERT INTO public.canonical_vehicles (
    plate_number, last_seen_at, created_at, updated_at
  )
  SELECT
    candidate.plate,
    max(candidate.occurred_at),
    clock_timestamp(),
    clock_timestamp()
  FROM pg_temp.approved_rnm_vehicle_mentions_batch AS candidate
  GROUP BY candidate.plate
  ON CONFLICT (plate_number)
  DO UPDATE SET
    last_seen_at = greatest(
      public.canonical_vehicles.last_seen_at,
      excluded.last_seen_at
    ),
    updated_at = clock_timestamp();

  INSERT INTO public.observations (
    organization_id,
    officer_id,
    plate_number,
    zone_id,
    site_id,
    location_id,
    observed_at,
    plate_source,
    module_key,
    canonical_vehicle_id,
    officer_notes,
    officer_notes_updated_at,
    external_refs,
    subject_kind,
    source_document_name,
    source_reference,
    source_sha256,
    source_locator,
    import_key
  )
  SELECT
    candidate.organization_id,
    candidate.officer_id,
    candidate.plate,
    candidate.zone_id,
    candidate.site_id,
    candidate.location_id,
    candidate.occurred_at,
    'historical_import',
    CASE
      WHEN candidate.event_type = 'camera_activation'
        OR candidate.comments ~* '\m(cctv|camera)\M'
      THEN 'cctv_review'
      ELSE 'patrol'
    END,
    vehicle.id,
    candidate.comments,
    candidate.occurred_at,
    jsonb_build_object(
      'external_ref', candidate.import_key,
      'approved_working_file', jsonb_strip_nulls(jsonb_build_object(
        'source_event_id', candidate.event_id,
        'source_event_type', candidate.event_type,
        'source_file', candidate.payload->>'source_file',
        'source_sha256', candidate.payload->>'source_sha256',
        'source_sheet', candidate.payload->>'source_sheet',
        'source_row', candidate.payload->>'source_row',
        'review_state', 'approved_in_working_file',
        'promoted_by', v_actor,
        'promoted_at', clock_timestamp()
      ))
    ),
    'vehicle',
    nullif(regexp_replace(coalesce(candidate.payload->>'source_file', ''), '^.*[\\/]', ''), ''),
    'local://rm/approved-working-files/' || coalesce(
      nullif(candidate.payload->>'source_sha256', ''),
      candidate.event_id::text
    ),
    nullif(candidate.payload->>'source_sha256', ''),
    concat_ws(
      ':',
      nullif(candidate.payload->>'source_sheet', ''),
      nullif(candidate.payload->>'source_row', '')
    ),
    candidate.import_key
  FROM pg_temp.approved_rnm_vehicle_mentions_batch AS candidate
  JOIN public.canonical_vehicles AS vehicle
    ON vehicle.plate_number = candidate.plate
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.observations AS existing
    WHERE existing.organization_id = candidate.organization_id
      AND public.normalize_plate_number(existing.plate_number) = candidate.plate
      AND existing.observed_at = candidate.occurred_at
      AND existing.zone_id IS NOT DISTINCT FROM candidate.zone_id
      AND existing.site_id IS NOT DISTINCT FROM candidate.site_id
  )
  ON CONFLICT (organization_id, import_key)
    WHERE import_key IS NOT NULL
  DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  UPDATE public.observations AS observation
     SET canonical_vehicle_id = coalesce(
       observation.canonical_vehicle_id,
       vehicle.id
     )
    FROM pg_temp.approved_rnm_vehicle_mentions_batch AS candidate
    JOIN public.canonical_vehicles AS vehicle
      ON vehicle.plate_number = candidate.plate
   WHERE observation.organization_id = candidate.organization_id
     AND public.normalize_plate_number(observation.plate_number) = candidate.plate
     AND observation.observed_at = candidate.occurred_at
     AND observation.zone_id IS NOT DISTINCT FROM candidate.zone_id
     AND observation.site_id IS NOT DISTINCT FROM candidate.site_id;

  INSERT INTO public.canonical_vehicle_links (
    canonical_vehicle_id,
    source_system,
    source_table,
    source_key,
    metadata
  )
  SELECT
    vehicle.id,
    'approved_working_file_observation',
    'location_events',
    candidate.event_id::text || ':' || candidate.plate,
    jsonb_strip_nulls(jsonb_build_object(
      'organization_id', candidate.organization_id,
      'provider_organization_id', p_provider_organization_id,
      'observation_id', observation.id,
      'source_sha256', candidate.payload->>'source_sha256',
      'source_file', candidate.payload->>'source_file',
      'source_sheet', candidate.payload->>'source_sheet',
      'source_row', candidate.payload->>'source_row',
      'review_state', 'approved_in_working_file'
    ))
  FROM pg_temp.approved_rnm_vehicle_mentions_batch AS candidate
  JOIN public.canonical_vehicles AS vehicle
    ON vehicle.plate_number = candidate.plate
  JOIN LATERAL (
    SELECT existing.id
    FROM public.observations AS existing
    WHERE existing.organization_id = candidate.organization_id
      AND public.normalize_plate_number(existing.plate_number) = candidate.plate
      AND existing.observed_at = candidate.occurred_at
      AND existing.zone_id IS NOT DISTINCT FROM candidate.zone_id
      AND existing.site_id IS NOT DISTINCT FROM candidate.site_id
    ORDER BY (existing.import_key = candidate.import_key) DESC, existing.created_at
    LIMIT 1
  ) AS observation ON true
  ON CONFLICT (source_system, source_table, source_key)
  DO UPDATE SET metadata = excluded.metadata;

  INSERT INTO public.audit_log (
    organization_id,
    actor_user_id,
    action,
    target_table,
    target_id,
    metadata
  )
  SELECT
    candidate.organization_id,
    v_actor,
    'approved_working_file_plate_promoted',
    'observations',
    observation.id,
    jsonb_build_object(
      'plate', candidate.plate,
      'canonical_vehicle_id', vehicle.id,
      'source_event_id', candidate.event_id,
      'source_review_state', 'approved_in_working_file',
      'provider_organization_id', p_provider_organization_id
    )
  FROM pg_temp.approved_rnm_vehicle_mentions_batch AS candidate
  JOIN public.canonical_vehicles AS vehicle
    ON vehicle.plate_number = candidate.plate
  JOIN public.observations AS observation
    ON observation.organization_id = candidate.organization_id
   AND public.normalize_plate_number(observation.plate_number) = candidate.plate
   AND observation.observed_at = candidate.occurred_at
   AND observation.zone_id IS NOT DISTINCT FROM candidate.zone_id
   AND observation.site_id IS NOT DISTINCT FROM candidate.site_id
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.audit_log AS receipt
    WHERE receipt.action = 'approved_working_file_plate_promoted'
      AND receipt.target_table = 'observations'
      AND receipt.target_id = observation.id
      AND receipt.metadata->>'source_event_id' = candidate.event_id::text
  );
  GET DIAGNOSTICS v_audited = ROW_COUNT;

  RETURN jsonb_build_object(
    'candidates', v_candidates,
    'observations_inserted', v_inserted,
    'observations_matched', v_candidates - v_inserted,
    'audit_receipts_inserted', v_audited
  );
END;
$function$;

COMMENT ON FUNCTION public.promote_approved_rnm_vehicle_mentions(uuid) IS
  'Promotes up to 100 unprocessed plate observations already approved in R&M patrol/CCTV working files. Repeated calls drain the replay-safe queue while retaining source event, note, file provenance, place, canonical link, and audit receipt.';