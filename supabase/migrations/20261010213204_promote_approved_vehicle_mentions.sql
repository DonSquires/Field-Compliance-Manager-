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
  v_candidate record;
  v_vehicle_id uuid;
  v_observation_id uuid;
  v_import_key text;
  v_inserted integer := 0;
  v_matched integer := 0;
  v_candidates integer := 0;
  v_vehicles integer := 0;
BEGIN
  IF v_actor IS NULL OR NOT public.is_admin_for_org(p_provider_organization_id) THEN
    RAISE EXCEPTION 'Provider administrator access required';
  END IF;

  FOR v_candidate IN
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
        normalized.plate
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
    SELECT * FROM extracted
    ORDER BY occurred_at, event_id, plate
  LOOP
    v_candidates := v_candidates + 1;
    v_import_key := 'rm_approved_note_plate:' || v_candidate.event_id::text || ':' || v_candidate.plate;

    v_vehicle_id := public.ensure_canonical_vehicle(
      v_candidate.plate,
      NULL,
      NULL,
      NULL,
      'location_events',
      v_candidate.event_id::text || ':' || v_candidate.plate,
      v_candidate.occurred_at
    );
    IF v_vehicle_id IS NULL THEN
      RAISE EXCEPTION 'Could not resolve canonical vehicle for plate %', v_candidate.plate;
    END IF;

    SELECT observation.id
      INTO v_observation_id
      FROM public.observations AS observation
     WHERE observation.organization_id = v_candidate.organization_id
       AND public.normalize_plate_number(observation.plate_number) = v_candidate.plate
       AND observation.observed_at = v_candidate.occurred_at
       AND observation.zone_id IS NOT DISTINCT FROM v_candidate.zone_id
       AND observation.site_id IS NOT DISTINCT FROM v_candidate.site_id
     ORDER BY (observation.import_key = v_import_key) DESC, observation.created_at
     LIMIT 1;

    IF v_observation_id IS NULL THEN
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
      ) VALUES (
        v_candidate.organization_id,
        v_candidate.officer_id,
        v_candidate.plate,
        v_candidate.zone_id,
        v_candidate.site_id,
        v_candidate.location_id,
        v_candidate.occurred_at,
        'historical_import',
        CASE
          WHEN v_candidate.event_type = 'camera_activation'
            OR v_candidate.comments ~* '\m(cctv|camera)\M'
          THEN 'cctv_review'
          ELSE 'patrol'
        END,
        v_vehicle_id,
        v_candidate.comments,
        v_candidate.occurred_at,
        jsonb_build_object(
          'external_ref', v_import_key,
          'approved_working_file', jsonb_strip_nulls(jsonb_build_object(
            'source_event_id', v_candidate.event_id,
            'source_event_type', v_candidate.event_type,
            'source_file', v_candidate.payload->>'source_file',
            'source_sha256', v_candidate.payload->>'source_sha256',
            'source_sheet', v_candidate.payload->>'source_sheet',
            'source_row', v_candidate.payload->>'source_row',
            'review_state', 'approved_in_working_file',
            'promoted_by', v_actor,
            'promoted_at', clock_timestamp()
          ))
        ),
        'vehicle',
        nullif(regexp_replace(coalesce(v_candidate.payload->>'source_file', ''), '^.*[\\/]', ''), ''),
        'local://rm/approved-working-files/' || coalesce(
          nullif(v_candidate.payload->>'source_sha256', ''),
          v_candidate.event_id::text
        ),
        nullif(v_candidate.payload->>'source_sha256', ''),
        concat_ws(
          ':',
          nullif(v_candidate.payload->>'source_sheet', ''),
          nullif(v_candidate.payload->>'source_row', '')
        ),
        v_import_key
      )
      ON CONFLICT (organization_id, import_key)
        WHERE import_key IS NOT NULL
      DO NOTHING
      RETURNING id INTO v_observation_id;

      IF v_observation_id IS NOT NULL THEN
        v_inserted := v_inserted + 1;
        INSERT INTO public.audit_log (
          organization_id,
          actor_user_id,
          action,
          target_table,
          target_id,
          metadata
        ) VALUES (
          v_candidate.organization_id,
          v_actor,
          'approved_working_file_plate_promoted',
          'observations',
          v_observation_id,
          jsonb_build_object(
            'plate', v_candidate.plate,
            'canonical_vehicle_id', v_vehicle_id,
            'source_event_id', v_candidate.event_id,
            'source_review_state', 'approved_in_working_file',
            'provider_organization_id', p_provider_organization_id
          )
        );
      ELSE
        SELECT observation.id
          INTO v_observation_id
          FROM public.observations AS observation
         WHERE observation.organization_id = v_candidate.organization_id
           AND observation.import_key = v_import_key;
        v_matched := v_matched + 1;
      END IF;
    ELSE
      UPDATE public.observations
         SET canonical_vehicle_id = coalesce(canonical_vehicle_id, v_vehicle_id)
       WHERE id = v_observation_id;
      v_matched := v_matched + 1;
    END IF;

    INSERT INTO public.canonical_vehicle_links (
      canonical_vehicle_id,
      source_system,
      source_table,
      source_key,
      metadata
    ) VALUES (
      v_vehicle_id,
      'approved_working_file_observation',
      'location_events',
      v_candidate.event_id::text || ':' || v_candidate.plate,
      jsonb_strip_nulls(jsonb_build_object(
        'organization_id', v_candidate.organization_id,
        'provider_organization_id', p_provider_organization_id,
        'observation_id', v_observation_id,
        'source_sha256', v_candidate.payload->>'source_sha256',
        'source_file', v_candidate.payload->>'source_file',
        'source_sheet', v_candidate.payload->>'source_sheet',
        'source_row', v_candidate.payload->>'source_row',
        'review_state', 'approved_in_working_file'
      ))
    )
    ON CONFLICT (source_system, source_table, source_key)
    DO UPDATE SET metadata = excluded.metadata;

    UPDATE public.canonical_vehicles
       SET last_seen_at = CASE
             WHEN last_seen_at IS NULL OR last_seen_at < v_candidate.occurred_at
             THEN v_candidate.occurred_at
             ELSE last_seen_at
           END,
           updated_at = clock_timestamp()
     WHERE id = v_vehicle_id;

    v_vehicles := v_vehicles + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'candidates', v_candidates,
    'observations_inserted', v_inserted,
    'observations_matched', v_matched,
    'vehicle_links_processed', v_vehicles
  );
END;
$function$;

COMMENT ON FUNCTION public.promote_approved_rnm_vehicle_mentions(uuid) IS
  'Promotes plate observations already approved in R&M patrol/CCTV working files into replay-safe canonical vehicle observations. The source event, note, file provenance, place, and audit receipt are retained.';
REVOKE ALL ON FUNCTION public.promote_approved_rnm_vehicle_mentions(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.promote_approved_rnm_vehicle_mentions(uuid)
  TO postgres, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_identity_vehicle_activity(
  p_organization_id uuid,
  p_canonical_vehicle_id uuid,
  p_limit integer DEFAULT 200
)
RETURNS TABLE (
  observation_id uuid,
  organization_id uuid,
  observed_at timestamptz,
  source_kind text,
  place_name text,
  officer_notes text,
  source_document_name text,
  source_reference text,
  source_locator text,
  evidence_items jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN
    RAISE EXCEPTION 'Identity registry administrator access required';
  END IF;

  RETURN QUERY
  WITH visible_organizations AS (
    SELECT p_organization_id AS id
    UNION
    SELECT unnest(public.get_descendant_organizations(p_organization_id))
    UNION
    SELECT agreement.client_organization_id
    FROM public.service_agreements AS agreement
    WHERE agreement.provider_organization_id = p_organization_id
      AND agreement.agreement_type = 'operational'
      AND agreement.invitation_status = 'accepted'
  )
  SELECT
    observation.id,
    observation.organization_id,
    observation.observed_at,
    CASE
      WHEN observation.module_key = 'cctv_review' THEN 'CCTV review'
      WHEN observation.plate_source = 'historical_import' THEN 'Approved patrol record'
      ELSE 'Field observation'
    END,
    coalesce(zone.name, site.name, location.name, 'Place not recorded'),
    observation.officer_notes,
    observation.source_document_name,
    observation.source_reference,
    observation.source_locator,
    coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', evidence.id,
        'storage_path', evidence.storage_path,
        'captured_at', evidence.captured_at,
        'sha256_hash', evidence.sha256_hash,
        'description', evidence.metadata->>'description',
        'original_name', evidence.metadata->>'original_name',
        'source_note', evidence.metadata->>'source_note'
      ) ORDER BY evidence.captured_at)
      FROM public.evidence_items AS evidence
      WHERE evidence.organization_id = observation.organization_id
        AND evidence.metadata->>'observation_id' = observation.id::text
    ), '[]'::jsonb)
  FROM public.observations AS observation
  JOIN visible_organizations AS visible
    ON visible.id = observation.organization_id
  LEFT JOIN public.location_zones AS zone
    ON zone.id = observation.zone_id
  LEFT JOIN public.client_sites AS site
    ON site.id = observation.site_id
  LEFT JOIN public.locations AS location
    ON location.id = observation.location_id
  WHERE observation.canonical_vehicle_id = p_canonical_vehicle_id
  ORDER BY observation.observed_at DESC, observation.id
  LIMIT least(greatest(coalesce(p_limit, 200), 1), 500);
END;
$function$;

COMMENT ON FUNCTION public.get_identity_vehicle_activity(uuid, uuid, integer) IS
  'Administrator-only observation and private-evidence history for a canonical vehicle across the provider organization and accepted operational clients.';
REVOKE ALL ON FUNCTION public.get_identity_vehicle_activity(uuid, uuid, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_identity_vehicle_activity(uuid, uuid, integer)
  TO postgres, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_identity_registry(
  p_organization_id uuid,
  p_search text DEFAULT NULL::text,
  p_limit integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_search text := lower(trim(coalesce(p_search, '')));
  v_limit integer := greatest(1, least(coalesce(p_limit, 100), 250));
  v_visible_organizations uuid[];
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN
    RAISE EXCEPTION 'Identity registry administrator access required';
  END IF;

  SELECT array_agg(DISTINCT scope.id)
    INTO v_visible_organizations
    FROM (
      SELECT p_organization_id AS id
      UNION
      SELECT unnest(public.get_descendant_organizations(p_organization_id))
      UNION
      SELECT agreement.client_organization_id
      FROM public.service_agreements AS agreement
      WHERE agreement.provider_organization_id = p_organization_id
        AND agreement.agreement_type = 'operational'
        AND agreement.invitation_status = 'accepted'
    ) AS scope;

  RETURN jsonb_build_object(
    'people', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'person_record_id', person.id,
        'canonical_person_id', link.canonical_person_id,
        'display_name', person.display_name,
        'review_state', person.review_state,
        'profile_details', coalesce(person.metadata->'profile_details', '{}'::jsonb),
        'date_of_birth', coalesce(person.metadata->'profile_details'->>'date_of_birth', canonical.date_of_birth::text),
        'canonical_review_state', canonical.review_state,
        'face_candidate_ready', EXISTS (
          SELECT 1 FROM public.person_face_templates face
          WHERE face.person_record_id = person.id
            AND face.organization_id = person.organization_id
        ),
        'document_count', (
          SELECT count(*)
          FROM public.person_identity_documents document
          WHERE document.person_record_id = person.id
        )
      ) ORDER BY lower(coalesce(person.display_name, '')), person.created_at)
      FROM (
        SELECT *
        FROM public.person_records
        WHERE organization_id = p_organization_id
          AND (
            v_search = ''
            OR lower(coalesce(display_name, '') || ' ' || coalesce(metadata::text, ''))
              LIKE '%' || v_search || '%'
          )
        ORDER BY created_at DESC
        LIMIT v_limit
      ) AS person
      LEFT JOIN public.canonical_person_links AS link
        ON link.source_table = 'person_records'
       AND link.source_id = person.id
      LEFT JOIN public.canonical_people AS canonical
        ON canonical.id = link.canonical_person_id
    ), '[]'::jsonb),
    'vehicle_total', (
      SELECT count(*)
      FROM public.canonical_vehicles AS vehicle
      WHERE (
        vehicle.org_notes ? p_organization_id::text
        OR EXISTS (
          SELECT 1
          FROM public.canonical_vehicle_links AS link
          WHERE link.canonical_vehicle_id = vehicle.id
            AND nullif(link.metadata->>'organization_id', '')::uuid = ANY(v_visible_organizations)
        )
        OR EXISTS (
          SELECT 1
          FROM public.observations AS observation
          WHERE observation.organization_id = ANY(v_visible_organizations)
            AND observation.canonical_vehicle_id = vehicle.id
        )
        OR EXISTS (
          SELECT 1
          FROM public.cctv_entity_observations AS observation
          WHERE observation.organization_id = ANY(v_visible_organizations)
            AND observation.canonical_vehicle_id = vehicle.id
        )
      )
      AND (
        v_search = ''
        OR lower(concat_ws(
          ' ',
          vehicle.plate_number,
          vehicle.make,
          vehicle.model,
          vehicle.colour,
          vehicle.body_type
        )) LIKE '%' || v_search || '%'
      )
    ),
    'vehicles', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', vehicle.id,
        'plate_number', vehicle.plate_number,
        'make', vehicle.make,
        'model', vehicle.model,
        'year', vehicle.year,
        'colour', vehicle.colour,
        'body_type', vehicle.body_type,
        'rego_status', vehicle.rego_status,
        'rego_expiry', vehicle.rego_expiry,
        'wof_status', vehicle.wof_status,
        'wof_expiry', vehicle.wof_expiry,
        'cof_status', vehicle.cof_status,
        'cof_expiry', vehicle.cof_expiry,
        'notes', vehicle.org_notes->p_organization_id::text->>'text',
        'compliance_source', vehicle.compliance_source,
        'compliance_checked_at', vehicle.compliance_checked_at,
        'observation_count', (
          SELECT count(*)
          FROM public.observations AS observation
          WHERE observation.organization_id = ANY(v_visible_organizations)
            AND observation.canonical_vehicle_id = vehicle.id
        ),
        'evidence_count', (
          SELECT count(*)
          FROM public.observations AS observation
          JOIN public.evidence_items AS evidence
            ON evidence.organization_id = observation.organization_id
           AND evidence.metadata->>'observation_id' = observation.id::text
          WHERE observation.organization_id = ANY(v_visible_organizations)
            AND observation.canonical_vehicle_id = vehicle.id
        ),
        'first_seen_at', (
          SELECT min(observation.observed_at)
          FROM public.observations AS observation
          WHERE observation.organization_id = ANY(v_visible_organizations)
            AND observation.canonical_vehicle_id = vehicle.id
        ),
        'last_seen_at', (
          SELECT max(observation.observed_at)
          FROM public.observations AS observation
          WHERE observation.organization_id = ANY(v_visible_organizations)
            AND observation.canonical_vehicle_id = vehicle.id
        ),
        'source_kinds', coalesce((
          SELECT jsonb_agg(source.kind ORDER BY source.kind)
          FROM (
            SELECT DISTINCT CASE
              WHEN observation.module_key = 'cctv_review' THEN 'CCTV review'
              WHEN observation.plate_source = 'historical_import' THEN 'Approved patrol record'
              ELSE 'Field observation'
            END AS kind
            FROM public.observations AS observation
            WHERE observation.organization_id = ANY(v_visible_organizations)
              AND observation.canonical_vehicle_id = vehicle.id
          ) AS source
        ), '[]'::jsonb)
      ) ORDER BY coalesce(vehicle.last_seen_at, vehicle.updated_at) DESC, vehicle.plate_number)
      FROM (
        SELECT *
        FROM public.canonical_vehicles AS candidate
        WHERE (
          candidate.org_notes ? p_organization_id::text
          OR EXISTS (
            SELECT 1
            FROM public.canonical_vehicle_links AS link
            WHERE link.canonical_vehicle_id = candidate.id
              AND nullif(link.metadata->>'organization_id', '')::uuid = ANY(v_visible_organizations)
          )
          OR EXISTS (
            SELECT 1
            FROM public.observations AS observation
            WHERE observation.organization_id = ANY(v_visible_organizations)
              AND observation.canonical_vehicle_id = candidate.id
          )
          OR EXISTS (
            SELECT 1
            FROM public.cctv_entity_observations AS observation
            WHERE observation.organization_id = ANY(v_visible_organizations)
              AND observation.canonical_vehicle_id = candidate.id
          )
        )
        AND (
          v_search = ''
          OR lower(concat_ws(
            ' ',
            candidate.plate_number,
            candidate.make,
            candidate.model,
            candidate.colour,
            candidate.body_type
          )) LIKE '%' || v_search || '%'
        )
        ORDER BY coalesce(candidate.last_seen_at, candidate.updated_at) DESC, candidate.plate_number
        LIMIT v_limit
      ) AS vehicle
    ), '[]'::jsonb),
    'documents', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', document.id,
        'person_record_id', document.person_record_id,
        'evidence_item_id', document.evidence_item_id,
        'attachment_id', document.attachment_id,
        'document_kind', document.document_kind,
        'extracted_fields', document.extracted_fields,
        'review_state', document.review_state,
        'review_notes', document.review_notes,
        'created_at', document.created_at,
        'reviewed_at', document.reviewed_at,
        'file_name', attachment.file_name,
        'file_type', attachment.file_type,
        'storage_bucket', attachment.storage_bucket,
        'storage_path', attachment.storage_path
      ) ORDER BY document.created_at DESC)
      FROM public.person_identity_documents AS document
      LEFT JOIN public.bob_attachments AS attachment
        ON attachment.id = document.attachment_id
      WHERE document.organization_id = p_organization_id
    ), '[]'::jsonb)
  );
END;
$function$;

COMMENT ON FUNCTION public.get_identity_registry(uuid, text, integer) IS
  'Administrator-only tenant registry of people and all canonical vehicles evidenced by the organization or its accepted operational clients. Vehicle results include source, sighting, and evidence summaries.';
REVOKE ALL ON FUNCTION public.get_identity_registry(uuid, text, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_identity_registry(uuid, text, integer)
  TO postgres, authenticated, service_role;