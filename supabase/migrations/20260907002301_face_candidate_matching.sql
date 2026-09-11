ALTER TABLE public.face_observations
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE OR REPLACE FUNCTION public.face_embedding_cosine(p_left jsonb, p_right jsonb)
RETURNS real
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  left_value jsonb;
  right_value jsonb;
  left_norm double precision := 0;
  right_norm double precision := 0;
  dot_product double precision := 0;
  index integer;
  left_number double precision;
  right_number double precision;
BEGIN
  IF jsonb_typeof(p_left) <> 'array' OR jsonb_typeof(p_right) <> 'array'
     OR jsonb_array_length(p_left) = 0 OR jsonb_array_length(p_left) <> jsonb_array_length(p_right) THEN
    RETURN 0;
  END IF;
  FOR index IN 0..jsonb_array_length(p_left) - 1 LOOP
    left_value := p_left -> index;
    right_value := p_right -> index;
    IF jsonb_typeof(left_value) <> 'number' OR jsonb_typeof(right_value) <> 'number' THEN
      RETURN 0;
    END IF;
    left_number := left_value::text::double precision;
    right_number := right_value::text::double precision;
    dot_product := dot_product + left_number * right_number;
    left_norm := left_norm + left_number * left_number;
    right_norm := right_norm + right_number * right_number;
  END LOOP;
  IF left_norm = 0 OR right_norm = 0 THEN RETURN 0; END IF;
  RETURN (dot_product / sqrt(left_norm * right_norm))::real;
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
  created_person_id uuid;
  unknown_label text;
  candidate_list jsonb;
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
    SELECT 1 FROM public.inference_jobs
     WHERE id = p_job_id AND evidence_item_id = p_evidence_id AND organization_id = p_org_id
       AND domain = 'video_motion' AND status = 'processing'
  ) THEN RAISE EXCEPTION 'Inference job is missing, mismatched, or not processing'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.evidence_items
     WHERE id = p_evidence_id AND organization_id = p_org_id AND evidence_kind = 'video'
  ) THEN RAISE EXCEPTION 'Video evidence is missing or belongs to another organization'; END IF;

  INSERT INTO public.inference_results (inference_job_id, evidence_item_id, domain, status, result)
  VALUES (p_job_id, p_evidence_id, 'video_motion', 'complete', p_motion_result)
  RETURNING id INTO result_id;

  FOR face_event IN
    SELECT value AS event, ordinality AS event_number
    FROM jsonb_array_elements(COALESCE(p_motion_result #> '{consolidated_events,face_events}', '[]'::jsonb)) WITH ORDINALITY
  LOOP
    SELECT COALESCE(jsonb_agg(candidate ORDER BY similarity DESC), '[]'::jsonb)
      INTO candidate_list
      FROM (
        SELECT jsonb_build_object(
          'person_record_id', p.id,
          'display_name', COALESCE(p.display_name, 'Unnamed person'),
          'similarity', round(public.face_embedding_cosine(
            face_event.event->'face_embedding', p.metadata #> '{face_reference,embedding}'
          )::numeric, 4),
          'reference_thumbnail', p.metadata #>> '{face_reference,thumbnail}',
          'review_state', p.review_state
        ) AS candidate,
        public.face_embedding_cosine(face_event.event->'face_embedding', p.metadata #> '{face_reference,embedding}') AS similarity
        FROM public.person_records p
        WHERE p.organization_id = p_org_id
          AND jsonb_typeof(face_event.event->'face_embedding') = 'array'
          AND jsonb_typeof(p.metadata #> '{face_reference,embedding}') = 'array'
        ORDER BY similarity DESC
        LIMIT 5
      ) ranked;

    unknown_label := CASE
      WHEN face_event.event->>'subject_label' IS NULL OR face_event.event->>'subject_label' = ''
        OR face_event.event->>'subject_label' ~ '^Person #[0-9]+$'
      THEN 'Unknown Person #' || face_event.event_number
      ELSE face_event.event->>'subject_label'
    END;
    INSERT INTO public.person_records (organization_id, display_name, review_state, metadata)
    VALUES (
      p_org_id, unknown_label, 'manual_review_required',
      jsonb_build_object(
        'origin', 'cctv_video_motion', 'source_evidence_item_id', p_evidence_id,
        'source_event_id', face_event.event->>'event_id', 'source_subject_id', face_event.event->>'subject_id',
        'identity_status', 'unknown_candidate',
        'face_reference', jsonb_build_object(
          'embedding', face_event.event->'face_embedding',
          'thumbnail', face_event.event->>'thumbnail',
          'evidence_item_id', p_evidence_id,
          'event_id', face_event.event->>'event_id'
        )
      )
    ) RETURNING id INTO created_person_id;

    INSERT INTO public.face_observations (
      organization_id, evidence_item_id, person_record_id, confidence, purpose, review_state, metadata
    ) VALUES (
      p_org_id, p_evidence_id, created_person_id, NULL, 'cctv_video_motion_candidate',
      'manual_review_required', jsonb_build_object(
        'source_event_id', face_event.event->>'event_id',
        'source_subject_id', face_event.event->>'subject_id',
        'original_thumbnail', face_event.event->>'thumbnail',
        'original_frame_hash', face_event.event->>'best_frame_hash',
        'candidates', candidate_list
      )
    );
  END LOOP;

  UPDATE public.inference_jobs SET status = 'complete', completed_at = clock_timestamp()
   WHERE id = p_job_id AND status = 'processing';
  IF NOT FOUND THEN RAISE EXCEPTION 'Inference job changed before completion'; END IF;
  RETURN result_id;
END;
$$;

REVOKE ALL ON FUNCTION public.face_embedding_cosine(jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.face_embedding_cosine(jsonb, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.complete_motion_inference(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_motion_inference(uuid, uuid, uuid, jsonb) TO service_role;