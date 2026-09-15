-- Behavioural truth table: owner console (subscriber list + lifecycle) and wildcard default pay.
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
  v_owner uuid := gen_random_uuid();
  v_gm uuid := gen_random_uuid();
  v_owner_master uuid := gen_random_uuid();
  v_sub uuid;
  v_sub_master uuid := gen_random_uuid();
  v_prospect uuid := gen_random_uuid();
  v_row record; v_res jsonb; v_ok boolean; v_err text; v_n int;
begin
  insert into public.organizations (id, name, organization_type, parent_organization_id, active, status)
  values (v_owner, 'Oracle Platform Owner', 'owner', null, true, 'active'),
         (v_prospect, 'Oracle Subscriber Security', 'private_enterprise', v_owner, false, 'prospect');
  insert into public.user_profiles (id, role, organization_id, employer_organization_id, display_name)
  values (v_gm, 'grand_master', v_owner, v_owner, 'Oracle GM'),
         (v_owner_master, 'master', v_owner, v_owner, 'Oracle Owner Master');
  insert into public.module_catalog (module_key, base_price, per_seat_price, per_site_price, billing_period, currency, active)
  values ('patrol', 0, 0, 0, 'monthly', 'NZD', true), ('rostering', 0, 0, 0, 'monthly', 'NZD', true), ('finance', 0, 0, 0, 'monthly', 'NZD', true)
  on conflict (module_key) do nothing;
  insert into public.module_dependencies (module_key, depends_on_module_key, reason) values ('finance', 'rostering', 'oracle') on conflict do nothing;

  -- Provision through the governed path, then give the subscriber a master.
  perform pg_temp.as_user(v_gm);
  v_res := public.platform_provision_subscriber('22222222-2222-4222-8222-222222222222', v_prospect, null, array['patrol', 'rostering', 'finance']);
  v_sub := (v_res->>'organization_id')::uuid;
  perform pg_temp.as_admin();
  insert into public.user_profiles (id, role, organization_id, employer_organization_id, display_name)
  values (v_sub_master, 'master', v_sub, v_sub, 'Oracle Subscriber Master');

  -- List: owner-only, aggregates only ------------------------------------------------
  perform pg_temp.as_user(v_owner_master);
  select count(*) into v_n from public.platform_list_subscribers();
  perform pg_temp.check('owner-side master (not grand_master) sees no subscribers', v_n = 0);
  perform pg_temp.as_user(v_sub_master);
  select count(*) into v_n from public.platform_list_subscribers();
  perform pg_temp.check('a subscriber master sees no subscriber list', v_n = 0);
  perform pg_temp.as_user(v_gm);
  select * into v_row from public.platform_list_subscribers() where organization_id = v_sub;
  perform pg_temp.check('grand_master lists the subscriber with its agreement and lines',
    v_row.organization_id = v_sub and v_row.agreement_id is not null and v_row.active_module_count = 3 and v_row.module_keys = array['finance', 'patrol', 'rostering']);
  perform pg_temp.check('activity is aggregate: user counts, no names', v_row.user_count = 1 and v_row.master_count = 1 and v_row.shifts_30d = 0 and v_row.jobs_30d = 0);

  -- Suspend ----------------------------------------------------------------------------
  perform pg_temp.as_user(v_owner_master);
  begin
    perform public.platform_set_subscriber_status(v_sub, 'suspended', 'oracle');
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm; end;
  perform pg_temp.check('only grand_master can change a subscriber''s status: ' || coalesce(v_err, ''), v_ok);
  perform pg_temp.as_user(v_gm);
  v_err := null;
  begin
    perform public.platform_set_subscriber_status(v_sub, 'suspended', '   ');
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm; end;
  perform pg_temp.check('suspension needs a reason: ' || coalesce(v_err, ''), v_ok and v_err like '%reason%');
  v_res := public.platform_set_subscriber_status(v_sub, 'suspended', 'Oracle: invoice 60 days overdue');
  perform pg_temp.check('suspend receipt names the modules taken offline', (v_res->>'status') = 'suspended' and (v_res->'modules') @> '["finance","patrol","rostering"]'::jsonb);
  perform pg_temp.as_admin();
  perform pg_temp.check('suspended: org status, lines, and modules all move together',
    (select status = 'suspended' and active from public.organizations where id = v_sub)
    and (select count(*) from public.org_module_subscriptions where organization_id = v_sub and status = 'suspended') = 3
    and (select count(*) from public.organization_modules where organization_id = v_sub and enabled) = 0);
  perform pg_temp.check('suspension is audited with the reason',
    exists (select 1 from public.audit_log where target_id = v_sub and action = 'platform_subscriber_suspended' and metadata->>'reason' like 'Oracle:%'));

  -- The subscriber's own people still exist and are not touched
  perform pg_temp.check('suspension does not touch the subscriber''s users', (select count(*) from public.user_profiles where organization_id = v_sub and deactivated_at is null) = 1);

  -- Reinstate ---------------------------------------------------------------------------
  perform pg_temp.as_user(v_gm);
  v_res := public.platform_set_subscriber_status(v_sub, 'active', null);
  perform pg_temp.as_admin();
  perform pg_temp.check('reinstated: exactly the suspended lines come back, dependencies in order',
    (select status = 'active' and active from public.organizations where id = v_sub)
    and (select count(*) from public.org_module_subscriptions where organization_id = v_sub and status = 'active') = 3
    and (select count(*) from public.organization_modules where organization_id = v_sub and enabled) = 3);

  -- Cancel --------------------------------------------------------------------------------
  perform pg_temp.as_user(v_gm);
  v_res := public.platform_set_subscriber_status(v_sub, 'cancelled', 'Oracle: subscriber closed');
  perform pg_temp.as_admin();
  perform pg_temp.check('cancelled: lines ended, modules off, organisation archived',
    (select status = 'archived' and not active from public.organizations where id = v_sub)
    and (select count(*) from public.org_module_subscriptions where organization_id = v_sub and status = 'cancelled' and ended_at = current_date) = 3
    and (select count(*) from public.organization_modules where organization_id = v_sub and enabled) = 0);
  perform pg_temp.as_user(v_gm);
  select * into v_row from public.platform_list_subscribers() where organization_id = v_sub;
  perform pg_temp.check('a cancelled subscriber stays listed (history), with zero live lines', v_row.cancelled_module_count = 3 and v_row.active_module_count = 0);

  -- Wildcard default pay resolves for any job type ------------------------------------------
  perform pg_temp.as_admin();
  insert into public.rate_rules (organization_id, rule_kind, name, rate_type, amount, pay_code, priority, active, effective_from)
  values (v_owner, 'pay', 'Guard (default pay, per hour)', 'hourly', 30.00, 'GUARD-HOURLY', -10, true, date '2025-04-01'),
         (v_owner, 'pay', 'Alarm response pay (per hour)', 'hourly', 34.00, 'ALARM', 0, true, date '2025-04-01');
  update public.rate_rules set job_type = 'alarm_response' where organization_id = v_owner and pay_code = 'ALARM';
  perform pg_temp.check('default pay applies to a job type with no specific rule',
    (select amount from public.resolve_rate_rule(v_owner, 'pay', now(), null, 'welfare_check', null, null, null, null, null, null, null, 'hourly')) = 30.00);
  perform pg_temp.check('a specific pay rule beats the default',
    (select amount from public.resolve_rate_rule(v_owner, 'pay', now(), null, 'alarm_response', null, null, null, null, null, null, null, 'hourly')) = 34.00);
end $$;

rollback;
