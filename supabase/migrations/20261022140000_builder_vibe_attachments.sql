-- Vibe attachments are owner/session-scoped private context, not business records.
CREATE TABLE IF NOT EXISTS public.builder_vibe_attachments (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES public.builder_vibe_sessions(id) ON DELETE CASCADE,
  uploaded_by uuid NOT NULL REFERENCES public.user_profiles(id),
  file_name text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
  file_type text NOT NULL CHECK (file_type IN (
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
    'text/csv',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  )),
  file_size_bytes bigint NOT NULL CHECK (file_size_bytes > 0 AND file_size_bytes <= 20971520),
  storage_bucket text NOT NULL DEFAULT 'bob-uploads' CHECK (storage_bucket = 'bob-uploads'),
  storage_path text NOT NULL UNIQUE,
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  extracted_text text NOT NULL DEFAULT '',
  extraction_status text NOT NULL DEFAULT 'not_applicable'
    CHECK (extraction_status IN ('not_applicable', 'pending', 'extracted', 'empty', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS builder_vibe_attachments_session_idx
  ON public.builder_vibe_attachments (session_id, created_at);

ALTER TABLE public.builder_vibe_attachments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.builder_vibe_attachments FROM anon, authenticated;
GRANT SELECT ON public.builder_vibe_attachments TO authenticated;
GRANT ALL ON public.builder_vibe_attachments TO service_role;

CREATE POLICY builder_vibe_attachments_owner_read ON public.builder_vibe_attachments
  FOR SELECT TO authenticated
  USING (
    public.is_grand_master()
    AND EXISTS (
      SELECT 1 FROM public.builder_vibe_sessions s
      WHERE s.id = builder_vibe_attachments.session_id
        AND s.created_by = auth.uid()
    )
  );

CREATE OR REPLACE FUNCTION public.builder_vibe_attachment_register(
  p_session_id uuid,
  p_attachment_id uuid,
  p_file_name text,
  p_file_type text,
  p_file_size_bytes bigint,
  p_storage_path text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := public.builder_vibe_require_owner();
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.builder_vibe_sessions
    WHERE id = p_session_id AND created_by = v_user AND status <> 'closed'
  ) THEN
    RAISE EXCEPTION 'Vibe session not found or closed';
  END IF;
  IF p_file_name IS NULL OR char_length(p_file_name) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'Attachment filename is invalid';
  END IF;
  IF p_file_type NOT IN (
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
    'text/csv',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) THEN
    RAISE EXCEPTION 'Attachment type is not supported';
  END IF;
  IF p_file_size_bytes IS NULL OR p_file_size_bytes <= 0 OR p_file_size_bytes > 20971520 THEN
    RAISE EXCEPTION 'Attachment exceeds the 20 MB Vibe limit';
  END IF;
  IF p_file_type LIKE 'image/%' AND p_file_size_bytes > 10485760 THEN
    RAISE EXCEPTION 'Vibe images must not exceed 10 MB';
  END IF;
  IF p_storage_path !~ (
    '^desktop/' || v_user::text || '/vibe/' || p_session_id::text || '/'
    || p_attachment_id::text || '-[A-Za-z0-9._-]{1,180}$'
  ) THEN
    RAISE EXCEPTION 'Attachment is outside this Vibe session storage path';
  END IF;
  INSERT INTO public.builder_vibe_attachments (
    id, session_id, uploaded_by, file_name, file_type, file_size_bytes,
    storage_bucket, storage_path, extraction_status
  ) VALUES (
    p_attachment_id, p_session_id, v_user, p_file_name, p_file_type, p_file_size_bytes,
    'bob-uploads', p_storage_path,
    CASE WHEN p_file_type LIKE 'image/%' THEN 'not_applicable' ELSE 'pending' END
  );
  RETURN p_attachment_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.builder_vibe_attachment_set_extraction(
  p_session_id uuid,
  p_attachment_id uuid,
  p_extracted_text text,
  p_sha256 text,
  p_extraction_status text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := public.builder_vibe_require_owner();
BEGIN
  IF p_extraction_status NOT IN ('extracted', 'empty', 'failed')
     OR char_length(coalesce(p_extracted_text, '')) > 200000
     OR (p_sha256 IS NOT NULL AND p_sha256 !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'Attachment extraction result is invalid';
  END IF;
  UPDATE public.builder_vibe_attachments a
     SET extracted_text = coalesce(p_extracted_text, ''),
         sha256 = p_sha256,
         extraction_status = p_extraction_status
    FROM public.builder_vibe_sessions s
   WHERE a.id = p_attachment_id
     AND a.session_id = p_session_id
     AND a.file_type NOT LIKE 'image/%'
     AND a.session_id = s.id
     AND s.created_by = v_user
     AND s.status <> 'closed';
  IF NOT FOUND THEN RAISE EXCEPTION 'Document attachment not found for this open Vibe session'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.builder_vibe_attachment_delete(
  p_session_id uuid,
  p_attachment_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := public.builder_vibe_require_owner();
BEGIN
  DELETE FROM public.builder_vibe_attachments a
   USING public.builder_vibe_sessions s
   WHERE a.id = p_attachment_id
     AND a.session_id = p_session_id
     AND s.id = a.session_id
     AND s.created_by = v_user
     AND s.status <> 'closed';
  IF NOT FOUND THEN RAISE EXCEPTION 'Attachment not found for this open Vibe session'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.builder_vibe_send_with_attachments(
  p_session_id uuid,
  p_content text,
  p_client_request_id text,
  p_attachment_ids uuid[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := public.builder_vibe_require_owner();
  v_ids uuid[] := coalesce(p_attachment_ids, '{}'::uuid[]);
  v_message_id uuid;
  v_payload jsonb;
BEGIN
  IF cardinality(v_ids) > 5 OR cardinality(v_ids) <> (SELECT count(DISTINCT id)::integer FROM unnest(v_ids) AS requested(id)) THEN
    RAISE EXCEPTION 'A message may contain up to five unique attachments';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM unnest(v_ids) AS requested(id)
    LEFT JOIN public.builder_vibe_attachments a
      ON a.id = requested.id AND a.session_id = p_session_id AND a.uploaded_by = v_user
    WHERE a.id IS NULL
       OR (a.file_type NOT LIKE 'image/%' AND a.extraction_status NOT IN ('extracted', 'empty'))
  ) THEN
    RAISE EXCEPTION 'One or more attachments are unavailable or not ready';
  END IF;

  v_message_id := public.builder_vibe_send(p_session_id, p_content, p_client_request_id, 'message');
  SELECT payload INTO v_payload
  FROM public.builder_vibe_messages
  WHERE id = v_message_id AND session_id = p_session_id AND created_by = v_user
  FOR UPDATE;
  IF v_payload IS NULL THEN RAISE EXCEPTION 'Vibe message could not be associated with this owner'; END IF;
  IF v_payload ? 'attachment_ids'
     AND v_payload->'attachment_ids' <> to_jsonb(v_ids) THEN
    RAISE EXCEPTION 'Request id was already used with different attachments';
  END IF;

  UPDATE public.builder_vibe_messages m
     SET payload = v_payload || jsonb_build_object(
       'attachment_ids', to_jsonb(v_ids),
       'attachments', coalesce((
         SELECT jsonb_agg(jsonb_build_object(
           'id', a.id,
           'file_name', a.file_name,
           'file_type', a.file_type,
           'file_size_bytes', a.file_size_bytes,
           'extraction_status', a.extraction_status
         ) ORDER BY a.created_at)
         FROM public.builder_vibe_attachments a
         WHERE a.session_id = p_session_id AND a.id = ANY(v_ids)
       ), '[]'::jsonb)
     )
   WHERE m.id = v_message_id;
  RETURN v_message_id;
END;
$$;

REVOKE ALL ON FUNCTION public.builder_vibe_attachment_register(uuid, uuid, text, text, bigint, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.builder_vibe_attachment_set_extraction(uuid, uuid, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.builder_vibe_attachment_delete(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.builder_vibe_send_with_attachments(uuid, text, text, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.builder_vibe_attachment_register(uuid, uuid, text, text, bigint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.builder_vibe_attachment_set_extraction(uuid, uuid, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.builder_vibe_attachment_delete(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.builder_vibe_send_with_attachments(uuid, text, text, uuid[]) TO authenticated;
