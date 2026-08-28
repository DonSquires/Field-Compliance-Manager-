create or replace function public.validate_ta_names (
  p_names text[]
)
  returns jsonb
  language plpgsql
  stable
  AS $function$
DECLARE
  v_result jsonb := '[]'::jsonb;
  v_name text;
  v_match text;
  v_suggestions jsonb;
  v_entry jsonb;
BEGIN
  -- If the canonical_ta_names table is empty, return all as valid
  -- (defence in depth: do not block proposals when the table has not
  -- been populated yet; the executor still validates against the live
  -- NZTA source).
  IF NOT EXISTS (SELECT 1 FROM public.canonical_ta_names LIMIT 1) THEN
    FOR i IN 1..array_length(p_names, 1) LOOP
      v_result := v_result || jsonb_build_object(
        'name', p_names[i],
        'valid', true,
        'suggestions', '[]'::jsonb,
        'note', 'canonical_ta_names table is empty; validation deferred to executor'
      );
    END LOOP;
    RETURN v_result;
  END IF;

  FOREACH v_name IN ARRAY p_names LOOP
    -- Exact match (case-insensitive)
    SELECT ta_name INTO v_match
    FROM public.canonical_ta_names
    WHERE upper(ta_name) = upper(trim(v_name))
    LIMIT 1;

    IF v_match IS NOT NULL THEN
      v_result := v_result || jsonb_build_object(
        'name', v_name,
        'valid', true,
        'canonical_name', v_match,
        'suggestions', '[]'::jsonb
      );
    ELSE
      -- No exact match: compute top 3 fuzzy suggestions by Levenshtein distance
      SELECT jsonb_agg(sub.ta_name ORDER BY sub.dist, sub.ta_name)
      INTO v_suggestions
      FROM (
        SELECT c.ta_name,
               levenshtein(upper(trim(v_name)), upper(c.ta_name)) AS dist
        FROM public.canonical_ta_names c
        ORDER BY dist ASC
        LIMIT 3
      ) sub;

      v_result := v_result || jsonb_build_object(
        'name', v_name,
        'valid', false,
        'suggestions', COALESCE(v_suggestions, '[]'::jsonb)
      );
    END IF;
  END LOOP;

  RETURN v_result;
END;
$function$;

grant execute on function "public"."validate_ta_names"(text[]) to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."validate_ta_names"(text[]) is 'Validate TA names against canonical_ta_names. Returns JSON array with valid/invalid status and Levenshtein-based fuzzy suggestions for invalid names. Phase 2 geofence redesign (epic #226).';
