CREATE OR REPLACE FUNCTION public.review_bob_document_draft(
  p_document_id uuid,
  p_document_version_id uuid,
  p_decision text,
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
  v_metadata jsonb;
  v_author text;
  v_status text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_decision NOT IN ('approved', 'rejected') THEN RAISE EXCEPTION 'Decision must be approved or rejected'; END IF;
  IF nullif(trim(coalesce(p_review_reason, '')), '') IS NULL THEN RAISE EXCEPTION 'Review reason is required'; END IF;

  SELECT d.organization_id, dv.metadata_json INTO v_org_id, v_metadata
  FROM public.documents d JOIN public.document_versions dv ON dv.document_id = d.id
  WHERE d.id = p_document_id AND dv.id = p_document_version_id FOR UPDATE;
  IF v_org_id IS NULL THEN RAISE EXCEPTION 'Document version not found'; END IF;
  IF NOT public.is_admin_for_org(v_org_id) AND NOT public.is_grand_master() THEN RAISE EXCEPTION 'Document review denied'; END IF;
  IF coalesce(v_metadata->>'authoring_status', '') <> 'needs_review' THEN RAISE EXCEPTION 'Only documents needing review can receive a decision'; END IF;

  v_author := v_metadata->>'authored_by';
  IF v_author = v_actor::text THEN RAISE EXCEPTION 'The document author cannot be its reviewer'; END IF;
  v_status := CASE WHEN p_decision = 'approved' THEN 'approved' ELSE 'rejected' END;

  UPDATE public.document_versions
  SET metadata_json = jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(coalesce(metadata_json, '{}'::jsonb), '{authoring_status}', to_jsonb(v_status)),
        '{reviewed_by}', to_jsonb(v_actor::text)
      ),
      '{reviewed_at}', to_jsonb(clock_timestamp()::text)
    ),
    '{review_reason}', to_jsonb(trim(p_review_reason))
  ), updated_at = clock_timestamp()
  WHERE id = p_document_version_id;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_org_id, v_actor, 'bob_document_review_decided', 'document_versions', p_document_version_id,
    jsonb_build_object('document_id', p_document_id, 'decision', v_status, 'review_reason', trim(p_review_reason)));

  RETURN jsonb_build_object('ok', true, 'document_id', p_document_id, 'document_version_id', p_document_version_id, 'status', v_status);
END;
$$;

REVOKE ALL ON FUNCTION public.review_bob_document_draft(uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_bob_document_draft(uuid, uuid, text, text) TO authenticated, service_role;
