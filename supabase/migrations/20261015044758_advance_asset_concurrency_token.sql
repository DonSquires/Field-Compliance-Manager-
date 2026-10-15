CREATE FUNCTION public.set_asset_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.set_asset_updated_at() IS
  'Advances the asset optimistic-concurrency token for every writer, including register updates, shift sign-out, return, and checks.';

REVOKE ALL ON FUNCTION public.set_asset_updated_at()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_asset_updated_at()
  TO postgres, service_role;

CREATE TRIGGER set_asset_updated_at
BEFORE UPDATE ON public.assets
FOR EACH ROW
EXECUTE FUNCTION public.set_asset_updated_at();