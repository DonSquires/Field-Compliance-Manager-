create or replace function public.refresh_canonical_ta_names (
  p_names  text[],
  p_source text   default 'nzta_featureserver'::text
)
  returns jsonb
  language plpgsql
  security definer
  AS $function$
DECLARE
  v_count integer;
  v_name text;
BEGIN
  -- Guard: never wipe the table with an empty input (Q6 ruling)
  IF p_names IS NULL OR array_length(p_names, 1) IS NULL OR array_length(p_names, 1) = 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'REFRESH_REFUSED: input names array is empty. The NZTA source may be unavailable. The existing canonical_ta_names data has been preserved (Q6: never silently degrade).'
    );
  END IF;

  -- Upsert each name
  v_count := 0;
  FOREACH v_name IN ARRAY p_names LOOP
    INSERT INTO public.canonical_ta_names (ta_name, source, last_refreshed_at)
    VALUES (trim(v_name), p_source, now())
    ON CONFLICT (ta_name) DO UPDATE
      SET source = EXCLUDED.source,
          last_refreshed_at = EXCLUDED.last_refreshed_at;
    v_count := v_count + 1;
  END LOOP;

  -- Remove names that are no longer in the authoritative source
  -- (but only if we received a reasonable number of names -- at least 50
  -- to avoid accidental wipe from a partial fetch)
  IF v_count >= 50 THEN
    DELETE FROM public.canonical_ta_names
    WHERE ta_name NOT IN (SELECT unnest(p_names));
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'upserted', v_count,
    'source', p_source,
    'refreshed_at', now()
  );
END;
$function$;

grant execute on function "public"."refresh_canonical_ta_names"(text[], text) to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."refresh_canonical_ta_names"(text[], text) is 'Upsert canonical TA names from a live NZTA fetch. Called by the bob-refresh-canonical-ta-names edge function. Refuses empty input (Q6: never silently degrade). Phase 2 geofence redesign (epic #226).';
