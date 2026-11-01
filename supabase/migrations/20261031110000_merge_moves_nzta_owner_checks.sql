-- merge_person_records moved NZTA owner checks to the kept person record but left
-- vehicle_identity_checks.canonical_person_id on the merged-away canonical person. Owner history
-- (sync_nzta_registered_owner_history, fired on canonical_person_id) and notice owner matching
-- read that column, so they kept pointing at the retired person. The merge now moves both keys.
-- Live check before this migration: 0 stale rows, 0 merged person records (no backfill needed).

CREATE OR REPLACE FUNCTION "public"."merge_person_records"(p_organization_id uuid, p_source_person_record_id uuid, p_target_person_record_id uuid, p_reason text, p_display_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_source public.person_records%rowtype;
  v_target public.person_records%rowtype;
  v_source_canonical uuid;
  v_target_canonical uuid;
  v_link record;
  v_incident_link public.incident_person_links%rowtype;
  v_name text;
  v_counts jsonb := '{}'::jsonb;
  v_n integer;
BEGIN
  IF v_actor IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN RAISE EXCEPTION 'An administrator merges person records'; END IF;
  IF coalesce(trim(p_reason), '') = '' THEN RAISE EXCEPTION 'Say why these are the same person'; END IF;
  SELECT * INTO v_source FROM public.person_records WHERE id = p_source_person_record_id AND organization_id = p_organization_id FOR UPDATE;
  SELECT * INTO v_target FROM public.person_records WHERE id = p_target_person_record_id AND organization_id = p_organization_id FOR UPDATE;
  IF v_source.id IS NULL OR v_target.id IS NULL OR v_source.id = v_target.id THEN RAISE EXCEPTION 'Choose two different people in this organisation'; END IF;
  IF v_source.metadata ? 'merged_into_person_record_id' OR v_target.metadata ? 'merged_into_person_record_id'
     OR v_source.metadata ? 'resolved_into_person_record_id' OR v_target.metadata ? 'resolved_into_person_record_id' THEN
    RAISE EXCEPTION 'One of these records has already been merged';
  END IF;
  IF v_source.review_state = 'verified' AND v_target.review_state <> 'verified' THEN
    RAISE EXCEPTION 'Keep the verified record: merge the unverified profile into the verified one';
  END IF;
  IF nullif(v_source.metadata->'profile_details'->>'staff_profile_id', '') IS NOT NULL
     AND nullif(v_target.metadata->'profile_details'->>'staff_profile_id', '') IS NOT NULL
     AND v_source.metadata->'profile_details'->>'staff_profile_id' <> v_target.metadata->'profile_details'->>'staff_profile_id' THEN
    RAISE EXCEPTION 'Both records belong to different staff members';
  END IF;
  v_source_canonical := public.ensure_canonical_person_for_record(v_source.id);
  v_target_canonical := public.ensure_canonical_person_for_record(v_target.id);

  -- Identity evidence and biometrics follow the person.
  UPDATE public.person_identity_documents SET person_record_id = v_target.id, updated_at = clock_timestamp() WHERE person_record_id = v_source.id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('identity_documents', v_n);
  UPDATE public.person_identity_face_proposals SET person_record_id = v_target.id WHERE person_record_id = v_source.id;
  DELETE FROM public.person_face_templates s WHERE s.person_record_id = v_source.id AND EXISTS (
    SELECT 1 FROM public.person_face_templates t WHERE t.person_record_id = v_target.id AND t.organization_id = s.organization_id
      AND t.source_kind = s.source_kind AND t.source_ref = s.source_ref);
  UPDATE public.person_face_templates SET person_record_id = v_target.id WHERE person_record_id = v_source.id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('face_templates', v_n);

  -- Incidents (unique per incident, canonical person and role).
  FOR v_incident_link IN SELECT * FROM public.incident_person_links WHERE person_record_id = v_source.id LOOP
    INSERT INTO public.incident_person_links(organization_id, incident_id, canonical_person_id, person_record_id, staff_profile_id, identity_document_id,
      involvement_role, source_kind, notes, recorded_by, created_at, updated_at)
    VALUES (v_incident_link.organization_id, v_incident_link.incident_id, v_target_canonical, v_target.id,
      coalesce(nullif(v_target.metadata->'profile_details'->>'staff_profile_id', '')::uuid, v_incident_link.staff_profile_id),
      v_incident_link.identity_document_id, v_incident_link.involvement_role, v_incident_link.source_kind, v_incident_link.notes,
      v_actor, v_incident_link.created_at, clock_timestamp())
    ON CONFLICT (incident_id, canonical_person_id, involvement_role) DO UPDATE SET
      person_record_id = excluded.person_record_id,
      identity_document_id = coalesce(incident_person_links.identity_document_id, excluded.identity_document_id),
      updated_at = clock_timestamp();
  END LOOP;
  DELETE FROM public.incident_person_links WHERE person_record_id = v_source.id;

  -- Sightings, CCTV and reviews.
  UPDATE public.cctv_entity_observations SET person_record_id = v_target.id, canonical_person_id = v_target_canonical WHERE person_record_id = v_source.id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('cctv_sightings', v_n);
  UPDATE public.face_observations SET person_record_id = v_target.id WHERE person_record_id = v_source.id;
  UPDATE public.observations SET person_record_id = v_target.id WHERE person_record_id = v_source.id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('observations', v_n);
  UPDATE public.cctv_identity_drafts SET proposed_person_record_id = v_target.id WHERE proposed_person_record_id = v_source.id;
  UPDATE public.cctv_identity_drafts SET final_person_record_id = v_target.id WHERE final_person_record_id = v_source.id;
  UPDATE public.cctv_review_event_decisions SET linked_person_record_id = v_target.id WHERE linked_person_record_id = v_source.id;
  UPDATE public.cctv_review_events SET linked_person_record_id = v_target.id WHERE linked_person_record_id = v_source.id;
  -- NZTA owner checks follow the person on both identity keys; the owner-history trigger then rebuilds
  -- the vehicle's registered-owner periods for the kept person.
  UPDATE public.vehicle_identity_checks SET person_record_id = v_target.id, canonical_person_id = v_target_canonical
  WHERE person_record_id = v_source.id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('vehicle_owner_checks', v_n);
  DELETE FROM public.observation_person_mentions s WHERE s.person_record_id = v_source.id AND s.status <> 'dismissed' AND EXISTS (
    SELECT 1 FROM public.observation_person_mentions t WHERE t.person_record_id = v_target.id AND t.observation_id = s.observation_id AND t.status <> 'dismissed');
  UPDATE public.observation_person_mentions SET person_record_id = v_target.id WHERE person_record_id = v_source.id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('sighting_mentions', v_n);

  -- Vehicle people and other graph edges keyed by canonical person.
  FOR v_link IN SELECT * FROM public.entity_links WHERE from_type = 'person' AND from_id = v_source_canonical AND active LOOP
    IF EXISTS (SELECT 1 FROM public.entity_links t WHERE t.organization_id = v_link.organization_id AND t.from_type = 'person'
        AND t.from_id = v_target_canonical AND t.to_type = v_link.to_type AND t.to_id = v_link.to_id AND t.relationship = v_link.relationship AND t.active) THEN
      UPDATE public.entity_links t SET evidence = t.evidence || jsonb_build_object('observation_ids', (
          SELECT coalesce(jsonb_agg(DISTINCT item), '[]'::jsonb)
          FROM jsonb_array_elements(coalesce(t.evidence->'observation_ids', '[]'::jsonb) || coalesce(v_link.evidence->'observation_ids', '[]'::jsonb)) item)),
        updated_at = clock_timestamp()
      WHERE t.organization_id = v_link.organization_id AND t.from_type = 'person' AND t.from_id = v_target_canonical
        AND t.to_type = v_link.to_type AND t.to_id = v_link.to_id AND t.relationship = v_link.relationship AND t.active;
      UPDATE public.entity_links SET active = false, ends_at = clock_timestamp(), updated_at = clock_timestamp(),
        evidence = evidence || jsonb_build_object('merged_into_canonical_person_id', v_target_canonical)
      WHERE id = v_link.id;
    ELSE
      UPDATE public.entity_links SET from_id = v_target_canonical, updated_at = clock_timestamp(),
        evidence = evidence || jsonb_build_object('person_record_id', v_target.id, 'merged_from_person_record_id', v_source.id)
      WHERE id = v_link.id;
    END IF;
  END LOOP;
  UPDATE public.entity_links SET from_id = v_target_canonical, updated_at = clock_timestamp()
  WHERE from_type = 'person' AND from_id = v_source_canonical AND NOT active;
  UPDATE public.entity_links SET to_id = v_target_canonical, updated_at = clock_timestamp()
  WHERE to_type = 'person' AND to_id = v_source_canonical;
  UPDATE public.entity_flags SET entity_id = v_target_canonical WHERE entity_type = 'person' AND entity_id = v_source_canonical;

  -- Names: the other profile's name becomes an AKA of the kept person.
  v_name := coalesce(nullif(trim(p_display_name), ''), v_target.display_name);
  IF public.normalize_person_name(v_name) IS NULL THEN RAISE EXCEPTION 'The kept person needs a name'; END IF;
  UPDATE public.person_record_aliases s SET active = false, retired_at = clock_timestamp(), retired_by = v_actor, retired_reason = 'Duplicate after merge'
  WHERE s.person_record_id = v_source.id AND s.active AND EXISTS (
    SELECT 1 FROM public.person_record_aliases t WHERE t.person_record_id = v_target.id AND t.active AND t.alias_norm = s.alias_norm);
  UPDATE public.person_record_aliases SET person_record_id = v_target.id, organization_id = p_organization_id WHERE person_record_id = v_source.id;
  INSERT INTO public.person_record_aliases (organization_id, person_record_id, alias, alias_norm, alias_kind, source, notes, created_by)
  SELECT p_organization_id, v_target.id, n.name, public.normalize_person_name(n.name), 'merged_record', 'merge', trim(p_reason), v_actor
  FROM (VALUES (v_source.display_name), (v_target.display_name)) n(name)
  WHERE public.normalize_person_name(n.name) IS NOT NULL AND public.normalize_person_name(n.name) <> public.normalize_person_name(v_name)
  ON CONFLICT (person_record_id, alias_norm) WHERE active DO NOTHING;
  -- Kept name is no longer an alias of itself.
  UPDATE public.person_record_aliases SET active = false, retired_at = clock_timestamp(), retired_by = v_actor, retired_reason = 'Now the main name'
  WHERE person_record_id = v_target.id AND active AND alias_norm = public.normalize_person_name(v_name);

  UPDATE public.person_records SET
    display_name = v_name,
    metadata = metadata
      || jsonb_build_object('profile_details', coalesce(v_source.metadata->'profile_details', '{}'::jsonb) || coalesce(metadata->'profile_details', '{}'::jsonb))
      || CASE WHEN NOT (metadata ? 'face_reference') AND v_source.metadata ? 'face_reference'
           THEN jsonb_build_object('face_reference', v_source.metadata->'face_reference') ELSE '{}'::jsonb END
      || jsonb_build_object('merged_from_person_record_ids',
           coalesce(metadata->'merged_from_person_record_ids', '[]'::jsonb) || jsonb_build_array(v_source.id))
  WHERE id = v_target.id;
  UPDATE public.canonical_people SET display_name = v_name, normalized_name = public.normalize_person_name(v_name), updated_at = clock_timestamp()
  WHERE id = v_target_canonical;

  UPDATE public.canonical_person_links SET canonical_person_id = v_target_canonical,
    metadata = metadata || jsonb_build_object('merged_from_canonical_person_id', v_source_canonical, 'merged_by', v_actor, 'merged_at', clock_timestamp())
  WHERE source_table = 'person_records' AND source_id = v_source.id;
  IF NOT EXISTS (SELECT 1 FROM public.canonical_person_links WHERE canonical_person_id = v_source_canonical) THEN
    UPDATE public.canonical_people SET status = 'merged', merged_into_id = v_target_canonical, updated_at = clock_timestamp() WHERE id = v_source_canonical;
  END IF;
  UPDATE public.person_records SET review_state = 'rejected',
    metadata = metadata || jsonb_build_object('merged_into_person_record_id', v_target.id, 'merged_at', clock_timestamp(),
      'merged_by', v_actor, 'merge_reason', trim(p_reason))
  WHERE id = v_source.id;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (p_organization_id, v_actor, 'person_records_merged', 'person_records', v_target.id, jsonb_build_object(
    'source_person_record_id', v_source.id, 'source_display_name', v_source.display_name,
    'target_person_record_id', v_target.id, 'kept_display_name', v_name,
    'source_canonical_person_id', v_source_canonical, 'target_canonical_person_id', v_target_canonical,
    'moved', v_counts, 'reason', trim(p_reason)));
  RETURN jsonb_build_object('person_record_id', v_target.id, 'merged_person_record_id', v_source.id,
    'canonical_person_id', v_target_canonical, 'display_name', v_name, 'moved', v_counts);
END;
$function$;

COMMENT ON FUNCTION public.merge_person_records(uuid, uuid, uuid, text, text) IS 'Administrator merge of two profiles of the same person (for example a CCTV "Unknown Person #N" and a named person). Moves identity evidence, face templates, sightings, CCTV, incidents, NZTA owner checks (person record and canonical person, so owner history follows), vehicle people, mentions, flags and aliases to the kept record; the other name becomes an AKA; the merged record is retained (rejected, merged_into_person_record_id) for audit.';
REVOKE ALL ON FUNCTION public.merge_person_records(uuid, uuid, uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.merge_person_records(uuid, uuid, uuid, text, text) TO authenticated;
