-- Owners recorded through record_vehicle_owner (entity_links) count as identified
-- for the repeat-subject readers, alongside the legacy registered_owner_name.
CREATE OR REPLACE FUNCTION "public"."list_repeat_vehicle_subjects_for_agreement"(p_service_agreement_id uuid, p_min_sightings integer DEFAULT 2, p_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to timestamp with time zone DEFAULT NULL::timestamp with time zone, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0)
 RETURNS TABLE(plate text, sightings bigint, places bigint, officers bigint, patrol_sightings bigint, cctv_sightings bigint, first_seen timestamp with time zone, last_seen timestamp with time zone, owner_identified boolean, total_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_scope_orgs uuid[];
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  v_scope_orgs := private.subject_scope_organizations(p_service_agreement_id);

  RETURN QUERY
  WITH places AS MATERIALIZED (
    SELECT l.zone_id, l.site_id FROM public.service_agreement_locations l
    WHERE l.service_agreement_id = p_service_agreement_id AND l.status = 'active'
  ),
  seen AS (
    SELECT upper(regexp_replace(o.plate_number, '[^A-Za-z0-9]', '', 'g')) pl,
      o.canonical_vehicle_id cv, o.observed_at at,
      coalesce(o.zone_id, o.site_id) place, o.officer_id officer, 'patrol'::text src
    FROM public.observations o
    WHERE o.organization_id = ANY(v_scope_orgs)
      AND o.observed_at <= now() AND (p_from IS NULL OR o.observed_at >= p_from) AND (p_to IS NULL OR o.observed_at < p_to)
      AND (p_service_agreement_id IS NULL OR EXISTS (SELECT 1 FROM places p WHERE (p.zone_id IS NOT NULL AND p.zone_id = o.zone_id) OR (p.site_id IS NOT NULL AND p.site_id = o.site_id)))
    UNION ALL
    SELECT upper(regexp_replace(c.candidate_plate, '[^A-Za-z0-9]', '', 'g')), c.canonical_vehicle_id,
      c.observed_at, coalesce(c.zone_id, c.site_id), NULL::uuid, 'cctv'::text
    FROM public.cctv_entity_observations c
    WHERE c.organization_id = ANY(v_scope_orgs)
      AND c.entity_kind = 'vehicle' AND c.review_state = 'accepted' AND c.candidate_plate IS NOT NULL
      AND c.observed_at <= now() AND (p_from IS NULL OR c.observed_at >= p_from) AND (p_to IS NULL OR c.observed_at < p_to)
      AND (p_service_agreement_id IS NULL OR EXISTS (SELECT 1 FROM places p WHERE (p.zone_id IS NOT NULL AND p.zone_id = c.zone_id) OR (p.site_id IS NOT NULL AND p.site_id = c.site_id)))
  ),
  grouped AS (
    SELECT s.pl, count(*) n, count(DISTINCT s.place) place_count, count(DISTINCT s.officer) officer_count,
      count(*) FILTER (WHERE s.src = 'patrol') patrol_count, count(*) FILTER (WHERE s.src = 'cctv') cctv_count,
      min(s.at) first_at, max(s.at) last_at,
      coalesce(bool_or((EXISTS (SELECT 1 FROM public.canonical_vehicles v WHERE v.id = s.cv AND v.registered_owner_name IS NOT NULL) OR EXISTS (SELECT 1 FROM public.entity_links el WHERE el.to_type = 'vehicle' AND el.to_id = s.cv AND el.from_type = 'person' AND el.active AND el.relationship IN ('owner', 'registered_owner') AND el.organization_id = ANY(v_scope_orgs)))), false) owner_flag
    FROM seen s WHERE s.pl <> '' GROUP BY s.pl
    HAVING count(*) >= greatest(coalesce(p_min_sightings, 2), 1)
  )
  SELECT g.pl, g.n, g.place_count, g.officer_count, g.patrol_count, g.cctv_count,
    g.first_at, g.last_at, g.owner_flag, count(*) OVER ()
  FROM grouped g ORDER BY g.n DESC, g.last_at DESC
  LIMIT least(greatest(coalesce(p_limit, 100), 1), 500) OFFSET greatest(coalesce(p_offset, 0), 0);
END;
$function$;

CREATE OR REPLACE FUNCTION "public"."get_vehicle_subject_details_for_agreement"(p_plate text, p_service_agreement_id uuid)
 RETURNS TABLE(canonical_vehicle_id uuid, plate text, make text, model text, year integer, colour text, body_type text, fuel_type text, owner_identified boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_scope_orgs uuid[];
  v_plate text := upper(regexp_replace(coalesce(p_plate, ''), '[^A-Za-z0-9]', '', 'g'));
BEGIN
  v_scope_orgs := private.subject_scope_organizations(p_service_agreement_id);
  RETURN QUERY
  WITH places AS (
    SELECT l.zone_id, l.site_id FROM public.service_agreement_locations l
    WHERE l.service_agreement_id = p_service_agreement_id AND l.status = 'active'
  ), ids AS (
    SELECT o.canonical_vehicle_id id FROM public.observations o
    WHERE o.organization_id = ANY(v_scope_orgs)
      AND upper(regexp_replace(o.plate_number, '[^A-Za-z0-9]', '', 'g')) = v_plate
      AND (p_service_agreement_id IS NULL OR EXISTS (SELECT 1 FROM places p WHERE (p.zone_id IS NOT NULL AND p.zone_id = o.zone_id) OR (p.site_id IS NOT NULL AND p.site_id = o.site_id)))
    UNION
    SELECT c.canonical_vehicle_id FROM public.cctv_entity_observations c
    WHERE c.organization_id = ANY(v_scope_orgs) AND c.entity_kind = 'vehicle' AND c.review_state = 'accepted'
      AND upper(regexp_replace(coalesce(c.candidate_plate, ''), '[^A-Za-z0-9]', '', 'g')) = v_plate
      AND (p_service_agreement_id IS NULL OR EXISTS (SELECT 1 FROM places p WHERE (p.zone_id IS NOT NULL AND p.zone_id = c.zone_id) OR (p.site_id IS NOT NULL AND p.site_id = c.site_id)))
  )
  SELECT v.id, v.plate_number, v.make, v.model, v.year, v.colour, v.body_type, v.fuel_type,
    (v.registered_owner_name IS NOT NULL OR EXISTS (SELECT 1 FROM public.entity_links el WHERE el.to_type = 'vehicle' AND el.to_id = v.id AND el.from_type = 'person' AND el.active AND el.relationship IN ('owner', 'registered_owner') AND el.organization_id = ANY(v_scope_orgs)))
  FROM ids JOIN public.canonical_vehicles v ON v.id = ids.id
  ORDER BY v.last_seen_at DESC NULLS LAST LIMIT 1;
END;
$function$;
