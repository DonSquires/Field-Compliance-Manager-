-- Behavioural truth table for CCTV media hash deduplication.
BEGIN;
SET LOCAL ROLE postgres;
SET LOCAL search_path TO public,extensions,pg_catalog;
CREATE OR REPLACE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM set_config('request.jwt.claims',json_build_object('sub',p_user::text,'role','authenticated')::text,true);PERFORM set_config('request.jwt.claim.sub',p_user::text,true);PERFORM set_config('request.jwt.claim.role','authenticated',true);SET LOCAL ROLE authenticated;END $$;
CREATE OR REPLACE FUNCTION pg_temp.as_admin() RETURNS void LANGUAGE plpgsql AS $$ BEGIN SET LOCAL ROLE postgres;END $$;
CREATE OR REPLACE FUNCTION pg_temp.check(p_label text,p_ok boolean) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF NOT coalesce(p_ok,false) THEN RAISE EXCEPTION 'FAIL [%]',p_label;END IF;RAISE NOTICE 'ok [%]',p_label;END $$;
DO $$
DECLARE v_org uuid:=gen_random_uuid();v_admin uuid:=gen_random_uuid();v_location uuid;v_place uuid;v_import_one uuid:=gen_random_uuid();v_import_two uuid:=gen_random_uuid();v_evidence uuid:=gen_random_uuid();v_hash text:=repeat('a',64);v_photo_hash text:=repeat('b',64);v_result jsonb;v_error text;
BEGIN
 INSERT INTO public.organizations(id,name,organization_type)VALUES(v_org,'T_CCTV_DEDUPE_ORG','service_provider');
 INSERT INTO public.user_profiles(id,organization_id,employer_organization_id,role,display_name)VALUES(v_admin,v_org,v_org,'admin','CCTV Dedupe Admin');
 INSERT INTO public.locations(organization_id,name,address)VALUES(v_org,'Dedupe Camera Place','1 Dedupe Way')RETURNING id,canonical_place_id INTO v_location,v_place;
 INSERT INTO public.cctv_imports(id,organization_id,location_id,canonical_place_id,camera_label,camera_key,source_device_kind,created_by)VALUES
    (v_import_one,v_org,v_location,v_place,'Dedupe Camera','dedupe-camera-one','generic_folder',v_admin),
    (v_import_two,v_org,v_location,v_place,'Dedupe Camera','dedupe-camera-two','generic_folder',v_admin);

 PERFORM pg_temp.as_user(v_admin);
 v_result:=public.prepare_cctv_media_upload(v_import_one,v_hash,'video','org/'||v_org||'/cctv/'||v_import_one||'/video.mp4');
 PERFORM pg_temp.check('first hash claimant may upload',v_result->>'action'='upload');
 v_result:=public.prepare_cctv_media_upload(v_import_two,v_hash,'video','org/'||v_org||'/cctv/'||v_import_two||'/renamed.mp4');
 PERFORM pg_temp.check('concurrent second hash claimant does not upload',v_result->>'action'='pending');

 PERFORM pg_temp.as_admin();
 INSERT INTO public.evidence_items(id,organization_id,module_key,evidence_kind,storage_path,captured_by_user_id,sha256_hash,cctv_import_id,metadata)
 VALUES(v_evidence,v_org,'cctv_review','video','org/'||v_org||'/cctv/'||v_import_one||'/video.mp4',v_admin,v_hash,v_import_one,jsonb_build_object('file_name','video.mp4'));
 PERFORM pg_temp.check('evidence registration completes the upload claim',(SELECT status='registered' AND evidence_item_id=v_evidence FROM public.cctv_media_upload_claims WHERE organization_id=v_org AND evidence_kind='video' AND sha256=v_hash));

 PERFORM pg_temp.as_user(v_admin);
 v_result:=public.find_existing_cctv_media_by_hash(v_import_two,v_hash,'video');
 PERFORM pg_temp.check('hash lookup finds the existing evidence',(v_result->>'found')::boolean AND (v_result->>'evidence_item_id')::uuid=v_evidence);
 v_result:=public.prepare_cctv_media_upload(v_import_two,v_hash,'video','org/'||v_org||'/cctv/'||v_import_two||'/renamed.mp4');
 PERFORM pg_temp.check('later upload reuses existing evidence',v_result->>'action'='reuse' AND (v_result->>'evidence_item_id')::uuid=v_evidence);
 PERFORM pg_temp.check('reuse is audited',EXISTS(SELECT 1 FROM public.audit_log WHERE organization_id=v_org AND action='cctv_media_duplicate_reused' AND target_id=v_evidence));

 PERFORM pg_temp.as_admin();
 BEGIN INSERT INTO public.evidence_items(organization_id,module_key,evidence_kind,storage_path,captured_by_user_id,sha256_hash,cctv_import_id,metadata)VALUES(v_org,'cctv_review','video','org/'||v_org||'/cctv/'||v_import_two||'/duplicate.mp4',v_admin,v_hash,v_import_two,'{}');v_error:=NULL;EXCEPTION WHEN OTHERS THEN v_error:=SQLERRM;END;
 PERFORM pg_temp.check('direct duplicate evidence insert is refused',v_error LIKE '%already registered%');

 PERFORM pg_temp.as_user(v_admin);
 v_result:=public.prepare_cctv_media_upload(v_import_one,v_photo_hash,'photo','org/'||v_org||'/cctv/'||v_import_one||'/photo.jpg');
 PERFORM pg_temp.check('photo and video hashes have independent claims',v_result->>'action'='upload');
 BEGIN PERFORM count(*) FROM public.cctv_media_upload_claims;v_error:=NULL;EXCEPTION WHEN OTHERS THEN v_error:=SQLERRM;END;
 PERFORM pg_temp.as_admin();
 PERFORM pg_temp.check('claim rows are not directly browser-readable',v_error LIKE '%permission denied%');
END $$;
ROLLBACK;
