SET LOCAL request.jwt.claim.sub = 'f1c00000-0000-4000-8000-000000000001';

DO $test$
DECLARE
  v_agreement uuid;
  v_result jsonb;
  v_replay jsonb;
  v_config public.client_site_patrol_config%rowtype;
  v_schedule public.service_agreement_delivery_schedules%rowtype;
  v_rejected boolean;
  v_audits integer;
BEGIN
  SELECT id INTO v_agreement FROM public.service_agreements
  WHERE provider_organization_id='e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid
    AND client_organization_id='405fc1f7-45e8-4736-a517-885bb3e5ef95'::uuid
    AND agreement_type='operational' AND invitation_status IN ('not_invited','invited','accepted')
    AND (ends_on IS NULL OR ends_on>=current_date)
  ORDER BY created_at LIMIT 1;
  IF v_agreement IS NULL THEN RAISE EXCEPTION 'Scoped R&M/NCC test agreement is unavailable'; END IF;
  v_result:=public.manage_crm_as_attended_patrol(
    'fca00000-0000-4000-8000-000000000001'::uuid,v_agreement,
    '5438c224-02e1-41fd-af00-952ba46cb8c0'::uuid,NULL,
    'b32a08f4-a29f-4b5d-80f6-9647acd5a817'::uuid,'Rollback-only attendance-mode verification');
  SELECT * INTO v_config FROM public.client_site_patrol_config WHERE id=(v_result->>'patrol_config_id')::uuid;
  SELECT * INTO v_schedule FROM public.service_agreement_delivery_schedules WHERE id=(v_result->>'schedule_id')::uuid;
  IF v_result->>'attendance_mode'<>'as_attended' OR v_schedule.work_model<>'as_attended_patrol'
    OR v_schedule.visits_per_shift<>0 OR v_config.visits_per_shift<>0 OR v_config.dwell_minutes<>0
    OR v_config.time_window_type<>'as_attended' OR v_config.sla_arrive_within_minutes IS NOT NULL
    OR v_config.sla_depart_within_minutes IS NOT NULL OR v_config.window_start IS NOT NULL OR v_config.window_end IS NOT NULL THEN
    RAISE EXCEPTION 'As-attended schedule contains synthetic visit or timing obligations';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.patrol_route_zones WHERE patrol_route_id='5438c224-02e1-41fd-af00-952ba46cb8c0'::uuid
    AND zone_id='b32a08f4-a29f-4b5d-80f6-9647acd5a817'::uuid AND expected_visits_per_shift IS NULL AND preferred_time_window IS NULL) THEN
    RAISE EXCEPTION 'Attendance place was not linked to the selected patrol';
  END IF;
  SELECT count(*) INTO v_audits FROM public.audit_log WHERE action='crm_as_attended_patrol_configured'
    AND metadata->>'client_request_id'='fca00000-0000-4000-8000-000000000001';
  v_replay:=public.manage_crm_as_attended_patrol(
    'fca00000-0000-4000-8000-000000000001'::uuid,v_agreement,
    '5438c224-02e1-41fd-af00-952ba46cb8c0'::uuid,NULL,'b32a08f4-a29f-4b5d-80f6-9647acd5a817'::uuid);
  IF v_replay->>'schedule_id'<>v_result->>'schedule_id' OR (v_replay->>'replayed')::boolean IS NOT TRUE
    OR (SELECT count(*) FROM public.audit_log WHERE action='crm_as_attended_patrol_configured'
      AND metadata->>'client_request_id'='fca00000-0000-4000-8000-000000000001')<>v_audits THEN
    RAISE EXCEPTION 'Attendance schedule replay was not idempotent';
  END IF;
  v_rejected:=false;
  BEGIN
    UPDATE public.client_site_patrol_config SET visits_per_shift=1 WHERE id=v_config.id;
  EXCEPTION WHEN check_violation THEN v_rejected:=true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Attendance mode accepted a planned visit obligation'; END IF;
  v_rejected:=false;
  BEGIN
    UPDATE public.client_site_patrol_config SET sla_arrive_within_minutes=30 WHERE id=v_config.id;
  EXCEPTION WHEN check_violation THEN v_rejected:=true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Attendance mode accepted an arrival deadline'; END IF;
  v_rejected:=false;
  BEGIN
    PERFORM public.manage_crm_as_attended_patrol(
      'fca00000-0000-4000-8000-000000000002'::uuid,v_agreement,
      'fca00000-0000-4000-8000-000000000099'::uuid,NULL,'b32a08f4-a29f-4b5d-80f6-9647acd5a817'::uuid);
  EXCEPTION WHEN raise_exception THEN v_rejected:=true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Attendance schedule accepted an unauthorized patrol'; END IF;
  IF position('cspc.time_window_type <> ''as_attended''' IN pg_get_functiondef('public.generate_shift_stops(uuid,date)'::regprocedure))=0 THEN
    RAISE EXCEPTION 'Scheduled stop generation does not exclude attendance-based configurations';
  END IF;
END;
$test$;

SELECT true AS attendance_schedule_behavior_verified;