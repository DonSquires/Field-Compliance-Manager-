-- Enriched deterministic existing-person recommendations.
BEGIN;
SET LOCAL ROLE postgres;
SET LOCAL search_path TO public,extensions,pg_catalog;
CREATE OR REPLACE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM set_config('request.jwt.claims',json_build_object('sub',p_user::text,'role','authenticated')::text,true);PERFORM set_config('request.jwt.claim.sub',p_user::text,true);PERFORM set_config('request.jwt.claim.role','authenticated',true);SET LOCAL ROLE authenticated;END $$;
CREATE OR REPLACE FUNCTION pg_temp.check(p_label text,p_ok boolean) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF NOT coalesce(p_ok,false) THEN RAISE EXCEPTION 'FAIL [%]',p_label;END IF;RAISE NOTICE 'ok [%]',p_label;END $$;
DO $$
DECLARE v_org uuid:=gen_random_uuid();v_admin uuid:=gen_random_uuid();v_source uuid:=gen_random_uuid();v_target uuid:=gen_random_uuid();v_target_canonical uuid;v_location uuid;v_incident uuid;v_source_document uuid:=gen_random_uuid();
BEGIN
 INSERT INTO public.organizations(id,name,organization_type)VALUES(v_org,'T_ENRICHED_RECOMMENDATION','service_provider');
 INSERT INTO public.user_profiles(id,organization_id,role,display_name)VALUES(v_admin,v_org,'admin','Recommendation Admin');
 INSERT INTO public.person_records(id,organization_id,display_name,review_state,metadata)VALUES
  (v_source,v_org,'Scanned Person','manual_review_required','{}'),
  (v_target,v_org,'Known Person','verified',jsonb_build_object('profile_details',jsonb_build_object('date_of_birth','1990-05-04','driver_licence_number','MATCH-123','staff_profile_id',v_admin)));
 v_target_canonical:=public.ensure_canonical_person_for_record(v_target);
 INSERT INTO public.person_identity_documents(organization_id,person_record_id,document_kind,extracted_fields,review_state,created_by)
 VALUES(v_org,v_target,'driver_licence','{"approved":{"driver_licence_number":"MATCH-123"}}','approved',v_admin);
 INSERT INTO public.locations(organization_id,name,address)VALUES(v_org,'Recommendation Place','5 Test Way')RETURNING id INTO v_location;
 INSERT INTO public.incidents(organization_id,officer_user_id,location_id,incident_type,severity,description,status)VALUES(v_org,v_admin,v_location,'recommendation_context','standard','Recommendation test','open')RETURNING id INTO v_incident;
 INSERT INTO public.incident_person_links(organization_id,incident_id,canonical_person_id,person_record_id,involvement_role,source_kind,notes,recorded_by)
 VALUES(v_org,v_incident,v_target_canonical,v_target,'subject','manual_link','Known incident context',v_admin);
 INSERT INTO public.person_identity_documents(id,organization_id,person_record_id,document_kind,extracted_fields,review_state,created_by)
 VALUES(v_source_document,v_org,v_source,'driver_licence',jsonb_build_object('proposed',jsonb_build_object('display_name','Known Person','date_of_birth','1990-05-04','driver_licence_number','MATCH-123')),'manual_review_required',v_admin);
 PERFORM pg_temp.as_user(v_admin);
 PERFORM pg_temp.check('exact credential recommendation is strong and enriched',(SELECT count(*)=1 AND bool_and(person_record_id=v_target AND score=1.0 AND basis='credential_number_exact' AND approved_identity_document_count=1 AND incident_count=1 AND confidence_label='strong') FROM public.get_identity_resolution_candidates(v_source_document)));
END $$;
ROLLBACK;
