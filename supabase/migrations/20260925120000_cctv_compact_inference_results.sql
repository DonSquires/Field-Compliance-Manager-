-- Postgres stores the review result, not the worker's per-frame scratch state. Original video is the durable
-- evidence/recomputation source; event observations retain bounded previews and model/review provenance.

CREATE OR REPLACE FUNCTION public.cctv_compact_event_array(p_job_id uuid, p_events jsonb, p_kind text)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT coalesce(jsonb_agg(
    (event.value - ARRAY['thumbnail', 'face_embedding', 'appearance_embedding']::text[])
    || CASE WHEN preview.thumbnail IS NOT NULL THEN jsonb_build_object('thumbnail', preview.thumbnail) ELSE '{}'::jsonb END
    ORDER BY event.ordinality
  ), '[]'::jsonb)
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_events) = 'array' THEN p_events ELSE '[]'::jsonb END) WITH ORDINALITY event(value, ordinality)
  LEFT JOIN LATERAL (
    SELECT observation.thumbnail
    FROM public.cctv_entity_observations observation
    WHERE observation.inference_job_id = p_job_id
      AND observation.review_state <> 'superseded'
      AND observation.entity_kind = CASE WHEN p_kind IN ('person', 'face') THEN 'person' ELSE p_kind END
      AND (
        observation.source_event_id = event.value->>'event_id'
        OR (p_kind = 'face' AND observation.attributes->>'face_event_id' = event.value->>'event_id')
      )
    ORDER BY (observation.source_event_id = event.value->>'event_id') DESC, observation.observed_at
    LIMIT 1
  ) preview ON true
$$;

CREATE OR REPLACE FUNCTION public.cctv_compact_motion_result(p_job_id uuid, p_result jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $$
DECLARE
  v_result jsonb := coalesce(p_result, '{}'::jsonb);
  v_segments jsonb;
  v_events jsonb := coalesce(p_result->'consolidated_events', '{}'::jsonb);
  v_keyframes jsonb;
BEGIN
  SELECT coalesce(jsonb_agg(
    (segment.value - 'frames') || jsonb_build_object('frame_count', coalesce(jsonb_array_length(segment.value->'frames'), 0))
    ORDER BY segment.ordinality
  ), '[]'::jsonb)
  INTO v_segments
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_result->'motion_segments') = 'array' THEN p_result->'motion_segments' ELSE '[]'::jsonb END) WITH ORDINALITY segment(value, ordinality);

  SELECT coalesce(jsonb_agg(frame.value - 'thumbnail' ORDER BY frame.ordinality), '[]'::jsonb)
  INTO v_keyframes
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_events->'keyframes') = 'array' THEN v_events->'keyframes' ELSE '[]'::jsonb END) WITH ORDINALITY frame(value, ordinality);

  v_events := jsonb_set(v_events, '{vehicle_events}', public.cctv_compact_event_array(p_job_id, v_events->'vehicle_events', 'vehicle'), true);
  v_events := jsonb_set(v_events, '{person_events}', public.cctv_compact_event_array(p_job_id, v_events->'person_events', 'person'), true);
  v_events := jsonb_set(v_events, '{face_events}', public.cctv_compact_event_array(p_job_id, v_events->'face_events', 'face'), true);
  v_events := jsonb_set(v_events, '{animal_events}', public.cctv_compact_event_array(p_job_id, v_events->'animal_events', 'animal'), true);
  v_events := jsonb_set(v_events, '{keyframes}', v_keyframes, true);
  v_result := jsonb_set(v_result, '{motion_segments}', v_segments, true);
  v_result := jsonb_set(v_result, '{consolidated_events}', v_events, true);
  RETURN v_result || jsonb_build_object('storage_profile', 'review_event_summary_v1');
END;
$$;

CREATE OR REPLACE FUNCTION public.cctv_inference_result_payload_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.domain = 'video_motion' THEN
    NEW.result := public.cctv_compact_motion_result(NEW.inference_job_id, NEW.result);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cctv_inference_result_payload_guard ON public.inference_results;
CREATE TRIGGER trg_cctv_inference_result_payload_guard
BEFORE INSERT OR UPDATE OF result ON public.inference_results
FOR EACH ROW EXECUTE FUNCTION public.cctv_inference_result_payload_guard();

CREATE OR REPLACE FUNCTION public.compact_cctv_inference_results(p_limit integer DEFAULT 5)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  target record;
  v_rows integer := 0;
  v_before bigint := 0;
  v_after bigint := 0;
  v_compact jsonb;
BEGIN
  IF auth.role() <> 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;
  FOR target IN
    SELECT id, inference_job_id, result
    FROM public.inference_results
    WHERE domain = 'video_motion' AND coalesce(result->>'storage_profile', '') <> 'review_event_summary_v1'
    ORDER BY created_at, id
    LIMIT least(greatest(coalesce(p_limit, 5), 1), 20)
    FOR UPDATE SKIP LOCKED
  LOOP
    v_before := v_before + pg_column_size(target.result);
    v_compact := public.cctv_compact_motion_result(target.inference_job_id, target.result);
    UPDATE public.inference_results SET result = v_compact WHERE id = target.id;
    v_after := v_after + pg_column_size(v_compact);
    v_rows := v_rows + 1;
  END LOOP;
  RETURN jsonb_build_object('rows', v_rows, 'before_bytes', v_before, 'after_bytes', v_after);
END;
$$;

REVOKE ALL ON FUNCTION public.cctv_compact_event_array(uuid, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cctv_compact_motion_result(uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.compact_cctv_inference_results(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cctv_compact_event_array(uuid, jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.cctv_compact_motion_result(uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.compact_cctv_inference_results(integer) TO service_role;
