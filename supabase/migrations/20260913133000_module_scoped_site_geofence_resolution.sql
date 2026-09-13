-- Standalone Site fallback was geofence-verified but module-blind. Add an
-- optional module/provider scope so module-aware callers only resolve a Site
-- when an accepted active service agreement enables that module and links the
-- Site. Legacy callers omitting p_module_key retain the previous behavior.
CREATE OR REPLACE FUNCTION public.resolve_verified_site_context(
  p_lat double precision,
  p_lng double precision,
  p_client_org_ids uuid[],
  p_module_key text DEFAULT NULL,
  p_provider_org_id uuid DEFAULT NULL
)
RETURNS TABLE(site_id uuid, site_name text, location_id uuid, client_organization_id uuid, match_kind text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  WITH point AS (
    SELECT st_setsrid(st_point(p_lng, p_lat), 4326) geometry
  )
  SELECT s.id, s.name, s.location_id, s.client_organization_id,
    CASE WHEN st_covers(s.boundary, p.geometry) THEN 'verified_boundary' ELSE 'verified_onsite_radius' END
  FROM public.client_sites s
  CROSS JOIN point p
  WHERE s.client_organization_id = ANY(coalesce(p_client_org_ids, '{}'::uuid[]))
    AND s.active
    AND s.boundary IS NOT NULL
    AND s.boundary_verification = 'verified'
    AND st_isvalid(s.boundary)
    AND NOT st_isempty(s.boundary)
    AND (
      st_covers(s.boundary, p.geometry)
      OR st_dwithin(coalesce(s.center_point, s.boundary)::geography, p.geometry::geography, coalesce(s.onsite_radius_meters, 10))
    )
    AND (
      p_module_key IS NULL
      OR EXISTS (
        SELECT 1
        FROM public.service_agreements sa
        JOIN public.service_agreement_modules sam ON sam.service_agreement_id = sa.id
          AND sam.enabled AND sam.module_key = p_module_key
        JOIN public.service_agreement_locations sal ON sal.service_agreement_id = sa.id
          AND sal.site_id = s.id AND sal.status = 'active'
        WHERE sa.client_organization_id = s.client_organization_id
          AND (p_provider_org_id IS NULL OR sa.provider_organization_id = p_provider_org_id)
          AND sa.invitation_status = 'accepted'
          AND sa.starts_on <= current_date
          AND (sa.ends_on IS NULL OR sa.ends_on >= current_date)
      )
    )
  ORDER BY CASE WHEN st_covers(s.boundary, p.geometry) THEN 0 ELSE 1 END,
    st_area(s.boundary), s.name
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.resolve_verified_site_context(double precision,double precision,uuid[],text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_verified_site_context(double precision,double precision,uuid[],text,uuid) TO service_role;
