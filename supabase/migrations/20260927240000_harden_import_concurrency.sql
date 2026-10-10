-- Close legacy cross-tenant batch creation and serialize imported source keys.
CREATE UNIQUE INDEX IF NOT EXISTS observations_patrol_import_external_ref_unique
  ON public.observations(organization_id, (external_refs->>'external_ref'))
  WHERE external_refs->>'external_ref' LIKE 'rm_patrol_import:%';
CREATE UNIQUE INDEX IF NOT EXISTS location_events_patrol_import_external_ref_unique
  ON public.location_events(organization_id, external_ref)
  WHERE source='rm_patrol_log_import' AND external_ref IS NOT NULL;

CREATE OR REPLACE FUNCTION public.create_file_import_batch(
  p_batch_name text,
  p_source_file text,
  p_source_sha256 text,
  p_parser text,
  p_manifest_json jsonb DEFAULT '{}'::jsonb,
  p_schema_json jsonb DEFAULT '{}'::jsonb,
  p_row_count integer DEFAULT 0,
  p_duplicate_count integer DEFAULT 0,
  p_unresolved_count integer DEFAULT 0,
  p_organization_id uuid DEFAULT NULL
) RETURNS public.file_import_batches
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_org_id uuid := p_organization_id;
  v_batch public.file_import_batches%rowtype;
  v_duplicate_of uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF v_org_id IS NULL THEN RAISE EXCEPTION 'Organisation is required'; END IF;
  IF NOT public.is_tenant_import_admin(v_org_id) THEN RAISE EXCEPTION 'Tenant import batch creation denied'; END IF;
  IF nullif(trim(coalesce(p_batch_name,'')),'') IS NULL OR nullif(trim(coalesce(p_source_file,'')),'') IS NULL THEN RAISE EXCEPTION 'Batch name and source file are required'; END IF;
  IF p_row_count<0 OR p_duplicate_count<0 OR p_unresolved_count<0 THEN RAISE EXCEPTION 'Import counts cannot be negative'; END IF;
  IF nullif(trim(coalesce(p_source_sha256,'')),'') IS NOT NULL THEN
    SELECT id INTO v_duplicate_of FROM public.file_import_batches
    WHERE organization_id=v_org_id AND source_sha256=trim(p_source_sha256)
    ORDER BY created_at LIMIT 1;
  END IF;
  INSERT INTO public.file_import_batches(
    organization_id,batch_name,source_file,source_sha256,duplicate_of_batch_id,parser,
    manifest_json,schema_json,row_count,duplicate_count,unresolved_count,created_by
  ) VALUES (
    v_org_id,trim(p_batch_name),trim(p_source_file),nullif(trim(coalesce(p_source_sha256,'')),''),v_duplicate_of,trim(p_parser),
    coalesce(p_manifest_json,'{}'::jsonb),coalesce(p_schema_json,'{}'::jsonb),p_row_count,p_duplicate_count,p_unresolved_count,v_actor
  ) RETURNING * INTO v_batch;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  VALUES(v_org_id,v_actor,'file_import_batch_created','file_import_batches',v_batch.id,
    jsonb_build_object('source_file',v_batch.source_file,'parser',v_batch.parser,'row_count',v_batch.row_count,'duplicate_count',v_batch.duplicate_count,'unresolved_count',v_batch.unresolved_count,'duplicate_of_batch_id',v_batch.duplicate_of_batch_id));
  RETURN v_batch;
END;
$function$;
REVOKE ALL ON FUNCTION public.create_file_import_batch(text,text,text,text,jsonb,jsonb,integer,integer,integer,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.create_file_import_batch(text,text,text,text,jsonb,jsonb,integer,integer,integer,uuid) TO postgres,authenticated,service_role;

ALTER FUNCTION public.stage_patrol_import_chunk(uuid,uuid,uuid,jsonb,jsonb,jsonb)
  RENAME TO stage_patrol_import_chunk_unlocked;
REVOKE ALL ON FUNCTION public.stage_patrol_import_chunk_unlocked(uuid,uuid,uuid,jsonb,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.stage_patrol_import_chunk_unlocked(uuid,uuid,uuid,jsonb,jsonb,jsonb) TO postgres;

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
    SELECT key FROM (
      SELECT 'evidence:'||value->>'external_ref' AS key FROM jsonb_array_elements(p_observations) value
      UNION
      SELECT 'evidence:'||value->>'external_ref' FROM jsonb_array_elements(p_events) value
      UNION
      SELECT 'vehicle:'||upper(value->>'plate') FROM jsonb_array_elements(p_observations) value WHERE nullif(value->>'plate','') IS NOT NULL
    ) keys WHERE nullif(key,'') IS NOT NULL ORDER BY key
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
