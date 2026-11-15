CREATE OR REPLACE FUNCTION public.roster_place_geofence_state(p_site_id uuid, p_zone_id uuid)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_has_boundary boolean;
  v_verified boolean;
BEGIN
  SELECT CASE WHEN p_site_id IS NOT NULL
    THEN EXISTS (SELECT 1 FROM public.client_sites s WHERE s.id = p_site_id AND s.boundary IS NOT NULL)
    ELSE EXISTS (SELECT 1 FROM public.location_zones z WHERE z.id = p_zone_id AND z.boundary IS NOT NULL)
  END INTO v_has_boundary;
  IF NOT v_has_boundary THEN RETURN 'missing'; END IF;

  -- Save and visual verification can share now() in one transaction.
  SELECT coalesce((
    SELECT h.verification_state = 'verified'
    FROM public.geofence_boundary_history h
    WHERE h.entity_type = CASE WHEN p_site_id IS NOT NULL THEN 'client_site' ELSE 'location_zone' END
      AND h.entity_id = coalesce(p_site_id, p_zone_id)
    ORDER BY h.created_at DESC, h.version DESC
    LIMIT 1
  ), false) INTO v_verified;
  RETURN CASE WHEN v_verified THEN 'verified' ELSE 'mapped_unverified' END;
END;
$$;
