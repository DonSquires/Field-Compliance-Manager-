-- Behavioural truth table for canonical staff/person identity and incident involvement.
BEGIN;
SET LOCAL ROLE postgres;
SET LOCAL search_path TO public,extensions,pg_catalog;
CREATE OR REPLACE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM set_config('request.jwt.claims',json_build_object('sub',p_user::text,'role','authenticated')::text,true);PERFORM set_config('request.jwt.claim.sub',p_user::text,true);PERFORM set_config('request.jwt.claim.role','authenticated',true);SET LOCAL ROLE authenticated;END $$;
CREATE OR REPLACE FUNCTION pg_temp.as_admin() RETURNS void LANGUAGE plpgsql AS $$ BEGIN SET LOCAL ROLE postgres;END $$;
CREATE OR REPLACE FUNCTION pg_temp.check(p_label text,p_ok boolean) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF NOT coalesce(p_ok,false) THEN RAISE EXCEPTION 'FAIL [%]',p_label;END IF;RAISE NOTICE 'ok [%]',p_label;END $$;
DO $$
DECLARE
 v_org uuid:=gen_random_uuid();v_other_org uuid:=gen_random_uuid();v_admin uuid:=gen_random_uuid();v_officer uuid:=gen_random_uuid();v_other_officer uuid:=gen_random_uuid();v_staff_user uuid:=gen_random_uuid();v_staff uuid:=v_staff_user;v_location uuid;v_incident uuid;v_staff_person uuid;v_staff_canonical uuid;v_witness_person uuid;v_witness_canonical uuid;v_result jsonb;v_error text;
BEGIN
 INSERT INTO public.organizations(id,name,organization_type)VALUES(v_org,'T_INCIDENT_ID_ORG','service_provider'),(v_other_org,'T_INCIDENT_ID_OTHER','service_provider');
 INSERT INTO public.user_profiles(id,organization_id,role,display_name)VALUES(v_admin,v_org,'admin','Identity Admin'),(v_officer,v_org,'officer','Assigned Officer'),(v_other_officer,v_other_org,'officer','Other Officer'),(v_staff_user,v_org,'officer','Staff Subject');
 INSERT INTO public.staff_profiles(id,user_id,organization_id,employee_number)VALUES(v_staff,v_staff_user,v_org,'T-STAFF');
 INSERT INTO public.locations(organization_id,name,address)VALUES(v_org,'T Incident Place','1 Test Way')RETURNING id INTO v_location;
 INSERT INTO public.incidents(organization_id,officer_user_id,location_id,incident_type,severity,description,status)VALUES(v_org,v_officer,v_location,'identity_test','standard','Identity convergence test','open')RETURNING id INTO v_incident;

 SELECT canonical_person_id,person_record_id INTO v_staff_canonical,v_staff_person FROM public.ensure_canonical_person_for_staff(v_staff);
 PERFORM pg_temp.check('staff receives a canonical person and tenant person projection',v_staff_canonical IS NOT NULL AND v_staff_person IS NOT NULL);
 PERFORM pg_temp.check('staff and person projection share one canonical identity',(SELECT count(*)=2 FROM public.canonical_person_links WHERE canonical_person_id=v_staff_canonical AND source_table IN ('staff_profiles','person_records')));

 PERFORM pg_temp.as_user(v_officer);
 v_result:=public.record_incident_person_identity(v_incident,'witness','Identity stated to assigned officer',NULL,NULL,'Witness Person',NULL);
 v_witness_person:=(v_result->>'person_record_id')::uuid;v_witness_canonical:=(v_result->>'canonical_person_id')::uuid;
 PERFORM pg_temp.check('assigned officer can record a new manual-review identity',v_witness_person IS NOT NULL AND (v_result->>'review_state')='manual_review_required');
 v_result:=public.record_incident_person_identity(v_incident,'staff_involved','Linked from staff roster identity',NULL,v_staff,NULL,NULL);
 PERFORM pg_temp.check('staff incident involvement uses the same canonical person',(v_result->>'canonical_person_id')::uuid=v_staff_canonical);
 PERFORM pg_temp.check('incident contains both canonical people',(SELECT count(*)=2 FROM public.get_incident_people(v_incident)));

 PERFORM pg_temp.as_user(v_other_officer);
 BEGIN PERFORM public.record_incident_person_identity(v_incident,'subject','Cross-tenant attempt',NULL,NULL,'Other Person',NULL);v_error:=NULL;EXCEPTION WHEN OTHERS THEN v_error:=SQLERRM;END;
 PERFORM pg_temp.as_admin();
 PERFORM pg_temp.check('unassigned cross-tenant officer is denied',v_error LIKE '%assigned officer or an administrator%');
 PERFORM pg_temp.check('the witness projection is eligible for CCTV canonical linking',(SELECT canonical_person_id=v_witness_canonical FROM public.canonical_person_links WHERE source_table='person_records' AND source_id=v_witness_person));
 PERFORM pg_temp.check('every incident person write is audited',(SELECT count(*)=2 FROM public.audit_log WHERE action='incident_person_identity_recorded' AND metadata->>'incident_id'=v_incident::text));
END $$;
ROLLBACK;
