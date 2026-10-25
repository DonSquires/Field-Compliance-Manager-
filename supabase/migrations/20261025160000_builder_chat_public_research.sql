-- Explicit owner-approved public research, isolated from repository/history context.
CREATE OR REPLACE FUNCTION public.builder_chat_send_research(
  p_thread_id uuid,
  p_content text,
  p_client_request_id text,
  p_files jsonb DEFAULT '[]'::jsonb,
  p_urls jsonb DEFAULT '[]'::jsonb,
  p_web_search boolean DEFAULT false,
  p_allow_cloud boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := public.builder_chat_require_owner();
  v_id uuid;
  v_existing public.builder_chat_messages%ROWTYPE;
  v_file jsonb;
  v_url jsonb;
  v_payload jsonb;
  v_prefix text;
  v_size bigint;
BEGIN
  IF p_allow_cloud IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Public cloud research requires explicit non-sensitive-content approval';
  END IF;
  IF p_client_request_id IS NULL OR char_length(p_client_request_id) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'Research requires a request id of 1 to 80 characters';
  END IF;
  IF p_content IS NULL OR char_length(btrim(p_content)) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'Research question must be 1 to 2000 characters';
  END IF;
  IF jsonb_typeof(p_files) IS DISTINCT FROM 'array' OR jsonb_array_length(p_files) > 5
     OR jsonb_typeof(p_urls) IS DISTINCT FROM 'array' OR jsonb_array_length(p_urls) > 6
     OR octet_length(p_files::text) > 100000 THEN
    RAISE EXCEPTION 'Research accepts five files, six URLs and bounded extracted text';
  END IF;
  PERFORM 1 FROM public.builder_chat_threads
   WHERE id = p_thread_id AND created_by = v_user AND status <> 'closed' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Open Builder chat not found for this owner'; END IF;

  SELECT * INTO v_existing FROM public.builder_chat_messages
   WHERE thread_id = p_thread_id AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_existing.created_by IS DISTINCT FROM v_user OR v_existing.content IS DISTINCT FROM btrim(p_content)
       OR v_existing.payload->>'research_mode' IS DISTINCT FROM 'public_cloud'
       OR v_existing.payload->'research_files' IS DISTINCT FROM p_files
       OR v_existing.payload->'research_urls' IS DISTINCT FROM p_urls
       OR v_existing.payload->'web_search' IS DISTINCT FROM to_jsonb(coalesce(p_web_search, false)) THEN
      RAISE EXCEPTION 'Request id was already used with different research or consent';
    END IF;
    RETURN v_existing.id;
  END IF;
  IF (SELECT count(DISTINCT f->>'id') FROM jsonb_array_elements(p_files) f) <> jsonb_array_length(p_files) THEN
    RAISE EXCEPTION 'Research attachments must have unique ids';
  END IF;
  FOR v_file IN SELECT value FROM jsonb_array_elements(p_files) LOOP
    IF jsonb_typeof(v_file) <> 'object'
       OR coalesce(v_file->>'id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR coalesce(v_file->>'sha256', '') !~ '^[0-9a-f]{64}$'
       OR char_length(coalesce(v_file->>'file_name', '')) NOT BETWEEN 1 AND 255
       OR coalesce(v_file->>'file_type', '') NOT IN (
         'image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/plain', 'text/csv',
         'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
         'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
       ) OR char_length(coalesce(v_file->>'extracted_text', '')) > 12000 THEN
      RAISE EXCEPTION 'Invalid research attachment metadata';
    END IF;
    v_size := (v_file->>'file_size_bytes')::bigint;
    IF v_size IS NULL OR v_size <= 0 OR v_size > 20971520
       OR (v_file->>'file_type' LIKE 'image/%' AND v_size > 10485760)
       OR (v_file->>'file_type' NOT LIKE 'image/%' AND btrim(coalesce(v_file->>'extracted_text', '')) = '') THEN
      RAISE EXCEPTION 'Research file is too large or has no readable document text';
    END IF;
    v_prefix := 'desktop/' || v_user::text || '/builder-chat/' || p_thread_id::text || '/' || (v_file->>'id') || '-';
    IF v_file->>'storage_path' IS NULL OR left(v_file->>'storage_path', length(v_prefix)) <> v_prefix
       OR substring(v_file->>'storage_path' FROM length(v_prefix) + 1) !~ '^[A-Za-z0-9._-]{1,180}$'
       OR NOT EXISTS (
         SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'bob-uploads'
           AND o.name = v_file->>'storage_path' AND o.owner_id = v_user::text
       ) THEN
      RAISE EXCEPTION 'Research file is not owned by this chat owner';
    END IF;
  END LOOP;
  FOR v_url IN SELECT value FROM jsonb_array_elements(p_urls) LOOP
    IF jsonb_typeof(v_url) <> 'string' OR char_length(v_url #>> '{}') > 1000
       OR (v_url #>> '{}') !~ '^https://[^/?#@]+/[^?#]*$' THEN
      RAISE EXCEPTION 'Research URLs must be public HTTPS without query strings or credentials';
    END IF;
  END LOOP;
  v_payload := jsonb_build_object(
    'research_mode', 'public_cloud', 'research_files', p_files, 'research_urls', p_urls,
    'web_search', coalesce(p_web_search, false),
    'research_consent', jsonb_build_object(
      'allowed', true, 'policy_version', 'builder_research_v1',
      'actor_user_id', v_user, 'recorded_at', now(),
      'attachment_ids', (SELECT coalesce(jsonb_agg(f->>'id'), '[]'::jsonb) FROM jsonb_array_elements(p_files) f),
      'raw_images_allowed', true, 'raw_documents_allowed_if_supported', true
    )
  );
  INSERT INTO public.builder_chat_messages(thread_id, role, kind, content, payload, status, client_request_id, created_by)
  VALUES (p_thread_id, 'owner', 'message', btrim(p_content), v_payload, 'queued', p_client_request_id, v_user)
  RETURNING id INTO v_id;
  UPDATE public.builder_chat_threads SET last_activity_at = now(), updated_at = now() WHERE id = p_thread_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.builder_chat_send_research(uuid, text, text, jsonb, jsonb, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.builder_chat_send_research(uuid, text, text, jsonb, jsonb, boolean, boolean) TO authenticated;

COMMENT ON FUNCTION public.builder_chat_send_research(uuid, text, text, jsonb, jsonb, boolean, boolean) IS
  'Explicit per-message owner attestation for isolated Ollama Cloud research. No earlier history, private repository source, credentials or tenant records are included. Raw images require verified vision support; documents use extracted text until native document support is verified.';
