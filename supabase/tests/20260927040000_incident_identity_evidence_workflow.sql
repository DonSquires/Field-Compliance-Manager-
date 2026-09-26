-- Officer incident ID capture and admin staff credential handoff truth table.
BEGIN;
SET LOCAL ROLE postgres;
SET LOCAL search_path TO public,extensions,storage,pg_catalog;
CREATE OR REPLACE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM set_config('request.jwt.claims',json_build_object('sub',p_user::text,'role','authenticated')::text,true);PERFORM set_config('request.jwt.claim.sub',p_user::text,true);PERFORM set_config('request.jwt.claim.role','authenticated',true);SET LOCAL ROLE authenticated;END $$;
CREATE OR REPLACE FUNCTION pg_temp.as_admin() RETURNS void LANGUAGE plpgsql AS $$ BEGIN SET LOCAL ROLE postgres;END $$;
CREATE OR REPLACE FUNCTION pg_temp.check(p_label text,p_ok boolean) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF NOT coalesce(p_ok,false) THEN RAISE EXCEPTION 'FAIL [%]',p_label;END IF;RAISE NOTICE 'ok [%]',p_label;END $$;
DO $$
DECLARE
 v_org uuid:=gen_random_uuid();v_other uuid:=gen_random_uuid();v_admin uuid:=gen_random_uuid();v_officer uuid:=gen_random_uuid();v_outsider uuid:=gen_random_uuid();v_staff uuid:=gen_random_uuid();v_location uuid;v_incident uuid;v_staff_person uuid;v_staff_canonical uuid;v_attachment uuid:=gen_random_uuid();v_document uuid;v_path text;v_result jsonb;v_error text;v_credential uuid;
BEGIN
 INSERT INTO public.organizations(id,name,organization_type)VALUES(v_org,'T_INCIDENT_EVIDENCE','service_provider'),(v_other,'T_INCIDENT_EVIDENCE_OTHER','service_provider');
 INSERT INTO public.user_profiles(id,organization_id,role,display_name)VALUES(v_admin,v_org,'admin','Evidence Admin'),(v_officer,v_org,'officer','Assigned Officer'),(v_outsider,v_other,'officer','Outside Officer'),(v_staff,v_org,'officer','Staff Identity');
 INSERT INTO public.staff_profiles(id,user_id,organization_id,employee_number)VALUES(v_staff,v_staff,v_org,'T-EVIDENCE');
 SELECT canonical_person_id,person_record_id INTO v_staff_canonical,v_staff_person FROM public.ensure_canonical_person_for_staff(v_staff);
 INSERT INTO public.locations(organization_id,name,address)VALUES(v_org,'Evidence Place','2 Test Way')RETURNING id INTO v_location;
 INSERT INTO public.incidents(organization_id,officer_user_id,location_id,incident_type,severity,description,status)VALUES(v_org,v_officer,v_location,'identity_evidence_test','standard','Identity evidence test','open')RETURNING id INTO v_incident;
 PERFORM set_config('request.jwt.claims',json_build_object('sub',v_officer::text,'role','authenticated')::text,true);
 PERFORM pg_temp.as_user(v_officer);
 v_result:=public.record_incident_person_identity(v_incident,'staff_involved','Staff presented security licence',v_staff_person,NULL,NULL,NULL);
 v_path:='org/'||v_org||'/identity/'||v_officer||'/incident-'||v_incident||'/'||v_attachment||'-coa.jpg';
 INSERT INTO storage.objects(bucket_id,name,owner,owner_id,metadata)VALUES('identity-evidence',v_path,v_officer,v_officer::text,jsonb_build_object('mimetype','image/jpeg','size',10));
 v_result:=public.register_incident_identity_attachment(v_incident,v_staff_person,'security_licence',v_attachment,'coa.jpg','image/jpeg',10,v_path);
 PERFORM pg_temp.check('assigned officer can register incident-scoped identity source',(v_result->>'attachment_id')::uuid=v_attachment);
 PERFORM pg_temp.as_admin();
 v_result:=public.register_deterministic_identity_document_proposal(v_officer,v_org,v_staff_person,v_attachment,'security_licence',repeat('4',64),jsonb_build_object('security_licence_number','T-COA','security_licence_expiry','2035-01-01','security_licence_authority','PSPLA'),NULL,NULL,0);
 v_document:=(v_result->>'identity_document_id')::uuid;
 PERFORM public.attach_incident_identity_proposal(v_officer,v_incident,v_staff_person,v_document);
 PERFORM pg_temp.check('proposal is linked to incident and evidence',(SELECT identity_document_id=v_document FROM public.incident_person_links WHERE incident_id=v_incident AND person_record_id=v_staff_person) AND EXISTS(SELECT 1 FROM public.incident_attachments WHERE incident_id=v_incident));
 PERFORM set_config('request.jwt.claims',json_build_object('sub',v_admin::text,'role','authenticated')::text,true);
 PERFORM pg_temp.as_user(v_admin);
 v_result:=public.review_canonical_identity_evidence(v_document,'approve',jsonb_build_object('display_name','Staff Identity','security_licence_number','T-COA','security_licence_expiry','2035-01-01','security_licence_authority','PSPLA'),'Compared incident source; send to People and HR verification');
 v_credential:=(v_result->>'staff_credential_handoff_id')::uuid;
 PERFORM pg_temp.check('admin approval creates an unverified staff credential handoff',v_credential IS NOT NULL AND (SELECT NOT verified AND staff_id=v_staff AND document_storage_path=v_path FROM public.staff_credentials WHERE id=v_credential));
 PERFORM pg_temp.check('approved incident identity points to the same staff canonical person',(SELECT canonical_person_id=v_staff_canonical AND source_kind='identity_document' FROM public.incident_person_links WHERE incident_id=v_incident AND person_record_id=v_staff_person));
 PERFORM pg_temp.as_user(v_outsider);
 BEGIN INSERT INTO storage.objects(bucket_id,name,owner,owner_id)VALUES('identity-evidence','org/'||v_org||'/identity/'||v_outsider||'/incident-'||v_incident||'/blocked.jpg',v_outsider,v_outsider::text);v_error:=NULL;EXCEPTION WHEN OTHERS THEN v_error:=SQLERRM;END;
 PERFORM pg_temp.as_admin();
 PERFORM pg_temp.check('unassigned officer cannot upload into another incident',v_error LIKE '%row-level security%' OR v_error LIKE '%policy%');
END $$;
ROLLBACK;
