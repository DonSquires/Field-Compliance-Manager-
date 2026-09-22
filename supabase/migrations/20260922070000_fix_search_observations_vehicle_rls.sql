-- Fixes a pre-existing bug in search_observations (from migration 20260908120000): the function
-- is plain SQL, not SECURITY DEFINER, so it runs under the calling user's own RLS context.
-- canonical_vehicles carries only a bob_full_read policy, so for every real (non-Bob) user the
-- direct join to that base table silently returned zero rows - vehicle_label fell back
-- to the observation's raw plate_number instead of the enriched make/model, and the free-text
-- search across cv.plate_number/make/model never matched anything, for every user of the
-- Observation Search page except Bob.
--
-- Fix: join canonical_vehicle_public instead - the same redacted, globally-readable projection
-- every other officer-facing page (VehicleSearchPage, OfficerVehicleLookupPage) already uses.
-- Only plate_number/make/model are read here, all present on the public view; no privilege
-- escalation needed (kept plain SQL, not SECURITY DEFINER).
CREATE OR REPLACE FUNCTION "public"."search_observations"(p_organization_id uuid, p_search text DEFAULT NULL::text, p_site_id uuid DEFAULT NULL::uuid, p_zone_id uuid DEFAULT NULL::uuid, p_location_id uuid DEFAULT NULL::uuid, p_vehicle_id uuid DEFAULT NULL::uuid, p_person_id uuid DEFAULT NULL::uuid, p_incident_id uuid DEFAULT NULL::uuid, p_poi boolean DEFAULT NULL::boolean, p_loi boolean DEFAULT NULL::boolean, p_limit integer DEFAULT 50)
 RETURNS TABLE(observation_id uuid, observed_at timestamp with time zone, organization_id uuid, plate_number text, vehicle_id uuid, vehicle_label text, person_id uuid, person_label text, site_id uuid, site_name text, zone_id uuid, zone_name text, location_id uuid, location_name text, incident_id uuid, incident_label text, poi boolean, loi boolean, compliance_status text, officer_notes text, photo_url text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT o.id, o.observed_at, o.organization_id, o.plate_number,
    o.canonical_vehicle_id,
    COALESCE(NULLIF(trim(concat_ws(' ', cv.plate_number, cv.make, cv.model)), ''), o.plate_number),
    o.person_record_id, pr.display_name, o.site_id, cs.name, o.zone_id, z.name,
    o.location_id, l.name, o.incident_id,
    CASE WHEN i.id IS NULL THEN NULL ELSE concat_ws(': ', i.incident_type, i.description) END,
    COALESCE(vf.active, false), COALESCE(pf.active, false), o.compliance_status,
    o.officer_notes, o.photo_url
  FROM public.observations o
  LEFT JOIN public.canonical_vehicle_public cv ON cv.id = o.canonical_vehicle_id
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
$function$;
