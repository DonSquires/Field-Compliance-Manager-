-- Place patrols and services, Task 4 (owner design 2026-11-16).
-- Sunrise and sunset in the database, so dusk and dawn patrol checks can be scheduled.
--   solar_event_at     - NOAA general solar position algorithm (zenith 90.833 degrees).
--                        p_date is the local Pacific/Auckland calendar date. Returns NULL
--                        when the sun never rises (polar night) or never sets (midnight
--                        sun) that day, and when p_date, p_lat, p_lng or p_event is NULL.
--                        Any p_event other than 'sunrise' or 'sunset' raises SQLSTATE 22023.
--   place_anchor_point - the point a place's solar times are computed for: site centre
--                        point, else zone centre point, else the site or zone boundary
--                        centroid, else NULL. Internal: service_role only.

CREATE OR REPLACE FUNCTION public.solar_event_at(p_date date, p_lat double precision, p_lng double precision, p_event text)
RETURNS timestamptz
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
DECLARE
  -- Minutes are measured from 00:00 UTC of p_date. Western longitudes (Chatham Islands,
  -- about 176.5 W) are taken as east of 180 (p_lng + 360), so solar noon lands on p_date
  -- in Pacific/Auckland rather than on the next local day.
  v_lng double precision;
  v_minutes double precision;
  v_t double precision;
  v_l0 double precision;
  v_m double precision;
  v_e double precision;
  v_c double precision;
  v_omega double precision;
  v_lambda double precision;
  v_eps double precision;
  v_dec double precision;
  v_y double precision;
  v_eqtime double precision;
  v_cos_ha double precision;
  v_ha double precision;
  v_pass integer;
BEGIN
  IF p_event IS NULL OR p_event NOT IN ('sunrise', 'sunset') THEN
    IF p_event IS NULL THEN RETURN NULL; END IF;
    RAISE EXCEPTION 'p_event must be sunrise or sunset' USING ERRCODE = '22023';
  END IF;
  IF p_date IS NULL OR p_lat IS NULL OR p_lng IS NULL THEN
    RETURN NULL;
  END IF;

  -- First pass at local solar noon, second pass at the first estimate of the event.
  v_lng := CASE WHEN p_lng < 0 THEN p_lng + 360 ELSE p_lng END;
  v_minutes := 720 - 4 * v_lng;
  FOR v_pass IN 1..2 LOOP
    v_t := ((p_date - DATE '2000-01-01') - 0.5 + v_minutes / 1440.0) / 36525.0;
    v_l0 := mod((280.46646 + v_t * (36000.76983 + v_t * 0.0003032))::numeric, 360)::double precision;
    v_m := 357.52911 + v_t * (35999.05029 - 0.0001537 * v_t);
    v_e := 0.016708634 - v_t * (0.000042037 + 0.0000001267 * v_t);
    v_c := sind(v_m) * (1.914602 - v_t * (0.004817 + 0.000014 * v_t))
         + sind(2 * v_m) * (0.019993 - 0.000101 * v_t)
         + sind(3 * v_m) * 0.000289;
    v_omega := 125.04 - 1934.136 * v_t;
    v_lambda := v_l0 + v_c - 0.00569 - 0.00478 * sind(v_omega);
    v_eps := 23 + (26 + (21.448 - v_t * (46.815 + v_t * (0.00059 - v_t * 0.001813))) / 60) / 60
           + 0.00256 * cosd(v_omega);
    v_dec := asind(sind(v_eps) * sind(v_lambda));
    v_y := tand(v_eps / 2) ^ 2;
    v_eqtime := 4 * degrees(
        v_y * sind(2 * v_l0)
      - 2 * v_e * sind(v_m)
      + 4 * v_e * v_y * sind(v_m) * cosd(2 * v_l0)
      - 0.5 * v_y * v_y * sind(4 * v_l0)
      - 1.25 * v_e * v_e * sind(2 * v_m));
    v_cos_ha := cosd(90.833) / (cosd(p_lat) * cosd(v_dec)) - tand(p_lat) * tand(v_dec);
    IF v_cos_ha > 1 OR v_cos_ha < -1 THEN
      RETURN NULL;
    END IF;
    v_ha := acosd(v_cos_ha);
    v_minutes := 720 - 4 * v_lng - v_eqtime + CASE WHEN p_event = 'sunrise' THEN -4 * v_ha ELSE 4 * v_ha END;
  END LOOP;

  RETURN (p_date::timestamp + make_interval(secs => v_minutes * 60)) AT TIME ZONE 'UTC';
END
$fn$;

REVOKE ALL ON FUNCTION public.solar_event_at(date, double precision, double precision, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.solar_event_at(date, double precision, double precision, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.place_anchor_point(p_site_id uuid, p_zone_id uuid)
RETURNS geometry(Point,4326)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT coalesce(
    (SELECT s.center_point FROM public.client_sites s WHERE s.id = p_site_id),
    (SELECT z.center_point FROM public.location_zones z WHERE z.id = p_zone_id),
    (SELECT ST_Centroid(s.boundary) FROM public.client_sites s WHERE s.id = p_site_id AND s.boundary IS NOT NULL),
    (SELECT ST_Centroid(z.boundary) FROM public.location_zones z WHERE z.id = p_zone_id AND z.boundary IS NOT NULL)
  )::geometry(Point,4326)
$fn$;

REVOKE ALL ON FUNCTION public.place_anchor_point(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.place_anchor_point(uuid, uuid) TO service_role;
