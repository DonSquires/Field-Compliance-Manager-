-- Behavioural truth table for tenant File Explorer folders.
BEGIN;
SET LOCAL ROLE postgres;
SET LOCAL search_path TO public,extensions,pg_catalog;

CREATE OR REPLACE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',json_build_object('sub',p_user::text,'role','authenticated')::text,true);
  PERFORM set_config('request.jwt.claim.sub',p_user::text,true);
  PERFORM set_config('request.jwt.claim.role','authenticated',true);
  SET LOCAL ROLE authenticated;
END $$;
CREATE OR REPLACE FUNCTION pg_temp.as_admin() RETURNS void LANGUAGE plpgsql AS $$ BEGIN SET LOCAL ROLE postgres;END $$;
CREATE OR REPLACE FUNCTION pg_temp.check(p_label text,p_ok boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF NOT coalesce(p_ok,false) THEN RAISE EXCEPTION 'FAIL [%]',p_label;END IF;RAISE NOTICE 'ok [%]',p_label;END $$;

DO $$
DECLARE
  v_org uuid:=gen_random_uuid();v_other_org uuid:=gen_random_uuid();v_admin uuid:=gen_random_uuid();v_officer uuid:=gen_random_uuid();v_staff_user uuid:=gen_random_uuid();
  v_location_one uuid;v_location_two uuid;v_person uuid;v_staff_person uuid;v_document uuid;v_generated_document uuid;v_sensitive_document uuid;v_org_space uuid;v_people_space uuid;v_parent uuid;v_custom uuid;v_custom_again uuid;v_other_folder uuid;v_placement uuid;v_tree jsonb;v_error text;
  v_request uuid:=gen_random_uuid();v_move_request uuid:=gen_random_uuid();
BEGIN
  INSERT INTO public.organizations(id,name,organization_type) VALUES(v_org,'T_FILE_EXPLORER_ORG','service_provider'),(v_other_org,'T_FILE_EXPLORER_OTHER','service_provider');
  INSERT INTO public.user_profiles(id,organization_id,employer_organization_id,role,display_name,email) VALUES
    (v_admin,v_org,v_org,'admin','Folder Admin','folder-admin@example.test'),
    (v_officer,v_org,v_org,'officer','Folder Officer','folder-officer@example.test'),
    (v_staff_user,v_org,v_org,'officer','Folder Staff','folder-staff@example.test');

  PERFORM pg_temp.check('new organisation receives nine standard spaces',(SELECT count(*)=9 FROM public.file_spaces WHERE organization_id=v_org AND active));
  PERFORM pg_temp.check('organisation receives company records and health and safety folders',(SELECT count(*)=2 FROM public.file_folders folder JOIN public.file_spaces space ON space.id=folder.space_id WHERE folder.organization_id=v_org AND space.space_key='organisation' AND folder.folder_key IN('company_records','health_safety') AND folder.active));

  INSERT INTO public.locations(organization_id,name,address) VALUES(v_org,'Operations Centre','1 Test Street') RETURNING id INTO v_location_one;
  INSERT INTO public.locations(organization_id,name,address) VALUES(v_org,'Operations Centre','2 Test Street') RETURNING id INTO v_location_two;
  PERFORM pg_temp.check('locations receive distinct linked folders',(SELECT count(*)=2 AND count(DISTINCT name)=2 FROM public.file_folders WHERE organization_id=v_org AND entity_type='location' AND entity_id IN(v_location_one,v_location_two) AND active));

  INSERT INTO public.person_records(organization_id,display_name,review_state,metadata) VALUES(v_org,'Non-staff Person','verified','{}') RETURNING id INTO v_person;
  PERFORM pg_temp.check('non-staff person receives one linked folder',(SELECT count(*)=1 FROM public.file_folders WHERE organization_id=v_org AND entity_type='person_record' AND entity_id=v_person AND active));

  INSERT INTO public.staff_profiles(id,user_id,organization_id,employee_number) VALUES(v_staff_user,v_staff_user,v_org,'FOLDER-STAFF');
  SELECT person_record_id INTO v_staff_person FROM public.ensure_canonical_person_for_staff(v_staff_user);
  PERFORM pg_temp.check('staff user and person projection share one folder',(SELECT count(*)=1 FROM public.file_folders WHERE organization_id=v_org AND active AND ((entity_type='user_profile' AND entity_id=v_staff_user) OR (entity_type='person_record' AND entity_id=v_staff_person))));

  INSERT INTO public.documents(organization_id,original_filename,mime_type,current_scope,source_channel,uploaded_by) VALUES(v_org,'folder-test.pdf','application/pdf','tenant_reference','chat_upload',v_admin) RETURNING id INTO v_document;
  PERFORM pg_temp.check('new document starts in Unfiled',(SELECT folder.folder_key='unfiled' FROM public.document_placements placement JOIN public.file_folders folder ON folder.id=placement.folder_id WHERE placement.document_id=v_document AND placement.is_primary AND placement.removed_at IS NULL));
  INSERT INTO public.documents(organization_id,original_filename,mime_type,current_scope,source_channel,uploaded_by) VALUES(v_org,'generated-report.pdf','application/pdf','tenant','system_generated',v_admin) RETURNING id INTO v_generated_document;
  PERFORM pg_temp.check('generated document starts in Generated outputs',(SELECT space.space_key='generated' AND placement.folder_id IS NULL FROM public.document_placements placement JOIN public.file_spaces space ON space.id=placement.space_id WHERE placement.document_id=v_generated_document AND placement.is_primary AND placement.removed_at IS NULL));

  PERFORM pg_temp.as_user(v_officer);
  v_tree:=public.get_file_explorer_tree(v_org);
  PERFORM pg_temp.check('ordinary org user can browse internal spaces',jsonb_array_length(v_tree->'spaces')>0);
  PERFORM pg_temp.check('ordinary org user cannot list restricted people or finance spaces',NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_tree->'spaces') item WHERE item->>'space_key' IN('people','finance')));

  PERFORM pg_temp.as_admin();PERFORM pg_temp.as_user(v_admin);
  v_tree:=public.get_file_explorer_tree(v_org);
  PERFORM pg_temp.check('administrator sees restricted people and finance spaces',(SELECT count(*)=2 FROM jsonb_array_elements(v_tree->'spaces') item WHERE item->>'space_key' IN('people','finance')));
  SELECT id INTO v_org_space FROM public.file_spaces WHERE organization_id=v_org AND space_key='organisation';
  SELECT id INTO v_parent FROM public.file_folders WHERE space_id=v_org_space AND folder_key='company_records';
  SELECT id INTO v_custom FROM public.create_file_folder(v_org,v_org_space,v_parent,'Board records',v_request);
  SELECT id INTO v_custom_again FROM public.create_file_folder(v_org,v_org_space,v_parent,'Board records',v_request);
  PERFORM pg_temp.check('custom folder creation is idempotent',v_custom=v_custom_again);
  SELECT id INTO v_placement FROM public.move_document_to_folder(v_org,v_document,v_org_space,v_custom,v_move_request);
  PERFORM pg_temp.check('move creates one active primary placement',(SELECT count(*)=1 FROM public.document_placements WHERE document_id=v_document AND is_primary AND removed_at IS NULL AND id=v_placement AND folder_id=v_custom));
  PERFORM pg_temp.check('move retains historical placement',(SELECT count(*)=1 FROM public.document_placements WHERE document_id=v_document AND NOT is_primary AND removed_at IS NOT NULL));
  PERFORM pg_temp.check('folder create and move are audited',(SELECT count(*)=2 FROM public.audit_log WHERE organization_id=v_org AND action IN('file_folder_created','document_moved_to_folder') AND actor_user_id=v_admin));

  SELECT id INTO v_people_space FROM public.file_spaces WHERE organization_id=v_org AND space_key='people';
  PERFORM pg_temp.as_admin();
  INSERT INTO public.documents(organization_id,original_filename,mime_type,current_scope,source_channel,uploaded_by) VALUES(v_org,'private-person-record.pdf','application/pdf','tenant','chat_upload',v_admin) RETURNING id INTO v_sensitive_document;
  PERFORM pg_temp.as_user(v_admin);
  PERFORM public.move_document_to_folder(v_org,v_sensitive_document,v_people_space,NULL,gen_random_uuid());
  PERFORM pg_temp.as_admin();PERFORM pg_temp.as_user(v_officer);
  PERFORM pg_temp.check('restricted folder document is filtered before browser transport',NOT EXISTS(SELECT 1 FROM public.documents WHERE id=v_sensitive_document));
  PERFORM pg_temp.as_admin();PERFORM pg_temp.as_user(v_admin);
  PERFORM pg_temp.check('direct corporate administrator can read restricted folder document',EXISTS(SELECT 1 FROM public.documents WHERE id=v_sensitive_document));

  PERFORM pg_temp.as_admin();
  SELECT folder.id INTO v_other_folder FROM public.file_folders folder JOIN public.file_spaces space ON space.id=folder.space_id WHERE folder.organization_id=v_other_org AND space.space_key='organisation' AND folder.folder_key='unfiled';
  PERFORM pg_temp.as_user(v_admin);
  BEGIN PERFORM public.move_document_to_folder(v_org,v_document,(SELECT space_id FROM public.file_folders WHERE id=v_other_folder),v_other_folder,gen_random_uuid());v_error:=NULL;EXCEPTION WHEN OTHERS THEN v_error:=SQLERRM;END;
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('cross-tenant destination is denied',v_error LIKE '%Destination section not found%');
END $$;
ROLLBACK;
