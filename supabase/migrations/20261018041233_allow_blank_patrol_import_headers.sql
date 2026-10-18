-- Spreadsheet exports can legitimately contain repeated unnamed columns. Treat only
-- normalized, nonblank header names as mappings while preserving duplicate-name rejection.
CREATE OR REPLACE FUNCTION "public"."begin_patrol_import_batch_unvalidated"(p_provider_organization_id uuid, p_client_organization_id uuid, p_batch_name text, p_source_file text, p_source_sha256 text, p_parser text, p_manifest_json jsonb, p_schema_json jsonb, p_row_count integer, p_duplicate_count integer, p_unresolved_count integer)
 RETURNS file_import_batches
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_batch public.file_import_batches%rowtype;
  v_idempotency_key text := nullif(p_manifest_json->>'idempotency_key', '');
  v_header text;
  v_mapping jsonb;
  v_expected_mappings integer;
  v_actual_mappings integer;
BEGIN
  IF v_actor IS NULL OR NOT public.is_tenant_import_admin(p_provider_organization_id) THEN RAISE EXCEPTION 'Tenant import administrator required'; END IF;
  IF p_provider_organization_id = p_client_organization_id THEN RAISE EXCEPTION 'Patrol import requires a distinct client organization'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = p_provider_organization_id AND active) THEN RAISE EXCEPTION 'Active provider organization required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = p_client_organization_id AND active) THEN RAISE EXCEPTION 'Active client organization required'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.service_agreements agreement
    WHERE agreement.provider_organization_id = p_provider_organization_id
      AND agreement.client_organization_id = p_client_organization_id
      AND agreement.agreement_type = 'operational'
      AND (agreement.starts_on IS NULL OR agreement.starts_on <= current_date)
      AND (agreement.ends_on IS NULL OR agreement.ends_on >= current_date)
  ) THEN RAISE EXCEPTION 'An active operational provider-client agreement is required'; END IF;
  IF v_idempotency_key IS NULL THEN RAISE EXCEPTION 'Import idempotency key is required'; END IF;
  IF p_source_sha256 !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'A lowercase SHA-256 source hash is required'; END IF;
  IF jsonb_typeof(p_schema_json->'headers') <> 'array' OR jsonb_typeof(p_schema_json->'resolved_mappings') <> 'array' THEN RAISE EXCEPTION 'Import headers and resolved mappings are required'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.import_source_profiles profile
    WHERE profile.organization_id = p_provider_organization_id
      AND profile.profile_code = p_manifest_json->>'source_profile'
      AND profile.active
  ) THEN RAISE EXCEPTION 'Active provider import profile required'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_provider_organization_id::text || ':' || v_idempotency_key, 0));
  SELECT * INTO v_batch FROM public.file_import_batches
  WHERE organization_id = p_provider_organization_id
    AND manifest_json->>'idempotency_key' = v_idempotency_key
  FOR UPDATE;
  IF FOUND AND v_batch.status <> 'staging' THEN RAISE EXCEPTION 'This source and import configuration already has a closed review batch'; END IF;

  IF NOT FOUND THEN
    INSERT INTO public.file_import_batches(
      organization_id, batch_name, source_file, source_sha256, parser, status,
      manifest_json, schema_json, row_count, duplicate_count, unresolved_count, created_by
    ) VALUES (
      p_provider_organization_id, trim(p_batch_name), trim(p_source_file), p_source_sha256,
      trim(p_parser), 'staging', p_manifest_json, p_schema_json,
      p_row_count, p_duplicate_count, p_unresolved_count, v_actor
    ) RETURNING * INTO v_batch;
  ELSE
    UPDATE public.file_import_batches SET
      batch_name = trim(p_batch_name), source_file = trim(p_source_file), source_sha256 = p_source_sha256,
      parser = trim(p_parser), manifest_json = p_manifest_json, schema_json = p_schema_json,
      row_count = p_row_count, duplicate_count = p_duplicate_count,
      unresolved_count = p_unresolved_count, updated_at = clock_timestamp()
    WHERE id = v_batch.id RETURNING * INTO v_batch;
    DELETE FROM public.file_import_mapping_reviews WHERE batch_id = v_batch.id AND decision = 'proposed';
  END IF;

  WITH normalized_headers AS (
    SELECT nullif(lower(regexp_replace(btrim(value), '\s+', ' ', 'g')), '') AS normalized_header
    FROM jsonb_array_elements_text(p_schema_json->'headers')
  )
  SELECT count(*)::integer, count(DISTINCT normalized_header)::integer
  INTO v_expected_mappings, v_actual_mappings
  FROM normalized_headers
  WHERE normalized_header IS NOT NULL;
  IF v_expected_mappings <> v_actual_mappings THEN RAISE EXCEPTION 'Duplicate source headers require manual correction'; END IF;

  FOR v_header IN
    SELECT value
    FROM jsonb_array_elements_text(p_schema_json->'headers')
    WHERE nullif(regexp_replace(btrim(value), '\s+', '', 'g'), '') IS NOT NULL
  LOOP
    v_mapping := NULL;
    SELECT item INTO v_mapping
    FROM jsonb_array_elements(p_schema_json->'resolved_mappings') item
    WHERE item->>'source_column' = v_header
    LIMIT 1;
    INSERT INTO public.file_import_mapping_reviews(
      organization_id, batch_id, source_column, target_entity, target_field, decision
    ) VALUES (
      v_batch.organization_id, v_batch.id, v_header,
      v_mapping->>'target_entity', v_mapping->>'target_field', 'proposed'
    ) ON CONFLICT(batch_id, source_column) DO NOTHING;
  END LOOP;

  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_batch.organization_id, v_actor, 'patrol_import_batch_staging_started', 'file_import_batches', v_batch.id,
    jsonb_build_object('client_organization_id', p_client_organization_id, 'source_profile', p_manifest_json->>'source_profile'));
  RETURN v_batch;
END;
$function$;
REVOKE ALL ON FUNCTION "public"."begin_patrol_import_batch_unvalidated"(p_provider_organization_id uuid, p_client_organization_id uuid, p_batch_name text, p_source_file text, p_source_sha256 text, p_parser text, p_manifest_json jsonb, p_schema_json jsonb, p_row_count integer, p_duplicate_count integer, p_unresolved_count integer) FROM PUBLIC, "anon", "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION "public"."begin_patrol_import_batch_unvalidated"(p_provider_organization_id uuid, p_client_organization_id uuid, p_batch_name text, p_source_file text, p_source_sha256 text, p_parser text, p_manifest_json jsonb, p_schema_json jsonb, p_row_count integer, p_duplicate_count integer, p_unresolved_count integer) TO "postgres";
