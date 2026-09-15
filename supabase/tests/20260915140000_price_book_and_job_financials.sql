-- Behavioural truth table: price book, quote-line kinds, and live financials on dispatch completion.
-- Runs in a transaction and rolls back. Fixtures as postgres; RPCs exercised as `authenticated` with a JWT sub.
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
create or replace function pg_temp.check(p_label text, p_ok boolean) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL [%]', p_label; end if;
  raise notice 'ok   [%]', p_label;
end $$;

do $$
declare
  v_provider uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  v_client uuid := gen_random_uuid();
  v_master uuid := gen_random_uuid();
  v_officer uuid := gen_random_uuid();
  v_other_master uuid := gen_random_uuid();
  v_site uuid := gen_random_uuid();
  v_agreement uuid := gen_random_uuid();
  v_shift uuid := gen_random_uuid();
  v_job uuid := gen_random_uuid();
  v_job2 uuid := gen_random_uuid();
  v_quote uuid := gen_random_uuid();
  v_item jsonb; v_item2 jsonb; v_item_id uuid;
  v_ok boolean; v_err text; v_n int; v_total numeric; v_res record;
begin
  -- Fixtures -----------------------------------------------------------------
  insert into public.organizations (id, name, organization_type, parent_organization_id, active, status)
  values (v_provider, 'Oracle Provider Ltd', 'service_provider', null, true, 'active'),
         (v_other, 'Oracle Other Provider', 'service_provider', null, true, 'active'),
         (v_client, 'Oracle Client Council', 'government', null, true, 'active');
  insert into public.user_profiles (id, role, organization_id, employer_organization_id, display_name)
  values (v_master, 'master', v_provider, v_provider, 'Oracle Master'),
         (v_officer, 'officer', v_provider, v_provider, 'Oracle Officer'),
         (v_other_master, 'master', v_other, v_other, 'Oracle Other Master');
  insert into public.service_agreements (id, provider_organization_id, client_organization_id, name, agreement_type, starts_on, ends_on)
  values (v_agreement, v_provider, v_client, 'Oracle Provider serves Oracle Client', 'operational', current_date, null);
  insert into public.client_sites (id, client_organization_id, organization_id, name, address, center_point, gps_lat, gps_lng, active)
  values (v_site, v_client, v_provider, 'Oracle Depot', '1 Oracle Way', st_setsrid(st_makepoint(173.2840, -41.2706), 4326), -41.2706, 173.2840, true);
  insert into public.shifts (id, organization_id, officer_user_id, service_type, scheduled_start, scheduled_end, status)
  values (v_shift, v_provider, v_officer, 'patrol', now() - interval '3 hours', now() + interval '5 hours', 'in_progress');

  -- Price book ------------------------------------------------------------------
  perform pg_temp.as_user(v_other_master);
  begin
    perform public.manage_finance_item(v_provider, 'create', null, 'POSTCRETE-BAG', 'Post crete bag', 'material', 'ea', 12.00, 15.60, null, 'oracle', current_date);
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm; end;
  perform pg_temp.check('another organisation''s master cannot write my price book: ' || coalesce(v_err, ''), v_ok);

  perform pg_temp.as_user(v_master);
  v_item := public.manage_finance_item(v_provider, 'create', null, 'postcrete-bag', 'Post crete bag', 'material', 'ea', 12.00, 15.60, 'Oracle Supplies', 'oracle sheet', current_date);
  v_item_id := (v_item->>'item_id')::uuid;
  perform pg_temp.check('item created with normalised SKU, current cost and price', v_item->>'sku' = 'POSTCRETE-BAG' and (v_item->>'unit_cost')::numeric = 12.00 and (v_item->>'unit_price')::numeric = 15.60);
  perform pg_temp.check('margin is derived, not typed', (v_item->>'margin_pct')::numeric = round((15.60 - 12.00) / 15.60 * 100, 2));
  v_item2 := public.manage_finance_item(v_provider, 'create', null, 'POSTCRETE-BAG', 'Post crete bag', 'material', 'ea', 12.00, 15.60, null, 'oracle sheet again', current_date);
  perform pg_temp.check('same SKU + same cost/price is idempotent (no new version)', (v_item2->>'item_id')::uuid = v_item_id);
  perform pg_temp.as_admin();
  perform pg_temp.check('exactly one approved cost and one approved price version',
    (select count(*) from public.finance_item_cost_versions where item_id = v_item_id and status = 'approved') = 1
    and (select count(*) from public.finance_item_price_versions where item_id = v_item_id and status = 'approved') = 1);
  perform pg_temp.as_user(v_master);
  v_item2 := public.manage_finance_item(v_provider, 'reprice', v_item_id, null, null, null, null, 12.50, 16.25, null, 'oracle reprice', current_date);
  perform pg_temp.check('reprice shows the new price', (v_item2->>'unit_price')::numeric = 16.25 and (v_item2->>'unit_cost')::numeric = 12.50);
  perform pg_temp.as_admin();
  perform pg_temp.check('previous versions retired, new versions approved',
    (select count(*) from public.finance_item_price_versions where item_id = v_item_id and status = 'retired') = 1
    and (select count(*) from public.finance_item_price_versions where item_id = v_item_id and status = 'approved' and version = 2) = 1
    and (select count(*) from public.finance_item_cost_versions where item_id = v_item_id and status = 'retired') = 1);
  perform pg_temp.check('audit rows for create and reprice',
    (select count(*) from public.audit_log where target_id = v_item_id and action in ('finance_item_created', 'finance_item_repriced')) = 2);

  perform pg_temp.as_user(v_other_master);
  select count(*) into v_n from public.finance_price_book where organization_id = v_provider;
  perform pg_temp.check('price book is not visible to another organisation', v_n = 0);
  perform pg_temp.as_user(v_master);
  select count(*) into v_n from public.finance_price_book where organization_id = v_provider;
  perform pg_temp.check('price book is visible to its own master', v_n = 1);

  -- Quote lines accept materials and equipment ----------------------------------------
  perform pg_temp.as_admin();
  insert into public.quotes (id, provider_org_id, client_org_id, client_name, title, status, target_margin_pct)
  values (v_quote, v_provider, v_client, 'Oracle Client Council', 'Oracle gate install', 'draft', 25)
  on conflict do nothing;
  perform pg_temp.as_user(v_master);
  v_err := null;
  begin
    perform public.add_crm_quote_line(gen_random_uuid(), v_quote, 'draft', 'materials', '[POSTCRETE-BAG] Post crete bag', 4, 12.50, 16.25, null, null);
    v_ok := true;
  exception when others then v_ok := false; v_err := sqlerrm; end;
  perform pg_temp.check('a materials quote line is accepted: ' || coalesce(v_err, 'ok'), v_ok);

  -- Rate rules: customer charge + staff pay + travel ----------------------------------
  perform pg_temp.as_admin();
  insert into public.rate_rules (organization_id, rule_kind, name, rate_type, amount, service_type, job_type, priority, active, effective_from)
  values (v_provider, 'billing', 'Patrolling (per hour)', 'hourly', 54.10, 'patrol', null, 0, true, date '2025-04-01'),
         (v_provider, 'billing', 'Travel, patrol vehicle (per km)', 'per_km', 1.04, null, null, 0, true, date '2025-04-01'),
         (v_provider, 'pay', 'Officer patrol pay (per hour)', 'hourly', 30.00, 'patrol', null, 0, true, date '2025-04-01'),
         (v_provider, 'pay', 'Officer travel (per km)', 'per_km', 0.95, null, null, 0, true, date '2025-04-01');

  -- Job completion writes live financials ----------------------------------------------
  insert into public.dispatch_jobs (id, organization_id, service_agreement_id, client_site_id, job_type, priority, status, shift_id, assigned_officer_id,
                                    dispatched_at, acknowledged_at, en_route_at, on_scene_at, insert_gps_lat, insert_gps_lng)
  values (v_job, v_provider, v_agreement, v_site, 'patrol_support', 'normal', 'on_scene', v_shift, v_officer,
          now() - interval '2 hours', now() - interval '110 minutes', now() - interval '100 minutes', now() - interval '60 minutes', -41.2900, 173.2400);
  perform pg_temp.as_user(v_master);
  select * into v_res from public.advance_dispatch_job_status(v_job, 'on_scene', 'completed', 'Oracle: patrol completed, all secure');
  perform pg_temp.check('job completed by the RPC', v_res.status = 'completed');
  perform pg_temp.as_admin();
  perform pg_temp.check('pay lines written on completion via the shift service-type fallback (labour + travel)',
    (select count(*) from public.dispatch_job_pay_lines where source_dispatch_id = v_job and rate_rule_id is not null) = 2);
  select coalesce(sum(line_total), 0) into v_total from public.dispatch_job_pay_lines where source_dispatch_id = v_job and rate_type = 'hourly';
  perform pg_temp.check('labour pay = worked hours x pay rate (about 1h x $30)', v_total between 29.5 and 30.5);
  perform pg_temp.check('charge lines written on completion (attendance + travel)',
    (select count(*) from public.dispatch_job_charge_lines where source_dispatch_id = v_job and rate_rule_id is not null) = 2);
  select coalesce(sum(line_total), 0) into v_total from public.dispatch_job_charge_lines where source_dispatch_id = v_job and rate_type = 'hourly';
  perform pg_temp.check('attendance charge = worked hours x $54.10', v_total between 53.5 and 54.7);
  perform pg_temp.check('travel charge uses the measured distance x $1.04',
    (select line_total = round(distance_km * 1.04, 2) and distance_km > 0 from public.dispatch_job_charge_lines where source_dispatch_id = v_job and rate_type = 'per_km'));
  perform pg_temp.check('charge lines carry the client and agreement',
    (select bool_and(client_organization_id = v_client and service_agreement_id = v_agreement) from public.dispatch_job_charge_lines where source_dispatch_id = v_job));
  perform pg_temp.check('one audit receipt for the resolution',
    (select count(*) from public.audit_log where target_id = v_job and action = 'dispatch_financials_resolved') = 1);

  -- Manual re-check is a replay, not a duplicate
  perform pg_temp.as_user(v_master);
  select * into v_res from public.resolve_dispatch_job_pay_lines(gen_random_uuid(), v_job, null);
  perform pg_temp.check('manual check replays without duplicating lines', v_res.lines_written = 2 and v_res.unresolved_count = 0);
  perform pg_temp.as_admin();
  perform pg_temp.check('still two pay and two charge lines',
    (select count(*) from public.dispatch_job_pay_lines where source_dispatch_id = v_job) = 2
    and (select count(*) from public.dispatch_job_charge_lines where source_dispatch_id = v_job) = 2);

  -- No matching rule: completion still succeeds; unresolved rows are kept for review
  insert into public.dispatch_jobs (id, organization_id, service_agreement_id, client_site_id, job_type, priority, status, shift_id, assigned_officer_id, dispatched_at, on_scene_at)
  values (v_job2, v_provider, v_agreement, v_site, 'welfare_check', 'high', 'on_scene', null, v_officer, now() - interval '50 minutes', now() - interval '30 minutes');
  perform pg_temp.as_user(v_master);
  select * into v_res from public.advance_dispatch_job_status(v_job2, 'on_scene', 'completed', 'Oracle: false alarm');
  perform pg_temp.check('completion is never blocked by pricing', v_res.status = 'completed');
  perform pg_temp.as_admin();
  perform pg_temp.check('unresolved pay row kept for review (never $0 silently)',
    (select count(*) from public.dispatch_job_pay_lines where source_dispatch_id = v_job2 and pay_code = 'UNRESOLVED') = 1);
  perform pg_temp.check('unresolved charge row kept for review',
    (select count(*) from public.dispatch_job_charge_lines where source_dispatch_id = v_job2 and rate_rule_id is null and description like 'Unresolved:%') = 1);

  -- Adding the missing rule and re-checking replaces the unresolved rows with priced ones
  insert into public.rate_rules (organization_id, rule_kind, name, rate_type, amount, service_type, job_type, priority, active, effective_from)
  values (v_provider, 'billing', 'Welfare check (per hour)', 'hourly', 60.00, null, 'welfare_check', 0, true, date '2025-04-01'),
         (v_provider, 'pay', 'Welfare check pay (per hour)', 'hourly', 32.00, null, 'welfare_check', 0, true, date '2025-04-01');
  perform pg_temp.as_user(v_master);
  select * into v_res from public.resolve_dispatch_job_pay_lines(gen_random_uuid(), v_job2, null);
  perform pg_temp.check('re-check after adding the rule prices the job', v_res.unresolved_count = 0 and v_res.lines_written = 1);
  perform pg_temp.as_admin();
  perform pg_temp.check('unresolved rows replaced, not kept alongside',
    (select count(*) from public.dispatch_job_pay_lines where source_dispatch_id = v_job2) = 1
    and (select count(*) from public.dispatch_job_pay_lines where source_dispatch_id = v_job2 and pay_code = 'UNRESOLVED') = 0
    and (select count(*) from public.dispatch_job_charge_lines where source_dispatch_id = v_job2 and rate_rule_id is not null) = 1
    and (select count(*) from public.dispatch_job_charge_lines where source_dispatch_id = v_job2 and rate_rule_id is null) = 0);

  -- Visibility of charge lines follows the organisation
  perform pg_temp.as_user(v_other_master);
  select count(*) into v_n from public.dispatch_job_charge_lines where organization_id = v_provider;
  perform pg_temp.check('another organisation cannot read my charge lines', v_n = 0);
  perform pg_temp.as_user(v_master);
  select count(*) into v_n from public.dispatch_job_charge_lines where organization_id = v_provider;
  perform pg_temp.check('my master reads my charge lines', v_n = 3);
  perform pg_temp.as_admin();
end $$;

rollback;
