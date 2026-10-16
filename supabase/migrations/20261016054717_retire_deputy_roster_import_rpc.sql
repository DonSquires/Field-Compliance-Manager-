-- Owner ruling 2026-10-16: Deputy exports are sample/build evidence only.
-- Keep the offline parser and fixtures, but remove the mutating production API.
DROP FUNCTION IF EXISTS public.apply_deputy_roster_import(
  uuid,
  uuid,
  text,
  text,
  integer,
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  jsonb
);