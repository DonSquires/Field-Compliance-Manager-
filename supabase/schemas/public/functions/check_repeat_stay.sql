create or replace function public.check_repeat_stay (
  p_plate         text,
  p_lat           double precision,
  p_lng           double precision,
  p_org_id        uuid,
  p_radius_m      integer                  default 500,
  p_window_nights integer                  default 1,
  p_at            timestamp with time zone default now()
)
  returns jsonb
  language plpgsql
  stable
  security definer
  AS $function$
declare
  v_nights      integer := 0;
  v_last_seen   timestamptz;
  v_point       geography;
  v_window_start timestamptz;
begin
  if p_radius_m is null or p_radius_m <= 0
     or p_window_nights is null or p_window_nights <= 0 then
    return jsonb_build_object(
      'breach', false,
      'nights_within_radius', 0,
      'radius_m', p_radius_m,
      'window_nights', p_window_nights,
      'last_seen_at', null,
      'reason', 'rule_disabled'
    );
  end if;

  v_point := st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography;
  -- Trailing window: p_window_nights calendar days back from p_at.
  v_window_start := (p_at at time zone 'Pacific/Auckland')::date
                    - (p_window_nights - 1) * interval '1 day';

  select
    count(distinct ((observed_at at time zone 'Pacific/Auckland')::date)),
    max(observed_at)
  into v_nights, v_last_seen
  from observations
  where organization_id = p_org_id
    and plate_number = p_plate
    and gps_point is not null
    and observed_at >= v_window_start
    and observed_at <= p_at
    and st_dwithin(gps_point::geography, v_point, p_radius_m);

  return jsonb_build_object(
    'breach', v_nights >= p_window_nights,
    'nights_within_radius', coalesce(v_nights, 0),
    'radius_m', p_radius_m,
    'window_nights', p_window_nights,
    'last_seen_at', v_last_seen,
    'reason', case when v_nights >= p_window_nights
                   then 'repeat_stay_within_radius' else 'within_limit' end
  );
end;
$function$;

grant execute
  on function "public"."check_repeat_stay"(text, double precision, double precision, uuid, integer, integer, timestamp with time zone)
  to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."check_repeat_stay"(text, double precision, double precision, uuid, integer, integer, timestamp with time zone) is 'Counts distinct nights a plate was observed within p_radius_m of a point over a trailing p_window_nights window. Returns JSON verdict (breach when nights >= window). Distances via ST_DWithin on geography. NCC 500m rule.';
