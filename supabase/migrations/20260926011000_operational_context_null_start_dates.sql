-- A missing starts_on means "in force" in agreementTerm.ts and throughout the UI.
-- Keep operational place resolution aligned: accepted open-ended agreements must not lose
-- their Site/Zone GPS context merely because the legacy start date is null.

CREATE OR REPLACE FUNCTION public.resolve_operational_context(
  p_lat double precision,
  p_lng double precision,
  p_org_id uuid,
  p_module_key text DEFAULT NULL,
  p_at timestamptz DEFAULT now()
) RETURNS TABLE(
  in_operating_bounds boolean,
  out_of_bounds_district text,
  governing_jurisdiction_id uuid,
  governing_jurisdiction_name text,
  on_site boolean,
  site_id uuid,
  client_org_id uuid,
  matched_zone_id uuid,
  matched_module_key text,
  effective_rules jsonb,
  resolution_status text,
  governor_overlap_flag boolean
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_point geometry := ST_SetSRID(ST_Point(p_lng, p_lat), 4326);
  v_direct record;
  v_contracted record;
  v_site record;
  v_blocked_status text;
BEGIN
  SELECT * INTO v_direct FROM public.resolve_context(p_lat, p_lng, p_org_id, p_module_key, p_at);
  IF v_direct.matched_zone_id IS NOT NULL OR v_direct.site_id IS NOT NULL THEN
    RETURN QUERY SELECT v_direct.in_operating_bounds, v_direct.out_of_bounds_district,
      v_direct.governing_jurisdiction_id, v_direct.governing_jurisdiction_name,
      v_direct.on_site, v_direct.site_id, v_direct.client_org_id,
      v_direct.matched_zone_id, v_direct.matched_module_key, v_direct.effective_rules,
      v_direct.resolution_status, v_direct.governor_overlap_flag;
    RETURN;
  END IF;

  SELECT rc.* INTO v_contracted
  FROM public.service_agreements sa
  JOIN public.service_agreement_modules sam
    ON sam.service_agreement_id = sa.id AND sam.enabled
   AND (p_module_key IS NULL OR sam.module_key = p_module_key)
  JOIN public.service_agreement_locations sal
    ON sal.service_agreement_id = sa.id AND sal.status = 'active'
  CROSS JOIN LATERAL public.resolve_context(p_lat, p_lng, sa.client_organization_id, p_module_key, p_at) rc
  WHERE sa.provider_organization_id = p_org_id
    AND sa.invitation_status = 'accepted'
    AND (sa.starts_on IS NULL OR sa.starts_on <= p_at::date)
    AND (sa.ends_on IS NULL OR sa.ends_on >= p_at::date)
    AND rc.resolution_status = 'resolved'
    AND ((sal.zone_id IS NOT NULL AND sal.zone_id = rc.matched_zone_id)
      OR (sal.site_id IS NOT NULL AND sal.site_id = rc.site_id))
  ORDER BY CASE WHEN sal.zone_id = rc.matched_zone_id THEN 0 ELSE 1 END
  LIMIT 1;

  IF FOUND THEN
    RETURN QUERY SELECT true, NULL::text, v_contracted.governing_jurisdiction_id,
      v_contracted.governing_jurisdiction_name, v_contracted.on_site,
      v_contracted.site_id, v_contracted.client_org_id, v_contracted.matched_zone_id,
      v_contracted.matched_module_key, v_contracted.effective_rules,
      v_contracted.resolution_status, v_contracted.governor_overlap_flag;
    RETURN;
  END IF;

  SELECT cs.id AS site_id, COALESCE(l.organization_id, cs.client_organization_id) AS client_org_id
    INTO v_site
  FROM public.service_agreements sa
  JOIN public.service_agreement_modules sam
    ON sam.service_agreement_id = sa.id AND sam.enabled
   AND (p_module_key IS NULL OR sam.module_key = p_module_key)
  JOIN public.service_agreement_locations sal
    ON sal.service_agreement_id = sa.id AND sal.status = 'active' AND sal.site_id IS NOT NULL
  JOIN public.client_sites cs ON cs.id = sal.site_id AND cs.active
  LEFT JOIN public.locations l ON l.id = cs.location_id
  WHERE sa.provider_organization_id = p_org_id
    AND sa.invitation_status = 'accepted'
    AND (sa.starts_on IS NULL OR sa.starts_on <= p_at::date)
    AND (sa.ends_on IS NULL OR sa.ends_on >= p_at::date)
    AND cs.boundary IS NOT NULL AND cs.boundary_verification = 'verified'
    AND ST_IsValid(cs.boundary) AND NOT ST_IsEmpty(cs.boundary) AND ST_Contains(cs.boundary, v_point)
  ORDER BY ST_Area(cs.boundary) ASC
  LIMIT 1;

  IF FOUND THEN
    RETURN QUERY SELECT true, NULL::text, v_direct.governing_jurisdiction_id,
      v_direct.governing_jurisdiction_name, true, v_site.site_id,
      v_site.client_org_id, NULL::uuid, p_module_key, '{}'::jsonb,
      'resolved'::text, v_direct.governor_overlap_flag;
    RETURN;
  END IF;

  SELECT candidate.status INTO v_blocked_status
  FROM (
    SELECT 'unresolved_unverified'::text AS status, 0 AS priority, ST_Area(z.boundary) AS area
    FROM public.service_agreements sa
    JOIN public.service_agreement_modules sam ON sam.service_agreement_id = sa.id AND sam.enabled
      AND (p_module_key IS NULL OR sam.module_key = p_module_key)
    JOIN public.service_agreement_locations sal ON sal.service_agreement_id = sa.id AND sal.status = 'active'
    JOIN public.location_zones z ON z.id = sal.zone_id AND z.is_active
    WHERE sa.provider_organization_id = p_org_id AND sa.invitation_status = 'accepted'
      AND (sa.starts_on IS NULL OR sa.starts_on <= p_at::date) AND (sa.ends_on IS NULL OR sa.ends_on >= p_at::date)
      AND z.boundary IS NOT NULL AND COALESCE(z.boundary_verification, 'unverified') <> 'verified'
      AND ST_IsValid(z.boundary) AND NOT ST_IsEmpty(z.boundary) AND ST_Contains(z.boundary, v_point)
      AND (p_module_key IS NULL OR z.module_key = p_module_key) AND public._geofence_active_at(z.active_schedule, p_at)
    UNION ALL
    SELECT 'unresolved_unverified'::text, 1, ST_Area(cs.boundary)
    FROM public.service_agreements sa
    JOIN public.service_agreement_modules sam ON sam.service_agreement_id = sa.id AND sam.enabled
      AND (p_module_key IS NULL OR sam.module_key = p_module_key)
    JOIN public.service_agreement_locations sal ON sal.service_agreement_id = sa.id AND sal.status = 'active'
    JOIN public.client_sites cs ON cs.id = sal.site_id AND cs.active
    WHERE sa.provider_organization_id = p_org_id AND sa.invitation_status = 'accepted'
      AND (sa.starts_on IS NULL OR sa.starts_on <= p_at::date) AND (sa.ends_on IS NULL OR sa.ends_on >= p_at::date)
      AND cs.boundary IS NOT NULL AND COALESCE(cs.boundary_verification, 'unverified') <> 'verified'
      AND ST_IsValid(cs.boundary) AND NOT ST_IsEmpty(cs.boundary) AND ST_Contains(cs.boundary, v_point)
    UNION ALL
    SELECT 'unresolved_invalid'::text, 2, 0::double precision
    FROM public.service_agreements sa
    JOIN public.service_agreement_modules sam ON sam.service_agreement_id = sa.id AND sam.enabled
      AND (p_module_key IS NULL OR sam.module_key = p_module_key)
    JOIN public.service_agreement_locations sal ON sal.service_agreement_id = sa.id AND sal.status = 'active'
    JOIN public.location_zones z ON z.id = sal.zone_id AND z.is_active
    WHERE sa.provider_organization_id = p_org_id AND sa.invitation_status = 'accepted'
      AND (sa.starts_on IS NULL OR sa.starts_on <= p_at::date) AND (sa.ends_on IS NULL OR sa.ends_on >= p_at::date)
      AND z.boundary IS NOT NULL AND (NOT ST_IsValid(z.boundary) OR ST_IsEmpty(z.boundary))
      AND z.boundary && v_point AND (p_module_key IS NULL OR z.module_key = p_module_key)
    UNION ALL
    SELECT 'unresolved_invalid'::text, 3, 0::double precision
    FROM public.service_agreements sa
    JOIN public.service_agreement_modules sam ON sam.service_agreement_id = sa.id AND sam.enabled
      AND (p_module_key IS NULL OR sam.module_key = p_module_key)
    JOIN public.service_agreement_locations sal ON sal.service_agreement_id = sa.id AND sal.status = 'active'
    JOIN public.client_sites cs ON cs.id = sal.site_id AND cs.active
    WHERE sa.provider_organization_id = p_org_id AND sa.invitation_status = 'accepted'
      AND (sa.starts_on IS NULL OR sa.starts_on <= p_at::date) AND (sa.ends_on IS NULL OR sa.ends_on >= p_at::date)
      AND cs.boundary IS NOT NULL AND (NOT ST_IsValid(cs.boundary) OR ST_IsEmpty(cs.boundary)) AND cs.boundary && v_point
  ) candidate
  ORDER BY candidate.priority, candidate.area
  LIMIT 1;

  IF v_blocked_status IS NOT NULL THEN
    RETURN QUERY SELECT v_direct.in_operating_bounds, v_direct.out_of_bounds_district,
      v_direct.governing_jurisdiction_id, v_direct.governing_jurisdiction_name,
      false, NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, '{}'::jsonb,
      v_blocked_status, v_direct.governor_overlap_flag;
    RETURN;
  END IF;

  RETURN QUERY SELECT v_direct.in_operating_bounds, v_direct.out_of_bounds_district,
    v_direct.governing_jurisdiction_id, v_direct.governing_jurisdiction_name,
    v_direct.on_site, v_direct.site_id, v_direct.client_org_id,
    v_direct.matched_zone_id, v_direct.matched_module_key, v_direct.effective_rules,
    v_direct.resolution_status, v_direct.governor_overlap_flag;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_operational_context(double precision,double precision,uuid,text,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_operational_context(double precision,double precision,uuid,text,timestamptz) TO service_role;

COMMENT ON FUNCTION public.resolve_operational_context(double precision,double precision,uuid,text,timestamptz) IS
  'Field-operation resolver for direct and accepted contracted Site/Zone facets. Null starts_on is already in force; verified Zone wins, verified Site is the fallback, and blocked linked geometry preserves P1/P2 status.';