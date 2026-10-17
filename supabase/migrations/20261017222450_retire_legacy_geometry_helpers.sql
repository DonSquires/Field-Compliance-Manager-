drop function if exists public.closure_at_point(double precision, double precision, uuid);
drop function if exists public.point_in_zone(double precision, double precision, uuid);
drop function if exists public.zones_for_site(uuid);
drop function if exists public.compute_point_distance_km(
  double precision,
  double precision,
  double precision,
  double precision
);