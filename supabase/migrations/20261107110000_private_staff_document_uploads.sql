ALTER TABLE public.staff_documents
  ADD COLUMN IF NOT EXISTS client_request_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS staff_documents_client_request_uidx
  ON public.staff_documents (organization_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.staff_documents
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.staff_documents TO authenticated;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'staff-documents',
  'staff-documents',
  false,
  10485760,
  ARRAY[
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
    'text/plain',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS staff_documents_private_select ON storage.objects;
CREATE POLICY staff_documents_private_select
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'staff-documents'
  AND EXISTS (
    SELECT 1
    FROM public.staff_documents document
    WHERE document.storage_path = storage.objects.name
      AND public.is_admin_for_org(document.organization_id)
  )
);

DROP POLICY IF EXISTS staff_documents_private_insert ON storage.objects;
CREATE POLICY staff_documents_private_insert
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'staff-documents'
  AND array_length(storage.foldername(name), 1) = 4
  AND (storage.foldername(name))[2] = 'staff'
  AND (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND EXISTS (
    SELECT 1
    FROM public.staff_profiles staff
    WHERE staff.id::text = (storage.foldername(name))[3]
      AND staff.organization_id::text = (storage.foldername(name))[1]
      AND public.is_admin_for_org(staff.organization_id)
  )
);

DROP POLICY IF EXISTS staff_documents_private_delete_orphan ON storage.objects;
CREATE POLICY staff_documents_private_delete_orphan
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'staff-documents'
  AND EXISTS (
    SELECT 1
    FROM public.staff_profiles staff
    WHERE staff.id::text = (storage.foldername(name))[3]
      AND staff.organization_id::text = (storage.foldername(name))[1]
      AND public.is_admin_for_org(staff.organization_id)
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.staff_documents document
    WHERE document.storage_path = storage.objects.name
  )
);

CREATE OR REPLACE FUNCTION public.record_staff_document_upload(
  p_client_request_id uuid,
  p_staff_id uuid,
  p_document_type text,
  p_file_name text,
  p_storage_path text,
  p_description text DEFAULT NULL,
  p_expiry_date date DEFAULT NULL
)
RETURNS public.staff_documents
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_staff public.staff_profiles%rowtype;
  v_document public.staff_documents%rowtype;
  v_size bigint;
  v_mime text;
  v_prefix text;
  v_file_name text := nullif(btrim(coalesce(p_file_name, '')), '');
  v_description text := nullif(btrim(coalesce(p_description, '')), '');
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'Client request ID is required';
  END IF;

  SELECT staff.*
  INTO v_staff
  FROM public.staff_profiles staff
  WHERE staff.id = p_staff_id
  FOR UPDATE;

  IF NOT FOUND OR NOT public.is_admin_for_org(v_staff.organization_id) THEN
    RAISE EXCEPTION 'Active organisation HR administrator required';
  END IF;
  IF p_document_type IS NULL
     OR p_document_type NOT IN ('credential_evidence', 'contract', 'certificate', 'policy_acknowledgement', 'other') THEN
    RAISE EXCEPTION 'Unsupported staff document type';
  END IF;
  IF v_file_name IS NULL
     OR length(v_file_name) > 255
     OR v_file_name ~ '[/\\]'
     OR p_storage_path IS NULL THEN
    RAISE EXCEPTION 'A valid file name and private storage path are required';
  END IF;
  IF v_description IS NOT NULL AND length(v_description) > 500 THEN
    RAISE EXCEPTION 'Document description must be 500 characters or fewer';
  END IF;
  v_prefix := v_staff.organization_id::text || '/staff/' || v_staff.id::text || '/' || p_client_request_id::text || '/';
  IF left(p_storage_path, length(v_prefix)) <> v_prefix
     OR right(p_storage_path, length(v_file_name)) <> v_file_name THEN
    RAISE EXCEPTION 'Document path does not match the organisation, staff member, and upload request';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_client_request_id::text, 0));

  SELECT document.*
  INTO v_document
  FROM public.staff_documents document
  WHERE document.organization_id = v_staff.organization_id
    AND document.client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_document.staff_id <> v_staff.id
       OR v_document.storage_path <> p_storage_path
       OR v_document.document_type <> p_document_type THEN
      RAISE EXCEPTION 'Document request ID has already been used for another upload';
    END IF;
    RETURN v_document;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.staff_documents document
    WHERE document.client_request_id = p_client_request_id
  ) THEN
    RAISE EXCEPTION 'Document request ID has already been used by another organisation';
  END IF;

  SELECT
    nullif(uploaded_object.metadata ->> 'size', '')::bigint,
    nullif(uploaded_object.metadata ->> 'mimetype', '')
  INTO v_size, v_mime
  FROM storage.objects uploaded_object
  WHERE uploaded_object.bucket_id = 'staff-documents'
    AND uploaded_object.name = p_storage_path;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Uploaded document was not found in private storage';
  END IF;
  IF v_size IS NULL OR v_size < 1 OR v_size > 10485760 THEN
    RAISE EXCEPTION 'Staff document must be between 1 byte and 10 MB';
  END IF;
  IF v_mime IS NULL OR v_mime NOT IN (
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
    'text/plain',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) THEN
    RAISE EXCEPTION 'Unsupported staff document media type';
  END IF;

  INSERT INTO public.staff_documents (
    staff_id,
    organization_id,
    document_type,
    file_name,
    storage_path,
    file_size_bytes,
    mime_type,
    description,
    uploaded_by,
    expiry_date,
    client_request_id
  ) VALUES (
    v_staff.id,
    v_staff.organization_id,
    p_document_type,
    v_file_name,
    p_storage_path,
    v_size,
    v_mime,
    v_description,
    v_actor,
    p_expiry_date,
    p_client_request_id
  )
  RETURNING * INTO v_document;

  INSERT INTO public.audit_log (
    organization_id, actor_user_id, action, target_table, target_id, metadata
  ) VALUES (
    v_staff.organization_id,
    v_actor,
    'staff_document_uploaded',
    'staff_documents',
    v_document.id,
    jsonb_build_object(
      'staff_id', v_staff.id,
      'document_type', v_document.document_type,
      'file_name', v_document.file_name,
      'file_size_bytes', v_document.file_size_bytes,
      'mime_type', v_document.mime_type,
      'client_request_id', p_client_request_id
    )
  );

  RETURN v_document;
END;
$$;

REVOKE ALL ON FUNCTION public.record_staff_document_upload(uuid, uuid, text, text, text, text, date)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_staff_document_upload(uuid, uuid, text, text, text, text, date)
  TO authenticated, service_role;
