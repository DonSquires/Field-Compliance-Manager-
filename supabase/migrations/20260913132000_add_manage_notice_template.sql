-- Governed module notice/document template authoring. Supports manual admin
-- authoring and Bob-proposed/extracted templates with source provenance.
CREATE OR REPLACE FUNCTION public.manage_notice_template(
  p_organization_id uuid,
  p_module_key text,
  p_notice_type text,
  p_body_html text,
  p_issuing_authority text DEFAULT NULL,
  p_authorising_act text DEFAULT NULL,
  p_authorising_section text DEFAULT NULL,
  p_bylaw_reference text DEFAULT NULL,
  p_fine_amount numeric DEFAULT NULL,
  p_payment_url text DEFAULT NULL,
  p_footer_text text DEFAULT NULL,
  p_source_document_url text DEFAULT NULL,
  p_bob_extracted boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_version integer;
  v_row public.notice_templates%rowtype;
BEGIN
  IF v_actor IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN
    RAISE EXCEPTION 'Organization administrator required';
  END IF;
  IF p_module_key NOT IN ('freedom_camping', 'parking_enforcement', 'noise_control', 'smoke_complaints', 'biosecurity') THEN
    RAISE EXCEPTION 'Unsupported enforcement module';
  END IF;
  IF p_notice_type NOT IN ('written_warning', 'notice_to_vacate', 'infringement', 'end', 'seizure') THEN
    RAISE EXCEPTION 'Unsupported notice type';
  END IF;
  IF nullif(trim(coalesce(p_body_html, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Template body is required';
  END IF;

  SELECT coalesce(max(version), 0) + 1 INTO v_version
  FROM public.notice_templates
  WHERE organization_id = p_organization_id
    AND module_key = p_module_key
    AND notice_type = p_notice_type;

  UPDATE public.notice_templates
  SET is_active = false, updated_at = now()
  WHERE organization_id = p_organization_id
    AND module_key = p_module_key
    AND notice_type = p_notice_type
    AND is_active;

  INSERT INTO public.notice_templates (
    organization_id, module_key, notice_type, version, is_active, issuing_authority,
    authorising_act, authorising_section, bylaw_reference, body_html, fine_amount,
    payment_url, footer_text, source_document_url, bob_extracted, created_by
  ) VALUES (
    p_organization_id, p_module_key, p_notice_type, v_version, true, p_issuing_authority,
    coalesce(p_authorising_act, 'Resource Management Act 1991'), p_authorising_section,
    p_bylaw_reference, p_body_html, p_fine_amount, p_payment_url, p_footer_text,
    p_source_document_url, coalesce(p_bob_extracted, false), v_actor
  ) RETURNING * INTO v_row;

  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (p_organization_id, v_actor, 'notice_template_saved', 'notice_templates', v_row.id,
    jsonb_build_object('module_key', p_module_key, 'notice_type', p_notice_type,
      'version', v_version, 'bob_extracted', coalesce(p_bob_extracted, false),
      'source_document_url', p_source_document_url));

  RETURN jsonb_build_object('id', v_row.id, 'module_key', v_row.module_key,
    'notice_type', v_row.notice_type, 'version', v_row.version,
    'is_active', v_row.is_active, 'source_document_url', v_row.source_document_url,
    'bob_extracted', v_row.bob_extracted);
END;
$$;

REVOKE ALL ON FUNCTION public.manage_notice_template(uuid,text,text,text,text,text,text,text,numeric,text,text,text,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manage_notice_template(uuid,text,text,text,text,text,text,text,numeric,text,text,text,boolean) TO authenticated, service_role;
