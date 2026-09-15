-- Behavioural truth table: a subscriber's own organisation is an operating context and its
-- master opens branches from Organisation settings. Runs in a transaction and rolls back.
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
  v_provider uuid := gen_random_uuid();     -- own-rooted subscriber (service_provider)
  v_master uuid := gen_random_uuid();       -- its master
  v_officer uuid := gen_random_uuid();      -- its officer (no admin authority)
  v_client uuid := gen_random_uuid();       -- a client organisation
  v_client_master uuid := gen_random_uuid();
  v_branch public.organizations%rowtype;
  v_branch2 public.organizations%rowtype;
  v_row public.organizations%rowtype;
  v_ok boolean; v_err text; v_n int; v_req uuid := gen_random_uuid();
  v_updated timestamptz;
begin
  insert into public.module_catalog (module_key, base_price, per_seat_price, per_site_price, billing_period, currency, active)
  values ('patrol', 0, 0, 0, 'monthly', 'NZD', true), ('rostering', 0, 0, 0, 'monthly', 'NZD', true), ('finance', 0, 0, 0, 'monthly', 'NZD', true), ('hr', 0, 0, 0, 'monthly', 'NZD', true)
  on conflict (module_key) do nothing;
  insert into public.module_dependencies (module_key, depends_on_module_key, reason)
  values ('finance', 'rostering', 'oracle') on conflict do nothing;

  insert into public.organizations (id, name, organization_type, parent_organization_id, active, status)
  values (v_provider, 'Oracle Subscriber Security', 'service_provider', null, true, 'active'),
         (v_client, 'Oracle Client Council', 'government', null, true, 'active');
  insert into public.user_profiles (id, role, organization_id, employer_organization_id, display_name)
  values (v_master, 'master', v_provider, v_provider, 'Oracle Master'),
         (v_officer, 'officer', v_provider, v_provider, 'Oracle Officer'),
         (v_client_master, 'master', v_client, v_client, 'Oracle Client Master');
  insert into public.organization_modules (organization_id, module_key, enabled)
  values (v_provider, 'patrol', true), (v_provider, 'rostering', true), (v_provider, 'finance', true), (v_provider, 'hr', false);

  -- 1. Home organisation is an operating context ---------------------------------
  perform pg_temp.as_user(v_master);
  select count(*) into v_n from public.get_operating_organization_contexts() c where c.organization_id = v_provider and c.authority_basis = 'organisation_home' and c.is_default;
  perform pg_temp.check('master sees the home organisation as the default operating context', v_n = 1);
  perform pg_temp.check('user_can_operate_organization(home) is true', public.user_can_operate_organization(v_provider));

  perform pg_temp.as_user(v_officer);
  select count(*) into v_n from public.get_operating_organization_contexts();
  perform pg_temp.check('an officer without authorisations has no operating context', v_n = 0);

  -- 2. Governed writes work on the provider organisation itself --------------------
  perform pg_temp.as_user(v_master);
  select updated_at into v_updated from public.organizations where id = v_provider;
  v_row := public.update_operating_branch_profile(v_provider, v_updated, 'ops@oracle.test', '03 555 0100', 'accounts@oracle.test', '1 Oracle Way', 'officer_direct');
  perform pg_temp.check('master updates the organisation profile', v_row.contact_email = 'ops@oracle.test');

  perform public.manage_operating_branch_rate_rule(
    p_operating_organization_id => v_provider, p_client_request_id => gen_random_uuid(), p_action => 'create',
    p_rate_rule_id => null, p_expected_updated_at => null, p_rule_kind => 'billing', p_name => 'Patrol visit',
    p_rate_type => 'per_visit', p_amount => 58.30, p_pay_code => null, p_service_type => 'patrol', p_job_type => null,
    p_client_org_id => null, p_site_id => null, p_zone_id => null, p_day_category => null,
    p_effective_from => null, p_effective_to => null, p_priority => 0);
  perform pg_temp.as_admin();
  perform pg_temp.check('master creates a customer charge rule at organisation level',
    exists (select 1 from public.rate_rules where organization_id = v_provider and name = 'Patrol visit' and rule_kind = 'billing'));

  perform pg_temp.as_user(v_master);
  perform public.set_operating_branch_module(v_provider, 'hr', true);
  perform pg_temp.as_admin();
  perform pg_temp.check('master enables a module at organisation level',
    exists (select 1 from public.organization_modules where organization_id = v_provider and module_key = 'hr' and enabled));

  -- 3. Branches from Organisation settings -----------------------------------------
  perform pg_temp.as_user(v_client_master);
  begin
    perform public.create_provider_branch(gen_random_uuid(), v_client, 'Should Fail', null, null);
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm; end;
  perform pg_temp.check('a client organisation cannot open branches: ' || coalesce(v_err, ''), v_ok);

  perform pg_temp.as_user(v_officer);
  begin
    perform public.create_provider_branch(gen_random_uuid(), v_provider, 'Should Fail', null, null);
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm; end;
  perform pg_temp.check('an officer cannot open branches: ' || coalesce(v_err, ''), v_ok);

  perform pg_temp.as_user(v_master);
  v_branch := public.create_provider_branch(v_req, v_provider, '  Nelson  ', 'Nelson@Oracle.test', '03 555 0101');
  perform pg_temp.check('branch is active under the provider with trimmed, normalised contact',
    v_branch.organization_type = 'branch' and v_branch.parent_organization_id = v_provider and v_branch.active and v_branch.status = 'active'
    and v_branch.name = 'Nelson' and v_branch.contact_email = 'nelson@oracle.test');
  v_branch2 := public.create_provider_branch(v_req, v_provider, 'Nelson', null, null);
  perform pg_temp.check('same request id replays the same branch', v_branch2.id = v_branch.id);
  begin
    perform public.create_provider_branch(gen_random_uuid(), v_provider, 'nelson', null, null);
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm; end;
  perform pg_temp.check('duplicate branch name is refused: ' || coalesce(v_err, ''), v_ok and v_err like '%already exists%');

  perform pg_temp.as_admin();
  select count(*) into v_n from public.organization_modules where organization_id = v_branch.id and enabled;
  perform pg_temp.check('branch inherits the parent''s enabled modules (patrol, rostering, finance, hr)', v_n = 4);
  perform pg_temp.check('audit row for branch creation',
    exists (select 1 from public.audit_log where action = 'provider_branch_created' and target_id = v_branch.id and actor_user_id = v_master));

  perform pg_temp.as_user(v_master);
  select count(*) into v_n from public.get_operating_organization_contexts() c where c.organization_id = v_branch.id and c.authority_basis = 'corporate_oversight';
  perform pg_temp.check('master can now operate the new branch (oversight)', v_n = 1);
  select count(*) into v_n from public.get_operating_organization_contexts() c where c.is_default;
  perform pg_temp.check('the home organisation stays the single default', v_n = 1);

  -- A branch cannot run a module the organisation has off.
  perform public.set_operating_branch_module(v_provider, 'hr', false);
  perform pg_temp.as_admin();
  update public.organization_modules set enabled = false where organization_id = v_branch.id and module_key = 'hr';
  perform pg_temp.as_user(v_master);
  begin
    perform public.set_operating_branch_module(v_branch.id, 'hr', true);
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm; end;
  perform pg_temp.check('branch cannot enable a module the organisation has off: ' || coalesce(v_err, ''), v_ok and v_err like '%Enable this module for the organisation%');
  perform public.set_operating_branch_module(v_branch.id, 'patrol', false);
  perform public.set_operating_branch_module(v_branch.id, 'patrol', true);
  perform pg_temp.check('branch toggles a module the organisation has on', true);

  -- 4. Archiving ---------------------------------------------------------------------
  perform pg_temp.as_admin();
  insert into public.user_profiles (id, role, organization_id, employer_organization_id, display_name)
  values (gen_random_uuid(), 'officer', v_branch.id, v_provider, 'Oracle Branch Officer');
  perform pg_temp.as_user(v_master);
  select updated_at into v_updated from public.organizations where id = v_branch.id;
  begin
    perform public.archive_provider_branch(v_branch.id, v_updated);
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm; end;
  perform pg_temp.check('branch with active staff cannot be archived: ' || coalesce(v_err, ''), v_ok and v_err like '%staff%');

  perform pg_temp.as_admin();
  update public.user_profiles set deactivated_at = now() where organization_id = v_branch.id;
  perform pg_temp.as_user(v_master);
  select updated_at into v_updated from public.organizations where id = v_branch.id;
  v_row := public.archive_provider_branch(v_branch.id, v_updated);
  perform pg_temp.check('branch archived', v_row.status = 'archived' and not v_row.active);
  select count(*) into v_n from public.get_operating_organization_contexts() c where c.organization_id = v_branch.id;
  perform pg_temp.check('archived branch leaves the operating contexts', v_n = 0);
  perform pg_temp.as_admin();
  select count(*) into v_n from public.organization_modules where organization_id = v_branch.id and enabled;
  perform pg_temp.check('archived branch has its modules turned off', v_n = 0);
end $$;

rollback;
