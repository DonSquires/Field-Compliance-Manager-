-- Low-level geometry setters are implementation details of governed proposal
-- execution. They must not be directly callable from a browser session.

REVOKE ALL ON FUNCTION public.set_site_geometry(
  uuid,
  jsonb,
  double precision,
  double precision,
  double precision,
  text,
  uuid,
  text
) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.set_zone_geometry(
  uuid,
  jsonb,
  text,
  uuid,
  text
) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.set_zone_geometry(
  uuid,
  double precision,
  double precision,
  double precision,
  text,
  uuid,
  text
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.set_site_geometry(
  uuid,
  jsonb,
  double precision,
  double precision,
  double precision,
  text,
  uuid,
  text
) TO service_role;

GRANT EXECUTE ON FUNCTION public.set_zone_geometry(
  uuid,
  jsonb,
  text,
  uuid,
  text
) TO service_role;

GRANT EXECUTE ON FUNCTION public.set_zone_geometry(
  uuid,
  double precision,
  double precision,
  double precision,
  text,
  uuid,
  text
) TO service_role;