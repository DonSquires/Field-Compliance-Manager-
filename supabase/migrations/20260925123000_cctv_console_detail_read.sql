-- One consistent detail snapshot replaces five REST reads on every realtime/poll refresh.

CREATE OR REPLACE FUNCTION public.get_cctv_console_import_detail(p_import_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_org_id uuid;
  v_result jsonb;
BEGIN
  SELECT organization_id INTO v_org_id FROM public.cctv_imports WHERE id = p_import_id;
  IF v_org_id IS NULL OR (auth.role() NOT IN ('service_role') AND session_user NOT IN ('postgres', 'supabase_admin')
     AND (auth.uid() IS NULL OR NOT public.org_access_allowed(v_org_id))) THEN
    RAISE EXCEPTION 'CCTV import detail access denied';
  END IF;

  WITH evidence AS (
    SELECT item.* FROM public.evidence_items item
    WHERE item.organization_id = v_org_id AND item.cctv_import_id = p_import_id
  )
  SELECT jsonb_build_object(
    'evidence', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', item.id, 'storage_path', item.storage_path, 'captured_at', item.captured_at,
        'metadata', item.metadata, 'sha256_hash', item.sha256_hash, 'is_court_ready', item.is_court_ready,
        'locked_at', item.locked_at, 'retention_hold', item.retention_hold
      ) ORDER BY item.captured_at) FROM evidence item
    ), '[]'::jsonb),
    'marks', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', event.id, 'source', event.source, 'source_ref', event.source_ref,
        'event_start_at', event.event_start_at, 'event_end_at', event.event_end_at,
        'severity', event.severity, 'thumbnail_path', event.thumbnail_path, 'metadata', event.metadata
      ) ORDER BY event.event_start_at)
      FROM (SELECT * FROM public.cctv_device_events WHERE cctv_import_id = p_import_id ORDER BY event_start_at LIMIT 5000) event
    ), '[]'::jsonb),
    'observations', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', observation.id, 'evidence_item_id', observation.evidence_item_id, 'cctv_import_id', observation.cctv_import_id,
        'source_event_id', observation.source_event_id, 'entity_kind', observation.entity_kind,
        'observed_at', observation.observed_at, 'observed_to', observation.observed_to,
        'candidate_label', observation.candidate_label, 'candidate_plate', observation.candidate_plate,
        'animal_type', observation.animal_type, 'species_confidence', observation.species_confidence, 'is_pest', observation.is_pest,
        'model_confidence', observation.model_confidence, 'quality_state', observation.quality_state,
        'attributes', observation.attributes, 'thumbnail', observation.thumbnail,
        'review_state', observation.review_state, 'portfolio_key', observation.portfolio_key,
        'portfolio_state', observation.portfolio_state, 'portfolio_candidates', observation.portfolio_candidates,
        'person_record_id', observation.person_record_id, 'canonical_person_id', observation.canonical_person_id,
        'canonical_vehicle_id', observation.canonical_vehicle_id, 'reviewed_at', observation.reviewed_at,
        'review_notes', observation.review_notes,
        'person_records', CASE WHEN person.id IS NULL THEN NULL ELSE jsonb_build_object('display_name', person.display_name, 'metadata', person.metadata) END
      ) ORDER BY observation.observed_at)
      FROM (SELECT * FROM public.cctv_entity_observations
            WHERE organization_id = v_org_id AND cctv_import_id = p_import_id AND review_state <> 'superseded'
            ORDER BY observed_at LIMIT 2000) observation
      LEFT JOIN public.person_records person ON person.id = observation.person_record_id
    ), '[]'::jsonb),
    'jobs', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', job.id, 'evidence_item_id', job.evidence_item_id, 'status', job.status))
      FROM public.inference_jobs job JOIN evidence item ON item.id = job.evidence_item_id
      WHERE job.domain = 'video_motion'
    ), '[]'::jsonb),
    'synopses', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'evidence_id', synopsis.evidence_id, 'approval_status', synopsis.approval_status,
        'generated_summary', synopsis.generated_summary, 'generated_at', synopsis.generated_at
      ) ORDER BY synopsis.generated_at DESC)
      FROM public.evidence_summary_approvals synopsis JOIN evidence item ON item.id = synopsis.evidence_id
      WHERE synopsis.generated_mode = 'cctv_vision_llm_scene_synopsis'
    ), '[]'::jsonb)
  ) INTO v_result;
  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.get_cctv_console_import_detail(uuid) IS
  'Tenant-authorized, snapshot-consistent CCTV console detail: evidence, timeline marks, review events, job states, and scene synopses in one read.';
REVOKE ALL ON FUNCTION public.get_cctv_console_import_detail(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_cctv_console_import_detail(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_cctv_console_import_detail(uuid) TO service_role;
