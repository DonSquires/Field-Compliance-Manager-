create or replace function public.observations_set_gps_point()
  returns trigger
  language plpgsql
  AS $function$
begin
  if new.gps_lat is not null and new.gps_lng is not null then
    new.gps_point := st_setsrid(st_makepoint(new.gps_lng, new.gps_lat), 4326);
  end if;
  return new;
end;
$function$;

grant execute on function "public"."observations_set_gps_point"() to public, "anon", "authenticated", "postgres", "service_role";
