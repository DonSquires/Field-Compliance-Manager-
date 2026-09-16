-- Behavioural truth table: the assigned worker records what they used from the field (20260916120000).
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
  v_client uuid := gen_random_uuid();
  v_master uuid := gen_random_uuid();
  v_worker uuid := gen_random_uuid();
  v_other_worker uuid := gen_random_uuid();
  v_site uuid := gen_random_uuid();
  v_hinge jsonb; v_hinge_id uuid;
  v_wo public.workshop_work_orders%rowtype;
  v_line public.workshop_work_order_lines%rowtype; v_admin_line public.workshop_work_order_lines%rowtype;
  v_ok boolean; v_err text;
begin
  insert into public.organizations (id, name, organization_type, parent_organization_id, active, status)
  values (v_provider, 'Oracle Workshop Ltd', 'service_provider', null, true, 'active'), (v_client, 'Oracle Client Council', 'government', null, true, 'active');
  insert into public.user_profiles (id, role, organization_id, employer_organization_id, display_name)
  values (v_master, 'master', v_provider, v_provider, 'Oracle Master'), (v_worker, 'officer', v_provider, v_provider, 'Oracle Technician'), (v_other_worker, 'officer', v_provider, v_provider, 'Oracle Other Technician');
  insert into public.client_sites (id, client_organization_id, organization_id, name, address, center_point, gps_lat, gps_lng, active)
  values (v_site, v_client, v_provider, 'Oracle Depot', '1 Oracle Way', st_setsrid(st_makepoint(173.2840, -41.2706), 4326), -41.2706, 173.2840, true);
  insert into public.module_catalog (module_key, base_price, per_seat_price, per_site_price, billing_period, currency, active) values ('workshop', 0, 0, 0, 'monthly', 'NZD', true) on conflict (module_key) do nothing;
  insert into public.organization_modules (organization_id, module_key, enabled) values (v_provider, 'workshop', true), (v_provider, 'finance', true);

  perform pg_temp.as_user(v_master);
  v_hinge := public.manage_finance_item(v_provider, 'create', null, 'HINGE-HD', 'Heavy duty gate hinge', 'part', 'ea', 18.00, 32.00, 'Oracle Steel', 'oracle', current_date);
  v_hinge_id := (v_hinge->>'item_id')::uuid;
  v_wo := public.create_workshop_work_order(gen_random_uuid(), v_provider, 'maintenance', 'Fix depot gate', null, v_client, null, v_site, null, null, v_worker, null, null);
  v_admin_line := public.add_workshop_work_order_line(gen_random_uuid(), v_wo.id, 'labour', null, 'Site visit', 1, 120.00, 60.00);

  -- Draft: nobody but an administrator touches lines.
  perform pg_temp.as_user(v_worker);
  begin
    perform public.add_workshop_work_order_line(gen_random_uuid(), v_wo.id, 'material', v_hinge_id, null, 2, null, null);
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm; end;
  perform pg_temp.check('the worker cannot add lines while the order is still a draft: ' || coalesce(v_err, ''), v_ok);

  perform pg_temp.as_user(v_master);
  v_wo := public.advance_workshop_work_order_status(v_wo.id, 'approved', null);
  perform pg_temp.as_user(v_worker);
  v_wo := public.advance_workshop_work_order_status(v_wo.id, 'in_progress', null);

  -- In progress: the assigned worker records price-book items at book price.
  v_line := public.add_workshop_work_order_line(gen_random_uuid(), v_wo.id, 'material', v_hinge_id, null, 2, 999.00, 1.00);
  perform pg_temp.check('the worker''s line takes the price-book price, never a typed one', v_line.unit_price = 32.00 and v_line.unit_cost = 18.00 and v_line.line_total = 64.00 and v_line.created_by = v_worker);
  begin
    perform public.add_workshop_work_order_line(gen_random_uuid(), v_wo.id, 'travel', null, 'Travel 40 km', 40, 1.10, null);
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm; end;
  perform pg_temp.check('the worker cannot add a free-text priced line: ' || coalesce(v_err, ''), v_ok and v_err ilike '%Pick the item from the price list%');
  begin
    perform public.remove_workshop_work_order_line(v_wo.id, v_admin_line.id);
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm; end;
  perform pg_temp.check('the worker cannot remove the administrator''s line: ' || coalesce(v_err, ''), v_ok and v_err ilike '%only remove lines you added%');
  perform public.remove_workshop_work_order_line(v_wo.id, v_line.id);
  perform pg_temp.as_admin();
  perform pg_temp.check('the worker removed their own line', (select count(*) from public.workshop_work_order_lines where work_order_id = v_wo.id) = 1);

  -- Another worker in the same organisation has no say.
  perform pg_temp.as_user(v_other_worker);
  begin
    perform public.add_workshop_work_order_line(gen_random_uuid(), v_wo.id, 'material', v_hinge_id, null, 1, null, null);
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm; end;
  perform pg_temp.check('an unassigned worker cannot add lines: ' || coalesce(v_err, ''), v_ok);

  -- The administrator keeps typed prices and can remove anything.
  perform pg_temp.as_user(v_master);
  v_line := public.add_workshop_work_order_line(gen_random_uuid(), v_wo.id, 'material', v_hinge_id, null, 1, 30.00, null);
  perform pg_temp.check('the administrator may still type a price', v_line.unit_price = 30.00 and v_line.created_by = v_master);
  perform public.remove_workshop_work_order_line(v_wo.id, v_line.id);
  perform pg_temp.as_user(v_worker);
  v_line := public.add_workshop_work_order_line(gen_random_uuid(), v_wo.id, 'material', v_hinge_id, null, 2, null, null);
  v_wo := public.advance_workshop_work_order_status(v_wo.id, 'completed', 'Hinges replaced');
  perform pg_temp.check('the worker completes the visit (no stock location, so no draw-down)', v_wo.status = 'completed');
  perform pg_temp.as_admin();
  perform pg_temp.check('the completed bill is the admin visit plus the worker''s hinges', (select charge_total from public.workshop_work_order_summary where id = v_wo.id) = 120.00 + 64.00);
end $$;

rollback;
