-- Behavioural truth table: a workshop BOM template becomes priced quote lines in one step (20260916130000).
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
  v_other_master uuid := gen_random_uuid();
  v_quote uuid := gen_random_uuid();
  v_steel jsonb; v_steel_id uuid; v_labour jsonb; v_labour_id uuid;
  v_tpl public.workshop_bom_templates%rowtype;
  v_r record;
  v_ok boolean; v_err text;
begin
  insert into public.organizations (id, name, organization_type, parent_organization_id, active, status)
  values (v_provider, 'Oracle Workshop Ltd', 'service_provider', null, true, 'active'), (v_other, 'Oracle Other', 'service_provider', null, true, 'active'), (v_client, 'Oracle Client Council', 'government', null, true, 'active');
  insert into public.user_profiles (id, role, organization_id, employer_organization_id, display_name)
  values (v_master, 'master', v_provider, v_provider, 'Oracle Master'), (v_other_master, 'master', v_other, v_other, 'Oracle Other Master');
  insert into public.module_catalog (module_key, base_price, per_seat_price, per_site_price, billing_period, currency, active) values ('workshop', 0, 0, 0, 'monthly', 'NZD', true) on conflict (module_key) do nothing;
  insert into public.organization_modules (organization_id, module_key, enabled) values (v_provider, 'workshop', true), (v_provider, 'finance', true), (v_provider, 'crm', true);
  insert into public.quotes (id, provider_org_id, client_org_id, client_name, title, status, target_margin_pct)
  values (v_quote, v_provider, v_client, 'Oracle Client Council', 'Lockbox for the depot', 'draft', 25);

  perform pg_temp.as_user(v_master);
  v_steel := public.manage_finance_item(v_provider, 'create', null, 'BOX-200', '200x200mm box section (lockbox)', 'material', 'm', 40.00, 62.00, 'Oracle Steel', 'oracle', current_date);
  v_steel_id := (v_steel->>'item_id')::uuid;
  v_labour := public.manage_finance_item(v_provider, 'create', null, 'FAB-HR', 'Fabrication labour', 'service', 'hr', 45.00, 95.00, null, 'oracle', current_date);
  v_labour_id := (v_labour->>'item_id')::uuid;
  v_tpl := public.manage_workshop_bom_template(gen_random_uuid(), v_provider, 'create', null, 'Standard lockbox', null, 'fabrication',
    jsonb_build_array(
      jsonb_build_object('line_kind', 'material', 'item_id', v_steel_id, 'quantity', 2.5),
      jsonb_build_object('line_kind', 'labour', 'item_id', v_labour_id, 'quantity', 3, 'description', 'Cut, weld, finish'),
      jsonb_build_object('line_kind', 'travel', 'quantity', 30, 'description', 'Delivery to site (km)')));

  perform pg_temp.as_user(v_other_master);
  begin
    perform public.add_crm_quote_lines_from_bom_template(gen_random_uuid(), v_quote, 'draft', v_tpl.id, null);
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm; end;
  perform pg_temp.check('another organisation cannot price my quote from my template: ' || coalesce(v_err, ''), v_ok);

  perform pg_temp.as_user(v_master);
  select * into v_r from public.add_crm_quote_lines_from_bom_template('33333333-3333-4333-8333-333333333333', v_quote, 'draft', v_tpl.id, null);
  perform pg_temp.check('three quote lines added, one (free-text travel) still needs a price', v_r.lines_added = 3 and v_r.lines_needing_price = 1);
  perform pg_temp.check('quote subtotal is the priced template at today''s sell prices (2.5 × 62 + 3 × 95)', v_r.subtotal_charge = 155.00 + 285.00 and v_r.total_cost = 100.00 + 135.00);
  perform pg_temp.as_admin();
  perform pg_temp.check('line kinds map onto the quote vocabulary and carry the template name',
    (select count(*) from public.quote_lines where quote_id = v_quote and kind = 'materials' and description = 'Standard lockbox — 200x200mm box section (lockbox)') = 1
    and (select count(*) from public.quote_lines where quote_id = v_quote and kind = 'labour' and description = 'Standard lockbox — Cut, weld, finish') = 1
    and (select count(*) from public.quote_lines where quote_id = v_quote and kind = 'travel' and unit_charge = 0) = 1);
  perform pg_temp.as_user(v_master);
  select * into v_r from public.add_crm_quote_lines_from_bom_template('33333333-3333-4333-8333-333333333333', v_quote, 'draft', v_tpl.id, null);
  perform pg_temp.check('replaying the same request adds nothing', v_r.lines_added = 0 and v_r.subtotal_charge = 440.00);
  perform pg_temp.as_admin();
  perform pg_temp.check('still exactly three lines on the quote', (select count(*) from public.quote_lines where quote_id = v_quote) = 3);
  perform pg_temp.check('one audit receipt for the template copy', (select count(*) from public.audit_log where target_id = v_quote and action = 'crm_quote_lines_added_from_bom_template') = 1);

  perform pg_temp.as_user(v_master);
  begin
    perform public.add_crm_quote_lines_from_bom_template(gen_random_uuid(), v_quote, 'sent', v_tpl.id, null);
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm; end;
  perform pg_temp.check('an expected-status mismatch is refused: ' || coalesce(v_err, ''), v_ok);
end $$;

rollback;
