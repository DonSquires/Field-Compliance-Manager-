DO $test$
DECLARE
  v_actor uuid:='fcab0000-0000-4000-8000-000000000001';
  v_other uuid:='fcab0000-0000-4000-8000-000000000002';
  v_shift uuid:=gen_random_uuid();
  v_from uuid:=gen_random_uuid();
  v_to uuid:=gen_random_uuid();
  v_result jsonb;
  v_replay jsonb;
  v_rejected boolean;
BEGIN
  INSERT INTO public.user_profiles(id,organization_id,role,display_name,email)
  VALUES(v_actor,'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid,'officer','Synthetic travel test officer','travel-fixture@example.invalid'),
    (v_other,'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid,'officer','Synthetic other travel test officer','other-travel-fixture@example.invalid');
  INSERT INTO public.shifts(id,organization_id,officer_user_id,service_type,scheduled_start,scheduled_end,status,notes)
  VALUES(v_shift,'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid,v_actor,'patrol',
    '2026-10-19T08:00:00Z','2026-10-19T16:00:00Z','completed','Synthetic rollback-only travel evidence test');
  INSERT INTO public.shift_stops(id,organization_id,shift_id,zone_id,module_key,stop_order,sla_arrive_by,status,actual_arrived_at,actual_departed_at,travel_distance_metres)
  VALUES(v_from,'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid,v_shift,'b32a08f4-a29f-4b5d-80f6-9647acd5a817'::uuid,'general_patrol',1,
    '2026-10-19T09:00:00Z','completed','2026-10-19T09:00:00Z','2026-10-19T09:10:00Z',999),
    (v_to,'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid,v_shift,'b2f86f76-dba5-4a3f-a7f2-0d32ef8448fe'::uuid,'general_patrol',2,
    '2026-10-19T09:30:00Z','completed','2026-10-19T09:30:00Z','2026-10-19T09:40:00Z',999);
  PERFORM set_config('request.jwt.claim.sub',v_actor::text,true);
  v_result:=public.record_patrol_travel_distance('fcab0000-0000-4000-8000-000000000010'::uuid,v_from,v_to,12.5,NULL,NULL,0);
  IF (v_result->>'distance_km')::numeric<>12.5 OR v_result->>'method'<>'recorded_km'
    OR (SELECT travel_distance_metres FROM public.shift_stops WHERE id=v_to)<>999 THEN
    RAISE EXCEPTION 'Measured travel was not recorded separately from the route estimate'; END IF;
  v_replay:=public.record_patrol_travel_distance('fcab0000-0000-4000-8000-000000000010'::uuid,v_from,v_to,12.5,NULL,NULL,0);
  IF (v_replay->>'replayed')::boolean IS NOT TRUE OR (v_replay->>'version')::integer<>1 THEN
    RAISE EXCEPTION 'Travel replay was not idempotent'; END IF;
  v_result:=public.record_patrol_travel_distance('fcab0000-0000-4000-8000-000000000011'::uuid,v_from,v_to,NULL,100,113.25,1);
  IF (v_result->>'distance_km')::numeric<>13.25 OR v_result->>'method'<>'odometer_difference' THEN
    RAISE EXCEPTION 'Odometer difference was not recorded'; END IF;
  v_rejected:=false;
  BEGIN
    PERFORM public.record_patrol_travel_distance('fcab0000-0000-4000-8000-000000000012'::uuid,v_from,v_to,NULL,113.25,5,2);
  EXCEPTION WHEN raise_exception THEN v_rejected:=true; END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Odometer reset was accepted'; END IF;
  v_rejected:=false;
  BEGIN
    PERFORM public.record_patrol_travel_distance('fcab0000-0000-4000-8000-000000000013'::uuid,v_from,v_to,10,NULL,NULL,0);
  EXCEPTION WHEN raise_exception THEN v_rejected:=true; END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Stale distance correction was accepted'; END IF;
  v_rejected:=false;
  BEGIN
    UPDATE public.shift_stops SET actual_travel_distance_km=99 WHERE id=v_to;
  EXCEPTION WHEN raise_exception THEN v_rejected:=true; END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Direct unaudited distance write was accepted'; END IF;
  PERFORM set_config('request.jwt.claim.sub',v_other::text,true);
  v_rejected:=false;
  BEGIN
    PERFORM public.record_patrol_travel_distance('fcab0000-0000-4000-8000-000000000014'::uuid,v_from,v_to,10,NULL,NULL,2);
  EXCEPTION WHEN raise_exception THEN v_rejected:=true; END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Another officer recorded travel on this shift'; END IF;
  IF (SELECT count(*) FROM public.audit_log WHERE actor_user_id=v_actor AND action='patrol_actual_travel_recorded')<>2 THEN
    RAISE EXCEPTION 'Travel write/replay/correction audit count is incorrect'; END IF;
END;
$test$;
SELECT true AS actual_travel_behavior_verified;