-- Enrich existing-person suggestions with deterministic identity fields and operational context.

DROP FUNCTION IF EXISTS public.get_identity_resolution_candidates(uuid);
CREATE FUNCTION public.get_identity_resolution_candidates(p_identity_document_id uuid)
RETURNS TABLE(
  person_record_id uuid,
  display_name text,
  review_state text,
  staff_profile_id uuid,
  score real,
  basis text,
  last_seen_at timestamptz,
  cctv_sighting_count bigint,
  approved_identity_document_count bigint,
  incident_count bigint,
  confidence_label text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_document public.person_identity_documents%rowtype;
  v_proposed jsonb;
  v_name_key text;
  v_dob date;
BEGIN
  SELECT * INTO v_document FROM public.person_identity_documents WHERE id=p_identity_document_id;
  IF v_document.id IS NULL THEN RAISE EXCEPTION 'Identity document not found'; END IF;
  IF auth.uid() IS NULL OR NOT public.is_admin_for_org(v_document.organization_id) THEN RAISE EXCEPTION 'Identity resolution administrator access required'; END IF;
  v_proposed:=coalesce(v_document.extracted_fields->'proposed','{}'::jsonb);
  v_name_key:=nullif(regexp_replace(lower(trim(coalesce(v_proposed->>'display_name',''))),'[^a-z0-9]+','','g'),'');
  v_dob:=nullif(v_proposed->>'date_of_birth','')::date;
  RETURN QUERY
  WITH face_raw AS (
    SELECT candidate,
      CASE candidate->>'match_kind'
        WHEN 'person_record' THEN nullif(candidate->>'match_id','')::uuid
        WHEN 'observation' THEN (SELECT observation.person_record_id FROM public.cctv_entity_observations observation WHERE observation.id=nullif(candidate->>'observation_id','')::uuid)
      END AS resolved_person_id
    FROM jsonb_array_elements(coalesce(v_document.extracted_fields->'candidate_matches','[]'::jsonb)) candidate
  ), face_hits AS (
    SELECT face_raw.resolved_person_id,
      coalesce((face_raw.candidate->>'score')::real,0)::real AS similarity,
      coalesce(face_raw.candidate->>'basis','face_similarity') AS match_basis,
      nullif(face_raw.candidate->>'last_seen_at','')::timestamptz AS seen_at
    FROM face_raw WHERE face_raw.resolved_person_id IS NOT NULL
  ), field_hits AS (
    SELECT person.id AS resolved_person_id,
      CASE
        WHEN (nullif(v_proposed->>'driver_licence_number','') IS NOT NULL AND person.metadata->'profile_details'->>'driver_licence_number'=v_proposed->>'driver_licence_number')
          OR (nullif(v_proposed->>'firearms_licence_number','') IS NOT NULL AND person.metadata->'profile_details'->>'firearms_licence_number'=v_proposed->>'firearms_licence_number')
          OR (nullif(v_proposed->>'security_licence_number','') IS NOT NULL AND person.metadata->'profile_details'->>'security_licence_number'=v_proposed->>'security_licence_number') THEN 1.0::real
        WHEN v_name_key IS NOT NULL AND regexp_replace(lower(trim(coalesce(person.display_name,''))),'[^a-z0-9]+','','g')=v_name_key
          AND v_dob IS NOT NULL AND nullif(person.metadata->'profile_details'->>'date_of_birth','')::date=v_dob THEN 0.98::real
        ELSE 0.82::real END AS similarity,
      CASE
        WHEN (nullif(v_proposed->>'driver_licence_number','') IS NOT NULL AND person.metadata->'profile_details'->>'driver_licence_number'=v_proposed->>'driver_licence_number')
          OR (nullif(v_proposed->>'firearms_licence_number','') IS NOT NULL AND person.metadata->'profile_details'->>'firearms_licence_number'=v_proposed->>'firearms_licence_number')
          OR (nullif(v_proposed->>'security_licence_number','') IS NOT NULL AND person.metadata->'profile_details'->>'security_licence_number'=v_proposed->>'security_licence_number') THEN 'credential_number_exact'
        WHEN v_dob IS NOT NULL AND nullif(person.metadata->'profile_details'->>'date_of_birth','')::date=v_dob THEN 'name_and_birth_date_exact'
        ELSE 'name_exact' END AS match_basis,
      NULL::timestamptz AS seen_at
    FROM public.person_records person
    WHERE person.organization_id=v_document.organization_id AND person.id<>v_document.person_record_id
      AND (
        (v_name_key IS NOT NULL AND regexp_replace(lower(trim(coalesce(person.display_name,''))),'[^a-z0-9]+','','g')=v_name_key)
        OR (nullif(v_proposed->>'driver_licence_number','') IS NOT NULL AND person.metadata->'profile_details'->>'driver_licence_number'=v_proposed->>'driver_licence_number')
        OR (nullif(v_proposed->>'firearms_licence_number','') IS NOT NULL AND person.metadata->'profile_details'->>'firearms_licence_number'=v_proposed->>'firearms_licence_number')
        OR (nullif(v_proposed->>'security_licence_number','') IS NOT NULL AND person.metadata->'profile_details'->>'security_licence_number'=v_proposed->>'security_licence_number')
      )
  ), ranked AS (
    SELECT DISTINCT ON (hit.resolved_person_id) hit.resolved_person_id,hit.similarity,hit.match_basis,hit.seen_at
    FROM (SELECT * FROM face_hits UNION ALL SELECT * FROM field_hits) hit
    WHERE hit.resolved_person_id<>v_document.person_record_id
    ORDER BY hit.resolved_person_id,hit.similarity DESC,hit.seen_at DESC NULLS LAST
  )
  SELECT person.id,person.display_name,person.review_state,
    nullif(person.metadata->'profile_details'->>'staff_profile_id','')::uuid,
    ranked.similarity,ranked.match_basis,
    coalesce(ranked.seen_at,(SELECT max(observed_at) FROM public.cctv_entity_observations observation WHERE observation.person_record_id=person.id)),
    (SELECT count(*) FROM public.cctv_entity_observations observation WHERE observation.person_record_id=person.id),
    (SELECT count(*) FROM public.person_identity_documents identity_document WHERE identity_document.person_record_id=person.id AND identity_document.review_state='approved'),
    (SELECT count(*) FROM public.incident_person_links incident_person WHERE incident_person.person_record_id=person.id),
    CASE WHEN ranked.similarity>=0.95 THEN 'strong' WHEN ranked.similarity>=0.8 THEN 'possible' ELSE 'weak' END
  FROM ranked JOIN public.person_records person ON person.id=ranked.resolved_person_id
  WHERE person.organization_id=v_document.organization_id
  ORDER BY ranked.similarity DESC,last_seen_at DESC NULLS LAST;
END;
$$;
REVOKE ALL ON FUNCTION public.get_identity_resolution_candidates(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_identity_resolution_candidates(uuid) TO authenticated,service_role;
COMMENT ON FUNCTION public.get_identity_resolution_candidates(uuid) IS 'Admin-only enriched existing-person suggestions from exact credential/name/DOB and biometric similarity, with staff, CCTV, approved-evidence, incident, and freshness context. Suggestions never resolve identity without confirmation.';
