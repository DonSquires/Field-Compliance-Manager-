create or replace function public.geometry_area_m2 (
  p_geojson jsonb
)
  returns numeric
  language sql
  stable
  AS $function$
  select st_area(st_setsrid(st_geomfromgeojson(p_geojson::text), 4326)::geography)::numeric;
$function$;

grant execute on function "public"."geometry_area_m2"(jsonb) to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."geometry_area_m2"(jsonb) is 'Read-only real area (square metres, geography cast for accuracy) of a supplied GeoJSON polygon. No writes, no pass/fail gate -- surfaces the actual number so a human can judge whether a shape plausibly matches the named place, since a geofence is a domain-blind boundary, not a zone_type-specific area band.';
