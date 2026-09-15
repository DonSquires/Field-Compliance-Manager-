-- Behavioural truth table for the platform-owner boundary (owner rulings 2026-09-15).
-- Runs in a transaction and rolls back. Fixtures as postgres; reads exercised as `authenticated` with a JWT sub.
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
  v_owner uuid := gen_random_uuid();          -- Iron Eagle (platform owner)
  v_gm uuid := gen_random_uuid();             -- owner's grand_master
  v_gm_deactivated uuid := gen_random_uuid(); -- a deactivated grand_master (must be powerless)
  v_owner_master uuid := gen_random_uuid();   -- owner-side master (billing staff, NOT grand_master)
  v_sub uuid;                                 -- subscriber org (provisioned by the RPC)
  v_sub_master uuid := gen_random_uuid();     -- subscriber's master
  v_client uuid := gen_random_uuid();         -- subscriber's own client (operational agreement)
  v_client_user uuid := gen_random_uuid();
  v_prospect uuid := gen_random_uuid();       -- CRM prospect to be reclassified
  v_site uuid := gen_random_uuid();
  v_receipt jsonb; v_receipt2 jsonb;
  v_n int; v_ok boolean; v_err text;
begin
  -- Fixtures -----------------------------------------------------------------
  insert into public.organizations (id, name, organization_type, parent_organization_id, active, status)
  values (v_owner, 'Oracle Platform Owner', 'owner', null, true, 'active'),
         (v_prospect, 'Oracle Prospect Security Ltd', 'private_enterprise', v_owner, false, 'prospect'),
         (v_client, 'Oracle Council', 'government', null, true, 'active');
  insert into public.user_profiles (id, role, organization_id, employer_organization_id, display_name)
  values (v_gm, 'grand_master', v_owner, v_owner, 'Oracle GM'),
         (v_gm_deactivated, 'grand_master', v_owner, v_owner, 'Oracle GM (deactivated)'),
         (v_owner_master, 'master', v_owner, v_owner, 'Oracle Owner Master'),
         (v_client_user, 'master', v_client, v_client, 'Oracle Council Master');
  update public.user_profiles set deactivated_at = now() where id = v_gm_deactivated;
  -- Catalog rows are data (seeded by the catalog migration live), so the oracle seeds the keys it uses.
  insert into public.module_catalog (module_key, base_price, per_seat_price, per_site_price, billing_period, currency, active)
  values ('patrol', 0, 0, 0, 'monthly', 'NZD', true), ('rostering', 0, 0, 0, 'monthly', 'NZD', true), ('finance', 0, 0, 0, 'monthly', 'NZD', true)
  on conflict (module_key) do nothing;
  insert into public.module_dependencies (module_key, depends_on_module_key, reason)
  values ('finance', 'rostering', 'oracle: finance derives from roster work units')
  on conflict do nothing;

  -- Catalog -------------------------------------------------------------------
  perform pg_temp.check('dispatch and cctv are sellable modules',
    (select count(*) from public.module_catalog where module_key in ('dispatch', 'cctv') and active) = 2);

  -- Provisioning: gate ----------------------------------------------------------
  perform pg_temp.as_user(v_owner_master);
  begin
    perform public.platform_provision_subscriber(gen_random_uuid(), null, 'Should Fail Ltd', array['patrol']);
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm; end;
  perform pg_temp.check('owner-side master cannot provision a subscriber: ' || coalesce(v_err, ''), v_ok);

  perform pg_temp.as_user(v_gm_deactivated);
  begin
    perform public.platform_provision_subscriber(gen_random_uuid(), null, 'Should Fail Ltd', array['patrol']);
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm; end;
  perform pg_temp.check('deactivated grand_master cannot provision: ' || coalesce(v_err, ''), v_ok);
  perform pg_temp.check('deactivated grand_master is not a grand_master', public.is_grand_master() = false);
  perform pg_temp.check('deactivated grand_master has no reach', public.org_access_allowed(v_prospect) = false);

  -- Provisioning: reclassify a dependent-free prospect --------------------------
  perform pg_temp.as_user(v_gm);
  begin
    perform public.platform_provision_subscriber(gen_random_uuid(), v_prospect, null, array['patrol', 'finance', 'nonsense_module']);
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm; end;
  perform pg_temp.check('unknown module key is rejected: ' || coalesce(v_err, ''), v_ok and v_err like '%nonsense_module%');

  v_receipt := public.platform_provision_subscriber('11111111-1111-4111-8111-111111111111', v_prospect, null,
                 array['patrol', 'rostering', 'finance', 'dispatch', 'cctv']);
  v_sub := (v_receipt->>'organization_id')::uuid;
  perform pg_temp.check('reclassified row keeps its id', v_sub = v_prospect);
  perform pg_temp.as_admin();
  perform pg_temp.check('subscriber is own-rooted service_provider, active',
    exists (select 1 from public.organizations where id = v_sub and organization_type = 'service_provider' and parent_organization_id is null and active and status = 'active'));
  perform pg_temp.check('financial platform agreement exists (owner -> subscriber)',
    exists (select 1 from public.service_agreements where provider_organization_id = v_owner and client_organization_id = v_sub and agreement_type = 'financial' and ends_on is null));
  perform pg_temp.check('subscription lines seeded active',
    (select count(*) from public.org_module_subscriptions where organization_id = v_sub and status = 'active') = 5);
  perform pg_temp.check('operational enablement seeded (finance after rostering)',
    (select count(*) from public.organization_modules where organization_id = v_sub and enabled) = 5);
  perform pg_temp.check('audit row written',
    exists (select 1 from public.audit_log where target_id = v_sub and action = 'platform_subscriber_provisioned' and actor_user_id = v_gm));

  -- Idempotent replay on the same request id
  perform pg_temp.as_user(v_gm);
  v_receipt2 := public.platform_provision_subscriber('11111111-1111-4111-8111-111111111111', v_prospect, null, array['patrol']);
  perform pg_temp.check('replay returns the same org without side effects',
    (v_receipt2->>'organization_id')::uuid = v_sub and (v_receipt2->>'replayed')::boolean);
  perform pg_temp.as_admin();
  perform pg_temp.check('replay did not add agreements',
    (select count(*) from public.service_agreements where client_organization_id = v_sub and agreement_type = 'financial') = 1);

  -- Reclassification refuses rows with dependents --------------------------------
  insert into public.organizations (id, name, organization_type, parent_organization_id, active, status)
  values (gen_random_uuid(), 'Oracle Prospect With Users', 'client', v_owner, false, 'prospect');
  insert into public.user_profiles (id, role, organization_id, employer_organization_id, display_name)
  select gen_random_uuid(), 'officer', o.id, o.id, 'Oracle Dependent' from public.organizations o where o.name = 'Oracle Prospect With Users';
  perform pg_temp.as_user(v_gm);
  begin
    perform public.platform_provision_subscriber(gen_random_uuid(), (select id from public.organizations where name = 'Oracle Prospect With Users'), null, array['patrol']);
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm; end;
  perform pg_temp.check('prospect with users cannot be reclassified: ' || coalesce(v_err, ''), v_ok and v_err like '%already has users%');

  -- Boundary: the financial agreement confers NO reach ----------------------------
  perform pg_temp.as_admin();
  insert into public.user_profiles (id, role, organization_id, employer_organization_id, display_name)
  values (v_sub_master, 'master', v_sub, v_sub, 'Oracle Subscriber Master');
  insert into public.client_sites (id, client_organization_id, organization_id, name, address, center_point, active)
  values (v_site, v_sub, v_sub, 'Oracle Subscriber Depot', '1 Oracle Way', st_setsrid(st_makepoint(173.2840, -41.2706), 4326), true);

  perform pg_temp.as_user(v_owner_master);
  perform pg_temp.check('owner-side master: no org_access_allowed on subscriber', public.org_access_allowed(v_sub) = false);
  perform pg_temp.check('owner-side master: no is_master_for_org on subscriber', public.is_master_for_org(v_sub) = false);
  perform pg_temp.check('owner-side master: no is_admin_for_org on subscriber', public.is_admin_for_org(v_sub) = false);
  select count(*) into v_n from public.client_sites where client_organization_id = v_sub;
  perform pg_temp.check('owner-side master cannot read subscriber places through RLS', v_n = 0);
  select count(*) into v_n from public.organizations where id = v_sub;
  perform pg_temp.check('owner-side master still sees the subscriber org row (Tier 0 counterparty)', v_n = 1);
  select count(*) into v_n from public.org_module_subscriptions where organization_id = v_sub;
  perform pg_temp.check('owner-side master reads subscription lines only if policy grants (recorded, not asserted): ' || v_n, true);

  perform pg_temp.as_user(v_sub_master);
  perform pg_temp.check('subscriber master: no reach into the owner org', public.org_access_allowed(v_owner) = false);
  select count(*) into v_n from public.organizations where id = v_owner;
  perform pg_temp.check('subscriber master sees the owner org row (name) via Tier 0 counterparty policy', v_n = 1);
  select count(*) into v_n from public.service_agreements where client_organization_id = v_sub and agreement_type = 'financial';
  perform pg_temp.check('subscriber master sees its own platform agreement', v_n = 1);
  select count(*) into v_n from public.client_sites where client_organization_id = v_sub;
  perform pg_temp.check('subscriber master reads its own places', v_n = 1);

  -- Boundary: an OPERATIONAL agreement still carries 0271 reach -------------------
  perform pg_temp.as_admin();
  insert into public.service_agreements (provider_organization_id, client_organization_id, name, agreement_type, starts_on, ends_on)
  values (v_sub, v_client, 'Oracle Subscriber serves Oracle Council', 'operational', current_date, null);
  perform pg_temp.as_user(v_sub_master);
  perform pg_temp.check('subscriber master reaches its operational client', public.org_access_allowed(v_client) = true);
  perform pg_temp.check('subscriber master may manage its operational client', public.is_master_for_org(v_client) = true);
  perform pg_temp.as_user(v_client_user);
  perform pg_temp.check('client sees its operational provider', public.org_access_allowed(v_sub) = true);
  perform pg_temp.check('client does not reach the platform owner', public.org_access_allowed(v_owner) = false);

  -- grand_master keeps platform-control reach -------------------------------------
  perform pg_temp.as_user(v_gm);
  perform pg_temp.check('grand_master reaches subscriber (narrowing to platform-control surface is a later slice)', public.org_access_allowed(v_sub) = true);
  perform pg_temp.as_admin();
end $$;

rollback;
