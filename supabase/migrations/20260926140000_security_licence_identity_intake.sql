-- Extend governed identity intake for security licences / CoA and historical licence evidence.

CREATE OR REPLACE FUNCTION public.register_identity_document_proposal(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_person_record_id uuid,
  p_attachment_id uuid,
  p_document_kind text,
  p_sha256 text,
  p_proposed_fields jsonb,
  p_face_embedding jsonb DEFAULT NULL,
  p_face_confidence real DEFAULT NULL,
  p_face_count integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := p_actor_user_id;
  v_attachment public.bob_attachments%rowtype;
  v_evidence_id uuid;
  v_document_id uuid;
  v_candidate_matches jsonb := '[]'::jsonb;
  v_face_vec vector(128);
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'Service identity required for identity extraction registration';
  END IF;
  IF v_actor IS NULL OR NOT public.identity_actor_can_admin(v_actor, p_organization_id) THEN RAISE EXCEPTION 'Identity registry administrator access required'; END IF;
  IF p_document_kind NOT IN ('driver_licence','firearms_licence','security_licence','passport','national_id','person_photo','other_identity') THEN RAISE EXCEPTION 'Unsupported identity document kind'; END IF;
  IF p_sha256 !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Identity document SHA-256 is required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.person_records WHERE id = p_person_record_id AND organization_id = p_organization_id) THEN RAISE EXCEPTION 'Person record not found in this organization'; END IF;
  SELECT * INTO v_attachment FROM public.bob_attachments
  WHERE id = p_attachment_id AND organization_id = p_organization_id AND uploaded_by = v_actor;
  IF v_attachment.id IS NULL THEN RAISE EXCEPTION 'Identity attachment not found for this administrator'; END IF;
  IF v_attachment.purpose <> 'identity_document' OR v_attachment.storage_bucket <> 'identity-evidence'
     OR v_attachment.storage_path NOT LIKE 'org/' || p_organization_id::text || '/identity/' || v_actor::text || '/%' THEN
    RAISE EXCEPTION 'Identity attachment is outside the governed private intake path';
  END IF;
  SELECT id INTO v_document_id FROM public.person_identity_documents WHERE attachment_id = p_attachment_id;
  IF v_document_id IS NOT NULL THEN RETURN jsonb_build_object('identity_document_id', v_document_id, 'duplicate', true); END IF;

  INSERT INTO public.evidence_items (organization_id, module_key, evidence_kind, storage_path, captured_by_user_id, captured_at, sha256_hash, metadata)
  VALUES (p_organization_id, 'identity_registry', 'document', v_attachment.storage_path, v_actor, v_attachment.created_at, p_sha256,
    jsonb_build_object('storage_bucket', v_attachment.storage_bucket, 'file_name', v_attachment.file_name,
      'file_type', v_attachment.file_type, 'file_size_bytes', v_attachment.file_size_bytes,
      'attachment_id', v_attachment.id, 'document_kind', p_document_kind,
      'authority', 'source_document', 'human_review_required', true))
  RETURNING id INTO v_evidence_id;

  IF p_face_count = 1 AND jsonb_typeof(p_face_embedding) = 'array' AND jsonb_array_length(p_face_embedding) = 128 THEN
    v_face_vec := public.cctv_jsonb_to_vector(p_face_embedding, 128);
  END IF;
  IF v_face_vec IS NOT NULL THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'match_kind', match_kind, 'match_id', match_id, 'observation_id', observation_id,
      'display_name', display_name, 'score', score, 'basis', basis, 'last_seen_at', last_seen_at
    ) ORDER BY score DESC), '[]'::jsonb)
    INTO v_candidate_matches
    FROM public.find_cctv_portfolio_matches(p_organization_id, 'person', p_face_embedding, NULL, NULL, NULL, 10);
  END IF;

  INSERT INTO public.person_identity_documents (organization_id, person_record_id, evidence_item_id, attachment_id,
    document_kind, extracted_fields, id_photo_storage_path, review_state, created_by, face_confidence, face_count)
  VALUES (p_organization_id, p_person_record_id, v_evidence_id, p_attachment_id, p_document_kind,
    jsonb_build_object('proposed', coalesce(p_proposed_fields, '{}'::jsonb), 'face_count', greatest(coalesce(p_face_count, 0), 0),
      'candidate_matches', v_candidate_matches, 'ocr_authority', 'advisory', 'review_required', true),
    CASE WHEN v_attachment.file_type LIKE 'image/%' THEN v_attachment.storage_path ELSE NULL END,
    'manual_review_required', v_actor, CASE WHEN v_face_vec IS NOT NULL THEN p_face_confidence ELSE NULL END,
    greatest(coalesce(p_face_count, 0), 0))
  RETURNING id INTO v_document_id;
  IF v_face_vec IS NOT NULL THEN
    INSERT INTO public.person_identity_face_proposals (identity_document_id, organization_id, person_record_id, face_vec, confidence)
    VALUES (v_document_id, p_organization_id, p_person_record_id, v_face_vec, p_face_confidence);
  END IF;
  UPDATE public.bob_attachments SET processing_state = 'manual_review_required', extraction_payload = jsonb_build_object(
    'identity_document_id', v_document_id, 'document_kind', p_document_kind, 'proposed_fields', coalesce(p_proposed_fields, '{}'::jsonb),
    'face_count', greatest(coalesce(p_face_count, 0), 0)), confidence = p_face_confidence WHERE id = p_attachment_id;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (p_organization_id, v_actor, 'identity_document_proposed', 'person_identity_documents', v_document_id,
    jsonb_build_object('person_record_id', p_person_record_id, 'document_kind', p_document_kind, 'attachment_id', p_attachment_id,
      'evidence_item_id', v_evidence_id, 'face_count', greatest(coalesce(p_face_count, 0), 0)));
  RETURN jsonb_build_object('identity_document_id', v_document_id, 'evidence_item_id', v_evidence_id,
    'face_candidate_pending', v_face_vec IS NOT NULL, 'candidate_matches', v_candidate_matches, 'duplicate', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.manage_identity_person_record(
  p_organization_id uuid,
  p_person_record_id uuid,
  p_action text,
  p_fields jsonb,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
  v_person_id uuid;
  v_security jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN RAISE EXCEPTION 'Identity registry administrator access required'; END IF;
  v_result := public.manage_identity_person(p_organization_id, p_person_record_id, p_action, p_fields, p_reason);
  IF p_action NOT IN ('create','update') THEN RETURN v_result; END IF;
  v_person_id := (v_result->>'person_record_id')::uuid;
  v_security := jsonb_strip_nulls(jsonb_build_object(
    'security_licence_number', nullif(trim(p_fields->>'security_licence_number'), ''),
    'security_licence_expiry', nullif(p_fields->>'security_licence_expiry', '')::date,
    'security_licence_authority', nullif(trim(p_fields->>'security_licence_authority'), ''),
    'security_endorsements', nullif(trim(p_fields->>'security_endorsements'), '')
  ));
  IF v_security <> '{}'::jsonb THEN
    UPDATE public.person_records
    SET metadata = metadata || jsonb_build_object('profile_details', coalesce(metadata->'profile_details', '{}'::jsonb) || v_security)
    WHERE id = v_person_id AND organization_id = p_organization_id;
  END IF;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.review_identity_evidence(
  p_identity_document_id uuid,
  p_action text,
  p_approved_fields jsonb DEFAULT '{}'::jsonb,
  p_review_notes text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_document public.person_identity_documents%rowtype;
  v_person public.person_records%rowtype;
  v_prior_details jsonb;
  v_current_details jsonb;
  v_result jsonb;
  v_approved jsonb;
  v_number_key text;
  v_expiry_key text;
  v_incoming_expiry date;
  v_existing_expiry date;
  v_promote_current boolean := false;
  v_value text;
BEGIN
  SELECT * INTO v_document FROM public.person_identity_documents WHERE id = p_identity_document_id;
  IF v_document.id IS NULL THEN RAISE EXCEPTION 'Identity document not found'; END IF;
  IF auth.uid() IS NULL OR NOT public.is_admin_for_org(v_document.organization_id) THEN RAISE EXCEPTION 'Identity registry administrator access required'; END IF;
  SELECT * INTO v_person FROM public.person_records WHERE id = v_document.person_record_id AND organization_id = v_document.organization_id;
  IF v_person.id IS NULL THEN RAISE EXCEPTION 'Linked person record not found'; END IF;
  v_prior_details := coalesce(v_person.metadata->'profile_details', '{}'::jsonb);

  v_result := public.review_identity_document(p_identity_document_id, p_action, p_approved_fields, p_review_notes);
  IF p_action <> 'approve' THEN RETURN v_result; END IF;

  v_approved := jsonb_strip_nulls(jsonb_build_object(
    'display_name', nullif(trim(p_approved_fields->>'display_name'), ''),
    'date_of_birth', nullif(p_approved_fields->>'date_of_birth', '')::date,
    'address', nullif(trim(p_approved_fields->>'address'), ''),
    'issued_date', nullif(p_approved_fields->>'issued_date', '')::date,
    'expiry_date', nullif(p_approved_fields->>'expiry_date', '')::date,
    'document_number', nullif(trim(p_approved_fields->>'document_number'), ''),
    'driver_licence_number', nullif(trim(p_approved_fields->>'driver_licence_number'), ''),
    'driver_licence_expiry', nullif(p_approved_fields->>'driver_licence_expiry', '')::date,
    'firearms_licence_number', nullif(trim(p_approved_fields->>'firearms_licence_number'), ''),
    'firearms_licence_expiry', nullif(p_approved_fields->>'firearms_licence_expiry', '')::date,
    'security_licence_number', nullif(trim(p_approved_fields->>'security_licence_number'), ''),
    'security_licence_expiry', nullif(p_approved_fields->>'security_licence_expiry', '')::date,
    'security_licence_authority', nullif(trim(p_approved_fields->>'security_licence_authority'), ''),
    'security_endorsements', nullif(trim(p_approved_fields->>'security_endorsements'), '')
  ));

  IF v_document.document_kind = 'driver_licence' THEN
    v_number_key := 'driver_licence_number'; v_expiry_key := 'driver_licence_expiry';
  ELSIF v_document.document_kind = 'firearms_licence' THEN
    v_number_key := 'firearms_licence_number'; v_expiry_key := 'firearms_licence_expiry';
  ELSIF v_document.document_kind = 'security_licence' THEN
    v_number_key := 'security_licence_number'; v_expiry_key := 'security_licence_expiry';
  END IF;

  IF v_expiry_key IS NOT NULL THEN
    v_incoming_expiry := coalesce(nullif(p_approved_fields->>v_expiry_key, '')::date, nullif(p_approved_fields->>'expiry_date', '')::date);
    v_existing_expiry := nullif(v_prior_details->>v_expiry_key, '')::date;
    v_promote_current := (v_incoming_expiry IS NULL OR v_incoming_expiry >= current_date)
      AND (v_existing_expiry IS NULL OR (v_incoming_expiry IS NOT NULL AND v_incoming_expiry >= v_existing_expiry));
    v_current_details := coalesce((SELECT metadata->'profile_details' FROM public.person_records WHERE id = v_person.id), '{}'::jsonb);
    IF v_promote_current THEN
      IF nullif(trim(p_approved_fields->>v_number_key), '') IS NOT NULL THEN
        v_current_details := jsonb_set(v_current_details, ARRAY[v_number_key], to_jsonb(trim(p_approved_fields->>v_number_key)), true);
      END IF;
      IF v_incoming_expiry IS NOT NULL THEN
        v_current_details := jsonb_set(v_current_details, ARRAY[v_expiry_key], to_jsonb(v_incoming_expiry), true);
      END IF;
      IF v_document.document_kind = 'security_licence' THEN
        FOREACH v_number_key IN ARRAY ARRAY['security_licence_authority','security_endorsements'] LOOP
          v_value := nullif(trim(p_approved_fields->>v_number_key), '');
          IF v_value IS NOT NULL THEN v_current_details := jsonb_set(v_current_details, ARRAY[v_number_key], to_jsonb(v_value), true); END IF;
        END LOOP;
      END IF;
    ELSE
      FOREACH v_number_key IN ARRAY ARRAY[v_number_key, v_expiry_key] LOOP
        IF v_prior_details ? v_number_key THEN
          v_current_details := jsonb_set(v_current_details, ARRAY[v_number_key], v_prior_details->v_number_key, true);
        ELSE
          v_current_details := v_current_details - v_number_key;
        END IF;
      END LOOP;
    END IF;
    UPDATE public.person_records SET metadata = metadata || jsonb_build_object('profile_details', v_current_details) WHERE id = v_person.id;
  END IF;

  UPDATE public.person_identity_documents
  SET extracted_fields = extracted_fields || jsonb_build_object('approved', v_approved, 'promoted_to_current_profile', v_promote_current)
  WHERE id = v_document.id;
  RETURN v_result || jsonb_build_object('current_credential_updated', v_promote_current);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.manage_identity_person(uuid,uuid,text,jsonb,text) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.review_identity_document(uuid,text,jsonb,text) FROM authenticated;
REVOKE ALL ON FUNCTION public.manage_identity_person_record(uuid,uuid,text,jsonb,text) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.review_identity_evidence(uuid,text,jsonb,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.manage_identity_person_record(uuid,uuid,text,jsonb,text) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.review_identity_evidence(uuid,text,jsonb,text) TO authenticated,service_role;

COMMENT ON FUNCTION public.manage_identity_person_record(uuid,uuid,text,jsonb,text) IS 'Administrator identity-person write path, including manually reviewed security licence / CoA details.';
COMMENT ON FUNCTION public.review_identity_evidence(uuid,text,jsonb,text) IS 'Human review boundary for identity evidence. Keeps older/expired licence versions as evidence without replacing the current profile credential.';
