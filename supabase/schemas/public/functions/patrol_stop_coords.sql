create or replace function public.patrol_stop_coords (
  p_shift_id uuid
)
  returns table (
    stop_id    uuid,
    site_id    uuid,
    zone_id    uuid,
    lat        double precision,
    lng        double precision,
    place_type text
  )
  language sql
  stable
  security definer
  AS $function$
  select
    ss.id as stop_id,
    ss.site_id,
    ss.zone_id,
    case
      when ss.site_id is not null then cs.gps_lat
      when ss.zone_id is not null then st_y(lz.center_point::geometry)
      else null
    end as lat,
    case
      when ss.site_id is not null then cs.gps_lng
      when ss.zone_id is not null then st_x(lz.center_point::geometry)
      else null
    end as lng,
    case
      when ss.site_id is not null then 'site'
      when ss.zone_id is not null then 'zone'
      else 'unknown'
    end as place_type
  from public.shift_stops ss
  left join public.client_sites   cs on cs.id = ss.site_id
  left join public.location_zones lz on lz.id = ss.zone_id
  where ss.shift_id = p_shift_id
    and ss.status in ('pending', 'en_route')
  order by ss.stop_order;
$function$;

grant execute on function "public"."patrol_stop_coords"(uuid) to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."patrol_stop_coords"(uuid) is 'Resolves each pending/en_route shift stop coordinate to plain lat/lng regardless of place type: site_id -> client_sites.gps_*, zone_id -> ST_Y/ST_X(location_zones.center_point). Unified stop model (!709); lets the patrol engine read zone-stops (which client_sites!inner previously dropped).';
