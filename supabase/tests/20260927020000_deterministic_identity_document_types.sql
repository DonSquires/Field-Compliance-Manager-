-- Behavioural truth table for deterministic identity and warrant definitions.
BEGIN;
SET LOCAL ROLE postgres;
SET LOCAL search_path TO public, extensions, pg_catalog;
CREATE OR REPLACE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM set_config('request.jwt.claims',json_build_object('sub',p_user::text,'role','authenticated')::text,true);PERFORM set_config('request.jwt.claim.sub',p_user::text,true);PERFORM set_config('request.jwt.claim.role','authenticated',true);SET LOCAL ROLE authenticated;END $$;
CREATE OR REPLACE FUNCTION pg_temp.as_admin() RETURNS void LANGUAGE plpgsql AS $$ BEGIN SET LOCAL ROLE postgres;END $$;
CREATE OR REPLACE FUNCTION pg_temp.check(p_label text,p_ok boolean) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF NOT coalesce(p_ok,false) THEN RAISE EXCEPTION 'FAIL [%]',p_label;END IF;RAISE NOTICE 'ok [%]',p_label;END $$;
DO $$
DECLARE
  v_org uuid:=gen_random_uuid();v_admin uuid:=gen_random_uuid();v_person uuid:=gen_random_uuid();v_conversation uuid:=gen_random_uuid();v_attachment uuid:=gen_random_uuid();v_document uuid;v_result jsonb;v_error text;
BEGIN
  PERFORM pg_temp.check('all initial deterministic document definitions exist',(SELECT count(*)=12 FROM public.identity_document_type_definitions WHERE active));
  PERFORM pg_temp.check('parking maps to generic authority with explicit activity',(SELECT staff_credential_type='warrant_of_authority' AND default_authorized_activities=ARRAY['Parking warden'] FROM public.identity_document_type_definitions WHERE document_kind='parking_warrant'));
  PERFORM pg_temp.check('freedom camping maps to generic authority with explicit activity',(SELECT staff_credential_type='warrant_of_authority' AND default_authorized_activities=ARRAY['Freedom camping officer'] FROM public.identity_document_type_definitions WHERE document_kind='freedom_camping_warrant'));
  INSERT INTO public.organizations(id,name,organization_type)VALUES(v_org,'T_DETERMINISTIC_IDS','service_provider');
  INSERT INTO public.user_profiles(id,organization_id,role,display_name)VALUES(v_admin,v_org,'admin','Deterministic ID Admin');
  INSERT INTO public.person_records(id,organization_id,display_name,review_state,metadata)VALUES(v_person,v_org,'Warrant Test Person','manual_review_required','{}');
  INSERT INTO public.bob_conversations(id,organization_id,user_id,module_key,title)VALUES(v_conversation,v_org,v_admin,'operations','Warrant test');
  INSERT INTO public.bob_attachments(id,organization_id,conversation_id,uploaded_by,file_name,file_type,file_size_bytes,storage_bucket,storage_path,purpose,processing_state)
  VALUES(v_attachment,v_org,v_conversation,v_admin,'noise-warrant.jpg','image/jpeg',10,'identity-evidence','org/'||v_org||'/identity/'||v_admin||'/noise-warrant.jpg','identity_document','processing');
  PERFORM set_config('request.jwt.claims',json_build_object('sub',v_admin::text,'role','authenticated')::text,true);
  v_result:=public.register_deterministic_identity_document_proposal(v_admin,v_org,v_person,v_attachment,'noise_control_warrant',repeat('3',64),jsonb_build_object('document_number','NCO-1234','issuing_authority','Example Council','expiry_date','2031-09-01','authorized_activities','Noise control officer'),NULL,NULL,0);
  v_document:=(v_result->>'identity_document_id')::uuid;
  PERFORM pg_temp.check('deterministic registration preserves the specific warrant kind',(SELECT document_kind='noise_control_warrant' FROM public.person_identity_documents WHERE id=v_document));
  PERFORM pg_temp.as_user(v_admin);
  v_result:=public.review_deterministic_identity_evidence(v_document,'approve',jsonb_build_object('display_name','Warrant Test Person','document_number','NCO-1234','issuing_authority','Example Council','issued_date','2026-09-01','expiry_date','2031-09-01','authorized_activities','Noise control officer'),'Compared warrant source with proposed fields');
  PERFORM pg_temp.check('approved warrant retains deterministic fields',(SELECT extracted_fields->'approved'->>'document_number'='NCO-1234' AND extracted_fields->'approved'->>'issuing_authority'='Example Council' AND extracted_fields->'approved'->>'authorized_activities'='Noise control officer' FROM public.person_identity_documents WHERE id=v_document));
  PERFORM pg_temp.check('identity intake does not silently create staff readiness',(SELECT count(*)=0 FROM public.staff_credentials WHERE organization_id=v_org));
  BEGIN PERFORM public.review_identity_evidence(v_document,'reject','{}','Bypass');v_error:=NULL;EXCEPTION WHEN OTHERS THEN v_error:=SQLERRM;END;
  PERFORM pg_temp.check('superseded review wrapper is not browser executable',v_error LIKE '%permission denied%');
END $$;
ROLLBACK;
