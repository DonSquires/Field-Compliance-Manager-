-- Behavioural truth table: the five RPCs with RETURNS TABLE column ambiguity now run on first use,
-- and a subscriber's own organisation can list its people. Runs in a transaction and rolls back.
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
  v_branch uuid := gen_random_uuid();
  v_client uuid := gen_random_uuid();
  v_master uuid := gen_random_uuid();
  v_officer uuid := gen_random_uuid();
  v_branch_officer uuid := gen_random_uuid();
  v_site uuid := gen_random_uuid();
  v_agreement uuid := gen_random_uuid();
  v_shift uuid := gen_random_uuid();
  v_resource uuid := gen_random_uuid();
  v_unit uuid := gen_random_uuid();
  v_workplace uuid := gen_random_uuid();
  v_invoice uuid := gen_random_uuid();
  v_res record; v_n int; v_ok boolean; v_err text;
begin
  insert into public.organizations (id, name, organization_type, parent_organization_id, active, status)
  values (v_provider, 'Oracle Provider Ltd', 'service_provider', null, true, 'active'),
         (v_branch, 'Oracle Provider Nelson', 'branch', v_provider, true, 'active'),
         (v_client, 'Oracle Council', 'government', null, true, 'active');
  insert into public.user_profiles (id, role, organization_id, employer_organization_id, display_name)
  values (v_master, 'master', v_provider, v_provider, 'Oracle Master'),
         (v_officer, 'officer', v_provider, v_provider, 'Oracle Officer'),
         (v_branch_officer, 'officer', v_branch, v_provider, 'Oracle Branch Officer');
  insert into public.staff_branch_authorisations (user_id, branch_org_id, role_at_branch, status) values (v_branch_officer, v_branch, 'officer', 'active');
  insert into public.service_agreements (id, provider_organization_id, client_organization_id, name, agreement_type, starts_on, invitation_status)
  values (v_agreement, v_provider, v_client, 'Oracle Provider serves Oracle Council', 'operational', current_date, 'accepted');
  insert into public.client_sites (id, client_organization_id, organization_id, name, address, center_point, gps_lat, gps_lng, active)
  values (v_site, v_client, v_provider, 'Oracle Depot', '1 Oracle Way', st_setsrid(st_makepoint(173.2840, -41.2706), 4326), -41.2706, 173.2840, true);
  insert into public.service_agreement_locations (service_agreement_id, site_id, status) values (v_agreement, v_site, 'active') on conflict do nothing;
  insert into public.shifts (id, organization_id, officer_user_id, service_type, scheduled_start, scheduled_end, status)
  values (v_shift, v_provider, v_officer, 'patrol', now() - interval '1 hour', now() + interval '7 hours', 'in_progress');
  insert into public.dispatch_resources (id, organization_id, name, service_type, assigned_officer_id, status)
  values (v_resource, v_provider, 'Oracle Car 1', 'patrol', v_officer, 'available');
  insert into public.organization_workplaces (id, organization_id, name) values (v_workplace, v_provider, 'Oracle base');
  -- An 'internal' unit needs only a workplace; its service_type is what queue_dispatch_job_for_officer matches.
  insert into public.roster_work_units (id, organization_id, name, work_unit_type, service_type, workplace_id, active)
  values (v_unit, v_provider, 'Oracle patrol unit', 'internal', 'patrol', v_workplace, true);

  -- People: the organisation's own master lists its people (home context) --------------------
  perform pg_temp.as_user(v_master);
  select count(*) into v_n from public.get_manageable_user_identities(v_provider);
  perform pg_temp.check('home organisation lists its own people (master + officer + employed branch officer)', v_n = 3);
  select count(*) into v_n from public.get_manageable_user_identities(v_branch);
  perform pg_temp.check('branch path still lists branch-authorised people only', v_n = 1);
  perform pg_temp.as_user(v_officer);
  v_err := null;
  begin
    select count(*) into v_n from public.get_manageable_user_identities(v_provider);
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm; end;
  perform pg_temp.check('an officer cannot list the organisation''s people: ' || coalesce(v_err, ''), v_ok);

  -- Dispatch: create a job, with and without a resource ------------------------------------------
  perform pg_temp.as_user(v_master);
  select * into v_res from public.create_dispatch_job(v_provider, v_agreement, v_site, gen_random_uuid(), 'alarm_response', 'high', 30, null, 'no resource', v_shift);
  perform pg_temp.check('create_dispatch_job without a resource works on first use', v_res.created and v_res.status = 'pending');
  select * into v_res from public.create_dispatch_job(v_provider, v_agreement, v_site, gen_random_uuid(), 'alarm_response', 'high', 30, v_resource, 'with resource', v_shift);
  perform pg_temp.check('create_dispatch_job with a resource dispatches and marks the resource busy',
    v_res.created and v_res.status = 'dispatched' and (select status from public.dispatch_resources where id = v_resource) = 'busy');

  -- Dispatch: queue for a named officer ------------------------------------------------------------
  select * into v_res from public.queue_dispatch_job_for_officer(v_provider, v_agreement, v_site, gen_random_uuid(), v_officer, v_unit, 'patrol', 'patrol_support', 'normal', 60, 'queued');
  perform pg_temp.check('queue_dispatch_job_for_officer works on first use', v_res.created and v_res.assigned_officer_id = v_officer and v_res.work_unit_id = v_unit);

  -- Invoicing: add a line -------------------------------------------------------------------------
  perform pg_temp.as_admin();
  insert into public.invoices (id, organization_id, client_organization_id, service_agreement_id, invoice_number, invoice_date, due_date, status, currency, total_amount)
  values (v_invoice, v_provider, v_client, v_agreement, 'ORACLE-0001', current_date, current_date + 20, 'draft', 'NZD', 0);
  perform pg_temp.as_user(v_master);
  select * into v_res from public.add_crm_invoice_line(gen_random_uuid(), v_invoice, 'Oracle patrol visits', 4, 54.10);
  perform pg_temp.check('add_crm_invoice_line works on first use and totals the line', v_res.created and v_res.subtotal = 216.40);
  perform pg_temp.as_admin();
end $$;

rollback;
