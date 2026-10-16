-- Synthetic identities and places only. The runner always rolls this transaction back.
DO $$
DECLARE
  v_org uuid := gen_random_uuid();
  v_other_org uuid := gen_random_uuid();
  v_other_location uuid := gen_random_uuid();
  v_officer uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid();
  v_location uuid := gen_random_uuid();
  v_zone uuid := gen_random_uuid();
  v_shift uuid := gen_random_uuid();
  v_stop uuid := gen_random_uuid();
  v_action uuid := gen_random_uuid();
  v_route uuid := gen_random_uuid();
  v_unit uuid := gen_random_uuid();
  v_warning uuid := gen_random_uuid();
  v_ad_hoc public.shifts%rowtype;
  v_hazard uuid;
  v_report uuid;
  v_request uuid := gen_random_uuid();
  v_briefing jsonb;
  v_receipt jsonb;
  v_count integer;
  v_blocked boolean;
BEGIN
  INSERT INTO public.organizations(id, name, organization_type)
    VALUES (v_org, 'ROLLBACK ONLY safety workflow fixture', 'client');
  INSERT INTO public.organizations(id, name, organization_type)
    VALUES (v_other_org, 'ROLLBACK ONLY unrelated tenant', 'client');
  INSERT INTO public.locations(id, organization_id, name)
    VALUES (v_other_location, v_other_org, 'ROLLBACK ONLY unrelated place');
  INSERT INTO public.user_profiles(id, organization_id, role, display_name)
    VALUES (v_officer, v_org, 'officer', 'Synthetic safety officer'),
           (v_admin, v_org, 'admin', 'Synthetic safety reviewer');
  INSERT INTO public.locations(id, organization_id, name)
    VALUES (v_location, v_org, 'ROLLBACK ONLY safety test place');
  INSERT INTO public.location_zones(id, organization_id, location_id, name, zone_type, module_key)
    VALUES (v_zone, v_org, v_location, 'Synthetic patrol zone', 'general', 'general_patrol');
  INSERT INTO public.shifts(id, organization_id, officer_user_id, service_type, zone_id, scheduled_start, scheduled_end, status)
    VALUES (v_shift, v_org, v_officer, 'patrol', v_zone, now(), now() + interval '8 hours', 'scheduled');
  INSERT INTO public.shift_stops(id, organization_id, shift_id, zone_id, module_key, sla_arrive_by)
    VALUES (v_stop, v_org, v_shift, v_zone, 'general_patrol', now() + interval '1 hour');
  INSERT INTO public.bob_agentic_actions(id, organization_id, user_id, action_type, status, approved_by, approved_at, proposed_payload)
    VALUES (v_action, v_org, v_admin, 'create_place_hazard', 'approved', v_admin, now(),
      jsonb_build_object('organization_id', v_org, 'location_id', v_location, 'zone_id', v_zone,
        'title', 'Synthetic wet floor', 'hazard_class', 'slips_trips_falls', 'risk_level', 'high',
        'controls', jsonb_build_array('Use the marked dry walkway'), 'source_name', 'Synthetic safety plan',
        'source_as_of', '2026-10-16', 'source_locator', 'Section 1'));
  v_hazard := public.apply_bob_place_hazard_proposal(v_action);
  IF v_hazard IS NULL OR public.apply_bob_place_hazard_proposal(v_action) <> v_hazard THEN
    RAISE EXCEPTION 'FAIL: approved Bob proposal did not apply idempotently';
  END IF;

  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_officer, 'role', 'authenticated')::text, true);
  INSERT INTO public.patrol_routes(id, organization_id, name)
    VALUES (v_route, v_org, 'ROLLBACK ONLY unscheduled patrol');
  INSERT INTO public.roster_work_units(id, organization_id, name, work_unit_type, service_type, patrol_route_id)
    VALUES (v_unit, v_org, 'ROLLBACK ONLY work unit', 'patrol', 'patrol', v_route);
  v_ad_hoc := public.start_ad_hoc_officer_shift(v_unit, 'patrol', v_location, v_zone);
  IF v_ad_hoc.status <> 'scheduled' OR v_ad_hoc.actual_start IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: unscheduled work started before the safety check';
  END IF;
  IF (public.start_ad_hoc_officer_shift(v_unit, 'patrol', v_location, v_zone)).id <> v_ad_hoc.id THEN
    RAISE EXCEPTION 'FAIL: unscheduled preparation retry created another shift';
  END IF;
  v_receipt := public.get_shift_safety_briefing(v_ad_hoc.id);
  IF (v_receipt->>'item_count')::integer <> 1 THEN
    RAISE EXCEPTION 'FAIL: unscheduled work lost its place risks';
  END IF;
  v_blocked := false;
  BEGIN
    INSERT INTO public.shifts(organization_id, officer_user_id, service_type, zone_id, scheduled_start, scheduled_end, status)
    VALUES (v_org, v_officer, 'patrol', v_zone, now(), now() + interval '8 hours', 'in_progress');
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE '%acknowledge%' THEN RAISE; END IF;
    v_blocked := true;
  END;
  IF NOT v_blocked THEN RAISE EXCEPTION 'FAIL: direct insert bypassed safety acknowledgement'; END IF;
  v_briefing := public.get_shift_safety_briefing(v_shift);
  IF (v_briefing->>'item_count')::integer <> 1 OR (v_briefing->>'acknowledged')::boolean THEN
    RAISE EXCEPTION 'FAIL: approved hazard did not reach the assigned briefing';
  END IF;
  v_blocked := false;
  BEGIN
    PERFORM public.start_officer_shift(gen_random_uuid(), v_shift, 'scheduled');
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE '%acknowledge%' THEN RAISE; END IF;
    v_blocked := true;
  END;
  IF NOT v_blocked THEN RAISE EXCEPTION 'FAIL: unacknowledged start was accepted'; END IF;
  v_receipt := public.acknowledge_safety_briefing(v_shift, v_briefing->>'briefing_hash', v_request);
  IF (v_receipt->>'replayed')::boolean THEN RAISE EXCEPTION 'FAIL: first acknowledgement was a replay'; END IF;
  v_receipt := public.acknowledge_safety_briefing(v_shift, v_briefing->>'briefing_hash', v_request);
  IF NOT (v_receipt->>'replayed')::boolean THEN RAISE EXCEPTION 'FAIL: retry was not idempotent'; END IF;
  PERFORM public.start_officer_shift(gen_random_uuid(), v_shift, 'scheduled');
  IF (SELECT status FROM public.shifts WHERE id = v_shift) <> 'in_progress' THEN
    RAISE EXCEPTION 'FAIL: acknowledged shift did not start';
  END IF;

  v_blocked := false;
  BEGIN
    INSERT INTO public.shift_stops(organization_id, shift_id, zone_id, module_key, stop_order, sla_arrive_by, status)
    VALUES (v_org, v_shift, v_zone, 'general_patrol', 9999, now(), 'on_scene');
  EXCEPTION WHEN SQLSTATE 'P0001' THEN v_blocked := true;
  END;
  IF NOT v_blocked THEN RAISE EXCEPTION 'FAIL: direct stop insert bypassed safety acknowledgement'; END IF;
  v_blocked := false;
  BEGIN
    UPDATE public.shift_stops SET status = 'on_scene' WHERE id = v_stop;
  EXCEPTION WHEN SQLSTATE 'P0001' THEN v_blocked := true;
  END;
  IF NOT v_blocked THEN RAISE EXCEPTION 'FAIL: stop arrival accepted a whole-shift receipt'; END IF;
  v_receipt := public.get_shift_safety_briefing(v_shift, v_stop);
  PERFORM public.acknowledge_safety_briefing(v_shift, v_receipt->>'briefing_hash', gen_random_uuid(), v_stop);
  UPDATE public.shift_stops SET status = 'on_scene' WHERE id = v_stop;

  v_request := gen_random_uuid();
  v_report := public.report_place_hazard(v_shift, 'zone', v_zone, 'Synthetic broken light', 'electrical', 'critical', v_request);
  IF public.report_place_hazard(v_shift, 'zone', v_zone, 'Synthetic broken light', 'electrical', 'critical', v_request) <> v_report THEN
    RAISE EXCEPTION 'FAIL: officer report retry was not idempotent';
  END IF;
  SELECT count(*) INTO v_count FROM public.notifications
    WHERE recipient_user_id = v_admin AND category = 'place_hazard_review' AND link_payload->>'hazard_id' = v_report::text;
  IF v_count <> 1 THEN RAISE EXCEPTION 'FAIL: reviewer did not receive exactly one notification'; END IF;
  v_receipt := public.get_shift_safety_briefing(v_shift);
  IF (v_receipt->>'acknowledged')::boolean OR NOT (v_receipt->>'changed_since_acknowledgement')::boolean
    OR v_receipt->'hazards'->0->>'status' <> 'reported' THEN
    RAISE EXCEPTION 'FAIL: new report did not invalidate the briefing or appear critical-first';
  END IF;
  v_blocked := false;
  BEGIN
    PERFORM public.acknowledge_safety_briefing(v_shift, v_briefing->>'briefing_hash', gen_random_uuid());
  EXCEPTION WHEN SQLSTATE 'P0001' THEN v_blocked := true;
  END;
  IF NOT v_blocked THEN RAISE EXCEPTION 'FAIL: stale briefing hash was accepted'; END IF;
  INSERT INTO public.entity_flags(id, organization_id, entity_type, entity_id, flag_type, alert_level, hazard_class, reason)
    SELECT v_warning, v_org, 'place', canonical_place_id, 'loi', 'high', 'other', 'Synthetic warning before change'
    FROM public.locations WHERE id = v_location;
  v_briefing := public.get_shift_safety_briefing(v_shift);
  UPDATE public.entity_flags SET reason = 'Synthetic changed warning instructions' WHERE id = v_warning;
  v_receipt := public.get_shift_safety_briefing(v_shift);
  IF v_receipt->>'briefing_hash' = v_briefing->>'briefing_hash' THEN
    RAISE EXCEPTION 'FAIL: changed warning instructions did not change the briefing hash';
  END IF;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  IF NOT public.can_manage_place_hazards(v_org, v_location)
    OR public.can_manage_place_hazards(v_org, v_other_location) THEN
    RAISE EXCEPTION 'FAIL: hazard-management authority does not respect organisation/place relationship';
  END IF;
  PERFORM public.manage_place_hazard('update', v_hazard,
    '{"controls":[],"likelihood":2,"consequence":4}'::jsonb, NULL);
  IF (SELECT cardinality(controls) <> 0 OR likelihood <> 2 OR consequence <> 4 FROM public.place_hazards WHERE id = v_hazard) THEN
    RAISE EXCEPTION 'FAIL: controls cannot be cleared or risk assessment cannot be stored';
  END IF;
  PERFORM public.manage_place_hazard('confirm', v_report, '{}'::jsonb, NULL);
  IF (SELECT status FROM public.place_hazards WHERE id = v_report) <> 'active' THEN
    RAISE EXCEPTION 'FAIL: reviewer confirmation did not persist';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.acknowledge_safety_briefing(uuid,text,uuid,uuid,double precision,double precision)', 'execute')
    OR has_function_privilege('authenticated', 'public.apply_bob_place_hazard_proposal(uuid)', 'execute') THEN
    RAISE EXCEPTION 'FAIL: client/service RPC grants are wrong';
  END IF;
END;
$$;
