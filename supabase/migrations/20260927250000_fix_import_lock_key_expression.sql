-- Parenthesize JSON extraction before text concatenation in lock keys.
CREATE OR REPLACE FUNCTION public.stage_patrol_import_chunk(
  p_batch_id uuid,
  p_provider_organization_id uuid,
  p_client_organization_id uuid,
  p_observations jsonb,
  p_events jsonb,
  p_proposals jsonb
) RETURNS TABLE(
  obs_inserted integer,
  obs_matched integer,
  evt_inserted integer,
  evt_matched integer,
  proposal_candidates integer,
  proposals_inserted integer,
  proposals_existing integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_key text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_tenant_import_admin(p_provider_organization_id) THEN RAISE EXCEPTION 'Tenant import administrator required'; END IF;
  IF jsonb_typeof(p_observations)<>'array' OR jsonb_typeof(p_events)<>'array' OR jsonb_typeof(p_proposals)<>'array' THEN RAISE EXCEPTION 'Import chunk values must be arrays'; END IF;

  FOR v_key IN
    SELECT lock_key FROM (
      SELECT 'evidence:'||(value->>'external_ref') AS lock_key FROM jsonb_array_elements(p_observations) value
      UNION
      SELECT 'evidence:'||(value->>'external_ref') FROM jsonb_array_elements(p_events) value
      UNION
      SELECT 'vehicle:'||upper(value->>'plate') FROM jsonb_array_elements(p_observations) value WHERE nullif(value->>'plate','') IS NOT NULL
    ) keys WHERE nullif(lock_key,'') IS NOT NULL ORDER BY lock_key
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(p_client_organization_id::text||':'||v_key,0));
  END LOOP;

  RETURN QUERY SELECT * FROM public.stage_patrol_import_chunk_unlocked(
    p_batch_id,p_provider_organization_id,p_client_organization_id,p_observations,p_events,p_proposals
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.stage_patrol_import_chunk(uuid,uuid,uuid,jsonb,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.stage_patrol_import_chunk(uuid,uuid,uuid,jsonb,jsonb,jsonb) TO postgres,authenticated,service_role;
;
