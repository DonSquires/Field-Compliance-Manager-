create or replace function public.compute_point_distance_km (
  lat1 double precision,
  lng1 double precision,
  lat2 double precision,
  lng2 double precision
)
  returns numeric
  language sql
  stable
  AS $function$
  select round(
    (st_distance(
      st_setsrid(st_makepoint(lng1, lat1), 4326)::geography,
      st_setsrid(st_makepoint(lng2, lat2), 4326)::geography
    ) / 1000.0)::numeric,
    3
  );
$function$;

grant execute
  on function "public"."compute_point_distance_km"(double precision, double precision, double precision, double precision)
  to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."compute_point_distance_km"(double precision, double precision, double precision, double precision) is 'Returns the geodesic distance in km between two lat/lng points. Uses ST_Distance on geography (metres) / 1000. Called by the completion pipeline for travel distance computation.';
