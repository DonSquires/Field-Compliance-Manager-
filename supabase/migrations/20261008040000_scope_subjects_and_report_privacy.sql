CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA private TO authenticated;
GRANT USAGE ON SCHEMA private TO service_role;

CREATE OR REPLACE FUNCTION private.rnm_admin_for_organization(p_target_organization_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_profiles actor
    WHERE actor.id = (SELECT auth.uid())
      AND actor.deactivated_at IS NULL
      AND actor.role IN ('admin', 'master', 'grand_master')
      AND p_target_organization_id IS NOT NULL
      AND (
        p_target_organization_id = 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid
        OR p_target_organization_id = ANY(public.get_descendant_organizations('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid))
      )
      AND (
        actor.role = 'grand_master'
        OR actor.organization_id = 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid
        OR actor.organization_id = ANY(public.get_descendant_organizations('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid))
        OR actor.employer_organization_id = ANY(public.get_descendant_organizations('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid))
      )
      AND public.is_admin_for_org(p_target_organization_id)
  );
$function$;
REVOKE ALL ON FUNCTION private.rnm_admin_for_organization(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.rnm_admin_for_organization(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.can_manage_r_and_m_identity()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_profiles actor
    WHERE actor.id = (SELECT auth.uid())
      AND actor.deactivated_at IS NULL
      AND actor.role IN ('admin', 'master', 'grand_master')
      AND (
        actor.role = 'grand_master'
        OR actor.organization_id = 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid
        OR actor.organization_id = ANY(public.get_descendant_organizations('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid))
        OR actor.employer_organization_id = ANY(public.get_descendant_organizations('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid))
      )
  );
$function$;
REVOKE ALL ON FUNCTION public.can_manage_r_and_m_identity() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_r_and_m_identity() TO authenticated;

CREATE OR REPLACE FUNCTION public.list_verified_person_projections_for_organization(p_organization_id uuid)
RETURNS TABLE(id uuid, canonical_person_id uuid, display_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_rnm_orgs uuid[] := ARRAY['e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid] || public.get_descendant_organizations('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid);
BEGIN
  IF auth.uid() IS NULL OR NOT private.rnm_admin_for_organization(p_organization_id) OR NOT (p_organization_id = ANY(v_rnm_orgs)) THEN
    RAISE EXCEPTION 'R&M administrator access to this organization is required';
  END IF;
  RETURN QUERY
  SELECT pr.id, cp.id, cp.display_name
  FROM public.person_records pr
  JOIN public.canonical_person_links cpl ON cpl.source_table='person_records' AND cpl.source_id=pr.id AND cpl.organization_id=pr.organization_id
  JOIN public.canonical_people cp ON cp.id=cpl.canonical_person_id AND cp.review_state='verified' AND cp.status='active'
  WHERE pr.organization_id=p_organization_id AND pr.review_state='verified'
  ORDER BY cp.display_name NULLS LAST, pr.id;
END;
$function$;
REVOKE ALL ON FUNCTION public.list_verified_person_projections_for_organization(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_verified_person_projections_for_organization(uuid) TO authenticated;

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
RETURNS TABLE(
  observation_id uuid, observed_at timestamptz, organization_id uuid, plate_number text,
  vehicle_id uuid, vehicle_label text, vehicle_homeless_status text,
  person_id uuid, person_label text, person_category text, person_homeless_status text,
  site_id uuid, site_name text, zone_id uuid, zone_name text,
  location_id uuid, location_name text, incident_id uuid, incident_label text,
  poi boolean, loi boolean, compliance_status text, officer_notes text, photo_url text
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $function$
  WITH identity_scope AS MATERIALIZED (
    SELECT private.rnm_admin_for_organization(p_organization_id) AS can_view
  )
  SELECT o.id, o.observed_at, o.organization_id, o.plate_number,
    o.canonical_vehicle_id,
    COALESCE(NULLIF(trim(concat_ws(' ', cv.plate_number, cv.make, cv.model)), ''), o.plate_number),
    NULLIF(cv.homeless_status, 'none'),
    CASE WHEN identity_scope.can_view AND cpp.id IS NOT NULL THEN o.person_record_id END,
    CASE WHEN identity_scope.can_view AND cpp.id IS NOT NULL THEN cpp.display_name END,
    CASE WHEN identity_scope.can_view AND cpp.id IS NOT NULL THEN NULLIF(pr.metadata -> 'profile_details' ->> 'category', '') END,
    CASE WHEN identity_scope.can_view AND cpp.id IS NOT NULL THEN NULLIF(cpp.homeless_status, 'none') END,
    o.site_id, cs.name, o.zone_id, z.name,
    o.location_id, l.name, o.incident_id,
    CASE WHEN i.id IS NULL THEN NULL ELSE concat_ws(': ', i.incident_type, i.description) END,
    COALESCE(vf.active, false), COALESCE(pf.active, false), o.compliance_status,
    o.officer_notes, o.photo_url
  FROM public.observations o
  CROSS JOIN identity_scope
  LEFT JOIN public.canonical_vehicle_public cv ON cv.id = o.canonical_vehicle_id
  LEFT JOIN public.person_records pr ON pr.id = o.person_record_id AND pr.organization_id=o.organization_id AND pr.review_state='verified' AND identity_scope.can_view
  LEFT JOIN LATERAL (
    SELECT cpl.canonical_person_id FROM public.canonical_person_links cpl
    WHERE identity_scope.can_view AND cpl.source_table = 'person_records' AND cpl.source_id = pr.id AND cpl.organization_id=pr.organization_id
    LIMIT 1
  ) link ON true
  LEFT JOIN public.canonical_person_public cpp ON identity_scope.can_view AND cpp.id = COALESCE(o.canonical_person_id,link.canonical_person_id) AND cpp.review_state='verified' AND cpp.status='active'
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
    WHERE identity_scope.can_view AND ef.organization_id = o.organization_id AND ef.entity_type = 'person'
      AND ef.entity_id = o.person_record_id
  ) pf ON true
  WHERE o.organization_id = p_organization_id
    AND public.org_access_allowed(o.organization_id)
    AND (p_site_id IS NULL OR o.site_id = p_site_id)
    AND (p_zone_id IS NULL OR o.zone_id = p_zone_id)
    AND (p_location_id IS NULL OR o.location_id = p_location_id)
    AND (p_vehicle_id IS NULL OR o.canonical_vehicle_id = p_vehicle_id)
    AND (p_person_id IS NULL OR (identity_scope.can_view AND (o.person_record_id = p_person_id OR COALESCE(o.canonical_person_id,link.canonical_person_id) = p_person_id)))
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

CREATE OR REPLACE FUNCTION public.link_observation_entities(
  p_observation_id uuid,
  p_organization_id uuid,
  p_canonical_vehicle_id uuid DEFAULT NULL,
  p_person_record_id uuid DEFAULT NULL,
  p_site_id uuid DEFAULT NULL,
  p_zone_id uuid DEFAULT NULL,
  p_location_id uuid DEFAULT NULL,
  p_incident_id uuid DEFAULT NULL,
  p_identity_basis text DEFAULT NULL
)
RETURNS public.observations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  result public.observations;
  v_previous_person uuid;
  v_previous_vehicle uuid;
  v_plate text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.org_access_allowed(p_organization_id) THEN
    RAISE EXCEPTION 'Observation access denied';
  END IF;
  IF (p_person_record_id IS NOT NULL OR p_canonical_vehicle_id IS NOT NULL)
     AND NOT private.rnm_admin_for_organization(p_organization_id) THEN
    RAISE EXCEPTION 'R&M administrator, master or grandmaster access required for identity links';
  END IF;
  SELECT o.person_record_id, o.canonical_vehicle_id INTO v_previous_person, v_previous_vehicle
  FROM public.observations o WHERE o.id = p_observation_id AND o.organization_id = p_organization_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Observation not found'; END IF;
  IF p_person_record_id IS NOT NULL AND p_person_record_id IS DISTINCT FROM v_previous_person
     AND nullif(trim(coalesce(p_identity_basis, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Record the basis for identifying this person';
  END IF;
  IF p_person_record_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.person_records pr
    JOIN public.canonical_person_links cpl ON cpl.source_table = 'person_records' AND cpl.source_id = pr.id AND cpl.organization_id = pr.organization_id
    JOIN public.canonical_people cp ON cp.id = cpl.canonical_person_id AND cp.review_state = 'verified' AND cp.status = 'active'
    WHERE pr.id = p_person_record_id AND pr.organization_id = p_organization_id AND pr.review_state = 'verified'
  ) THEN RAISE EXCEPTION 'Select a verified person record with a verified canonical identity'; END IF;
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
  IF p_canonical_vehicle_id IS NOT NULL THEN
    SELECT upper(regexp_replace(o.plate_number, '[^A-Za-z0-9]', '', 'g')) INTO v_plate
    FROM public.observations o
    WHERE o.id = p_observation_id AND o.organization_id = p_organization_id;
    IF v_plate IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.canonical_vehicles v
      WHERE v.id = p_canonical_vehicle_id
        AND upper(regexp_replace(v.plate_number, '[^A-Za-z0-9]', '', 'g')) = v_plate
    ) THEN RAISE EXCEPTION 'Canonical vehicle plate does not match the observation'; END IF;
  END IF;

  UPDATE public.observations
  SET canonical_vehicle_id = COALESCE(p_canonical_vehicle_id, canonical_vehicle_id),
      person_record_id = COALESCE(p_person_record_id, person_record_id),
      site_id = COALESCE(p_site_id, site_id),
      zone_id = COALESCE(p_zone_id, zone_id),
      location_id = COALESCE(p_location_id, location_id),
      incident_id = COALESCE(p_incident_id, incident_id)
  WHERE id = p_observation_id AND organization_id = p_organization_id
  RETURNING * INTO result;

  IF result.person_record_id IS DISTINCT FROM v_previous_person OR result.canonical_vehicle_id IS DISTINCT FROM v_previous_vehicle THEN
    INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
    VALUES (p_organization_id, auth.uid(), 'observation_identity_linked', 'observations', p_observation_id,
      jsonb_strip_nulls(jsonb_build_object(
        'previous_person_record_id', v_previous_person,
        'person_record_id', result.person_record_id,
        'previous_canonical_vehicle_id', v_previous_vehicle,
        'canonical_vehicle_id', result.canonical_vehicle_id,
        'identity_basis', nullif(trim(coalesce(p_identity_basis, '')), '')
      )));
  END IF;
  RETURN result;
END;
$function$;
DROP FUNCTION IF EXISTS public.link_observation_entities(uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid);
REVOKE ALL ON FUNCTION public.link_observation_entities(uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.link_observation_entities(uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.list_repeat_vehicle_subjects_for_agreement(
  p_service_agreement_id uuid,
  p_min_sightings integer DEFAULT 2,
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL,
  p_limit integer DEFAULT 100,
  p_offset integer DEFAULT 0
) RETURNS TABLE (
  plate text, sightings bigint, places bigint, officers bigint, patrol_sightings bigint,
  cctv_sightings bigint, first_seen timestamptz, last_seen timestamptz,
  owner_identified boolean, total_count bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_provider uuid;
  v_rnm_orgs uuid[] := ARRAY['e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid] || public.get_descendant_organizations('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid);
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT sa.provider_organization_id INTO v_provider FROM public.service_agreements sa
  WHERE sa.id = p_service_agreement_id AND sa.agreement_type = 'operational' AND sa.invitation_status = 'accepted';
  IF v_provider IS NULL OR NOT private.rnm_admin_for_organization(v_provider) THEN
    RAISE EXCEPTION 'R&M administrator access to this agreement is required';
  END IF;

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
    WHERE o.organization_id = ANY(v_rnm_orgs)
      AND o.observed_at <= now() AND (p_from IS NULL OR o.observed_at >= p_from) AND (p_to IS NULL OR o.observed_at < p_to)
      AND EXISTS (SELECT 1 FROM places p WHERE (p.zone_id IS NOT NULL AND p.zone_id = o.zone_id) OR (p.site_id IS NOT NULL AND p.site_id = o.site_id))
    UNION ALL
    SELECT upper(regexp_replace(c.candidate_plate, '[^A-Za-z0-9]', '', 'g')), c.canonical_vehicle_id,
      c.observed_at, coalesce(c.zone_id, c.site_id), NULL::uuid, 'cctv'::text
    FROM public.cctv_entity_observations c
    WHERE c.organization_id = ANY(v_rnm_orgs)
      AND c.entity_kind = 'vehicle' AND c.review_state = 'accepted' AND c.candidate_plate IS NOT NULL
      AND c.observed_at <= now() AND (p_from IS NULL OR c.observed_at >= p_from) AND (p_to IS NULL OR c.observed_at < p_to)
      AND EXISTS (SELECT 1 FROM places p WHERE (p.zone_id IS NOT NULL AND p.zone_id = c.zone_id) OR (p.site_id IS NOT NULL AND p.site_id = c.site_id))
  ),
  grouped AS (
    SELECT s.pl, count(*) n, count(DISTINCT s.place) place_count, count(DISTINCT s.officer) officer_count,
      count(*) FILTER (WHERE s.src = 'patrol') patrol_count, count(*) FILTER (WHERE s.src = 'cctv') cctv_count,
      min(s.at) first_at, max(s.at) last_at,
      coalesce(bool_or(EXISTS (SELECT 1 FROM public.canonical_vehicles v WHERE v.id = s.cv AND v.registered_owner_name IS NOT NULL)), false) owner_flag
    FROM seen s WHERE s.pl <> '' GROUP BY s.pl
    HAVING count(*) >= greatest(coalesce(p_min_sightings, 2), 1)
  )
  SELECT g.pl, g.n, g.place_count, g.officer_count, g.patrol_count, g.cctv_count,
    g.first_at, g.last_at, g.owner_flag, count(*) OVER ()
  FROM grouped g ORDER BY g.n DESC, g.last_at DESC
  LIMIT least(greatest(coalesce(p_limit, 100), 1), 500) OFFSET greatest(coalesce(p_offset, 0), 0);
END;
$function$;
REVOKE ALL ON FUNCTION public.list_repeat_vehicle_subjects_for_agreement(uuid, integer, timestamptz, timestamptz, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_repeat_vehicle_subjects_for_agreement(uuid, integer, timestamptz, timestamptz, integer, integer) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.list_repeat_vehicle_subjects(integer, timestamptz, timestamptz, integer, integer);

CREATE OR REPLACE FUNCTION public.get_vehicle_subject_details_for_agreement(p_plate text, p_service_agreement_id uuid)
RETURNS TABLE(canonical_vehicle_id uuid, plate text, make text, model text, year integer, colour text, body_type text, fuel_type text, owner_identified boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_provider uuid;
  v_rnm_orgs uuid[] := ARRAY['e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid] || public.get_descendant_organizations('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid);
  v_plate text := upper(regexp_replace(coalesce(p_plate, ''), '[^A-Za-z0-9]', '', 'g'));
BEGIN
  SELECT sa.provider_organization_id INTO v_provider FROM public.service_agreements sa
  WHERE sa.id = p_service_agreement_id AND sa.agreement_type = 'operational' AND sa.invitation_status = 'accepted';
  IF auth.uid() IS NULL OR v_provider IS NULL OR NOT private.rnm_admin_for_organization(v_provider) THEN
    RAISE EXCEPTION 'R&M administrator access to this agreement is required';
  END IF;
  RETURN QUERY
  WITH places AS (
    SELECT l.zone_id, l.site_id FROM public.service_agreement_locations l
    WHERE l.service_agreement_id = p_service_agreement_id AND l.status = 'active'
  ), ids AS (
    SELECT o.canonical_vehicle_id id FROM public.observations o
    WHERE o.organization_id = ANY(v_rnm_orgs)
      AND upper(regexp_replace(o.plate_number, '[^A-Za-z0-9]', '', 'g')) = v_plate
      AND EXISTS (SELECT 1 FROM places p WHERE (p.zone_id IS NOT NULL AND p.zone_id = o.zone_id) OR (p.site_id IS NOT NULL AND p.site_id = o.site_id))
    UNION
    SELECT c.canonical_vehicle_id FROM public.cctv_entity_observations c
    WHERE c.organization_id = ANY(v_rnm_orgs) AND c.entity_kind = 'vehicle' AND c.review_state = 'accepted'
      AND upper(regexp_replace(coalesce(c.candidate_plate, ''), '[^A-Za-z0-9]', '', 'g')) = v_plate
      AND EXISTS (SELECT 1 FROM places p WHERE (p.zone_id IS NOT NULL AND p.zone_id = c.zone_id) OR (p.site_id IS NOT NULL AND p.site_id = c.site_id))
  )
  SELECT v.id, v.plate_number, v.make, v.model, v.year, v.colour, v.body_type, v.fuel_type,
    v.registered_owner_name IS NOT NULL
  FROM ids JOIN public.canonical_vehicles v ON v.id = ids.id
  ORDER BY v.last_seen_at DESC NULLS LAST LIMIT 1;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_vehicle_subject_details_for_agreement(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_vehicle_subject_details_for_agreement(text, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.list_vehicle_subject_history_for_agreement(p_plate text, p_service_agreement_id uuid, p_limit integer DEFAULT 200)
RETURNS TABLE(source text, record_id uuid, organization_id uuid, observed_at timestamptz, place_id uuid, officer_id uuid, note text, canonical_vehicle_id uuid, evidence_item_id uuid, compliance_status text, compliance_reason text, photo_url text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_provider uuid;
  v_rnm_orgs uuid[] := ARRAY['e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid] || public.get_descendant_organizations('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid);
  v_plate text := upper(regexp_replace(coalesce(p_plate, ''), '[^A-Za-z0-9]', '', 'g'));
BEGIN
  SELECT sa.provider_organization_id INTO v_provider FROM public.service_agreements sa
  WHERE sa.id = p_service_agreement_id AND sa.agreement_type = 'operational' AND sa.invitation_status = 'accepted';
  IF auth.uid() IS NULL OR v_provider IS NULL OR NOT private.rnm_admin_for_organization(v_provider) THEN
    RAISE EXCEPTION 'R&M administrator access to this agreement is required';
  END IF;
  IF v_plate = '' THEN RETURN; END IF;
  RETURN QUERY
  WITH places AS MATERIALIZED (
    SELECT l.zone_id, l.site_id FROM public.service_agreement_locations l
    WHERE l.service_agreement_id = p_service_agreement_id AND l.status = 'active'
  )
  SELECT * FROM (
    SELECT 'patrol'::text, o.id, o.organization_id, o.observed_at, coalesce(o.zone_id, o.site_id), o.officer_id,
      o.officer_notes, o.canonical_vehicle_id,
      (SELECT e.id FROM public.evidence_items e WHERE e.organization_id = o.organization_id AND e.metadata->>'observation_id' = o.id::text ORDER BY e.captured_at DESC LIMIT 1),
      CASE WHEN o.is_compliant IS NULL THEN NULL WHEN o.is_compliant THEN 'compliant' ELSE 'non_compliant' END,
      o.compliance_reason, o.photo_url
    FROM public.observations o
    WHERE o.organization_id = ANY(v_rnm_orgs)
      AND upper(regexp_replace(o.plate_number, '[^A-Za-z0-9]', '', 'g')) = v_plate AND o.observed_at <= now()
      AND EXISTS (SELECT 1 FROM places p WHERE (p.zone_id IS NOT NULL AND p.zone_id = o.zone_id) OR (p.site_id IS NOT NULL AND p.site_id = o.site_id))
    UNION ALL
    SELECT 'cctv'::text, c.id, c.organization_id, c.observed_at, coalesce(c.zone_id, c.site_id), NULL::uuid,
      nullif(concat_ws(' · ', c.candidate_label, c.attributes->>'description'), ''), c.canonical_vehicle_id, c.evidence_item_id,
      NULL::text, NULL::text, NULL::text
    FROM public.cctv_entity_observations c
    WHERE c.organization_id = ANY(v_rnm_orgs) AND c.entity_kind = 'vehicle' AND c.review_state = 'accepted' AND c.observed_at <= now()
      AND upper(regexp_replace(coalesce(c.candidate_plate, ''), '[^A-Za-z0-9]', '', 'g')) = v_plate
      AND EXISTS (SELECT 1 FROM places p WHERE (p.zone_id IS NOT NULL AND p.zone_id = c.zone_id) OR (p.site_id IS NOT NULL AND p.site_id = c.site_id))
    UNION ALL
    SELECT 'patrol_comment'::text, e.id, e.organization_id, e.occurred_at, coalesce(e.zone_id, e.client_site_id), NULL::uuid,
      e.payload->>'comments', NULL::uuid, NULL::uuid, NULL::text, e.payload->>'issue', NULL::text
    FROM public.location_events e
    WHERE e.organization_id = ANY(v_rnm_orgs) AND e.occurred_at <= now() AND e.payload->>'comments' ILIKE '%' || v_plate || '%'
      AND EXISTS (SELECT 1 FROM places p WHERE (p.zone_id IS NOT NULL AND p.zone_id = e.zone_id) OR (p.site_id IS NOT NULL AND p.site_id = e.client_site_id))
      AND NOT EXISTS (SELECT 1 FROM public.observations o WHERE o.external_refs->>'external_ref' = e.external_ref AND o.organization_id = e.organization_id)
  ) history
  ORDER BY observed_at DESC
  LIMIT least(greatest(coalesce(p_limit, 200), 1), 500);
END;
$function$;
REVOKE ALL ON FUNCTION public.list_vehicle_subject_history_for_agreement(text, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_vehicle_subject_history_for_agreement(text, uuid, integer) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.list_vehicle_subject_history(text, integer);

CREATE OR REPLACE FUNCTION public.list_unlinked_plate_mentions_for_agreement(p_service_agreement_id uuid, p_from timestamptz DEFAULT NULL, p_to timestamptz DEFAULT NULL, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0)
RETURNS TABLE(plate text, mentions bigint, first_seen timestamptz, last_seen timestamptz, total_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE v_provider uuid;
  v_rnm_orgs uuid[] := ARRAY['e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid] || public.get_descendant_organizations('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid);
BEGIN
  SELECT sa.provider_organization_id INTO v_provider FROM public.service_agreements sa
  WHERE sa.id = p_service_agreement_id AND sa.agreement_type = 'operational' AND sa.invitation_status = 'accepted';
  IF auth.uid() IS NULL OR v_provider IS NULL OR NOT private.rnm_admin_for_organization(v_provider) THEN
    RAISE EXCEPTION 'R&M administrator access to this agreement is required';
  END IF;
  RETURN QUERY
  WITH places AS MATERIALIZED (
    SELECT l.zone_id, l.site_id FROM public.service_agreement_locations l WHERE l.service_agreement_id = p_service_agreement_id AND l.status = 'active'
  ), mentions AS (
    SELECT upper(regexp_replace(m.plate[1], '[^A-Za-z0-9]', '', 'g')) plate, e.id, e.occurred_at
    FROM public.location_events e
    CROSS JOIN LATERAL regexp_matches(coalesce(e.payload->>'comments',''), '\m([A-Z]{3}[0-9]{3})\M', 'gi') AS m(plate)
    WHERE e.organization_id = ANY(v_rnm_orgs) AND e.occurred_at <= now() AND (p_from IS NULL OR e.occurred_at >= p_from) AND (p_to IS NULL OR e.occurred_at < p_to)
      AND EXISTS (SELECT 1 FROM places p WHERE (p.zone_id IS NOT NULL AND p.zone_id = e.zone_id) OR (p.site_id IS NOT NULL AND p.site_id = e.client_site_id))
      AND NOT EXISTS (SELECT 1 FROM public.observations o WHERE upper(regexp_replace(o.plate_number,'[^A-Za-z0-9]','','g')) = upper(regexp_replace(m.plate[1],'[^A-Za-z0-9]','','g')) AND (o.zone_id=e.zone_id OR o.site_id=e.client_site_id))
      AND NOT EXISTS (SELECT 1 FROM public.cctv_entity_observations c WHERE c.review_state='accepted' AND upper(regexp_replace(coalesce(c.candidate_plate,''),'[^A-Za-z0-9]','','g')) = upper(regexp_replace(m.plate[1],'[^A-Za-z0-9]','','g')) AND (c.zone_id=e.zone_id OR c.site_id=e.client_site_id))
  ), grouped AS (
    SELECT m.plate, count(*) n, min(m.occurred_at) first_at, max(m.occurred_at) last_at FROM mentions m GROUP BY m.plate
  )
  SELECT g.plate, g.n, g.first_at, g.last_at, count(*) over () FROM grouped g ORDER BY g.n DESC, g.last_at DESC
  LIMIT least(greatest(coalesce(p_limit,100),1),500) OFFSET greatest(coalesce(p_offset,0),0);
END;
$function$;
REVOKE ALL ON FUNCTION public.list_unlinked_plate_mentions_for_agreement(uuid, timestamptz, timestamptz, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_unlinked_plate_mentions_for_agreement(uuid, timestamptz, timestamptz, integer, integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.list_repeat_person_subjects_for_agreement(
  p_service_agreement_id uuid,
  p_min_sightings integer DEFAULT 2,
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL,
  p_limit integer DEFAULT 100,
  p_offset integer DEFAULT 0
) RETURNS TABLE(canonical_person_id uuid, display_name text, sightings bigint, places bigint, patrol_sightings bigint, cctv_sightings bigint, first_seen timestamptz, last_seen timestamptz, total_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_provider uuid;
  v_rnm_orgs uuid[] := ARRAY['e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid] || public.get_descendant_organizations('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid);
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT sa.provider_organization_id INTO v_provider FROM public.service_agreements sa
  WHERE sa.id=p_service_agreement_id AND sa.agreement_type='operational' AND sa.invitation_status='accepted';
  IF v_provider IS NULL OR NOT private.rnm_admin_for_organization(v_provider) THEN RAISE EXCEPTION 'R&M administrator access to this agreement is required'; END IF;
  RETURN QUERY
  WITH places AS MATERIALIZED (
    SELECT l.zone_id,l.site_id FROM public.service_agreement_locations l WHERE l.service_agreement_id=p_service_agreement_id AND l.status='active'
  ), seen AS (
    SELECT coalesce(o.canonical_person_id,cpl.canonical_person_id) person_id, coalesce(o.zone_id,o.site_id) place, o.observed_at at, 'patrol'::text src
    FROM public.observations o
    JOIN public.person_records pr ON pr.id=o.person_record_id AND pr.organization_id=o.organization_id AND pr.review_state='verified'
    LEFT JOIN public.canonical_person_links cpl ON cpl.source_table='person_records' AND cpl.source_id=o.person_record_id AND cpl.organization_id=o.organization_id
    JOIN public.canonical_people cp ON cp.id=coalesce(o.canonical_person_id,cpl.canonical_person_id) AND cp.review_state='verified' AND cp.status='active'
    WHERE o.organization_id=ANY(v_rnm_orgs) AND o.person_record_id IS NOT NULL AND o.observed_at<=now()
      AND (p_from IS NULL OR o.observed_at>=p_from) AND (p_to IS NULL OR o.observed_at<p_to)
      AND EXISTS (SELECT 1 FROM places p WHERE (p.zone_id IS NOT NULL AND p.zone_id=o.zone_id) OR (p.site_id IS NOT NULL AND p.site_id=o.site_id))
    UNION ALL
    SELECT coalesce(c.canonical_person_id,cpl.canonical_person_id), coalesce(c.zone_id,c.site_id), c.observed_at, 'cctv'::text
    FROM public.cctv_entity_observations c
    JOIN public.person_records pr ON pr.id=c.person_record_id AND pr.organization_id=c.organization_id AND pr.review_state='verified'
    LEFT JOIN public.canonical_person_links cpl ON cpl.source_table='person_records' AND cpl.source_id=c.person_record_id AND cpl.organization_id=c.organization_id
    JOIN public.canonical_people cp ON cp.id=coalesce(c.canonical_person_id,cpl.canonical_person_id) AND cp.review_state='verified' AND cp.status='active'
    WHERE c.organization_id=ANY(v_rnm_orgs) AND c.entity_kind='person' AND c.review_state='accepted'
      AND c.person_record_id IS NOT NULL AND c.observed_at<=now()
      AND (p_from IS NULL OR c.observed_at>=p_from) AND (p_to IS NULL OR c.observed_at<p_to)
      AND EXISTS (SELECT 1 FROM places p WHERE (p.zone_id IS NOT NULL AND p.zone_id=c.zone_id) OR (p.site_id IS NOT NULL AND p.site_id=c.site_id))
  ), grouped AS (
    SELECT s.person_id, count(*) n, count(DISTINCT s.place) place_count,
      count(*) FILTER (WHERE s.src='patrol') patrol_count, count(*) FILTER (WHERE s.src='cctv') cctv_count,
      min(s.at) first_at, max(s.at) last_at
    FROM seen s GROUP BY s.person_id HAVING count(*)>=greatest(coalesce(p_min_sightings,2),1)
  )
  SELECT g.person_id, cp.display_name, g.n, g.place_count, g.patrol_count, g.cctv_count, g.first_at, g.last_at, count(*) OVER ()
  FROM grouped g JOIN public.canonical_person_public cp ON cp.id=g.person_id AND cp.review_state='verified' AND cp.status='active'
  ORDER BY g.n DESC,g.last_at DESC LIMIT least(greatest(coalesce(p_limit,100),1),500) OFFSET greatest(coalesce(p_offset,0),0);
END;
$function$;
REVOKE ALL ON FUNCTION public.list_repeat_person_subjects_for_agreement(uuid, integer, timestamptz, timestamptz, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_repeat_person_subjects_for_agreement(uuid, integer, timestamptz, timestamptz, integer, integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.list_person_subject_history_for_agreement(p_canonical_person_id uuid, p_service_agreement_id uuid, p_limit integer DEFAULT 200)
RETURNS TABLE(source text, record_id uuid, organization_id uuid, observed_at timestamptz, place_id uuid, plate text, note text, evidence_item_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_provider uuid;
  v_rnm_orgs uuid[] := ARRAY['e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid] || public.get_descendant_organizations('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid);
BEGIN
  SELECT sa.provider_organization_id INTO v_provider FROM public.service_agreements sa
  WHERE sa.id=p_service_agreement_id AND sa.agreement_type='operational' AND sa.invitation_status='accepted';
  IF auth.uid() IS NULL OR v_provider IS NULL OR NOT private.rnm_admin_for_organization(v_provider) THEN RAISE EXCEPTION 'R&M administrator access to this agreement is required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.canonical_people cp WHERE cp.id=p_canonical_person_id AND cp.review_state='verified' AND cp.status='active') THEN RAISE EXCEPTION 'Verified canonical person is not available'; END IF;
  RETURN QUERY
  WITH places AS MATERIALIZED (SELECT l.zone_id,l.site_id FROM public.service_agreement_locations l WHERE l.service_agreement_id=p_service_agreement_id AND l.status='active')
  SELECT * FROM (
    SELECT 'patrol'::text,o.id,o.organization_id,o.observed_at,coalesce(o.zone_id,o.site_id),o.plate_number,o.officer_notes,
      (SELECT e.id FROM public.evidence_items e WHERE e.organization_id=o.organization_id AND e.metadata->>'observation_id'=o.id::text ORDER BY e.captured_at DESC LIMIT 1)
    FROM public.observations o
    JOIN public.person_records pr ON pr.id=o.person_record_id AND pr.organization_id=o.organization_id AND pr.review_state='verified'
    LEFT JOIN public.canonical_person_links cpl ON cpl.source_table='person_records' AND cpl.source_id=o.person_record_id AND cpl.organization_id=o.organization_id
    WHERE o.organization_id=ANY(v_rnm_orgs) AND coalesce(o.canonical_person_id,cpl.canonical_person_id)=p_canonical_person_id AND o.observed_at<=now()
      AND EXISTS (SELECT 1 FROM places p WHERE (p.zone_id IS NOT NULL AND p.zone_id=o.zone_id) OR (p.site_id IS NOT NULL AND p.site_id=o.site_id))
    UNION ALL
    SELECT 'cctv'::text,c.id,c.organization_id,c.observed_at,coalesce(c.zone_id,c.site_id),c.candidate_plate,
      nullif(concat_ws(' · ',c.candidate_label,c.attributes->>'description'),''),c.evidence_item_id
    FROM public.cctv_entity_observations c
    JOIN public.person_records pr ON pr.id=c.person_record_id AND pr.organization_id=c.organization_id AND pr.review_state='verified'
    LEFT JOIN public.canonical_person_links cpl ON cpl.source_table='person_records' AND cpl.source_id=c.person_record_id AND cpl.organization_id=c.organization_id
    WHERE c.organization_id=ANY(v_rnm_orgs) AND c.entity_kind='person' AND c.review_state='accepted'
      AND coalesce(c.canonical_person_id,cpl.canonical_person_id)=p_canonical_person_id AND c.observed_at<=now()
      AND EXISTS (SELECT 1 FROM places p WHERE (p.zone_id IS NOT NULL AND p.zone_id=c.zone_id) OR (p.site_id IS NOT NULL AND p.site_id=c.site_id))
  ) h ORDER BY observed_at DESC LIMIT least(greatest(coalesce(p_limit,200),1),500);
END;
$function$;
REVOKE ALL ON FUNCTION public.list_person_subject_history_for_agreement(uuid, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_person_subject_history_for_agreement(uuid, uuid, integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION private.agreement_subject_summary(p_service_agreement_id uuid, p_from timestamptz, p_to timestamptz)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE v_provider uuid; v_repeats integer; v_multi_place integer; v_owner_count integer; v_person_count integer; v_evidence_count integer; v_action_count integer;
  v_rnm_orgs uuid[] := ARRAY['e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid] || public.get_descendant_organizations('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid);
BEGIN
  SELECT sa.provider_organization_id INTO v_provider FROM public.service_agreements sa WHERE sa.id=p_service_agreement_id;
  IF v_provider IS NULL OR NOT (v_provider = ANY(v_rnm_orgs)) THEN RETURN '{}'::jsonb; END IF;
  WITH places AS MATERIALIZED (
    SELECT l.zone_id,l.site_id FROM public.service_agreement_locations l WHERE l.service_agreement_id=p_service_agreement_id AND l.status='active'
  ), seen AS (
    SELECT upper(regexp_replace(o.plate_number,'[^A-Za-z0-9]','','g')) plate, coalesce(o.zone_id,o.site_id) place, o.canonical_vehicle_id cv
    FROM public.observations o WHERE o.organization_id = ANY(v_rnm_orgs) AND o.observed_at>=p_from AND o.observed_at<p_to AND o.observed_at<=now()
      AND EXISTS (SELECT 1 FROM places p WHERE (p.zone_id IS NOT NULL AND p.zone_id=o.zone_id) OR (p.site_id IS NOT NULL AND p.site_id=o.site_id))
    UNION ALL
    SELECT upper(regexp_replace(c.candidate_plate,'[^A-Za-z0-9]','','g')), coalesce(c.zone_id,c.site_id), c.canonical_vehicle_id
    FROM public.cctv_entity_observations c WHERE c.organization_id = ANY(v_rnm_orgs) AND c.entity_kind='vehicle' AND c.review_state='accepted' AND c.candidate_plate IS NOT NULL
      AND c.observed_at>=p_from AND c.observed_at<p_to AND c.observed_at<=now()
      AND EXISTS (SELECT 1 FROM places p WHERE (p.zone_id IS NOT NULL AND p.zone_id=c.zone_id) OR (p.site_id IS NOT NULL AND p.site_id=c.site_id))
  ), groups AS (
    SELECT plate, count(*) n, count(DISTINCT place) places,
      bool_or(EXISTS (SELECT 1 FROM public.canonical_vehicles v WHERE v.id=seen.cv AND v.registered_owner_name IS NOT NULL)) owner_flag
    FROM seen WHERE plate<>'' GROUP BY plate
  )
  SELECT count(*) FILTER (WHERE n>=2), count(*) FILTER (WHERE n>=2 AND places>1), count(*) FILTER (WHERE n>=1 AND owner_flag)
  INTO v_repeats,v_multi_place,v_owner_count FROM groups;
  WITH places AS MATERIALIZED (
    SELECT l.zone_id,l.site_id FROM public.service_agreement_locations l WHERE l.service_agreement_id=p_service_agreement_id AND l.status='active'
  ), identified AS (
    SELECT coalesce(o.canonical_person_id,cpl.canonical_person_id) person_id FROM public.observations o
    JOIN public.person_records pr ON pr.id=o.person_record_id AND pr.organization_id=o.organization_id AND pr.review_state='verified'
    LEFT JOIN public.canonical_person_links cpl ON cpl.source_table='person_records' AND cpl.source_id=o.person_record_id AND cpl.organization_id=o.organization_id
    JOIN public.canonical_people cp ON cp.id=coalesce(o.canonical_person_id,cpl.canonical_person_id) AND cp.review_state='verified' AND cp.status='active'
    WHERE o.organization_id=ANY(v_rnm_orgs) AND o.person_record_id IS NOT NULL AND o.observed_at>=p_from AND o.observed_at<p_to AND o.observed_at<=now()
      AND EXISTS (SELECT 1 FROM places p WHERE (p.zone_id IS NOT NULL AND p.zone_id=o.zone_id) OR (p.site_id IS NOT NULL AND p.site_id=o.site_id))
    UNION
    SELECT coalesce(c.canonical_person_id,cpl.canonical_person_id) FROM public.cctv_entity_observations c
    JOIN public.person_records pr ON pr.id=c.person_record_id AND pr.organization_id=c.organization_id AND pr.review_state='verified'
    LEFT JOIN public.canonical_person_links cpl ON cpl.source_table='person_records' AND cpl.source_id=c.person_record_id AND cpl.organization_id=c.organization_id
    JOIN public.canonical_people cp ON cp.id=coalesce(c.canonical_person_id,cpl.canonical_person_id) AND cp.review_state='verified' AND cp.status='active'
    WHERE c.organization_id=ANY(v_rnm_orgs) AND c.entity_kind='person' AND c.review_state='accepted' AND c.person_record_id IS NOT NULL
      AND c.observed_at>=p_from AND c.observed_at<p_to AND c.observed_at<=now()
      AND EXISTS (SELECT 1 FROM places p WHERE (p.zone_id IS NOT NULL AND p.zone_id=c.zone_id) OR (p.site_id IS NOT NULL AND p.site_id=c.site_id))
  )
  SELECT count(DISTINCT i.person_id) INTO v_person_count FROM identified i;
  SELECT count(*) INTO v_action_count
  FROM public.location_events e
  WHERE e.organization_id=ANY(v_rnm_orgs) AND e.occurred_at>=p_from AND e.occurred_at<p_to AND e.occurred_at<=now()
    AND (nullif(trim(e.payload->>'action_notes'),'') IS NOT NULL OR nullif(trim(e.payload->>'action_taken'),'') IS NOT NULL
      OR nullif(trim(e.payload->>'comments'),'') IS NOT NULL)
    AND EXISTS (SELECT 1 FROM public.service_agreement_locations l WHERE l.service_agreement_id=p_service_agreement_id AND l.status='active'
      AND ((l.zone_id IS NOT NULL AND l.zone_id=e.zone_id) OR (l.site_id IS NOT NULL AND l.site_id=e.client_site_id)));
  SELECT count(DISTINCT e.id) INTO v_evidence_count
  FROM public.evidence_items e
  WHERE e.organization_id=ANY(v_rnm_orgs) AND e.captured_at>=p_from AND e.captured_at<p_to
    AND (
      EXISTS (SELECT 1 FROM public.location_events le WHERE le.id=e.location_event_id AND le.organization_id=e.organization_id
        AND le.occurred_at>=p_from AND le.occurred_at<p_to AND EXISTS (SELECT 1 FROM public.service_agreement_locations l
          WHERE l.service_agreement_id=p_service_agreement_id AND l.status='active'
            AND ((l.zone_id IS NOT NULL AND l.zone_id=le.zone_id) OR (l.site_id IS NOT NULL AND l.site_id=le.client_site_id))))
      OR EXISTS (SELECT 1 FROM public.observations o WHERE o.organization_id=e.organization_id AND o.observed_at>=p_from AND o.observed_at<p_to
        AND (e.metadata->>'observation_id'=o.id::text OR e.storage_path=o.photo_url)
        AND EXISTS (SELECT 1 FROM public.service_agreement_locations l WHERE l.service_agreement_id=p_service_agreement_id AND l.status='active'
          AND ((l.zone_id IS NOT NULL AND l.zone_id=o.zone_id) OR (l.site_id IS NOT NULL AND l.site_id=o.site_id))))
      OR EXISTS (SELECT 1 FROM public.cctv_entity_observations c WHERE c.evidence_item_id=e.id AND c.organization_id=e.organization_id
        AND c.observed_at>=p_from AND c.observed_at<p_to AND c.review_state='accepted'
        AND EXISTS (SELECT 1 FROM public.service_agreement_locations l WHERE l.service_agreement_id=p_service_agreement_id AND l.status='active'
          AND ((l.zone_id IS NOT NULL AND l.zone_id=c.zone_id) OR (l.site_id IS NOT NULL AND l.site_id=c.site_id))))
    );
  RETURN jsonb_build_object(
    'repeatVehicles',coalesce(v_repeats,0), 'vehiclesAtMultiplePlaces',coalesce(v_multi_place,0),
    'ownersIdentified',coalesce(v_owner_count,0), 'peopleIdentified',coalesce(v_person_count,0),
    'supportingEvidenceItems',coalesce(v_evidence_count,0), 'recordsWithActionNotes',coalesce(v_action_count,0),
    'clientSummary', CASE WHEN coalesce(v_owner_count,0)>0 OR coalesce(v_person_count,0)>0 THEN
      'R&M has identified ' ||
      CASE WHEN coalesce(v_owner_count,0)>0 THEN 'the registered owner of '||v_owner_count::text||' vehicle(s)' ELSE '' END ||
      CASE WHEN coalesce(v_owner_count,0)>0 AND coalesce(v_person_count,0)>0 THEN ' and ' ELSE '' END ||
      CASE WHEN coalesce(v_person_count,0)>0 THEN v_person_count::text||' person record(s) relating to this report' ELSE '' END ||
      '. Identifying details are not included in this standard report.' ELSE NULL END
  );
END;
$function$;
REVOKE ALL ON FUNCTION private.agreement_subject_summary(uuid,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.agreement_subject_summary(uuid,timestamptz,timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION private.attach_report_subject_summary()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
BEGIN
  IF NEW.report_kind = 'monthly' THEN
    NEW.data := coalesce(NEW.data,'{}'::jsonb) || jsonb_build_object('subjectSummary',
      private.agreement_subject_summary(NEW.service_agreement_id, NEW.period_start::timestamptz, (NEW.period_end + 1)::timestamptz));
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION private.attach_report_subject_summary() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS monthly_report_pack_subject_summary ON public.monthly_report_packs;
CREATE TRIGGER monthly_report_pack_subject_summary
BEFORE INSERT OR UPDATE OF data, service_agreement_id, period_start, period_end ON public.monthly_report_packs
FOR EACH ROW EXECUTE FUNCTION private.attach_report_subject_summary();

DROP FUNCTION IF EXISTS public.list_vehicle_subject_identifications(text, uuid);
CREATE FUNCTION public.list_vehicle_subject_identifications(p_plate text, p_service_agreement_id uuid)
RETURNS TABLE(canonical_person_id uuid, person_record_id uuid, display_name text, identification_basis text, linked_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE v_provider uuid; v_plate text:=upper(regexp_replace(coalesce(p_plate,''),'[^A-Za-z0-9]','','g'));
BEGIN
  SELECT sa.provider_organization_id INTO v_provider FROM public.service_agreements sa WHERE sa.id=p_service_agreement_id AND sa.agreement_type='operational' AND sa.invitation_status='accepted';
  IF auth.uid() IS NULL OR v_provider IS NULL OR NOT private.rnm_admin_for_organization(v_provider) THEN RAISE EXCEPTION 'R&M administrator access required'; END IF;
  RETURN QUERY
  SELECT DISTINCT ON (cp.id) cp.id, o.person_record_id, cp.display_name,
    coalesce(a.metadata->>'identity_basis', 'Basis not recorded'), coalesce(a.created_at, o.observed_at)
  FROM public.observations o JOIN public.person_records pr ON pr.id=o.person_record_id AND pr.organization_id=o.organization_id AND pr.review_state='verified'
  JOIN public.canonical_person_links cpl ON cpl.source_table='person_records' AND cpl.source_id=pr.id AND cpl.organization_id=pr.organization_id
  JOIN public.canonical_people cp ON cp.id=coalesce(o.canonical_person_id,cpl.canonical_person_id) AND cp.review_state='verified' AND cp.status='active'
  JOIN public.service_agreement_locations l ON l.service_agreement_id=p_service_agreement_id AND l.status='active'
  LEFT JOIN LATERAL (
    SELECT al.metadata, al.created_at FROM public.audit_log al
    WHERE al.target_table='observations' AND al.target_id=o.id AND al.action='observation_identity_linked'
      AND al.metadata->>'person_record_id'=o.person_record_id::text
    ORDER BY al.created_at DESC LIMIT 1
  ) a ON true
  WHERE o.organization_id = ANY(ARRAY['e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid] || public.get_descendant_organizations('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid))
    AND upper(regexp_replace(o.plate_number,'[^A-Za-z0-9]','','g'))=v_plate AND o.person_record_id IS NOT NULL AND o.observed_at<=now()
    AND ((l.zone_id IS NOT NULL AND l.zone_id=o.zone_id) OR (l.site_id IS NOT NULL AND l.site_id=o.site_id))
  ORDER BY cp.id, coalesce(a.created_at, o.observed_at) DESC;
END;
$function$;
REVOKE ALL ON FUNCTION public.list_vehicle_subject_identifications(text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_vehicle_subject_identifications(text,uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.list_repeat_vehicle_subjects_for_agreement(uuid,integer,timestamptz,timestamptz,integer,integer) IS 'Agreement-place-scoped repeat vehicle summary, restricted to R&M administrators. No person names are returned.';
COMMENT ON FUNCTION public.list_vehicle_subject_history_for_agreement(text,uuid,integer) IS 'Agreement-place-scoped patrol, accepted CCTV and unlinked patrol-comment history, restricted to R&M administrators.';
COMMENT ON FUNCTION public.list_vehicle_subject_identifications(text,uuid) IS 'Returns person identity details only to R&M administrators for the selected agreement.';
COMMENT ON FUNCTION private.attach_report_subject_summary() IS 'Adds aggregate-only identification counts and privacy-safe client wording to monthly report packs.';
