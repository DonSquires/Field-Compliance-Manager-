-- Human-reviewed resolution of a temporary identity projection to an existing canonical person.

CREATE OR REPLACE FUNCTION public.get_identity_resolution_candidates(p_identity_document_id uuid)
RETURNS TABLE(person_record_id uuid,display_name text,review_state text,staff_profile_id uuid,score real,basis text,last_seen_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE v_document public.person_identity_documents%rowtype;BEGIN
  SELECT * INTO v_document FROM public.person_identity_documents WHERE id=p_identity_document_id;
  IF v_document.id IS NULL THEN RAISE EXCEPTION 'Identity document not found'; END IF;
  IF auth.uid() IS NULL OR NOT public.is_admin_for_org(v_document.organization_id) THEN RAISE EXCEPTION 'Identity resolution administrator access required'; END IF;
  RETURN QUERY
  WITH raw AS (
    SELECT candidate,
      CASE candidate->>'match_kind'
        WHEN 'person_record' THEN nullif(candidate->>'match_id','')::uuid
        WHEN 'observation' THEN (SELECT observation.person_record_id FROM public.cctv_entity_observations observation WHERE observation.id=nullif(candidate->>'observation_id','')::uuid)
      END AS resolved_person_id
    FROM jsonb_array_elements(coalesce(v_document.extracted_fields->'candidate_matches','[]'::jsonb)) candidate
  ), ranked AS (
    SELECT DISTINCT ON (raw.resolved_person_id) raw.resolved_person_id,
      coalesce((raw.candidate->>'score')::real,0)::real AS similarity,
      coalesce(raw.candidate->>'basis','similarity') AS match_basis,
      nullif(raw.candidate->>'last_seen_at','')::timestamptz AS seen_at
    FROM raw WHERE raw.resolved_person_id IS NOT NULL AND raw.resolved_person_id<>v_document.person_record_id
    ORDER BY raw.resolved_person_id,coalesce((raw.candidate->>'score')::real,0) DESC
  )
  SELECT person.id,person.display_name,person.review_state,nullif(person.metadata->'profile_details'->>'staff_profile_id','')::uuid,
    ranked.similarity,ranked.match_basis,ranked.seen_at
  FROM ranked JOIN public.person_records person ON person.id=ranked.resolved_person_id
  WHERE person.organization_id=v_document.organization_id
  ORDER BY ranked.similarity DESC,ranked.seen_at DESC NULLS LAST;
END;
$$;
REVOKE ALL ON FUNCTION public.get_identity_resolution_candidates(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_identity_resolution_candidates(uuid) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.resolve_identity_document_person(
  p_identity_document_id uuid,p_target_person_record_id uuid,p_resolution_reason text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_actor uuid:=auth.uid();v_document public.person_identity_documents%rowtype;v_source public.person_records%rowtype;v_target public.person_records%rowtype;
  v_source_canonical uuid;v_target_canonical uuid;v_other_source_links integer;v_incident_link public.incident_person_links%rowtype;
BEGIN
  IF coalesce(trim(p_resolution_reason),'')='' THEN RAISE EXCEPTION 'Resolution reason is required'; END IF;
  SELECT * INTO v_document FROM public.person_identity_documents WHERE id=p_identity_document_id FOR UPDATE;
  IF v_document.id IS NULL OR v_document.review_state<>'manual_review_required' THEN RAISE EXCEPTION 'A pending identity document is required'; END IF;
  IF v_actor IS NULL OR NOT public.is_admin_for_org(v_document.organization_id) THEN RAISE EXCEPTION 'Identity resolution administrator access required'; END IF;
  SELECT * INTO v_source FROM public.person_records WHERE id=v_document.person_record_id AND organization_id=v_document.organization_id FOR UPDATE;
  SELECT * INTO v_target FROM public.person_records WHERE id=p_target_person_record_id AND organization_id=v_document.organization_id FOR UPDATE;
  IF v_source.id IS NULL OR v_target.id IS NULL OR v_source.id=v_target.id THEN RAISE EXCEPTION 'Choose a different existing person in this organization'; END IF;
  v_source_canonical:=public.ensure_canonical_person_for_record(v_source.id);
  v_target_canonical:=public.ensure_canonical_person_for_record(v_target.id);

  UPDATE public.person_identity_documents SET person_record_id=v_target.id,updated_at=clock_timestamp() WHERE id=v_document.id;
  UPDATE public.person_identity_face_proposals SET person_record_id=v_target.id WHERE identity_document_id=v_document.id;
  UPDATE public.bob_attachments SET extraction_payload=jsonb_set(coalesce(extraction_payload,'{}'::jsonb),'{person_record_id}',to_jsonb(v_target.id),true)
    WHERE id=v_document.attachment_id;
  UPDATE public.evidence_items SET metadata=jsonb_set(coalesce(metadata,'{}'::jsonb),'{resolved_person_record_id}',to_jsonb(v_target.id),true)
    WHERE id=v_document.evidence_item_id;

  FOR v_incident_link IN SELECT * FROM public.incident_person_links WHERE person_record_id=v_source.id LOOP
    INSERT INTO public.incident_person_links(organization_id,incident_id,canonical_person_id,person_record_id,staff_profile_id,identity_document_id,involvement_role,source_kind,notes,recorded_by,created_at,updated_at)
    VALUES(v_incident_link.organization_id,v_incident_link.incident_id,v_target_canonical,v_target.id,
      nullif(v_target.metadata->'profile_details'->>'staff_profile_id','')::uuid,
      CASE WHEN v_incident_link.identity_document_id=v_document.id THEN v_document.id ELSE v_incident_link.identity_document_id END,
      v_incident_link.involvement_role,v_incident_link.source_kind,v_incident_link.notes,v_actor,v_incident_link.created_at,clock_timestamp())
    ON CONFLICT(incident_id,canonical_person_id,involvement_role) DO UPDATE SET
      person_record_id=excluded.person_record_id,staff_profile_id=coalesce(excluded.staff_profile_id,incident_person_links.staff_profile_id),
      identity_document_id=coalesce(excluded.identity_document_id,incident_person_links.identity_document_id),
      notes=excluded.notes,recorded_by=excluded.recorded_by,updated_at=clock_timestamp();
  END LOOP;
  DELETE FROM public.incident_person_links WHERE person_record_id=v_source.id;

  UPDATE public.cctv_entity_observations SET person_record_id=v_target.id,canonical_person_id=v_target_canonical WHERE person_record_id=v_source.id;
  UPDATE public.face_observations SET person_record_id=v_target.id WHERE person_record_id=v_source.id;
  UPDATE public.observations SET person_record_id=v_target.id,canonical_person_id=v_target_canonical WHERE person_record_id=v_source.id;
  UPDATE public.cctv_identity_drafts SET proposed_person_record_id=v_target.id WHERE proposed_person_record_id=v_source.id AND organization_id=v_document.organization_id;
  UPDATE public.canonical_person_links SET canonical_person_id=v_target_canonical,metadata=metadata||jsonb_build_object('resolved_from_canonical_person_id',v_source_canonical,'resolved_by',v_actor,'resolved_at',clock_timestamp())
    WHERE source_table='person_records' AND source_id=v_source.id;
  SELECT count(*) INTO v_other_source_links FROM public.canonical_person_links WHERE canonical_person_id=v_source_canonical;
  IF v_other_source_links=0 THEN UPDATE public.canonical_people SET status='merged',merged_into_id=v_target_canonical,updated_at=clock_timestamp() WHERE id=v_source_canonical; END IF;
  UPDATE public.person_records SET review_state='rejected',metadata=metadata||jsonb_build_object('resolved_into_person_record_id',v_target.id,'resolved_at',clock_timestamp(),'resolved_by',v_actor)
    WHERE id=v_source.id;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  VALUES(v_document.organization_id,v_actor,'identity_document_person_resolved','person_identity_documents',v_document.id,jsonb_build_object(
    'source_person_record_id',v_source.id,'target_person_record_id',v_target.id,'source_canonical_person_id',v_source_canonical,
    'target_canonical_person_id',v_target_canonical,'resolution_reason',trim(p_resolution_reason)));
  RETURN jsonb_build_object('identity_document_id',v_document.id,'source_person_record_id',v_source.id,'person_record_id',v_target.id,
    'canonical_person_id',v_target_canonical,'staff_profile_id',nullif(v_target.metadata->'profile_details'->>'staff_profile_id','')::uuid);
END;
$$;
REVOKE ALL ON FUNCTION public.resolve_identity_document_person(uuid,uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.resolve_identity_document_person(uuid,uuid,text) TO authenticated,service_role;
COMMENT ON FUNCTION public.resolve_identity_document_person(uuid,uuid,text) IS 'Admin-only human resolution of pending incident/CCTV identity evidence to an existing person projection and canonical person, preserving source history and audit.';
