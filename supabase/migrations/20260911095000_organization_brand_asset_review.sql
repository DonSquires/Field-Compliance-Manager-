DROP POLICY IF EXISTS organization_brand_assets_select ON public.organization_brand_assets;
CREATE POLICY organization_brand_assets_select ON public.organization_brand_assets
  FOR SELECT TO authenticated
  USING (public.org_access_allowed(organization_id) AND (status = 'approved' OR public.is_admin_for_org(organization_id) OR public.is_grand_master()));

CREATE OR REPLACE FUNCTION public.review_organization_brand_asset(
  p_asset_id uuid,
  p_decision text,
  p_reason text
)
RETURNS public.organization_brand_assets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_asset public.organization_brand_assets;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_decision NOT IN ('approved', 'revoked') THEN RAISE EXCEPTION 'Brand asset decision must be approved or revoked'; END IF;
  IF nullif(trim(coalesce(p_reason, '')), '') IS NULL THEN RAISE EXCEPTION 'Brand asset review reason is required'; END IF;
  SELECT * INTO v_asset FROM public.organization_brand_assets WHERE id = p_asset_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Brand asset not found'; END IF;
  IF NOT public.is_admin_for_org(v_asset.organization_id) AND NOT public.is_grand_master() THEN RAISE EXCEPTION 'Brand asset review denied'; END IF;

  UPDATE public.organization_brand_assets
  SET status = p_decision,
      approved_by = CASE WHEN p_decision = 'approved' THEN v_actor ELSE approved_by END,
      approved_at = CASE WHEN p_decision = 'approved' THEN clock_timestamp() ELSE approved_at END,
      updated_at = clock_timestamp()
  WHERE id = v_asset.id
  RETURNING * INTO v_asset;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_asset.organization_id, v_actor, 'organization_brand_asset_reviewed', 'organization_brand_assets', v_asset.id,
    jsonb_build_object('decision', p_decision, 'reason', trim(p_reason)));
  RETURN v_asset;
END;
$$;

REVOKE ALL ON FUNCTION public.review_organization_brand_asset(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_organization_brand_asset(uuid, text, text) TO authenticated, service_role;
