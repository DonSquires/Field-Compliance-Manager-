-- Observations already acquire canonical identity through
-- resolve_record_canonical_identity -> ensure_canonical_vehicle. Search that
-- registry once, not every linked sighting. Legacy unlinked observations still
-- use caller RLS; the partial index keeps that fallback off the linked history.
CREATE INDEX IF NOT EXISTS idx_observations_unlinked_vehicle_search
ON public.observations (id) INCLUDE (plate_number)
WHERE canonical_vehicle_id IS NULL;

CREATE OR REPLACE FUNCTION public.search_vehicle_registrations(p_pattern text, p_limit integer DEFAULT 51)
RETURNS TABLE(id uuid, plate_number text, make text, model text, year integer, colour text)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = ''
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_pattern IS NULL OR length(p_pattern) > 40 OR p_pattern !~ '^[A-Za-z0-9%]+$'
    OR p_pattern !~ '[A-Za-z0-9]' THEN
    RAISE EXCEPTION 'Enter a registration fragment using letters, numbers and %% wildcards';
  END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT v.id, v.plate_number, v.make, v.model, v.year, v.colour
    FROM public.canonical_vehicle_public v WHERE v.plate_number ILIKE p_pattern
    UNION ALL
    SELECT NULL::uuid, upper(regexp_replace(o.plate_number, '[^A-Za-z0-9]', '', 'g')),
      NULL::text, NULL::text, NULL::integer, NULL::text
    FROM public.observations o
    WHERE o.canonical_vehicle_id IS NULL
      AND upper(regexp_replace(o.plate_number, '[^A-Za-z0-9]', '', 'g')) ILIKE p_pattern
  ), unique_plates AS (
    SELECT DISTINCT ON (c.plate_number) c.*
    FROM candidates c
    ORDER BY c.plate_number, c.id NULLS LAST
  )
  SELECT u.* FROM unique_plates u ORDER BY u.plate_number
  LIMIT least(greatest(coalesce(p_limit, 51), 1), 51);
END;
$function$;
REVOKE ALL ON FUNCTION public.search_vehicle_registrations(text, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.search_vehicle_registrations(text, integer) TO authenticated;

COMMENT ON FUNCTION public.search_vehicle_registrations(text, integer) IS
  'Registration discovery from the existing Tier-0 canonical vehicle projection, with caller-RLS fallback for legacy unlinked observations only. Does not enumerate linked observation history or implement a separate permission engine.';
