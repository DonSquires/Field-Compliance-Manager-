-- Behavioural truth table: website fuel observations yield a 3-month median and stay provenance-bearing (20260917070000).
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
create or replace function pg_temp.check(p_label text, p_ok boolean) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL [%]', p_label; end if;
  raise notice 'ok   [%]', p_label;
end $$;

do $$
declare
  v_org uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid();
  v_officer uuid := gen_random_uuid();
  v_req_1 uuid := gen_random_uuid();
  v_req_2 uuid := gen_random_uuid();
  v_req_3 uuid := gen_random_uuid();
  v_req_4 uuid := gen_random_uuid();
  v_med record;
  v_ok boolean; v_err text;
begin
  insert into public.organizations (id, name, organization_type, parent_organization_id, active, status)
  values (v_org, 'Oracle Fuel Ops', 'service_provider', null, true, 'active');
  insert into public.user_profiles (id, role, organization_id, employer_organization_id, display_name)
  values (v_admin, 'master', v_org, v_org, 'Oracle Admin'), (v_officer, 'officer', v_org, v_org, 'Oracle Officer');

  perform pg_temp.as_user(v_admin);
  perform public.record_fuel_price_observation(v_req_1, v_org, 'petrol', current_date - 70, 2.10, 'AA Fuel', 'https://example.com/aa/weekly', current_timestamp - interval '70 days', 'aa-1', 'hash-1');
  perform public.record_fuel_price_observation(v_req_2, v_org, 'petrol', current_date - 50, 2.30, 'BP Fuel', 'https://example.com/bp/monthly', current_timestamp - interval '50 days', 'bp-2', 'hash-2');
  perform public.record_fuel_price_observation(v_req_3, v_org, 'petrol', current_date - 22, 2.40, 'AA Fuel', 'https://example.com/aa/weekly?latest', current_timestamp - interval '22 days', 'aa-3', 'hash-3');
  perform public.record_fuel_price_observation(v_req_4, v_org, 'petrol', current_date - 5, 2.60, 'BP Fuel', 'https://example.com/bp/monthly?latest', current_timestamp - interval '5 days', 'bp-4', 'hash-4');

  select * into v_med from public.get_median_fuel_price(v_org, 'petrol', current_date, 3);
  perform pg_temp.check('median across the trailing three months is the central value', abs(v_med.median_price_per_litre - 2.35) < 0.001 and v_med.observation_count = 4);
  perform pg_temp.check('window bounds reflect the trailing three months', v_med.window_start <= current_date - 3 * 30 and v_med.window_end = current_date);

  perform pg_temp.as_user(v_officer);
  begin
    perform public.record_fuel_price_observation(gen_random_uuid(), v_org, 'diesel', current_date - 10, 2.80, 'Fuel Watch', 'https://example.com/fuel-watch', current_timestamp - interval '10 days', 'fw-1', 'hash-5');
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm; end;
  perform pg_temp.check('only authorised admins can add a fuel observation: ' || coalesce(v_err, ''), v_ok);
end $$;

rollback;
