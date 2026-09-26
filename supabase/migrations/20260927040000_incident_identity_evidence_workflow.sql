-- Incident-scoped officer ID capture -> deterministic proposal -> admin review -> optional staff credential handoff.

CREATE OR REPLACE FUNCTION public.identity_actor_can_admin(p_actor_user_id uuid,p_organization_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT EXISTS(
    SELECT 1 FROM public.user_profiles profile
    WHERE profile.id=p_actor_user_id AND profile.deactivated_at IS NULL
      AND profile.role IN ('grand_master','master','admin')
      AND (profile.role='grand_master'
        OR (profile.role='master' AND (p_organization_id=ANY(public.get_descendant_organizations(profile.employer_organization_id))
          OR p_organization_id=ANY(public.get_descendant_organizations(profile.organization_id))
          OR EXISTS(SELECT 1 FROM public.service_agreements agreement WHERE agreement.agreement_type='operational'
            AND (agreement.ends_on IS NULL OR agreement.ends_on>=current_date)
            AND agreement.client_organization_id=p_organization_id
            AND (profile.organization_id=agreement.provider_organization_id OR profile.employer_organization_id=agreement.provider_organization_id))))
        OR (profile.role='admin' AND (profile.organization_id=p_organization_id
          OR p_organization_id=ANY(public.get_descendant_organizations(profile.organization_id))
          OR EXISTS(SELECT 1 FROM public.service_agreements agreement WHERE agreement.agreement_type='operational'
            AND (agreement.ends_on IS NULL OR agreement.ends_on>=current_date)
            AND agreement.client_organization_id=p_organization_id
            AND (profile.organization_id=agreement.provider_organization_id OR profile.employer_organization_id=agreement.provider_organization_id)))))
  ) OR EXISTS(
      SELECT 1 FROM public.user_profiles profile
      JOIN public.incidents incident ON incident.officer_user_id=profile.id
      WHERE profile.id=p_actor_user_id AND profile.deactivated_at IS NULL
        AND profile.role IN ('officer','admin_officer') AND incident.organization_id=p_organization_id
        AND incident.status IN ('open','in_review','escalated')
    )
$$;

DROP POLICY IF EXISTS identity_evidence_select ON storage.objects;
DROP POLICY IF EXISTS identity_evidence_insert ON storage.objects;
DROP POLICY IF EXISTS identity_evidence_update ON storage.objects;
DROP POLICY IF EXISTS identity_evidence_delete ON storage.objects;
CREATE POLICY identity_evidence_select ON storage.objects FOR SELECT TO authenticated USING (
  bucket_id='identity-evidence' AND (storage.foldername(name))[1]='org'
  AND (storage.foldername(name))[2] ~ '^[0-9a-fA-F-]{36}$'
  AND (
    public.is_admin_for_org(((storage.foldername(name))[2])::uuid)
    OR ((storage.foldername(name))[3]='identity' AND (storage.foldername(name))[4]=auth.uid()::text
      AND (storage.foldername(name))[5] ~ '^incident-[0-9a-fA-F-]{36}$'
      AND public.can_record_incident_person(substring((storage.foldername(name))[5] from 10)::uuid,auth.uid()))
  )
);
CREATE POLICY identity_evidence_insert ON storage.objects FOR INSERT TO authenticated WITH CHECK (
  bucket_id='identity-evidence' AND (storage.foldername(name))[1]='org'
  AND (storage.foldername(name))[2] ~ '^[0-9a-fA-F-]{36}$'
  AND (
    public.is_admin_for_org(((storage.foldername(name))[2])::uuid)
    OR ((storage.foldername(name))[3]='identity' AND (storage.foldername(name))[4]=auth.uid()::text
      AND (storage.foldername(name))[5] ~ '^incident-[0-9a-fA-F-]{36}$'
      AND public.can_record_incident_person(substring((storage.foldername(name))[5] from 10)::uuid,auth.uid()))
  )
);
CREATE POLICY identity_evidence_update ON storage.objects FOR UPDATE TO authenticated USING (
  bucket_id='identity-evidence' AND (public.is_admin_for_org(((storage.foldername(name))[2])::uuid)
    OR ((storage.foldername(name))[4]=auth.uid()::text AND (storage.foldername(name))[5] ~ '^incident-[0-9a-fA-F-]{36}$'
      AND public.can_record_incident_person(substring((storage.foldername(name))[5] from 10)::uuid,auth.uid())))
) WITH CHECK (bucket_id='identity-evidence');
CREATE POLICY identity_evidence_delete ON storage.objects FOR DELETE TO authenticated USING (
  bucket_id='identity-evidence' AND (public.is_admin_for_org(((storage.foldername(name))[2])::uuid)
    OR ((storage.foldername(name))[4]=auth.uid()::text AND (storage.foldername(name))[5] ~ '^incident-[0-9a-fA-F-]{36}$'
      AND public.can_record_incident_person(substring((storage.foldername(name))[5] from 10)::uuid,auth.uid())))
);

CREATE OR REPLACE FUNCTION public.register_incident_identity_attachment(
  p_incident_id uuid,p_person_record_id uuid,p_document_kind text,p_attachment_id uuid,
  p_file_name text,p_file_type text,p_file_size_bytes bigint,p_storage_path text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_actor uuid:=auth.uid();v_incident public.incidents%rowtype;v_conversation uuid;v_definition public.identity_document_type_definitions%rowtype;
BEGIN
  SELECT * INTO v_incident FROM public.incidents WHERE id=p_incident_id;
  IF v_incident.id IS NULL OR v_actor IS NULL OR NOT public.can_record_incident_person(v_incident.id,v_actor) THEN RAISE EXCEPTION 'Assigned incident access required'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.incident_person_links WHERE incident_id=v_incident.id AND person_record_id=p_person_record_id) THEN RAISE EXCEPTION 'Record the person on the incident before adding identity evidence'; END IF;
  SELECT * INTO v_definition FROM public.identity_document_type_definitions WHERE document_kind=p_document_kind AND active;
  IF v_definition.document_kind IS NULL THEN RAISE EXCEPTION 'Unsupported identity document kind'; END IF;
  IF p_file_type NOT IN ('image/jpeg','image/png','image/webp','image/bmp','image/tiff','application/pdf') THEN RAISE EXCEPTION 'Unsupported identity evidence file type'; END IF;
  IF p_file_size_bytes<=0 OR p_file_size_bytes>26214400 THEN RAISE EXCEPTION 'Identity evidence must be 25 MB or smaller'; END IF;
  IF p_storage_path NOT LIKE 'org/'||v_incident.organization_id::text||'/identity/'||v_actor::text||'/incident-'||v_incident.id::text||'/%' THEN RAISE EXCEPTION 'Identity evidence path is outside the incident scope'; END IF;
  IF NOT EXISTS(SELECT 1 FROM storage.objects object WHERE object.bucket_id='identity-evidence' AND object.name=p_storage_path) THEN RAISE EXCEPTION 'Uploaded identity evidence object not found'; END IF;
  SELECT id INTO v_conversation FROM public.bob_conversations WHERE organization_id=v_incident.organization_id AND user_id=v_actor AND module_key='operations' ORDER BY updated_at DESC LIMIT 1;
  IF v_conversation IS NULL THEN
    INSERT INTO public.bob_conversations(organization_id,user_id,module_key,title)VALUES(v_incident.organization_id,v_actor,'operations','Incident identity evidence')RETURNING id INTO v_conversation;
  END IF;
  INSERT INTO public.bob_attachments(id,organization_id,conversation_id,uploaded_by,file_name,file_type,file_size_bytes,storage_bucket,storage_path,purpose,processing_state,extraction_payload)
  VALUES(p_attachment_id,v_incident.organization_id,v_conversation,v_actor,p_file_name,p_file_type,p_file_size_bytes,'identity-evidence',p_storage_path,'identity_document','processing',jsonb_build_object(
    'incident_id',v_incident.id,'person_record_id',p_person_record_id,'document_kind',p_document_kind,'capture_authority','assigned_incident'));
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  VALUES(v_incident.organization_id,v_actor,'incident_identity_attachment_registered','bob_attachments',p_attachment_id,jsonb_build_object('incident_id',v_incident.id,'person_record_id',p_person_record_id,'document_kind',p_document_kind));
  RETURN jsonb_build_object('attachment_id',p_attachment_id,'organization_id',v_incident.organization_id,'person_record_id',p_person_record_id,'document_kind',p_document_kind);
END;
$$;
REVOKE ALL ON FUNCTION public.register_incident_identity_attachment(uuid,uuid,text,uuid,text,text,bigint,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.register_incident_identity_attachment(uuid,uuid,text,uuid,text,text,bigint,text) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.attach_incident_identity_proposal(p_actor_user_id uuid,p_incident_id uuid,p_person_record_id uuid,p_identity_document_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_document public.person_identity_documents%rowtype;BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' AND session_user NOT IN ('postgres','supabase_admin') THEN RAISE EXCEPTION 'Service identity required'; END IF;
  IF NOT public.can_record_incident_person(p_incident_id,p_actor_user_id) THEN RAISE EXCEPTION 'Assigned incident access required'; END IF;
  SELECT * INTO v_document FROM public.person_identity_documents WHERE id=p_identity_document_id AND person_record_id=p_person_record_id;
  IF v_document.id IS NULL THEN RAISE EXCEPTION 'Identity proposal does not belong to this incident person'; END IF;
  UPDATE public.incident_person_links SET identity_document_id=v_document.id,updated_at=clock_timestamp()
  WHERE incident_id=p_incident_id AND person_record_id=p_person_record_id;
  INSERT INTO public.incident_attachments(organization_id,incident_id,evidence_item_id,attachment_kind)
  SELECT v_document.organization_id,p_incident_id,v_document.evidence_item_id,'document'
  WHERE NOT EXISTS(SELECT 1 FROM public.incident_attachments WHERE incident_id=p_incident_id AND evidence_item_id=v_document.evidence_item_id);
END;
$$;
REVOKE ALL ON FUNCTION public.attach_incident_identity_proposal(uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.attach_incident_identity_proposal(uuid,uuid,uuid,uuid) TO postgres,service_role;

CREATE OR REPLACE FUNCTION public.review_canonical_identity_evidence(
  p_identity_document_id uuid,p_action text,p_approved_fields jsonb DEFAULT '{}'::jsonb,p_review_notes text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_document public.person_identity_documents%rowtype;v_definition public.identity_document_type_definitions%rowtype;v_person public.person_records%rowtype;
  v_result jsonb;v_staff_id uuid;v_credential_id uuid;v_number text;v_authority text;v_issued date;v_expiry date;v_activities text[];v_storage_path text;
BEGIN
  SELECT * INTO v_document FROM public.person_identity_documents WHERE id=p_identity_document_id;
  IF v_document.id IS NULL THEN RAISE EXCEPTION 'Identity document not found'; END IF;
  SELECT * INTO v_definition FROM public.identity_document_type_definitions WHERE document_kind=v_document.document_kind;
  v_result:=public.review_deterministic_identity_evidence(p_identity_document_id,p_action,p_approved_fields,p_review_notes);
  IF p_action='approve' THEN
    UPDATE public.incident_person_links SET source_kind='identity_document',updated_at=clock_timestamp() WHERE identity_document_id=v_document.id;
    SELECT * INTO v_person FROM public.person_records WHERE id=v_document.person_record_id;
    v_staff_id:=nullif(v_person.metadata->'profile_details'->>'staff_profile_id','')::uuid;
    IF v_staff_id IS NOT NULL AND v_definition.staff_credential_type IS NOT NULL THEN
      v_number:=coalesce(nullif(trim(p_approved_fields->>'security_licence_number'),''),nullif(trim(p_approved_fields->>'driver_licence_number'),''),nullif(trim(p_approved_fields->>'firearms_licence_number'),''),nullif(trim(p_approved_fields->>'document_number'),''));
      v_authority:=coalesce(nullif(trim(p_approved_fields->>'security_licence_authority'),''),nullif(trim(p_approved_fields->>'issuing_authority'),''));
      v_issued:=nullif(p_approved_fields->>'issued_date','')::date;
      v_expiry:=coalesce(nullif(p_approved_fields->>'security_licence_expiry','')::date,nullif(p_approved_fields->>'driver_licence_expiry','')::date,nullif(p_approved_fields->>'firearms_licence_expiry','')::date,nullif(p_approved_fields->>'expiry_date','')::date);
      v_activities:=CASE WHEN nullif(trim(p_approved_fields->>'authorized_activities'),'') IS NOT NULL THEN regexp_split_to_array(trim(p_approved_fields->>'authorized_activities'),'\s*,\s*') ELSE v_definition.default_authorized_activities END;
      SELECT credential_id INTO v_credential_id FROM public.record_staff_credential(v_document.id,v_staff_id,v_definition.staff_credential_type,v_number,v_authority,v_issued,v_expiry,v_activities,false,'Created from approved identity evidence; People & HR verification still required');
      SELECT attachment.storage_path INTO v_storage_path FROM public.bob_attachments attachment WHERE attachment.id=v_document.attachment_id;
      UPDATE public.staff_credentials SET document_storage_path=v_storage_path WHERE id=v_credential_id;
    END IF;
  END IF;
  RETURN v_result||jsonb_build_object('staff_credential_handoff_id',v_credential_id,'staff_verification_required',v_credential_id IS NOT NULL);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.review_deterministic_identity_evidence(uuid,text,jsonb,text) FROM authenticated;
REVOKE ALL ON FUNCTION public.review_canonical_identity_evidence(uuid,text,jsonb,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.review_canonical_identity_evidence(uuid,text,jsonb,text) TO authenticated,service_role;

COMMENT ON FUNCTION public.register_incident_identity_attachment(uuid,uuid,text,uuid,text,text,bigint,text) IS 'Assigned-officer/admin registration of an uploaded incident-scoped ID source before trusted OCR/face inference.';
COMMENT ON FUNCTION public.review_canonical_identity_evidence(uuid,text,jsonb,text) IS 'Admin approval boundary for canonical identity evidence; staff projections receive an unverified Staff Credential handoff for People & HR review.';
