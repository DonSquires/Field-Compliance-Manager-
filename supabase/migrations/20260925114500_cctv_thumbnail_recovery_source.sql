-- Recovery source for derived thumbnails omitted during payload remediation. The inference result remains
-- read-only here; callers receive at most five images and write back only through the bounded compactor RPC.

CREATE OR REPLACE FUNCTION public.get_cctv_oversized_thumbnails(p_limit integer DEFAULT 5)
RETURNS TABLE(observation_id uuid, thumbnail text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF auth.role() <> 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;
  RETURN QUERY
  SELECT observation.id,
         coalesce(
           CASE WHEN observation.thumbnail IS NOT NULL AND octet_length(observation.thumbnail) > 80000 THEN observation.thumbnail END,
           CASE observation.entity_kind
             WHEN 'vehicle' THEN jsonb_path_query_first(result.result, '$.consolidated_events.vehicle_events[*] ? (@.event_id == $event)', jsonb_build_object('event', to_jsonb(observation.source_event_id)))->>'thumbnail'
             WHEN 'animal' THEN jsonb_path_query_first(result.result, '$.consolidated_events.animal_events[*] ? (@.event_id == $event)', jsonb_build_object('event', to_jsonb(observation.source_event_id)))->>'thumbnail'
             WHEN 'person' THEN coalesce(
               jsonb_path_query_first(result.result, '$.consolidated_events.person_events[*] ? (@.event_id == $event)', jsonb_build_object('event', to_jsonb(observation.source_event_id)))->>'thumbnail',
               jsonb_path_query_first(result.result, '$.consolidated_events.face_events[*] ? (@.event_id == $event)', jsonb_build_object('event', to_jsonb(observation.source_event_id)))->>'thumbnail'
             )
           END
         ) AS thumbnail
  FROM public.cctv_entity_observations observation
  LEFT JOIN LATERAL (
    SELECT stored.result
    FROM public.inference_results stored
    WHERE stored.inference_job_id = observation.inference_job_id AND stored.domain = 'video_motion'
    ORDER BY stored.created_at DESC
    LIMIT 1
  ) result ON true
  WHERE observation.review_state <> 'superseded'
    AND (observation.thumbnail IS NULL OR octet_length(observation.thumbnail) > 80000)
    AND coalesce(
      CASE WHEN observation.thumbnail IS NOT NULL AND octet_length(observation.thumbnail) > 80000 THEN observation.thumbnail END,
      CASE observation.entity_kind
        WHEN 'vehicle' THEN jsonb_path_query_first(result.result, '$.consolidated_events.vehicle_events[*] ? (@.event_id == $event)', jsonb_build_object('event', to_jsonb(observation.source_event_id)))->>'thumbnail'
        WHEN 'animal' THEN jsonb_path_query_first(result.result, '$.consolidated_events.animal_events[*] ? (@.event_id == $event)', jsonb_build_object('event', to_jsonb(observation.source_event_id)))->>'thumbnail'
        WHEN 'person' THEN coalesce(
          jsonb_path_query_first(result.result, '$.consolidated_events.person_events[*] ? (@.event_id == $event)', jsonb_build_object('event', to_jsonb(observation.source_event_id)))->>'thumbnail',
          jsonb_path_query_first(result.result, '$.consolidated_events.face_events[*] ? (@.event_id == $event)', jsonb_build_object('event', to_jsonb(observation.source_event_id)))->>'thumbnail'
        )
      END
    ) LIKE 'data:image/%'
  ORDER BY observation.created_at, observation.id
  LIMIT least(greatest(coalesce(p_limit, 5), 1), 20);
END;
$$;

REVOKE ALL ON FUNCTION public.get_cctv_oversized_thumbnails(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_cctv_oversized_thumbnails(integer) TO service_role;
