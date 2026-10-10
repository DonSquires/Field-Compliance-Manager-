BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS evidence_items_external_record_hash_unique
  ON public.evidence_items (
    organization_id,
    (metadata->>'record_kind'),
    (metadata->>'record_id'),
    sha256_hash
  )
  WHERE metadata->>'provenance' = 'external'
    AND nullif(metadata->>'record_id', '') IS NOT NULL
    AND sha256_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS observation_supporting_external_photo_unique
  ON public.observation_supporting_evidence (organization_id, observation_id, storage_path)
  WHERE evidence_kind = 'external_photo'
    AND observation_id IS NOT NULL
    AND storage_path IS NOT NULL;

CREATE OR REPLACE FUNCTION public.attach_external_photo_to_record(
  p_record_kind text,
  p_record_id uuid,
  p_storage_path text,
  p_sha256 text,
  p_description text DEFAULT NULL,
  p_source_note text DEFAULT NULL,
  p_original_name text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_org uuid;
  v_event_id uuid;
  v_evidence_id uuid;
  v_path text := nullif(trim(coalesce(p_storage_path, '')), '');
  v_hash text := lower(nullif(trim(coalesce(p_sha256, '')), ''));
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_record_kind NOT IN ('location_event', 'observation') THEN RAISE EXCEPTION 'Unsupported record kind %', p_record_kind; END IF;
  IF v_path IS NULL THEN RAISE EXCEPTION 'storage_path is required'; END IF;
  IF v_hash IS NULL OR v_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'A SHA-256 hash of the file is required'; END IF;

  IF p_record_kind = 'location_event' THEN
    SELECT e.organization_id, e.id INTO v_org, v_event_id
    FROM public.location_events e
    WHERE e.id = p_record_id;
  ELSE
    SELECT o.organization_id INTO v_org
    FROM public.observations o
    WHERE o.id = p_record_id;
  END IF;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Record not found'; END IF;
  IF NOT public.org_access_allowed(v_org) THEN RAISE EXCEPTION 'Not permitted to add evidence to this record'; END IF;

  IF position('org/' || v_org::text || '/record-evidence/' in v_path) <> 1 THEN
    RAISE EXCEPTION 'Evidence must be stored under org/%/record-evidence/', v_org;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    v_org::text || ':' || p_record_kind || ':' || p_record_id::text || ':' || v_hash,
    0
  ));

  SELECT id INTO v_evidence_id
  FROM public.evidence_items
  WHERE organization_id = v_org
    AND metadata->>'provenance' = 'external'
    AND metadata->>'record_kind' = p_record_kind
    AND metadata->>'record_id' = p_record_id::text
    AND sha256_hash = v_hash
  LIMIT 1;

  IF v_evidence_id IS NULL THEN
    INSERT INTO public.evidence_items (
      organization_id, module_key, evidence_kind, storage_path, captured_by_user_id, captured_at,
      sha256_hash, is_court_ready, retention_class, location_event_id, metadata
    ) VALUES (
      v_org, 'record_review', 'photo', v_path, v_user, clock_timestamp(),
      v_hash, false, 'policy_defined', v_event_id,
      jsonb_strip_nulls(jsonb_build_object(
        'provenance', 'external',
        'record_kind', p_record_kind,
        'record_id', p_record_id,
        'observation_id', CASE WHEN p_record_kind = 'observation' THEN p_record_id END,
        'description', nullif(trim(coalesce(p_description, '')), ''),
        'source_note', nullif(trim(coalesce(p_source_note, '')), ''),
        'original_name', nullif(trim(coalesce(p_original_name, '')), '')
      ))
    )
    RETURNING id INTO v_evidence_id;

    INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
    VALUES (
      v_org, v_user, 'external_photo_attached', 'evidence_items', v_evidence_id,
      jsonb_build_object(
        'record_kind', p_record_kind,
        'record_id', p_record_id,
        'sha256_hash', v_hash,
        'storage_path', v_path
      )
    );
  END IF;

  IF p_record_kind = 'observation' THEN
    INSERT INTO public.observation_supporting_evidence (
      organization_id, observation_id, evidence_kind, storage_bucket, storage_path, notes, created_by
    ) VALUES (
      v_org, p_record_id, 'external_photo', 'bob-uploads', v_path,
      nullif(trim(coalesce(p_description, '')), ''), v_user
    )
    ON CONFLICT (organization_id, observation_id, storage_path)
      WHERE evidence_kind = 'external_photo'
        AND observation_id IS NOT NULL
        AND storage_path IS NOT NULL
    DO NOTHING;
  END IF;

  RETURN v_evidence_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.attach_external_photo_to_record(text, uuid, text, text, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.attach_external_photo_to_record(text, uuid, text, text, text, text, text)
  TO authenticated, service_role;

COMMIT;