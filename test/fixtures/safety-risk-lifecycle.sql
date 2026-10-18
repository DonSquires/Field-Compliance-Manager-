DO $$
DECLARE
  o uuid := gen_random_uuid(); other_org uuid := gen_random_uuid();
  officer uuid := gen_random_uuid(); reviewer uuid := gen_random_uuid(); outsider uuid := gen_random_uuid();
  loc uuid := gen_random_uuid(); zone uuid := gen_random_uuid(); shift uuid := gen_random_uuid();
  hazard uuid; request uuid := gen_random_uuid(); review_id uuid; report_id uuid := gen_random_uuid();
  v_incident_id uuid := gen_random_uuid(); item public.dynamic_risk_assessments%rowtype;
  workspace jsonb; blocked boolean; n integer; investigation uuid; foreign_investigation uuid;
BEGIN
  INSERT INTO public.organizations(id,name,organization_type) VALUES
    (o,'ROLLBACK ONLY lifecycle','client'),(other_org,'ROLLBACK ONLY unrelated lifecycle','client');
  INSERT INTO public.user_profiles(id,organization_id,role,display_name) VALUES
    (officer,o,'officer','Synthetic assessor'),(reviewer,o,'admin','Synthetic reviewer'),(outsider,other_org,'admin','Unrelated reviewer');
  INSERT INTO public.locations(id,organization_id,name) VALUES(loc,o,'Synthetic lifecycle place');
  INSERT INTO public.location_zones(id,organization_id,location_id,name,zone_type,module_key)
    VALUES(zone,o,loc,'Synthetic assessment zone','general','general_patrol');
  INSERT INTO public.shifts(id,organization_id,officer_user_id,service_type,zone_id,scheduled_start,scheduled_end,status)
    VALUES(shift,o,officer,'patrol',zone,now(),now()+interval '8 hours','in_progress');
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',officer,'role','authenticated')::text,true);
  item := public.submit_dynamic_risk_assessment(shift,'zone',zone,'Check rear gate','Loose material on walkway',
    ARRAY['Use the marked walkway'],2::smallint,3::smallint,'stop_work',true,request);
  IF item.decision <> 'stop_work' OR item.signed_at IS NULL THEN RAISE EXCEPTION 'FAIL: unsafe attestation'; END IF;
  IF (public.submit_dynamic_risk_assessment(shift,'zone',zone,'Check rear gate','Loose material on walkway',
    ARRAY['Use the marked walkway'],2::smallint,3::smallint,'stop_work',true,request)).id <> item.id THEN
    RAISE EXCEPTION 'FAIL: assessment retry'; END IF;
  blocked := false;
  BEGIN
    PERFORM public.submit_dynamic_risk_assessment(shift,'zone',zone,'Check rear gate','Loose material on walkway',
      ARRAY['Different control'],2::smallint,3::smallint,'stop_work',true,request);
  EXCEPTION WHEN SQLSTATE 'P0001' THEN blocked := true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'FAIL: changed request replay'; END IF;
  SELECT id INTO review_id FROM public.safety_reviews WHERE assessment_id=item.id;
  IF review_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.notifications WHERE recipient_user_id=reviewer AND link_payload->>'review_id'=review_id::text) THEN
    RAISE EXCEPTION 'FAIL: supervisor review notification'; END IF;
  blocked := false;
  BEGIN PERFORM public.get_safety_review_workspace(o,loc);
  EXCEPTION WHEN SQLSTATE 'P0001' THEN blocked := true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'FAIL: officer read private workspace'; END IF;
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',outsider,'role','authenticated')::text,true);
  blocked := false;
  BEGIN PERFORM public.get_shift_risk_assessments(shift);
  EXCEPTION WHEN SQLSTATE 'P0001' THEN blocked := true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'FAIL: tenant assessment leak'; END IF;
  foreign_investigation := (public.create_investigation(other_org,gen_random_uuid(),'ROLLBACK-FOREIGN','Unrelated synthetic case')).id;
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO n FROM public.dynamic_risk_assessments WHERE shift_id=shift;
  IF n<>0 THEN RAISE EXCEPTION 'FAIL: tenant assessment RLS'; END IF;
  SELECT count(*) INTO n FROM public.safety_reviews WHERE organization_id=o;
  IF n<>0 THEN RAISE EXCEPTION 'FAIL: tenant review RLS'; END IF;
  blocked := false;
  BEGIN UPDATE public.dynamic_risk_assessments SET decision='proceed_with_controls' WHERE id=item.id;
  EXCEPTION WHEN insufficient_privilege THEN blocked := true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'FAIL: signed evidence was mutable'; END IF;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',reviewer,'role','authenticated')::text,true);
  hazard := public.manage_place_hazard('create',NULL,jsonb_build_object('organization_id',o,'zone_id',zone,
    'title','Synthetic walkway hazard','hazard_class','slips_trips_falls','risk_level','medium',
    'controls',jsonb_build_array('Use the marked walkway'),'review_due',current_date-1),gen_random_uuid());
  PERFORM public.sweep_place_hazard_reviews(o);
  PERFORM public.sweep_place_hazard_reviews(o);
  SELECT count(*) INTO n FROM public.notifications WHERE organization_id=o AND dedup_key LIKE 'hazard_due:%';
  IF n<>1 THEN RAISE EXCEPTION 'FAIL: reminder deduplication %',n; END IF;
  blocked := false;
  BEGIN PERFORM public.review_place_hazard(hazard,1,outsider,'{}',current_date+30,'Controls checked on site.');
  EXCEPTION WHEN SQLSTATE 'P0001' THEN blocked := true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'FAIL: foreign risk owner'; END IF;
  blocked := false;
  BEGIN PERFORM public.review_place_hazard(hazard,1,reviewer,jsonb_build_object('Use the marked walkway',NULL),current_date+30,'Controls checked on site.');
  EXCEPTION WHEN SQLSTATE 'P0001' THEN blocked := true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'FAIL: null hierarchy classification'; END IF;
  PERFORM public.review_place_hazard(hazard,1,reviewer,jsonb_build_object('Use the marked walkway','administrative'),current_date+30,'Controls checked on site.');
  IF (SELECT risk_owner_id FROM public.place_hazards WHERE id=hazard)<>reviewer THEN RAISE EXCEPTION 'FAIL: owner not persisted'; END IF;
  blocked := false;
  BEGIN PERFORM public.review_place_hazard(hazard,1,reviewer,'{}',current_date+30,'Stale review of controls.');
  EXCEPTION WHEN SQLSTATE 'P0001' THEN blocked := true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'FAIL: stale hazard review'; END IF;
  PERFORM public.complete_safety_review(review_id,'Area isolated and supervisor informed; reassess before resuming.',hazard);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',officer,'role','authenticated')::text,true);
  workspace := public.get_shift_risk_assessments(shift);
  IF workspace->0->>'review_status'<>'closed' OR workspace->0->>'decision'<>'stop_work' THEN
    RAISE EXCEPTION 'FAIL: review rewrote unsafe evidence or lost officer receipt'; END IF;
  INSERT INTO public.officer_field_reports(id,organization_id,officer_id,shift_id,zone_id,report_type,title,description)
    VALUES(report_id,o,officer,shift,zone,'health_safety','Synthetic H&S report','Synthetic report details for rollback only');
  IF NOT EXISTS (SELECT 1 FROM public.safety_reviews WHERE field_report_id=report_id AND location_id=loc) THEN
    RAISE EXCEPTION 'FAIL: H&S report did not open place review'; END IF;
  INSERT INTO public.officer_field_reports(organization_id,officer_id,shift_id,zone_id,report_type,title,description)
    VALUES(o,officer,shift,zone,'maintenance','Ordinary synthetic report','Not an H&S report');
  IF (SELECT count(*) FROM public.safety_reviews WHERE organization_id=o)<>2 THEN
    RAISE EXCEPTION 'FAIL: ordinary report opened safety review'; END IF;
  INSERT INTO public.incidents(id,organization_id,location_id,incident_type) VALUES(v_incident_id,o,loc,'other');
  IF EXISTS (SELECT 1 FROM public.safety_reviews WHERE incident_id=v_incident_id) THEN
    RAISE EXCEPTION 'FAIL: ordinary incident automatically opened review'; END IF;
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',reviewer,'role','authenticated')::text,true);
  investigation := (public.create_investigation(o,gen_random_uuid(),'ROLLBACK-SAFETY','Synthetic H&S corrective action')).id;
  SELECT id INTO review_id FROM public.safety_reviews WHERE field_report_id=report_id;
  blocked := false;
  BEGIN PERFORM public.complete_safety_review(review_id,'Synthetic review must not cross organisations.',hazard,foreign_investigation);
  EXCEPTION WHEN SQLSTATE 'P0001' THEN blocked := true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'FAIL: foreign investigation linked'; END IF;
  PERFORM public.complete_safety_review(review_id,'Path isolated and maintenance arranged after reading source evidence.',hazard,investigation);
  IF (SELECT investigation_id FROM public.officer_field_reports WHERE id=report_id) IS DISTINCT FROM investigation
    OR NOT EXISTS (SELECT 1 FROM public.investigation_links WHERE investigation_id=investigation AND entity_id=report_id AND entity_type='field_report') THEN
    RAISE EXCEPTION 'FAIL: canonical field-report investigation link'; END IF;
  review_id := public.open_incident_safety_review(v_incident_id);
  IF public.open_incident_safety_review(v_incident_id)<>review_id THEN RAISE EXCEPTION 'FAIL: incident retry'; END IF;
  PERFORM public.complete_safety_review(review_id,'Other incident reviewed for its safety implications.',hazard,investigation);
  IF (SELECT investigation_id FROM public.incidents WHERE id=v_incident_id) IS DISTINCT FROM investigation THEN
    RAISE EXCEPTION 'FAIL: canonical incident investigation link'; END IF;
  workspace := public.get_safety_review_workspace(o,loc);
  IF jsonb_array_length(workspace->'reviews')<>3 THEN RAISE EXCEPTION 'FAIL: review workspace'; END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(workspace->'reviews') r WHERE r->>'source_description'='Synthetic report details for rollback only') THEN
    RAISE EXCEPTION 'FAIL: source evidence lost'; END IF;
END;
$$;
