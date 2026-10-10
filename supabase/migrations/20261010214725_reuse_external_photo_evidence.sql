CREATE OR REPLACE FUNCTION public.attach_external_photo_to_record(
  p_record_kind text,
  p_record_id uuid,
  p_storage_path text,
  p_sha256 text,
  p_description text DEFAULT NULL::text,
  p_source_note text DEFAULT NULL::text,
  p_original_name text DEFAULT NULL::text,
  p_captured_at timestamptz DEFAULT NULL::timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_org uuid;
  v_event_id uuid;
  v_evidence_id uuid;
  v_support_id uuid;
  v_path text := nullif(trim(coalesce(p_storage_path, '')), '');
  v_evidence_path text;
  v_hash text := lower(nullif(trim(coalesce(p_sha256, '')), ''));
  v_captured_at timestamptz := coalesce(p_captured_at, clock_timestamp());
  v_reused boolean := false;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_record_kind NOT IN ('location_event', 'observation') THEN
    RAISE EXCEPTION 'Unsupported record kind %', p_record_kind;
  END IF;
  IF v_path IS NULL THEN
    RAISE EXCEPTION 'storage_path is required';
  END IF;
  IF v_hash IS NULL OR v_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'A SHA-256 hash of the file is required';
  END IF;

  IF p_record_kind = 'location_event' THEN
    SELECT event.organization_id, event.id
      INTO v_org, v_event_id
      FROM public.location_events AS event
     WHERE event.id = p_record_id;
  ELSE
    SELECT observation.organization_id
      INTO v_org
      FROM public.observations AS observation
     WHERE observation.id = p_record_id;
  END IF;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Record not found';
  END IF;
  IF NOT public.org_access_allowed(v_org) THEN
    RAISE EXCEPTION 'Not permitted to add evidence to this record';
  END IF;
  IF position('org/' || v_org::text || '/record-evidence/' in v_path) <> 1 THEN
    RAISE EXCEPTION 'Evidence must be stored under org/%/record-evidence/', v_org;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    v_org::text || ':photo:' || v_hash,
    0
  ));

  SELECT evidence.id, evidence.storage_path
    INTO v_evidence_id, v_evidence_path
    FROM public.evidence_items AS evidence
   WHERE evidence.organization_id = v_org
     AND evidence.evidence_kind = 'photo'
     AND lower(evidence.sha256_hash) = v_hash
   ORDER BY (
     evidence.metadata->>'record_kind' = p_record_kind
     AND evidence.metadata->>'record_id' = p_record_id::text
   ) DESC,
     evidence.captured_at
   LIMIT 1
   FOR UPDATE;

  IF v_evidence_id IS NULL THEN
    v_evidence_path := v_path;
    INSERT INTO public.evidence_items (
      organization_id,
      module_key,
      evidence_kind,
      storage_path,
      captured_by_user_id,
      captured_at,
      sha256_hash,
      is_court_ready,
      retention_class,
      location_event_id,
      metadata
    ) VALUES (
      v_org,
      'record_review',
      'photo',
      v_evidence_path,
      v_user,
      v_captured_at,
      v_hash,
      false,
      'policy_defined',
      v_event_id,
      jsonb_strip_nulls(jsonb_build_object(
        'provenance', 'external',
        'record_kind', p_record_kind,
        'record_id', p_record_id,
        'observation_id', CASE
          WHEN p_record_kind = 'observation' THEN p_record_id
        END,
        'linked_observation_ids', CASE
          WHEN p_record_kind = 'observation'
          THEN jsonb_build_array(p_record_id::text)
        END,
        'description', nullif(trim(coalesce(p_description, '')), ''),
        'source_note', nullif(trim(coalesce(p_source_note, '')), ''),
        'original_name', nullif(trim(coalesce(p_original_name, '')), ''),
        'source_captured_at', p_captured_at
      ))
    )
    RETURNING id INTO v_evidence_id;

    INSERT INTO public.audit_log (
      organization_id, actor_user_id, action, target_table, target_id, metadata
    ) VALUES (
      v_org,
      v_user,
      'external_photo_attached',
      'evidence_items',
      v_evidence_id,
      jsonb_strip_nulls(jsonb_build_object(
        'record_kind', p_record_kind,
        'record_id', p_record_id,
        'sha256_hash', v_hash,
        'storage_path', v_evidence_path,
        'source_captured_at', p_captured_at
      ))
    );
  ELSE
    v_reused := true;
    IF p_record_kind = 'observation' THEN
      UPDATE public.evidence_items
         SET metadata = jsonb_set(
           coalesce(metadata, '{}'::jsonb),
           '{linked_observation_ids}',
           CASE
             WHEN coalesce(metadata->'linked_observation_ids', '[]'::jsonb)
               @> jsonb_build_array(p_record_id::text)
             THEN coalesce(metadata->'linked_observation_ids', '[]'::jsonb)
             ELSE coalesce(metadata->'linked_observation_ids', '[]'::jsonb)
               || jsonb_build_array(p_record_id::text)
           END,
           true
         )
       WHERE id = v_evidence_id;
    END IF;
  END IF;

  IF p_record_kind = 'observation' THEN
    INSERT INTO public.observation_supporting_evidence (
      organization_id,
      observation_id,
      evidence_kind,
      storage_bucket,
      storage_path,
      notes,
      captured_at,
      created_by
    ) VALUES (
      v_org,
      p_record_id,
      'external_photo',
      'bob-uploads',
      v_evidence_path,
      nullif(trim(coalesce(p_description, '')), ''),
      v_captured_at,
      v_user
    )
    ON CONFLICT (organization_id, observation_id, storage_path)
      WHERE evidence_kind = 'external_photo'
        AND observation_id IS NOT NULL
        AND storage_path IS NOT NULL
    DO NOTHING
    RETURNING id INTO v_support_id;

    IF v_reused AND v_support_id IS NOT NULL THEN
      INSERT INTO public.audit_log (
        organization_id, actor_user_id, action, target_table, target_id, metadata
      ) VALUES (
        v_org,
        v_user,
        'external_photo_reused_for_observation',
        'evidence_items',
        v_evidence_id,
        jsonb_build_object(
          'observation_id', p_record_id,
          'sha256_hash', v_hash,
          'storage_path', v_evidence_path
        )
      );
    END IF;
  END IF;

  RETURN v_evidence_id;
END;
$function$;

COMMENT ON FUNCTION public.attach_external_photo_to_record(
  text, uuid, text, text, text, text, text, timestamptz
) IS
  'Registers an external photo or reuses the organization''s existing hash-addressed evidence item, then creates an idempotent record link. Source capture time, provenance, non-court-ready state, and an audit receipt are preserved.';
REVOKE ALL ON FUNCTION public.attach_external_photo_to_record(
  text, uuid, text, text, text, text, text, timestamptz
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.attach_external_photo_to_record(
  text, uuid, text, text, text, text, text, timestamptz
) TO postgres, authenticated, service_role;

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
        'id', coalesce(evidence.id, supporting.id),
        'storage_path', supporting.storage_path,
        'captured_at', coalesce(evidence.captured_at, supporting.captured_at),
        'sha256_hash', evidence.sha256_hash,
        'description', coalesce(
          evidence.metadata->>'description',
          supporting.notes
        ),
        'original_name', evidence.metadata->>'original_name',
        'source_note', evidence.metadata->>'source_note'
      ) ORDER BY coalesce(evidence.captured_at, supporting.captured_at))
      FROM public.observation_supporting_evidence AS supporting
      LEFT JOIN public.evidence_items AS evidence
        ON evidence.organization_id = supporting.organization_id
       AND evidence.storage_path = supporting.storage_path
      WHERE supporting.organization_id = observation.organization_id
        AND supporting.observation_id = observation.id
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