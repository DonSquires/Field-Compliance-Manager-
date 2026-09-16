-- Behavioural truth table: every RPC the static sweep flagged now runs when a real call reaches
-- the statement that used to fail. Runs in a transaction and rolls back.
begin;
set local role postgres;
set local search_path to public, extensions, pg_catalog;

create or replace function pg_temp.as_user(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  set local role authenticated;
end $$;
create or replace function pg_temp.as_admin() returns void language plpgsql as $$
begin set local role postgres; end $$;
create or replace function pg_temp.as_service() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  set local role service_role;
end $$;
create or replace function pg_temp.check(p_label text, p_ok boolean) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL [%]', p_label; end if;
  raise notice 'ok   [%]', p_label;
end $$;

do $$
declare
  v_provider uuid := gen_random_uuid();
  v_client uuid := gen_random_uuid();
  v_master uuid := gen_random_uuid();
  v_officer uuid := gen_random_uuid();
  v_officer2 uuid := gen_random_uuid();
  -- staff_profiles.id is FK-bound to user_profiles.id: the staff id is the user id.
  v_staff uuid;
  v_staff2 uuid;
  v_site uuid := gen_random_uuid();
  v_zone uuid := gen_random_uuid();
  v_agreement uuid := gen_random_uuid();
  v_shift uuid := gen_random_uuid();
  v_future_shift uuid := gen_random_uuid();
  v_debrief uuid := gen_random_uuid();
  v_followup uuid := gen_random_uuid();
  v_noise uuid := gen_random_uuid();
  v_vehicle uuid := gen_random_uuid();
  v_workplace uuid := gen_random_uuid();
  v_unit uuid := gen_random_uuid();
  v_wf_job uuid := gen_random_uuid();
  v_pl_period uuid := gen_random_uuid();
  v_res record; v_json jsonb; v_n int; v_num numeric; v_ok boolean; v_err text; v_swap record; v_sheet record;
begin
  v_staff := v_officer; v_staff2 := v_officer2;
  -- Fixtures -------------------------------------------------------------------------------
  insert into public.organizations (id, name, organization_type, parent_organization_id, active, status)
  values (v_provider, 'Oracle Provider Ltd', 'service_provider', null, true, 'active'),
         (v_client, 'Oracle Council', 'government', null, true, 'active');
  insert into public.user_profiles (id, role, organization_id, employer_organization_id, display_name)
  values (v_master, 'master', v_provider, v_provider, 'Oracle Master'),
         (v_officer, 'officer', v_provider, v_provider, 'Oracle Officer'),
         (v_officer2, 'officer', v_provider, v_provider, 'Oracle Officer Two');
  insert into public.staff_profiles (id, organization_id, user_id, work_ready, overtime_eligible, seniority_date, role_code)
  values (v_staff, v_provider, v_officer, true, true, current_date - 900, 'guard'),
         (v_staff2, v_provider, v_officer2, true, true, current_date - 30, 'guard');
  insert into public.service_agreements (id, provider_organization_id, client_organization_id, name, agreement_type, starts_on, invitation_status)
  values (v_agreement, v_provider, v_client, 'Oracle Provider serves Oracle Council', 'operational', current_date, 'accepted');
  insert into public.client_sites (id, client_organization_id, organization_id, name, address, center_point, boundary, gps_lat, gps_lng, active)
  values (v_site, v_client, v_provider, 'Oracle Depot', '1 Oracle Way', st_setsrid(st_makepoint(173.2840, -41.2706), 4326),
          st_setsrid(st_geomfromtext('POLYGON((173.279 -41.271, 173.281 -41.271, 173.281 -41.269, 173.279 -41.269, 173.279 -41.271))'), 4326), -41.2706, 173.2840, true);
  insert into public.location_zones (id, organization_id, name, boundary)
  values (v_zone, v_provider, 'Oracle Zone', st_multi(st_setsrid(st_geomfromtext('POLYGON((173.27 -41.28, 173.30 -41.28, 173.30 -41.26, 173.27 -41.26, 173.27 -41.28))'), 4326)));
  insert into public.zone_closures (organization_id, zone_id, closure_type, status, effective_from, reason)
  values (v_provider, v_zone, 'temporary_closure', 'active', current_date, 'oracle');
  insert into public.shifts (id, organization_id, officer_user_id, service_type, scheduled_start, scheduled_end, actual_start, actual_end, status)
  values (v_shift, v_provider, v_officer, 'patrol', now() - interval '9 hours', now() - interval '1 hour', now() - interval '9 hours', now() - interval '1 hour', 'completed'),
         (v_future_shift, v_provider, v_officer, 'patrol', now() + interval '2 days', now() + interval '2 days 8 hours', null, null, 'published');
  insert into public.canonical_vehicles (id, plate_number) values (v_vehicle, 'ORC123');
  insert into public.entity_flags (organization_id, entity_type, entity_id, flag_type, alert_level, reason, active)
  values (v_provider, 'vehicle', v_vehicle, 'voi', 'high', 'oracle: seen at multiple incidents', true);
  insert into public.shift_debriefs (organization_id, shift_id, officer_user_id, client_event_id, summary)
  values (v_provider, v_shift, v_officer, gen_random_uuid(), 'Oracle debrief: quiet patrol, one vehicle of interest noted') returning id into v_debrief;
  insert into public.debrief_followups (id, organization_id, debrief_id, shift_id, officer_user_id, status)
  values (v_followup, v_provider, v_debrief, v_shift, v_officer, 'open');
  insert into public.noise_assessments (id, organization_id, officer_user_id, review_status) values (v_noise, v_provider, v_officer, 'open');
  insert into public.organization_workplaces (id, organization_id, name) values (v_workplace, v_provider, 'Oracle base');
  insert into public.roster_work_units (id, organization_id, name, work_unit_type, service_type, workplace_id, active)
  values (v_unit, v_provider, 'Oracle patrol unit', 'internal', 'patrol', v_workplace, true);
  insert into public.roster_slots (organization_id, work_unit_id, scheduled_start, scheduled_end, client_request_id, status)
  values (v_provider, v_unit, now() + interval '4 days', now() + interval '4 days 8 hours', gen_random_uuid(), 'draft');
  insert into auth.users (id, instance_id, aud, role, email) values
    (v_master, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'oracle-master@example.test'),
    ('00000000-0000-0000-0000-00000000b0b0', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'oracle-bob@example.test');
  insert into public.user_profiles (id, role, organization_id, employer_organization_id, display_name)
  values ('00000000-0000-0000-0000-00000000b0b0', 'officer', v_provider, v_provider, 'Bob (system actor)') on conflict (id) do nothing;
  insert into public.wf_jobs (id, title, created_by, state) values (v_wf_job, 'Oracle workflow job', v_master, 'ratified');
  insert into public.finance_pl_periods (id, organization_id, name, period_start, period_end) values (v_pl_period, v_provider, 'Oracle period', date_trunc('month', current_date)::date, (date_trunc('month', current_date) + interval '1 month - 1 day')::date);
  insert into public.cost_centres (organization_id, code, name) values (v_provider, 'ORC-PATROL', 'Oracle patrol'), (v_provider, 'ORC-NOISE', 'Oracle noise');

  -- 1. Mobile push registration ---------------------------------------------------------------
  perform pg_temp.as_user(v_officer);
  select * into v_res from public.register_officer_device_token('ExponentPushToken[oracle-1]', 'expo', 'Oracle phone', '1.0.0');
  perform pg_temp.check('register_officer_device_token runs on first use', v_res.push_token = 'ExponentPushToken[oracle-1]' and v_res.is_active);
  select * into v_res from public.register_officer_device_token('ExponentPushToken[oracle-1]', 'expo', 'Oracle phone', '1.0.1');
  perform pg_temp.check('re-registering the same token upserts (on conflict path)', v_res.push_token = 'ExponentPushToken[oracle-1]');

  -- 2. Mobile offline package ---------------------------------------------------------------------
  v_json := public.get_officer_data_package(v_shift);
  perform pg_temp.check('offline package builds and carries the vehicle flag with its plate',
    (v_json->'entity_flags')::jsonb @> '[{"plate_number":"ORC123","flag_type":"voi","severity":"high"}]'::jsonb);

  -- 3. Zone / closure lookup ------------------------------------------------------------------------
  perform pg_temp.as_admin();
  select count(*) into v_n from public.closure_at_point(-41.27, 173.28, v_provider);
  perform pg_temp.check('closure_at_point finds the active closure', v_n = 1);
  -- get_zone_for_gps was dropped by 20260915170000 (duplicate of resolve_context); resolve_context is
  -- proven in supabase/tests/20260915170000_place_model_convergence.sql.

  -- 4. Bob roster fill candidates ---------------------------------------------------------------------
  perform pg_temp.as_user(v_master);
  select count(*) into v_n from public.get_bob_roster_fill_candidates(v_provider, now(), now() + interval '7 days');
  perform pg_temp.check('get_bob_roster_fill_candidates scores the open slot for work-ready staff', v_n = 2);
  perform pg_temp.check('seniority lowers the score without extract()', (select bool_and(c.score between 90 and 100) from public.get_bob_roster_fill_candidates(v_provider, now(), now() + interval '7 days') c));

  -- 5. Reviews reaching the previously ambiguous statements (and their notifications) ------------------
  perform pg_temp.as_user(v_master);
  select * into v_res from public.manage_debrief_followup(v_followup, 1, 'escalate', 'Oracle escalation');
  perform pg_temp.check('manage_debrief_followup escalates (owner_user_id coalesce reached)', v_res.followup_status = 'escalated' and v_res.owner_user_id = v_master);
  select * into v_res from public.manage_noise_assessment_review(v_noise, 'open', 'acknowledge', 'Oracle ack');
  perform pg_temp.check('manage_noise_assessment_review acknowledges (follow_up_required case reached)', v_res.review_status = 'acknowledged');
  perform pg_temp.as_admin();
  perform pg_temp.check('debrief_followup and noise_review notifications were accepted by the category check',
    (select count(*) from public.notifications n where n.organization_id = v_provider and n.category in ('debrief_followup', 'noise_review')) = 2);
  perform pg_temp.check('notifications_category_check carries every recorded category',
    (select bool_and(pg_get_constraintdef(c.oid) like '%' || cat || '%') from pg_constraint c, unnest(array['leave_decision','timesheet_decision','breach_decision','debrief_followup','noise_review','video_review','bob_self_memory','roster']) cat where c.conname = 'notifications_category_check'));

  -- 6. Timesheet from work (jsonb loop) --------------------------------------------------------------------
  perform pg_temp.as_user(v_officer);
  perform pg_temp.check('get_officer_timesheet_work returns the completed shift with its minutes (CTE columns named)',
    (select count(*) = 1 and min(w.calculated_minutes) = 480 and min(w.source_type) = 'shift' from public.get_officer_timesheet_work((now() - interval '2 days')::date, current_date) w));
  select * into v_sheet from public.submit_officer_timesheet_from_work(gen_random_uuid(), (now() - interval '2 days')::date, current_date, 0, 'oracle');
  perform pg_temp.check('submit_officer_timesheet_from_work writes the sheet and its work entries', v_sheet.created and v_sheet.source_count = 1 and v_sheet.work_derived_hours = 8.00);
  perform pg_temp.as_admin();
  perform pg_temp.check('work entries were inserted from the jsonb loop', (select count(*) from public.timesheet_work_entries where timesheet_id = v_sheet.id) >= 1);

  -- 7. Shift swap with a direct replacement (notification enqueue reached) -----------------------------------
  perform pg_temp.as_user(v_officer);
  v_swap := public.request_shift_swap(gen_random_uuid(), v_future_shift, v_staff2, 'direct', 'Oracle: family commitment');
  perform pg_temp.check('request_shift_swap with a replacement notifies without an arity error', v_swap.status = 'pending' and v_swap.swap_with_staff_id = v_staff2);
  perform pg_temp.as_admin();
  perform pg_temp.check('a notification row was queued for the replacement', exists (select 1 from public.notifications n where n.recipient_user_id = v_officer2 and n.category = 'roster'));
  perform pg_temp.as_user(v_master);
  perform public.review_shift_swap(gen_random_uuid(), v_swap.id, 'pending', 'approved', 'Oracle approved');
  perform pg_temp.as_admin();
  perform pg_temp.check('review_shift_swap notifies both officers', (select count(*) from public.notifications n where n.category = 'roster' and n.dedup_key like 'shift_swap_decision:%') = 2);
  perform pg_temp.check('approval reassigns the shift to the replacement', (select s.officer_user_id from public.shifts s where s.id = v_future_shift) = v_officer2);

  -- 8. Boundary drift (Hausdorff in metres) ----------------------------------------------------------------------
  v_num := public.compare_boundaries_hausdorff(
    '{"type":"Polygon","coordinates":[[[173.280,-41.270],[173.281,-41.270],[173.281,-41.269],[173.280,-41.269],[173.280,-41.270]]]}',
    '{"type":"Polygon","coordinates":[[[173.2801,-41.270],[173.2811,-41.270],[173.2811,-41.269],[173.2801,-41.269],[173.2801,-41.270]]]}');
  perform pg_temp.check('compare_boundaries_hausdorff returns metres for a ~8 m shift', v_num between 5 and 12);

  -- 9. Workflow lease pickup (pgcrypto in extensions) — the live path is the service identity ---------------
  perform pg_temp.as_service();
  select * into v_res from public.wf_service_pickup_run(v_wf_job, 'oracle-runner');
  perform pg_temp.check('wf_service_pickup_run issues a lease token (gen_random_bytes resolved in extensions)', v_res.status = 'picked_up' and length(v_res.lease_token) = 64 and v_res.lease_expires_at > now());
  perform pg_temp.as_admin();
  perform pg_temp.check('the job moved to running with a state event', (select state::text from public.wf_jobs where id = v_wf_job) = 'running' and exists (select 1 from public.wf_state_events e where e.job_id = v_wf_job and e.to_state = 'running'));

  -- 10. Cost-centre roll (RETURN QUERY over INSERT ... RETURNING, no longer STABLE) --------------------------------
  perform pg_temp.as_user(v_master);
  select count(*) into v_n from public.calculate_cost_centre_roll(v_pl_period);
  perform pg_temp.check('calculate_cost_centre_roll returns one roll per cost centre', v_n = 2);
  perform pg_temp.as_admin();
  perform pg_temp.check('the rolls were persisted', (select count(*) from public.finance_cost_centre_rolls r where r.pl_period_id = v_pl_period) = 2);

  -- 11. Columns the governed paths write now exist ------------------------------------------------------------------
  perform pg_temp.check('smoke_assessments.shift_id and shift_stops.officer_instructions exist',
    exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'smoke_assessments' and column_name = 'shift_id')
    and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'shift_stops' and column_name = 'officer_instructions'));
end $$;

rollback;
