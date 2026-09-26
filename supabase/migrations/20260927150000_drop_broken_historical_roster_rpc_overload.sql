-- The 14000 correction added the required client-organization argument.
-- PostgreSQL treats a changed argument list as a new overload, so remove the
-- superseded function whose field-evidence query cannot resolve that scope.
DROP FUNCTION IF EXISTS public.apply_historical_roster_assignment_import(
  uuid, uuid, text, text, jsonb, jsonb, text[], jsonb, boolean
);