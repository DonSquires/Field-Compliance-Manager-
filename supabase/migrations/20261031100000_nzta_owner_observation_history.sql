CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_links_nzta_owner_history_check
  ON public.entity_links (organization_id, (evidence->>'nzta_owner_history_first_check_id'))
  WHERE relationship = 'registered_owner'
    AND evidence ? 'nzta_owner_history_first_check_id';

CREATE OR REPLACE FUNCTION public.sync_nzta_registered_owner_history(
  p_organization_id uuid,
  p_canonical_vehicle_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_episode record;
  v_link_id uuid;
  v_episode_count integer := 0;
  v_current_person uuid;
  v_manual_link_count integer;
  v_episode_keys text[];
BEGIN
  IF v_actor IS NULL
     OR NOT public.is_admin_for_org(p_organization_id)
     OR NOT public.can_access_vehicle_owner_identity(p_organization_id, true) THEN
    RAISE EXCEPTION 'Vehicle owner identity administrator access required';
  END IF;

  PERFORM 1
  FROM public.canonical_vehicles
  WHERE id = p_canonical_vehicle_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Canonical vehicle not found'; END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.vehicle_identity_checks check_row
    JOIN public.person_identity_documents document
      ON document.id = check_row.identity_document_id
     AND document.organization_id = check_row.organization_id
    WHERE check_row.organization_id = p_organization_id
      AND check_row.canonical_vehicle_id = p_canonical_vehicle_id
      AND check_row.source_authority = 'NZTA Motor Vehicle Register'
      AND check_row.relationship = 'registered_person_at_check'
      AND document.document_kind = 'nzta_mvr_record'
      AND (document.review_state = 'approved'
        OR check_row.vehicle_snapshot->>'owner_only_review' = 'true')
  ) THEN
    RAISE EXCEPTION 'No reviewed NZTA registered-person checks exist for this vehicle';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.vehicle_identity_checks check_row
    JOIN public.person_identity_documents document
      ON document.id = check_row.identity_document_id
     AND document.organization_id = check_row.organization_id
    WHERE check_row.organization_id = p_organization_id
      AND check_row.canonical_vehicle_id = p_canonical_vehicle_id
      AND check_row.source_authority = 'NZTA Motor Vehicle Register'
      AND check_row.relationship = 'registered_person_at_check'
      AND document.document_kind = 'nzta_mvr_record'
      AND (document.review_state = 'approved'
        OR check_row.vehicle_snapshot->>'owner_only_review' = 'true')
    GROUP BY check_row.checked_at
    HAVING count(DISTINCT check_row.canonical_person_id) > 1
  ) THEN
    RAISE EXCEPTION 'Conflicting owners share an NZTA check timestamp; owner history was not changed';
  END IF;

  SELECT count(*) INTO v_manual_link_count
  FROM public.entity_links link
  WHERE link.organization_id = p_organization_id
    AND link.from_type = 'person'
    AND link.to_type = 'vehicle'
    AND link.to_id = p_canonical_vehicle_id
    AND link.relationship = 'registered_owner'
    AND link.active
    AND link.evidence->>'source' IS DISTINCT FROM 'nzta_mvr';
  IF v_manual_link_count > 0 THEN
    RAISE EXCEPTION 'A manually recorded registered owner needs review before NZTA history can be synchronized';
  END IF;

  SELECT check_row.canonical_person_id
    INTO v_current_person
  FROM public.vehicle_identity_checks check_row
  JOIN public.person_identity_documents document
    ON document.id = check_row.identity_document_id
   AND document.organization_id = check_row.organization_id
  WHERE check_row.organization_id = p_organization_id
    AND check_row.canonical_vehicle_id = p_canonical_vehicle_id
    AND check_row.source_authority = 'NZTA Motor Vehicle Register'
    AND check_row.relationship = 'registered_person_at_check'
    AND document.document_kind = 'nzta_mvr_record'
    AND (document.review_state = 'approved'
      OR check_row.vehicle_snapshot->>'owner_only_review' = 'true')
  ORDER BY check_row.checked_at DESC, check_row.id DESC
  LIMIT 1;

  WITH source_checks AS (
    SELECT check_row.id, check_row.checked_at, check_row.canonical_person_id
    FROM public.vehicle_identity_checks check_row
    JOIN public.person_identity_documents document
      ON document.id = check_row.identity_document_id
     AND document.organization_id = check_row.organization_id
    WHERE check_row.organization_id = p_organization_id
      AND check_row.canonical_vehicle_id = p_canonical_vehicle_id
      AND check_row.source_authority = 'NZTA Motor Vehicle Register'
      AND check_row.relationship = 'registered_person_at_check'
      AND document.document_kind = 'nzta_mvr_record'
      AND (document.review_state = 'approved'
        OR check_row.vehicle_snapshot->>'owner_only_review' = 'true')
  ),
  ordered_checks AS (
    SELECT source_checks.*,
           lag(canonical_person_id) OVER (ORDER BY checked_at, id) AS previous_person_id
    FROM source_checks
  ),
  numbered_checks AS (
    SELECT ordered_checks.*,
           sum(CASE WHEN previous_person_id IS DISTINCT FROM canonical_person_id THEN 1 ELSE 0 END)
             OVER (ORDER BY checked_at, id) AS episode_number
    FROM ordered_checks
  ),
  episodes AS (
    SELECT episode_number,
           (array_agg(id ORDER BY checked_at, id))[1] AS first_check_id
    FROM numbered_checks
    GROUP BY episode_number
  )
  SELECT coalesce(array_agg(first_check_id::text), ARRAY[]::text[])
    INTO v_episode_keys
  FROM episodes;

  UPDATE public.entity_links link
  SET active = false,
      ends_at = coalesce(link.ends_at, clock_timestamp()),
      evidence = link.evidence || jsonb_build_object(
        'superseded_by_reconciliation', true,
        'reconciled_at', clock_timestamp()
      ),
      updated_at = clock_timestamp()
  WHERE link.organization_id = p_organization_id
    AND link.from_type = 'person'
    AND link.to_type = 'vehicle'
    AND link.to_id = p_canonical_vehicle_id
    AND link.relationship = 'registered_owner'
    AND link.evidence ? 'nzta_owner_history_first_check_id'
    AND NOT (link.evidence->>'nzta_owner_history_first_check_id' = ANY(v_episode_keys));

  UPDATE public.entity_links link
  SET active = false,
      ends_at = coalesce(link.ends_at, clock_timestamp()),
      evidence = link.evidence || CASE WHEN EXISTS (
          SELECT 1 FROM public.vehicle_identity_checks seen
          WHERE seen.organization_id = p_organization_id
            AND seen.canonical_vehicle_id = p_canonical_vehicle_id
            AND seen.canonical_person_id = link.from_id
            AND seen.relationship = 'registered_person_at_check'
        ) THEN jsonb_build_object(
          'superseded_by_reconciliation', true,
          'replaced_by_owner_history', true,
          'reconciled_at', clock_timestamp()
        ) ELSE jsonb_build_object('reconciled_at', clock_timestamp()) END,
      updated_at = clock_timestamp()
  WHERE link.organization_id = p_organization_id
    AND link.from_type = 'person'
    AND link.to_type = 'vehicle'
    AND link.to_id = p_canonical_vehicle_id
    AND link.relationship = 'registered_owner'
    AND link.active
    AND link.evidence->>'source' = 'nzta_mvr'
    AND NOT (link.evidence ? 'nzta_owner_history_first_check_id');

  UPDATE public.entity_links link
  SET active = false,
      ends_at = coalesce(link.ends_at, clock_timestamp()),
      updated_at = clock_timestamp()
  WHERE link.organization_id = p_organization_id
    AND link.from_type = 'person'
    AND link.to_type = 'vehicle'
    AND link.to_id = p_canonical_vehicle_id
    AND link.relationship = 'registered_owner'
    AND link.active
    AND link.evidence ? 'nzta_owner_history_first_check_id';

  FOR v_episode IN
    WITH source_checks AS (
      SELECT check_row.id, check_row.checked_at, check_row.canonical_person_id,
             check_row.person_record_id
      FROM public.vehicle_identity_checks check_row
      JOIN public.person_identity_documents document
        ON document.id = check_row.identity_document_id
       AND document.organization_id = check_row.organization_id
      WHERE check_row.organization_id = p_organization_id
        AND check_row.canonical_vehicle_id = p_canonical_vehicle_id
        AND check_row.source_authority = 'NZTA Motor Vehicle Register'
        AND check_row.relationship = 'registered_person_at_check'
        AND document.document_kind = 'nzta_mvr_record'
        AND (document.review_state = 'approved'
          OR check_row.vehicle_snapshot->>'owner_only_review' = 'true')
    ),
    ordered_checks AS (
      SELECT source_checks.*,
             lag(canonical_person_id) OVER (ORDER BY checked_at, id) AS previous_person_id
      FROM source_checks
    ),
    numbered_checks AS (
      SELECT ordered_checks.*,
             sum(CASE WHEN previous_person_id IS DISTINCT FROM canonical_person_id THEN 1 ELSE 0 END)
               OVER (ORDER BY checked_at, id) AS episode_number
      FROM ordered_checks
    ),
    episodes AS (
      SELECT episode_number, canonical_person_id,
             min(checked_at) AS observed_from,
             (array_agg(id ORDER BY checked_at, id))[1] AS first_check_id,
             (array_agg(person_record_id ORDER BY checked_at DESC, id DESC))[1] AS person_record_id,
             array_agg(id ORDER BY checked_at, id) AS check_ids
      FROM numbered_checks
      GROUP BY episode_number, canonical_person_id
    )
    SELECT episodes.*,
           lead(observed_from) OVER (ORDER BY episode_number) AS superseded_at
    FROM episodes
    ORDER BY episode_number
  LOOP
    SELECT link.id INTO v_link_id
    FROM public.entity_links link
    WHERE link.organization_id = p_organization_id
      AND link.relationship = 'registered_owner'
      AND link.evidence->>'nzta_owner_history_first_check_id' = v_episode.first_check_id::text
    FOR UPDATE;

    IF v_link_id IS NULL THEN
      INSERT INTO public.entity_links (
        organization_id, from_type, from_id, to_type, to_id, relationship,
        evidence, active, starts_at, ends_at, created_by
      ) VALUES (
        p_organization_id, 'person', v_episode.canonical_person_id,
        'vehicle', p_canonical_vehicle_id, 'registered_owner',
        jsonb_build_object(
          'source', 'nzta_mvr',
          'basis', 'Observed at NZTA source check; dates are observations, not legal transfer dates.',
          'person_record_id', v_episode.person_record_id,
          'nzta_restricted', true,
          'observation_ids', '[]'::jsonb,
          'nzta_owner_history_first_check_id', v_episode.first_check_id,
          'nzta_owner_history_check_ids', to_jsonb(v_episode.check_ids),
          'source_checked_at', v_episode.observed_from,
          'superseded_at_nzta_check', v_episode.superseded_at
        ),
        v_episode.superseded_at IS NULL,
        v_episode.observed_from,
        v_episode.superseded_at,
        v_actor
      )
      RETURNING id INTO v_link_id;
    ELSE
      UPDATE public.entity_links link
      SET from_id = v_episode.canonical_person_id,
          evidence = jsonb_build_object(
            'source', 'nzta_mvr',
            'basis', 'Observed at NZTA source check; dates are observations, not legal transfer dates.',
            'person_record_id', v_episode.person_record_id,
            'nzta_restricted', true,
            'observation_ids', '[]'::jsonb,
            'nzta_owner_history_first_check_id', v_episode.first_check_id,
            'nzta_owner_history_check_ids', to_jsonb(v_episode.check_ids),
            'source_checked_at', v_episode.observed_from,
            'superseded_at_nzta_check', v_episode.superseded_at
          ),
          active = v_episode.superseded_at IS NULL,
          starts_at = v_episode.observed_from,
          ends_at = v_episode.superseded_at,
          updated_at = clock_timestamp()
      WHERE link.id = v_link_id;
    END IF;
    v_episode_count := v_episode_count + 1;
    v_link_id := NULL;
  END LOOP;

  INSERT INTO public.audit_log (
    organization_id, actor_user_id, action, target_table, target_id, metadata
  ) VALUES (
    p_organization_id, v_actor, 'nzta_registered_owner_history_synchronized',
    'entity_links', p_canonical_vehicle_id,
    jsonb_build_object(
      'canonical_vehicle_id', p_canonical_vehicle_id,
      'current_canonical_person_id', v_current_person,
      'owner_observation_episodes', v_episode_count,
      'date_basis', 'NZTA source check observations; not legal transfer dates'
    )
  );

  RETURN jsonb_build_object(
    'canonical_vehicle_id', p_canonical_vehicle_id,
    'current_canonical_person_id', v_current_person,
    'owner_observation_episodes', v_episode_count
  );
END;
$$;

COMMENT ON FUNCTION public.sync_nzta_registered_owner_history(uuid, uuid) IS
'Rebuilds the R&M organisation-scoped registered-owner observations from reviewed NZTA source-time checks. The latest check is current; prior distinct-owner periods are inactive. Dates are check observations, never legal transfer dates.';
REVOKE ALL ON FUNCTION public.sync_nzta_registered_owner_history(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.sync_nzta_registered_owner_history(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.sync_nzta_owner_history_after_check()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.source_authority = 'NZTA Motor Vehicle Register'
     AND NEW.relationship = 'registered_person_at_check' THEN
    PERFORM public.sync_nzta_registered_owner_history(
      NEW.organization_id, NEW.canonical_vehicle_id
    );
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.sync_nzta_owner_history_after_check() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS sync_nzta_owner_history_after_check ON public.vehicle_identity_checks;
CREATE TRIGGER sync_nzta_owner_history_after_check
AFTER INSERT OR UPDATE OF canonical_vehicle_id, canonical_person_id, checked_at
ON public.vehicle_identity_checks
FOR EACH ROW
EXECUTE FUNCTION public.sync_nzta_owner_history_after_check();

CREATE OR REPLACE FUNCTION public.review_nzta_mvr_owner_evidence(
  p_identity_document_id uuid,
  p_approved_fields jsonb,
  p_review_notes text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_document public.person_identity_documents%rowtype;
  v_person public.person_records%rowtype;
  v_canonical_person_id uuid;
  v_vehicle_result jsonb;
  v_vehicle_id uuid;
  v_check_id uuid;
  v_existing public.vehicle_identity_checks%rowtype;
  v_existing_plate text;
  v_plate text := public.normalize_plate_number(p_approved_fields->>'plate_number');
  v_checked_at timestamptz := nullif(p_approved_fields->>'query_completed_at', '')::timestamptz;
  v_display_name text := nullif(trim(p_approved_fields->>'display_name'), '');
  v_notes text := nullif(trim(coalesce(p_review_notes, '')), '');
BEGIN
  SELECT * INTO v_document
  FROM public.person_identity_documents
  WHERE id = p_identity_document_id
  FOR UPDATE;
  IF v_document.id IS NULL OR v_document.document_kind <> 'nzta_mvr_record' THEN
    RAISE EXCEPTION 'NZTA MVR identity evidence not found';
  END IF;
  IF v_actor IS NULL
     OR NOT public.is_admin_for_org(v_document.organization_id)
     OR NOT public.can_access_vehicle_owner_identity(v_document.organization_id, true) THEN
    RAISE EXCEPTION 'Identity registry and vehicle owner identity administrator access required';
  END IF;
  IF v_document.review_state <> 'manual_review_required' THEN
    RAISE EXCEPTION 'Identity evidence is not awaiting review';
  END IF;
  IF jsonb_typeof(p_approved_fields) IS DISTINCT FROM 'object'
     OR coalesce(p_approved_fields->>'person_vehicle_match_confirmed', '') <> 'true' THEN
    RAISE EXCEPTION 'Confirm that the private source image links this person and vehicle';
  END IF;
  IF v_plate IS NULL OR length(v_plate) > 10 THEN
    RAISE EXCEPTION 'A valid plate from the source image is required';
  END IF;
  IF v_checked_at IS NULL OR v_checked_at > clock_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'A valid NZTA query completion time is required';
  END IF;
  IF v_notes IS NULL OR char_length(v_notes) > 1000 THEN
    RAISE EXCEPTION 'A review reason of 1 to 1000 characters is required';
  END IF;

  SELECT * INTO v_person
  FROM public.person_records
  WHERE id = v_document.person_record_id
    AND organization_id = v_document.organization_id;
  IF v_person.id IS NULL THEN RAISE EXCEPTION 'Person record not found in this organization'; END IF;
  IF v_document.evidence_item_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.evidence_items item
    WHERE item.id = v_document.evidence_item_id
      AND item.organization_id = v_document.organization_id
  ) THEN
    RAISE EXCEPTION 'Private NZTA source evidence is missing';
  END IF;

  v_canonical_person_id := public.ensure_canonical_person_for_record(v_person.id);
  IF v_canonical_person_id IS NULL THEN RAISE EXCEPTION 'The person could not be linked to a canonical person'; END IF;

  SELECT * INTO v_existing
  FROM public.vehicle_identity_checks
  WHERE identity_document_id = v_document.id
  FOR UPDATE;
  IF v_existing.id IS NOT NULL THEN
    SELECT public.normalize_plate_number(vehicle.plate_number)
      INTO v_existing_plate
    FROM public.canonical_vehicles vehicle
    WHERE vehicle.id = v_existing.canonical_vehicle_id;
    IF v_existing.checked_at <> v_checked_at
       OR v_existing.vehicle_snapshot->>'owner_only_review' IS DISTINCT FROM 'true'
       OR v_existing.person_record_id <> v_person.id
       OR v_existing.canonical_person_id <> v_canonical_person_id
       OR v_existing_plate IS DISTINCT FROM v_plate THEN
      RAISE EXCEPTION 'Identity evidence already has a different source-time check';
    END IF;
    PERFORM public.sync_nzta_registered_owner_history(
      v_document.organization_id, v_existing.canonical_vehicle_id
    );
    RETURN jsonb_build_object(
      'identity_document_id', v_document.id,
      'identity_check_id', v_existing.id,
      'canonical_vehicle_id', v_existing.canonical_vehicle_id,
      'owner_history_synchronized', true,
      'vehicle_facts_pending', true,
      'inserted', false
    );
  END IF;

  v_vehicle_result := public.manage_identity_vehicle(
    v_document.organization_id,
    NULL,
    v_plate,
    '{}'::jsonb,
    'NZTA registered-owner identity reviewed; vehicle facts remain pending for source comparison'
  );
  v_vehicle_id := (v_vehicle_result->>'vehicle_id')::uuid;
  IF v_vehicle_id IS NULL THEN RAISE EXCEPTION 'Canonical vehicle was not returned'; END IF;

  UPDATE public.person_records
  SET review_state = 'verified',
      metadata = metadata || jsonb_build_object(
        'profile_details',
        coalesce(metadata->'profile_details', '{}'::jsonb) || jsonb_build_object(
          'nzta_mvr_sourced', true,
          'nzta_mvr_last_checked_at', v_checked_at,
          'nzta_mvr_owner_identity_document_id', v_document.id
        )
      )
  WHERE id = v_person.id;
  UPDATE public.canonical_people
  SET display_name = coalesce(v_display_name, display_name),
      normalized_name = regexp_replace(
        lower(trim(coalesce(v_display_name, display_name, ''))),
        '[^a-z0-9]+', '', 'g'
      ),
      review_state = 'verified',
      metadata = metadata || jsonb_build_object(
        'last_nzta_mvr_owner_identity_document_id', v_document.id,
        'last_nzta_mvr_checked_at', v_checked_at,
        'last_nzta_mvr_reviewed_by', v_actor
      ),
      updated_at = clock_timestamp()
  WHERE id = v_canonical_person_id;

  INSERT INTO public.vehicle_identity_checks (
    organization_id, canonical_vehicle_id, person_record_id,
    canonical_person_id, identity_document_id, evidence_item_id,
    checked_at, vehicle_snapshot, reviewed_by
  ) VALUES (
    v_document.organization_id, v_vehicle_id, v_person.id,
    v_canonical_person_id, v_document.id, v_document.evidence_item_id,
    v_checked_at,
    p_approved_fields - ARRAY[
      'address', 'email', 'phone', 'driver_licence_number',
      'firearms_licence_number', 'security_licence_number', 'document_number'
    ] || jsonb_build_object(
      'owner_only_review', true,
      'vehicle_facts_review_state', 'manual_review_required'
    ),
    v_actor
  )
  RETURNING id INTO v_check_id;

  UPDATE public.person_identity_documents
  SET extracted_fields = jsonb_set(
        coalesce(extracted_fields, '{}'::jsonb),
        '{owner_review}',
        jsonb_build_object(
          'decision', 'registered_owner_confirmed',
          'reviewed_by', v_actor,
          'reviewed_at', clock_timestamp(),
          'source_checked_at', v_checked_at,
          'vehicle_facts_pending', true,
          'notes', v_notes
        ),
        true
      ),
      updated_at = clock_timestamp()
  WHERE id = v_document.id;

  INSERT INTO public.audit_log (
    organization_id, actor_user_id, action, target_table, target_id, metadata
  ) VALUES (
    v_document.organization_id, v_actor, 'nzta_owner_identity_reviewed',
    'person_identity_documents', v_document.id,
    jsonb_build_object(
      'identity_check_id', v_check_id,
      'canonical_vehicle_id', v_vehicle_id,
      'canonical_person_id', v_canonical_person_id,
      'source_checked_at', v_checked_at,
      'vehicle_facts_pending', true,
      'review_notes', v_notes
    )
  );

  RETURN jsonb_build_object(
    'identity_document_id', v_document.id,
    'identity_check_id', v_check_id,
    'canonical_vehicle_id', v_vehicle_id,
    'canonical_person_id', v_canonical_person_id,
    'owner_history_synchronized', true,
    'vehicle_facts_pending', true,
    'inserted', true
  );
END;
$$;

COMMENT ON FUNCTION public.review_nzta_mvr_owner_evidence(uuid, jsonb, text) IS
'Separately confirms the registered person and check time from a consistent NZTA source image while leaving conflicting or unreviewed mechanical vehicle facts in the identity review queue.';
REVOKE ALL ON FUNCTION public.review_nzta_mvr_owner_evidence(uuid, jsonb, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.review_nzta_mvr_owner_evidence(uuid, jsonb, text) TO authenticated;

DROP FUNCTION public.get_vehicle_owner_links(uuid, uuid);
CREATE FUNCTION public.get_vehicle_owner_links(p_organization_id uuid, p_canonical_vehicle_id uuid)
RETURNS TABLE(
  link_id uuid, relationship text, active boolean, source text, basis text,
  nzta_restricted boolean, person_record_id uuid, canonical_person_id uuid,
  display_name text, phone text, email text, address text, locality text,
  observation_ids uuid[], details_visible boolean, recorded_at timestamptz,
  recorded_by_name text, ended_at timestamptz, source_checked_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_full boolean;
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL
     OR NOT public.org_access_allowed(p_organization_id) THEN
    RETURN;
  END IF;
  v_full := public.can_access_vehicle_owner_identity(p_organization_id);
  RETURN QUERY
  SELECT link.id, link.relationship, link.active, link.evidence->>'source',
    CASE WHEN v_full THEN link.evidence->>'basis' END,
    coalesce((link.evidence->>'nzta_restricted')::boolean, false),
    CASE WHEN v_full THEN person_record.id END,
    CASE WHEN v_full THEN link.from_id END,
    CASE WHEN v_full THEN coalesce(person_record.display_name, canonical_person.display_name) END,
    CASE WHEN v_full THEN person_record.metadata->'profile_details'->>'phone' END,
    CASE WHEN v_full THEN person_record.metadata->'profile_details'->>'email' END,
    CASE WHEN v_full THEN person_record.metadata->'profile_details'->>'address' END,
    public.vehicle_owner_locality(person_record.metadata->'profile_details'),
    coalesce(ARRAY(
      SELECT (item #>> '{}')::uuid
      FROM jsonb_array_elements(coalesce(link.evidence->'observation_ids', '[]'::jsonb)) item
    ), ARRAY[]::uuid[]),
    v_full,
    link.created_at, user_profile.display_name,
    CASE WHEN v_full OR NOT (link.evidence ? 'nzta_owner_history_first_check_id') THEN link.ends_at END,
    CASE WHEN v_full THEN nullif(link.evidence->>'source_checked_at', '')::timestamptz END
  FROM public.entity_links link
  LEFT JOIN public.person_records person_record
    ON person_record.id = (link.evidence->>'person_record_id')::uuid
   AND person_record.organization_id = link.organization_id
  LEFT JOIN public.canonical_people canonical_person ON canonical_person.id = link.from_id
  LEFT JOIN public.user_profiles user_profile ON user_profile.id = link.created_by
  WHERE link.organization_id = p_organization_id
    AND link.to_type = 'vehicle'
    AND link.to_id = p_canonical_vehicle_id
    AND link.from_type = 'person'
    AND link.relationship IN ('owner', 'registered_owner', 'driver', 'associated_person')
    AND NOT coalesce(link.evidence->>'superseded_by_reconciliation', 'false')::boolean
  ORDER BY link.active DESC,
    (link.relationship IN ('owner', 'registered_owner')) DESC,
    link.created_at DESC
  LIMIT 50;
END;
$$;

COMMENT ON FUNCTION public.get_vehicle_owner_links(uuid, uuid) IS
'Returns organisation-scoped vehicle/person links. Authorised users receive protected identity details and the source-time NZTA observation timestamp; other users receive only the existing redacted relationship data. NZTA history timestamps are observations, not legal transfer dates.';
REVOKE ALL ON FUNCTION public.get_vehicle_owner_links(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_vehicle_owner_links(uuid, uuid) TO authenticated;