-- Governed human review of Bob's document classification proposal.
-- Reviews append a new classification row so the original proposal remains auditable.

CREATE OR REPLACE FUNCTION public.review_document_classification(
  p_document_version_id uuid,
  p_privacy_class text,
  p_contains_pii boolean,
  p_contains_operational_security boolean,
  p_contains_financial_data boolean,
  p_contains_legal_privilege boolean,
  p_reason text
) RETURNS public.document_classifications
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_org_id uuid;
  v_review public.document_classifications%rowtype;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF nullif(trim(coalesce(p_reason, '')), '') IS NULL THEN RAISE EXCEPTION 'Review reason is required'; END IF;
  IF p_privacy_class NOT IN ('public', 'internal_non_sensitive', 'tenant_sensitive', 'restricted') THEN
    RAISE EXCEPTION 'Unsupported privacy class';
  END IF;

  SELECT d.organization_id INTO v_org_id
  FROM public.document_versions dv
  JOIN public.documents d ON d.id = dv.document_id
  WHERE dv.id = p_document_version_id;
  IF v_org_id IS NULL THEN RAISE EXCEPTION 'Document version not found'; END IF;
  IF NOT public.is_admin_for_org(v_org_id) AND NOT public.is_grand_master() THEN
    RAISE EXCEPTION 'Document classification review denied';
  END IF;

  INSERT INTO public.document_classifications (
    document_version_id, privacy_class, contains_pii, contains_operational_security,
    contains_financial_data, contains_legal_privilege, classifier_source,
    confidence, rationale, reviewed_by, reviewed_at
  ) VALUES (
    p_document_version_id, p_privacy_class, coalesce(p_contains_pii, false),
    coalesce(p_contains_operational_security, false), coalesce(p_contains_financial_data, false),
    coalesce(p_contains_legal_privilege, false), 'human_review', 1.0,
    trim(p_reason), v_actor, clock_timestamp()
  ) RETURNING * INTO v_review;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_org_id, v_actor, 'document_classification_reviewed', 'document_classifications', v_review.id,
    jsonb_build_object('document_version_id', p_document_version_id, 'privacy_class', p_privacy_class,
      'contains_pii', p_contains_pii, 'contains_operational_security', p_contains_operational_security,
      'contains_financial_data', p_contains_financial_data, 'contains_legal_privilege', p_contains_legal_privilege,
      'reason', trim(p_reason)));
  RETURN v_review;
END;
$$;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.document_classifications FROM anon, authenticated;
GRANT SELECT ON TABLE public.document_classifications TO authenticated;

REVOKE ALL ON FUNCTION public.review_document_classification(uuid, text, boolean, boolean, boolean, boolean, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_document_classification(uuid, text, boolean, boolean, boolean, boolean, text) TO authenticated, service_role;