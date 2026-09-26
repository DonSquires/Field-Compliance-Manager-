-- First-class CCTV stills: immutable photo evidence, a dated timeline event, and the same
-- laptop-first visual-analysis queue used by video. Recognition remains provisional and review-required.

CREATE OR REPLACE FUNCTION public.register_cctv_import_photo(
  p_import_id uuid,
  p_storage_path text,
  p_file_name text,
  p_file_size_bytes bigint,
  p_sha256 text DEFAULT NULL,
  p_captured_at timestamptz DEFAULT NULL,
  p_source_ref text DEFAULT NULL,
  p_content_type text DEFAULT 'image/jpeg',
  p_capture_time_source text DEFAULT 'file_modified_time',
  p_width integer DEFAULT NULL,
  p_height integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_import public.cctv_imports%rowtype;
  v_prefix text;
  v_ref text;
  v_captured_at timestamptz := coalesce(p_captured_at, clock_timestamp());
  v_evidence uuid;
  v_job uuid;
BEGIN
  SELECT * INTO v_import FROM public.cctv_imports WHERE id = p_import_id;
  IF v_import.id IS NULL THEN RAISE EXCEPTION 'CCTV import not found'; END IF;
  IF v_actor IS NULL OR NOT public.org_access_allowed(v_import.organization_id) THEN RAISE EXCEPTION 'CCTV import access denied'; END IF;
  v_prefix := 'org/' || v_import.organization_id::text || '/cctv/' || v_import.id::text || '/';
  IF p_storage_path IS NULL OR position(v_prefix in p_storage_path) <> 1 THEN RAISE EXCEPTION 'Photo must be stored under %', v_prefix; END IF;
  IF coalesce(p_content_type, '') NOT IN ('image/jpeg', 'image/png', 'image/webp', 'image/bmp', 'image/tiff') THEN RAISE EXCEPTION 'Unsupported CCTV photo type'; END IF;
  IF p_file_size_bytes IS NULL OR p_file_size_bytes <= 0 THEN RAISE EXCEPTION 'Photo file size is required'; END IF;
  IF p_sha256 IS NOT NULL AND p_sha256 !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Photo SHA-256 must be lowercase hexadecimal'; END IF;
  IF p_capture_time_source NOT IN ('camera_filename', 'camera_index', 'file_metadata', 'file_modified_time', 'operator') THEN RAISE EXCEPTION 'Unknown photo capture-time source'; END IF;
  v_ref := coalesce(nullif(trim(p_source_ref), ''), nullif(trim(p_file_name), ''), p_storage_path);

  SELECT id INTO v_evidence FROM public.evidence_items
  WHERE cctv_import_id = v_import.id AND evidence_kind = 'photo' AND metadata->>'source_ref' = v_ref;
  IF v_evidence IS NULL THEN
    INSERT INTO public.evidence_items (organization_id, module_key, evidence_kind, storage_path, captured_by_user_id, captured_at, sha256_hash, cctv_import_id, metadata)
    VALUES (v_import.organization_id, 'cctv_review', 'photo', p_storage_path, v_actor, v_captured_at, nullif(trim(p_sha256), ''), v_import.id,
      jsonb_strip_nulls(jsonb_build_object(
        'file_name', p_file_name, 'file_type', p_content_type, 'file_size_bytes', p_file_size_bytes,
        'storage_bucket', 'bob-uploads', 'source_ref', v_ref, 'recorded_start_at', v_captured_at,
        'capture_time_source', p_capture_time_source, 'width', p_width, 'height', p_height,
        'cctv_import_id', v_import.id, 'camera_label', v_import.camera_label, 'camera_key', v_import.camera_key,
        'source_device_kind', v_import.source_device_kind, 'source_timezone', v_import.source_timezone,
        'location_id', v_import.location_id, 'site_id', v_import.site_id, 'zone_id', v_import.zone_id,
        'canonical_place_id', v_import.canonical_place_id, 'review_required', true)))
    RETURNING id INTO v_evidence;
  END IF;

  INSERT INTO public.cctv_device_events (cctv_import_id, organization_id, source, source_ref, event_start_at, severity, thumbnail_path, metadata)
  VALUES (v_import.id, v_import.organization_id, 'device_snapshot', v_ref, v_captured_at, 'detection', p_storage_path,
    jsonb_strip_nulls(jsonb_build_object('kind', 'photo_evidence', 'evidence_item_id', v_evidence, 'file_name', p_file_name,
      'file_type', p_content_type, 'file_size_bytes', p_file_size_bytes, 'sha256', p_sha256,
      'capture_time_source', p_capture_time_source, 'width', p_width, 'height', p_height, 'review_required', true)))
  ON CONFLICT (cctv_import_id, source, source_ref) DO UPDATE SET
    event_start_at = EXCLUDED.event_start_at,
    severity = EXCLUDED.severity,
    thumbnail_path = EXCLUDED.thumbnail_path,
    metadata = public.cctv_device_events.metadata || EXCLUDED.metadata;

  SELECT id INTO v_job FROM public.inference_jobs WHERE evidence_item_id = v_evidence AND domain = 'video_motion' LIMIT 1;
  IF v_job IS NULL THEN
    INSERT INTO public.inference_jobs (organization_id, evidence_item_id, domain, status, stage, progress_label, requested_by_user_id)
    VALUES (v_import.organization_id, v_evidence, 'video_motion', 'queued', 'queued', 'Photo queued for face and plate review', v_actor)
    RETURNING id INTO v_job;
  END IF;

  UPDATE public.cctv_imports SET status = CASE WHEN status IN ('draft', 'uploading') THEN 'registered' ELSE status END WHERE id = v_import.id;
  RETURN jsonb_build_object('evidence_item_id', v_evidence, 'inference_job_id', v_job, 'source_ref', v_ref);
END;
$$;

REVOKE ALL ON FUNCTION public.register_cctv_import_photo(uuid,text,text,bigint,text,timestamptz,text,text,text,integer,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_cctv_import_photo(uuid,text,text,bigint,text,timestamptz,text,text,text,integer,integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.complete_cctv_still_inference(
  p_job_id uuid,
  p_evidence_id uuid,
  p_org_id uuid,
  p_result jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result_id uuid;
  v_import_id uuid;
BEGIN
  IF auth.role() <> 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin') THEN RAISE EXCEPTION 'Service identity required'; END IF;
  IF jsonb_typeof(p_result) <> 'object' THEN RAISE EXCEPTION 'Still inference result must be an object'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.inference_jobs
    WHERE id = p_job_id AND evidence_item_id = p_evidence_id AND organization_id = p_org_id
      AND domain = 'video_motion' AND status = 'processing'
  ) THEN RAISE EXCEPTION 'CCTV still inference job is missing, mismatched, or not processing'; END IF;
  SELECT cctv_import_id INTO v_import_id FROM public.evidence_items
  WHERE id = p_evidence_id AND organization_id = p_org_id AND evidence_kind = 'photo';
  IF NOT FOUND THEN RAISE EXCEPTION 'Photo evidence is missing or belongs to another organization'; END IF;

  INSERT INTO public.inference_results (inference_job_id, evidence_item_id, domain, status, result)
  VALUES (p_job_id, p_evidence_id, 'video_motion', 'complete', p_result)
  RETURNING id INTO v_result_id;

  UPDATE public.inference_jobs SET status = 'complete', stage = 'complete', progress_percent = 100,
    progress_label = 'Photo analysis ready for review', completed_at = clock_timestamp(),
    lease_token = NULL, lease_expires_at = NULL, heartbeat_at = NULL
  WHERE id = p_job_id AND status = 'processing';
  IF NOT FOUND THEN RAISE EXCEPTION 'CCTV still inference job changed before completion'; END IF;

  IF v_import_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.evidence_items item
    JOIN public.inference_jobs job ON job.evidence_item_id = item.id
    WHERE item.cctv_import_id = v_import_id AND job.domain = 'video_motion'
      AND job.status NOT IN ('complete', 'inconclusive', 'manual_review_required')
  ) THEN
    UPDATE public.cctv_imports SET status = 'review_ready', updated_at = clock_timestamp()
    WHERE id = v_import_id AND status IN ('registered', 'processing');
  END IF;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (p_org_id, NULL, 'cctv_still_inference_completed', 'inference_jobs', p_job_id,
    jsonb_build_object('evidence_item_id', p_evidence_id, 'review_required', true));
  RETURN v_result_id;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_cctv_still_inference(uuid,uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_cctv_still_inference(uuid,uuid,uuid,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.set_cctv_import_manifest(p_import_id uuid, p_manifest jsonb, p_status text DEFAULT NULL)
RETURNS public.cctv_imports LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor uuid := auth.uid(); v_row public.cctv_imports%rowtype;
BEGIN
  SELECT * INTO v_row FROM public.cctv_imports WHERE id = p_import_id FOR UPDATE;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'CCTV import not found'; END IF;
  IF v_actor IS NULL OR NOT public.org_access_allowed(v_row.organization_id) THEN RAISE EXCEPTION 'CCTV import access denied'; END IF;
  IF jsonb_typeof(p_manifest) <> 'array' THEN RAISE EXCEPTION 'Manifest must be an array'; END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('draft', 'uploading', 'registered', 'processing', 'review_ready', 'archived', 'failed') THEN RAISE EXCEPTION 'Unknown import status %', p_status; END IF;
  UPDATE public.cctv_imports SET
    source_manifest = p_manifest,
    video_count = (SELECT count(*) FROM jsonb_array_elements(p_manifest) item WHERE item->>'kind' = 'video'),
    skipped_count = (SELECT count(*) FROM jsonb_array_elements(p_manifest) item WHERE item->>'kind' = 'skipped_empty'),
    snapshot_count = (SELECT count(*) FROM jsonb_array_elements(p_manifest) item WHERE item->>'kind' IN ('snapshot', 'photo')),
    bytes_total = (SELECT coalesce(sum((item->>'size_bytes')::bigint), 0) FROM jsonb_array_elements(p_manifest) item WHERE item->>'kind' IN ('video', 'snapshot', 'photo')),
    recorded_from = (SELECT min((item->>'slot_start_at')::timestamptz) FROM jsonb_array_elements(p_manifest) item WHERE item->>'kind' IN ('video', 'snapshot', 'photo') AND nullif(item->>'slot_start_at', '') IS NOT NULL),
    recorded_to = (SELECT max(coalesce((item->>'slot_end_at')::timestamptz, (item->>'slot_start_at')::timestamptz)) FROM jsonb_array_elements(p_manifest) item WHERE item->>'kind' IN ('video', 'snapshot', 'photo') AND nullif(item->>'slot_start_at', '') IS NOT NULL),
    status = coalesce(p_status, status)
  WHERE id = p_import_id RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.set_cctv_import_manifest(uuid,jsonb,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_cctv_import_manifest(uuid,jsonb,text) TO authenticated, service_role;

COMMENT ON FUNCTION public.register_cctv_import_photo(uuid,text,text,bigint,text,timestamptz,text,text,text,integer,integer) IS
  'Registers an immutable CCTV photo as evidence and a dated timeline event, then queues laptop-first face/ALPR review.';
COMMENT ON FUNCTION public.complete_cctv_still_inference(uuid,uuid,uuid,jsonb) IS
  'Service-only completion for one CCTV photo. Recognition is provisional and review-required.';