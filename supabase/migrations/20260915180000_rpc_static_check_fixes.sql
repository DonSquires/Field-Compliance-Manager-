-- Static-check sweep of every public plpgsql RPC (plpgsql_check in the disposable database),
-- each finding confirmed against the live catalog and, where reachable, by a rolled-back live
-- probe on 2026-09-15. These are functions that are present and wired but fail the first
-- time a real call reaches the faulty statement.
--
-- Live-confirmed failures: register_officer_device_token (mobile push registration),
-- get_officer_data_package (mobile offline package), get_bob_roster_fill_candidates (Bob roster
-- fill), closure_at_point (zone closure lookup), wf_pickup_run / wf_service_pickup_run
-- (Bob control-plane lease pickup), compare_boundaries_hausdorff / propose_boundary (boundary
-- review). closure_at_point has no live caller (process-officer-scan moved to resolve_context;
-- 20260915170000 dropped its sibling get_zone_for_gps) but stays exposed to authenticated callers,
-- so it is made correct rather than left failing. Statically certain, reached only with real records: manage_debrief_followup,
-- manage_noise_assessment_review, manage_smoke_assessment_review, rollback_bob_roster_fill_plan,
-- submit_officer_timesheet_from_work, resubmit_rejected_timesheet_from_work,
-- submit_smoke_assessment_receipt, request_shift_swap, review_shift_swap, accept_quote
-- (called by manage_crm_quote on acceptance), generate_shift_stops (called by
-- materialize_roster_slot), calculate_cost_centre_roll (also declared STABLE while inserting).
--
-- Found by the truth table, not the static check: get_officer_timesheet_work's CTEs had unnamed
-- columns, so its `ended_at > started_at` filter bound to the (null) RETURNS TABLE variables and
-- every officer timesheet derived from work carried zero hours. Columns are now named.
--
-- Two columns were written by governed paths but never added to their tables; the intent is
-- clear from the migrations and the declared schema, so they are added rather than the writes
-- removed: smoke_assessments.shift_id (noise sibling has it; the edge function passes it) and
-- shift_stops.officer_instructions (quote schedule -> patrol config -> stop, so the officer
-- sees the instruction at the stop).

ALTER TABLE public.smoke_assessments ADD COLUMN IF NOT EXISTS shift_id uuid REFERENCES public.shifts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_smoke_assessments_shift ON public.smoke_assessments (shift_id) WHERE shift_id IS NOT NULL;
COMMENT ON COLUMN public.smoke_assessments.shift_id IS 'Shift the assessment was made on (submit_smoke_assessment_receipt); mirrors noise_assessments.shift_id.';

ALTER TABLE public.shift_stops ADD COLUMN IF NOT EXISTS officer_instructions text;
COMMENT ON COLUMN public.shift_stops.officer_instructions IS 'Instruction for the officer at this stop, copied from client_site_patrol_config at generation (quote schedule -> patrol config -> stop).';

-- Found by the truth table: the live notifications_category_check is the 20260830071000 list.
-- The ledger records 20260901006000..20260906000004 (leave_decision, timesheet_decision,
-- breach_decision, debrief_followup, noise_review, video_review) as applied, but the live
-- constraint does not carry them, so review_timesheet, review_leave_request,
-- manage_breach_alert, manage_debrief_followup (escalate/resolve) and
-- manage_noise_assessment_review (with an officer) all fail on the notification insert.
-- Re-assert the full recorded list; every existing row is within it.
DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO definition
  FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public' AND t.relname = 'notifications' AND c.conname = 'notifications_category_check';
  IF definition IS NULL OR definition NOT LIKE '%debrief_followup%' OR definition NOT LIKE '%video_review%' THEN
    ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_category_check;
    ALTER TABLE public.notifications ADD CONSTRAINT notifications_category_check
      CHECK (category = ANY (ARRAY[
        'credential_expiry'::text, 'sla_breach'::text, 'report_ready'::text,
        'report_reviewed'::text, 'leave_decision'::text, 'timesheet_decision'::text,
        'breach_decision'::text, 'debrief_followup'::text, 'noise_review'::text,
        'welfare'::text, 'dispatch'::text, 'roster'::text, 'open_job'::text,
        'video_review'::text, 'system'::text, 'schema_change_request'::text,
        'bob_conversation'::text, 'bob_self_memory'::text
      ]));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION "public"."register_officer_device_token"(p_push_token text, p_platform text DEFAULT 'expo'::text, p_device_name text DEFAULT NULL::text, p_app_version text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, push_token text, platform text, is_active boolean, last_seen_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_token public.officer_device_tokens%rowtype;
  v_clean_token text := trim(coalesce(p_push_token, ''));
  v_clean_platform text := lower(trim(coalesce(p_platform, 'expo')));
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  select p.organization_id into v_org_id from public.user_profiles p where p.id = v_user_id and p.deactivated_at is null;
  if v_org_id is null then raise exception 'Active profile required for device registration'; end if;
  if v_clean_token = '' then raise exception 'push_token is required'; end if;
  if v_clean_platform not in ('expo', 'ios', 'android', 'web') then
    raise exception 'Unsupported device platform %', p_platform;
  end if;

  insert into public.officer_device_tokens (
    organization_id, user_id, push_token, platform, device_name, app_version, is_active, last_seen_at, updated_at
  ) values (
    v_org_id, v_user_id, v_clean_token, v_clean_platform, nullif(trim(coalesce(p_device_name, '')), ''), nullif(trim(coalesce(p_app_version, '')), ''), true, clock_timestamp(), clock_timestamp()
  )
  on conflict (organization_id, user_id, push_token) do update set
    platform = excluded.platform,
    device_name = coalesce(excluded.device_name, officer_device_tokens.device_name),
    app_version = coalesce(excluded.app_version, officer_device_tokens.app_version),
    is_active = true,
    last_seen_at = clock_timestamp(),
    updated_at = clock_timestamp()
  returning * into v_token;

  insert into public.audit_log (
    organization_id, actor_user_id, action, target_table, target_id, metadata
  ) values (
    v_org_id, v_user_id, 'officer_device_token_registered', 'officer_device_tokens', v_token.id,
    jsonb_build_object('platform', v_token.platform, 'device_name', v_token.device_name, 'app_version', v_token.app_version)
  );

  return query select v_token.id, v_token.push_token, v_token.platform, v_token.is_active, v_token.last_seen_at;
end;
$function$;

CREATE OR REPLACE FUNCTION "public"."get_officer_data_package"(p_shift_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_zones jsonb;
  v_matrix jsonb;
  v_flags jsonb;
  v_rules jsonb;
  v_stops jsonb;
  v_welfare jsonb;
  v_package jsonb;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  select p.organization_id into v_org_id from public.user_profiles p where p.id = v_user_id and p.deactivated_at is null;
  if v_org_id is null then raise exception 'Active officer profile required for data package download'; end if;

  if p_shift_id is not null and not exists (select 1 from public.shifts s where s.id = p_shift_id and s.organization_id = v_org_id) then
    raise exception 'Shift does not belong to the officer organisation';
  end if;

  -- 1. Active location zones (address is the house address)
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', z.id,
    'location_id', z.location_id,
    'name', z.name,
    'address', l.address,
    'zone_type', z.zone_type,
    'module_key', z.module_key,
    'rule_type', z.rule_type,
    'is_active', z.is_active
  )), '[]'::jsonb) into v_zones
  from public.location_zones z
  left join public.locations l on l.id = z.location_id
  where z.organization_id = v_org_id and z.is_active = true;

  -- 2. Current zone compliance matrix
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', m.id,
    'zone_id', m.zone_id,
    'max_consecutive_nights', m.max_consecutive_nights,
    'max_nights_per_month', m.max_nights_per_month,
    'scv_required', m.scv_required,
    'is_current', m.is_current
  )), '[]'::jsonb) into v_matrix
  from public.zone_compliance_matrix m
  where m.organization_id = v_org_id and m.is_current = true;

  -- 3. Active entity flags (vehicle/person)
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', f.id,
    'entity_type', f.entity_type,
    'entity_id', f.entity_id,
    'plate_number', cv.plate_number,
    'flag_type', f.flag_type,
    'flag_reason', f.reason,
    'severity', f.alert_level,
    'is_active', f.active
  )), '[]'::jsonb) into v_flags
  from public.entity_flags f
  left join public.canonical_vehicles cv on f.entity_type = 'vehicle' and cv.id = f.entity_id
  where f.organization_id = v_org_id and f.active = true;

  -- 4. Module rule sets
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id,
    'module_key', r.module_key,
    'name', r.name,
    'evidence_requirements', r.evidence_requirements,
    'approval_policy', r.approval_policy
  )), '[]'::jsonb) into v_rules
  from public.module_rule_sets r
  where r.organization_id = v_org_id;

  -- 5. Patrol stops for current shift if supplied
  if p_shift_id is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', st.id,
      'site_id', st.site_id,
      'zone_id', st.zone_id,
      'status', st.status,
      'sla_respond_by', st.sla_arrive_by,
      'sla_depart_by', st.sla_depart_by,
      'notes', st.officer_notes,
      'officer_instructions', st.officer_instructions
    )), '[]'::jsonb) into v_stops
    from public.shift_stops st
    where st.shift_id = p_shift_id and st.organization_id = v_org_id;
  else
    v_stops := '[]'::jsonb;
  end if;

  -- 6. Welfare settings
  select to_jsonb(w.*) into v_welfare
  from public.officer_welfare_settings w
  where w.organization_id = v_org_id limit 1;

  v_package := jsonb_build_object(
    'package_timestamp', clock_timestamp(),
    'organization_id', v_org_id,
    'officer_id', v_user_id,
    'shift_id', p_shift_id,
    'location_zones', v_zones,
    'zone_compliance_matrix', v_matrix,
    'entity_flags', v_flags,
    'module_rule_sets', v_rules,
    'shift_stops', v_stops,
    'welfare_settings', coalesce(v_welfare, '{}'::jsonb)
  );

  insert into public.audit_log (
    organization_id, actor_user_id, action, target_table, target_id, metadata
  ) values (
    v_org_id, v_user_id, 'officer_data_package_downloaded', 'user_profiles', v_user_id,
    jsonb_build_object('shift_id', p_shift_id, 'zone_count', jsonb_array_length(v_zones), 'flag_count', jsonb_array_length(v_flags))
  );

  return v_package;
end;
$function$;

CREATE OR REPLACE FUNCTION "public"."get_bob_roster_fill_candidates"(p_organization_id uuid, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS TABLE(roster_slot_id uuid, work_unit_id uuid, scheduled_start timestamp with time zone, scheduled_end timestamp with time zone, staff_id uuid, score numeric, rationale text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_admin_for_org(p_organization_id) then
    raise exception 'Active roster administrator required';
  end if;

  if p_to <= p_from or p_to - p_from > interval '31 days' then
    raise exception 'Roster planning window must be greater than zero and no more than 31 days';
  end if;

  return query
  select
    slot.id,
    slot.work_unit_id,
    slot.scheduled_start,
    slot.scheduled_end,
    staff.id,
    (
      100
      - coalesce((now()::date - staff.seniority_date) / 3650.0, 0)
      - coalesce((select count(*) from public.roster_slots assigned where assigned.staff_id = staff.id and assigned.status not in ('declined', 'cancelled') and assigned.scheduled_start >= p_from and assigned.scheduled_start < p_to), 0) * 3
    )::numeric(8,2),
    concat_ws('; ',
      'work-ready',
      'current credentials/training required by roster gate',
      'available',
      'fatigue clear',
      case when staff.seniority_date is null then 'seniority date unavailable' else 'balanced by current scheduled load and seniority' end
    )
  from public.roster_slots slot
  join public.staff_profiles staff on staff.organization_id = slot.organization_id
  where slot.organization_id = p_organization_id
    and slot.staff_id is null
    and slot.status = 'draft'
    and slot.scheduled_start >= p_from
    and slot.scheduled_start < p_to
    and staff.work_ready = true
    and staff.overtime_eligible = true
    and (staff.end_date is null or staff.end_date >= (slot.scheduled_start at time zone 'Pacific/Auckland')::date)
    and not public.staff_has_roster_availability_conflict(staff.id, slot.scheduled_start, slot.scheduled_end)
    and public.staff_fatigue_conflict(staff.id, slot.scheduled_start, slot.scheduled_end, slot.id) is null
    and not exists (
      select 1 from public.roster_slots occupied
      where occupied.staff_id = staff.id
        and occupied.status not in ('declined', 'cancelled')
        and tstzrange(occupied.scheduled_start, occupied.scheduled_end, '[)')
            && tstzrange(slot.scheduled_start, slot.scheduled_end, '[)')
    )
  order by slot.scheduled_start, score desc, staff.seniority_date asc nulls last, staff.id;
end;
$function$;

CREATE OR REPLACE FUNCTION "public"."closure_at_point"(p_lat double precision, p_lng double precision, p_org_id uuid)
 RETURNS TABLE(closure_id uuid, zone_id uuid, closure_type text, reason text)
 LANGUAGE plpgsql
 STABLE
AS $function$
declare
  v_point geometry := st_setsrid(st_point(p_lng, p_lat), 4326);
begin
  return query
  select
    zc.id,
    zc.zone_id,
    zc.closure_type,
    zc.reason
  from zone_closures zc
  join location_zones lz on lz.id = zc.zone_id
  where zc.organization_id = p_org_id
    and lz.organization_id = p_org_id
    and st_contains(lz.boundary, v_point)
    and zc.status = 'active'
    and zc.effective_from <= current_date
    and (zc.effective_to is null or zc.effective_to >= current_date)
  limit 1;
end;
$function$;

CREATE OR REPLACE FUNCTION "public"."manage_debrief_followup"(p_followup_id uuid, p_expected_version integer, p_action text, p_note text)
 RETURNS TABLE(followup_id uuid, followup_status text, owner_user_id uuid, followup_version integer, acted_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
declare v_actor uuid:=auth.uid();v_item public.debrief_followups%rowtype;v_note text:=nullif(trim(coalesce(p_note,'')),'');
begin
  select f.* into v_item from public.debrief_followups f where f.id=p_followup_id for update;if not found then raise exception 'Debrief follow-up not found';end if;
  if not public.is_admin_for_org(v_item.organization_id) then raise exception 'Active operations administrator required';end if;
  if v_item.version<>p_expected_version then raise exception 'Debrief follow-up changed since it was opened';end if;
  if v_note is null then raise exception 'Follow-up action notes are required';end if;
  if p_action='claim' and v_item.status='open' then update public.debrief_followups set status='claimed',owner_user_id=v_actor,latest_note=v_note,version=version+1,updated_at=clock_timestamp() where id=v_item.id returning * into v_item;
  elsif p_action='escalate' and v_item.status in('open','claimed') then update public.debrief_followups set status='escalated',owner_user_id=coalesce(owner_user_id,v_actor),latest_note=v_note,version=version+1,updated_at=clock_timestamp() where id=v_item.id returning * into v_item;
  elsif p_action='resolve' and v_item.status in('claimed','escalated') then update public.debrief_followups set status='resolved',owner_user_id=coalesce(owner_user_id,v_actor),latest_note=v_note,resolved_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() where id=v_item.id returning * into v_item;
  else raise exception 'Unsupported debrief follow-up transition from % using %',v_item.status,p_action;end if;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_item.organization_id,v_actor,'debrief_followup_managed','debrief_followups',v_item.id,jsonb_build_object('action',p_action,'status',v_item.status,'owner_user_id',v_item.owner_user_id,'version',v_item.version,'note',v_note));
  if p_action in('escalate','resolve') then perform public.enqueue_notification(p_organization_id=>v_item.organization_id,p_category=>'debrief_followup',p_title=>case when p_action='resolve' then 'Debrief follow-up resolved' else 'Debrief follow-up escalated' end,p_body=>v_note,p_severity=>case when p_action='escalate' then 'warning' else 'info' end,p_recipient_user_id=>v_item.officer_user_id,p_link_page=>'debrief-followup',p_link_payload=>jsonb_build_object('debrief_id',v_item.debrief_id,'followup_id',v_item.id),p_dedup_key=>'debrief_followup:'||v_item.id::text||':'||v_item.version::text);end if;
  return query select v_item.id,v_item.status,v_item.owner_user_id,v_item.version,v_item.updated_at;
end;$function$;
REVOKE ALL ON FUNCTION "public"."manage_debrief_followup"(p_followup_id uuid, p_expected_version integer, p_action text, p_note text) FROM PUBLIC, "anon", "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION "public"."manage_debrief_followup"(p_followup_id uuid, p_expected_version integer, p_action text, p_note text) TO "postgres";
GRANT EXECUTE ON FUNCTION "public"."manage_debrief_followup"(p_followup_id uuid, p_expected_version integer, p_action text, p_note text) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."manage_debrief_followup"(p_followup_id uuid, p_expected_version integer, p_action text, p_note text) TO "service_role";

CREATE OR REPLACE FUNCTION "public"."manage_dispatch_job"(p_job_id uuid, p_expected_status text, p_action text, p_priority text DEFAULT NULL::text, p_briefing_notes text DEFAULT NULL::text, p_dispatch_resource_id uuid DEFAULT NULL::uuid, p_reason text DEFAULT NULL::text)
 RETURNS dispatch_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_actor uuid := auth.uid(); v_job public.dispatch_jobs%rowtype;
BEGIN
  SELECT * INTO v_job FROM public.dispatch_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR NOT public.is_admin_for_org(v_job.organization_id) THEN RAISE EXCEPTION 'Dispatch job not found or access denied'; END IF;
  IF v_job.status <> p_expected_status THEN RAISE EXCEPTION 'Dispatch job changed since it was opened'; END IF;
  IF v_job.status IN ('completed','cancelled') THEN RAISE EXCEPTION 'Completed or cancelled jobs cannot be changed'; END IF;
  IF p_action NOT IN ('amend','reassign','escalate','cancel') THEN RAISE EXCEPTION 'Unsupported dispatch job action'; END IF;
  IF nullif(trim(coalesce(p_reason,'')), '') IS NULL THEN RAISE EXCEPTION 'A reason is required'; END IF;
  IF p_priority IS NOT NULL AND p_priority NOT IN ('low','normal','high','urgent') THEN RAISE EXCEPTION 'Unsupported priority'; END IF;
  IF p_action = 'cancel' THEN
    UPDATE public.dispatch_jobs SET status='cancelled', outcome_notes=concat_ws(E'\n', outcome_notes, 'Cancelled: ' || trim(p_reason)) WHERE id=v_job.id RETURNING * INTO v_job;
  ELSE
    UPDATE public.dispatch_jobs SET
      priority=CASE WHEN p_action='escalate' THEN 'urgent' ELSE coalesce(p_priority, priority) END,
      briefing_notes=coalesce(nullif(trim(p_briefing_notes),''), briefing_notes),
      dispatch_resource_id=CASE WHEN p_action='reassign' THEN p_dispatch_resource_id ELSE dispatch_resource_id END,
      sla_impact_warning=CASE WHEN p_action='escalate' THEN true ELSE sla_impact_warning END
    WHERE id=v_job.id RETURNING * INTO v_job;
  END IF;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  VALUES(v_job.organization_id,v_actor,'dispatch_job_'||p_action,'dispatch_jobs',v_job.id,jsonb_build_object('reason',trim(p_reason),'priority',v_job.priority,'dispatch_resource_id',v_job.dispatch_resource_id,'status',v_job.status));
  RETURN v_job;
END; $function$;
REVOKE ALL ON FUNCTION "public"."manage_dispatch_job"(p_job_id uuid, p_expected_status text, p_action text, p_priority text, p_briefing_notes text, p_dispatch_resource_id uuid, p_reason text) FROM PUBLIC, "anon", "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION "public"."manage_dispatch_job"(p_job_id uuid, p_expected_status text, p_action text, p_priority text, p_briefing_notes text, p_dispatch_resource_id uuid, p_reason text) TO "postgres";
GRANT EXECUTE ON FUNCTION "public"."manage_dispatch_job"(p_job_id uuid, p_expected_status text, p_action text, p_priority text, p_briefing_notes text, p_dispatch_resource_id uuid, p_reason text) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."manage_dispatch_job"(p_job_id uuid, p_expected_status text, p_action text, p_priority text, p_briefing_notes text, p_dispatch_resource_id uuid, p_reason text) TO "service_role";

CREATE OR REPLACE FUNCTION "public"."manage_dispatch_job_timing"(p_job_id uuid, p_expected_status text, p_sla_minutes integer, p_expected_dwell_minutes integer, p_timing_source text DEFAULT 'dispatcher_override'::text, p_reason text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, status text, sla_minutes integer, sla_respond_by timestamp with time zone, expected_dwell_minutes integer, timing_source text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_job public.dispatch_jobs%rowtype;
BEGIN
  SELECT job.* INTO v_job FROM public.dispatch_jobs AS job WHERE job.id = p_job_id FOR UPDATE;
  IF NOT FOUND OR NOT public.is_admin_for_org(v_job.organization_id) THEN RAISE EXCEPTION 'Dispatch job not found or access denied'; END IF;
  IF v_job.status <> p_expected_status OR v_job.status IN ('completed', 'cancelled') THEN RAISE EXCEPTION 'Dispatch job timing can only change for its current active status'; END IF;
  IF p_sla_minutes NOT BETWEEN 1 AND 1440 OR p_expected_dwell_minutes NOT BETWEEN 1 AND 240 THEN RAISE EXCEPTION 'SLA and dwell time are outside allowed ranges'; END IF;
  IF p_timing_source NOT IN ('site_service', 'patrol_schedule', 'bob_pattern', 'dispatcher_override') THEN RAISE EXCEPTION 'Unsupported timing source'; END IF;
  UPDATE public.dispatch_jobs AS job SET sla_minutes = p_sla_minutes, sla_respond_by = job.created_at + make_interval(mins => p_sla_minutes), expected_dwell_minutes = p_expected_dwell_minutes, timing_source = p_timing_source
  WHERE job.id = v_job.id RETURNING job.* INTO v_job;
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES(v_job.organization_id, auth.uid(), 'dispatch_job_timing_updated', 'dispatch_jobs', v_job.id, jsonb_build_object('sla_minutes', v_job.sla_minutes, 'expected_dwell_minutes', v_job.expected_dwell_minutes, 'timing_source', v_job.timing_source, 'reason', nullif(trim(coalesce(p_reason, '')), '')));
  RETURN QUERY SELECT v_job.id, v_job.status, v_job.sla_minutes, v_job.sla_respond_by, v_job.expected_dwell_minutes, v_job.timing_source;
END; $function$;
REVOKE ALL ON FUNCTION "public"."manage_dispatch_job_timing"(p_job_id uuid, p_expected_status text, p_sla_minutes integer, p_expected_dwell_minutes integer, p_timing_source text, p_reason text) FROM PUBLIC, "anon", "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION "public"."manage_dispatch_job_timing"(p_job_id uuid, p_expected_status text, p_sla_minutes integer, p_expected_dwell_minutes integer, p_timing_source text, p_reason text) TO "postgres";
GRANT EXECUTE ON FUNCTION "public"."manage_dispatch_job_timing"(p_job_id uuid, p_expected_status text, p_sla_minutes integer, p_expected_dwell_minutes integer, p_timing_source text, p_reason text) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."manage_dispatch_job_timing"(p_job_id uuid, p_expected_status text, p_sla_minutes integer, p_expected_dwell_minutes integer, p_timing_source text, p_reason text) TO "service_role";

CREATE OR REPLACE FUNCTION "public"."manage_finance_item"(p_organization_id uuid, p_action text, p_item_id uuid, p_sku text, p_name text, p_item_type text, p_unit_of_measure text, p_unit_cost numeric, p_unit_price numeric, p_supplier_name text DEFAULT NULL::text, p_source_reference text DEFAULT NULL::text, p_effective_from date DEFAULT CURRENT_DATE)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is null or not public.user_can_operate_organization(p_organization_id) or not public.is_admin_for_org(p_organization_id) then
    raise exception 'Active organisation administrator required';
  end if;
  return public.manage_finance_item_internal(auth.uid(), p_organization_id, p_action, p_item_id, p_sku, p_name, p_item_type, p_unit_of_measure, p_unit_cost, p_unit_price, p_supplier_name, p_source_reference, p_effective_from);
end;
$function$;

CREATE OR REPLACE FUNCTION "public"."manage_noise_assessment_review"(p_assessment_id uuid, p_expected_review_status text, p_action text, p_notes text)
 RETURNS TABLE(assessment_id uuid, review_status text, reviewed_by uuid, reviewed_at timestamp with time zone, follow_up_required boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
declare v_actor uuid:=auth.uid();v_item public.noise_assessments%rowtype;v_officer uuid;v_next text;v_notes text:=nullif(trim(coalesce(p_notes,'')),'');
begin
  select n.* into v_item from public.noise_assessments n where n.id=p_assessment_id for update;if not found then raise exception 'Noise assessment not found';end if;
  if not public.is_admin_for_org(v_item.organization_id) then raise exception 'Active Noise Control administrator required';end if;
  if v_item.review_status<>p_expected_review_status then raise exception 'Noise review changed from expected status % to %',p_expected_review_status,v_item.review_status;end if;
  if v_notes is null then raise exception 'Noise review notes are required';end if;
  if p_action='acknowledge' and v_item.review_status='open' then v_next:='acknowledged';
  elsif p_action='require_follow_up' and v_item.review_status in('open','acknowledged','follow_up') then v_next:='follow_up';
  elsif p_action='close' and v_item.review_status in('open','acknowledged','follow_up') then v_next:='closed';
  else raise exception 'Unsupported Noise Control review transition from % using %',v_item.review_status,p_action;end if;
  update public.noise_assessments set review_status=v_next,reviewed_by=v_actor,reviewed_at=clock_timestamp(),review_notes=v_notes,follow_up_required=case when v_next='follow_up' then true when v_next='closed' then false else follow_up_required end where id=v_item.id returning * into v_item;
  v_officer:=coalesce(v_item.officer_user_id,v_item.officer_id);
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_item.organization_id,v_actor,'noise_assessment_reviewed','noise_assessments',v_item.id,jsonb_build_object('previous_review_status',p_expected_review_status,'review_status',v_item.review_status,'action',p_action,'source_officer_id',v_officer,'notes',v_notes));
  if v_officer is not null then perform public.enqueue_notification(p_organization_id=>v_item.organization_id,p_category=>'noise_review',p_title=>'Noise assessment reviewed',p_body=>v_notes,p_severity=>case when v_next='follow_up' then 'warning' else 'info' end,p_recipient_user_id=>v_officer,p_link_page=>'noise-review',p_link_payload=>jsonb_build_object('assessment_id',v_item.id),p_dedup_key=>'noise_review:'||v_item.id::text||':'||v_item.review_status);end if;
  return query select v_item.id,v_item.review_status,v_item.reviewed_by,v_item.reviewed_at,v_item.follow_up_required;
end;$function$;
REVOKE ALL ON FUNCTION "public"."manage_noise_assessment_review"(p_assessment_id uuid, p_expected_review_status text, p_action text, p_notes text) FROM PUBLIC, "anon", "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION "public"."manage_noise_assessment_review"(p_assessment_id uuid, p_expected_review_status text, p_action text, p_notes text) TO "postgres";
GRANT EXECUTE ON FUNCTION "public"."manage_noise_assessment_review"(p_assessment_id uuid, p_expected_review_status text, p_action text, p_notes text) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."manage_noise_assessment_review"(p_assessment_id uuid, p_expected_review_status text, p_action text, p_notes text) TO "service_role";

CREATE OR REPLACE FUNCTION "public"."manage_notice_template"(p_organization_id uuid, p_module_key text, p_notice_type text, p_body_html text, p_issuing_authority text DEFAULT NULL::text, p_authorising_act text DEFAULT NULL::text, p_authorising_section text DEFAULT NULL::text, p_bylaw_reference text DEFAULT NULL::text, p_fine_amount numeric DEFAULT NULL::numeric, p_payment_url text DEFAULT NULL::text, p_footer_text text DEFAULT NULL::text, p_source_document_url text DEFAULT NULL::text, p_bob_extracted boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_version integer;
  v_row public.notice_templates%rowtype;
BEGIN
  IF v_actor IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN
    RAISE EXCEPTION 'Organization administrator required';
  END IF;
  IF p_module_key NOT IN ('freedom_camping', 'parking_enforcement', 'noise_control', 'smoke_complaints', 'biosecurity') THEN
    RAISE EXCEPTION 'Unsupported enforcement module';
  END IF;
  IF p_notice_type NOT IN ('written_warning', 'notice_to_vacate', 'infringement', 'end', 'seizure') THEN
    RAISE EXCEPTION 'Unsupported notice type';
  END IF;
  IF nullif(trim(coalesce(p_body_html, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Template body is required';
  END IF;

  SELECT coalesce(max(version), 0) + 1 INTO v_version
  FROM public.notice_templates
  WHERE organization_id = p_organization_id
    AND module_key = p_module_key
    AND notice_type = p_notice_type;

  UPDATE public.notice_templates
  SET is_active = false, updated_at = now()
  WHERE organization_id = p_organization_id
    AND module_key = p_module_key
    AND notice_type = p_notice_type
    AND is_active;

  INSERT INTO public.notice_templates (
    organization_id, module_key, notice_type, version, is_active, issuing_authority,
    authorising_act, authorising_section, bylaw_reference, body_html, fine_amount,
    payment_url, footer_text, source_document_url, bob_extracted, created_by
  ) VALUES (
    p_organization_id, p_module_key, p_notice_type, v_version, true, p_issuing_authority,
    coalesce(p_authorising_act, 'Resource Management Act 1991'), p_authorising_section,
    p_bylaw_reference, p_body_html, p_fine_amount, p_payment_url, p_footer_text,
    p_source_document_url, coalesce(p_bob_extracted, false), v_actor
  ) RETURNING * INTO v_row;

  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (p_organization_id, v_actor, 'notice_template_saved', 'notice_templates', v_row.id,
    jsonb_build_object('module_key', p_module_key, 'notice_type', p_notice_type,
      'version', v_version, 'bob_extracted', coalesce(p_bob_extracted, false),
      'source_document_url', p_source_document_url));

  RETURN jsonb_build_object('id', v_row.id, 'module_key', v_row.module_key,
    'notice_type', v_row.notice_type, 'version', v_row.version,
    'is_active', v_row.is_active, 'source_document_url', v_row.source_document_url,
    'bob_extracted', v_row.bob_extracted);
END;
$function$;

CREATE OR REPLACE FUNCTION "public"."manage_smoke_assessment_review"(p_assessment_id uuid, p_expected_review_state text, p_action text, p_notes text)
 RETURNS TABLE(assessment_id uuid, review_state text, reviewed_by uuid, reviewed_at timestamp with time zone, follow_up_required boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
declare
  v_actor uuid := auth.uid();
  v_item public.smoke_assessments%rowtype;
  v_officer uuid;
  v_next text;
  v_notes text := nullif(trim(coalesce(p_notes, '')), '');
begin
  select s.* into v_item from public.smoke_assessments s where s.id = p_assessment_id for update;
  if not found then raise exception 'Smoke assessment not found'; end if;
  if not public.is_admin_for_org(v_item.organization_id) then raise exception 'Active Smoke Complaints administrator required'; end if;
  if v_item.review_state <> p_expected_review_state then
    raise exception 'Smoke review changed from expected state % to %', p_expected_review_state, v_item.review_state;
  end if;
  if v_notes is null then raise exception 'Review notes are required'; end if;

  if p_action = 'triage' and v_item.review_state in ('submitted', 'requires_supervisor_review') then
    v_next := 'triaged';
  elsif p_action = 'require_review' then
    v_next := 'requires_supervisor_review';
  elsif p_action = 'close' and v_item.review_state in ('submitted', 'requires_supervisor_review', 'triaged') then
    v_next := 'closed';
  else
    raise exception 'Unsupported smoke review transition from % using %', v_item.review_state, p_action;
  end if;

  update public.smoke_assessments
    set review_state = v_next,
        reviewed_by = v_actor,
        reviewed_at = clock_timestamp(),
        review_notes = v_notes,
        follow_up_required = case when v_next = 'requires_supervisor_review' then true when v_next = 'closed' then false else follow_up_required end
    where id = v_item.id
    returning * into v_item;

  v_officer := coalesce(v_item.officer_user_id, v_item.officer_id);

  insert into public.audit_log (
    organization_id, actor_user_id, action, target_table, target_id, metadata
  ) values (
    v_item.organization_id, v_actor, 'smoke_assessment_reviewed', 'smoke_assessments', v_item.id,
    jsonb_build_object('previous_review_state', p_expected_review_state, 'review_state', v_next, 'action', p_action, 'source_officer_id', v_officer, 'notes', v_notes)
  );

  if v_officer is not null then
    perform public.enqueue_notification(
      p_organization_id => v_item.organization_id,
      p_category => 'report_reviewed',
      p_title => 'Smoke assessment reviewed',
      p_body => v_notes,
      p_severity => case when v_next = 'requires_supervisor_review' then 'warning' else 'info' end,
      p_recipient_user_id => v_officer,
      p_link_page => 'smoke-review',
      p_link_payload => jsonb_build_object('assessment_id', v_item.id),
      p_dedup_key => 'smoke_review:' || v_item.id::text || ':' || v_item.review_state
    );
  end if;

  return query select v_item.id, v_item.review_state, v_item.reviewed_by, v_item.reviewed_at, v_item.follow_up_required;
end;
$function$;

CREATE OR REPLACE FUNCTION "public"."rollback_bob_roster_fill_plan"(p_action_id uuid)
 RETURNS TABLE(plan_id uuid, assignments_rolled_back integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
declare
  v_action public.bob_agentic_actions%rowtype;
  v_plan public.bob_roster_plans%rowtype;
  v_item public.bob_roster_plan_slots%rowtype;
  v_slot public.roster_slots%rowtype;
  v_count integer := 0;
begin
  select a.* into v_action from public.bob_agentic_actions a where a.id = p_action_id for update;
  if not found then raise exception 'Bob action not found'; end if;
  if v_action.action_type <> 'rollback_bob_roster_plan' or v_action.status <> 'approved' then
    raise exception 'Only approved rollback_bob_roster_plan actions can be executed';
  end if;

  select p.* into v_plan from public.bob_roster_plans p
  where p.id = (coalesce(v_action.amended_payload, v_action.proposed_payload)->>'plan_id')::uuid
    and p.organization_id = v_action.organization_id
  for update;
  if not found then raise exception 'Bob roster plan not found'; end if;
  if v_plan.status <> 'applied' then raise exception 'Bob roster plan is already rolled back'; end if;

  for v_item in select * from public.bob_roster_plan_slots where plan_id = v_plan.id and rolled_back_at is null loop
    select s.* into v_slot from public.roster_slots s where s.id = v_item.roster_slot_id for update;
    if not found or v_slot.status <> 'draft' or v_slot.staff_id is distinct from v_item.staff_id then
      raise exception 'Roster slot % was edited or published after plan application; it cannot be rolled back automatically', v_item.roster_slot_id;
    end if;
    update public.roster_slots set staff_id = null where id = v_slot.id;
    update public.bob_roster_plan_slots set rolled_back_at = now() where id = v_item.id;
    v_count := v_count + 1;
  end loop;

  update public.bob_roster_plans
  set status = 'rolled_back', rolled_back_at = now(), rolled_back_by = v_action.approved_by,
      rollback_reason = nullif(trim(coalesce(coalesce(v_action.amended_payload, v_action.proposed_payload)->>'reason', '')), '')
  where id = v_plan.id;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_action.organization_id, v_action.approved_by, 'bob_roster_plan_rolled_back', 'bob_roster_plans', v_plan.id,
    jsonb_build_object('action_id', v_action.id, 'assignments_rolled_back', v_count));

  return query select v_plan.id, v_count;
end;
$function$;

CREATE OR REPLACE FUNCTION "public"."submit_officer_timesheet_from_work"(p_client_event_id uuid, p_period_start date, p_period_end date, p_adjustment_hours numeric DEFAULT 0, p_notes text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, created boolean, submitted_at timestamp with time zone, work_derived_hours numeric, actual_hours numeric, source_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_staff public.staff_profiles%rowtype;
  v_sheet public.timesheets%rowtype;
  v_work record;
  v_work_json jsonb := '[]'::jsonb;
  v_work_minutes integer := 0;
  v_source_count integer := 0;
  v_adjustment numeric := coalesce(p_adjustment_hours, 0);
  v_actual numeric;
  v_scheduled numeric;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  select sp.* into v_staff from public.staff_profiles sp join public.user_profiles up on up.id = v_user_id and up.deactivated_at is null where (sp.user_id = v_user_id or sp.id = v_user_id) and sp.organization_id = up.organization_id limit 1;
  if not found then raise exception 'Active staff profile required'; end if;
  if p_client_event_id is null then raise exception 'client_event_id is required'; end if;
  if p_period_start is null or p_period_end is null or p_period_start > p_period_end or p_period_end - p_period_start > 31 then raise exception 'Timesheet period must be between 1 and 32 days'; end if;
  if p_period_end > current_date then raise exception 'Future timesheet periods cannot be submitted'; end if;
  if v_adjustment < -744 or v_adjustment > 744 then raise exception 'Adjustment hours are outside the accepted range'; end if;

  select t.* into v_sheet from public.timesheets t where t.organization_id = v_staff.organization_id and t.staff_id = v_staff.id and t.client_event_id = p_client_event_id;
  if found then
    return query select v_sheet.id, false, v_sheet.submitted_at, coalesce(v_sheet.work_derived_hours, 0), v_sheet.actual_hours, (select count(*)::integer from public.timesheet_work_entries e where e.timesheet_id = v_sheet.id);
    return;
  end if;
  if exists (select 1 from public.timesheets t where t.staff_id = v_staff.id and daterange(t.period_start, t.period_end, '[]') && daterange(p_period_start, p_period_end, '[]')) then raise exception 'A timesheet already overlaps this period'; end if;

  for v_work in select * from public.get_officer_timesheet_work(p_period_start, p_period_end) loop
    v_work_minutes := v_work_minutes + v_work.calculated_minutes;
    v_source_count := v_source_count + 1;
    v_work_json := v_work_json || jsonb_build_array(jsonb_build_object('source_type', v_work.source_type, 'source_id', v_work.source_id, 'work_status', v_work.work_status, 'started_at', v_work.started_at, 'ended_at', v_work.ended_at, 'calculated_minutes', v_work.calculated_minutes, 'label', v_work.label, 'metadata', v_work.metadata));
  end loop;

  v_actual := round((v_work_minutes::numeric / 60) + v_adjustment, 2);
  if v_actual < 0 or v_actual > 744 then raise exception 'Derived actual hours are outside the accepted range'; end if;

  select coalesce(sum(extract(epoch from (s.scheduled_end - s.scheduled_start)) / 3600), 0) into v_scheduled from public.shifts s where s.organization_id = v_staff.organization_id and s.officer_user_id = v_user_id and s.scheduled_start::date between p_period_start and p_period_end and s.status in ('accepted', 'in_progress', 'completed');

  insert into public.timesheets (organization_id, staff_id, period_start, period_end, scheduled_hours, actual_hours, overtime_hours, adjustment_hours, work_derived_hours, work_summary, status, notes, submitted_at, client_event_id)
  values (v_staff.organization_id, v_staff.id, p_period_start, p_period_end, round(v_scheduled, 2), v_actual, greatest(0, v_actual - round(v_scheduled, 2)), v_adjustment, round(v_work_minutes::numeric / 60, 2), jsonb_build_object('source_count', v_source_count, 'work_minutes', v_work_minutes, 'entries', v_work_json), 'submitted', nullif(trim(coalesce(p_notes, '')), ''), clock_timestamp(), p_client_event_id)
  returning * into v_sheet;

  for v_work in select value from jsonb_array_elements(v_work_json) loop
    insert into public.timesheet_work_entries (organization_id, timesheet_id, source_type, source_id, work_status, started_at, ended_at, calculated_minutes, metadata)
    values (v_staff.organization_id, v_sheet.id, (v_work.value)->>'source_type', ((v_work.value)->>'source_id')::uuid, (v_work.value)->>'work_status', ((v_work.value)->>'started_at')::timestamptz, ((v_work.value)->>'ended_at')::timestamptz, ((v_work.value)->>'calculated_minutes')::integer, coalesce((v_work.value)->'metadata', '{}'::jsonb));
  end loop;

  insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_staff.organization_id, v_user_id, 'timesheet_submitted_from_work', 'timesheets', v_sheet.id, jsonb_build_object('staff_id', v_sheet.staff_id, 'period_start', p_period_start, 'period_end', p_period_end, 'work_derived_hours', v_sheet.work_derived_hours, 'adjustment_hours', v_adjustment, 'actual_hours', v_sheet.actual_hours, 'source_count', v_source_count));

  return query select v_sheet.id, true, v_sheet.submitted_at, v_sheet.work_derived_hours, v_sheet.actual_hours, v_source_count;
end;
$function$;

CREATE OR REPLACE FUNCTION "public"."resubmit_rejected_timesheet_from_work"(p_timesheet_id uuid, p_adjustment_hours numeric DEFAULT 0, p_notes text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, submitted_at timestamp with time zone, actual_hours numeric, source_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
declare
  v_actor uuid := auth.uid();
  v_staff public.staff_profiles%rowtype;
  v_sheet public.timesheets%rowtype;
  v_work record;
  v_minutes integer := 0;
  v_count integer := 0;
  v_actual numeric;
  v_entries jsonb := '[]'::jsonb;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  select t.* into v_sheet from public.timesheets t where t.id = p_timesheet_id for update;
  if not found then raise exception 'Timesheet not found'; end if;
  select sp.* into v_staff from public.staff_profiles sp where (sp.user_id = v_actor or sp.id = v_actor) and sp.id = v_sheet.staff_id and sp.organization_id = v_sheet.organization_id;
  if not found then raise exception 'Only the timesheet owner can resubmit it'; end if;
  if v_sheet.status <> 'rejected' then raise exception 'Only rejected timesheets can be resubmitted'; end if;
  if p_adjustment_hours < -744 or p_adjustment_hours > 744 then raise exception 'Adjustment hours are outside the accepted range'; end if;

  for v_work in select * from public.get_officer_timesheet_work(v_sheet.period_start, v_sheet.period_end) loop
    v_minutes := v_minutes + v_work.calculated_minutes;
    v_count := v_count + 1;
    v_entries := v_entries || jsonb_build_array(jsonb_build_object('source_type', v_work.source_type, 'source_id', v_work.source_id, 'work_status', v_work.work_status, 'started_at', v_work.started_at, 'ended_at', v_work.ended_at, 'calculated_minutes', v_work.calculated_minutes, 'label', v_work.label, 'metadata', v_work.metadata));
  end loop;
  v_actual := round((v_minutes::numeric / 60) + coalesce(p_adjustment_hours, 0), 2);
  if v_actual < 0 or v_actual > 744 then raise exception 'Derived actual hours are outside the accepted range'; end if;

  delete from public.timesheet_work_entries where timesheet_id = v_sheet.id;
  update public.timesheets set actual_hours = v_actual, overtime_hours = greatest(0, v_actual - coalesce(scheduled_hours, 0)), adjustment_hours = coalesce(p_adjustment_hours, 0), work_derived_hours = round(v_minutes::numeric / 60, 2), work_summary = jsonb_build_object('source_count', v_count, 'work_minutes', v_minutes, 'entries', v_entries), status = 'submitted', review_notes = nullif(trim(coalesce(p_notes, '')), ''), submitted_at = clock_timestamp(), approved_by = null, approved_at = null where id = v_sheet.id returning * into v_sheet;

  for v_work in select value from jsonb_array_elements(v_entries) loop
    insert into public.timesheet_work_entries (organization_id, timesheet_id, source_type, source_id, work_status, started_at, ended_at, calculated_minutes, metadata) values (v_sheet.organization_id, v_sheet.id, (v_work.value)->>'source_type', ((v_work.value)->>'source_id')::uuid, (v_work.value)->>'work_status', ((v_work.value)->>'started_at')::timestamptz, ((v_work.value)->>'ended_at')::timestamptz, ((v_work.value)->>'calculated_minutes')::integer, coalesce((v_work.value)->'metadata', '{}'::jsonb));
  end loop;

  insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata) values (v_sheet.organization_id, v_actor, 'timesheet_resubmitted_after_correction', 'timesheets', v_sheet.id, jsonb_build_object('actual_hours', v_actual, 'adjustment_hours', p_adjustment_hours, 'source_count', v_count, 'prior_status', 'rejected'));
  return query select v_sheet.id, v_sheet.submitted_at, v_sheet.actual_hours, v_count;
end;
$function$;

CREATE OR REPLACE FUNCTION "public"."submit_smoke_assessment_receipt"(p_client_request_id uuid, p_assessed_at timestamp with time zone, p_smoke_source_type text DEFAULT 'domestic_solid_fuel'::text, p_complaint_source text DEFAULT 'neighbour'::text, p_severity text DEFAULT 'medium'::text, p_action_taken text DEFAULT 'no_action'::text, p_scene_description text DEFAULT NULL::text, p_address text DEFAULT NULL::text, p_complaint_address text DEFAULT NULL::text, p_complainant_site_id uuid DEFAULT NULL::uuid, p_site_id uuid DEFAULT NULL::uuid, p_notice_number text DEFAULT NULL::text, p_legal_basis text DEFAULT 'RMA s.17A'::text, p_is_out_of_hours boolean DEFAULT false, p_follow_up_required boolean DEFAULT false, p_shift_id uuid DEFAULT NULL::uuid, p_dispatch_job_id uuid DEFAULT NULL::uuid, p_evidence_items jsonb DEFAULT '[]'::jsonb, p_classification jsonb DEFAULT '{}'::jsonb)
 RETURNS TABLE(id uuid, created boolean, received_at timestamp with time zone, evidence_state text, review_state text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_existing public.smoke_assessments%rowtype;
  v_assessment public.smoke_assessments%rowtype;
  v_review_state text;
  v_evidence_state text := 'verified';
  v_item jsonb;
  v_evidence_id uuid;
  v_photo_arr jsonb := '[]'::jsonb;
  v_ordinal integer := 0;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  select p.organization_id into v_org_id from public.user_profiles p where p.id = v_user_id and p.deactivated_at is null and p.role in ('officer', 'admin_officer', 'admin', 'master', 'grand_master');
  if v_org_id is null then raise exception 'Active officer profile required'; end if;
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;

  if p_assessed_at is null or p_assessed_at > now() + interval '5 minutes' or p_assessed_at < now() - interval '24 hours' then
    raise exception 'assessed_at is outside the accepted capture window';
  end if;

  if nullif(trim(coalesce(p_address, '')), '') is null then
    raise exception 'Observed smoke location address is required';
  end if;

  if p_action_taken in ('abatement_notice', 'infringement_notice') and nullif(trim(coalesce(p_notice_number, '')), '') is null then
    raise exception 'Notice number is required for statutory abatement or infringement notices';
  end if;

  if p_shift_id is not null and not exists (select 1 from public.shifts s where s.id = p_shift_id and s.organization_id = v_org_id) then
    raise exception 'Shift does not belong to the officer organisation';
  end if;

  if p_dispatch_job_id is not null and not exists (select 1 from public.dispatch_jobs d where d.id = p_dispatch_job_id and d.organization_id = v_org_id) then
    raise exception 'Dispatch job does not belong to the officer organisation';
  end if;

  -- Idempotency check
  select s.* into v_existing from public.smoke_assessments s
    where s.organization_id = v_org_id and s.officer_user_id = v_user_id and s.client_request_id = p_client_request_id;
  if found then
    return query select v_existing.id, false, v_existing.created_at, v_existing.evidence_state, v_existing.review_state;
    return;
  end if;

  -- Derive initial review state
  if p_classification is null or coalesce(p_classification->>'classification', '') = '' or coalesce(p_classification->>'status', '') = 'unavailable' then
    v_review_state := 'requires_supervisor_review';
  else
    v_review_state := 'submitted';
  end if;

  insert into public.smoke_assessments (
    organization_id, officer_user_id, officer_id, client_request_id, assessed_at,
    smoke_source_type, smoke_source, complaint_source, severity, action_taken, action,
    scene_description, address, complaint_address, complainant_site_id, site_id,
    notice_number, legal_basis, is_out_of_hours, follow_up_required,
    shift_id, dispatch_job_id, status, evidence_state, review_state,
    bob_classification, bob_confidence
  ) values (
    v_org_id, v_user_id, v_user_id, p_client_request_id, p_assessed_at,
    p_smoke_source_type, p_smoke_source_type, p_complaint_source, p_severity, p_action_taken, p_action_taken,
    nullif(trim(coalesce(p_scene_description, '')), ''), trim(p_address), nullif(trim(coalesce(p_complaint_address, '')), ''), p_complainant_site_id, p_site_id,
    nullif(trim(coalesce(p_notice_number, '')), ''), coalesce(p_legal_basis, 'RMA s.17A'), coalesce(p_is_out_of_hours, false), coalesce(p_follow_up_required, false),
    p_shift_id, p_dispatch_job_id, 'open', v_evidence_state, v_review_state,
    nullif(trim(coalesce(p_classification->>'classification', '')), ''), (p_classification->>'confidence')::real
  ) returning * into v_assessment;

  -- Process evidence items
  if jsonb_array_length(p_evidence_items) > 0 then
    for v_item in select * from jsonb_array_elements(p_evidence_items) loop
      v_evidence_id := gen_random_uuid();
      insert into public.evidence_items (
        id, organization_id, module_key, evidence_kind, storage_path, captured_by_user_id, captured_at, metadata
      ) values (
        v_evidence_id, v_org_id, 'smoke_complaints', coalesce(v_item->>'evidence_kind', 'photo'), v_item->>'watermarked_path', v_user_id, p_assessed_at, coalesce(v_item, '{}'::jsonb)
      );

      insert into public.smoke_assessment_evidence (
        organization_id, smoke_assessment_id, evidence_item_id, ordinal, purpose
      ) values (
        v_org_id, v_assessment.id, v_evidence_id, v_ordinal, coalesce(v_item->>'purpose', 'primary_evidence')
      );

      v_photo_arr := v_photo_arr || jsonb_build_array(jsonb_build_object(
        'id', v_evidence_id,
        'storage_path', v_item->>'watermarked_path',
        'original_path', v_item->>'original_path',
        'captured_at', p_assessed_at
      ));
      v_ordinal := v_ordinal + 1;
    end loop;

    update public.smoke_assessments
      set photo_urls = v_photo_arr
      where id = v_assessment.id;
  end if;

  insert into public.audit_log (
    organization_id, actor_user_id, action, target_table, target_id, metadata
  ) values (
    v_org_id, v_user_id, 'smoke_assessment_submitted', 'smoke_assessments', v_assessment.id,
    jsonb_build_object(
      'client_request_id', p_client_request_id,
      'smoke_source_type', v_assessment.smoke_source_type,
      'severity', v_assessment.severity,
      'action_taken', v_assessment.action_taken,
      'is_out_of_hours', v_assessment.is_out_of_hours,
      'review_state', v_review_state,
      'evidence_count', v_ordinal
    )
  );

  return query select v_assessment.id, true, v_assessment.created_at, v_assessment.evidence_state, v_assessment.review_state;
end;
$function$;

CREATE OR REPLACE FUNCTION "public"."request_shift_swap"(p_client_request_id uuid, p_shift_id uuid, p_swap_with_staff_id uuid DEFAULT NULL::uuid, p_swap_type text DEFAULT 'open'::text, p_reason text DEFAULT NULL::text)
 RETURNS shift_swaps
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := auth.uid(); v_shift public.shifts%rowtype; v_original_staff public.staff_profiles%rowtype; v_replacement public.staff_profiles%rowtype; v_swap public.shift_swaps%rowtype; v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  if p_swap_type not in ('open', 'direct', 'coverage_request') then raise exception 'Unsupported shift swap type'; end if;
  if v_reason is null then raise exception 'A reason is required for a shift swap request'; end if;
  select s.* into v_shift from public.shifts s where s.id = p_shift_id for update;
  if not found then raise exception 'Shift not found'; end if;
  if v_shift.officer_user_id <> v_actor then raise exception 'Only the assigned officer can request a swap'; end if;
  if v_shift.status not in ('scheduled', 'published', 'accepted') then raise exception 'Only unstarted shifts can be swapped'; end if;
  select sp.* into v_original_staff from public.staff_profiles sp where sp.organization_id = v_shift.organization_id and (sp.user_id = v_actor or sp.id = v_actor) and sp.work_ready;
  if not found then raise exception 'Active work-ready staff profile required'; end if;
  if p_swap_with_staff_id is not null then
    if p_swap_type <> 'direct' then raise exception 'A replacement officer requires a direct swap'; end if;
    select sp.* into v_replacement from public.staff_profiles sp where sp.id = p_swap_with_staff_id and sp.organization_id = v_shift.organization_id and sp.work_ready;
    if not found or v_replacement.id = v_original_staff.id then raise exception 'Replacement officer is not eligible'; end if;
    if exists (select 1 from public.roster_slots rs where rs.staff_id = v_replacement.id and rs.status not in ('declined', 'cancelled') and rs.scheduled_start < v_shift.scheduled_end and rs.scheduled_end > v_shift.scheduled_start) then raise exception 'Replacement officer has an overlapping roster assignment'; end if;
  end if;
  select sw.* into v_swap from public.shift_swaps sw where sw.organization_id = v_shift.organization_id and sw.original_shift_id = v_shift.id and sw.status = 'pending' order by sw.created_at desc limit 1;
  if found then return v_swap; end if;
  insert into public.shift_swaps (organization_id, original_shift_id, original_staff_id, swap_with_staff_id, swap_type, reason, status, requested_by, requested_at) values (v_shift.organization_id, v_shift.id, v_original_staff.id, p_swap_with_staff_id, p_swap_type, v_reason, 'pending', v_actor, clock_timestamp()) returning * into v_swap;
  insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata) values (v_shift.organization_id, v_actor, 'shift_swap_requested', 'shift_swaps', v_swap.id, jsonb_build_object('shift_id', v_shift.id, 'swap_type', p_swap_type, 'replacement_staff_id', p_swap_with_staff_id, 'reason', v_reason, 'client_request_id', p_client_request_id));
  if p_swap_with_staff_id is not null and v_replacement.user_id is not null then perform public.enqueue_notification(v_shift.organization_id, 'roster', 'Direct shift swap requested', 'An officer has requested you take a rostered shift. Await roster approval.', 'warning', v_replacement.user_id, null, 'schedule', jsonb_build_object('shift_swap_id', v_swap.id, 'shift_id', v_shift.id), 'shift_swap_requested:' || v_swap.id::text); end if;
  return v_swap;
end;
$function$;

CREATE OR REPLACE FUNCTION "public"."review_shift_swap"(p_client_request_id uuid, p_swap_id uuid, p_expected_status text, p_decision text, p_review_notes text DEFAULT NULL::text)
 RETURNS shift_swaps
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_actor uuid := auth.uid(); v_swap public.shift_swaps%rowtype; v_orig_shift public.shifts%rowtype; v_notes text := nullif(trim(coalesce(p_review_notes, '')), ''); v_original_user uuid; v_replacement_user uuid;
begin
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  select sw.* into v_swap from public.shift_swaps sw where sw.id = p_swap_id for update;
  if not found then raise exception 'Shift swap request not found'; end if;
  if not public.is_admin_for_org(v_swap.organization_id) then raise exception 'Not authorised to review shift swaps for this organization'; end if;
  if v_swap.status <> p_expected_status then raise exception 'Shift swap changed from expected status % to %', p_expected_status, v_swap.status; end if;
  if p_decision not in ('approved', 'declined') then raise exception 'Decision must be approved or declined'; end if;
  select coalesce(sp.user_id, sp.id) into v_original_user from public.staff_profiles sp where sp.id = v_swap.original_staff_id;
  select coalesce(sp.user_id, sp.id) into v_replacement_user from public.staff_profiles sp where sp.id = v_swap.swap_with_staff_id;
  if p_decision = 'approved' then
    if v_swap.swap_with_staff_id is null then raise exception 'Cannot approve swap without designated replacement staff'; end if;
    select sh.* into v_orig_shift from public.shifts sh where sh.id = v_swap.original_shift_id;
    if found then update public.shifts set officer_user_id = v_swap.swap_with_staff_id, updated_at = now() where id = v_orig_shift.id; if v_orig_shift.roster_slot_id is not null then update public.roster_slots set staff_id = v_swap.swap_with_staff_id, updated_at = now() where id = v_orig_shift.roster_slot_id; end if; end if;
    update public.shift_swaps set status = 'approved', approved_by = v_actor, approved_at = now(), completed_at = now() where id = v_swap.id returning * into v_swap;
  else
    update public.shift_swaps set status = 'declined', declined_reason = v_notes, approved_by = v_actor, approved_at = now() where id = v_swap.id returning * into v_swap;
  end if;
  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata) values (v_swap.organization_id, v_actor, 'shift_swap_reviewed', 'shift_swaps', v_swap.id, jsonb_build_object('decision', p_decision, 'original_shift_id', v_swap.original_shift_id, 'swap_with_staff_id', v_swap.swap_with_staff_id, 'client_request_id', p_client_request_id));
  if v_original_user is not null then perform public.enqueue_notification(v_swap.organization_id, 'roster', 'Shift swap ' || p_decision, coalesce(v_notes, 'Your shift swap request has been ' || p_decision || '.'), 'info', v_original_user, null, 'schedule', jsonb_build_object('shift_swap_id', v_swap.id, 'status', v_swap.status), 'shift_swap_decision:' || v_swap.id::text || ':original:' || v_swap.status); end if;
  if v_replacement_user is not null and v_replacement_user is distinct from v_original_user then perform public.enqueue_notification(v_swap.organization_id, 'roster', 'Direct shift swap ' || p_decision, coalesce(v_notes, 'The direct shift swap has been ' || p_decision || '.'), 'info', v_replacement_user, null, 'schedule', jsonb_build_object('shift_swap_id', v_swap.id, 'status', v_swap.status), 'shift_swap_decision:' || v_swap.id::text || ':replacement:' || v_swap.status); end if;
  return v_swap;
end;
$function$;

CREATE OR REPLACE FUNCTION "public"."get_officer_timesheet_work"(p_period_start date, p_period_end date)
 RETURNS TABLE(source_type text, source_id uuid, work_status text, started_at timestamp with time zone, ended_at timestamp with time zone, calculated_minutes integer, label text, metadata jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_period_start timestamptz := p_period_start::timestamptz;
  v_period_end timestamptz := (p_period_end + 1)::timestamptz;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if p_period_start is null or p_period_end is null or p_period_start > p_period_end then raise exception 'Invalid timesheet period'; end if;
  select p.organization_id into v_org_id from public.user_profiles p where p.id = v_user_id and p.deactivated_at is null;
  if v_org_id is null then raise exception 'Active staff profile required'; end if;

  return query
  with shift_work(source_type, id, work_status, started_at, ended_at, label, metadata) as (
    select 'shift'::text, s.id, 'completed'::text,
      greatest(s.actual_start, v_period_start), least(s.actual_end, v_period_end),
      coalesce(s.service_type, 'shift'),
      jsonb_build_object('shift_id', s.id, 'service_type', s.service_type, 'status', s.status, 'scheduled_start', s.scheduled_start, 'scheduled_end', s.scheduled_end, 'actual_start', s.actual_start, 'actual_end', s.actual_end)
    from public.shifts s
    where s.organization_id = v_org_id and s.officer_user_id = v_user_id
      and s.status = 'completed' and s.actual_start is not null and s.actual_end is not null
      and s.actual_end > v_period_start and s.actual_start < v_period_end
  ), job_work(source_type, id, work_status, started_at, ended_at, label, metadata) as (
    select 'dispatch_job'::text, d.id, 'completed'::text,
      greatest(coalesce(d.on_scene_at, d.en_route_at, d.acknowledged_at, d.dispatched_at, d.created_at), v_period_start),
      least(d.completed_at, v_period_end), coalesce(d.job_type, 'Dispatch job'),
      jsonb_build_object('dispatch_job_id', d.id, 'job_type', d.job_type, 'status', d.status, 'shift_id', d.shift_id, 'shift_stop_id', d.shift_stop_id, 'dispatched_at', d.dispatched_at, 'on_scene_at', d.on_scene_at, 'completed_at', d.completed_at)
    from public.dispatch_jobs d
    left join public.shifts s on s.id = d.shift_id and s.officer_user_id = v_user_id
    where d.organization_id = v_org_id
      and (s.id is not null or d.dispatch_resource_id in (select dr.id from public.dispatch_resources dr where dr.assigned_officer_id = v_user_id))
      and d.status = 'completed' and d.completed_at is not null and d.shift_id is null
      and d.completed_at > v_period_start
      and coalesce(d.on_scene_at, d.en_route_at, d.acknowledged_at, d.dispatched_at, d.created_at) < v_period_end
  ), sources as (
    select * from shift_work union all select * from job_work
  ), bounded as (
    select *, greatest(0, floor(extract(epoch from (ended_at - started_at)) / 60))::integer as minutes
    from sources where ended_at > started_at
  )
  select source_type, id, work_status, started_at, ended_at, minutes, label,
    metadata || jsonb_build_object('calculated_minutes', minutes)
  from bounded order by started_at, source_type, id;
end;
$function$;

CREATE OR REPLACE FUNCTION "public"."wf_pickup_run"(_job_id uuid, _runner_id text)
 RETURNS wf_runs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _job public.wf_jobs%rowtype;
  _run public.wf_runs%rowtype;
  _lease_token text := encode(extensions.gen_random_bytes(32), 'hex');
  _now timestamptz := now();
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO _job
  FROM public.wf_jobs
  WHERE id = _job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found: %', _job_id;
  END IF;

  UPDATE public.wf_runs
  SET status = 'failed', finished_at = _now, result_summary = jsonb_build_object('reason', 'lease expired')
  WHERE job_id = _job_id
    AND status = 'picked_up'
    AND lease_expires_at IS NOT NULL
    AND lease_expires_at <= _now;

  IF EXISTS (
    SELECT 1 FROM public.wf_runs
    WHERE job_id = _job_id AND status = 'picked_up' AND lease_expires_at > _now
  ) THEN
    RAISE EXCEPTION 'Job already has an active worker lease';
  END IF;

  INSERT INTO public.wf_runs (
    job_id, runner_id, status, picked_up_at, lease_token, lease_expires_at, heartbeat_at
  ) VALUES (
    _job_id, _runner_id, 'picked_up', _now, _lease_token, _now + interval '15 minutes', _now
  )
  RETURNING * INTO _run;

  PERFORM public.wf_transition_job_state(
    _job_id, 'running', concat('runner pickup ', _runner_id), 'runner'
  );

  RETURN _run;
END;
$function$;

CREATE OR REPLACE FUNCTION "public"."wf_service_pickup_run"(_job_id uuid, _runner_id text)
 RETURNS wf_runs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _job public.wf_jobs%rowtype;
  _run public.wf_runs%rowtype;
  _lease_token text := encode(extensions.gen_random_bytes(32), 'hex');
  _now timestamptz := now();
  _bob uuid := '00000000-0000-0000-0000-00000000b0b0';
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;
  IF _runner_id IS NULL OR btrim(_runner_id) = '' THEN
    RAISE EXCEPTION 'runner_id is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_profiles WHERE id = _bob) THEN
    RAISE EXCEPTION 'Bob system actor is not configured';
  END IF;

  SELECT * INTO _job FROM public.wf_jobs WHERE id = _job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job not found: %', _job_id; END IF;
  IF _job.state <> 'ratified' THEN
    RAISE EXCEPTION 'Job is not ratified for execution';
  END IF;

  UPDATE public.wf_runs
  SET status = 'failed', finished_at = _now, result_summary = jsonb_build_object('reason', 'lease expired')
  WHERE job_id = _job_id AND status = 'picked_up'
    AND lease_expires_at IS NOT NULL AND lease_expires_at <= _now;

  IF EXISTS (SELECT 1 FROM public.wf_runs WHERE job_id = _job_id AND status = 'picked_up' AND lease_token IS NOT NULL) THEN
    RAISE EXCEPTION 'Job already has an active worker lease';
  END IF;

  INSERT INTO public.wf_runs (job_id, runner_id, status, picked_up_at, lease_token, lease_expires_at, heartbeat_at)
  VALUES (_job_id, _runner_id, 'picked_up', _now, _lease_token, _now + interval '15 minutes', _now)
  RETURNING * INTO _run;

  UPDATE public.wf_jobs SET state = 'running', updated_at = _now WHERE id = _job_id;
  INSERT INTO public.wf_state_events (job_id, from_state, to_state, reason, actor_user_id, actor_type)
  VALUES (_job_id, 'ratified', 'running', concat('service runner pickup ', _runner_id), _bob, 'system');
  RETURN _run;
END;
$function$;

CREATE OR REPLACE FUNCTION "public"."compare_boundaries_hausdorff"(p_geojson_a text, p_geojson_b text)
 RETURNS double precision
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  geom_a geometry;
  geom_b geometry;
  dist double precision;
BEGIN
  -- Null/empty guard: return large sentinel (mismatch), never 0.
  IF p_geojson_a IS NULL OR p_geojson_b IS NULL
     OR trim(p_geojson_a) = '' OR trim(p_geojson_b) = '' THEN
    RETURN 1e9;
  END IF;

  BEGIN
    geom_a := ST_MakeValid(ST_GeomFromGeoJSON(p_geojson_a));
    geom_b := ST_MakeValid(ST_GeomFromGeoJSON(p_geojson_b));
  EXCEPTION WHEN OTHERS THEN
    -- Invalid GeoJSON: return large sentinel (mismatch), never 0.
    RETURN 1e9;
  END;

  -- Empty geometry guard
  IF geom_a IS NULL OR geom_b IS NULL
     OR ST_IsEmpty(geom_a) OR ST_IsEmpty(geom_b) THEN
    RETURN 1e9;
  END IF;

  -- ST_HausdorffDistance on geography returns metres.
  dist := ST_HausdorffDistance(ST_Transform(ST_SetSRID(geom_a, 4326), 2193), ST_Transform(ST_SetSRID(geom_b, 4326), 2193));

  -- Defensive: if the result is NULL or non-finite, return sentinel.
  IF dist IS NULL OR dist = 'NaN'::double precision
     OR dist = 'Infinity'::double precision THEN
    RETURN 1e9;
  END IF;

  RETURN dist;
END;
$function$;

CREATE OR REPLACE FUNCTION "public"."propose_boundary"(p_organization_id uuid, p_entity_type text, p_entity_id uuid, p_geojson jsonb, p_source text, p_source_ref jsonb DEFAULT '{}'::jsonb, p_address_candidate jsonb DEFAULT NULL::jsonb, p_zone_type text DEFAULT NULL::text, p_proposed_via text DEFAULT 'workbench'::text)
 RETURNS TABLE(proposal_id uuid, area_m2 numeric, gate_ok boolean, gate_reason text, drift_from_current_m double precision, current_has_boundary boolean, proposed_geojson jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_geom geometry;
  v_area numeric;
  v_gate record;
  v_current geometry;
  v_drift double precision;
  v_zone_type text := p_zone_type;
  v_row public.boundary_proposals%rowtype;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF NOT public.is_admin_for_org(p_organization_id) AND NOT public.org_access_allowed(p_organization_id) THEN
    RAISE EXCEPTION 'Organization access denied';
  END IF;
  IF p_entity_type NOT IN ('client_site','location_zone','organization','patrol_checkpoint') THEN
    RAISE EXCEPTION 'Unsupported entity_type %', p_entity_type;
  END IF;

  v_geom := ST_Multi(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(p_geojson::text), 4326)));
  IF v_geom IS NULL OR ST_IsEmpty(v_geom) OR NOT ST_IsValid(v_geom) THEN
    RAISE EXCEPTION 'Proposed geometry is empty or invalid';
  END IF;
  IF GeometryType(v_geom) <> 'MULTIPOLYGON' THEN
    RAISE EXCEPTION 'Proposed geometry must be a polygon, got %', GeometryType(v_geom);
  END IF;
  v_area := ST_Area(v_geom::geography);

  IF p_entity_id IS NOT NULL THEN
    IF p_entity_type = 'client_site' THEN
      SELECT boundary INTO v_current FROM public.client_sites WHERE id = p_entity_id;
      v_zone_type := coalesce(v_zone_type, 'site');
    ELSIF p_entity_type = 'location_zone' THEN
      SELECT boundary, coalesce(v_zone_type, zone_type) INTO v_current, v_zone_type FROM public.location_zones WHERE id = p_entity_id;
    ELSIF p_entity_type = 'organization' THEN
      SELECT jurisdiction_geom INTO v_current FROM public.organizations WHERE id = p_entity_id;
      v_zone_type := coalesce(v_zone_type, 'jurisdiction');
    END IF;
    IF v_current IS NOT NULL THEN
      v_drift := ST_HausdorffDistance(ST_Transform(ST_SetSRID(v_current::geometry, 4326), 2193), ST_Transform(ST_SetSRID(v_geom::geometry, 4326), 2193));
    END IF;
  ELSE
    v_zone_type := coalesce(v_zone_type, CASE p_entity_type WHEN 'client_site' THEN 'site' WHEN 'organization' THEN 'jurisdiction' END);
  END IF;

  SELECT * INTO v_gate FROM public.geofence_area_gate(v_area, v_zone_type);

  -- Any older open proposal for the same entity is superseded by this one.
  IF p_entity_id IS NOT NULL THEN
    UPDATE public.boundary_proposals SET status = 'superseded', decided_at = clock_timestamp()
    WHERE entity_type = p_entity_type AND entity_id = p_entity_id AND status = 'proposed';
  END IF;

  INSERT INTO public.boundary_proposals (
    organization_id, entity_type, entity_id, proposed_boundary, center_point, area_m2,
    source, source_ref, address_candidate, zone_type, gate_ok, gate_reason,
    drift_from_current_m, proposed_by, proposed_via
  ) VALUES (
    p_organization_id, p_entity_type, p_entity_id, v_geom, ST_Centroid(v_geom), v_area,
    p_source, coalesce(p_source_ref, '{}'::jsonb), p_address_candidate, v_zone_type, v_gate.ok, v_gate.reason,
    v_drift, v_actor, CASE WHEN p_proposed_via IN ('workbench','batch','bob') THEN p_proposed_via ELSE 'workbench' END
  ) RETURNING * INTO v_row;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (p_organization_id, v_actor, 'boundary_proposed', 'boundary_proposals', v_row.id,
    jsonb_build_object('entity_type', p_entity_type, 'entity_id', p_entity_id, 'source', p_source,
      'area_m2', round(v_area), 'gate_ok', v_gate.ok, 'gate_reason', v_gate.reason, 'drift_m', v_drift));

  RETURN QUERY SELECT v_row.id, v_area, v_gate.ok, v_gate.reason, v_drift, v_current IS NOT NULL, ST_AsGeoJSON(v_geom)::jsonb;
END;
$function$;

CREATE OR REPLACE FUNCTION "public"."accept_quote"(p_quote_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_quote            public.quotes%rowtype;
  v_role             text;
  v_caller_org       uuid;
  v_employer_org     uuid;
  v_agreement_id     uuid;
  v_base_rate        numeric;
  v_callout_rate     numeric;
  v_travel_rate      numeric;
  v_site             record;
  v_site_rate        numeric;
begin
  select * into v_quote from public.quotes where id = p_quote_id;
  if not found then
    raise exception 'accept_quote: quote % not found', p_quote_id;
  end if;

  select role, organization_id, employer_organization_id into v_role, v_caller_org, v_employer_org
  from public.user_profiles where id = auth.uid();

  if not (
    public.is_grand_master()
    or (
      v_role in ('master','admin','admin_officer')
      and v_quote.provider_org_id = any(public.get_descendant_organizations(coalesce(v_employer_org, v_caller_org)))
    )
  ) then
    raise exception 'accept_quote: not authorised to accept quotes for this provider';
  end if;

  if v_quote.status = 'accepted' and v_quote.service_agreement_id is not null then
    return v_quote.service_agreement_id;
  end if;

  if v_quote.status not in ('draft','sent') then
    raise exception 'accept_quote: quote status % cannot be accepted', v_quote.status;
  end if;
  if v_quote.client_org_id is null then
    raise exception 'accept_quote: quote has no client organisation; a service agreement requires a real client (set client_org_id before accepting)';
  end if;

  v_agreement_id := v_quote.service_agreement_id;

  if v_agreement_id is null then
    select id into v_agreement_id
    from public.service_agreements
    where provider_organization_id = v_quote.provider_org_id
      and client_organization_id  = v_quote.client_org_id
      and name = v_quote.title
    limit 1;
  end if;

  if v_agreement_id is null then
    insert into public.service_agreements (provider_organization_id, client_organization_id, name, starts_on, agreement_type, invitation_status)
    values (v_quote.provider_org_id, v_quote.client_org_id, v_quote.title, current_date, 'operational', 'accepted')
    returning id into v_agreement_id;
  else
    update public.service_agreements
    set agreement_type = 'operational',
        invitation_status = 'accepted'
    where id = v_agreement_id;
  end if;

  select avg(unit_charge) into v_base_rate
  from public.quote_lines where quote_id = p_quote_id and kind in ('labour','module') and unit_charge > 0;

  select avg(unit_charge) into v_travel_rate
  from public.quote_lines where quote_id = p_quote_id and kind = 'travel' and unit_charge > 0;

  select avg(unit_charge) into v_callout_rate
  from public.quote_lines where quote_id = p_quote_id and kind in ('platform_fee','custom')
    and unit_charge > 0 and lower(description) like '%callout%';

  if exists (select 1 from public.crm_commercial_settings where service_agreement_id = v_agreement_id) then
    update public.crm_commercial_settings set
      currency            = v_quote.currency,
      base_rate_per_hour  = coalesce(v_base_rate, base_rate_per_hour),
      callout_rate_per_hour = coalesce(v_callout_rate, callout_rate_per_hour),
      travel_rate_per_km  = coalesce(v_travel_rate, travel_rate_per_km)
    where service_agreement_id = v_agreement_id;
  else
    insert into public.crm_commercial_settings
      (service_agreement_id, currency, base_rate_per_hour, callout_rate_per_hour, travel_rate_per_km)
    values
      (v_agreement_id, v_quote.currency, v_base_rate, v_callout_rate, v_travel_rate);
  end if;

  for v_site in
    select distinct site_id from public.quote_lines
    where quote_id = p_quote_id and site_id is not null
  loop
    select avg(unit_charge) into v_site_rate
    from public.quote_lines
    where quote_id = p_quote_id and site_id = v_site.site_id and kind in ('labour','module') and unit_charge > 0;
    v_site_rate := coalesce(v_site_rate, v_base_rate);

    if exists (
      select 1 from public.site_financial_config
      where site_id = v_site.site_id and service_agreement_id = v_agreement_id
    ) then
      update public.site_financial_config set
        billing_model = 'hourly',
        hourly_rate   = coalesce(v_site_rate, hourly_rate),
        updated_at    = now()
      where site_id = v_site.site_id and service_agreement_id = v_agreement_id;
    else
      insert into public.site_financial_config
        (organization_id, site_id, service_agreement_id, billing_model, hourly_rate)
      values
        (v_quote.provider_org_id, v_site.site_id, v_agreement_id, 'hourly', v_site_rate);
    end if;
  end loop;

  update public.quotes set
    status               = 'accepted',
    accepted_at          = now(),
    accepted_by          = auth.uid(),
    service_agreement_id = v_agreement_id,
    updated_by           = auth.uid()
  where id = p_quote_id;

  return v_agreement_id;
end $function$;
COMMENT ON FUNCTION "public"."accept_quote"(p_quote_id uuid) IS 'B5 (#2): accept a Layer 2 quote -> create/link a service_agreement, write crm_commercial_settings + per-site site_financial_config from the quote lines, stamp the quote accepted. Atomic, security-definer, authz = grand_master or provider admin/master. Idempotent; requires a real client_org_id.';
REVOKE ALL ON FUNCTION "public"."accept_quote"(p_quote_id uuid) FROM PUBLIC, "anon", "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION "public"."accept_quote"(p_quote_id uuid) TO "postgres";
GRANT EXECUTE ON FUNCTION "public"."accept_quote"(p_quote_id uuid) TO "service_role";

CREATE OR REPLACE FUNCTION "public"."acknowledge_operational_continuity_item"(p_client_request_id uuid, p_continuity_item_id uuid, p_acknowledgement_notes text DEFAULT NULL::text, p_continuation_location_event_id uuid DEFAULT NULL::uuid)
 RETURNS operational_continuity_receipts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_actor uuid:=auth.uid(); v_item public.operational_continuity_items%rowtype; v_receipt public.operational_continuity_receipts%rowtype;
begin
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  select * into v_receipt from public.operational_continuity_receipts where recipient_organization_id = (select recipient_organization_id from public.operational_continuity_items where id = p_continuity_item_id) and client_request_id = p_client_request_id;
  if found then return v_receipt; end if;
  select * into v_item from public.operational_continuity_items where id=p_continuity_item_id for update;
  if not found or not public.is_admin_for_org(v_item.recipient_organization_id) then raise exception 'Continuity item not available to your organization'; end if;
  insert into public.operational_continuity_receipts(continuity_item_id,recipient_organization_id,acknowledged_by,continuation_location_event_id,acknowledgement_notes,client_request_id)
  values(v_item.id,v_item.recipient_organization_id,v_actor,p_continuation_location_event_id,nullif(trim(coalesce(p_acknowledgement_notes,'')),''),p_client_request_id)
  returning * into v_receipt;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_item.recipient_organization_id,v_actor,'operational_continuity_acknowledged','operational_continuity_receipts',v_receipt.id,jsonb_build_object('continuity_item_id',v_item.id,'source_organization_id',v_item.source_organization_id));
  return v_receipt;
end; $function$;
REVOKE ALL ON FUNCTION "public"."acknowledge_operational_continuity_item"(p_client_request_id uuid, p_continuity_item_id uuid, p_acknowledgement_notes text, p_continuation_location_event_id uuid) FROM PUBLIC, "anon", "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION "public"."acknowledge_operational_continuity_item"(p_client_request_id uuid, p_continuity_item_id uuid, p_acknowledgement_notes text, p_continuation_location_event_id uuid) TO "postgres";
GRANT EXECUTE ON FUNCTION "public"."acknowledge_operational_continuity_item"(p_client_request_id uuid, p_continuity_item_id uuid, p_acknowledgement_notes text, p_continuation_location_event_id uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."acknowledge_operational_continuity_item"(p_client_request_id uuid, p_continuity_item_id uuid, p_acknowledgement_notes text, p_continuation_location_event_id uuid) TO "service_role";

CREATE OR REPLACE FUNCTION "public"."acknowledge_roster_attendance_exception"(p_shift_id uuid, p_exception_type text, p_notes text)
 RETURNS TABLE(shift_id uuid, acknowledged_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_actor uuid := auth.uid(); v_shift public.shifts%rowtype; v_user uuid; v_at timestamptz := clock_timestamp(); v_notes text := nullif(trim(coalesce(p_notes, '')), '');
begin
  if v_notes is null then raise exception 'Attendance exception notes are required'; end if;
  if p_exception_type not in ('late_start', 'active_overrun') then raise exception 'Unsupported attendance exception type'; end if;
  select s.* into v_shift from public.shifts s where s.id = p_shift_id for update;
  if not found then raise exception 'Shift not found'; end if;
  if not public.is_admin_for_org(v_shift.organization_id) then raise exception 'Roster administrator required'; end if;
  select coalesce(sp.user_id, sp.id) into v_user from public.staff_profiles sp where sp.id = (select rs.staff_id from public.roster_slots rs where rs.linked_shift_id = v_shift.id limit 1);
  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata) values (v_shift.organization_id, v_actor, 'roster_attendance_exception_acknowledged', 'shifts', v_shift.id, jsonb_build_object('exception_type', p_exception_type, 'notes', v_notes, 'acknowledged_at', v_at));
  if v_user is not null then perform public.enqueue_notification(p_organization_id => v_shift.organization_id, p_category => 'roster', p_title => 'Attendance exception acknowledged', p_body => v_notes, p_severity => 'warning', p_recipient_user_id => v_user, p_link_page => 'schedule', p_link_payload => jsonb_build_object('shift_id', v_shift.id, 'exception_type', p_exception_type), p_dedup_key => 'attendance_exception_ack:' || v_shift.id::text || ':' || p_exception_type || ':' || v_at::text); end if;
  return query select v_shift.id, v_at;
end;
$function$;

CREATE OR REPLACE FUNCTION "public"."calculate_cost_centre_roll"(p_pl_period_id uuid)
 RETURNS SETOF finance_cost_centre_rolls
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_org uuid;
  v_period public.finance_pl_periods%rowtype;
BEGIN
  SELECT organization_id INTO v_org FROM public.user_profiles WHERE id = v_actor AND deactivated_at IS NULL;
  IF v_org IS NULL OR NOT public.is_admin_for_org(v_org) THEN RAISE EXCEPTION 'Active finance administrator required'; END IF;
  SELECT * INTO v_period FROM public.finance_pl_periods WHERE id = p_pl_period_id AND organization_id = v_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'P&L period not found in organization'; END IF;
  RETURN QUERY
  INSERT INTO public.finance_cost_centre_rolls(organization_id, pl_period_id, cost_centre_id, cost_centre_code, cost_centre_name, total_labour, total_vehicle, total_materials, total_equipment, total_overhead, total_depreciation, total_cost, attribution_count)
  SELECT v_org, p_pl_period_id, cc.id, cc.code, cc.name,
    COALESCE(SUM(CASE WHEN fsc.cost_type = 'labour' THEN fsc.total_cost ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN fsc.cost_type = 'vehicle' THEN fsc.total_cost ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN fsc.cost_type = 'materials' THEN fsc.total_cost ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN fsc.cost_type = 'equipment' THEN fsc.total_cost ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN fsc.cost_type = 'overhead' THEN fsc.total_cost ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN fsc.cost_type = 'depreciation' THEN fsc.total_cost ELSE 0 END), 0),
    COALESCE(SUM(fsc.total_cost), 0), COUNT(fsc.id)
  FROM public.cost_centres cc LEFT JOIN public.finance_service_costs fsc ON cc.id = fsc.cost_centre_id AND fsc.pl_period_id = p_pl_period_id AND fsc.organization_id = v_org
  WHERE cc.organization_id = v_org GROUP BY cc.id, cc.code, cc.name
  RETURNING *;
END;
$function$;
