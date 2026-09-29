-- Reuse immutable CCTV bytes across imports while retaining import-scoped evidence and review context.

CREATE OR REPLACE FUNCTION public.register_cctv_import_video(
  p_import_id uuid, p_storage_path text, p_file_name text, p_file_size_bytes bigint, p_sha256 text DEFAULT NULL,
  p_recorded_start_at timestamptz DEFAULT NULL, p_recorded_end_at timestamptz DEFAULT NULL, p_source_ref text DEFAULT NULL,
  p_content_type text DEFAULT 'video/mp4')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor uuid := auth.uid(); v_import public.cctv_imports%rowtype; v_prefix text; v_media_prefix text; v_ref text; v_evidence uuid; v_job uuid;
BEGIN
  SELECT * INTO v_import FROM public.cctv_imports WHERE id = p_import_id;
  IF v_import.id IS NULL THEN RAISE EXCEPTION 'CCTV import not found'; END IF;
  IF v_actor IS NULL OR NOT public.org_access_allowed(v_import.organization_id) THEN RAISE EXCEPTION 'CCTV import access denied'; END IF;
  v_prefix := 'org/' || v_import.organization_id::text || '/cctv/' || v_import.id::text || '/';
  v_media_prefix := 'org/' || v_import.organization_id::text || '/cctv-media/';
  IF p_storage_path IS NULL OR (position(v_prefix in p_storage_path) <> 1 AND position(v_media_prefix in p_storage_path) <> 1) THEN
    RAISE EXCEPTION 'Video must be stored under the import or content media prefix';
  END IF;
  IF position(v_media_prefix in p_storage_path) = 1 AND (p_sha256 IS NULL OR lower(p_sha256) <> lower(split_part(substr(p_storage_path, length(v_media_prefix) + 1), '/', 1))) THEN
    RAISE EXCEPTION 'Content-addressed video path must match its SHA-256';
  END IF;
  IF coalesce(p_content_type, '') NOT LIKE 'video/%' THEN RAISE EXCEPTION 'Only video files are registered for CCTV review'; END IF;
  v_ref := coalesce(nullif(trim(p_source_ref), ''), nullif(trim(p_file_name), ''), p_storage_path);
  SELECT id INTO v_evidence FROM public.evidence_items WHERE cctv_import_id = v_import.id AND metadata->>'source_ref' = v_ref;
  IF v_evidence IS NULL THEN
    INSERT INTO public.evidence_items (organization_id, module_key, evidence_kind, storage_path, captured_by_user_id, captured_at, sha256_hash, cctv_import_id, metadata)
    VALUES (v_import.organization_id, 'cctv_review', 'video', p_storage_path, v_actor, coalesce(p_recorded_start_at, clock_timestamp()), nullif(lower(trim(p_sha256)), ''), v_import.id,
      jsonb_strip_nulls(jsonb_build_object('file_name', p_file_name, 'file_type', coalesce(p_content_type, 'video/mp4'), 'file_size_bytes', p_file_size_bytes,
        'storage_bucket', 'bob-uploads', 'source_ref', v_ref, 'recorded_start_at', p_recorded_start_at, 'recorded_end_at', p_recorded_end_at,
        'cctv_import_id', v_import.id, 'camera_label', v_import.camera_label, 'camera_key', v_import.camera_key, 'source_device_kind', v_import.source_device_kind,
        'source_timezone', v_import.source_timezone, 'location_id', v_import.location_id, 'canonical_place_id', v_import.canonical_place_id)))
    RETURNING id INTO v_evidence;
  END IF;
  SELECT id INTO v_job FROM public.inference_jobs WHERE evidence_item_id = v_evidence AND domain = 'video_motion' LIMIT 1;
  IF v_job IS NULL THEN
    INSERT INTO public.inference_jobs (organization_id, evidence_item_id, domain, status, requested_by_user_id)
    VALUES (v_import.organization_id, v_evidence, 'video_motion', 'queued', v_actor) RETURNING id INTO v_job;
  END IF;
  UPDATE public.cctv_imports SET status = CASE WHEN status IN ('draft', 'uploading') THEN 'registered' ELSE status END WHERE id = v_import.id;
  RETURN jsonb_build_object('evidence_item_id', v_evidence, 'inference_job_id', v_job, 'source_ref', v_ref);
END $$;

CREATE OR REPLACE FUNCTION public.register_cctv_import_photo(
  p_import_id uuid, p_storage_path text, p_file_name text, p_file_size_bytes bigint, p_sha256 text DEFAULT NULL,
  p_captured_at timestamptz DEFAULT NULL, p_source_ref text DEFAULT NULL, p_content_type text DEFAULT 'image/jpeg',
  p_capture_time_source text DEFAULT 'file_modified_time', p_width integer DEFAULT NULL, p_height integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor uuid := auth.uid(); v_import public.cctv_imports%rowtype; v_prefix text; v_media_prefix text; v_ref text; v_captured_at timestamptz := coalesce(p_captured_at, clock_timestamp()); v_evidence uuid; v_job uuid;
BEGIN
  SELECT * INTO v_import FROM public.cctv_imports WHERE id = p_import_id;
  IF v_import.id IS NULL THEN RAISE EXCEPTION 'CCTV import not found'; END IF;
  IF v_actor IS NULL OR NOT public.org_access_allowed(v_import.organization_id) THEN RAISE EXCEPTION 'CCTV import access denied'; END IF;
  v_prefix := 'org/' || v_import.organization_id::text || '/cctv/' || v_import.id::text || '/';
  v_media_prefix := 'org/' || v_import.organization_id::text || '/cctv-media/';
  IF p_storage_path IS NULL OR (position(v_prefix in p_storage_path) <> 1 AND position(v_media_prefix in p_storage_path) <> 1) THEN
    RAISE EXCEPTION 'Photo must be stored under the import or content media prefix';
  END IF;
  IF position(v_media_prefix in p_storage_path) = 1 AND (p_sha256 IS NULL OR lower(p_sha256) <> lower(split_part(substr(p_storage_path, length(v_media_prefix) + 1), '/', 1))) THEN
    RAISE EXCEPTION 'Content-addressed photo path must match its SHA-256';
  END IF;
  IF coalesce(p_content_type, '') NOT IN ('image/jpeg', 'image/png', 'image/webp', 'image/bmp', 'image/tiff') THEN RAISE EXCEPTION 'Unsupported CCTV photo type'; END IF;
  IF p_file_size_bytes IS NULL OR p_file_size_bytes <= 0 THEN RAISE EXCEPTION 'Photo file size is required'; END IF;
  IF p_capture_time_source NOT IN ('camera_filename', 'camera_index', 'file_metadata', 'file_modified_time', 'operator') THEN RAISE EXCEPTION 'Unknown photo capture-time source'; END IF;
  v_ref := coalesce(nullif(trim(p_source_ref), ''), nullif(trim(p_file_name), ''), p_storage_path);
  SELECT id INTO v_evidence FROM public.evidence_items WHERE cctv_import_id = v_import.id AND evidence_kind = 'photo' AND metadata->>'source_ref' = v_ref;
  IF v_evidence IS NULL THEN
    INSERT INTO public.evidence_items (organization_id, module_key, evidence_kind, storage_path, captured_by_user_id, captured_at, sha256_hash, cctv_import_id, metadata)
    VALUES (v_import.organization_id, 'cctv_review', 'photo', p_storage_path, v_actor, v_captured_at, nullif(lower(trim(p_sha256)), ''), v_import.id,
      jsonb_strip_nulls(jsonb_build_object('file_name', p_file_name, 'file_type', p_content_type, 'file_size_bytes', p_file_size_bytes,
        'storage_bucket', 'bob-uploads', 'source_ref', v_ref, 'recorded_start_at', v_captured_at, 'capture_time_source', p_capture_time_source,
        'width', p_width, 'height', p_height, 'cctv_import_id', v_import.id, 'camera_label', v_import.camera_label, 'camera_key', v_import.camera_key,
        'source_device_kind', v_import.source_device_kind, 'source_timezone', v_import.source_timezone, 'location_id', v_import.location_id,
        'site_id', v_import.site_id, 'zone_id', v_import.zone_id, 'canonical_place_id', v_import.canonical_place_id, 'review_required', true)))
    RETURNING id INTO v_evidence;
  END IF;
  INSERT INTO public.cctv_device_events (cctv_import_id, organization_id, source, source_ref, event_start_at, severity, thumbnail_path, metadata)
  VALUES (v_import.id, v_import.organization_id, 'device_snapshot', v_ref, v_captured_at, 'detection', p_storage_path,
    jsonb_strip_nulls(jsonb_build_object('kind', 'photo_evidence', 'evidence_item_id', v_evidence, 'file_name', p_file_name, 'file_type', p_content_type,
      'file_size_bytes', p_file_size_bytes, 'sha256', p_sha256, 'capture_time_source', p_capture_time_source, 'width', p_width, 'height', p_height, 'review_required', true)))
  ON CONFLICT (cctv_import_id, source, source_ref) DO UPDATE SET event_start_at = EXCLUDED.event_start_at, severity = EXCLUDED.severity, thumbnail_path = EXCLUDED.thumbnail_path, metadata = public.cctv_device_events.metadata || EXCLUDED.metadata;
  SELECT id INTO v_job FROM public.inference_jobs WHERE evidence_item_id = v_evidence AND domain = 'video_motion' LIMIT 1;
  IF v_job IS NULL THEN
    INSERT INTO public.inference_jobs (organization_id, evidence_item_id, domain, status, stage, progress_label, requested_by_user_id)
    VALUES (v_import.organization_id, v_evidence, 'video_motion', 'queued', 'queued', 'Photo queued for face and plate review', v_actor) RETURNING id INTO v_job;
  END IF;
  UPDATE public.cctv_imports SET status = CASE WHEN status IN ('draft', 'uploading') THEN 'registered' ELSE status END WHERE id = v_import.id;
  RETURN jsonb_build_object('evidence_item_id', v_evidence, 'inference_job_id', v_job, 'source_ref', v_ref);
END $$;

REVOKE ALL ON FUNCTION public.register_cctv_import_video(uuid,text,text,bigint,text,timestamptz,timestamptz,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_cctv_import_video(uuid,text,text,bigint,text,timestamptz,timestamptz,text,text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.register_cctv_import_photo(uuid,text,text,bigint,text,timestamptz,text,text,text,integer,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_cctv_import_photo(uuid,text,text,bigint,text,timestamptz,text,text,text,integer,integer) TO authenticated, service_role;
