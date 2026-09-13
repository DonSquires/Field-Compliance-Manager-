-- manage_report_template — the missing authoring path for report_templates.
-- report_templates previously had no INSERT/UPDATE RPC anywhere: only a
-- SELECT policy existed, so no provider admin could ever create the template
-- manage_crm_agreement_reporting requires before enabling client reporting.
-- Scoped by agreement (not a raw organization_id param) so the frontend never
-- has to know/pass a provider org id directly; mirrors the governance shape
-- of manage_crm_agreement_reporting (provider-admin gated, security definer,
-- audited).
CREATE OR REPLACE FUNCTION public.manage_report_template(
  p_agreement_id uuid,
  p_module_key text,
  p_template_code text,
  p_name text,
  p_output_policy jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_organization_id uuid;
  v_template_code text := nullif(trim(coalesce(p_template_code, '')), '');
  v_name text := nullif(trim(coalesce(p_name, '')), '');
  v_module text := nullif(trim(coalesce(p_module_key, '')), '');
  v_row public.report_templates%rowtype;
BEGIN
  SELECT provider_organization_id INTO v_organization_id FROM public.service_agreements WHERE id = p_agreement_id;
  IF v_organization_id IS NULL THEN RAISE EXCEPTION 'Service agreement not found'; END IF;
  IF v_actor IS NULL OR NOT public.is_admin_for_org(v_organization_id) THEN
    RAISE EXCEPTION 'Provider administrator required';
  END IF;
  IF v_template_code IS NULL OR v_name IS NULL OR v_module IS NULL THEN
    RAISE EXCEPTION 'module_key, template_code, and name are required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.module_catalog WHERE module_key = v_module AND active) THEN
    RAISE EXCEPTION 'module_key is not a recognized active module';
  END IF;

  INSERT INTO public.report_templates (organization_id, module_key, template_code, name, output_policy)
  VALUES (v_organization_id, v_module, v_template_code, v_name, coalesce(p_output_policy, '{}'::jsonb))
  ON CONFLICT (organization_id, template_code)
  DO UPDATE SET module_key = excluded.module_key, name = excluded.name, output_policy = excluded.output_policy
  RETURNING * INTO v_row;

  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_organization_id, v_actor, 'report_template_saved', 'report_templates', v_row.id,
          jsonb_build_object('template_code', v_row.template_code, 'module_key', v_row.module_key, 'name', v_row.name));

  RETURN jsonb_build_object(
    'id', v_row.id, 'organization_id', v_row.organization_id, 'module_key', v_row.module_key,
    'template_code', v_row.template_code, 'name', v_row.name, 'output_policy', v_row.output_policy
  );
END;
$$;

REVOKE ALL ON FUNCTION public.manage_report_template(uuid,text,text,text,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manage_report_template(uuid,text,text,text,jsonb) TO authenticated, service_role;
