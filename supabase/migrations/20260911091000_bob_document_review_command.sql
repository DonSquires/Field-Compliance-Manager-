CREATE OR REPLACE FUNCTION public.submit_bob_document_for_review(
  p_document_id uuid,
  p_document_version_id uuid,
  p_review_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_org_id uuid;
  v_current jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF nullif(trim(coalesce(p_review_reason, '')), '') IS NULL THEN RAISE EXCEPTION 'Review reason is required'; END IF;

  SELECT d.organization_id, dv.metadata_json
  INTO v_org_id, v_current
  FROM public.documents d
  JOIN public.document_versions dv ON dv.document_id = d.id
  WHERE d.id = p_document_id AND dv.id = p_document_version_id
  FOR UPDATE;

  IF v_org_id IS NULL THEN RAISE EXCEPTION 'Document draft not found'; END IF;
  IF NOT public.is_admin_for_org(v_org_id) AND NOT public.is_grand_master() THEN
    RAISE EXCEPTION 'Document review submission requires an administrator';
  END IF;
  IF coalesce(v_current->>'authoring_status', 'draft') <> 'draft' THEN
    RAISE EXCEPTION 'Only draft documents can be submitted for review';
  END IF;

  UPDATE public.document_versions
  SET metadata_json = jsonb_set(
    jsonb_set(
      jsonb_set(coalesce(metadata_json, '{}'::jsonb), '{authoring_status}', '"needs_review"'::jsonb),
      '{review_requested_by}', to_jsonb(v_actor::text)
    ),
    '{review_reason}', to_jsonb(trim(p_review_reason))
  ), updated_at = clock_timestamp()
  WHERE id = p_document_version_id;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (
    v_org_id, v_actor, 'bob_document_review_requested', 'document_versions', p_document_version_id,
    jsonb_build_object('document_id', p_document_id, 'review_reason', trim(p_review_reason))
  );

  RETURN jsonb_build_object('ok', true, 'document_id', p_document_id, 'document_version_id', p_document_version_id, 'status', 'needs_review');
END;
$$;

REVOKE ALL ON FUNCTION public.submit_bob_document_for_review(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_bob_document_for_review(uuid, uuid, text) TO authenticated, service_role;
