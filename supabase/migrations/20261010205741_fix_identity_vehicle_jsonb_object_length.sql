-- manage_identity_vehicle used a PostgreSQL function that does not exist.
-- Keep the original, already-live RPC stable and supply the narrowly scoped
-- immutable helper it intended to call.
CREATE OR REPLACE FUNCTION public.jsonb_object_length(p_value jsonb)
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
  SELECT count(*)::integer
  FROM jsonb_object_keys(coalesce(p_value, '{}'::jsonb));
$function$;

COMMENT ON FUNCTION public.jsonb_object_length(jsonb) IS
  'Returns the number of top-level keys in a JSON object. Used by manage_identity_vehicle shared-record protection.';
REVOKE ALL ON FUNCTION public.jsonb_object_length(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.jsonb_object_length(jsonb)
  TO postgres, service_role;