-- Adds a thumbnail and a link back to the source footage for "same or similar on record" candidates,
-- so a reviewer can actually SEE the earlier sighting before confirming a link instead of trusting a bare
-- percentage. Only the 'observation' match kind (face/appearance hits against another
-- cctv_entity_observations row) carries a natural thumbnail/import - legacy person-record face hits and
-- plate-based canonical_vehicle hits are cross-sighting/aggregate matches with no single representative
-- frame, so they stay NULL there (the UI simply shows no thumbnail for those, which is honest - a plate
-- match is already a strong, self-evident signal that doesn't need visual confirmation the way a fuzzy
-- appearance score does).
--
-- Changes the function's RETURNS TABLE shape, which Postgres does not allow via CREATE OR REPLACE -
-- drop then recreate.
DROP FUNCTION IF EXISTS public.find_cctv_portfolio_matches(uuid, text, jsonb, jsonb, text, uuid, integer);

CREATE FUNCTION "public"."find_cctv_portfolio_matches"(p_organization_id uuid, p_entity_kind text, p_face_embedding jsonb DEFAULT NULL::jsonb, p_appearance_embedding jsonb DEFAULT NULL::jsonb, p_plate text DEFAULT NULL::text, p_exclude_observation_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 10)
 RETURNS TABLE(match_kind text, match_id uuid, observation_id uuid, portfolio_key uuid, display_name text, score real, basis text, last_seen_at timestamp with time zone, canonical_place_id uuid, plate_number text, person_record_id uuid, canonical_vehicle_id uuid, thumbnail text, evidence_item_id uuid, cctv_import_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_face public.vector; v_app public.vector; v_plate text; v_n integer := greatest(coalesce(p_limit, 10), 1);
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin')
     AND (auth.uid() IS NULL OR NOT public.org_access_allowed(p_organization_id)) THEN
    RAISE EXCEPTION 'CCTV portfolio access denied';
  END IF;
  IF p_entity_kind NOT IN ('person', 'vehicle', 'animal') THEN RAISE EXCEPTION 'Unknown entity kind %', p_entity_kind; END IF;
  v_face := public.cctv_jsonb_to_vector(p_face_embedding, 128);
  v_app := public.cctv_jsonb_to_vector(p_appearance_embedding, 256);
  v_plate := public.normalize_plate_number(p_plate);
  RETURN QUERY
  WITH face_hits AS (
    SELECT 'observation'::text AS match_kind, o.id AS match_id, o.id AS observation_id, o.portfolio_key,
           coalesce(pr.display_name, o.candidate_label)::text AS display_name,
           (1 - (o.face_vec <=> v_face))::real AS score, 'face'::text AS basis, o.observed_at AS last_seen_at,
           o.canonical_place_id, o.candidate_plate::text AS plate_number, o.person_record_id, o.canonical_vehicle_id,
           o.thumbnail, o.evidence_item_id, o.cctv_import_id
    FROM public.cctv_entity_observations o
    LEFT JOIN public.person_records pr ON pr.id = o.person_record_id
    WHERE v_face IS NOT NULL AND p_entity_kind = 'person'
      AND o.organization_id = p_organization_id AND o.entity_kind = 'person' AND o.face_vec IS NOT NULL
      AND o.review_state <> 'rejected' AND (p_exclude_observation_id IS NULL OR o.id <> p_exclude_observation_id)
    ORDER BY o.face_vec <=> v_face
    LIMIT v_n * 3
  ), legacy_face_hits AS (
    SELECT 'person_record'::text, fo.person_record_id, NULL::uuid, NULL::uuid, pr.display_name::text,
           public.face_embedding_cosine(fo.metadata->'embedding', p_face_embedding)::real, 'face_legacy'::text, fo.created_at,
           NULL::uuid, NULL::text, fo.person_record_id, NULL::uuid,
           NULL::text, NULL::uuid, NULL::uuid
    FROM public.face_observations fo
    JOIN public.person_records pr ON pr.id = fo.person_record_id
    WHERE p_face_embedding IS NOT NULL AND p_entity_kind = 'person'
      AND fo.organization_id = p_organization_id AND fo.metadata ? 'embedding'
  ), appearance_hits AS (
    SELECT 'observation'::text, o.id, o.id, o.portfolio_key,
           coalesce(cv.plate_number, pr.display_name, o.candidate_label)::text,
           (1 - (o.appearance_vec <=> v_app))::real, 'appearance'::text, o.observed_at,
           o.canonical_place_id, coalesce(cv.plate_number, o.candidate_plate)::text, o.person_record_id, o.canonical_vehicle_id,
           o.thumbnail, o.evidence_item_id, o.cctv_import_id
    FROM public.cctv_entity_observations o
    LEFT JOIN public.canonical_vehicles cv ON cv.id = o.canonical_vehicle_id
    LEFT JOIN public.person_records pr ON pr.id = o.person_record_id
    WHERE v_app IS NOT NULL
      AND o.organization_id = p_organization_id AND o.entity_kind = p_entity_kind AND o.appearance_vec IS NOT NULL
      AND o.review_state <> 'rejected' AND (p_exclude_observation_id IS NULL OR o.id <> p_exclude_observation_id)
    ORDER BY o.appearance_vec <=> v_app
    LIMIT v_n * 3
  ), plate_hits AS (
    SELECT 'canonical_vehicle'::text, cv.id, NULL::uuid, NULL::uuid,
           concat_ws(' ', cv.plate_number, cv.make, cv.model, cv.colour)::text,
           (CASE WHEN cv.plate_number = v_plate THEN 1.0 ELSE extensions.similarity(cv.plate_number, v_plate) END)::real,
           (CASE WHEN cv.plate_number = v_plate THEN 'plate_exact' ELSE 'plate_similar' END)::text, cv.last_seen_at,
           NULL::uuid, cv.plate_number::text, NULL::uuid, cv.id,
           NULL::text, NULL::uuid, NULL::uuid
    FROM public.canonical_vehicles cv
    WHERE v_plate IS NOT NULL AND p_entity_kind = 'vehicle'
      AND (cv.plate_number = v_plate OR extensions.similarity(cv.plate_number, v_plate) >= 0.6)
    ORDER BY (cv.plate_number = v_plate) DESC, extensions.similarity(cv.plate_number, v_plate) DESC
    LIMIT v_n
  ), all_hits AS (
    SELECT * FROM face_hits UNION ALL SELECT * FROM legacy_face_hits
    UNION ALL SELECT * FROM appearance_hits UNION ALL SELECT * FROM plate_hits
  )
  SELECT h.match_kind, h.match_id, h.observation_id, h.portfolio_key, h.display_name, h.score, h.basis,
         h.last_seen_at, h.canonical_place_id, h.plate_number, h.person_record_id, h.canonical_vehicle_id,
         h.thumbnail, h.evidence_item_id, h.cctv_import_id
  FROM all_hits h
  WHERE h.score >= CASE h.basis WHEN 'face' THEN 0.65 WHEN 'face_legacy' THEN 0.65 WHEN 'appearance' THEN 0.70 ELSE 0.60 END
  ORDER BY h.score DESC, h.last_seen_at DESC NULLS LAST
  LIMIT v_n;
END $function$;
REVOKE ALL ON FUNCTION "public"."find_cctv_portfolio_matches"(p_organization_id uuid, p_entity_kind text, p_face_embedding jsonb, p_appearance_embedding jsonb, p_plate text, p_exclude_observation_id uuid, p_limit integer) FROM PUBLIC, "anon", "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION "public"."find_cctv_portfolio_matches"(p_organization_id uuid, p_entity_kind text, p_face_embedding jsonb, p_appearance_embedding jsonb, p_plate text, p_exclude_observation_id uuid, p_limit integer) TO "postgres";
GRANT EXECUTE ON FUNCTION "public"."find_cctv_portfolio_matches"(p_organization_id uuid, p_entity_kind text, p_face_embedding jsonb, p_appearance_embedding jsonb, p_plate text, p_exclude_observation_id uuid, p_limit integer) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."find_cctv_portfolio_matches"(p_organization_id uuid, p_entity_kind text, p_face_embedding jsonb, p_appearance_embedding jsonb, p_plate text, p_exclude_observation_id uuid, p_limit integer) TO "service_role";

-- record_cctv_entity_observations: same body, only the stored portfolio_candidates JSONB now also
-- carries thumbnail/evidence_item_id/cctv_import_id per candidate (whichever find_cctv_portfolio_matches
-- returns - NULL for the match kinds that have none). Return type is unchanged, so CREATE OR REPLACE
-- applies directly.
CREATE OR REPLACE FUNCTION "public"."record_cctv_entity_observations"(p_job_id uuid, p_evidence_id uuid, p_organization_id uuid, p_observations jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
            'canonical_vehicle_id', match.canonical_vehicle_id,
            'thumbnail', match.thumbnail,
            'evidence_item_id', match.evidence_item_id,
            'cctv_import_id', match.cctv_import_id
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
$function$;
COMMENT ON FUNCTION "public"."record_cctv_entity_observations"(p_job_id uuid, p_evidence_id uuid, p_organization_id uuid, p_observations jsonb) IS 'Service-only CCTV writer. Person face/body portfolios receive a canonical Unknown Person #N profile while remaining unreviewed; a human names or merges the profile before it is relied on as an identity.';
REVOKE ALL ON FUNCTION "public"."record_cctv_entity_observations"(p_job_id uuid, p_evidence_id uuid, p_organization_id uuid, p_observations jsonb) FROM PUBLIC, "anon", "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION "public"."record_cctv_entity_observations"(p_job_id uuid, p_evidence_id uuid, p_organization_id uuid, p_observations jsonb) TO "service_role";
