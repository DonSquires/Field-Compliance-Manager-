-- One continuous, stationary vehicle stay is one review event. Source detections remain as superseded
-- observations so the clip/evidence provenance is retained without flooding the review queue.

CREATE OR REPLACE FUNCTION public.cctv_bbox_is_stationary(p_left jsonb, p_right jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  lx double precision; ly double precision; lw double precision; lh double precision;
  rx double precision; ry double precision; rw double precision; rh double precision;
  scale double precision;
BEGIN
  IF jsonb_typeof(p_left) <> 'object' OR jsonb_typeof(p_right) <> 'object' THEN RETURN false; END IF;
  lx := (p_left->>'x')::double precision; ly := (p_left->>'y')::double precision;
  lw := (p_left->>'width')::double precision; lh := (p_left->>'height')::double precision;
  rx := (p_right->>'x')::double precision; ry := (p_right->>'y')::double precision;
  rw := (p_right->>'width')::double precision; rh := (p_right->>'height')::double precision;
  IF least(lw, lh, rw, rh) <= 0 THEN RETURN false; END IF;
  scale := greatest(lw, lh, rw, rh);
  RETURN sqrt(power((lx + lw / 2) - (rx + rw / 2), 2) + power((ly + lh / 2) - (ry + rh / 2), 2)) <= scale * 0.30
    AND lw / rw BETWEEN 0.65 AND 1.55
    AND lh / rh BETWEEN 0.65 AND 1.55;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.cctv_bbox_is_stationary(jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cctv_bbox_is_stationary(jsonb, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.cctv_strip_candidate_images(p_candidates jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE WHEN jsonb_typeof(p_candidates) = 'array'
    THEN coalesce(jsonb_agg(candidate - 'thumbnail'), '[]'::jsonb)
    ELSE '[]'::jsonb END
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_candidates) = 'array' THEN p_candidates ELSE '[]'::jsonb END) candidate
$$;

CREATE OR REPLACE FUNCTION public.cctv_observation_payload_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  NEW.portfolio_candidates := public.cctv_strip_candidate_images(NEW.portfolio_candidates);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cctv_observation_payload_guard ON public.cctv_entity_observations;
CREATE TRIGGER trg_cctv_observation_payload_guard
BEFORE INSERT OR UPDATE OF portfolio_candidates ON public.cctv_entity_observations
FOR EACH ROW EXECUTE FUNCTION public.cctv_observation_payload_guard();

UPDATE public.cctv_entity_observations
SET portfolio_candidates = public.cctv_strip_candidate_images(portfolio_candidates)
WHERE portfolio_candidates @? '$[*].thumbnail';

-- Keep the return shape stable for existing callers, but no longer copy an observation's base64 image into
-- every candidate JSON document. The observation id remains the durable route to that source frame.
CREATE OR REPLACE FUNCTION public.find_cctv_portfolio_matches(p_organization_id uuid, p_entity_kind text, p_face_embedding jsonb DEFAULT NULL::jsonb, p_appearance_embedding jsonb DEFAULT NULL::jsonb, p_plate text DEFAULT NULL::text, p_exclude_observation_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 10)
RETURNS TABLE(match_kind text, match_id uuid, observation_id uuid, portfolio_key uuid, display_name text, score real, basis text, last_seen_at timestamp with time zone, canonical_place_id uuid, plate_number text, person_record_id uuid, canonical_vehicle_id uuid, thumbnail text, evidence_item_id uuid, cctv_import_id uuid)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
           NULL::text AS thumbnail, o.evidence_item_id, o.cctv_import_id
    FROM public.cctv_entity_observations o
    LEFT JOIN public.person_records pr ON pr.id = o.person_record_id
    WHERE v_face IS NOT NULL AND p_entity_kind = 'person'
      AND o.organization_id = p_organization_id AND o.entity_kind = 'person' AND o.face_vec IS NOT NULL
      AND o.review_state NOT IN ('rejected', 'superseded') AND (p_exclude_observation_id IS NULL OR o.id <> p_exclude_observation_id)
    ORDER BY o.face_vec <=> v_face LIMIT v_n * 3
  ), legacy_face_hits AS (
    SELECT 'person_record'::text, fo.person_record_id, NULL::uuid, NULL::uuid, pr.display_name::text,
           public.face_embedding_cosine(fo.metadata->'embedding', p_face_embedding)::real, 'face_legacy'::text, fo.created_at,
           NULL::uuid, NULL::text, fo.person_record_id, NULL::uuid, NULL::text, NULL::uuid, NULL::uuid
    FROM public.face_observations fo JOIN public.person_records pr ON pr.id = fo.person_record_id
    WHERE p_face_embedding IS NOT NULL AND p_entity_kind = 'person'
      AND fo.organization_id = p_organization_id AND fo.metadata ? 'embedding'
  ), appearance_hits AS (
    SELECT 'observation'::text, o.id, o.id, o.portfolio_key,
           coalesce(cv.plate_number, pr.display_name, o.candidate_label)::text,
           (1 - (o.appearance_vec <=> v_app))::real, 'appearance'::text, o.observed_at,
           o.canonical_place_id, coalesce(cv.plate_number, o.candidate_plate)::text, o.person_record_id, o.canonical_vehicle_id,
           NULL::text, o.evidence_item_id, o.cctv_import_id
    FROM public.cctv_entity_observations o
    LEFT JOIN public.canonical_vehicles cv ON cv.id = o.canonical_vehicle_id
    LEFT JOIN public.person_records pr ON pr.id = o.person_record_id
    WHERE v_app IS NOT NULL AND o.organization_id = p_organization_id AND o.entity_kind = p_entity_kind AND o.appearance_vec IS NOT NULL
      AND o.review_state NOT IN ('rejected', 'superseded') AND (p_exclude_observation_id IS NULL OR o.id <> p_exclude_observation_id)
    ORDER BY o.appearance_vec <=> v_app LIMIT v_n * 3
  ), plate_hits AS (
    SELECT 'canonical_vehicle'::text, cv.id, NULL::uuid, NULL::uuid,
           concat_ws(' ', cv.plate_number, cv.make, cv.model, cv.colour)::text,
           (CASE WHEN cv.plate_number = v_plate THEN 1.0 ELSE extensions.similarity(cv.plate_number, v_plate) END)::real,
           (CASE WHEN cv.plate_number = v_plate THEN 'plate_exact' ELSE 'plate_similar' END)::text, cv.last_seen_at,
           NULL::uuid, cv.plate_number::text, NULL::uuid, cv.id, NULL::text, NULL::uuid, NULL::uuid
    FROM public.canonical_vehicles cv
    WHERE v_plate IS NOT NULL AND p_entity_kind = 'vehicle'
      AND (cv.plate_number = v_plate OR extensions.similarity(cv.plate_number, v_plate) >= 0.6)
    ORDER BY (cv.plate_number = v_plate) DESC, extensions.similarity(cv.plate_number, v_plate) DESC LIMIT v_n
  ), all_hits AS (
    SELECT * FROM face_hits UNION ALL SELECT * FROM legacy_face_hits
    UNION ALL SELECT * FROM appearance_hits UNION ALL SELECT * FROM plate_hits
  )
  SELECT h.match_kind, h.match_id, h.observation_id, h.portfolio_key, h.display_name, h.score, h.basis,
         h.last_seen_at, h.canonical_place_id, h.plate_number, h.person_record_id, h.canonical_vehicle_id,
         h.thumbnail, h.evidence_item_id, h.cctv_import_id
  FROM all_hits h
  WHERE h.score >= CASE h.basis WHEN 'face' THEN 0.65 WHEN 'face_legacy' THEN 0.65 WHEN 'appearance' THEN 0.70 ELSE 0.60 END
  ORDER BY h.score DESC, h.last_seen_at DESC NULLS LAST LIMIT v_n;
END;
$$;

CREATE OR REPLACE FUNCTION public.coalesce_cctv_stationary_vehicle_observations(p_job_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_new public.cctv_entity_observations%rowtype;
  v_anchor public.cctv_entity_observations%rowtype;
  v_timezone text;
  v_count integer := 0;
  v_new_end timestamptz;
  v_anchor_end timestamptz;
BEGIN
  IF auth.role() <> 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.inference_jobs WHERE id = p_job_id AND domain = 'video_motion') THEN
    RAISE EXCEPTION 'CCTV inference job is missing';
  END IF;

  FOR v_new IN
    SELECT * FROM public.cctv_entity_observations
    WHERE inference_job_id = p_job_id AND entity_kind = 'vehicle' AND review_state = 'unreviewed'
    ORDER BY observed_at, id
  LOOP
    IF v_new.cctv_import_id IS NULL OR jsonb_typeof(v_new.attributes->'bbox') <> 'object' THEN CONTINUE; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(v_new.cctv_import_id::text || ':stationary-vehicle', 0));
    SELECT source_timezone INTO v_timezone FROM public.cctv_imports WHERE id = v_new.cctv_import_id;
    v_timezone := coalesce(v_timezone, 'Pacific/Auckland');
    v_new_end := coalesce(v_new.observed_to, v_new.observed_at);
    v_anchor.id := NULL;

    SELECT candidate.* INTO v_anchor
    FROM public.cctv_entity_observations candidate
    WHERE candidate.id <> v_new.id
      AND candidate.organization_id = v_new.organization_id
      AND candidate.cctv_import_id = v_new.cctv_import_id
      AND candidate.entity_kind = 'vehicle'
      AND candidate.review_state = 'unreviewed'
      AND (candidate.observed_at AT TIME ZONE v_timezone)::date = (v_new.observed_at AT TIME ZONE v_timezone)::date
      AND candidate.observed_at <= v_new_end + interval '15 minutes'
      AND coalesce(candidate.observed_to, candidate.observed_at) >= v_new.observed_at - interval '15 minutes'
      AND public.cctv_bbox_is_stationary(coalesce(candidate.attributes->'last_bbox', candidate.attributes->'bbox'), v_new.attributes->'bbox')
      AND (
        (v_new.candidate_plate IS NOT NULL AND candidate.candidate_plate = v_new.candidate_plate)
        OR (v_new.appearance_vec IS NOT NULL AND candidate.appearance_vec IS NOT NULL AND (1 - (candidate.appearance_vec <=> v_new.appearance_vec)) >= 0.88)
      )
    ORDER BY abs(extract(epoch FROM (candidate.observed_at - v_new.observed_at))), candidate.observed_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

    IF v_anchor.id IS NULL THEN CONTINUE; END IF;
    v_anchor_end := coalesce(v_anchor.observed_to, v_anchor.observed_at);
    UPDATE public.cctv_entity_observations
    SET observed_at = least(v_anchor.observed_at, v_new.observed_at),
        observed_to = greatest(v_anchor_end, v_new_end),
        candidate_plate = coalesce(v_anchor.candidate_plate, v_new.candidate_plate),
        canonical_vehicle_id = coalesce(v_anchor.canonical_vehicle_id, v_new.canonical_vehicle_id),
        model_confidence = greatest(v_anchor.model_confidence, v_new.model_confidence),
        attributes = v_anchor.attributes || jsonb_strip_nulls(jsonb_build_object(
          'frame_count', coalesce((v_anchor.attributes->>'frame_count')::integer, 1) + coalesce((v_new.attributes->>'frame_count')::integer, 1),
          'source_observation_count', coalesce((v_anchor.attributes->>'source_observation_count')::integer, 1) + 1,
          'continuous_stationary_event', true,
          'last_bbox', v_new.attributes->'bbox',
          'coalesced_until', greatest(v_anchor_end, v_new_end)
        )),
        thumbnail = CASE WHEN coalesce(v_new.model_confidence, 0) > coalesce(v_anchor.model_confidence, 0) AND v_new.thumbnail IS NOT NULL THEN v_new.thumbnail ELSE v_anchor.thumbnail END,
        frame_sha256 = CASE WHEN coalesce(v_new.model_confidence, 0) > coalesce(v_anchor.model_confidence, 0) THEN coalesce(v_new.frame_sha256, v_anchor.frame_sha256) ELSE v_anchor.frame_sha256 END
    WHERE id = v_anchor.id;

    UPDATE public.cctv_entity_observations
    SET review_state = 'superseded',
        review_notes = 'Source detection consolidated into continuous stationary vehicle event ' || v_anchor.id::text,
        attributes = attributes || jsonb_build_object('superseded_by_observation_id', v_anchor.id, 'continuous_stationary_event_source', true),
        portfolio_candidates = '[]'::jsonb,
        thumbnail = NULL
    WHERE id = v_new.id;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.coalesce_cctv_stationary_vehicle_observations(uuid) IS
  'Service-only post-inference consolidation: same camera/day, <=15 minute gap, stationary bbox, and exact plate or >=88% appearance similarity. Source rows remain superseded for evidence provenance.';
REVOKE ALL ON FUNCTION public.coalesce_cctv_stationary_vehicle_observations(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.coalesce_cctv_stationary_vehicle_observations(uuid) TO service_role;