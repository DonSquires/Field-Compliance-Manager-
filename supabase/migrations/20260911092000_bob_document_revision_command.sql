CREATE OR REPLACE FUNCTION public.save_bob_document_revision(
  p_document_id uuid,
  p_supersedes_version_id uuid,
  p_title text,
  p_document_type text,
  p_authored_html text,
  p_authored_text text,
  p_reference_handles jsonb DEFAULT '[]'::jsonb,
  p_reference_metadata jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_org_id uuid;
  v_next_label text;
  v_version_id uuid;
  v_title text := nullif(trim(coalesce(p_title, '')), '');
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF v_title IS NULL THEN RAISE EXCEPTION 'Document title is required'; END IF;
  IF nullif(trim(coalesce(p_authored_text, '')), '') IS NULL THEN RAISE EXCEPTION 'Document content is required'; END IF;
  IF jsonb_typeof(coalesce(p_reference_handles, '[]'::jsonb)) <> 'array' THEN RAISE EXCEPTION 'Reference handles must be an array'; END IF;

  SELECT d.organization_id INTO v_org_id
  FROM public.documents d
  JOIN public.document_versions dv ON dv.document_id = d.id
  WHERE d.id = p_document_id AND dv.id = p_supersedes_version_id
  FOR UPDATE;
  IF v_org_id IS NULL THEN RAISE EXCEPTION 'Document version not found'; END IF;
  IF NOT public.is_admin_for_org(v_org_id) AND NOT public.is_grand_master() THEN
    RAISE EXCEPTION 'Document revision requires an administrator';
  END IF;

  SELECT 'v' || (count(*) + 1)::text INTO v_next_label
  FROM public.document_versions
  WHERE document_id = p_document_id;

  INSERT INTO public.document_versions (
    document_id, version_label, supersedes_version_id, extracted_text, metadata_json
  ) VALUES (
    p_document_id, v_next_label, p_supersedes_version_id, p_authored_text,
    jsonb_build_object(
      'authoring_html', coalesce(p_authored_html, ''),
      'content_format', 'html',
      'title', v_title,
      'document_type', nullif(trim(coalesce(p_document_type, '')), ''),
      'authoring_status', 'draft',
      'authored_by', v_actor,
      'reference_handles', coalesce(p_reference_handles, '[]'::jsonb),
      'references', coalesce(p_reference_metadata, '[]'::jsonb),
      'revision_reason', 'Authoring revision created from the previous version.'
    )
  ) RETURNING id INTO v_version_id;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (
    v_org_id, v_actor, 'bob_document_revision_created', 'document_versions', v_version_id,
    jsonb_build_object('document_id', p_document_id, 'supersedes_version_id', p_supersedes_version_id, 'version_label', v_next_label)
  );

  RETURN jsonb_build_object('ok', true, 'document_id', p_document_id, 'document_version_id', v_version_id, 'version_label', v_next_label, 'status', 'draft');
END;
$$;

REVOKE ALL ON FUNCTION public.save_bob_document_revision(uuid, uuid, text, text, text, text, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_bob_document_revision(uuid, uuid, text, text, text, text, jsonb, jsonb) TO authenticated, service_role;
