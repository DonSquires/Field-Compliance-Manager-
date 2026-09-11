CREATE TABLE IF NOT EXISTS public.organization_brand_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  asset_kind text NOT NULL CHECK (asset_kind IN ('logo', 'wordmark', 'letterhead', 'footer', 'signature', 'color_palette')),
  variant text NOT NULL DEFAULT 'default' CHECK (variant IN ('default', 'light', 'dark', 'print')),
  label text NOT NULL,
  storage_bucket text,
  storage_path text,
  asset_url text,
  mime_type text,
  sha256 text,
  alt_text text,
  usage_scope text NOT NULL DEFAULT 'documents' CHECK (usage_scope IN ('documents', 'reports', 'client_portal', 'all')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'revoked', 'superseded')),
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES public.user_profiles(id),
  approved_by uuid REFERENCES public.user_profiles(id),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (storage_path IS NOT NULL OR asset_url IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS organization_brand_assets_scope_idx
  ON public.organization_brand_assets (organization_id, asset_kind, variant, status, updated_at DESC);

ALTER TABLE public.organization_brand_assets ENABLE ROW LEVEL SECURITY;
CREATE POLICY organization_brand_assets_select ON public.organization_brand_assets
  FOR SELECT TO authenticated
  USING (public.org_access_allowed(organization_id) AND status = 'approved');
CREATE POLICY organization_brand_assets_write ON public.organization_brand_assets
  FOR ALL TO authenticated
  USING (public.is_admin_for_org(organization_id) OR public.is_grand_master())
  WITH CHECK (public.is_admin_for_org(organization_id) OR public.is_grand_master());
REVOKE ALL ON public.organization_brand_assets FROM anon;
GRANT SELECT ON public.organization_brand_assets TO authenticated;
GRANT ALL ON public.organization_brand_assets TO service_role;

CREATE OR REPLACE FUNCTION public.register_organization_brand_asset(
  p_organization_id uuid,
  p_asset_kind text,
  p_variant text,
  p_label text,
  p_storage_bucket text DEFAULT NULL,
  p_storage_path text DEFAULT NULL,
  p_asset_url text DEFAULT NULL,
  p_mime_type text DEFAULT NULL,
  p_sha256 text DEFAULT NULL,
  p_alt_text text DEFAULT NULL,
  p_usage_scope text DEFAULT 'documents'
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
  IF NOT public.is_admin_for_org(p_organization_id) AND NOT public.is_grand_master() THEN RAISE EXCEPTION 'Brand asset registration denied'; END IF;
  IF nullif(trim(coalesce(p_label, '')), '') IS NULL THEN RAISE EXCEPTION 'Brand asset label is required'; END IF;
  IF p_storage_path IS NULL AND p_asset_url IS NULL THEN RAISE EXCEPTION 'Brand asset source is required'; END IF;

  INSERT INTO public.organization_brand_assets (
    organization_id, asset_kind, variant, label, storage_bucket, storage_path, asset_url,
    mime_type, sha256, alt_text, usage_scope, status, created_by
  ) VALUES (
    p_organization_id, p_asset_kind, p_variant, trim(p_label), p_storage_bucket, p_storage_path,
    p_asset_url, p_mime_type, p_sha256, nullif(trim(coalesce(p_alt_text, '')), ''), p_usage_scope,
    'pending', v_actor
  ) RETURNING * INTO v_asset;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (p_organization_id, v_actor, 'organization_brand_asset_registered', 'organization_brand_assets', v_asset.id,
    jsonb_build_object('asset_kind', p_asset_kind, 'variant', p_variant, 'usage_scope', p_usage_scope));
  RETURN v_asset;
END;
$$;

REVOKE ALL ON FUNCTION public.register_organization_brand_asset(uuid, text, text, text, text, text, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_organization_brand_asset(uuid, text, text, text, text, text, text, text, text, text, text) TO authenticated, service_role;
