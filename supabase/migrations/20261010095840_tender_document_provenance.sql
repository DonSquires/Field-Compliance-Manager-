BEGIN;

ALTER TABLE public.tender_documents
  ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS source_document_id uuid REFERENCES public.documents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_sha256 text,
  ADD COLUMN IF NOT EXISTS source_reference text,
  ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'unreviewed',
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;

UPDATE public.tender_documents td
SET organization_id = t.organization_id
FROM public.tenders t
WHERE t.id = td.tender_id
  AND td.organization_id IS NULL;

ALTER TABLE public.tender_documents
  ALTER COLUMN organization_id SET NOT NULL;

ALTER TABLE public.tender_documents
  DROP CONSTRAINT IF EXISTS tender_documents_review_status_check;

ALTER TABLE public.tender_documents
  ADD CONSTRAINT tender_documents_review_status_check
  CHECK (review_status IN ('unreviewed', 'accepted', 'rejected'));

CREATE INDEX IF NOT EXISTS tender_documents_org_review
  ON public.tender_documents (organization_id, review_status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS tender_documents_source_hash_unique
  ON public.tender_documents (organization_id, tender_id, source_sha256)
  WHERE source_sha256 IS NOT NULL;

CREATE OR REPLACE FUNCTION public.attach_tender_document(
  p_tender_id uuid,
  p_document_name text,
  p_document_type text,
  p_storage_path text,
  p_source_sha256 text DEFAULT NULL,
  p_source_reference text DEFAULT NULL,
  p_source_document_id uuid DEFAULT NULL
) RETURNS public.tender_documents
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_tender public.tenders%rowtype;
  v_document public.tender_documents%rowtype;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF nullif(trim(coalesce(p_document_name, '')), '') IS NULL
     OR nullif(trim(coalesce(p_storage_path, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Document name and storage path are required';
  END IF;
  IF p_storage_path ~ '(^|/)\.\.(/|$)' OR p_storage_path LIKE '/%' OR p_storage_path ~ '^[A-Za-z]:[\\/]' THEN
    RAISE EXCEPTION 'Storage path must be a tenant-relative object path';
  END IF;
  SELECT * INTO STRICT v_tender
  FROM public.tenders
  WHERE id = p_tender_id
  FOR SHARE;
  IF NOT public.is_admin_for_org(v_tender.organization_id) THEN
    RAISE EXCEPTION 'Tender document attachment denied';
  END IF;
  IF p_source_document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.documents d
    WHERE d.id = p_source_document_id
      AND (d.organization_id = v_tender.organization_id OR d.organization_id IS NULL)
  ) THEN
    RAISE EXCEPTION 'Source document is outside the tender organisation';
  END IF;
  INSERT INTO public.tender_documents(
    tender_id, organization_id, document_name, document_type, storage_path,
    source_document_id, source_sha256, source_reference, uploaded_by
  ) VALUES (
    v_tender.id, v_tender.organization_id, trim(p_document_name), nullif(trim(coalesce(p_document_type, '')), ''),
    trim(p_storage_path), p_source_document_id, nullif(trim(coalesce(p_source_sha256, '')), ''),
    nullif(trim(coalesce(p_source_reference, '')), ''), v_actor
  )
  ON CONFLICT (organization_id, tender_id, source_sha256)
  WHERE source_sha256 IS NOT NULL
  DO UPDATE SET document_name = public.tender_documents.document_name
  RETURNING * INTO v_document;
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (
    v_tender.organization_id, v_actor, 'tender_document_attached', 'tender_documents', v_document.id,
    jsonb_build_object(
      'tender_id', v_tender.id, 'document_name', v_document.document_name,
      'source_sha256', v_document.source_sha256, 'source_reference', v_document.source_reference,
      'review_status', v_document.review_status
    )
  );
  RETURN v_document;
END;
$function$;

REVOKE ALL ON FUNCTION public.attach_tender_document(uuid, text, text, text, text, text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.attach_tender_document(uuid, text, text, text, text, text, uuid)
  TO authenticated, service_role;

DROP POLICY IF EXISTS tender_documents_insert ON public.tender_documents;
DROP POLICY IF EXISTS tender_documents_select ON public.tender_documents;

CREATE POLICY tender_documents_select
  ON public.tender_documents FOR SELECT TO authenticated
  USING (public.org_access_allowed(organization_id));

REVOKE INSERT, UPDATE, DELETE ON public.tender_documents FROM anon, authenticated;

COMMIT;