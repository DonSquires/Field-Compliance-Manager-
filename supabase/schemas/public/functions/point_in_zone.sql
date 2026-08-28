create or replace function public.point_in_zone (
  p_lat     double precision,
  p_lng     double precision,
  p_zone_id uuid
)
  returns boolean
  language plpgsql
  stable
  AS $function$
declare
  v_point geometry := st_setsrid(st_point(p_lng, p_lat), 4326);
begin
  return exists (
    select 1 from location_zones
    where id = p_zone_id
      and st_contains(boundary, v_point)
  );
end;
$function$;

grant execute on function "public"."point_in_zone"(double precision, double precision, uuid) to public, "anon", "authenticated", "postgres", "service_role";
