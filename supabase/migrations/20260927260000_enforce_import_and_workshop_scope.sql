-- Enforce immutable import provenance and contract/place scope before the
-- locked importer executes, and require tenant-local Workshop authority.
ALTER FUNCTION public.begin_patrol_import_batch(uuid,uuid,text,text,text,text,jsonb,jsonb,integer,integer,integer)
  RENAME TO begin_patrol_import_batch_unvalidated;
REVOKE ALL ON FUNCTION public.begin_patrol_import_batch_unvalidated(uuid,uuid,text,text,text,text,jsonb,jsonb,integer,integer,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.begin_patrol_import_batch_unvalidated(uuid,uuid,text,text,text,text,jsonb,jsonb,integer,integer,integer) TO postgres;

CREATE OR REPLACE FUNCTION public.begin_patrol_import_batch(
  p_provider_organization_id uuid,
  p_client_organization_id uuid,
  p_batch_name text,
  p_source_file text,
  p_source_sha256 text,
  p_parser text,
  p_manifest_json jsonb,
  p_schema_json jsonb,
  p_row_count integer,
  p_duplicate_count integer,
  p_unresolved_count integer
) RETURNS public.file_import_batches
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF p_source_sha256 IS NULL OR p_source_sha256 !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'A lowercase SHA-256 source hash is required'; END IF;
  IF p_manifest_json->>'derivative_sha256' IS NULL OR p_manifest_json->>'derivative_sha256' !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'A lowercase SHA-256 derivative hash is required'; END IF;
  RETURN public.begin_patrol_import_batch_unvalidated(
    p_provider_organization_id,p_client_organization_id,p_batch_name,p_source_file,p_source_sha256,
    p_parser,p_manifest_json,p_schema_json,p_row_count,p_duplicate_count,p_unresolved_count
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.begin_patrol_import_batch(uuid,uuid,text,text,text,text,jsonb,jsonb,integer,integer,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.begin_patrol_import_batch(uuid,uuid,text,text,text,text,jsonb,jsonb,integer,integer,integer) TO postgres,authenticated,service_role;

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
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_batch public.file_import_batches%rowtype;
  v_row jsonb;
  v_zone_id uuid;
  v_site_id uuid;
  v_key text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_tenant_import_admin(p_provider_organization_id) THEN RAISE EXCEPTION 'Tenant import administrator required'; END IF;
  IF jsonb_typeof(p_observations)<>'array' OR jsonb_typeof(p_events)<>'array' OR jsonb_typeof(p_proposals)<>'array' THEN RAISE EXCEPTION 'Import chunk values must be arrays'; END IF;
  SELECT * INTO v_batch FROM public.file_import_batches WHERE id=p_batch_id;
  IF NOT FOUND OR v_batch.organization_id<>p_provider_organization_id OR v_batch.status<>'staging' THEN RAISE EXCEPTION 'Open provider import batch required'; END IF;
  IF v_batch.source_sha256 IS NULL OR v_batch.manifest_json->>'target_client_organization_id' IS DISTINCT FROM p_client_organization_id::text THEN RAISE EXCEPTION 'Import batch provenance or client scope is invalid'; END IF;
  IF NOT EXISTS(
    SELECT 1 FROM public.service_agreements agreement
    JOIN public.service_agreement_modules module ON module.service_agreement_id=agreement.id AND module.module_key='patrol' AND module.enabled
    WHERE agreement.provider_organization_id=p_provider_organization_id
      AND agreement.client_organization_id=p_client_organization_id
      AND agreement.agreement_type='operational'
      AND (agreement.starts_on IS NULL OR agreement.starts_on<=current_date)
      AND (agreement.ends_on IS NULL OR agreement.ends_on>=current_date)
  ) THEN RAISE EXCEPTION 'Active contracted patrol module required'; END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_observations) LOOP
    v_zone_id:=NULLIF(v_row->>'zone_id','')::uuid;v_site_id:=NULLIF(v_row->>'site_id','')::uuid;
    IF v_row->'payload'->>'source_sha256' IS DISTINCT FROM v_batch.source_sha256 THEN RAISE EXCEPTION 'Observation source hash does not match its batch'; END IF;
    IF NOT EXISTS(
      SELECT 1 FROM public.service_agreements agreement
      JOIN public.service_agreement_modules module ON module.service_agreement_id=agreement.id AND module.module_key='patrol' AND module.enabled
      JOIN public.service_agreement_locations location ON location.service_agreement_id=agreement.id AND location.status='active'
      WHERE agreement.provider_organization_id=p_provider_organization_id AND agreement.client_organization_id=p_client_organization_id
        AND agreement.agreement_type='operational' AND (agreement.starts_on IS NULL OR agreement.starts_on<=current_date) AND (agreement.ends_on IS NULL OR agreement.ends_on>=current_date)
        AND ((v_zone_id IS NOT NULL AND location.zone_id=v_zone_id) OR (v_site_id IS NOT NULL AND location.site_id=v_site_id))
    ) THEN RAISE EXCEPTION 'Observation place is outside contracted patrol coverage'; END IF;
    IF EXISTS(
      SELECT 1 FROM public.observations observation
      WHERE observation.organization_id=p_client_organization_id AND observation.external_refs->>'external_ref'=v_row->>'external_ref'
        AND observation.external_refs->'import'->>'source' IS DISTINCT FROM 'rm_patrol_log_import'
    ) THEN RAISE EXCEPTION 'Observation external reference is not owned by this importer'; END IF;
  END LOOP;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_events) LOOP
    v_zone_id:=NULLIF(v_row->>'zone_id','')::uuid;v_site_id:=NULLIF(v_row->>'site_id','')::uuid;
    IF v_row->'payload'->>'source_sha256' IS DISTINCT FROM v_batch.source_sha256 THEN RAISE EXCEPTION 'Location event source hash does not match its batch'; END IF;
    IF NOT EXISTS(
      SELECT 1 FROM public.service_agreements agreement
      JOIN public.service_agreement_modules module ON module.service_agreement_id=agreement.id AND module.module_key='patrol' AND module.enabled
      JOIN public.service_agreement_locations location ON location.service_agreement_id=agreement.id AND location.status='active'
      WHERE agreement.provider_organization_id=p_provider_organization_id AND agreement.client_organization_id=p_client_organization_id
        AND agreement.agreement_type='operational' AND (agreement.starts_on IS NULL OR agreement.starts_on<=current_date) AND (agreement.ends_on IS NULL OR agreement.ends_on>=current_date)
        AND ((v_zone_id IS NOT NULL AND location.zone_id=v_zone_id) OR (v_site_id IS NOT NULL AND location.site_id=v_site_id))
    ) THEN RAISE EXCEPTION 'Location event place is outside contracted patrol coverage'; END IF;
    IF EXISTS(
      SELECT 1 FROM public.location_events event
      WHERE event.organization_id=p_client_organization_id AND event.external_ref=v_row->>'external_ref'
        AND event.source IS DISTINCT FROM 'rm_patrol_log_import'
    ) THEN RAISE EXCEPTION 'Location event external reference is not owned by this importer'; END IF;
  END LOOP;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_proposals) LOOP
    IF v_row->'source_values'->>'source_sha256' IS DISTINCT FROM v_batch.source_sha256 THEN RAISE EXCEPTION 'Proposal source hash does not match its batch'; END IF;
  END LOOP;

  FOR v_key IN
    SELECT lock_key FROM (
      SELECT 'evidence:'||(value->>'external_ref') AS lock_key FROM jsonb_array_elements(p_observations) value
      UNION SELECT 'evidence:'||(value->>'external_ref') FROM jsonb_array_elements(p_events) value
    ) keys WHERE nullif(lock_key,'') IS NOT NULL ORDER BY lock_key
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(p_client_organization_id::text||':'||v_key,0));
  END LOOP;
  FOR v_key IN
    SELECT DISTINCT 'vehicle:'||upper(value->>'plate') AS lock_key
    FROM jsonb_array_elements(p_observations) value
    WHERE nullif(value->>'plate','') IS NOT NULL ORDER BY lock_key
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(v_key,0));
  END LOOP;

  RETURN QUERY SELECT * FROM public.stage_patrol_import_chunk_unlocked(
    p_batch_id,p_provider_organization_id,p_client_organization_id,p_observations,p_events,p_proposals
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.stage_patrol_import_chunk(uuid,uuid,uuid,jsonb,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.stage_patrol_import_chunk(uuid,uuid,uuid,jsonb,jsonb,jsonb) TO postgres,authenticated,service_role;

ALTER FUNCTION public.create_workshop_work_order_classified_core(uuid,uuid,text,text,uuid,uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,timestamptz,uuid,uuid)
  RENAME TO create_workshop_work_order_classified_core_unchecked;
REVOKE ALL ON FUNCTION public.create_workshop_work_order_classified_core_unchecked(uuid,uuid,text,text,uuid,uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,timestamptz,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.create_workshop_work_order_classified_core_unchecked(uuid,uuid,text,text,uuid,uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,timestamptz,uuid,uuid) TO postgres;

CREATE OR REPLACE FUNCTION public.create_workshop_work_order_classified_core(
  p_client_request_id uuid,p_organization_id uuid,p_kind text,p_title text,
  p_work_subject_code_id uuid,p_work_activity_code_id uuid,p_description text,
  p_client_organization_id uuid,p_service_agreement_id uuid,p_client_site_id uuid,
  p_asset_id uuid,p_inventory_location_id uuid,p_assigned_user_id uuid,
  p_scheduled_for timestamptz,p_bom_template_id uuid,p_zone_id uuid
) RETURNS public.workshop_work_orders
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_tenant_import_admin(p_organization_id) THEN RAISE EXCEPTION 'Tenant Workshop administrator required'; END IF;
  IF p_kind='maintenance' THEN
    IF p_client_organization_id IS NULL OR p_service_agreement_id IS NULL THEN RAISE EXCEPTION 'Maintenance requires a client and service agreement'; END IF;
    IF NOT EXISTS(
      SELECT 1 FROM public.service_agreements agreement
      JOIN public.service_agreement_modules module ON module.service_agreement_id=agreement.id AND module.module_key='workshop' AND module.enabled
      WHERE agreement.id=p_service_agreement_id
        AND agreement.provider_organization_id=p_organization_id
        AND agreement.client_organization_id=p_client_organization_id
        AND agreement.agreement_type='operational'
        AND (agreement.starts_on IS NULL OR agreement.starts_on<=current_date)
        AND (agreement.ends_on IS NULL OR agreement.ends_on>=current_date)
    ) THEN RAISE EXCEPTION 'Active contracted Workshop module required'; END IF;
    IF (p_client_site_id IS NOT NULL OR p_zone_id IS NOT NULL) AND NOT EXISTS(
      SELECT 1 FROM public.service_agreement_locations location
      WHERE location.service_agreement_id=p_service_agreement_id AND location.status='active'
        AND ((p_client_site_id IS NOT NULL AND location.site_id=p_client_site_id) OR (p_zone_id IS NOT NULL AND location.zone_id=p_zone_id))
    ) THEN RAISE EXCEPTION 'Maintenance place is outside the service agreement'; END IF;
  END IF;
  RETURN public.create_workshop_work_order_classified_core_unchecked(
    p_client_request_id,p_organization_id,p_kind,p_title,p_work_subject_code_id,p_work_activity_code_id,p_description,
    p_client_organization_id,p_service_agreement_id,p_client_site_id,p_asset_id,p_inventory_location_id,
    p_assigned_user_id,p_scheduled_for,p_bom_template_id,p_zone_id
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.create_workshop_work_order_classified_core(uuid,uuid,text,text,uuid,uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,timestamptz,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.create_workshop_work_order_classified_core(uuid,uuid,text,text,uuid,uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,timestamptz,uuid,uuid) TO postgres;
;
