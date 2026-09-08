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
BEGIN
  IF auth.role() <> 'service_role' AND session_user <> 'postgres' THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;
  IF p_job_id IS NULL OR p_evidence_id IS NULL OR p_org_id IS NULL OR p_motion_result IS NULL THEN
    RAISE EXCEPTION 'Job, evidence, organization, and motion result are required';
  END IF;
  IF jsonb_typeof(p_motion_result) <> 'object'
     OR jsonb_typeof(p_motion_result->'motion_segments') <> 'array' THEN
    RAISE EXCEPTION 'Motion result must contain a motion_segments array';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.inference_jobs
     WHERE id = p_job_id AND evidence_item_id = p_evidence_id AND organization_id = p_org_id
       AND domain = 'video_motion' AND status = 'processing'
  ) THEN
    RAISE EXCEPTION 'Inference job is missing, mismatched, or not processing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.evidence_items
     WHERE id = p_evidence_id AND organization_id = p_org_id AND evidence_kind = 'video'
  ) THEN
    RAISE EXCEPTION 'Video evidence is missing or belongs to another organization';
  END IF;

  INSERT INTO public.inference_results (inference_job_id, evidence_item_id, domain, status, result)
  VALUES (p_job_id, p_evidence_id, 'video_motion', 'complete', p_motion_result)
  RETURNING id INTO result_id;

  FOR face_event IN
    SELECT value AS event, ordinality AS event_number
    FROM jsonb_array_elements(COALESCE(p_motion_result #> '{consolidated_events,face_events}', '[]'::jsonb))
      WITH ORDINALITY
  LOOP
    unknown_label := CASE
      WHEN face_event.event->>'subject_label' IS NULL
        OR face_event.event->>'subject_label' = ''
        OR face_event.event->>'subject_label' ~ '^Person #[0-9]+$'
      THEN 'Unknown Person #' || face_event.event_number
      ELSE face_event.event->>'subject_label'
    END;

    INSERT INTO public.person_records (
      organization_id, display_name, review_state, metadata
    ) VALUES (
      p_org_id,
      unknown_label,
      'manual_review_required',
      jsonb_build_object(
        'origin', 'cctv_video_motion',
        'source_evidence_item_id', p_evidence_id,
        'source_event_id', face_event.event->>'event_id',
        'source_subject_id', face_event.event->>'subject_id',
        'identity_status', 'unknown_candidate'
      )
    ) RETURNING id INTO created_person_id;

    INSERT INTO public.face_observations (
      organization_id, evidence_item_id, person_record_id, confidence, purpose, review_state
    ) VALUES (
      p_org_id,
      p_evidence_id,
      created_person_id,
      NULL,
      'cctv_video_motion_candidate',
      'manual_review_required'
    );
  END LOOP;

  UPDATE public.inference_jobs SET status = 'complete', completed_at = clock_timestamp()
   WHERE id = p_job_id AND status = 'processing';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inference job changed before completion';
  END IF;
  RETURN result_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.assign_face_observation_person(
  p_observation_id uuid,
  p_person_record_id uuid,
  p_display_name text DEFAULT NULL
)
RETURNS public.face_observations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  observation public.face_observations;
BEGIN
  IF auth.role() <> 'service_role' AND session_user <> 'postgres' THEN
    IF auth.uid() IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.face_observations
       WHERE id = p_observation_id AND public.org_access_allowed(organization_id)
    ) THEN
      RAISE EXCEPTION 'Observation access denied';
    END IF;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.face_observations o
    JOIN public.person_records p ON p.organization_id = o.organization_id
   WHERE o.id = p_observation_id AND p.id = p_person_record_id
  ) THEN
    RAISE EXCEPTION 'Person record does not belong to the observation organization';
  END IF;

  IF NULLIF(trim(p_display_name), '') IS NOT NULL THEN
    UPDATE public.person_records
       SET display_name = trim(p_display_name), review_state = 'manual_review_required'
     WHERE id = p_person_record_id;
  END IF;

  UPDATE public.face_observations
     SET person_record_id = p_person_record_id, review_state = 'reviewed'
   WHERE id = p_observation_id
   RETURNING * INTO observation;
  RETURN observation;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_motion_inference(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_motion_inference(uuid, uuid, uuid, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.assign_face_observation_person(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assign_face_observation_person(uuid, uuid, text) TO authenticated, service_role;