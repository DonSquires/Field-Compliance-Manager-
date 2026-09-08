-- Governed observation relationships and cross-module wildcard search.
-- Observation facts remain immutable after completion; relationship links are
-- managed through the RPC below so tenant and entity access is checked.

ALTER TABLE public.observations
  ADD COLUMN IF NOT EXISTS canonical_vehicle_id uuid REFERENCES public.canonical_vehicles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS person_record_id uuid REFERENCES public.person_records(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS incident_id uuid REFERENCES public.incidents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_observations_canonical_vehicle
  ON public.observations (organization_id, canonical_vehicle_id, observed_at DESC)
  WHERE canonical_vehicle_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_observations_person_record
  ON public.observations (organization_id, person_record_id, observed_at DESC)
  WHERE person_record_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_observations_incident
  ON public.observations (organization_id, incident_id, observed_at DESC)
  WHERE incident_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.link_observation_entities(
  p_observation_id uuid,
  p_organization_id uuid,
  p_canonical_vehicle_id uuid DEFAULT NULL,
  p_person_record_id uuid DEFAULT NULL,
  p_site_id uuid DEFAULT NULL,
  p_zone_id uuid DEFAULT NULL,
  p_location_id uuid DEFAULT NULL,
  p_incident_id uuid DEFAULT NULL
)
RETURNS public.observations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE result public.observations;
BEGIN
  IF auth.uid() IS NULL OR NOT public.org_access_allowed(p_organization_id) THEN
    RAISE EXCEPTION 'Observation access denied';
  END IF;
  IF p_person_record_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.person_records
    WHERE id = p_person_record_id AND public.org_access_allowed(organization_id)
  ) THEN RAISE EXCEPTION 'Person record is outside the accessible organization'; END IF;
  IF p_site_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.client_sites
    WHERE id = p_site_id AND public.has_location_access(id, NULL, 'client_reads_provider')
  ) THEN RAISE EXCEPTION 'Site is outside the accessible organization'; END IF;
  IF p_zone_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.location_zones
    WHERE id = p_zone_id AND public.org_access_allowed(organization_id)
  ) THEN RAISE EXCEPTION 'Zone is outside the accessible organization'; END IF;
  IF p_incident_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.incidents
    WHERE id = p_incident_id AND public.org_access_allowed(organization_id)
  ) THEN RAISE EXCEPTION 'Incident is outside the accessible organization'; END IF;
  IF p_canonical_vehicle_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.canonical_vehicles WHERE id = p_canonical_vehicle_id
  ) THEN RAISE EXCEPTION 'Vehicle record not found'; END IF;

  UPDATE public.observations
  SET canonical_vehicle_id = p_canonical_vehicle_id,
      person_record_id = p_person_record_id,
      site_id = COALESCE(p_site_id, site_id),
      zone_id = COALESCE(p_zone_id, zone_id),
      location_id = COALESCE(p_location_id, location_id),
      incident_id = p_incident_id
  WHERE id = p_observation_id AND organization_id = p_organization_id
  RETURNING * INTO result;
  IF result.id IS NULL THEN RAISE EXCEPTION 'Observation not found'; END IF;
  RETURN result;
END;
$$;

DROP FUNCTION IF EXISTS public.search_observations(uuid, text, uuid, uuid, uuid, uuid, uuid, uuid, boolean, boolean, integer);

CREATE OR REPLACE FUNCTION public.search_observations(
  p_organization_id uuid,
  p_search text DEFAULT NULL,
  p_site_id uuid DEFAULT NULL,
  p_zone_id uuid DEFAULT NULL,
  p_location_id uuid DEFAULT NULL,
  p_vehicle_id uuid DEFAULT NULL,
  p_person_id uuid DEFAULT NULL,
  p_incident_id uuid DEFAULT NULL,
  p_poi boolean DEFAULT NULL,
  p_loi boolean DEFAULT NULL,
  p_limit integer DEFAULT 50
)
RETURNS TABLE (
  observation_id uuid,
  observed_at timestamptz,
  organization_id uuid,
  plate_number text,
  vehicle_id uuid,
  vehicle_label text,
  person_id uuid,
  person_label text,
  site_id uuid,
  site_name text,
  zone_id uuid,
  zone_name text,
  location_id uuid,
  location_name text,
  incident_id uuid,
  incident_label text,
  poi boolean,
  loi boolean,
  compliance_status text,
  officer_notes text,
  photo_url text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT o.id, o.observed_at, o.organization_id, o.plate_number,
    o.canonical_vehicle_id,
    COALESCE(NULLIF(trim(concat_ws(' ', cv.plate_number, cv.make, cv.model)), ''), o.plate_number),
    o.person_record_id, pr.display_name, o.site_id, cs.name, o.zone_id, z.name,
    o.location_id, l.name, o.incident_id,
    CASE WHEN i.id IS NULL THEN NULL ELSE concat_ws(': ', i.incident_type, i.description) END,
    COALESCE(vf.active, false), COALESCE(pf.active, false), o.compliance_status,
    o.officer_notes, o.photo_url
  FROM public.observations o
  LEFT JOIN public.canonical_vehicles cv ON cv.id = o.canonical_vehicle_id
  LEFT JOIN public.person_records pr ON pr.id = o.person_record_id
  LEFT JOIN public.client_sites cs ON cs.id = o.site_id
  LEFT JOIN public.location_zones z ON z.id = o.zone_id
  LEFT JOIN public.locations l ON l.id = o.location_id
  LEFT JOIN public.incidents i ON i.id = o.incident_id
  LEFT JOIN LATERAL (
    SELECT bool_or(ef.active AND ef.flag_type IN ('poi','voi')) AS active
    FROM public.entity_flags ef
    WHERE ef.organization_id = o.organization_id AND ef.entity_type = 'vehicle'
      AND ef.entity_id = COALESCE(o.canonical_vehicle_id, cv.id)
  ) vf ON true
  LEFT JOIN LATERAL (
    SELECT bool_or(ef.active AND ef.flag_type IN ('loi','poi')) AS active
    FROM public.entity_flags ef
    WHERE ef.organization_id = o.organization_id AND ef.entity_type = 'person'
      AND ef.entity_id = o.person_record_id
  ) pf ON true
  WHERE o.organization_id = p_organization_id
    AND public.org_access_allowed(o.organization_id)
    AND (p_site_id IS NULL OR o.site_id = p_site_id)
    AND (p_zone_id IS NULL OR o.zone_id = p_zone_id)
    AND (p_location_id IS NULL OR o.location_id = p_location_id)
    AND (p_vehicle_id IS NULL OR o.canonical_vehicle_id = p_vehicle_id)
    AND (p_person_id IS NULL OR o.person_record_id = p_person_id)
    AND (p_incident_id IS NULL OR o.incident_id = p_incident_id)
    AND (p_poi IS NULL OR COALESCE(vf.active, false) = p_poi)
    AND (p_loi IS NULL OR COALESCE(pf.active, false) = p_loi)
    AND (
      NULLIF(trim(p_search), '') IS NULL OR
      concat_ws(' ', o.plate_number, o.officer_notes, cv.plate_number, cv.make, cv.model,
        pr.display_name, cs.name, z.name, l.name, l.address, l.suburb, l.notes, i.incident_type, i.description,
        o.location_id::text, o.site_id::text, o.zone_id::text) ILIKE '%' || trim(p_search) || '%'
    )
  ORDER BY o.observed_at DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
$$;

REVOKE ALL ON FUNCTION public.link_observation_entities(uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.link_observation_entities(uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.search_observations(uuid, text, uuid, uuid, uuid, uuid, uuid, uuid, boolean, boolean, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_observations(uuid, text, uuid, uuid, uuid, uuid, uuid, uuid, boolean, boolean, integer) TO authenticated, service_role;
