-- Mark a CCTV import review-ready only when every video_motion job in it reached a reviewable terminal state.
-- A multi-clip import must remain registered while another clip is still queued or processing.

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
  import_id uuid;
  ready_import_id uuid;
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

    unknown_label := CASE
      WHEN face_event.event->>'subject_label' IS NULL
        OR face_event.event->>'subject_label' = ''
        OR face_event.event->>'subject_label' ~ '^Person #[0-9]+$'
      THEN 'Unknown Person #' || face_event.event_number
      ELSE face_event.event->>'subject_label'
    END;
    INSERT INTO public.person_records (organization_id, display_name, review_state, metadata)
    VALUES (
      p_org_id,
      unknown_label,
      'manual_review_required',
      jsonb_build_object(
        'origin', 'cctv_video_motion',
        'source_evidence_item_id', p_evidence_id,
        'source_event_id', face_event.event->>'event_id',
        'source_subject_id', face_event.event->>'subject_id',
        'identity_status', 'unknown_candidate',
        'face_reference', jsonb_build_object(
          'embedding', face_event.event->'face_embedding',
          'thumbnail', face_event.event->>'thumbnail',
          'evidence_item_id', p_evidence_id,
          'event_id', face_event.event->>'event_id'
        )
      )
    )
    RETURNING id INTO created_person_id;

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
      created_person_id,
      NULL,
      'cctv_video_motion_candidate',
      'manual_review_required',
      jsonb_build_object(
        'source_event_id', face_event.event->>'event_id',
        'source_subject_id', face_event.event->>'subject_id',
        'original_thumbnail', face_event.event->>'thumbnail',
        'original_frame_hash', face_event.event->>'best_frame_hash',
        'candidates', candidate_list
      )
    );
  END LOOP;

  UPDATE public.inference_jobs
     SET status = 'complete',
         completed_at = clock_timestamp()
   WHERE id = p_job_id
     AND status = 'processing';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inference job changed before completion';
  END IF;

  -- Serialise completions through the parent import. Two clips can finish concurrently; the second
  -- parent-lock holder sees the first completion and is then able to advance the import.
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

COMMENT ON FUNCTION public.complete_motion_inference(uuid, uuid, uuid, jsonb) IS
  'Stores a completed video-motion result, preserves face candidates for human review, and advances the parent CCTV import to review_ready only when every video job is reviewable.';

REVOKE ALL ON FUNCTION public.complete_motion_inference(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_motion_inference(uuid, uuid, uuid, jsonb) TO postgres, service_role;
