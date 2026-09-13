-- Self-serve module subscription toggle for the caller's own organisation,
-- regardless of organization_type (unlike set_operating_branch_module, which
-- is branch-only). Reuses module_catalog + the module_dependencies trigger
-- added in 20260913110000_modular_platform_catalog.sql — the trigger still
-- enforces (e.g. finance requires rostering) even through this entry point.
CREATE OR REPLACE FUNCTION public.set_organization_module_subscription(
  p_organization_id uuid,
  p_module_key text,
  p_enabled boolean
)
RETURNS public.organization_modules
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_module public.organization_modules%rowtype;
BEGIN
  IF v_actor IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN
    RAISE EXCEPTION 'Active organisation administrator required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.module_catalog module WHERE module.module_key = p_module_key AND module.active) THEN
    RAISE EXCEPTION 'Active platform module required';
  END IF;

  INSERT INTO public.organization_modules (organization_id, module_key, enabled)
  VALUES (p_organization_id, p_module_key, p_enabled)
  ON CONFLICT (organization_id, module_key) DO UPDATE SET enabled = excluded.enabled
  RETURNING * INTO v_module;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (p_organization_id, v_actor, 'organization_module_subscription_set', 'organization_modules', v_module.id, jsonb_build_object('module_key', v_module.module_key, 'enabled', v_module.enabled));

  RETURN v_module;
END;
$$;

REVOKE ALL ON FUNCTION public.set_organization_module_subscription(uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_organization_module_subscription(uuid, text, boolean) TO authenticated, service_role;
