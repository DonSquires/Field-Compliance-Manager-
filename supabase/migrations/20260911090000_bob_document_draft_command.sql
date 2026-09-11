CREATE OR REPLACE FUNCTION public.create_bob_document_draft(
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
  v_document_id uuid;
  v_version_id uuid;
  v_title text := nullif(trim(coalesce(p_title, '')), '');
  v_type text := nullif(trim(coalesce(p_document_type, '')), '');
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF v_title IS NULL THEN RAISE EXCEPTION 'Document title is required'; END IF;
  IF nullif(trim(coalesce(p_authored_text, '')), '') IS NULL THEN RAISE EXCEPTION 'Document content is required'; END IF;
  IF jsonb_typeof(coalesce(p_reference_handles, '[]'::jsonb)) <> 'array' THEN RAISE EXCEPTION 'Reference handles must be an array'; END IF;
  IF jsonb_typeof(coalesce(p_reference_metadata, '[]'::jsonb)) <> 'array' THEN RAISE EXCEPTION 'Reference metadata must be an array'; END IF;

  SELECT organization_id INTO v_org_id
  FROM public.user_profiles
  WHERE id = v_actor;
  IF v_org_id IS NULL THEN RAISE EXCEPTION 'Organization context is required'; END IF;
  IF NOT public.is_admin_for_org(v_org_id) AND NOT public.is_grand_master() THEN
    RAISE EXCEPTION 'Document drafting requires an administrator';
  END IF;

  INSERT INTO public.documents (
    original_filename, mime_type, source_channel, organization_id, current_scope, uploaded_by
  ) VALUES (
    left(v_title || '.html', 255), 'text/html', 'system_generated', v_org_id, 'conversation_only', v_actor
  ) RETURNING id INTO v_document_id;

  INSERT INTO public.document_versions (
    document_id, version_label, extracted_text, metadata_json
  ) VALUES (
    v_document_id, 'v1', p_authored_text,
    jsonb_build_object(
      'authoring_html', coalesce(p_authored_html, ''),
      'content_format', 'html',
      'title', v_title,
      'document_type', v_type,
      'authoring_status', 'draft',
      'authored_by', v_actor,
      'reference_handles', coalesce(p_reference_handles, '[]'::jsonb),
      'references', coalesce(p_reference_metadata, '[]'::jsonb)
    )
  ) RETURNING id INTO v_version_id;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (
    v_org_id, v_actor, 'bob_document_draft_created', 'documents', v_document_id,
    jsonb_build_object('document_version_id', v_version_id, 'document_type', v_type, 'title', v_title, 'reference_count', jsonb_array_length(coalesce(p_reference_handles, '[]'::jsonb)))
  );

  RETURN jsonb_build_object('ok', true, 'document_id', v_document_id, 'document_version_id', v_version_id, 'scope', 'conversation_only', 'status', 'draft');
END;
$$;

REVOKE ALL ON FUNCTION public.create_bob_document_draft(text, text, text, text, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_bob_document_draft(text, text, text, text, jsonb, jsonb) TO authenticated, service_role;
