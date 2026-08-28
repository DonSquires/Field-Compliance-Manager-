create or replace function public.compare_boundaries_hausdorff (
  p_geojson_a text,
  p_geojson_b text
)
  returns double precision
  language plpgsql
  stable
  AS $function$
DECLARE
  geom_a geometry;
  geom_b geometry;
  dist double precision;
BEGIN
  -- Null/empty guard: return large sentinel (mismatch), never 0.
  IF p_geojson_a IS NULL OR p_geojson_b IS NULL
     OR trim(p_geojson_a) = '' OR trim(p_geojson_b) = '' THEN
    RETURN 1e9;
  END IF;

  BEGIN
    geom_a := ST_MakeValid(ST_GeomFromGeoJSON(p_geojson_a));
    geom_b := ST_MakeValid(ST_GeomFromGeoJSON(p_geojson_b));
  EXCEPTION WHEN OTHERS THEN
    -- Invalid GeoJSON: return large sentinel (mismatch), never 0.
    RETURN 1e9;
  END;

  -- Empty geometry guard
  IF geom_a IS NULL OR geom_b IS NULL
     OR ST_IsEmpty(geom_a) OR ST_IsEmpty(geom_b) THEN
    RETURN 1e9;
  END IF;

  -- ST_HausdorffDistance on geography returns metres.
  dist := ST_HausdorffDistance(geom_a::geography, geom_b::geography);

  -- Defensive: if the result is NULL or non-finite, return sentinel.
  IF dist IS NULL OR dist = 'NaN'::double precision
     OR dist = 'Infinity'::double precision THEN
    RETURN 1e9;
  END IF;

  RETURN dist;
END;
$function$;

grant execute on function "public"."compare_boundaries_hausdorff"(text, text) to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."compare_boundaries_hausdorff"(text, text) is 'Compare two GeoJSON boundaries via ST_HausdorffDistance (geography, metres). Returns distance in metres; returns 1e9 sentinel on null/invalid input (never 0). Used by canonicalSiteEntry.ts for Q-A3 reconciliation (threshold 5m per Q7).';
