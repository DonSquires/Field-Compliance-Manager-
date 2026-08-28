create or replace function public.get_zone_for_gps (
  p_lat    double precision,
  p_lng    double precision,
  p_org_id uuid
)
  returns table (
    site_id          uuid,
    site_name        text,
    zone_id          uuid,
    zone_name        text,
    parent_zone_id   uuid,
    compliance_rules jsonb,
    closure_active   boolean
  )
  language plpgsql
  stable
  AS $function$
declare
  v_point geometry := st_setsrid(st_point(p_lng, p_lat), 4326);
  v_site_id uuid;
  v_zone_id uuid;
begin
  select id into v_site_id
  from client_sites
  where organization_id = p_org_id
    and st_dwithin(boundary, v_point, onsite_radius_meters)
  limit 1;

  if v_site_id is null then
    return;
  end if;

  select id into v_zone_id
  from location_zones
  where organization_id = p_org_id
    and st_contains(boundary, v_point)
  order by parent_zone_id nulls last
  limit 1;

  return query
  select
    cs.id,
    cs.site_name,
    lz.id,
    lz.name,
    lz.parent_zone_id,
    jsonb_build_object(
      'repeat_stay_radius_m', lz.repeat_stay_radius_m,
      'repeat_stay_window_nights', lz.repeat_stay_window_nights,
      'scv_required', lz.scv_required,
      'nightly_limit_consecutive', lz.nightly_limit_consecutive,
      'nightly_limit_monthly', lz.nightly_limit_monthly
    ),
    case when zc.id is not null then true else false end
  from client_sites cs
  left join location_zones lz on lz.id = v_zone_id
  left join zone_closures zc on zc.zone_id = v_zone_id
    and zc.active_from <= now()
    and zc.active_to >= now()
  where cs.id = v_site_id;
end;
$function$;

grant execute on function "public"."get_zone_for_gps"(double precision, double precision, uuid) to public, "anon", "authenticated", "postgres", "service_role";
