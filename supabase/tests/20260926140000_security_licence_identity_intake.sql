-- Behavioural checks for CoA intake and historical licence protection.
BEGIN;
SET LOCAL ROLE postgres;
SET LOCAL search_path TO public, extensions, pg_catalog;

CREATE OR REPLACE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  SET LOCAL ROLE authenticated;
END $$;
CREATE OR REPLACE FUNCTION pg_temp.as_admin() RETURNS void LANGUAGE plpgsql AS $$ BEGIN SET LOCAL ROLE postgres; END $$;
CREATE OR REPLACE FUNCTION pg_temp.check(p_label text, p_ok boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF NOT coalesce(p_ok, false) THEN RAISE EXCEPTION 'FAIL [%]', p_label; END IF; RAISE NOTICE 'ok [%]', p_label; END $$;

DO $$
DECLARE
  v_org uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid();
  v_person uuid;
  v_conversation uuid := gen_random_uuid();
  v_security_attachment uuid := gen_random_uuid();
  v_old_attachment uuid := gen_random_uuid();
  v_security_document uuid;
  v_old_document uuid;
  v_result jsonb;
  v_details jsonb;
  v_error text;
BEGIN
  INSERT INTO public.organizations(id,name,organization_type) VALUES(v_org,'T_SECURITY_IDENTITY','service_provider');
  INSERT INTO public.user_profiles(id,organization_id,role,display_name) VALUES(v_admin,v_org,'admin','Security Identity Admin');
  INSERT INTO public.bob_conversations(id,organization_id,user_id,module_key,title) VALUES(v_conversation,v_org,v_admin,'operations','Security identity test');
  PERFORM set_config('request.jwt.claims', json_build_object('sub',v_admin::text,'role','authenticated')::text, true);

  PERFORM pg_temp.as_user(v_admin);
  v_result := public.manage_identity_person_record(v_org,NULL,'create',jsonb_build_object(
    'display_name','Credential Test Person','firearms_licence_number','CURRENT-F','firearms_licence_expiry','2035-01-01',
    'security_licence_number','CURRENT-C','security_licence_expiry','2034-01-01',
    'security_licence_authority','Private Security Personnel Licensing Authority','security_endorsements','Personal guard'
  ),'Create credential comparison fixture');
  v_person := (v_result->>'person_record_id')::uuid;
  SELECT metadata->'profile_details' INTO v_details FROM public.person_records WHERE id=v_person;
  PERFORM pg_temp.check('manual CoA fields persist through the governed wrapper', v_details->>'security_licence_number'='CURRENT-C');
  BEGIN
    PERFORM public.manage_identity_person(v_org,v_person,'update',jsonb_build_object('display_name','Bypass'),'Bypass');
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.check('the superseded direct person RPC is not browser executable', v_error LIKE '%permission denied%');

  PERFORM pg_temp.as_admin();
  INSERT INTO public.bob_attachments(id,organization_id,conversation_id,uploaded_by,file_name,file_type,file_size_bytes,storage_bucket,storage_path,purpose,processing_state)
  VALUES
    (v_security_attachment,v_org,v_conversation,v_admin,'coa-front.jpg','image/jpeg',10,'identity-evidence','org/'||v_org||'/identity/'||v_admin||'/coa-front.jpg','identity_document','processing'),
    (v_old_attachment,v_org,v_conversation,v_admin,'old-firearms.jpg','image/jpeg',10,'identity-evidence','org/'||v_org||'/identity/'||v_admin||'/old-firearms.jpg','identity_document','processing');
  v_result := public.register_identity_document_proposal(v_admin,v_org,v_person,v_security_attachment,'security_licence',repeat('1',64),
    jsonb_build_object('security_licence_number','NEW-C','expiry_date','2036-01-01','security_endorsements','Personal guard, Crowd controller'),NULL,NULL,0);
  v_security_document := (v_result->>'identity_document_id')::uuid;
  v_result := public.register_identity_document_proposal(v_admin,v_org,v_person,v_old_attachment,'firearms_licence',repeat('2',64),
    jsonb_build_object('firearms_licence_number','OLD-F','expiry_date','2020-01-01'),NULL,NULL,0);
  v_old_document := (v_result->>'identity_document_id')::uuid;

  PERFORM pg_temp.as_user(v_admin);
  v_result := public.review_identity_evidence(v_security_document,'approve',jsonb_build_object(
    'display_name','Credential Test Person','security_licence_number','NEW-C','security_licence_expiry','2036-01-01',
    'security_licence_authority','Private Security Personnel Licensing Authority','security_endorsements','Personal guard, Crowd controller'
  ),'Compared CoA front and back source images');
  PERFORM pg_temp.check('current CoA becomes the current profile licence', (v_result->>'current_credential_updated')::boolean);
  SELECT metadata->'profile_details' INTO v_details FROM public.person_records WHERE id=v_person;
  PERFORM pg_temp.check('approved CoA fields persist on the identity profile', v_details->>'security_licence_number'='NEW-C' AND v_details->>'security_endorsements' LIKE '%Crowd controller%');

  v_result := public.review_identity_evidence(v_old_document,'approve',jsonb_build_object(
    'display_name','Credential Test Person','firearms_licence_number','OLD-F','firearms_licence_expiry','2020-01-01'
  ),'Retain expired firearms licence as historical evidence');
  PERFORM pg_temp.check('expired older licence is not promoted to current profile', NOT (v_result->>'current_credential_updated')::boolean);
  SELECT metadata->'profile_details' INTO v_details FROM public.person_records WHERE id=v_person;
  PERFORM pg_temp.check('historical approval leaves the current firearms licence untouched', v_details->>'firearms_licence_number'='CURRENT-F' AND v_details->>'firearms_licence_expiry'='2035-01-01');
  PERFORM pg_temp.check('historical licence remains approved evidence', (SELECT review_state='approved' AND extracted_fields->>'promoted_to_current_profile'='false' FROM public.person_identity_documents WHERE id=v_old_document));
  BEGIN
    PERFORM public.review_identity_document(v_security_document,'reject','{}'::jsonb,'Bypass');
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.check('the superseded direct review RPC is not browser executable', v_error LIKE '%permission denied%');
END $$;

ROLLBACK;
