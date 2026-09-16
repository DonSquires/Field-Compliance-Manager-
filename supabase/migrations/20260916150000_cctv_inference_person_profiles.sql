-- CCTV inference builds a provisional person profile for each face/body portfolio.
-- The profile is an unknown subject record, not a verified name or enforcement decision.

CREATE OR REPLACE FUNCTION public.ensure_cctv_person_profile(
  p_organization_id uuid,
  p_portfolio_key uuid,
  p_observation_id uuid DEFAULT NULL,
  p_evidence_item_id uuid DEFAULT NULL,
  p_observed_at timestamptz DEFAULT NULL
)
RETURNS TABLE(person_record_id uuid, canonical_person_id uuid, display_name text, created boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_person_id uuid;
  v_canonical_id uuid;
  v_display_name text;
  v_unknown_number integer;
  v_created boolean := false;
BEGIN
  IF auth.role() <> 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;
  IF p_organization_id IS NULL OR p_portfolio_key IS NULL THEN
    RAISE EXCEPTION 'Organization and person portfolio are required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = p_organization_id) THEN
    RAISE EXCEPTION 'Organization does not exist';
  END IF;

  -- Serialise the per-organisation number so concurrent clips cannot mint the same Unknown Person #N.
  PERFORM pg_advisory_xact_lock(hashtextextended('cctv_unknown_person:' || p_organization_id::text, 0));

  SELECT observation.person_record_id,
         COALESCE(observation.canonical_person_id, link.canonical_person_id),
         person.display_name
    INTO v_person_id, v_canonical_id, v_display_name
    FROM public.cctv_entity_observations AS observation
    LEFT JOIN public.person_records AS person
      ON person.id = observation.person_record_id
    LEFT JOIN public.canonical_person_links AS link
      ON link.source_table = 'person_records'
     AND link.source_id = observation.person_record_id
   WHERE observation.organization_id = p_organization_id
     AND observation.entity_kind = 'person'
     AND observation.portfolio_key = p_portfolio_key
     AND observation.review_state <> 'rejected'
     AND observation.person_record_id IS NOT NULL
   ORDER BY (observation.review_state = 'accepted') DESC,
            observation.reviewed_at DESC NULLS LAST,
            observation.observed_at
   LIMIT 1;

  IF v_person_id IS NULL THEN
    SELECT person.id, link.canonical_person_id, person.display_name
      INTO v_person_id, v_canonical_id, v_display_name
      FROM public.person_records AS person
      LEFT JOIN public.canonical_person_links AS link
        ON link.source_table = 'person_records'
       AND link.source_id = person.id
     WHERE person.organization_id = p_organization_id
       AND person.metadata->>'cctv_portfolio_key' = p_portfolio_key::text
     ORDER BY person.created_at
     LIMIT 1;
  END IF;

  IF v_person_id IS NULL THEN
    SELECT COALESCE(MAX(GREATEST(
      CASE WHEN person.metadata->>'cctv_unknown_person_number' ~ '^[0-9]+$'
        THEN (person.metadata->>'cctv_unknown_person_number')::integer ELSE 0 END,
      CASE WHEN person.display_name ~ '^Unknown Person #[0-9]+$'
        THEN regexp_replace(person.display_name, '^Unknown Person #', '')::integer ELSE 0 END
    )), 0) + 1
      INTO v_unknown_number
      FROM public.person_records AS person
     WHERE person.organization_id = p_organization_id;

    v_display_name := 'Unknown Person #' || v_unknown_number;
    INSERT INTO public.person_records (organization_id, display_name, review_state, metadata)
    VALUES (
      p_organization_id,
      v_display_name,
      'manual_review_required',
      jsonb_strip_nulls(jsonb_build_object(
        'origin', 'cctv_inference_profile',
        'identity_status', 'unknown_pending_human_review',
        'cctv_portfolio_key', p_portfolio_key,
        'cctv_unknown_person_number', v_unknown_number,
        'first_observation_id', p_observation_id,
        'first_evidence_item_id', p_evidence_item_id,
        'first_seen_at', p_observed_at
      ))
    )
    RETURNING id INTO v_person_id;
    v_canonical_id := public.ensure_canonical_person_for_record(v_person_id);
    UPDATE public.canonical_people
       SET metadata = metadata || jsonb_strip_nulls(jsonb_build_object(
             'origin', 'cctv_inference_profile',
             'identity_status', 'unknown_pending_human_review',
             'cctv_portfolio_key', p_portfolio_key,
             'cctv_unknown_person_number', v_unknown_number,
             'first_observation_id', p_observation_id,
             'first_evidence_item_id', p_evidence_item_id,
             'first_seen_at', p_observed_at
           )),
           review_state = 'manual_review_required',
           updated_at = clock_timestamp()
     WHERE id = v_canonical_id;
    v_created := true;

    INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
    VALUES (
      p_organization_id,
      NULL,
      'cctv_unknown_person_profile_created',
      'person_records',
      v_person_id,
      jsonb_build_object(
        'canonical_person_id', v_canonical_id,
        'portfolio_key', p_portfolio_key,
        'unknown_person_number', v_unknown_number,
        'observation_id', p_observation_id,
        'evidence_item_id', p_evidence_item_id
      )
    );
  ELSE
    v_canonical_id := COALESCE(v_canonical_id, public.ensure_canonical_person_for_record(v_person_id));
  END IF;

  person_record_id := v_person_id;
  canonical_person_id := v_canonical_id;
  display_name := v_display_name;
  created := v_created;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.ensure_cctv_person_profile(uuid, uuid, uuid, uuid, timestamptz) IS
  'Service-only find-or-create of an Unknown Person #N person_records/canonical_people profile for a CCTV face/body portfolio. The profile remains manual_review_required until a human identifies it.';

CREATE OR REPLACE FUNCTION public.record_cctv_entity_observations(
  p_job_id uuid,
  p_evidence_id uuid,
  p_organization_id uuid,
  p_observations jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  observation jsonb;
  saved_count integer := 0;
  v_id uuid;
  v_kind text;
  v_import public.cctv_imports%rowtype;
  v_import_id uuid;
  v_face public.vector;
  v_app public.vector;
  v_candidates jsonb;
  v_key uuid;
  v_best_key uuid;
  v_best_score real;
  v_state text;
  v_person_id uuid;
  v_canonical_id uuid;
BEGIN
  IF auth.role() <> 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;
  IF jsonb_typeof(p_observations) <> 'array' THEN
    RAISE EXCEPTION 'CCTV entity observations must be an array';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.inference_jobs
    WHERE id = p_job_id
      AND evidence_item_id = p_evidence_id
      AND organization_id = p_organization_id
      AND domain = 'video_motion'
  ) THEN
    RAISE EXCEPTION 'CCTV inference job is missing or outside the organization';
  END IF;
  SELECT evidence.cctv_import_id
    INTO v_import_id
    FROM public.evidence_items AS evidence
   WHERE evidence.id = p_evidence_id;
  IF v_import_id IS NOT NULL THEN
    SELECT * INTO v_import FROM public.cctv_imports WHERE id = v_import_id;
  END IF;

  FOR observation IN SELECT value FROM jsonb_array_elements(p_observations)
  LOOP
    v_kind := observation->>'entity_kind';
    IF v_kind NOT IN ('person', 'vehicle', 'animal')
       OR NULLIF(observation->>'source_event_id', '') IS NULL
       OR NULLIF(observation->>'observed_at', '') IS NULL THEN
      CONTINUE;
    END IF;
    v_face := CASE WHEN v_kind = 'person' THEN public.cctv_jsonb_to_vector(observation->'candidate_embedding', 128) END;
    v_app := public.cctv_jsonb_to_vector(observation->'appearance_embedding', 256);
    v_id := NULL;

    INSERT INTO public.cctv_entity_observations (
      organization_id, inference_job_id, evidence_item_id, source_event_id, entity_kind,
      observed_at, observed_to, cctv_import_id, location_id, canonical_place_id, site_id, zone_id,
      candidate_label, candidate_plate, animal_type, species_confidence, is_pest,
      candidate_embedding, appearance_embedding, face_vec, appearance_vec,
      model_confidence, quality_state, attributes, frame_sha256, thumbnail
    ) VALUES (
      p_organization_id, p_job_id, p_evidence_id, observation->>'source_event_id', v_kind,
      (observation->>'observed_at')::timestamptz, NULLIF(observation->>'observed_to', '')::timestamptz,
      v_import.id, v_import.location_id, v_import.canonical_place_id,
      COALESCE(v_import.site_id, NULLIF(observation->>'site_id', '')::uuid),
      COALESCE(v_import.zone_id, NULLIF(observation->>'zone_id', '')::uuid),
      NULLIF(observation->>'candidate_label', ''),
      NULLIF(public.normalize_plate_number(observation->>'candidate_plate'), ''),
      NULLIF(lower(observation->>'animal_type'), ''),
      NULLIF(observation->>'species_confidence', '')::real,
      CASE WHEN observation ? 'is_pest' THEN (observation->>'is_pest')::boolean END,
      CASE WHEN jsonb_typeof(observation->'candidate_embedding') = 'array' THEN observation->'candidate_embedding' END,
      CASE WHEN jsonb_typeof(observation->'appearance_embedding') = 'array' THEN observation->'appearance_embedding' END,
      v_face, v_app,
      NULLIF(observation->>'model_confidence', '')::real,
      CASE WHEN observation->>'quality_state' IN ('clear', 'glitch', 'flare', 'ir_switch', 'degraded', 'occluded') THEN observation->>'quality_state' ELSE 'clear' END,
      CASE WHEN jsonb_typeof(observation->'attributes') = 'object' THEN observation->'attributes' ELSE '{}'::jsonb END,
      NULLIF(observation->>'frame_sha256', ''),
      CASE WHEN observation->>'thumbnail' LIKE 'data:image/%' THEN observation->>'thumbnail' ELSE NULL END
    )
    ON CONFLICT (inference_job_id, source_event_id, entity_kind) DO UPDATE SET
      observed_to = EXCLUDED.observed_to,
      candidate_label = EXCLUDED.candidate_label,
      candidate_plate = EXCLUDED.candidate_plate,
      animal_type = EXCLUDED.animal_type,
      species_confidence = EXCLUDED.species_confidence,
      is_pest = EXCLUDED.is_pest,
      candidate_embedding = EXCLUDED.candidate_embedding,
      appearance_embedding = EXCLUDED.appearance_embedding,
      face_vec = EXCLUDED.face_vec,
      appearance_vec = EXCLUDED.appearance_vec,
      model_confidence = EXCLUDED.model_confidence,
      quality_state = EXCLUDED.quality_state,
      attributes = EXCLUDED.attributes,
      frame_sha256 = EXCLUDED.frame_sha256,
      thumbnail = EXCLUDED.thumbnail
    WHERE public.cctv_entity_observations.review_state = 'unreviewed'
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      CONTINUE;
    END IF;
    saved_count := saved_count + 1;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'match_kind', match.match_kind,
             'match_id', match.match_id,
             'observation_id', match.observation_id,
             'portfolio_key', match.portfolio_key,
             'display_name', match.display_name,
             'score', match.score,
             'basis', match.basis,
             'last_seen_at', match.last_seen_at,
             'plate_number', match.plate_number,
             'person_record_id', match.person_record_id,
            'canonical_vehicle_id', match.canonical_vehicle_id
               ) ORDER BY match.score DESC), '[]'::jsonb)
      INTO v_candidates
      FROM public.find_cctv_portfolio_matches(
        p_organization_id,
        v_kind,
        observation->'candidate_embedding',
        observation->'appearance_embedding',
        observation->>'candidate_plate',
        v_id,
        5
      ) AS match;

    SELECT match.portfolio_key, match.score
      INTO v_best_key, v_best_score
      FROM public.find_cctv_portfolio_matches(
        p_organization_id,
        v_kind,
        observation->'candidate_embedding',
        observation->'appearance_embedding',
        NULL,
        v_id,
        5
      ) AS match
     WHERE match.match_kind = 'observation'
       AND match.portfolio_key IS NOT NULL
       AND match.score >= CASE match.basis WHEN 'face' THEN 0.72 ELSE 0.80 END
     ORDER BY match.score DESC
     LIMIT 1;

    v_key := COALESCE(v_best_key, gen_random_uuid());
    v_state := CASE WHEN jsonb_array_length(v_candidates) > 0 THEN 'candidate' ELSE 'unmatched' END;
    UPDATE public.cctv_entity_observations
       SET portfolio_candidates = v_candidates,
           portfolio_key = COALESCE(portfolio_key, v_key),
           portfolio_state = CASE WHEN portfolio_state IN ('linked', 'new_identity', 'rejected') THEN portfolio_state ELSE v_state END
     WHERE id = v_id;
    SELECT portfolio_key INTO v_key FROM public.cctv_entity_observations WHERE id = v_id;

    IF v_kind = 'person' THEN
      SELECT profile.person_record_id, profile.canonical_person_id
        INTO v_person_id, v_canonical_id
        FROM public.ensure_cctv_person_profile(
          p_organization_id,
          v_key,
          v_id,
          p_evidence_id,
          (observation->>'observed_at')::timestamptz
        ) AS profile;

      UPDATE public.cctv_entity_observations
         SET person_record_id = v_person_id,
             canonical_person_id = v_canonical_id
       WHERE organization_id = p_organization_id
         AND entity_kind = 'person'
         AND portfolio_key = v_key
         AND review_state = 'unreviewed'
         AND (person_record_id IS NULL OR person_record_id = v_person_id)
         AND (canonical_person_id IS NULL OR canonical_person_id = v_canonical_id);
    END IF;
  END LOOP;
  RETURN saved_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_cctv_person_profile(
  p_observation_id uuid,
  p_display_name text,
  p_profile_details jsonb DEFAULT '{}'::jsonb,
  p_notes text DEFAULT NULL
)
RETURNS public.cctv_entity_observations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_observation public.cctv_entity_observations%rowtype;
  v_person public.person_records%rowtype;
  v_canonical_id uuid;
  v_display_name text := nullif(trim(coalesce(p_display_name, '')), '');
  v_detail_keys jsonb;
BEGIN
  SELECT * INTO v_observation
    FROM public.cctv_entity_observations
   WHERE id = p_observation_id
   FOR UPDATE;
  IF v_observation.id IS NULL THEN
    RAISE EXCEPTION 'CCTV observation not found';
  END IF;
  IF v_actor IS NULL OR NOT public.org_access_allowed(v_observation.organization_id) THEN
    RAISE EXCEPTION 'CCTV person profile access denied';
  END IF;
  IF v_observation.entity_kind <> 'person' THEN
    RAISE EXCEPTION 'Only a person observation can update a person profile';
  END IF;
  IF v_display_name IS NULL OR char_length(v_display_name) > 200 THEN
    RAISE EXCEPTION 'A person name between 1 and 200 characters is required';
  END IF;
  IF jsonb_typeof(coalesce(p_profile_details, '{}'::jsonb)) <> 'object'
     OR octet_length(coalesce(p_profile_details, '{}'::jsonb)::text) > 16384 THEN
    RAISE EXCEPTION 'Person profile details must be an object no larger than 16 KB';
  END IF;
  SELECT * INTO v_person
    FROM public.person_records
   WHERE id = v_observation.person_record_id
     AND organization_id = v_observation.organization_id
   FOR UPDATE;
  IF v_person.id IS NULL THEN
    RAISE EXCEPTION 'No inference person profile is attached to this observation';
  END IF;
  v_canonical_id := COALESCE(
    v_observation.canonical_person_id,
    (SELECT link.canonical_person_id FROM public.canonical_person_links AS link WHERE link.source_table = 'person_records' AND link.source_id = v_person.id LIMIT 1),
    public.ensure_canonical_person_for_record(v_person.id)
  );

  UPDATE public.person_records
     SET display_name = v_display_name,
         review_state = 'manual_review_required',
         metadata = metadata || jsonb_build_object(
           'identity_status', 'named_by_human_review',
           'named_at', clock_timestamp(),
           'named_by', v_actor,
          'profile_details', coalesce(metadata->'profile_details', '{}'::jsonb) || coalesce(p_profile_details, '{}'::jsonb)
         )
   WHERE id = v_person.id;
  UPDATE public.canonical_people
     SET display_name = v_display_name,
         normalized_name = regexp_replace(lower(v_display_name), '[^a-z0-9]+', '', 'g'),
         review_state = 'manual_review_required',
         metadata = metadata || jsonb_build_object(
           'identity_status', 'named_by_human_review',
           'named_at', clock_timestamp(),
           'named_by', v_actor
         ),
         updated_at = clock_timestamp()
   WHERE id = v_canonical_id;
  UPDATE public.cctv_entity_observations
     SET person_record_id = v_person.id,
         canonical_person_id = v_canonical_id,
         review_state = 'accepted',
         portfolio_state = 'linked',
         reviewed_by = v_actor,
         reviewed_at = clock_timestamp(),
         review_notes = nullif(trim(p_notes), '')
   WHERE id = v_observation.id
   RETURNING * INTO v_observation;
  SELECT COALESCE(jsonb_agg(key ORDER BY key), '[]'::jsonb)
    INTO v_detail_keys
    FROM jsonb_object_keys(coalesce(p_profile_details, '{}'::jsonb)) AS key;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (
    v_observation.organization_id,
    v_actor,
    'cctv_person_profile_updated',
    'person_records',
    v_person.id,
    jsonb_build_object(
      'observation_id', v_observation.id,
      'canonical_person_id', v_canonical_id,
      'profile_detail_keys', v_detail_keys,
      'profile_name_changed', true
    )
  );
  RETURN v_observation;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_motion_inference(
  p_job_id uuid,
  p_evidence_id uuid,
  p_org_id uuid,
  p_motion_result jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result_id uuid;
  face_event record;
  candidate_list jsonb;
  import_id uuid;
  ready_import_id uuid;
  v_person_id uuid;
  v_canonical_id uuid;
  v_portfolio_key uuid;
BEGIN
  IF auth.role() <> 'service_role' AND session_user <> 'postgres' THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;
  IF p_job_id IS NULL OR p_evidence_id IS NULL OR p_org_id IS NULL OR p_motion_result IS NULL THEN
    RAISE EXCEPTION 'Job, evidence, organization, and motion result are required';
  END IF;
  IF jsonb_typeof(p_motion_result) <> 'object' OR jsonb_typeof(p_motion_result->'motion_segments') <> 'array' THEN
    RAISE EXCEPTION 'Motion result must contain a motion_segments array';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.inference_jobs
    WHERE id = p_job_id
      AND evidence_item_id = p_evidence_id
      AND organization_id = p_org_id
      AND domain = 'video_motion'
      AND status = 'processing'
  ) THEN
    RAISE EXCEPTION 'Inference job is missing, mismatched, or not processing';
  END IF;
  SELECT evidence.cctv_import_id
    INTO import_id
    FROM public.evidence_items AS evidence
   WHERE evidence.id = p_evidence_id
     AND evidence.organization_id = p_org_id
     AND evidence.evidence_kind = 'video';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Video evidence is missing or belongs to another organization';
  END IF;

  INSERT INTO public.inference_results (inference_job_id, evidence_item_id, domain, status, result)
  VALUES (p_job_id, p_evidence_id, 'video_motion', 'complete', p_motion_result)
  RETURNING id INTO result_id;

  FOR face_event IN
    SELECT value AS event, ordinality AS event_number
    FROM jsonb_array_elements(COALESCE(p_motion_result #> '{consolidated_events,face_events}', '[]'::jsonb)) WITH ORDINALITY
  LOOP
    v_person_id := NULL;
    v_canonical_id := NULL;
    v_portfolio_key := NULL;
    SELECT observation.person_record_id, observation.canonical_person_id, observation.portfolio_key
      INTO v_person_id, v_canonical_id, v_portfolio_key
      FROM public.cctv_entity_observations AS observation
     WHERE observation.inference_job_id = p_job_id
       AND observation.organization_id = p_org_id
       AND observation.entity_kind = 'person'
       AND (
         observation.source_event_id = face_event.event->>'event_id'
         OR observation.attributes->>'face_event_id' = face_event.event->>'event_id'
       )
     ORDER BY (observation.source_event_id = face_event.event->>'event_id') DESC,
              observation.observed_at
     LIMIT 1;

    IF v_person_id IS NULL THEN
      v_portfolio_key := COALESCE(v_portfolio_key, gen_random_uuid());
      SELECT profile.person_record_id, profile.canonical_person_id
        INTO v_person_id, v_canonical_id
        FROM public.ensure_cctv_person_profile(
          p_org_id,
          v_portfolio_key,
          NULL,
          p_evidence_id,
          NULLIF(face_event.event->>'first_seen_at', '')::timestamptz
        ) AS profile;
    ELSIF v_canonical_id IS NULL THEN
      v_canonical_id := public.ensure_canonical_person_for_record(v_person_id);
    END IF;

    SELECT COALESCE(jsonb_agg(candidate ORDER BY similarity DESC), '[]'::jsonb)
      INTO candidate_list
      FROM (
        SELECT jsonb_build_object(
          'person_record_id', person.id,
          'display_name', COALESCE(person.display_name, 'Unnamed person'),
          'similarity', round(public.face_embedding_cosine(
            face_event.event->'face_embedding', person.metadata #> '{face_reference,embedding}'
          )::numeric, 4),
          'reference_thumbnail', person.metadata #>> '{face_reference,thumbnail}',
          'review_state', person.review_state
        ) AS candidate,
        public.face_embedding_cosine(face_event.event->'face_embedding', person.metadata #> '{face_reference,embedding}') AS similarity
        FROM public.person_records AS person
        WHERE person.organization_id = p_org_id
          AND jsonb_typeof(face_event.event->'face_embedding') = 'array'
          AND jsonb_typeof(person.metadata #> '{face_reference,embedding}') = 'array'
        ORDER BY similarity DESC
        LIMIT 5
      ) AS ranked;

    IF NOT EXISTS (
      SELECT 1
      FROM public.face_observations AS face_observation
      WHERE face_observation.evidence_item_id = p_evidence_id
        AND face_observation.metadata->>'source_event_id' = face_event.event->>'event_id'
    ) THEN
      INSERT INTO public.face_observations (
        organization_id,
        evidence_item_id,
        person_record_id,
        confidence,
        purpose,
        review_state,
        metadata
      )
      VALUES (
        p_org_id,
        p_evidence_id,
        v_person_id,
        NULL,
        'cctv_video_motion_candidate',
        'manual_review_required',
        jsonb_strip_nulls(jsonb_build_object(
          'source_event_id', face_event.event->>'event_id',
          'source_subject_id', face_event.event->>'subject_id',
          'original_thumbnail', face_event.event->>'thumbnail',
          'original_frame_hash', face_event.event->>'best_frame_hash',
          'embedding', face_event.event->'face_embedding',
          'canonical_person_id', v_canonical_id,
          'candidates', candidate_list
        ))
      );
    END IF;
  END LOOP;

  UPDATE public.inference_jobs
     SET status = 'complete',
         completed_at = clock_timestamp()
   WHERE id = p_job_id
     AND status = 'processing';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inference job changed before completion';
  END IF;

  IF import_id IS NOT NULL THEN
    PERFORM 1
      FROM public.cctv_imports
     WHERE id = import_id
     FOR UPDATE;
    UPDATE public.cctv_imports AS import_row
       SET status = 'review_ready',
           updated_at = clock_timestamp()
     WHERE import_row.id = import_id
       AND import_row.status IN ('registered', 'processing')
       AND EXISTS (
         SELECT 1
         FROM public.evidence_items AS import_evidence
         JOIN public.inference_jobs AS import_job
           ON import_job.evidence_item_id = import_evidence.id
        WHERE import_evidence.cctv_import_id = import_row.id
          AND import_job.domain = 'video_motion'
       )
       AND NOT EXISTS (
         SELECT 1
         FROM public.evidence_items AS import_evidence
         JOIN public.inference_jobs AS import_job
           ON import_job.evidence_item_id = import_evidence.id
        WHERE import_evidence.cctv_import_id = import_row.id
          AND import_job.domain = 'video_motion'
          AND import_job.status NOT IN ('complete', 'inconclusive', 'manual_review_required')
       )
    RETURNING import_row.id INTO ready_import_id;
    IF ready_import_id IS NOT NULL THEN
      INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
      VALUES (
        p_org_id,
        NULL,
        'cctv_import_review_ready',
        'cctv_imports',
        ready_import_id,
        jsonb_build_object('trigger_job_id', p_job_id, 'completed_video_jobs', (
          SELECT count(*)
          FROM public.evidence_items AS import_evidence
          JOIN public.inference_jobs AS import_job
            ON import_job.evidence_item_id = import_evidence.id
          WHERE import_evidence.cctv_import_id = ready_import_id
            AND import_job.domain = 'video_motion'
            AND import_job.status IN ('complete', 'inconclusive', 'manual_review_required')
        ))
      );
    END IF;
  END IF;

  RETURN result_id;
END;
$$;

DO $$
DECLARE
  observation record;
  profile record;
  v_portfolio_key uuid;
BEGIN
  FOR observation IN
    SELECT id, organization_id, portfolio_key, evidence_item_id, observed_at
      FROM public.cctv_entity_observations
     WHERE entity_kind = 'person'
       AND review_state <> 'rejected'
       AND (person_record_id IS NULL OR canonical_person_id IS NULL)
     ORDER BY organization_id, observed_at, id
  LOOP
    UPDATE public.cctv_entity_observations
       SET portfolio_key = COALESCE(portfolio_key, gen_random_uuid())
     WHERE id = observation.id
     RETURNING portfolio_key INTO v_portfolio_key;
    SELECT * INTO profile
      FROM public.ensure_cctv_person_profile(
        observation.organization_id,
        v_portfolio_key,
        observation.id,
        observation.evidence_item_id,
        observation.observed_at
      );
    UPDATE public.cctv_entity_observations
       SET person_record_id = profile.person_record_id,
           canonical_person_id = profile.canonical_person_id
     WHERE organization_id = observation.organization_id
       AND entity_kind = 'person'
       AND portfolio_key = v_portfolio_key
       AND review_state = 'unreviewed'
       AND (person_record_id IS NULL OR person_record_id = profile.person_record_id)
       AND (canonical_person_id IS NULL OR canonical_person_id = profile.canonical_person_id);
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.record_cctv_entity_observations(uuid, uuid, uuid, jsonb) IS
  'Service-only CCTV writer. Person face/body portfolios receive a canonical Unknown Person #N profile while remaining unreviewed; a human names or merges the profile before it is relied on as an identity.';
COMMENT ON FUNCTION public.update_cctv_person_profile(uuid, text, jsonb, text) IS
  'Human-review path to name and enrich an inferred CCTV person profile without creating a duplicate canonical person.';
COMMENT ON FUNCTION public.complete_motion_inference(uuid, uuid, uuid, jsonb) IS
  'Stores a completed video-motion result, attaches face evidence to its inferred person profile, and advances the parent CCTV import to review_ready only when every video job is reviewable.';

REVOKE ALL ON FUNCTION public.ensure_cctv_person_profile(uuid, uuid, uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_cctv_person_profile(uuid, uuid, uuid, uuid, timestamptz) TO postgres, service_role;
REVOKE ALL ON FUNCTION public.record_cctv_entity_observations(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_cctv_entity_observations(uuid, uuid, uuid, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.update_cctv_person_profile(uuid, text, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_cctv_person_profile(uuid, text, jsonb, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.complete_motion_inference(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_motion_inference(uuid, uuid, uuid, jsonb) TO postgres, service_role;
