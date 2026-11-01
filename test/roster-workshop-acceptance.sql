-- Run after the migration in one transaction and ROLLBACK. All records are synthetic.
DO $test$
DECLARE
  v_org uuid := 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13';
  v_actor uuid := 'f1c00000-0000-4000-8000-000000000001';
  v_place uuid := gen_random_uuid();
  v_order uuid := gen_random_uuid();
  v_draft uuid := gen_random_uuid();
  v_internal uuid := gen_random_uuid();
  v_client uuid;
  v_asset uuid := gen_random_uuid();
  v_maintenance uuid := gen_random_uuid();
  v_foreign_order uuid := gen_random_uuid();
  v_unit public.roster_work_units%rowtype;
  v_slot public.roster_slots%rowtype;
  v_cost record;
  v_failed boolean;
BEGIN
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_actor, 'role', 'authenticated')::text, true);
  IF NOT public.is_admin_for_org(v_org) THEN RAISE EXCEPTION 'Dedicated import automation administrator is unavailable'; END IF;
  INSERT INTO public.organization_workplaces(id, organization_id, name)
    VALUES (v_place, v_org, 'Synthetic workshop roster acceptance');
  SELECT client_organization_id INTO v_client FROM public.service_agreements
    WHERE provider_organization_id = v_org AND client_organization_id <> v_org LIMIT 1;
  IF v_client IS NULL THEN RAISE EXCEPTION 'Provider-scoped client fixture unavailable'; END IF;
  INSERT INTO public.workshop_work_orders(id, organization_id, client_request_id, order_number, kind, title, status, client_organization_id)
    VALUES (v_order, v_org, gen_random_uuid(), 'TEST-' || v_order, 'fabrication', 'Synthetic fabrication acceptance', 'approved', v_client),
      (v_draft, v_org, gen_random_uuid(), 'TEST-' || v_draft, 'fabrication', 'Synthetic draft acceptance', 'draft', v_client),
      (v_internal, v_org, gen_random_uuid(), 'TEST-' || v_internal, 'fabrication', 'Synthetic internal order', 'approved', NULL);
  v_failed := false;
  BEGIN
    PERFORM public.create_operating_workshop_roster_work_unit(v_org, 'Internal order', v_internal, v_place);
  EXCEPTION WHEN raise_exception THEN v_failed := SQLERRM LIKE 'Manufacturing and maintenance work must be assigned to a client%'; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'Internal order without a client was accepted'; END IF;
  SELECT * INTO v_unit FROM public.create_operating_workshop_roster_work_unit(v_org, 'Synthetic labour unit', v_order, v_place);
  IF v_unit.work_unit_type <> 'workshop' OR v_unit.service_type <> 'fabrication'
    OR v_unit.workshop_work_order_id <> v_order THEN RAISE EXCEPTION 'Work order link or derived service type missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.audit_log WHERE target_id = v_unit.id
    AND action = 'roster_work_unit_created' AND metadata->>'workshop_work_order_id' = v_order::text) THEN
    RAISE EXCEPTION 'Work unit audit receipt missing';
  END IF;
  v_failed := false;
  BEGIN
    PERFORM public.create_operating_workshop_roster_work_unit(v_org, 'Duplicate', v_order, v_place);
  EXCEPTION WHEN raise_exception THEN v_failed := SQLERRM LIKE 'This work order already%'; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'Duplicate order link was not rejected'; END IF;

  v_failed := false;
  BEGIN
    PERFORM public.create_operating_workshop_roster_work_unit(v_org, 'Foreign order', gen_random_uuid(), v_place);
  EXCEPTION WHEN raise_exception THEN v_failed := SQLERRM = 'Open work order in this operating branch required'; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'Unknown or foreign order was not rejected'; END IF;
  v_failed := false;
  BEGIN
    PERFORM public.create_operating_workshop_roster_work_unit(v_org, 'Foreign workplace', v_draft, gen_random_uuid());
  EXCEPTION WHEN raise_exception THEN v_failed := SQLERRM = 'Active provider workplace required'; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'Unknown or foreign workplace was not rejected'; END IF;

  SELECT * INTO v_slot FROM public.create_roster_slot(gen_random_uuid(), v_unit.id, NULL, now() + interval '7 days', now() + interval '7 days 2 hours', false);
  PERFORM public.manage_roster_slot(v_slot.id, 'draft', 'publish');
  IF (SELECT linked_shift_id IS NOT NULL OR status <> 'published' FROM public.roster_slots WHERE id = v_slot.id) THEN
    RAISE EXCEPTION 'Workshop publication fabricated a field shift or failed';
  END IF;
  SELECT * INTO v_cost FROM public.get_roster_labour_cost(v_org, now() + interval '6 days', now() + interval '8 days') WHERE slot_id = v_slot.id;
  IF NOT FOUND OR v_cost.billable IS NOT NULL OR v_cost.charge_rate IS NOT NULL OR v_cost.margin IS NOT NULL THEN
    RAISE EXCEPTION 'Workshop roster labour was charged a second time';
  END IF;
  v_failed := false;
  BEGIN
    PERFORM public.materialize_roster_slot(v_slot.id, 'published');
  EXCEPTION WHEN raise_exception THEN v_failed := SQLERRM = 'Only patrol and static roster slots materialize field shifts'; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'Workshop materialization was not refused'; END IF;
  PERFORM public.manage_roster_slot(v_slot.id, 'published', 'cancel', 'Synthetic test cleanup');

  SELECT * INTO v_unit FROM public.create_operating_workshop_roster_work_unit(v_org, 'Draft order unit', v_draft, v_place);
  v_failed := false;
  BEGIN
    PERFORM public.create_roster_slot(gen_random_uuid(), v_unit.id, NULL, now() + interval '8 days', now() + interval '8 days 1 hour', false);
  EXCEPTION WHEN raise_exception THEN v_failed := SQLERRM = 'Approve an open Workshop work order before rostering its labour'; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'Unapproved order accepted roster labour'; END IF;
  UPDATE public.workshop_work_orders SET status = 'cancelled' WHERE id = v_draft;
  v_failed := false;
  BEGIN
    PERFORM public.create_operating_workshop_roster_work_unit(v_org, 'Closed order', v_draft, v_place);
  EXCEPTION WHEN raise_exception THEN v_failed := SQLERRM = 'Open work order in this operating branch required'; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'Closed order was accepted'; END IF;

  INSERT INTO public.assets(id, organization_id, name, asset_type)
    VALUES (v_asset, v_org, 'Synthetic maintenance asset', 'other');
  INSERT INTO public.workshop_work_orders(id, organization_id, client_request_id, order_number, kind, title, status, client_organization_id, asset_id)
    VALUES (v_maintenance, v_org, gen_random_uuid(), 'TEST-' || v_maintenance, 'maintenance', 'Synthetic client maintenance', 'approved', v_client, v_asset);
  INSERT INTO public.workshop_work_orders(id, organization_id, client_request_id, order_number, kind, title, status)
    VALUES (v_foreign_order, v_client, gen_random_uuid(), 'TEST-' || v_foreign_order, 'fabrication', 'Synthetic foreign order', 'approved');
  SELECT * INTO v_unit FROM public.create_operating_workshop_roster_work_unit(v_org, 'Client maintenance unit', v_maintenance, v_place);
  IF v_unit.service_type <> 'maintenance'
    OR (SELECT client_organization_id IS DISTINCT FROM v_client OR asset_id IS DISTINCT FROM v_asset
      FROM public.workshop_work_orders WHERE id = v_unit.workshop_work_order_id) THEN
    RAISE EXCEPTION 'Client maintenance attribution was changed or lost';
  END IF;
  v_failed := false;
  BEGIN
    PERFORM public.create_operating_workshop_roster_work_unit(v_org, 'Cross-tenant order', v_foreign_order, v_place);
  EXCEPTION WHEN raise_exception THEN v_failed := SQLERRM = 'Open work order in this operating branch required'; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'Cross-tenant order was accepted'; END IF;
  SELECT * INTO v_slot FROM public.create_roster_slot(gen_random_uuid(), v_unit.id, NULL, now() + interval '9 days', now() + interval '9 days 1 hour', false);
  PERFORM public.manage_roster_slot(v_slot.id, 'draft', 'publish');
  SELECT * INTO v_cost FROM public.get_roster_labour_cost(v_org, now() + interval '8 days', now() + interval '10 days') WHERE slot_id = v_slot.id;
  IF NOT FOUND OR v_cost.billable IS NOT NULL OR v_cost.margin IS NOT NULL THEN
    RAISE EXCEPTION 'Client maintenance was charged twice';
  END IF;

  IF has_function_privilege('anon', 'public.create_operating_workshop_roster_work_unit(uuid,text,uuid,uuid,uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Anonymous work unit creation is exposed';
  END IF;
  PERFORM set_config('request.jwt.claims', '{}', true);
  v_failed := false;
  BEGIN
    PERFORM public.create_operating_workshop_roster_work_unit(v_org, 'Unauthenticated', v_order, v_place);
  EXCEPTION WHEN raise_exception THEN v_failed := SQLERRM = 'Active authorized operating branch administrator required'; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'Unauthenticated creation was accepted'; END IF;
END;
$test$;
SELECT jsonb_build_object('mode', 'rollback', 'workshop_roster_acceptance', 'passed') AS result;
