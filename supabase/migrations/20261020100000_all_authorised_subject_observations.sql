-- NULL agreement selects all observations in organisations the R&M administrator
-- may manage, including observations with no current agreement/place mapping.
-- A non-NULL agreement retains the existing accepted-agreement/place semantics.
CREATE OR REPLACE FUNCTION private.subject_scope_organizations(p_service_agreement_id uuid)
RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_provider uuid;
  v_orgs uuid[] := ARRAY['e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid]
    || public.get_descendant_organizations('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid);
  v_authorised uuid[];
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_service_agreement_id IS NOT NULL THEN
    SELECT sa.provider_organization_id INTO v_provider
    FROM public.service_agreements sa
    WHERE sa.id = p_service_agreement_id
      AND sa.agreement_type = 'operational' AND sa.invitation_status = 'accepted';
    IF v_provider IS NULL OR NOT private.rnm_admin_for_organization(v_provider) THEN
      RAISE EXCEPTION 'R&M administrator access to this agreement is required';
    END IF;
    RETURN v_orgs;
  END IF;
  SELECT array_agg(DISTINCT org_id) INTO v_authorised
  FROM unnest(v_orgs) AS scope(org_id)
  WHERE private.rnm_admin_for_organization(org_id);
  IF coalesce(cardinality(v_authorised), 0) = 0 THEN
    RAISE EXCEPTION 'R&M administrator access is required';
  END IF;
  RETURN v_authorised;
END;
$function$;
REVOKE ALL ON FUNCTION private.subject_scope_organizations(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Keep observation-only registrations discoverable without inventing a
-- canonical vehicle. SECURITY INVOKER preserves the caller's observation RLS.
CREATE OR REPLACE FUNCTION public.search_vehicle_registrations(p_pattern text, p_limit integer DEFAULT 51)
RETURNS TABLE(id uuid, plate_number text, make text, model text, year integer, colour text)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = ''
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_pattern IS NULL OR length(p_pattern) > 40 OR p_pattern !~ '^[A-Za-z0-9%]+$'
    OR p_pattern !~ '[A-Za-z0-9]' THEN
    RAISE EXCEPTION 'Enter a registration fragment using letters, numbers and %% wildcards';
  END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT v.id, v.plate_number, v.make, v.model, v.year, v.colour
    FROM public.canonical_vehicle_public v WHERE v.plate_number ILIKE p_pattern
    UNION ALL
    SELECT NULL::uuid, upper(regexp_replace(o.plate_number, '[^A-Za-z0-9]', '', 'g')),
      NULL::text, NULL::text, NULL::integer, NULL::text
    FROM public.observations o
    WHERE upper(regexp_replace(o.plate_number, '[^A-Za-z0-9]', '', 'g')) ILIKE p_pattern
  ), unique_plates AS (
    SELECT DISTINCT ON (c.plate_number) c.*
    FROM candidates c
    ORDER BY c.plate_number, c.id NULLS LAST
  )
  SELECT u.* FROM unique_plates u ORDER BY u.plate_number
  LIMIT least(greatest(coalesce(p_limit, 51), 1), 51);
END;
$function$;
REVOKE ALL ON FUNCTION public.search_vehicle_registrations(text, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.search_vehicle_registrations(text, integer) TO authenticated;

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
COMMENT ON FUNCTION "public"."list_repeat_vehicle_subjects_for_agreement"(p_service_agreement_id uuid, p_min_sightings integer, p_from timestamp with time zone, p_to timestamp with time zone, p_limit integer, p_offset integer) IS 'Selected agreement, or all authorised R&M observations when agreement is NULL: repeat vehicle summary, restricted to R&M administrators. No person names are returned.';
REVOKE ALL ON FUNCTION "public"."list_repeat_vehicle_subjects_for_agreement"(p_service_agreement_id uuid, p_min_sightings integer, p_from timestamp with time zone, p_to timestamp with time zone, p_limit integer, p_offset integer) FROM PUBLIC, "anon", "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION "public"."list_repeat_vehicle_subjects_for_agreement"(p_service_agreement_id uuid, p_min_sightings integer, p_from timestamp with time zone, p_to timestamp with time zone, p_limit integer, p_offset integer) TO "postgres";
GRANT EXECUTE ON FUNCTION "public"."list_repeat_vehicle_subjects_for_agreement"(p_service_agreement_id uuid, p_min_sightings integer, p_from timestamp with time zone, p_to timestamp with time zone, p_limit integer, p_offset integer) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."list_repeat_vehicle_subjects_for_agreement"(p_service_agreement_id uuid, p_min_sightings integer, p_from timestamp with time zone, p_to timestamp with time zone, p_limit integer, p_offset integer) TO "service_role";

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
    v.registered_owner_name IS NOT NULL
  FROM ids JOIN public.canonical_vehicles v ON v.id = ids.id
  ORDER BY v.last_seen_at DESC NULLS LAST LIMIT 1;
END;
$function$;
REVOKE ALL ON FUNCTION "public"."get_vehicle_subject_details_for_agreement"(p_plate text, p_service_agreement_id uuid) FROM PUBLIC, "anon", "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION "public"."get_vehicle_subject_details_for_agreement"(p_plate text, p_service_agreement_id uuid) TO "postgres";
GRANT EXECUTE ON FUNCTION "public"."get_vehicle_subject_details_for_agreement"(p_plate text, p_service_agreement_id uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."get_vehicle_subject_details_for_agreement"(p_plate text, p_service_agreement_id uuid) TO "service_role";

CREATE OR REPLACE FUNCTION "public"."list_vehicle_subject_history_for_agreement"(p_plate text, p_service_agreement_id uuid, p_limit integer DEFAULT 200)
 RETURNS TABLE(source text, record_id uuid, organization_id uuid, observed_at timestamp with time zone, place_id uuid, officer_id uuid, note text, canonical_vehicle_id uuid, evidence_item_id uuid, compliance_status text, compliance_reason text, photo_url text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_scope_orgs uuid[];
  v_plate text := upper(regexp_replace(coalesce(p_plate, ''), '[^A-Za-z0-9]', '', 'g'));
BEGIN
  v_scope_orgs := private.subject_scope_organizations(p_service_agreement_id);
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
    WHERE o.organization_id = ANY(v_scope_orgs)
      AND upper(regexp_replace(o.plate_number, '[^A-Za-z0-9]', '', 'g')) = v_plate AND o.observed_at <= now()
      AND (p_service_agreement_id IS NULL OR EXISTS (SELECT 1 FROM places p WHERE (p.zone_id IS NOT NULL AND p.zone_id = o.zone_id) OR (p.site_id IS NOT NULL AND p.site_id = o.site_id)))
    UNION ALL
    SELECT 'cctv'::text, c.id, c.organization_id, c.observed_at, coalesce(c.zone_id, c.site_id), NULL::uuid,
      nullif(concat_ws(' · ', c.candidate_label, c.attributes->>'description'), ''), c.canonical_vehicle_id, c.evidence_item_id,
      NULL::text, NULL::text, NULL::text
    FROM public.cctv_entity_observations c
    WHERE c.organization_id = ANY(v_scope_orgs) AND c.entity_kind = 'vehicle' AND c.review_state = 'accepted' AND c.observed_at <= now()
      AND upper(regexp_replace(coalesce(c.candidate_plate, ''), '[^A-Za-z0-9]', '', 'g')) = v_plate
      AND (p_service_agreement_id IS NULL OR EXISTS (SELECT 1 FROM places p WHERE (p.zone_id IS NOT NULL AND p.zone_id = c.zone_id) OR (p.site_id IS NOT NULL AND p.site_id = c.site_id)))
    UNION ALL
    SELECT 'patrol_comment'::text, e.id, e.organization_id, e.occurred_at, coalesce(e.zone_id, e.client_site_id), NULL::uuid,
      e.payload->>'comments', NULL::uuid, NULL::uuid, NULL::text, e.payload->>'issue', NULL::text
    FROM public.location_events e
    WHERE e.organization_id = ANY(v_scope_orgs) AND e.occurred_at <= now() AND e.payload->>'comments' ILIKE '%' || v_plate || '%'
      AND (p_service_agreement_id IS NULL OR EXISTS (SELECT 1 FROM places p WHERE (p.zone_id IS NOT NULL AND p.zone_id = e.zone_id) OR (p.site_id IS NOT NULL AND p.site_id = e.client_site_id)))
      AND NOT EXISTS (SELECT 1 FROM public.observations o WHERE o.external_refs->>'external_ref' = e.external_ref AND o.organization_id = e.organization_id)
  ) history
  ORDER BY observed_at DESC
  LIMIT least(greatest(coalesce(p_limit, 200), 1), 500);
END;
$function$;
COMMENT ON FUNCTION "public"."list_vehicle_subject_history_for_agreement"(p_plate text, p_service_agreement_id uuid, p_limit integer) IS 'Selected agreement, or all authorised R&M observations when agreement is NULL: patrol, accepted CCTV and unlinked patrol-comment history, restricted to R&M administrators.';
REVOKE ALL ON FUNCTION "public"."list_vehicle_subject_history_for_agreement"(p_plate text, p_service_agreement_id uuid, p_limit integer) FROM PUBLIC, "anon", "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION "public"."list_vehicle_subject_history_for_agreement"(p_plate text, p_service_agreement_id uuid, p_limit integer) TO "postgres";
GRANT EXECUTE ON FUNCTION "public"."list_vehicle_subject_history_for_agreement"(p_plate text, p_service_agreement_id uuid, p_limit integer) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."list_vehicle_subject_history_for_agreement"(p_plate text, p_service_agreement_id uuid, p_limit integer) TO "service_role";

CREATE OR REPLACE FUNCTION "public"."list_unlinked_plate_mentions_for_agreement"(p_service_agreement_id uuid, p_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to timestamp with time zone DEFAULT NULL::timestamp with time zone, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0)
 RETURNS TABLE(plate text, mentions bigint, first_seen timestamp with time zone, last_seen timestamp with time zone, total_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_scope_orgs uuid[];
BEGIN
  v_scope_orgs := private.subject_scope_organizations(p_service_agreement_id);
  RETURN QUERY
  WITH places AS MATERIALIZED (
    SELECT l.zone_id, l.site_id FROM public.service_agreement_locations l WHERE l.service_agreement_id = p_service_agreement_id AND l.status = 'active'
  ), mentions AS (
    SELECT upper(regexp_replace(m.plate[1], '[^A-Za-z0-9]', '', 'g')) plate, e.id, e.occurred_at
    FROM public.location_events e
    CROSS JOIN LATERAL regexp_matches(coalesce(e.payload->>'comments',''), '\m([A-Z]{3}[0-9]{3})\M', 'gi') AS m(plate)
    WHERE e.organization_id = ANY(v_scope_orgs) AND e.occurred_at <= now() AND (p_from IS NULL OR e.occurred_at >= p_from) AND (p_to IS NULL OR e.occurred_at < p_to)
      AND (p_service_agreement_id IS NULL OR EXISTS (SELECT 1 FROM places p WHERE (p.zone_id IS NOT NULL AND p.zone_id = e.zone_id) OR (p.site_id IS NOT NULL AND p.site_id = e.client_site_id)))
      AND NOT EXISTS (SELECT 1 FROM public.observations o WHERE upper(regexp_replace(o.plate_number,'[^A-Za-z0-9]','','g')) = upper(regexp_replace(m.plate[1],'[^A-Za-z0-9]','','g')) AND (o.zone_id=e.zone_id OR o.site_id=e.client_site_id))
      AND NOT EXISTS (SELECT 1 FROM public.cctv_entity_observations c WHERE c.review_state='accepted' AND upper(regexp_replace(coalesce(c.candidate_plate,''),'[^A-Za-z0-9]','','g')) = upper(regexp_replace(m.plate[1],'[^A-Za-z0-9]','','g')) AND (c.zone_id=e.zone_id OR c.site_id=e.client_site_id))
  ), grouped AS (
    SELECT m.plate, count(*) n, min(m.occurred_at) first_at, max(m.occurred_at) last_at FROM mentions m GROUP BY m.plate
  )
  SELECT g.plate, g.n, g.first_at, g.last_at, count(*) over () FROM grouped g ORDER BY g.n DESC, g.last_at DESC
  LIMIT least(greatest(coalesce(p_limit,100),1),500) OFFSET greatest(coalesce(p_offset,0),0);
END;
$function$;
REVOKE ALL ON FUNCTION "public"."list_unlinked_plate_mentions_for_agreement"(p_service_agreement_id uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_limit integer, p_offset integer) FROM PUBLIC, "anon", "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION "public"."list_unlinked_plate_mentions_for_agreement"(p_service_agreement_id uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_limit integer, p_offset integer) TO "postgres";
GRANT EXECUTE ON FUNCTION "public"."list_unlinked_plate_mentions_for_agreement"(p_service_agreement_id uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_limit integer, p_offset integer) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."list_unlinked_plate_mentions_for_agreement"(p_service_agreement_id uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_limit integer, p_offset integer) TO "service_role";

CREATE OR REPLACE FUNCTION "public"."list_repeat_person_subjects_for_agreement"(p_service_agreement_id uuid, p_min_sightings integer DEFAULT 2, p_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to timestamp with time zone DEFAULT NULL::timestamp with time zone, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0)
 RETURNS TABLE(canonical_person_id uuid, display_name text, sightings bigint, places bigint, patrol_sightings bigint, cctv_sightings bigint, first_seen timestamp with time zone, last_seen timestamp with time zone, total_count bigint)
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
    SELECT l.zone_id,l.site_id FROM public.service_agreement_locations l WHERE l.service_agreement_id=p_service_agreement_id AND l.status='active'
  ), seen AS (
    SELECT coalesce(o.canonical_person_id,cpl.canonical_person_id) person_id, coalesce(o.zone_id,o.site_id) place, o.observed_at at, 'patrol'::text src
    FROM public.observations o
    JOIN public.person_records pr ON pr.id=o.person_record_id AND pr.organization_id=o.organization_id AND pr.review_state='verified'
    LEFT JOIN public.canonical_person_links cpl ON cpl.source_table='person_records' AND cpl.source_id=o.person_record_id AND cpl.organization_id=o.organization_id
    JOIN public.canonical_people cp ON cp.id=coalesce(o.canonical_person_id,cpl.canonical_person_id) AND cp.review_state='verified' AND cp.status='active'
    WHERE o.organization_id=ANY(v_scope_orgs) AND o.person_record_id IS NOT NULL AND o.observed_at<=now()
      AND (p_from IS NULL OR o.observed_at>=p_from) AND (p_to IS NULL OR o.observed_at<p_to)
      AND (p_service_agreement_id IS NULL OR EXISTS (SELECT 1 FROM places p WHERE (p.zone_id IS NOT NULL AND p.zone_id=o.zone_id) OR (p.site_id IS NOT NULL AND p.site_id=o.site_id)))
    UNION ALL
    SELECT coalesce(c.canonical_person_id,cpl.canonical_person_id), coalesce(c.zone_id,c.site_id), c.observed_at, 'cctv'::text
    FROM public.cctv_entity_observations c
    JOIN public.person_records pr ON pr.id=c.person_record_id AND pr.organization_id=c.organization_id AND pr.review_state='verified'
    LEFT JOIN public.canonical_person_links cpl ON cpl.source_table='person_records' AND cpl.source_id=c.person_record_id AND cpl.organization_id=c.organization_id
    JOIN public.canonical_people cp ON cp.id=coalesce(c.canonical_person_id,cpl.canonical_person_id) AND cp.review_state='verified' AND cp.status='active'
    WHERE c.organization_id=ANY(v_scope_orgs) AND c.entity_kind='person' AND c.review_state='accepted'
      AND c.person_record_id IS NOT NULL AND c.observed_at<=now()
      AND (p_from IS NULL OR c.observed_at>=p_from) AND (p_to IS NULL OR c.observed_at<p_to)
      AND (p_service_agreement_id IS NULL OR EXISTS (SELECT 1 FROM places p WHERE (p.zone_id IS NOT NULL AND p.zone_id=c.zone_id) OR (p.site_id IS NOT NULL AND p.site_id=c.site_id)))
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
REVOKE ALL ON FUNCTION "public"."list_repeat_person_subjects_for_agreement"(p_service_agreement_id uuid, p_min_sightings integer, p_from timestamp with time zone, p_to timestamp with time zone, p_limit integer, p_offset integer) FROM PUBLIC, "anon", "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION "public"."list_repeat_person_subjects_for_agreement"(p_service_agreement_id uuid, p_min_sightings integer, p_from timestamp with time zone, p_to timestamp with time zone, p_limit integer, p_offset integer) TO "postgres";
GRANT EXECUTE ON FUNCTION "public"."list_repeat_person_subjects_for_agreement"(p_service_agreement_id uuid, p_min_sightings integer, p_from timestamp with time zone, p_to timestamp with time zone, p_limit integer, p_offset integer) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."list_repeat_person_subjects_for_agreement"(p_service_agreement_id uuid, p_min_sightings integer, p_from timestamp with time zone, p_to timestamp with time zone, p_limit integer, p_offset integer) TO "service_role";

CREATE OR REPLACE FUNCTION "public"."list_person_subject_history_for_agreement"(p_canonical_person_id uuid, p_service_agreement_id uuid, p_limit integer DEFAULT 200)
 RETURNS TABLE(source text, record_id uuid, organization_id uuid, observed_at timestamp with time zone, place_id uuid, plate text, note text, evidence_item_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_scope_orgs uuid[];
BEGIN
  v_scope_orgs := private.subject_scope_organizations(p_service_agreement_id);
  IF NOT EXISTS (SELECT 1 FROM public.canonical_people cp WHERE cp.id=p_canonical_person_id AND cp.review_state='verified' AND cp.status='active') THEN RAISE EXCEPTION 'Verified canonical person is not available'; END IF;
  RETURN QUERY
  WITH places AS MATERIALIZED (SELECT l.zone_id,l.site_id FROM public.service_agreement_locations l WHERE l.service_agreement_id=p_service_agreement_id AND l.status='active')
  SELECT * FROM (
    SELECT 'patrol'::text,o.id,o.organization_id,o.observed_at,coalesce(o.zone_id,o.site_id),o.plate_number,o.officer_notes,
      (SELECT e.id FROM public.evidence_items e WHERE e.organization_id=o.organization_id AND e.metadata->>'observation_id'=o.id::text ORDER BY e.captured_at DESC LIMIT 1)
    FROM public.observations o
    JOIN public.person_records pr ON pr.id=o.person_record_id AND pr.organization_id=o.organization_id AND pr.review_state='verified'
    LEFT JOIN public.canonical_person_links cpl ON cpl.source_table='person_records' AND cpl.source_id=o.person_record_id AND cpl.organization_id=o.organization_id
    WHERE o.organization_id=ANY(v_scope_orgs) AND coalesce(o.canonical_person_id,cpl.canonical_person_id)=p_canonical_person_id AND o.observed_at<=now()
      AND (p_service_agreement_id IS NULL OR EXISTS (SELECT 1 FROM places p WHERE (p.zone_id IS NOT NULL AND p.zone_id=o.zone_id) OR (p.site_id IS NOT NULL AND p.site_id=o.site_id)))
    UNION ALL
    SELECT 'cctv'::text,c.id,c.organization_id,c.observed_at,coalesce(c.zone_id,c.site_id),c.candidate_plate,
      nullif(concat_ws(' · ',c.candidate_label,c.attributes->>'description'),''),c.evidence_item_id
    FROM public.cctv_entity_observations c
    JOIN public.person_records pr ON pr.id=c.person_record_id AND pr.organization_id=c.organization_id AND pr.review_state='verified'
    LEFT JOIN public.canonical_person_links cpl ON cpl.source_table='person_records' AND cpl.source_id=c.person_record_id AND cpl.organization_id=c.organization_id
    WHERE c.organization_id=ANY(v_scope_orgs) AND c.entity_kind='person' AND c.review_state='accepted'
      AND coalesce(c.canonical_person_id,cpl.canonical_person_id)=p_canonical_person_id AND c.observed_at<=now()
      AND (p_service_agreement_id IS NULL OR EXISTS (SELECT 1 FROM places p WHERE (p.zone_id IS NOT NULL AND p.zone_id=c.zone_id) OR (p.site_id IS NOT NULL AND p.site_id=c.site_id)))
  ) h ORDER BY observed_at DESC LIMIT least(greatest(coalesce(p_limit,200),1),500);
END;
$function$;
REVOKE ALL ON FUNCTION "public"."list_person_subject_history_for_agreement"(p_canonical_person_id uuid, p_service_agreement_id uuid, p_limit integer) FROM PUBLIC, "anon", "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION "public"."list_person_subject_history_for_agreement"(p_canonical_person_id uuid, p_service_agreement_id uuid, p_limit integer) TO "postgres";
GRANT EXECUTE ON FUNCTION "public"."list_person_subject_history_for_agreement"(p_canonical_person_id uuid, p_service_agreement_id uuid, p_limit integer) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."list_person_subject_history_for_agreement"(p_canonical_person_id uuid, p_service_agreement_id uuid, p_limit integer) TO "service_role";

CREATE OR REPLACE FUNCTION "public"."list_vehicle_subject_identifications"(p_plate text, p_service_agreement_id uuid)
 RETURNS TABLE(canonical_person_id uuid, person_record_id uuid, display_name text, identification_basis text, linked_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_scope_orgs uuid[]; v_plate text:=upper(regexp_replace(coalesce(p_plate,''),'[^A-Za-z0-9]','','g'));
BEGIN
  v_scope_orgs := private.subject_scope_organizations(p_service_agreement_id);
  RETURN QUERY
  SELECT DISTINCT ON (cp.id) cp.id, o.person_record_id, cp.display_name,
    coalesce(a.metadata->>'identity_basis', 'Basis not recorded'), coalesce(a.created_at, o.observed_at)
  FROM public.observations o JOIN public.person_records pr ON pr.id=o.person_record_id AND pr.organization_id=o.organization_id AND pr.review_state='verified'
  JOIN public.canonical_person_links cpl ON cpl.source_table='person_records' AND cpl.source_id=pr.id AND cpl.organization_id=pr.organization_id
  JOIN public.canonical_people cp ON cp.id=coalesce(o.canonical_person_id,cpl.canonical_person_id) AND cp.review_state='verified' AND cp.status='active'
  LEFT JOIN LATERAL (
    SELECT al.metadata, al.created_at FROM public.audit_log al
    WHERE al.target_table='observations' AND al.target_id=o.id AND al.action='observation_identity_linked'
      AND al.metadata->>'person_record_id'=o.person_record_id::text
    ORDER BY al.created_at DESC LIMIT 1
  ) a ON true
  WHERE o.organization_id = ANY(v_scope_orgs)
    AND upper(regexp_replace(o.plate_number,'[^A-Za-z0-9]','','g'))=v_plate AND o.person_record_id IS NOT NULL AND o.observed_at<=now()
    AND (p_service_agreement_id IS NULL OR EXISTS (SELECT 1 FROM public.service_agreement_locations l
      WHERE l.service_agreement_id=p_service_agreement_id AND l.status='active'
        AND ((l.zone_id IS NOT NULL AND l.zone_id=o.zone_id) OR (l.site_id IS NOT NULL AND l.site_id=o.site_id))))
  ORDER BY cp.id, coalesce(a.created_at, o.observed_at) DESC;
END;
$function$;
COMMENT ON FUNCTION "public"."list_vehicle_subject_identifications"(p_plate text, p_service_agreement_id uuid) IS 'Returns person identity details only to R&M administrators for the selected agreement, or all authorised R&M observations when agreement is NULL.';
REVOKE ALL ON FUNCTION "public"."list_vehicle_subject_identifications"(p_plate text, p_service_agreement_id uuid) FROM PUBLIC, "anon", "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION "public"."list_vehicle_subject_identifications"(p_plate text, p_service_agreement_id uuid) TO "postgres";
GRANT EXECUTE ON FUNCTION "public"."list_vehicle_subject_identifications"(p_plate text, p_service_agreement_id uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."list_vehicle_subject_identifications"(p_plate text, p_service_agreement_id uuid) TO "service_role";
