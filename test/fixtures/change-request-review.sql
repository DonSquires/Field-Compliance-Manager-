DO $$
DECLARE
  org uuid := gen_random_uuid(); foreign_org uuid := gen_random_uuid();
  officer uuid := gen_random_uuid(); reviewer uuid := gen_random_uuid(); outsider uuid := gen_random_uuid();
  packet uuid := gen_random_uuid(); affected integer; denied boolean;
BEGIN
  INSERT INTO public.organizations(id,name,organization_type) VALUES
    (org,'ROLLBACK ONLY page requests','client'),(foreign_org,'ROLLBACK ONLY other requests','client');
  INSERT INTO public.user_profiles(id,organization_id,role,display_name) VALUES
    (officer,org,'officer','Synthetic requester'),(reviewer,org,'admin','Synthetic reviewer'),(outsider,foreign_org,'admin','Other reviewer');
  INSERT INTO public.bob_friction_packets(id,organization_id,user_id,client_packet_key,envelope,repair_risk,automation_status)
    VALUES(packet,org,officer,'change:'||packet,
      '{"schema_version":"1","during":{"user_report":{"kind":"change_request","desired_behavior":"Group unfilled shifts"}}}',
      'significant','awaiting_grandmaster');
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',officer,'role','authenticated')::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  denied := false;
  BEGIN
    INSERT INTO public.bob_friction_packets(organization_id,user_id,client_packet_key,envelope,repair_risk,automation_status,route)
      VALUES(org,officer,'forged','{}','routine','queued','dispatch_flow');
  EXCEPTION WHEN insufficient_privilege THEN denied := true; END;
  IF NOT denied THEN RAISE EXCEPTION 'FAIL: direct insertion permitted'; END IF;
  denied := false;
  BEGIN UPDATE public.bob_friction_packets SET repair_risk='routine' WHERE id=packet;
  EXCEPTION WHEN insufficient_privilege THEN denied := true; END;
  IF NOT denied THEN RAISE EXCEPTION 'FAIL: routing writable'; END IF;
  UPDATE public.bob_friction_packets SET disposition='resolved' WHERE id=packet;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected<>0 THEN RAISE EXCEPTION 'FAIL: requester reviewed own request'; END IF;
  IF (SELECT count(*) FROM public.bob_friction_packets WHERE id=packet)<>1 THEN RAISE EXCEPTION 'FAIL: requester cannot read receipt'; END IF;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',outsider,'role','authenticated')::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  IF (SELECT count(*) FROM public.bob_friction_packets WHERE id=packet)<>0 THEN RAISE EXCEPTION 'FAIL: cross-tenant read'; END IF;
  UPDATE public.bob_friction_packets SET disposition='resolved' WHERE id=packet;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected<>0 THEN RAISE EXCEPTION 'FAIL: cross-tenant review'; END IF;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',reviewer,'role','authenticated')::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  UPDATE public.bob_friction_packets SET disposition='reviewing', review_note='Checking the roster workflow' WHERE id=packet;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected<>1 THEN RAISE EXCEPTION 'FAIL: administrator cannot review'; END IF;
  EXECUTE 'RESET ROLE';
  IF NOT EXISTS (SELECT 1 FROM public.bob_friction_packets WHERE id=packet AND reviewed_by=reviewer AND reviewed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL: review actor/time not stamped'; END IF;
  denied := false;
  BEGIN UPDATE public.bob_friction_packets SET repair_risk='routine' WHERE id=packet;
  EXCEPTION WHEN check_violation THEN denied := true; END;
  IF NOT denied THEN RAISE EXCEPTION 'FAIL: user brief could be made routine'; END IF;
END;
$$;
