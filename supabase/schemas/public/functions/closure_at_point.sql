create or replace function public.closure_at_point (
  p_lat    double precision,
  p_lng    double precision,
  p_org_id uuid
)
  returns table (
    closure_id   uuid,
    zone_id      uuid,
    closure_type text,
    reason       text
  )
  language plpgsql
  stable
  AS $function$
declare
  v_point geometry := st_setsrid(st_point(p_lng, p_lat), 4326);
begin
  return query
  select
    zc.id,
    zc.zone_id,
    zc.closure_type,
    zc.reason
  from zone_closures zc
  join location_zones lz on lz.id = zc.zone_id
  where zc.organization_id = p_org_id
    and lz.organization_id = p_org_id
    and st_contains(lz.boundary, v_point)
    and zc.active_from <= now()
    and zc.active_to >= now()
  limit 1;
end;
$function$;

grant execute on function "public"."closure_at_point"(double precision, double precision, uuid) to public, "anon", "authenticated", "postgres", "service_role";
