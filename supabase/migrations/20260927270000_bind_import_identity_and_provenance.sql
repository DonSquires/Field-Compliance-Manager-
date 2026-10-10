-- Bind import audit identity to reviewed profile data, stamp importer ownership
-- server-side, and require immutable row provenance and one contracted place.
ALTER TABLE public.import_source_profiles ADD COLUMN IF NOT EXISTS import_actor_id uuid;
ALTER TABLE public.import_source_profiles DROP CONSTRAINT IF EXISTS import_source_profiles_import_actor_id_fkey;
ALTER TABLE public.import_source_profiles ADD CONSTRAINT import_source_profiles_import_actor_id_fkey
  FOREIGN KEY (import_actor_id) REFERENCES public.user_profiles(id) ON DELETE RESTRICT;
UPDATE public.import_source_profiles
SET import_actor_id='08369a00-e2df-45d6-9e6b-6b3a6bede645'::uuid,updated_at=now()
WHERE organization_id='e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid AND profile_code='rm_patrol_log';
COMMENT ON COLUMN public.import_source_profiles.import_actor_id IS
  'Dedicated active tenant admin/master identity used for audited imports. The client script cannot override this value.';

ALTER FUNCTION public.begin_patrol_import_batch(uuid,uuid,text,text,text,text,jsonb,jsonb,integer,integer,integer)
  RENAME TO begin_patrol_import_batch_provenance_unchecked;
REVOKE ALL ON FUNCTION public.begin_patrol_import_batch_provenance_unchecked(uuid,uuid,text,text,text,text,jsonb,jsonb,integer,integer,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.begin_patrol_import_batch_provenance_unchecked(uuid,uuid,text,text,text,text,jsonb,jsonb,integer,integer,integer) TO postgres;

CREATE OR REPLACE FUNCTION public.begin_patrol_import_batch(
  p_provider_organization_id uuid,p_client_organization_id uuid,p_batch_name text,
  p_source_file text,p_source_sha256 text,p_parser text,p_manifest_json jsonb,p_schema_json jsonb,
  p_row_count integer,p_duplicate_count integer,p_unresolved_count integer
) RETURNS public.file_import_batches
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_profile public.import_source_profiles%rowtype;
BEGIN
  SELECT * INTO v_profile FROM public.import_source_profiles
  WHERE organization_id=p_provider_organization_id AND profile_code=p_manifest_json->>'source_profile' AND active;
  IF NOT FOUND OR v_profile.import_actor_id IS NULL OR v_profile.import_actor_id<>auth.uid() THEN RAISE EXCEPTION 'Configured tenant import identity required'; END IF;
  IF NOT public.is_tenant_import_admin(p_provider_organization_id) THEN RAISE EXCEPTION 'Configured import identity is not an active tenant administrator'; END IF;
  RETURN public.begin_patrol_import_batch_provenance_unchecked(
    p_provider_organization_id,p_client_organization_id,p_batch_name,p_source_file,p_source_sha256,
    p_parser,p_manifest_json,p_schema_json,p_row_count,p_duplicate_count,p_unresolved_count
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.begin_patrol_import_batch(uuid,uuid,text,text,text,text,jsonb,jsonb,integer,integer,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.begin_patrol_import_batch(uuid,uuid,text,text,text,text,jsonb,jsonb,integer,integer,integer) TO postgres,authenticated,service_role;

ALTER FUNCTION public.stage_patrol_import_chunk(uuid,uuid,uuid,jsonb,jsonb,jsonb)
  RENAME TO stage_patrol_import_chunk_contract_scoped;
REVOKE ALL ON FUNCTION public.stage_patrol_import_chunk_contract_scoped(uuid,uuid,uuid,jsonb,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.stage_patrol_import_chunk_contract_scoped(uuid,uuid,uuid,jsonb,jsonb,jsonb) TO postgres;

CREATE OR REPLACE FUNCTION public.stage_patrol_import_chunk(
  p_batch_id uuid,p_provider_organization_id uuid,p_client_organization_id uuid,
  p_observations jsonb,p_events jsonb,p_proposals jsonb
) RETURNS TABLE(
  obs_inserted integer,obs_matched integer,evt_inserted integer,evt_matched integer,
  proposal_candidates integer,proposals_inserted integer,proposals_existing integer
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_batch public.file_import_batches%rowtype;
  v_profile public.import_source_profiles%rowtype;
  v_row jsonb;
  v_existing jsonb;
  v_observations jsonb;
  v_events jsonb;
  v_proposals jsonb;
  v_derivative_hash text;
  v_profile_code text;
BEGIN
  SELECT * INTO v_batch FROM public.file_import_batches WHERE id=p_batch_id FOR UPDATE;
  IF NOT FOUND OR v_batch.organization_id<>p_provider_organization_id OR v_batch.status<>'staging' THEN RAISE EXCEPTION 'Open provider import batch required'; END IF;
  v_profile_code:=v_batch.manifest_json->>'source_profile';
  v_derivative_hash:=v_batch.manifest_json->>'derivative_sha256';
  SELECT * INTO v_profile FROM public.import_source_profiles WHERE organization_id=p_provider_organization_id AND profile_code=v_profile_code AND active;
  IF NOT FOUND OR v_profile.import_actor_id IS NULL OR v_profile.import_actor_id<>auth.uid() OR v_batch.created_by<>auth.uid() THEN RAISE EXCEPTION 'Configured tenant import identity required'; END IF;
  IF v_batch.source_sha256 IS NULL OR v_derivative_hash IS NULL THEN RAISE EXCEPTION 'Import batch provenance is incomplete'; END IF;

  SELECT coalesce(jsonb_agg(jsonb_set(value,'{payload,source}','"rm_patrol_log_import"'::jsonb,true)),'[]'::jsonb)
  INTO v_observations FROM jsonb_array_elements(p_observations) value;
  SELECT coalesce(jsonb_agg(jsonb_set(value,'{payload,source}','"rm_patrol_log_import"'::jsonb,true)),'[]'::jsonb)
  INTO v_events FROM jsonb_array_elements(p_events) value;
  SELECT coalesce(jsonb_agg(jsonb_set(value,'{source_values,source}','"rm_patrol_log_import"'::jsonb,true)),'[]'::jsonb)
  INTO v_proposals FROM jsonb_array_elements(p_proposals) value;

  FOR v_row IN SELECT * FROM jsonb_array_elements(v_observations) LOOP
    IF v_row->'payload'->>'source_sha256' IS DISTINCT FROM v_batch.source_sha256
      OR v_row->'payload'->>'derivative_sha256' IS DISTINCT FROM v_derivative_hash
      OR nullif(v_row->'payload'->>'source_file','') IS NULL
      OR coalesce(v_row->'payload'->>'source_row','') !~ '^[1-9][0-9]*$'
      OR v_row->'payload'->>'classification_profile' IS DISTINCT FROM v_profile_code THEN
      RAISE EXCEPTION 'Observation row provenance is incomplete or does not match its batch';
    END IF;
    SELECT observation.external_refs->'import' INTO v_existing FROM public.observations observation
    WHERE observation.organization_id=p_client_organization_id AND observation.external_refs->>'external_ref'=v_row->>'external_ref';
    IF v_existing IS NOT NULL AND (
      (nullif(v_existing->>'source','') IS NOT NULL AND v_existing->>'source' IS DISTINCT FROM 'rm_patrol_log_import')
      OR (nullif(v_existing->>'source_sha256','') IS NOT NULL AND v_existing->>'source_sha256' IS DISTINCT FROM v_batch.source_sha256)
      OR (nullif(v_existing->>'derivative_sha256','') IS NOT NULL AND v_existing->>'derivative_sha256' IS DISTINCT FROM v_derivative_hash)
      OR (nullif(v_existing->>'source_file','') IS NOT NULL AND v_existing->>'source_file' IS DISTINCT FROM v_row->'payload'->>'source_file')
      OR (nullif(v_existing->>'source_sheet','') IS NOT NULL AND v_existing->>'source_sheet' IS DISTINCT FROM v_row->'payload'->>'source_sheet')
      OR (nullif(v_existing->>'source_row','') IS NOT NULL AND v_existing->>'source_row' IS DISTINCT FROM v_row->'payload'->>'source_row')
    ) THEN RAISE EXCEPTION 'Observation immutable provenance conflict requires reconciliation'; END IF;
  END LOOP;

  FOR v_row IN SELECT * FROM jsonb_array_elements(v_events) LOOP
    IF v_row->'payload'->>'source_sha256' IS DISTINCT FROM v_batch.source_sha256
      OR v_row->'payload'->>'derivative_sha256' IS DISTINCT FROM v_derivative_hash
      OR nullif(v_row->'payload'->>'source_file','') IS NULL
      OR coalesce(v_row->'payload'->>'source_row','') !~ '^[1-9][0-9]*$'
      OR v_row->'payload'->>'classification_profile' IS DISTINCT FROM v_profile_code THEN
      RAISE EXCEPTION 'Location event row provenance is incomplete or does not match its batch';
    END IF;
    SELECT event.payload INTO v_existing FROM public.location_events event
    WHERE event.organization_id=p_client_organization_id AND event.external_ref=v_row->>'external_ref';
    IF v_existing IS NOT NULL AND (
      (nullif(v_existing->>'source','') IS NOT NULL AND v_existing->>'source' IS DISTINCT FROM 'rm_patrol_log_import')
      OR (nullif(v_existing->>'source_sha256','') IS NOT NULL AND v_existing->>'source_sha256' IS DISTINCT FROM v_batch.source_sha256)
      OR (nullif(v_existing->>'derivative_sha256','') IS NOT NULL AND v_existing->>'derivative_sha256' IS DISTINCT FROM v_derivative_hash)
      OR (nullif(v_existing->>'source_file','') IS NOT NULL AND v_existing->>'source_file' IS DISTINCT FROM v_row->'payload'->>'source_file')
      OR (nullif(v_existing->>'source_sheet','') IS NOT NULL AND v_existing->>'source_sheet' IS DISTINCT FROM v_row->'payload'->>'source_sheet')
      OR (nullif(v_existing->>'source_row','') IS NOT NULL AND v_existing->>'source_row' IS DISTINCT FROM v_row->'payload'->>'source_row')
    ) THEN RAISE EXCEPTION 'Location event immutable provenance conflict requires reconciliation'; END IF;
  END LOOP;

  FOR v_row IN SELECT * FROM jsonb_array_elements(v_proposals) LOOP
    IF v_row->'source_values'->>'source_sha256' IS DISTINCT FROM v_batch.source_sha256
      OR v_row->'source_values'->>'derivative_sha256' IS DISTINCT FROM v_derivative_hash
      OR nullif(v_row->'source_values'->>'source_file','') IS NULL
      OR coalesce(v_row->'source_values'->>'source_row','') !~ '^[1-9][0-9]*$'
      OR v_row->'source_values'->>'source_profile' IS DISTINCT FROM v_profile_code THEN
      RAISE EXCEPTION 'Proposal row provenance is incomplete or does not match its batch';
    END IF;
  END LOOP;

  RETURN QUERY SELECT * FROM public.stage_patrol_import_chunk_contract_scoped(
    p_batch_id,p_provider_organization_id,p_client_organization_id,v_observations,v_events,v_proposals
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.stage_patrol_import_chunk(uuid,uuid,uuid,jsonb,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.stage_patrol_import_chunk(uuid,uuid,uuid,jsonb,jsonb,jsonb) TO postgres,authenticated,service_role;

ALTER FUNCTION public.finalize_patrol_import_batch(uuid,jsonb)
  RENAME TO finalize_patrol_import_batch_unvalidated;
REVOKE ALL ON FUNCTION public.finalize_patrol_import_batch_unvalidated(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.finalize_patrol_import_batch_unvalidated(uuid,jsonb) TO postgres;

CREATE OR REPLACE FUNCTION public.finalize_patrol_import_batch(p_batch_id uuid,p_receipt jsonb)
RETURNS public.file_import_batches
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_batch public.file_import_batches%rowtype;v_profile public.import_source_profiles%rowtype;
BEGIN
  SELECT * INTO v_batch FROM public.file_import_batches WHERE id=p_batch_id FOR UPDATE;
  IF NOT FOUND OR v_batch.status<>'staging' THEN RAISE EXCEPTION 'Open staging import batch required'; END IF;
  SELECT * INTO v_profile FROM public.import_source_profiles WHERE organization_id=v_batch.organization_id AND profile_code=v_batch.manifest_json->>'source_profile' AND active;
  IF NOT FOUND OR v_profile.import_actor_id IS NULL OR v_profile.import_actor_id<>auth.uid() OR v_batch.created_by<>auth.uid() THEN RAISE EXCEPTION 'Configured tenant import identity required'; END IF;
  RETURN public.finalize_patrol_import_batch_unvalidated(p_batch_id,p_receipt);
END;
$function$;
REVOKE ALL ON FUNCTION public.finalize_patrol_import_batch(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.finalize_patrol_import_batch(uuid,jsonb) TO postgres,authenticated,service_role;

ALTER FUNCTION public.create_workshop_work_order_classified_core(uuid,uuid,text,text,uuid,uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,timestamptz,uuid,uuid)
  RENAME TO create_workshop_work_order_classified_core_agreement_scoped;
REVOKE ALL ON FUNCTION public.create_workshop_work_order_classified_core_agreement_scoped(uuid,uuid,text,text,uuid,uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,timestamptz,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.create_workshop_work_order_classified_core_agreement_scoped(uuid,uuid,text,text,uuid,uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,timestamptz,uuid,uuid) TO postgres;

CREATE OR REPLACE FUNCTION public.create_workshop_work_order_classified_core(
  p_client_request_id uuid,p_organization_id uuid,p_kind text,p_title text,
  p_work_subject_code_id uuid,p_work_activity_code_id uuid,p_description text,
  p_client_organization_id uuid,p_service_agreement_id uuid,p_client_site_id uuid,
  p_asset_id uuid,p_inventory_location_id uuid,p_assigned_user_id uuid,
  p_scheduled_for timestamptz,p_bom_template_id uuid,p_zone_id uuid
) RETURNS public.workshop_work_orders
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF p_kind='maintenance' AND ((p_client_site_id IS NULL)=(p_zone_id IS NULL)) THEN
    RAISE EXCEPTION 'Maintenance requires exactly one contracted site or zone';
  END IF;
  RETURN public.create_workshop_work_order_classified_core_agreement_scoped(
    p_client_request_id,p_organization_id,p_kind,p_title,p_work_subject_code_id,p_work_activity_code_id,p_description,
    p_client_organization_id,p_service_agreement_id,p_client_site_id,p_asset_id,p_inventory_location_id,
    p_assigned_user_id,p_scheduled_for,p_bom_template_id,p_zone_id
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.create_workshop_work_order_classified_core(uuid,uuid,text,text,uuid,uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,timestamptz,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.create_workshop_work_order_classified_core(uuid,uuid,text,text,uuid,uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,timestamptz,uuid,uuid) TO postgres;
;
