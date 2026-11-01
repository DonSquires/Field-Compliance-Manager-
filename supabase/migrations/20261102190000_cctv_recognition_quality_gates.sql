-- Low-quality person and vehicle sightings must not enter biometric matching. Person sightings may join an
-- existing provisional profile through a usable face or body template, but only a stored, clear, usable face
-- can create a new Unknown Person profile. The inference worker remains advisory; a human still names or
-- links every profile. Service guards fail closed when the request role is missing.

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
  IF coalesce(auth.role(), '') <> 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin') THEN
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
    LEFT JOIN public.person_records AS person ON person.id = observation.person_record_id
    LEFT JOIN public.canonical_person_links AS link
      ON link.source_table = 'person_records' AND link.source_id = observation.person_record_id
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
        ON link.source_table = 'person_records' AND link.source_id = person.id
     WHERE person.organization_id = p_organization_id
       AND person.metadata->>'cctv_portfolio_key' = p_portfolio_key::text
     ORDER BY person.created_at
     LIMIT 1;
  END IF;

  IF v_person_id IS NULL AND (
    p_observation_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM public.cctv_entity_observations AS observation
      WHERE observation.id = p_observation_id
        AND observation.organization_id = p_organization_id
        AND observation.entity_kind = 'person'
        AND observation.face_vec IS NOT NULL
        AND observation.quality_state = 'clear'
        AND observation.attributes->>'face_usable_for_matching' = 'true'
    )
  ) THEN
    RETURN;
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

    INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
    VALUES (
      p_organization_id, NULL, 'cctv_unknown_person_profile_created', 'person_records', v_person_id,
      jsonb_build_object(
        'canonical_person_id', v_canonical_id,
        'portfolio_key', p_portfolio_key,
        'unknown_person_number', v_unknown_number,
        'observation_id', p_observation_id,
        'evidence_item_id', p_evidence_item_id
      )
    );
    v_created := true;
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
  'Service-only find-or-create of a provisional CCTV person profile. New profiles require a clear, quality-gated face observation; human review is still required before identity use.';

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
  v_face_input jsonb;
  v_app_input jsonb;
  v_face_usable boolean;
  v_app_usable boolean;
  v_candidates jsonb;
  v_key uuid;
  v_best_key uuid;
  v_best_score real;
  v_state text;
  v_person_id uuid;
  v_canonical_id uuid;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin') THEN
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
    IF v_kind IS NULL OR v_kind NOT IN ('person', 'vehicle', 'animal')
       OR NULLIF(observation->>'source_event_id', '') IS NULL
       OR NULLIF(observation->>'observed_at', '') IS NULL THEN
      CONTINUE;
    END IF;

    v_face_usable := v_kind = 'person'
      AND observation #>> '{attributes,face_usable_for_matching}' = 'true'
      AND COALESCE(observation->>'quality_state', 'clear') = 'clear';
    v_app_usable := v_kind NOT IN ('person', 'vehicle')
      OR (
        observation #>> '{attributes,appearance_embedding_usable}' = 'true'
        AND COALESCE(observation->>'quality_state', 'clear') = 'clear'
      );
    v_face_input := observation->'candidate_embedding';
    v_app_input := observation->'appearance_embedding';
    IF NOT v_face_usable THEN v_face_input := NULL; END IF;
    IF NOT v_app_usable THEN v_app_input := NULL; END IF;
    v_face := CASE WHEN v_face_usable THEN public.cctv_jsonb_to_vector(v_face_input, 128) END;
    v_app := CASE WHEN v_app_usable THEN public.cctv_jsonb_to_vector(v_app_input, 256) END;
    IF v_face IS NULL THEN v_face_input := NULL; END IF;
    IF v_app IS NULL THEN v_app_input := NULL; END IF;
    v_id := NULL;
    v_person_id := NULL;
    v_canonical_id := NULL;

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
      CASE WHEN jsonb_typeof(v_face_input) = 'array' THEN v_face_input END,
      CASE WHEN jsonb_typeof(v_app_input) = 'array' THEN v_app_input END,
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
             'canonical_vehicle_id', match.canonical_vehicle_id,
             'thumbnail', match.thumbnail,
             'evidence_item_id', match.evidence_item_id,
             'cctv_import_id', match.cctv_import_id
               ) ORDER BY match.score DESC), '[]'::jsonb)
      INTO v_candidates
      FROM public.find_cctv_portfolio_matches(
        p_organization_id, v_kind, v_face_input, v_app_input,
        observation->>'candidate_plate', v_id, 5
      ) AS match;

    SELECT match.portfolio_key, match.score
      INTO v_best_key, v_best_score
      FROM public.find_cctv_portfolio_matches(
        p_organization_id, v_kind, v_face_input, v_app_input, NULL, v_id, 5
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

    -- A usable face may create a profile. A usable body match may only join the matched portfolio's profile.
    IF v_kind = 'person' AND (v_face IS NOT NULL OR v_best_key IS NOT NULL) THEN
      SELECT profile.person_record_id, profile.canonical_person_id
        INTO v_person_id, v_canonical_id
        FROM public.ensure_cctv_person_profile(
          p_organization_id, v_key, v_id, p_evidence_id,
          (observation->>'observed_at')::timestamptz
        ) AS profile;

      IF v_person_id IS NOT NULL THEN
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
    END IF;
  END LOOP;
  RETURN saved_count;
END;
$$;

COMMENT ON FUNCTION public.record_cctv_entity_observations(uuid, uuid, uuid, jsonb) IS
  'Service-only CCTV writer. Person and vehicle templates are stored and matched only when their explicit quality gates pass; usable body matches may join existing profiles, while new provisional profiles require a usable face.';
REVOKE ALL ON FUNCTION public.ensure_cctv_person_profile(uuid, uuid, uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ensure_cctv_person_profile(uuid, uuid, uuid, uuid, timestamptz) TO postgres, service_role;
REVOKE ALL ON FUNCTION public.record_cctv_entity_observations(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_cctv_entity_observations(uuid, uuid, uuid, jsonb) TO postgres, service_role;
