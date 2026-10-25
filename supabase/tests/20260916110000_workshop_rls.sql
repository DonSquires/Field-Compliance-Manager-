-- Behavioural truth table: workshop module (BOM templates, fabrication + maintenance work orders,
-- strict stock draw-down, and the completed-work invoice sweep that also picks up dispatch charge lines).
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
  v_worker uuid := gen_random_uuid();
  v_other_master uuid := gen_random_uuid();
  v_site uuid := gen_random_uuid();
  v_agreement uuid := gen_random_uuid();
  v_asset uuid := gen_random_uuid();
  v_steel jsonb; v_steel_id uuid; v_bolts jsonb; v_bolts_id uuid; v_labour jsonb; v_labour_id uuid;
  v_loc public.finance_inventory_locations%rowtype;
  v_tpl public.workshop_bom_templates%rowtype;
  v_wo public.workshop_work_orders%rowtype; v_wo2 public.workshop_work_orders%rowtype; v_wo3 public.workshop_work_orders%rowtype;
  v_line public.workshop_work_order_lines%rowtype;
  v_inv public.invoices%rowtype; v_inv2 public.invoices%rowtype;
  v_charge uuid := gen_random_uuid(); v_job uuid := gen_random_uuid();
  v_ok boolean; v_err text; v_n int; v_total numeric;
begin
  -- Fixtures -----------------------------------------------------------------
  insert into public.organizations (id, name, organization_type, parent_organization_id, active, status)
  values (v_provider, 'Oracle Workshop Ltd', 'service_provider', null, true, 'active'),
         (v_other, 'Oracle Other Provider', 'service_provider', null, true, 'active'),
         (v_client, 'Oracle Client Council', 'government', null, true, 'active');
  insert into public.user_profiles (id, role, organization_id, employer_organization_id, display_name)
  values (v_master, 'master', v_provider, v_provider, 'Oracle Master'),
         (v_worker, 'officer', v_provider, v_provider, 'Oracle Fabricator'),
         (v_other_master, 'master', v_other, v_other, 'Oracle Other Master');
  insert into public.service_agreements (id, provider_organization_id, client_organization_id, name, agreement_type, starts_on, ends_on)
  values (v_agreement, v_provider, v_client, 'Oracle Workshop serves Oracle Client', 'operational', current_date, null);
  insert into public.client_sites (id, client_organization_id, organization_id, name, address, center_point, gps_lat, gps_lng, active)
  values (v_site, v_client, v_provider, 'Oracle Depot', '1 Oracle Way', st_setsrid(st_makepoint(173.2840, -41.2706), 4326), -41.2706, 173.2840, true);
  insert into public.assets (id, organization_id, asset_type, name) values (v_asset, v_provider, 'other', 'Depot cyclone gate');
  insert into public.module_catalog (module_key, base_price, per_seat_price, per_site_price, billing_period, currency, active)
  values ('workshop', 0, 0, 0, 'monthly', 'NZD', true) on conflict (module_key) do nothing;
  insert into public.organization_modules (organization_id, module_key, enabled) values (v_provider, 'workshop', true), (v_provider, 'finance', true), (v_other, 'finance', true);

  -- Price book -----------------------------------------------------------------
  perform pg_temp.as_user(v_master);
  v_steel := public.manage_finance_item(v_provider, 'create', null, 'BOX-200', '200x200mm box section (lockbox)', 'material', 'm', 40.00, 62.00, 'Oracle Steel', 'oracle', current_date);
  v_steel_id := (v_steel->>'item_id')::uuid;
  v_bolts := public.manage_finance_item(v_provider, 'create', null, 'M20-NUT', '20mm nuts and flat washers', 'material', 'ea', 1.10, 2.20, 'Oracle Steel', 'oracle', current_date);
  v_bolts_id := (v_bolts->>'item_id')::uuid;
  v_labour := public.manage_finance_item(v_provider, 'create', null, 'FAB-HR', 'Fabrication labour', 'service', 'hr', 45.00, 95.00, null, 'oracle', current_date);
  v_labour_id := (v_labour->>'item_id')::uuid;

  -- Module gate + admin gate ---------------------------------------------------
  perform pg_temp.as_user(v_other_master);
  begin
    perform public.manage_workshop_bom_template(gen_random_uuid(), v_other, 'create', null, 'Lockbox', null, 'fabrication', '[]'::jsonb);
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm; end;
  perform pg_temp.check('an organisation without the workshop module cannot use it: ' || coalesce(v_err, ''), v_ok and v_err ilike '%not enabled%');
  begin
    perform public.manage_workshop_bom_template(gen_random_uuid(), v_provider, 'create', null, 'Lockbox', null, 'fabrication', '[]'::jsonb);
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm; end;
  perform pg_temp.check('another organisation''s master cannot write my templates: ' || coalesce(v_err, ''), v_ok);
  perform pg_temp.as_user(v_worker);
  begin
    perform public.manage_workshop_bom_template(gen_random_uuid(), v_provider, 'create', null, 'Lockbox', null, 'fabrication', '[]'::jsonb);
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm; end;
  perform pg_temp.check('a worker cannot manage templates: ' || coalesce(v_err, ''), v_ok);

  -- BOM template ---------------------------------------------------------------
  perform pg_temp.as_user(v_master);
  v_tpl := public.manage_workshop_bom_template(gen_random_uuid(), v_provider, 'create', null, 'Standard lockbox', 'Box section + fixings + labour', 'fabrication',
    jsonb_build_array(
      jsonb_build_object('line_kind', 'material', 'item_id', v_steel_id, 'quantity', 2.5),
      jsonb_build_object('line_kind', 'material', 'item_id', v_bolts_id, 'quantity', 8),
      jsonb_build_object('line_kind', 'labour', 'item_id', v_labour_id, 'quantity', 3, 'description', 'Cut, weld, finish')));
  perform pg_temp.as_admin();
  perform pg_temp.check('template created with three lines in order',
    (select count(*) from public.workshop_bom_template_lines where template_id = v_tpl.id) = 3
    and (select description from public.workshop_bom_template_lines where template_id = v_tpl.id and position = 1) = '200x200mm box section (lockbox)'
    and (select description from public.workshop_bom_template_lines where template_id = v_tpl.id and position = 3) = 'Cut, weld, finish');
  perform pg_temp.as_user(v_master);
  begin
    perform public.manage_workshop_bom_template(gen_random_uuid(), v_provider, 'create', null, 'Bad', null, 'fabrication', jsonb_build_array(jsonb_build_object('line_kind', 'material', 'item_id', v_steel_id, 'quantity', 0)));
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm; end;
  perform pg_temp.check('a template line needs a quantity above zero: ' || coalesce(v_err, ''), v_ok);

  -- Stock location + receipt ----------------------------------------------------
  v_loc := public.manage_finance_inventory_location(v_provider, 'create', null, 'Workshop', 'warehouse', null);
  perform public.record_finance_inventory_transaction(v_steel_id, v_loc.id, 'receipt', 10, 40.00, 'oracle-receipt-steel', 'Oracle Steel invoice 1');
  perform public.record_finance_inventory_transaction(v_bolts_id, v_loc.id, 'receipt', 5, 1.10, 'oracle-receipt-bolts', 'Oracle Steel invoice 1');
  perform pg_temp.as_admin();
  perform pg_temp.check('stock on hand after receipts', (select on_hand from public.finance_inventory_balances where item_id = v_steel_id and location_id = v_loc.id) = 10
    and (select on_hand from public.finance_inventory_balances where item_id = v_bolts_id and location_id = v_loc.id) = 5);

  -- Fabrication work order from the template ------------------------------------
  perform pg_temp.as_user(v_master);
  v_wo := public.create_workshop_work_order('11111111-1111-4111-8111-111111111111', v_provider, 'fabrication', 'Lockbox for Oracle Depot', 'Build one standard lockbox',
                                            v_client, v_agreement, null, null, v_loc.id, v_worker, now() + interval '1 day', v_tpl.id);
  perform pg_temp.check('work order numbered and drafted', v_wo.status = 'draft' and v_wo.order_number like 'WO-%-0001' and v_wo.kind = 'fabrication');
  v_wo2 := public.create_workshop_work_order('11111111-1111-4111-8111-111111111111', v_provider, 'fabrication', 'Lockbox for Oracle Depot', null, v_client, null, null, null, null, null, null, null);
  perform pg_temp.check('same request id replays the same work order', v_wo2.id = v_wo.id);
  perform pg_temp.as_admin();
  perform pg_temp.check('template lines copied at today''s approved cost and sell price',
    (select count(*) from public.workshop_work_order_lines where work_order_id = v_wo.id) = 3
    and (select unit_price from public.workshop_work_order_lines where work_order_id = v_wo.id and item_id = v_steel_id) = 62.00
    and (select unit_cost from public.workshop_work_order_lines where work_order_id = v_wo.id and item_id = v_steel_id) = 40.00
    and (select line_total from public.workshop_work_order_lines where work_order_id = v_wo.id and item_id = v_steel_id) = 155.00);
  perform pg_temp.check('summary view totals the bill', (select charge_total from public.workshop_work_order_summary where id = v_wo.id) = 155.00 + 17.60 + 285.00);

  -- Maintenance needs a place or asset ------------------------------------------
  perform pg_temp.as_user(v_master);
  begin
    perform public.create_workshop_work_order(gen_random_uuid(), v_provider, 'maintenance', 'Service the gate', null, v_client, null, null, null, null, null, null, null);
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm; end;
  perform pg_temp.check('a maintenance visit needs the place or the asset: ' || coalesce(v_err, ''), v_ok);
  v_wo3 := public.create_workshop_work_order(gen_random_uuid(), v_provider, 'maintenance', 'Service the depot gate', null, v_client, v_agreement, v_site, v_asset, null, v_worker, null, null);
  perform pg_temp.check('maintenance visit anchored to the site and asset', v_wo3.client_site_id = v_site and v_wo3.asset_id = v_asset and v_wo3.order_number like 'WO-%-0002');
  v_line := public.add_workshop_work_order_line(gen_random_uuid(), v_wo3.id, 'labour', v_labour_id, null, 1.5, null, null);
  perform pg_temp.check('a labour line takes the price-book rate by default', v_line.unit_price = 95.00 and v_line.line_total = 142.50 and v_line.description = 'Fabrication labour');
  v_line := public.add_workshop_work_order_line(gen_random_uuid(), v_wo3.id, 'travel', null, 'Travel to Oracle Depot', 32, 1.10, 0.75);
  perform pg_temp.check('a free-text travel line keeps the typed rate', v_line.unit_price = 1.10 and v_line.line_total = 35.20);

  -- Ladder + strict draw-down ----------------------------------------------------
  begin
    perform public.advance_workshop_work_order_status(v_wo.id, 'completed', null);
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm; end;
  perform pg_temp.check('draft cannot jump straight to completed: ' || coalesce(v_err, ''), v_ok);
  v_wo := public.advance_workshop_work_order_status(v_wo.id, 'approved', null);
  perform pg_temp.as_user(v_worker);
  begin
    perform public.advance_workshop_work_order_status(v_wo.id, 'cancelled', 'no');
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm; end;
  perform pg_temp.check('the assigned worker cannot cancel: ' || coalesce(v_err, ''), v_ok);
  v_wo := public.advance_workshop_work_order_status(v_wo.id, 'in_progress', null);
  perform pg_temp.check('the assigned worker can start the job', v_wo.status = 'in_progress' and v_wo.started_at is not null);
  begin
    perform public.advance_workshop_work_order_status(v_wo.id, 'completed', 'done');
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm; end;
  perform pg_temp.check('a worker cannot complete an order that draws stock (administrator needed): ' || coalesce(v_err, ''), v_ok and v_err ilike '%administrator%');
  perform pg_temp.as_user(v_master);
  begin
    perform public.advance_workshop_work_order_status(v_wo.id, 'completed', 'done');
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm; end;
  perform pg_temp.check('a shortfall (8 nuts needed, 5 on hand) stops completion with a plain message: ' || coalesce(v_err, ''), v_ok and v_err ilike '%Not enough%20mm nuts%');
  perform public.record_finance_inventory_transaction(v_bolts_id, v_loc.id, 'receipt', 20, 1.10, 'oracle-receipt-bolts-2', 'Oracle Steel invoice 2');
  v_wo := public.advance_workshop_work_order_status(v_wo.id, 'completed', 'Lockbox built and powder-coated');
  perform pg_temp.check('completed with a completion note', v_wo.status = 'completed' and v_wo.completed_at is not null and v_wo.completion_note = 'Lockbox built and powder-coated');
  perform pg_temp.as_admin();
  perform pg_temp.check('material lines drew stock down at the workshop (10-2.5 steel, 25-8 nuts)',
    (select on_hand from public.finance_inventory_balances where item_id = v_steel_id and location_id = v_loc.id) = 7.5
    and (select on_hand from public.finance_inventory_balances where item_id = v_bolts_id and location_id = v_loc.id) = 17);
  perform pg_temp.check('each material line is tied to its consumption transaction; labour is not',
    (select count(*) from public.workshop_work_order_lines where work_order_id = v_wo.id and line_kind = 'material' and inventory_transaction_id is not null) = 2
    and (select inventory_transaction_id from public.workshop_work_order_lines where work_order_id = v_wo.id and line_kind = 'labour') is null);
  perform pg_temp.check('completion is idempotent on the ledger (re-running the draw-down cannot double count)',
    (select count(*) from public.finance_inventory_transactions where idempotency_key like 'workshop_line:%') = 2);
  perform pg_temp.as_user(v_master);
  begin
    perform public.add_workshop_work_order_line(gen_random_uuid(), v_wo.id, 'labour', v_labour_id, null, 1, null, null);
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm; end;
  perform pg_temp.check('a completed order is closed to new lines: ' || coalesce(v_err, ''), v_ok);

  -- Maintenance visit completes without a stock location (no draw-down) ----------------
  v_wo3 := public.advance_workshop_work_order_status(v_wo3.id, 'approved', null);
  v_wo3 := public.advance_workshop_work_order_status(v_wo3.id, 'in_progress', null);
  v_wo3 := public.advance_workshop_work_order_status(v_wo3.id, 'completed', 'Gate hinges replaced');
  perform pg_temp.check('maintenance visit completed', v_wo3.status = 'completed');

  -- Invoice sweep: workshop lines + an uninvoiced dispatch charge line ----------------
  perform pg_temp.as_admin();
  insert into public.dispatch_jobs (id, organization_id, service_agreement_id, client_site_id, job_type, priority, status, completed_at)
  values (v_job, v_provider, v_agreement, v_site, 'alarm_response', 'normal', 'completed', now());
  -- Callouts must carry a billing decision before invoicing (20261025091600); this one is Extra.
  perform set_config('fcm.dispatch_billing_rpc', 'on', true);
  update public.dispatch_jobs set billing_basis = 'extra', billing_basis_set_at = now() where id = v_job;
  perform set_config('fcm.dispatch_billing_rpc', '', true);
  insert into public.dispatch_job_charge_lines (id, organization_id, source_dispatch_id, client_organization_id, service_agreement_id, rate_type, description, quantity, unit_rate, line_total, service_type, day_category)
  values (v_charge, v_provider, v_job, v_client, v_agreement, 'callout', 'Alarm response callout', 1, 38.87, 38.87, 'alarm_response', 'weekday');
  perform pg_temp.as_user(v_other_master);
  begin
    perform public.generate_crm_invoice_from_completed_work(gen_random_uuid(), v_provider, v_client, null, null, null);
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm; end;
  perform pg_temp.check('another organisation cannot invoice my work: ' || coalesce(v_err, ''), v_ok);
  perform pg_temp.as_user(v_master);
  v_inv := public.generate_crm_invoice_from_completed_work('22222222-2222-4222-8222-222222222222', v_provider, v_client, null, null, null);
  perform pg_temp.as_admin();
  select count(*), sum(line_total) into v_n, v_total from public.invoice_line_items where invoice_id = v_inv.id;
  perform pg_temp.check('one draft invoice carries every completed workshop line and the dispatch charge (3 + 2 + 1 lines)', v_inv.status = 'draft' and v_n = 6);
  perform pg_temp.check('subtotal is the sum of the work, GST 15% on top', v_inv.subtotal = 155.00 + 17.60 + 285.00 + 142.50 + 35.20 + 38.87
    and v_inv.gst_amount = round(v_inv.subtotal * 0.15, 2) and v_inv.total_amount = round(v_inv.subtotal * 1.15, 2) and v_total = v_inv.subtotal);
  perform pg_temp.check('source lines are stamped so nothing bills twice',
    (select count(*) from public.workshop_work_order_lines where organization_id = v_provider and invoice_line_item_id is null) = 0
    and (select invoice_line_item_id from public.dispatch_job_charge_lines where id = v_charge) is not null);
  perform pg_temp.check('summary view shows nothing left to invoice', (select uninvoiced_total from public.workshop_work_order_summary where id = v_wo.id) = 0);
  perform pg_temp.as_user(v_master);
  v_inv2 := public.generate_crm_invoice_from_completed_work('22222222-2222-4222-8222-222222222222', v_provider, v_client, null, null, null);
  perform pg_temp.check('same request id returns the same invoice', v_inv2.id = v_inv.id);
  begin
    perform public.generate_crm_invoice_from_completed_work(gen_random_uuid(), v_provider, v_client, null, null, null);
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm; end;
  perform pg_temp.check('a second sweep finds nothing and creates no empty invoice: ' || coalesce(v_err, ''), v_ok and v_err ilike '%No completed, uninvoiced work%');
  perform pg_temp.as_admin();
  perform pg_temp.check('no empty invoice left behind', (select count(*) from public.invoices where organization_id = v_provider) = 1);

  -- RLS -------------------------------------------------------------------------
  perform pg_temp.as_user(v_other_master);
  perform pg_temp.check('another organisation sees none of my work orders, lines or templates',
    (select count(*) from public.workshop_work_orders) = 0 and (select count(*) from public.workshop_work_order_lines) = 0
    and (select count(*) from public.workshop_bom_templates) = 0 and (select count(*) from public.workshop_work_order_summary) = 0);
  perform pg_temp.as_user(v_worker);
  perform pg_temp.check('a member reads their organisation''s work orders through the summary view', (select count(*) from public.workshop_work_order_summary where organization_id = v_provider) = 2);
  begin
    insert into public.workshop_work_orders (organization_id, client_request_id, order_number, kind, title) values (v_provider, gen_random_uuid(), 'WO-X', 'fabrication', 'direct');
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm; end;
  perform pg_temp.check('no direct table writes, only the governed RPCs: ' || coalesce(v_err, ''), v_ok);

  perform pg_temp.as_admin();
  perform pg_temp.check('audit trail: template, orders, status moves, invoice',
    (select count(*) from public.audit_log where organization_id = v_provider and action like 'workshop_%') >= 8
    and (select count(*) from public.audit_log where organization_id = v_provider and action = 'crm_invoice_generated_from_completed_work') = 1);
end $$;

rollback;
