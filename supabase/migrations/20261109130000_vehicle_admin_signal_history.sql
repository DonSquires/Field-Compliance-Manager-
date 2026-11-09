CREATE OR REPLACE FUNCTION public.get_vehicle_enrichment_receipts(
  p_organization_id uuid,
  p_canonical_vehicle_id uuid,
  p_limit integer DEFAULT 25
)
RETURNS TABLE(source_name text, source_location text, retrieved_at timestamptz, response_sha256 text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN
    RAISE EXCEPTION 'Vehicle enrichment receipt access requires an organisation administrator'
      USING ERRCODE = '42501';
  END IF;
  IF p_canonical_vehicle_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.canonical_vehicles v WHERE v.id = p_canonical_vehicle_id
  ) THEN
    RAISE EXCEPTION 'Canonical vehicle not found';
  END IF;
  RETURN QUERY
  SELECT source.source_name, source.source_location, source.retrieved_at, source.response_sha256
  FROM public.vehicle_data_sources source
  WHERE source.canonical_vehicle_id = p_canonical_vehicle_id
  ORDER BY source.retrieved_at DESC, source.id DESC
  LIMIT least(greatest(coalesce(p_limit, 25), 1), 100);
END;
$function$;
COMMENT ON FUNCTION public.get_vehicle_enrichment_receipts(uuid,uuid,integer) IS
  'Admin-only minimized licensed-enrichment history. Returns source, scope, timestamp and response hash only; never returns source keys, authorization references, URLs or normalized payload values.';
REVOKE ALL ON FUNCTION public.get_vehicle_enrichment_receipts(uuid,uuid,integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_vehicle_enrichment_receipts(uuid,uuid,integer)
  TO authenticated, service_role;