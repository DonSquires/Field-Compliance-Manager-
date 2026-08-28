create or replace function public.zones_for_site (
  p_site_id uuid
)
  returns table (
    zone_id        uuid,
    zone_name      text,
    parent_zone_id uuid,
    boundary       public.geometry
  )
  language plpgsql
  stable
  AS $function$
begin
  return query
  select
    lz.id,
    lz.name,
    lz.parent_zone_id,
    lz.boundary
  from location_zones lz
  where lz.location_id = (
    select location_id from client_sites where id = p_site_id
  )
  order by lz.parent_zone_id nulls first;
end;
$function$;

grant execute on function "public"."zones_for_site"(uuid) to public, "anon", "authenticated", "postgres", "service_role";
