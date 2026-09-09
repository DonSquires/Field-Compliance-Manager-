CREATE OR REPLACE FUNCTION public.register_bob_video_attachment_for_review(p_attachment_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  attachment public.bob_attachments%rowtype;
  evidence_id uuid;
  job_id uuid;
BEGIN
  IF auth.role() <> 'service_role' AND session_user <> 'postgres' THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;

  SELECT * INTO attachment
    FROM public.bob_attachments
   WHERE id = p_attachment_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bob attachment not found';
  END IF;
  IF attachment.file_type NOT LIKE 'video/%' THEN
    RAISE EXCEPTION 'Bob attachment is not a video';
  END IF;

  SELECT id INTO evidence_id
    FROM public.evidence_items
   WHERE metadata->>'bob_attachment_id' = attachment.id::text
   LIMIT 1;
  IF evidence_id IS NULL THEN
    INSERT INTO public.evidence_items (
      organization_id,
      module_key,
      evidence_kind,
      storage_path,
      captured_by_user_id,
      metadata
    ) VALUES (
      attachment.organization_id,
      'cctv_review',
      'video',
      attachment.storage_path,
      attachment.uploaded_by,
      jsonb_build_object(
        'bob_attachment_id', attachment.id,
        'bob_conversation_id', attachment.conversation_id,
        'file_name', attachment.file_name,
        'file_type', attachment.file_type,
        'file_size_bytes', attachment.file_size_bytes,
        'storage_bucket', attachment.storage_bucket
      ) || jsonb_strip_nulls(jsonb_build_object(
        'desktop_review_batch', attachment.extraction_payload->'desktop_review_batch'
      ))
    ) RETURNING id INTO evidence_id;
  END IF;

  SELECT id INTO job_id
    FROM public.inference_jobs
   WHERE evidence_item_id = evidence_id
     AND domain = 'video_motion'
   LIMIT 1;
  IF job_id IS NULL THEN
    INSERT INTO public.inference_jobs (
      organization_id,
      evidence_item_id,
      domain,
      status,
      requested_by_user_id
    ) VALUES (
      attachment.organization_id,
      evidence_id,
      'video_motion',
      'queued',
      attachment.uploaded_by
    ) RETURNING id INTO job_id;
  END IF;

  UPDATE public.bob_attachments
     SET purpose = 'video_intake',
         processing_state = 'processing',
         extraction_summary = 'Queued for CCTV motion and risk review.',
         extraction_payload = coalesce(extraction_payload, '{}'::jsonb)
           || jsonb_build_object('evidence_item_id', evidence_id, 'inference_job_id', job_id),
         updated_at = now()
   WHERE id = attachment.id;

  RETURN job_id;
END;
$$;

REVOKE ALL ON FUNCTION public.register_bob_video_attachment_for_review(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_bob_video_attachment_for_review(uuid) TO service_role;
