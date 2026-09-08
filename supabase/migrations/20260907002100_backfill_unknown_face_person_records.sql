DO $$
DECLARE
  motion_result record;
  face_event record;
  created_person_id uuid;
  unknown_label text;
BEGIN
  FOR motion_result IN
    SELECT r.evidence_item_id, j.organization_id, r.result
    FROM public.inference_results r
    JOIN public.inference_jobs j ON j.id = r.inference_job_id
    WHERE r.domain = 'video_motion'
      AND jsonb_array_length(COALESCE(r.result #> '{consolidated_events,face_events}', '[]'::jsonb)) > 0
      AND NOT EXISTS (
        SELECT 1 FROM public.face_observations o
        WHERE o.evidence_item_id = r.evidence_item_id
          AND o.purpose = 'cctv_video_motion_candidate'
      )
  LOOP
    FOR face_event IN
      SELECT value AS event, ordinality AS event_number
      FROM jsonb_array_elements(COALESCE(motion_result.result #> '{consolidated_events,face_events}', '[]'::jsonb))
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
        motion_result.organization_id,
        unknown_label,
        'manual_review_required',
        jsonb_build_object(
          'origin', 'cctv_video_motion',
          'source_evidence_item_id', motion_result.evidence_item_id,
          'source_event_id', face_event.event->>'event_id',
          'source_subject_id', face_event.event->>'subject_id',
          'identity_status', 'unknown_candidate'
        )
      ) RETURNING id INTO created_person_id;

      INSERT INTO public.face_observations (
        organization_id, evidence_item_id, person_record_id, purpose, review_state
      ) VALUES (
        motion_result.organization_id,
        motion_result.evidence_item_id,
        created_person_id,
        'cctv_video_motion_candidate',
        'manual_review_required'
      );
    END LOOP;
  END LOOP;
END;
$$;