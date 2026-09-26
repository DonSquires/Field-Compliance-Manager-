-- Pending incident identity resolution to an existing staff/non-staff canonical person.
BEGIN;
SET LOCAL ROLE postgres;
SET LOCAL search_path TO public,extensions,pg_catalog;
CREATE OR REPLACE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM set_config('request.jwt.claims',json_build_object('sub',p_user::text,'role','authenticated')::text,true);PERFORM set_config('request.jwt.claim.sub',p_user::text,true);PERFORM set_config('request.jwt.claim.role','authenticated',true);SET LOCAL ROLE authenticated;END $$;
CREATE OR REPLACE FUNCTION pg_temp.as_admin() RETURNS void LANGUAGE plpgsql AS $$ BEGIN SET LOCAL ROLE postgres;END $$;
CREATE OR REPLACE FUNCTION pg_temp.check(p_label text,p_ok boolean) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF NOT coalesce(p_ok,false) THEN RAISE EXCEPTION 'FAIL [%]',p_label;END IF;RAISE NOTICE 'ok [%]',p_label;END $$;
DO $$
DECLARE
 v_org uuid:=gen_random_uuid();v_admin uuid:=gen_random_uuid();v_staff uuid:=gen_random_uuid();v_source uuid:=gen_random_uuid();v_target uuid;v_target_canonical uuid;v_source_canonical uuid;v_location uuid;v_incident uuid;v_conversation uuid:=gen_random_uuid();v_attachment uuid:=gen_random_uuid();v_evidence uuid:=gen_random_uuid();v_document uuid:=gen_random_uuid();v_result jsonb;
BEGIN
 INSERT INTO public.organizations(id,name,organization_type)VALUES(v_org,'T_ID_RESOLUTION','service_provider');
 INSERT INTO public.user_profiles(id,organization_id,role,display_name)VALUES(v_admin,v_org,'admin','Resolution Admin'),(v_staff,v_org,'officer','Known Staff Person');
 INSERT INTO public.staff_profiles(id,user_id,organization_id,employee_number)VALUES(v_staff,v_staff,v_org,'T-RESOLVE');
 SELECT canonical_person_id,person_record_id INTO v_target_canonical,v_target FROM public.ensure_canonical_person_for_staff(v_staff);
 INSERT INTO public.person_records(id,organization_id,display_name,review_state,metadata)VALUES(v_source,v_org,'Temporary Incident Person','manual_review_required','{}');
 v_source_canonical:=public.ensure_canonical_person_for_record(v_source);
 INSERT INTO public.locations(organization_id,name,address)VALUES(v_org,'Resolution Place','3 Test Way')RETURNING id INTO v_location;
 INSERT INTO public.incidents(organization_id,officer_user_id,location_id,incident_type,severity,description,status)VALUES(v_org,v_admin,v_location,'identity_resolution','standard','Resolution test','open')RETURNING id INTO v_incident;
 PERFORM set_config('request.jwt.claims',json_build_object('sub',v_admin::text,'role','authenticated')::text,true);PERFORM pg_temp.as_user(v_admin);
 PERFORM public.record_incident_person_identity(v_incident,'staff_involved','Temporary identity pending resolution',v_source,NULL,NULL,NULL);
 PERFORM pg_temp.as_admin();
 INSERT INTO public.bob_conversations(id,organization_id,user_id,module_key,title)VALUES(v_conversation,v_org,v_admin,'operations','Resolution test');
 INSERT INTO public.bob_attachments(id,organization_id,conversation_id,uploaded_by,file_name,file_type,file_size_bytes,storage_bucket,storage_path,purpose,processing_state)VALUES(v_attachment,v_org,v_conversation,v_admin,'resolve.jpg','image/jpeg',10,'identity-evidence','org/'||v_org||'/identity/'||v_admin||'/resolve.jpg','identity_document','manual_review_required');
 INSERT INTO public.evidence_items(id,organization_id,module_key,evidence_kind,storage_path,captured_by_user_id,sha256_hash,metadata)VALUES(v_evidence,v_org,'identity_registry','document','org/'||v_org||'/identity/'||v_admin||'/resolve.jpg',v_admin,repeat('5',64),'{}');
 INSERT INTO public.person_identity_documents(id,organization_id,person_record_id,evidence_item_id,attachment_id,document_kind,extracted_fields,review_state,created_by)
 VALUES(v_document,v_org,v_source,v_evidence,v_attachment,'security_licence',jsonb_build_object('candidate_matches',jsonb_build_array(jsonb_build_object('match_kind','person_record','match_id',v_target,'display_name','Known Staff Person','score',0.99,'basis','face_identity'))),'manual_review_required',v_admin);
 INSERT INTO public.person_identity_face_proposals(identity_document_id,organization_id,person_record_id,face_vec,confidence)VALUES(v_document,v_org,v_source,public.cctv_jsonb_to_vector(to_jsonb(array_fill(0.1::real,ARRAY[128])),128),0.99);
 UPDATE public.incident_person_links SET identity_document_id=v_document WHERE incident_id=v_incident AND person_record_id=v_source;
 PERFORM pg_temp.as_user(v_admin);
 PERFORM pg_temp.check('candidate RPC resolves a known staff projection',(SELECT count(*)=1 AND bool_and(person_record_id=v_target AND staff_profile_id=v_staff) FROM public.get_identity_resolution_candidates(v_document)));
 v_result:=public.resolve_identity_document_person(v_document,v_target,'Source face and identity fields match the known staff profile');
 PERFORM pg_temp.as_admin();
 PERFORM pg_temp.check('pending document and face proposal move to target',(SELECT person_record_id=v_target FROM public.person_identity_documents WHERE id=v_document) AND (SELECT person_record_id=v_target FROM public.person_identity_face_proposals WHERE identity_document_id=v_document));
 PERFORM pg_temp.check('incident now points to target staff canonical identity',(SELECT canonical_person_id=v_target_canonical AND person_record_id=v_target AND staff_profile_id=v_staff FROM public.incident_person_links WHERE incident_id=v_incident));
 PERFORM pg_temp.check('source projection is preserved as resolved history',(SELECT review_state='rejected' AND metadata->>'resolved_into_person_record_id'=v_target::text FROM public.person_records WHERE id=v_source));
 PERFORM pg_temp.check('source projection now resolves to target canonical identity',(SELECT canonical_person_id=v_target_canonical FROM public.canonical_person_links WHERE source_table='person_records' AND source_id=v_source));
 PERFORM pg_temp.check('source canonical is merged when no other projections remain',(SELECT status='merged' AND merged_into_id=v_target_canonical FROM public.canonical_people WHERE id=v_source_canonical));
 PERFORM pg_temp.check('resolution is audited',(SELECT count(*)=1 FROM public.audit_log WHERE action='identity_document_person_resolved' AND target_id=v_document));
END $$;
ROLLBACK;
