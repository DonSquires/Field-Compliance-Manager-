-- Display thumbnails are derivatives, not source evidence. Keep them bounded so review-list reads cannot
-- exhaust the database/API; the original frame remains available through evidence_item_id + frame_sha256.

CREATE OR REPLACE FUNCTION public.cctv_observation_payload_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  NEW.portfolio_candidates := public.cctv_strip_candidate_images(NEW.portfolio_candidates);
  IF NEW.thumbnail IS NOT NULL AND octet_length(NEW.thumbnail) > 80000 THEN
    NEW.attributes := coalesce(NEW.attributes, '{}'::jsonb) || jsonb_build_object(
      'thumbnail_omitted', 'payload_over_80kb',
      'thumbnail_original_bytes', octet_length(NEW.thumbnail)
    );
    NEW.thumbnail := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cctv_observation_payload_guard ON public.cctv_entity_observations;
CREATE TRIGGER trg_cctv_observation_payload_guard
BEFORE INSERT OR UPDATE OF portfolio_candidates, thumbnail ON public.cctv_entity_observations
FOR EACH ROW EXECUTE FUNCTION public.cctv_observation_payload_guard();

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
  SELECT o.id, o.thumbnail
  FROM public.cctv_entity_observations o
  WHERE o.thumbnail IS NOT NULL AND octet_length(o.thumbnail) > 80000 AND o.review_state <> 'superseded'
  ORDER BY o.created_at, o.id
  LIMIT least(greatest(coalesce(p_limit, 5), 1), 20);
END;
$$;

CREATE OR REPLACE FUNCTION public.compact_cctv_observation_thumbnail(
  p_observation_id uuid,
  p_thumbnail text,
  p_original_bytes integer,
  p_compacted_bytes integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF auth.role() <> 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;
  IF p_thumbnail IS NOT NULL AND (p_thumbnail NOT LIKE 'data:image/jpeg;base64,%' OR octet_length(p_thumbnail) > 80000 OR p_compacted_bytes > 60000) THEN
    RAISE EXCEPTION 'Compacted CCTV thumbnail is invalid or too large';
  END IF;
  UPDATE public.cctv_entity_observations
  SET thumbnail = p_thumbnail,
      attributes = attributes || jsonb_build_object(
        'thumbnail_compacted', p_thumbnail IS NOT NULL,
        'thumbnail_compaction_failed', p_thumbnail IS NULL,
        'thumbnail_original_bytes', p_original_bytes,
        'thumbnail_compacted_bytes', p_compacted_bytes,
        'thumbnail_compacted_at', clock_timestamp()
      )
  WHERE id = p_observation_id AND review_state <> 'superseded';
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.get_cctv_oversized_thumbnails(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.compact_cctv_observation_thumbnail(uuid, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_cctv_oversized_thumbnails(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.compact_cctv_observation_thumbnail(uuid, text, integer, integer) TO service_role;
